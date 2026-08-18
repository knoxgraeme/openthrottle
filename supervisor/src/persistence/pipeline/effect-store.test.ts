import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { digestNormalized } from "../../pipeline/manifest.js";
import { runtime, setupPipelineStore, shippedCatalogPath, ticket } from "../../__fixtures__/pipeline-store.js";
import { databaseMigrations } from "../migrations/runner.js";

describe("pipeline effect store", () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("leases effect intents at least once and journals acknowledgement atomically", () => {
    const setup = setupPipelineStore();
    db = setup.db;
    const { tickets, pipelines, catalog, snapshot } = setup;
    const manifest = catalog.manifests.get("fixture/command@1")!;
    tickets.upsert({
      ...ticket("effect-session"),
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig: snapshot,
        runtime,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "implement",
      },
    });
    const instance = pipelines.getInstanceForSession("effect-session")!;
    db.prepare(`
      INSERT INTO pipeline_effect_intents (
        id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, next_attempt_at, created_at
      ) VALUES ('later-cleanup', ?, 2, 'cleanup', 'later-cleanup', '{}', ?,
        'pending', '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')
    `).run(instance.id, digestNormalized("{}"));
    const first = pipelines.claimEffects(
      "2099-01-01T00:00:00.000Z",
      "2099-01-01T00:01:00.000Z"
    );
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: "provision", status: "processing", attempts: 1 });
    expect(pipelines.claimEffects(
      "2099-01-01T00:00:30.000Z",
      "2099-01-01T00:02:00.000Z"
    )).toEqual([]);
    const reclaimed = pipelines.claimEffects(
      "2099-01-01T00:01:00.000Z",
      "2099-01-01T00:02:00.000Z"
    );
    expect(reclaimed[0]).toMatchObject({ id: first[0]!.id, attempts: 2 });

    pipelines.recordEffectAcknowledgement({
      effectId: first[0]!.id,
      eventId: "effect-ack-1",
      payload: JSON.stringify({ providerResourceId: "opaque-1" }),
    });
    pipelines.recordEffectAcknowledgement({
      effectId: first[0]!.id,
      eventId: "effect-ack-1",
      payload: JSON.stringify({ providerResourceId: "opaque-1" }),
    });
    expect(pipelines.listEffects(instance.id)[0]?.status).toBe("acknowledged");
    expect(db.prepare("SELECT kind, status FROM pipeline_inbox_events WHERE id = ?")
      .get("effect-ack-1")).toEqual({ kind: "effect_acknowledged", status: "pending" });
    const later = pipelines.claimEffects(
      "2099-01-01T01:00:00.000Z",
      "2099-01-01T01:01:00.000Z"
    );
    expect(later).toEqual([expect.objectContaining({ id: "later-cleanup", attempts: 1 })]);
    pipelines.recordEffectAcknowledgement({
      effectId: "later-cleanup",
      eventId: "effect-ack-2",
      payload: "{}",
    });
    expect(pipelines.claimEffects(
      "2099-01-01T02:00:00.000Z",
      "2099-01-01T02:01:00.000Z"
    )).toEqual([]);
  });

  it("persists reservation and checkpoint heads separately from publication", () => {
    const setup = setupPipelineStore(":memory:", shippedCatalogPath);
    db = setup.db;
    const { tickets, pipelines, catalog, snapshot } = setup;
    const manifest = catalog.manifests.get("core/implement@4")!;
    tickets.upsert({
      ...ticket("branch-session"),
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig: snapshot,
        runtime,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "implement",
        planDigest: "c".repeat(64),
      },
    });
    const instance = pipelines.getInstanceForSession("branch-session")!;
    expect(pipelines.listEffects(instance.id).map((effect) => effect.kind)).toEqual([
      "create_task_branch",
      "provision",
    ]);
    const create = pipelines.claimEffects(
      "2099-01-01T00:00:00.000Z",
      "2099-01-01T00:01:00.000Z"
    )[0]!;
    expect(create).toMatchObject({ kind: "create_task_branch", attempts: 1 });
    pipelines.recordEffectAcknowledgement({
      effectId: create.id,
      eventId: "branch-created",
      payload: JSON.stringify({ sha: "a".repeat(40) }),
    });
    const reserved = pipelines.getTaskBranch(instance.id)!;
    expect(reserved).toMatchObject({
      base_sha: "a".repeat(40),
      acknowledged_remote_sha: "a".repeat(40),
      accepted_integration_sha: null,
      plan_digest: "c".repeat(64),
      status: "reserved",
    });
    expect(() => pipelines.queueTaskBranchAdvance({
      instanceId: instance.id,
      generation: instance.generation + 1,
      lineage: reserved.lineage,
      expectedOldSha: "a".repeat(40),
      expectedNewSha: "d".repeat(40),
    })).toThrow(/stale lineage/);

    const provision = pipelines.claimEffects(
      "2099-01-01T00:02:00.000Z",
      "2099-01-01T00:03:00.000Z"
    )[0]!;
    pipelines.recordEffectAcknowledgement({
      effectId: provision.id,
      eventId: "provisioned",
      payload: JSON.stringify({ providerResourceId: "sandbox" }),
    });
    const advance = pipelines.queueTaskBranchAdvance({
      instanceId: instance.id,
      generation: instance.generation,
      lineage: reserved.lineage,
      expectedOldSha: "a".repeat(40),
      expectedNewSha: "d".repeat(40),
    });
    expect(pipelines.queueTaskBranchAdvance({
      instanceId: instance.id,
      generation: instance.generation,
      lineage: reserved.lineage,
      expectedOldSha: "a".repeat(40),
      expectedNewSha: "d".repeat(40),
    }).id).toBe(advance.id);
    expect(pipelines.getTaskBranch(instance.id)).toMatchObject({
      accepted_integration_sha: "d".repeat(40),
      acknowledged_remote_sha: "a".repeat(40),
      status: "reserved",
    });
    const claimedAdvance = pipelines.claimEffects(
      "2099-01-01T00:04:00.000Z",
      "2099-01-01T00:05:00.000Z"
    )[0]!;
    pipelines.recordEffectAcknowledgement({
      effectId: claimedAdvance.id,
      eventId: "branch-advanced",
      payload: JSON.stringify({ sha: "d".repeat(40) }),
    });
    expect(pipelines.getTaskBranch(instance.id)).toMatchObject({
      accepted_integration_sha: "d".repeat(40),
      acknowledged_remote_sha: "d".repeat(40),
      status: "checkpointed",
    });
    expect(pipelines.queueTaskBranchAdvance({
      instanceId: instance.id,
      generation: instance.generation,
      lineage: reserved.lineage,
      expectedOldSha: "a".repeat(40),
      expectedNewSha: "d".repeat(40),
    }).id).toBe(advance.id);
    expect(pipelines.getStatusForIssue(instance.ticket_id)).toMatchObject({
      task_branch_state: "checkpointed",
      task_branch_remote_sha: "d".repeat(40),
      published_commit: null,
      published_pr_url: null,
    });
    expect(pipelines.listPublications(instance.id).some((receipt) => receipt.kind === "pull_request")).toBe(false);
  });

  it("leases a migrated branch reservation before older legacy provision work", () => {
    const setup = setupPipelineStore(":memory:", shippedCatalogPath);
    db = setup.db;
    const { tickets, pipelines, catalog, snapshot } = setup;
    const manifest = catalog.manifests.get("core/implement@4")!;
    tickets.upsert({
      ...ticket("migrated-branch-order-session"),
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig: snapshot,
        runtime,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "implement",
        planDigest: "c".repeat(64),
      },
    });
    const instance = pipelines.getInstanceForSession("migrated-branch-order-session")!;
    db.prepare(`
      UPDATE pipeline_effect_intents
      SET created_at = CASE kind
        WHEN 'provision' THEN '2020-01-01T00:00:00.000Z'
        ELSE '2021-01-01T00:00:00.000Z'
      END,
      next_attempt_at = '2022-01-01T00:00:00.000Z', transition_version = 1
      WHERE pipeline_instance_id = ? AND kind IN ('create_task_branch', 'provision')
    `).run(instance.id);

    const reservation = pipelines.claimEffects(
      "2022-01-01T00:00:00.000Z",
      "2022-01-01T00:01:00.000Z",
      4,
    );
    expect(reservation).toEqual([
      expect.objectContaining({ kind: "create_task_branch", status: "processing" }),
    ]);
    expect(pipelines.listEffects(instance.id).find((effect) => effect.kind === "provision"))
      .toMatchObject({ status: "pending", attempts: 0 });
  });

  it("releases terminal checkpoint payloads and lets cleanup bypass the dead branch intent", () => {
    const setup = setupPipelineStore(":memory:", shippedCatalogPath);
    db = setup.db;
    const { tickets, pipelines, catalog, snapshot } = setup;
    const manifest = catalog.manifests.get("core/implement@4")!;
    tickets.upsert({
      ...ticket("dead-checkpoint-session"),
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig: snapshot,
        runtime,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "implement",
        planDigest: "c".repeat(64),
      },
    });
    const instance = pipelines.getInstanceForSession("dead-checkpoint-session")!;
    const create = pipelines.claimEffects(
      "2099-01-01T00:00:00.000Z", "2099-01-01T00:01:00.000Z"
    )[0]!;
    pipelines.recordEffectAcknowledgement({
      effectId: create.id,
      eventId: "dead-checkpoint-branch-created",
      payload: JSON.stringify({ sha: "a".repeat(40) }),
    });
    const advance = pipelines.queueTaskBranchAdvance({
      instanceId: instance.id,
      generation: instance.generation,
      lineage: pipelines.getTaskBranch(instance.id)!.lineage,
      expectedOldSha: "a".repeat(40),
      expectedNewSha: "d".repeat(40),
    });
    const payload = Buffer.from("ordinary-checkpoint");
    db.prepare(`
      INSERT INTO pipeline_stage_checkpoint_objects (
        attempt_id, effect_id, expected_tree_sha, expected_old_sha, expected_new_sha,
        payload_sha256, payload_bytes, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pipelines.getActiveAttempt(instance.id)!.id,
      advance.id,
      "e".repeat(40),
      "a".repeat(40),
      "d".repeat(40),
      createHash("sha256").update(payload).digest("hex"),
      payload.byteLength,
      payload,
      "2099-01-01T00:02:00.000Z"
    );
    const claimed = pipelines.claimEffects(
      "2099-01-01T00:02:00.000Z", "2099-01-01T00:03:00.000Z"
    )[0]!;
    expect(claimed.id).toBe(advance.id);
    pipelines.markEffectFailed(advance.id, "permanent checkpoint failure", null);
    expect(db.prepare("SELECT effect_id FROM pipeline_stage_checkpoint_objects WHERE effect_id = ?")
      .get(advance.id)).toBeUndefined();
    db.prepare(`
      UPDATE pipeline_effect_intents
      SET status = 'acknowledged', acknowledged_at = '2099-01-01T00:03:00.000Z'
      WHERE pipeline_instance_id = ? AND kind = 'provision'
    `).run(instance.id);

    const cleanupPayload = "{}";
    db.prepare(`
      INSERT INTO pipeline_effect_intents (
        id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, next_attempt_at, created_at
      ) VALUES ('cleanup-after-dead-checkpoint', ?, 99, 'cleanup', 'cleanup-after-dead-checkpoint',
        ?, ?, 'pending', '2099-01-01T00:04:00.000Z', '2099-01-01T00:04:00.000Z')
    `).run(instance.id, cleanupPayload, digestNormalized(cleanupPayload));
    expect(pipelines.claimEffects(
      "2099-01-01T00:04:00.000Z", "2099-01-01T00:05:00.000Z"
    )).toEqual([expect.objectContaining({ id: "cleanup-after-dead-checkpoint", kind: "cleanup" })]);
  });

  it("backfills an active pre-v53 write pipeline before it can continue", () => {
    const setup = setupPipelineStore(":memory:", shippedCatalogPath);
    db = setup.db;
    const { tickets, pipelines, catalog, snapshot } = setup;
    const manifest = catalog.manifests.get("core/implement@4")!;
    tickets.upsert({
      ...ticket("pre-v53-active-session"),
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig: snapshot,
        runtime,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "implement",
        planDigest: "c".repeat(64),
      },
    });
    const instance = pipelines.getInstanceForSession("pre-v53-active-session")!;
    db.prepare("DELETE FROM pipeline_effect_intents WHERE pipeline_instance_id = ?").run(instance.id);
    db.prepare("DELETE FROM pipeline_task_branches WHERE pipeline_instance_id = ?").run(instance.id);

    databaseMigrations.find((migration) => migration.version === 53)!.up(db);

    expect(pipelines.getTaskBranch(instance.id)).toMatchObject({
      pipeline_instance_id: instance.id,
      base_sha: instance.base_commit,
      acknowledged_remote_sha: null,
      status: "pending",
    });
    expect(pipelines.listEffects(instance.id)).toEqual([
      expect.objectContaining({ kind: "create_task_branch", status: "pending" }),
    ]);
  });
});
