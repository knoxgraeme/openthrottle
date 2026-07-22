import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
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
import { buildInstalledRuntimeDescriptor } from "./sandbox-runtime.js";

const catalogPath = fileURLToPath(new URL("../pipelines/catalog.yaml", import.meta.url));
const runtime = buildInstalledRuntimeDescriptor("test-runtime/v1");

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

  function setup() {
    db = openDb(":memory:");
    const tickets = createTicketStore(db);
    const pipelines = createPipelineStore(db);
    const catalog = loadPipelineCatalog(catalogPath, runtime.descriptor);
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

  it("pins legacy mode for ordinary generations and creates a new-mode graph atomically", () => {
    const { tickets, pipelines, catalog, snapshot } = setup();
    tickets.upsert(ticket("legacy-session"));
    expect(db!.prepare("SELECT execution_mode FROM session_executions WHERE linear_session_id = ?").pluck().get("legacy-session")).toBe("legacy");

    const manifest = catalog.manifests.get("ce/implement@1")!;
    const input = {
      ...ticket("pipeline-session"),
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig: snapshot,
        runtime,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
      },
    };
    tickets.upsert(input);
    tickets.upsert(input);

    const instance = pipelines.getInstanceForSession("pipeline-session")!;
    expect(instance.pipeline_id).toBe("ce/implement");
    expect(instance.status).toBe("dispatchable");
    expect(instance.attempt_count).toBe(1);
    expect(pipelines.getActiveAttempt(instance.id)?.stage_id).toBe("implement");
    expect(pipelines.listEffects(instance.id).map((effect) => effect.kind)).toEqual(["provision"]);
    expect(db!.prepare("SELECT COUNT(*) FROM pipeline_instances").pluck().get()).toBe(1);
  });

  it("rolls ticket/session/instance state back together when pinning fails", () => {
    const { tickets, catalog, snapshot } = setup();
    const manifest = catalog.manifests.get("ce/implement@1")!;
    expect(() => tickets.upsert({
      ...ticket("broken-session"),
      pipeline: {
        repository: "owner/repo",
        baseCommit: "c".repeat(40),
        manifest,
        repositoryConfig: snapshot,
        runtime,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
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
    expect(pipelines.getSessionExecutionMode("rollback-new")).toBeUndefined();
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
    v2Value.version = 2;
    v2Value.description = "A compatible future command fixture.";
    const v2 = validatePipelineManifest(v2Value, { runtime: runtime.descriptor });
    const moved: ValidatedPipelineCatalog = {
      aliases: { "fixture-command": { id: v2.manifest.id, version: 2 } },
      manifests: new Map([["fixture/command@1", v1], ["fixture/command@2", v2]]),
      normalized: canonicalJson({
        aliases: { "fixture-command": { id: v2.manifest.id, version: 2 } },
        manifests: [v1, v2].map((entry) => ({
          id: entry.manifest.id,
          version: entry.manifest.version,
          digest: entry.digest,
        })),
      }),
      digest: digestNormalized(canonicalJson({
        aliases: { "fixture-command": { id: v2.manifest.id, version: 2 } },
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
        },
      });
    }
    expect(pipelines.getInstanceForSession("session-v1")?.pipeline_version).toBe(1);
    expect(pipelines.getInstanceForSession("session-v2")?.pipeline_version).toBe(2);
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
      },
    });
    const instance = pipelines.getInstanceForSession("effect-session")!;
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
    expect(pipelines.claimEffects(
      "2099-01-01T01:00:00.000Z",
      "2099-01-01T01:01:00.000Z"
    )).toEqual([]);
  });
});
