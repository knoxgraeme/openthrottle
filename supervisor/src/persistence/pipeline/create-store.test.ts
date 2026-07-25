import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createSupervisorStore } from "../store.js";
import { createPipelineStore } from "./create-store.js";
import { openDb } from "../database.js";
import {
  setupPipelineStore,
  shippedCatalogPath,
  ticket,
} from "../../__fixtures__/pipeline-store.js";

describe("pipeline store composition", () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("creates only explicitly configured pipeline graphs", () => {
    const setup = setupPipelineStore(":memory:", shippedCatalogPath);
    db = setup.db;
    const { tickets, pipelines, catalog, snapshot } = setup;
    tickets.upsertUnpinned(ticket("unpinned-session"));
    expect(db.prepare("SELECT execution_mode FROM session_executions WHERE linear_session_id = ?").pluck().get("unpinned-session")).toBeUndefined();

    const manifest = catalog.manifests.get("ce/implement@2")!;
    const input = {
      ...ticket("pipeline-session"),
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig: snapshot,
        runtime: setup.runtime,
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
    expect(db.prepare("SELECT COUNT(*) FROM pipeline_instances").pluck().get()).toBe(1);
  });

  it("backfills missing selection publications on construction", () => {
    const setup = setupPipelineStore();
    db = setup.db;
    const { tickets, pipelines, catalog, snapshot } = setup;
    const manifest = catalog.manifests.get("fixture/command@1")!;
    tickets.upsert({
      ...ticket("selection-publication"),
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig: snapshot,
        runtime: setup.runtime,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "implement",
      },
    });
    const instance = pipelines.getInstanceForSession("selection-publication")!;
    db.prepare(`
      DELETE FROM linear_outbox
      WHERE id IN (
        SELECT id FROM pipeline_publication_receipts WHERE pipeline_instance_id = ?
      )
    `).run(instance.id);
    db.prepare("DELETE FROM pipeline_publication_receipts WHERE pipeline_instance_id = ?").run(instance.id);

    const reconstructed = createPipelineStore(db);

    expect(reconstructed.listPublications(instance.id).map((publication) => publication.kind).sort()).toEqual([
      "github_summary",
      "linear_ledger",
    ]);
  });

  it("does not create a pipeline graph for unpinned tickets after construction", () => {
    db = openDb(":memory:");
    const pipelines = createPipelineStore(db);
    const tickets = createSupervisorStore(db, pipelines);

    tickets.upsertUnpinned(ticket("legacy-session"));

    expect(db.prepare("SELECT COUNT(*) FROM pipeline_instances").pluck().get()).toBe(0);
    expect(db.prepare("SELECT execution_mode FROM session_executions WHERE linear_session_id = ?").pluck().get("legacy-session")).toBeUndefined();
  });
});
