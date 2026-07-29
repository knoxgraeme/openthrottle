import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPipelineCatalog, parseRepositoryConfig } from "../../pipeline/manifest.js";
import { openDb } from "../database.js";
import { createSupervisorStore } from "../store.js";
import { createPipelineStore } from "./create-store.js";
import { catalogPath, runtime, setupPipelineStore, shippedCatalogPath, ticket } from "../../__fixtures__/pipeline-store.js";
import { parsePipelinePublication } from "../../pipeline/publication.js";
import type { ExecutionUnitStore } from "./unit-store.js";

describe("pipeline instance store", () => {
  let db: Database.Database | undefined;
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    db?.close();
    db = undefined;
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls ticket/session/instance state back together when pinning fails", () => {
    const setup = setupPipelineStore(":memory:", shippedCatalogPath);
    db = setup.db;
    const { tickets, catalog, snapshot } = setup;
    const manifest = catalog.manifests.get("core/implement@4")!;
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
    const setup = setupPipelineStore();
    db = setup.db;
    const { tickets, pipelines, catalog, snapshot } = setup;
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

  it("preserves the active structured ledger in superseded terminal publications", () => {
    const setup = setupPipelineStore();
    db = setup.db;
    const { tickets, pipelines, catalog, snapshot } = setup;
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
    const unitStore = pipelines as typeof pipelines & ExecutionUnitStore;
    unitStore.createGraph({
      pipelineInstanceId: oldInstance.id,
      parentAttemptId: oldAttempt.id,
      parentStageId: oldAttempt.stage_id,
      parentRunId: "run-old",
      graphDigest: "graph-digest",
      planDigest: "plan-digest",
      units: [{ id: "U1" }],
    });

    tickets.upsert({ ...ticket("session-new", "shared-issue"), pipeline });

    const publication = pipelines.listPublications(oldInstance.id)
      .find((item) => item.kind === "linear_ledger" && item.idempotency_key.includes(":superseded:"))!;
    const envelope = parsePipelinePublication(publication.payload);
    expect(envelope.structured_execution?.units[0]?.unit_id).toBe("U1");
    expect(envelope.body).toContain("**Structured Unit Ledger**");
    expect(envelope.body).toContain("- U1: active (no alarm); state=pending");
  });

  it("rolls back supersession when a replacement generation cannot be pinned", () => {
    const setup = setupPipelineStore();
    db = setup.db;
    const { tickets, pipelines, catalog, snapshot } = setup;
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
    expect(db!.prepare("SELECT execution_mode FROM agent_sessions WHERE id = ?").pluck().get("rollback-new")).toBeUndefined();
  });

  it("enforces run/attempt identities and rejects orphaned audit receipts", () => {
    const setup = setupPipelineStore();
    db = setup.db;
    const { tickets, pipelines, catalog, snapshot } = setup;
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
    const pipelines = createPipelineStore(db);
    const tickets = createSupervisorStore(db, pipelines);
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
});
