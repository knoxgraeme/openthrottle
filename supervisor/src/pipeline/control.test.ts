import type Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createSupervisorStore, type SupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import { canSteerPipelineRun } from "./control.js";
import { coordinatePipelineEvent, type PipelineCoordinatorEvent } from "./coordinator.js";
import { digestNormalized, loadPipelineCatalog, parseRepositoryConfig } from "./manifest.js";
import { createPipelineStore } from "../persistence/pipeline/create-store.js";
import { buildInstalledRuntimeDescriptor } from "../__fixtures__/runtime.js";
import type { PipelineInstance, PipelineStageAttempt, PipelineStore } from "./store.js";

const shippedCatalogPath = fileURLToPath(new URL("../../pipelines/catalog.yaml", import.meta.url));
const runtime = buildInstalledRuntimeDescriptor("control-test/v1");

describe("canSteerPipelineRun", () => {
  let db: Database.Database | undefined;
  afterEach(() => db?.close());

  function setup() {
    db = openDb(":memory:");
    const pipelines = createPipelineStore(db);
    const tickets = createSupervisorStore(db, pipelines);
    const catalog = loadPipelineCatalog(shippedCatalogPath, runtime.descriptor);
    pipelines.acceptRuntimeDescriptor(runtime);
    pipelines.acceptCatalog(catalog);
    const config = parseRepositoryConfig(
      "schema: openthrottle.config/v1\ndefault_graph: simple\ngraphs: [{ id: simple, kind: builtin, ref: core/simple@1 }]\npipelines: { implement: fixture-command }\n"
    );
    const snapshot = pipelines.saveRepositoryConfigSnapshot({
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      blobSha: "b".repeat(40),
      config,
    });
    const manifest = catalog.manifests.get("core/implement@4")!;
    tickets.upsert({
      linear_issue_id: "issue-1",
      linear_issue_identifier: "ISSUE-1",
      linear_session_id: "session-1",
      sandbox_id: null,
      branch: "ot/issue-1",
      agent: "codex",
      repo: "owner/repo",
      pr_url: null,
      state: "active",
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
    const instance = pipelines.getInstanceForSession("session-1")!;
    const attempt = pipelines.getActiveAttempt(instance.id)!;
    return { pipelines, tickets, instance, attempt };
  }

  // Dispatches the given attempt as the currently-live child, exactly as the
  // real effect processor does: a `runs` row must exist before bindStageRun
  // can fence the attempt to it (foreign key), then markStageDispatched puts
  // both the attempt and the instance into "running".
  function dispatch(
    pipelines: PipelineStore,
    tickets: SupervisorStore,
    instance: PipelineInstance,
    attempt: PipelineStageAttempt,
    runId: string
  ): void {
    tickets.beginRun({
      issueId: instance.linear_issue_id,
      runId,
      taskType: "implement",
      tokenHash: "token-hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    pipelines.bindStageRun(attempt.id, runId);
    pipelines.markStageDispatched(attempt.id);
  }

  function completionEvent(
    instance: PipelineInstance,
    attempt: PipelineStageAttempt
  ): PipelineCoordinatorEvent {
    const payload = JSON.stringify({ id: "implementation-done", outcome: "success" });
    const resultHash = digestNormalized(payload);
    return {
      id: "implementation-done",
      kind: "stage_result",
      instanceId: instance.id,
      generation: instance.generation,
      attemptId: attempt.id,
      requestHash: attempt.request_hash,
      outcome: "success",
      resultHash,
      artifacts: [{
        kind: "stage_result",
        schemaVersion: 1,
        assurance: "semantic_attested" as const,
        payload,
        hash: resultHash,
      }],
    };
  }

  it("binds live steering to the exact current child fence -- the dispatched attempt's own run id", () => {
    const { pipelines, tickets, instance, attempt } = setup();
    expect(attempt.stage_id).toBe("implementation");
    const runId = attempt.planned_run_id!;
    dispatch(pipelines, tickets, instance, attempt, runId);

    expect(canSteerPipelineRun({
      store: pipelines,
      sessionId: instance.linear_session_id,
      runId,
      agent: "codex",
    })).toBe(true);
  });

  it("uses a caller-supplied attempt instead of re-querying, and actually consults it rather than ignoring it", () => {
    const { pipelines, tickets, instance, attempt } = setup();
    const runId = attempt.planned_run_id!;
    dispatch(pipelines, tickets, instance, attempt, runId);
    const liveAttempt = pipelines.getActiveAttempt(instance.id)!;

    expect(canSteerPipelineRun({
      store: pipelines,
      sessionId: instance.linear_session_id,
      runId,
      agent: "codex",
      attempt: liveAttempt,
    })).toBe(true);

    // A store fresh-query for this instance would still find the live
    // attempt above and return true; passing a stale attempt object proves
    // the supplied attempt is actually consulted, not silently ignored in
    // favor of an internal re-query.
    expect(canSteerPipelineRun({
      store: pipelines,
      sessionId: instance.linear_session_id,
      runId,
      agent: "codex",
      attempt: { ...liveAttempt, run_id: "stale-run-id-from-a-prior-child" },
    })).toBe(false);
  });

  it("rejects a reply carrying a stale run id even while the current child is live", () => {
    const { pipelines, tickets, instance, attempt } = setup();
    const runId = attempt.planned_run_id!;
    dispatch(pipelines, tickets, instance, attempt, runId);

    expect(canSteerPipelineRun({
      store: pipelines,
      sessionId: instance.linear_session_id,
      runId: "stale-run-id-from-a-prior-child",
      agent: "codex",
    })).toBe(false);
  });

  it("rejects the prior child's run id once the graph advances to a new child action", () => {
    const { pipelines, tickets, instance, attempt } = setup();
    const staleRunId = attempt.planned_run_id!;
    dispatch(pipelines, tickets, instance, attempt, staleRunId);
    expect(canSteerPipelineRun({
      store: pipelines,
      sessionId: instance.linear_session_id,
      runId: staleRunId,
      agent: "codex",
    })).toBe(true);

    const transitioned = coordinatePipelineEvent(pipelines, completionEvent(instance, attempt));
    expect(transitioned.active_stage_id).toBe("semantic_review");
    const nextAttempt = pipelines.getActiveAttempt(instance.id)!;
    expect(nextAttempt.id).not.toBe(attempt.id);

    // The now-superseded child's run id must remain audit-only: it no longer
    // fences live steering, even though the session and issue are unchanged.
    expect(canSteerPipelineRun({
      store: pipelines,
      sessionId: instance.linear_session_id,
      runId: staleRunId,
      agent: "codex",
    })).toBe(false);
  });

  it("never allows opencode to live-steer, regardless of run id", () => {
    const { pipelines, tickets, instance, attempt } = setup();
    const runId = attempt.planned_run_id!;
    dispatch(pipelines, tickets, instance, attempt, runId);

    expect(canSteerPipelineRun({
      store: pipelines,
      sessionId: instance.linear_session_id,
      runId,
      agent: "opencode",
    })).toBe(false);
  });
});
