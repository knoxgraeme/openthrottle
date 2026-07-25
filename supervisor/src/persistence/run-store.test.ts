import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupPipelineStore, ticket } from "../__fixtures__/pipeline-store.js";
import { openDb } from "./database.js";
import { createSupervisorStore, type SupervisorStore } from "./store.js";

describe("run store", () => {
  let db: ReturnType<typeof openDb>;
  let store: SupervisorStore;

  beforeEach(() => {
    db = openDb(":memory:");
    store = createSupervisorStore(db);
    store.upsertUnpinned({
      linear_issue_id: "issue-1",
      linear_issue_identifier: "OT-1",
      linear_session_id: "session-1",
      sandbox_id: null,
      branch: "ot/ot-1",
      agent: "codex",
      repo: "owner/repo",
      base_branch: "main",
      pr_url: null,
      state: "active",
    });
  });

  afterEach(() => db.close());

  it("serializes stage actors per ticket", () => {
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-1",
      taskType: "implement",
      tokenHash: "a".repeat(64),
      expiresAt: "2026-07-23T00:00:00.000Z",
    })).toBe(true);
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-2",
      taskType: "implement",
      tokenHash: "b".repeat(64),
      expiresAt: "2026-07-23T00:00:00.000Z",
    })).toBe(false);
    expect(store.finishRun({ runId: "run-1", status: "completed" })).toMatchObject({
      id: "run-1",
      status: "completed",
    });
    expect(store.getByIssueId("issue-1")?.run_id).toBeNull();
  });

  it("roots pipeline actor liveness on the owning attempt", () => {
    db.close();
    const fixture = setupPipelineStore();
    db = fixture.db;
    store = fixture.tickets;
    const manifest = fixture.catalog.manifests.get("fixture/command@2")!;
    store.upsert({
      ...ticket("session-pipeline", "issue-pipeline"),
      pipeline: {
        repository: "owner/repo",
        baseCommit: "a".repeat(40),
        manifest,
        repositoryConfig: fixture.snapshot,
        runtime: fixture.runtime,
        authorizedCapabilities: manifest.manifest.requires.capabilities,
        taskType: "implement",
      },
    });
    const instance = fixture.pipelines.getInstanceForSession("session-pipeline")!;
    const attempt = fixture.pipelines.getActiveAttempt(instance.id)!;
    const runId = attempt.planned_run_id!;

    expect(store.beginRun({
      issueId: "issue-pipeline",
      runId,
      taskType: "implement",
      tokenHash: "c".repeat(64),
      expiresAt: "2026-07-23T00:00:00.000Z",
    })).toBe(true);
    expect(store.renewRunLiveness(runId, "2026-07-22T10:00:00.000Z")).toBe(true);

    expect(db.prepare(`
      SELECT attempt_id, run_id, actor_state, last_heartbeat_at
      FROM pipeline_attempt_actors WHERE run_id = ?
    `).get(runId)).toEqual({
      attempt_id: attempt.id,
      run_id: runId,
      actor_state: "running",
      last_heartbeat_at: "2026-07-22T10:00:00.000Z",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM run_liveness WHERE run_id = ?").get(runId))
      .toEqual({ count: 0 });
  });

  it("keeps legacy direct-run liveness as a compatibility fallback", () => {
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-direct",
      taskType: "implement",
      tokenHash: "d".repeat(64),
      expiresAt: "2026-07-23T00:00:00.000Z",
    })).toBe(true);
    expect(store.renewRunLiveness("run-direct", "2026-07-22T10:00:00.000Z")).toBe(true);

    expect(db.prepare("SELECT COUNT(*) AS count FROM pipeline_attempt_actors WHERE run_id = 'run-direct'").get())
      .toEqual({ count: 0 });
    expect(db.prepare(`
      SELECT actor_state, last_heartbeat_at FROM run_liveness WHERE run_id = 'run-direct'
    `).get()).toEqual({
      actor_state: "running",
      last_heartbeat_at: "2026-07-22T10:00:00.000Z",
    });
  });
});
