import type Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTicketStore, openDb } from "./db.js";
import {
  canonicalJson,
  digestNormalized,
  loadPipelineCatalog,
  parseRepositoryConfig,
  validatePipelineManifest,
  type ValidatedPipelineCatalog,
} from "./pipeline-manifest.js";
import { createPipelineStore } from "./pipeline-store.js";
import { buildInstalledRuntimeDescriptor, loadRuntimeCapabilityDescriptor } from "./sandbox-runtime.js";

const catalogPath = fileURLToPath(new URL("./__fixtures__/pipelines/catalog.yaml", import.meta.url));
const shippedCatalogPath = fileURLToPath(new URL("../pipelines/catalog.yaml", import.meta.url));
const runtimeDescriptorPath = fileURLToPath(new URL("../pipelines/runtime-capabilities-v1.json", import.meta.url));
const retiredHistoryPath = fileURLToPath(new URL("./__fixtures__/retired-pipeline-history-v1.json", import.meta.url));
const runtime = buildInstalledRuntimeDescriptor("test-runtime/v1");

function seedRetiredPipelineHistory(database: Database.Database) {
  const fixture = JSON.parse(readFileSync(retiredHistoryPath, "utf8")) as {
    runtime: { release: string; protocol: string };
    aliases: Record<string, { id: string; version: number }>;
    manifests: Array<{ id: string; version: number }>;
  };
  const runtimeNormalized = canonicalJson(fixture.runtime);
  const historicalRuntime = { normalized: runtimeNormalized, digest: digestNormalized(runtimeNormalized) };
  database.prepare(`
    INSERT INTO runtime_capability_descriptors (
      runtime_release, digest, protocol, normalized_descriptor, accepted_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(fixture.runtime.release, historicalRuntime.digest, fixture.runtime.protocol, runtimeNormalized, "2026-07-21T00:00:00.000Z");
  const manifests = new Map<string, { digest: string }>();
  for (const manifest of fixture.manifests) {
    const normalized = canonicalJson(manifest);
    const digest = digestNormalized(normalized);
    database.prepare(`
      INSERT INTO pipeline_catalog_entries (
        pipeline_id, version, digest, normalized_manifest, accepted_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(manifest.id, manifest.version, digest, normalized, "2026-07-21T00:00:00.000Z");
    manifests.set(`${manifest.id}@${manifest.version}`, { digest });
  }
  for (const [alias, reference] of Object.entries(fixture.aliases)) {
    const manifest = manifests.get(`${reference.id}@${reference.version}`)!;
    database.prepare(`
      INSERT INTO pipeline_catalog_aliases(alias, pipeline_id, version, digest, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(alias, reference.id, reference.version, manifest.digest, "2026-07-21T00:00:00.000Z");
  }
  return { runtime: historicalRuntime, manifests };
}

describe("pipeline store", () => {
  let db: Database.Database | undefined;
  const temporaryDirectories: string[] = [];
  afterEach(() => {
    db?.close();
    db = undefined;
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function setup(selectedCatalogPath = catalogPath) {
    db = openDb(":memory:");
    const tickets = createTicketStore(db);
    const pipelines = createPipelineStore(db);
    const catalog = loadPipelineCatalog(selectedCatalogPath, runtime.descriptor);
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
    const config = parseRepositoryConfig("pipelines: { implement: implement }\n");
    const snapshot = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config,
    });
    return { tickets, pipelines, catalog, snapshot };
  }

  function ticket(sessionId: string, issueId = `issue-${sessionId}`) {
    return {
      linear_issue_id: issueId,
      linear_issue_identifier: issueId.toUpperCase(),
      linear_session_id: sessionId,
      sandbox_id: null,
      branch: `ot/${issueId}`,
      agent: "codex" as const,
      repo: "owner/repo",
      pr_url: null,
      state: "active" as const,
    };
  }

  it("creates only explicitly configured pipeline graphs", () => {
    const { tickets, pipelines, catalog, snapshot } = setup(shippedCatalogPath);
    tickets.upsertUnpinned(ticket("unpinned-session"));
    expect(db!.prepare("SELECT execution_mode FROM session_executions WHERE linear_session_id = ?").pluck().get("unpinned-session")).toBeUndefined();

    const manifest = catalog.manifests.get("ce/implement@2")!;
    const input = {
      ...ticket("pipeline-session"),
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig: snapshot,
        runtime,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "implement" as const,
      },
    };
    tickets.upsert(input);
    tickets.upsert(input);

    const instance = pipelines.getInstanceForSession("pipeline-session")!;
    expect(instance.pipeline_id).toBe("ce/implement");
    expect(instance.status).toBe("dispatchable");
    expect(instance.attempt_count).toBe(1);
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    expect(attempt.stage_id).toBe("planning");
    const request = pipelines.getStageRequest(attempt.id);
    expect(request).toMatchObject({
      pipelineInstanceId: instance.id,
      attemptId: attempt.id,
      runId: attempt.planned_run_id,
      branch: "ot/issue-pipeline-session",
      agent: "codex",
      repositoryConfigDigest: snapshot.digest,
      nativeSessionId: null,
    });
    expect(request.requestHash).toBe(attempt.request_hash);
    expect(request.idempotencyKey).toBe(attempt.idempotency_key);
    expect(pipelines.listEffects(instance.id).map((effect) => effect.kind)).toEqual(["provision"]);
    expect(db!.prepare("SELECT COUNT(*) FROM pipeline_instances").pluck().get()).toBe(1);
  });

  it("rolls ticket/session/instance state back together when pinning fails", () => {
    const { tickets, catalog, snapshot } = setup(shippedCatalogPath);
    const manifest = catalog.manifests.get("ce/implement@2")!;
    expect(() => tickets.upsert({
      ...ticket("broken-session"),
      pipeline: {
        repository: "owner/repo",
        baseCommit: "c".repeat(40),
        manifest,
        repositoryConfig: snapshot,
        runtime,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "implement",
      },
    })).toThrow(/snapshot binding mismatch/);
    expect(tickets.getByIssueId("issue-broken-session")).toBeUndefined();
    expect(db!.prepare("SELECT COUNT(*) FROM agent_sessions").pluck().get()).toBe(0);
    expect(db!.prepare("SELECT COUNT(*) FROM pipeline_instances").pluck().get()).toBe(0);
  });

  it("atomically fences an older pipeline generation before pinning its replacement", () => {
    const { tickets, pipelines, catalog, snapshot } = setup();
    const manifest = catalog.manifests.get("fixture/command@1")!;
    const pipeline = {
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      manifest,
      repositoryConfig: snapshot,
      runtime,
      authorizedCapabilities: manifest.manifest.requires.capabilities,
      taskType: "implement" as const,
    };
    tickets.upsert({ ...ticket("session-old", "shared-issue"), pipeline });
    const oldInstance = pipelines.getInstanceForSession("session-old")!;
    const oldAttempt = pipelines.getActiveAttempt(oldInstance.id)!;

    tickets.upsert({ ...ticket("session-new", "shared-issue"), pipeline });

    expect(pipelines.getInstance(oldInstance.id)).toMatchObject({
      status: "superseded",
      active_stage_id: null,
      terminal_outcome: "superseded",
      state_version: 1,
    });
    expect(pipelines.getAttempt(oldAttempt.id)?.status).toBe("superseded");
    expect(pipelines.listEffects(oldInstance.id).map((effect) => [effect.kind, effect.status]))
      .toEqual([["provision", "dead"], ["stop", "pending"]]);
    expect(pipelines.getInstanceForSession("session-new")?.status).toBe("dispatchable");
  });

  it("rolls back supersession when a replacement generation cannot be pinned", () => {
    const { tickets, pipelines, catalog, snapshot } = setup();
    const manifest = catalog.manifests.get("fixture/command@1")!;
    const pipeline = {
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      manifest,
      repositoryConfig: snapshot,
      runtime,
      authorizedCapabilities: manifest.manifest.requires.capabilities,
      taskType: "implement" as const,
    };
    tickets.upsert({ ...ticket("rollback-old", "rollback-issue"), pipeline });
    const oldInstance = pipelines.getInstanceForSession("rollback-old")!;

    expect(() => tickets.upsert({
      ...ticket("rollback-new", "rollback-issue"),
      pipeline: { ...pipeline, baseCommit: "c".repeat(40) },
    })).toThrow(/snapshot binding mismatch/);

    expect(tickets.getByIssueId("rollback-issue")?.linear_session_id).toBe("rollback-old");
    expect(pipelines.getInstance(oldInstance.id)?.status).toBe("dispatchable");
    expect(pipelines.listEffects(oldInstance.id).map((effect) => [effect.kind, effect.status]))
      .toEqual([["provision", "pending"]]);
    expect(db!.prepare("SELECT execution_mode FROM session_executions WHERE linear_session_id = ?").pluck().get("rollback-new")).toBeUndefined();
  });

  it("rejects mutation of an accepted version while allowing aliases to move for future instances", () => {
    const { tickets, pipelines, catalog, snapshot } = setup();
    const v1 = catalog.manifests.get("fixture/command@1")!;
    const mutatedValue = JSON.parse(v1.normalized) as Record<string, unknown>;
    mutatedValue.description = "Mutated after acceptance";
    const mutated = validatePipelineManifest(mutatedValue, { runtime: runtime.descriptor });
    const mutatedCatalog: ValidatedPipelineCatalog = {
      aliases: { fixture: { id: mutated.manifest.id, version: 1 } },
      manifests: new Map([["fixture/command@1", mutated]]),
      normalized: canonicalJson({
        aliases: { fixture: { id: mutated.manifest.id, version: 1 } },
        manifests: [{ id: mutated.manifest.id, version: 1, digest: mutated.digest }],
      }),
      digest: digestNormalized(canonicalJson({
        aliases: { fixture: { id: mutated.manifest.id, version: 1 } },
        manifests: [{ id: mutated.manifest.id, version: 1, digest: mutated.digest }],
      })),
    };
    expect(() => pipelines.acceptCatalog(mutatedCatalog)).toThrow(/different digest/);

    const v2Value = JSON.parse(v1.normalized) as Record<string, unknown>;
    v2Value.version = 3;
    v2Value.description = "A compatible future command fixture.";
    const v2 = validatePipelineManifest(v2Value, { runtime: runtime.descriptor });
    const moved: ValidatedPipelineCatalog = {
      aliases: { "fixture-command": { id: v2.manifest.id, version: 3 } },
      manifests: new Map([["fixture/command@1", v1], ["fixture/command@3", v2]]),
      normalized: canonicalJson({
        aliases: { "fixture-command": { id: v2.manifest.id, version: 3 } },
        manifests: [v1, v2].map((entry) => ({
          id: entry.manifest.id,
          version: entry.manifest.version,
          digest: entry.digest,
        })),
      }),
      digest: digestNormalized(canonicalJson({
        aliases: { "fixture-command": { id: v2.manifest.id, version: 3 } },
        manifests: [v1, v2].map((entry) => ({
          id: entry.manifest.id,
          version: entry.manifest.version,
          digest: entry.digest,
        })),
      })),
    };
    pipelines.acceptCatalog(moved);

    for (const [sessionId, manifest] of [["session-v1", v1], ["session-v2", v2]] as const) {
      tickets.upsert({
        ...ticket(sessionId),
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
    }
    expect(pipelines.getInstanceForSession("session-v1")?.pipeline_version).toBe(1);
    expect(pipelines.getInstanceForSession("session-v2")?.pipeline_version).toBe(3);
  });

  it("revalidates pinned hashes and restricts deletion of audit-bearing parents", () => {
    const { tickets, pipelines, catalog, snapshot } = setup();
    const manifest = catalog.manifests.get("fixture/agent@1")!;
    tickets.upsert({
      ...ticket("audit-session"),
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
    const instance = pipelines.getInstanceForSession("audit-session")!;
    expect(() => db!.prepare(
      "DELETE FROM pipeline_catalog_entries WHERE pipeline_id = ? AND version = ?"
    ).run(manifest.manifest.id, manifest.manifest.version)).toThrow(/FOREIGN KEY/);

    db!.prepare("UPDATE pipeline_instances SET normalized_manifest = ? WHERE id = ?")
      .run("{}", instance.id);
    expect(() => pipelines.getInstance(instance.id)).toThrow(/manifest digest mismatch/);
  });

  it("enforces run/attempt identities and rejects orphaned audit receipts", () => {
    const { tickets, pipelines, catalog, snapshot } = setup();
    const manifest = catalog.manifests.get("fixture/command@1")!;
    tickets.upsert({
      ...ticket("integrity-session"),
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
    const instance = pipelines.getInstanceForSession("integrity-session")!;
    expect(() => db!.prepare(`
      INSERT INTO pipeline_artifacts (
        id, pipeline_instance_id, attempt_id, kind, schema_version, assurance,
        payload, artifact_hash, created_at
      ) VALUES ('orphan', ?, 'missing', 'stage_result', 1, 'executor_verified', '{}', ?, ?)
    `).run(instance.id, "c".repeat(64), new Date().toISOString())).toThrow(/FOREIGN KEY/);
    expect(() => db!.prepare(`
      INSERT INTO pipeline_stage_attempts (
        id, pipeline_instance_id, stage_id, attempt_ordinal, reentry_ordinal,
        request_hash, idempotency_key, context_revision, native_context_policy,
        status, created_at, updated_at
      ) SELECT 'duplicate-attempt', pipeline_instance_id, stage_id,
        attempt_ordinal, reentry_ordinal, ?, ?, context_revision,
        native_context_policy, status, created_at, updated_at
      FROM pipeline_stage_attempts WHERE pipeline_instance_id = ? LIMIT 1
    `).run("d".repeat(64), "duplicate-key", instance.id)).toThrow(/UNIQUE/);

    expect(() => db!.prepare(`
      INSERT INTO pipeline_artifacts (
        id, pipeline_instance_id, attempt_id, kind, schema_version, assurance,
        payload, artifact_hash, created_at
      ) VALUES ('unknown-kind', ?, ?, 'mystery', 1, 'executor_verified', '{}', ?, ?)
    `).run(
      instance.id,
      pipelines.getActiveAttempt(instance.id)!.id,
      "e".repeat(64),
      new Date().toISOString()
    )).toThrow(/CHECK/);

    tickets.upsert({
      ...ticket("other-integrity-session"),
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
    const other = pipelines.getInstanceForSession("other-integrity-session")!;
    expect(() => db!.prepare(`
      INSERT INTO pipeline_artifacts (
        id, pipeline_instance_id, attempt_id, kind, schema_version, assurance,
        payload, artifact_hash, created_at
      ) VALUES ('cross-instance', ?, ?, 'stage_result', 1, 'executor_verified', '{}', ?, ?)
    `).run(
      instance.id,
      pipelines.getActiveAttempt(other.id)!.id,
      "f".repeat(64),
      new Date().toISOString()
    )).toThrow(/FOREIGN KEY/);

    const sharedHash = "1".repeat(64);
    const createdAt = new Date().toISOString();
    const insertArtifact = db!.prepare(`
      INSERT INTO pipeline_artifacts (
        id, pipeline_instance_id, attempt_id, kind, schema_version, assurance,
        payload, artifact_hash, created_at
      ) VALUES (?, ?, ?, 'stage_result', 1, 'executor_verified', '{}', ?, ?)
    `);
    insertArtifact.run(
      "shared-artifact-first",
      instance.id,
      pipelines.getActiveAttempt(instance.id)!.id,
      sharedHash,
      createdAt
    );
    insertArtifact.run(
      "shared-artifact-second",
      other.id,
      pipelines.getActiveAttempt(other.id)!.id,
      sharedHash,
      createdAt
    );
    expect(db!.prepare(
      "SELECT COUNT(*) AS count FROM pipeline_artifacts WHERE artifact_hash = ?"
    ).get(sharedHash)).toEqual({ count: 2 });
  });

  it("recovers the same pinned state and pending effects from a file-backed restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "openthrottle-pipeline-store-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "supervisor.db");
    db = openDb(path);
    const tickets = createTicketStore(db);
    const pipelines = createPipelineStore(db);
    const catalog = loadPipelineCatalog(catalogPath, runtime.descriptor);
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
    const config = parseRepositoryConfig("pipelines: { implement: fixture-command }\n");
    const snapshot = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config,
    });
    const manifest = catalog.manifests.get("fixture/command@1")!;
    tickets.upsert({
      ...ticket("restart-session"),
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
    const before = pipelines.getInstanceForSession("restart-session")!;
    db.close();
    db = openDb(path);
    const recovered = createPipelineStore(db);
    const after = recovered.getInstance(before.id)!;
    expect(after).toEqual(before);
    expect(recovered.getActiveAttempt(after.id)?.request_hash).toHaveLength(64);
    expect(recovered.listEffects(after.id).map((effect) => [effect.kind, effect.status])).toEqual([
      ["provision", "pending"],
    ]);
  });

  it("upgrades the current catalog and runtime without rewriting accepted v1 history", () => {
    const directory = mkdtempSync(join(tmpdir(), "openthrottle-pipeline-upgrade-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "supervisor.db");
    const changedV1Runtime = buildInstalledRuntimeDescriptor("openthrottle-snapshot/v1");

    db = openDb(path);
    const historical = seedRetiredPipelineHistory(db);
    db.close();

    db = openDb(path);
    const recovered = createPipelineStore(db);
    expect(changedV1Runtime.digest).not.toBe(historical.runtime.digest);
    expect(() => recovered.acceptRuntimeDescriptor(changedV1Runtime))
      .toThrow(/runtime release openthrottle-snapshot\/v1 was already accepted with a different digest/);

    const shippedRuntime = loadRuntimeCapabilityDescriptor(runtimeDescriptorPath, "openthrottle-snapshot/v2");
    const shippedCatalog = loadPipelineCatalog(shippedCatalogPath, shippedRuntime.descriptor);
    recovered.acceptRuntimeDescriptor(shippedRuntime);
    recovered.acceptCatalog(shippedCatalog);

    expect(db.prepare(`
      SELECT runtime_release, digest FROM runtime_capability_descriptors ORDER BY runtime_release
    `).all()).toEqual([
      { runtime_release: "openthrottle-snapshot/v1", digest: historical.runtime.digest },
      { runtime_release: "openthrottle-snapshot/v2", digest: shippedRuntime.digest },
    ]);
    expect(db.prepare(`
      SELECT pipeline_id, version, digest FROM pipeline_catalog_entries
      WHERE pipeline_id IN ('ce/implement', 'ce/investigate')
      ORDER BY pipeline_id, version
    `).all()).toEqual([
      { pipeline_id: "ce/implement", version: 1, digest: historical.manifests.get("ce/implement@1")!.digest },
      { pipeline_id: "ce/implement", version: 2, digest: shippedCatalog.manifests.get("ce/implement@2")!.digest },
      { pipeline_id: "ce/implement", version: 3, digest: shippedCatalog.manifests.get("ce/implement@3")!.digest },
      { pipeline_id: "ce/investigate", version: 1, digest: historical.manifests.get("ce/investigate@1")!.digest },
      { pipeline_id: "ce/investigate", version: 2, digest: shippedCatalog.manifests.get("ce/investigate@2")!.digest },
    ]);
    expect(db.prepare(`
      SELECT alias, version FROM pipeline_catalog_aliases
      WHERE alias IN ('implement', 'investigate') ORDER BY alias
    `).all()).toEqual([
      { alias: "implement", version: 3 },
      { alias: "investigate", version: 2 },
    ]);
  });

  it("leases effect intents at least once and journals acknowledgement atomically", () => {
    const { tickets, pipelines, catalog, snapshot } = setup();
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
    db!.prepare(`
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
    expect(db!.prepare("SELECT kind, status FROM pipeline_inbox_events WHERE id = ?")
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
});
