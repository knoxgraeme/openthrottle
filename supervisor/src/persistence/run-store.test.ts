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
      ticket_id: "issue-1",
      ticket_reference: "OT-1",
      session_id: "session-1",
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

  it("stamps fault_attribution alongside settlement_reason at finish, defaulting to null when omitted", () => {
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-1",
      taskType: "implement",
      tokenHash: "a".repeat(64),
      expiresAt: "2026-07-23T00:00:00.000Z",
    })).toBe(true);
    expect(store.finishRun({ runId: "run-1", status: "completed", faultAttribution: "agent" })).toMatchObject({
      id: "run-1",
      status: "completed",
      settlement_reason: "completed",
      fault_attribution: "agent",
    });

    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-2",
      taskType: "implement",
      tokenHash: "b".repeat(64),
      expiresAt: "2026-07-23T00:00:00.000Z",
    })).toBe(true);
    expect(store.finishRun({ runId: "run-2", status: "completed" })).toMatchObject({
      id: "run-2",
      fault_attribution: null,
    });
  });

  it("stamps fault_attribution at the reaping claim and preserves it through the terminal settlement", () => {
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-1",
      taskType: "implement",
      tokenHash: "a".repeat(64),
      expiresAt: "2026-07-23T00:00:00.000Z",
    })).toBe(true);
    expect(store.claimRunForReaping("run-1", "reaper-a", "stalled", "executor")).toMatchObject({
      id: "run-1",
      status: "reaping",
      settlement_reason: "stalled",
      fault_attribution: "executor",
    });
    expect(store.finishReapingRun({
      runId: "run-1",
      owner: "reaper-a",
      status: "timed_out",
    })).toMatchObject({
      id: "run-1",
      status: "timed_out",
      fault_attribution: "executor",
    });
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
      SELECT id, planned_run_id, actor_state, last_heartbeat_at
      FROM pipeline_stage_attempts WHERE planned_run_id = ?
    `).get(runId)).toEqual({
      id: attempt.id,
      planned_run_id: runId,
      actor_state: "running",
      last_heartbeat_at: "2026-07-22T10:00:00.000Z",
    });
    expect(db.prepare("SELECT actor_state, expires_at FROM runs WHERE id = ?").get(runId))
      .toEqual({
        actor_state: "running",
        expires_at: "2026-07-23T00:00:00.000Z",
      });
  });

  it("lists a stalled run through its pipeline attempt actor", () => {
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
    // The owner-row actor state is the only stall source used by the reaper.
    expect(db.prepare("SELECT actor_state FROM pipeline_stage_attempts WHERE planned_run_id = ?").get(runId))
      .toEqual({ actor_state: "running" });

    expect(store.renewRunLiveness(runId, "2026-07-22T10:00:00.000Z")).toBe(true);
    expect(store.listStalledRuns("2026-07-22T10:00:00.000Z").map((run) => run.id)).toEqual([runId]);
    expect(store.listStalledRuns("2026-07-22T09:59:59.000Z")).toEqual([]);

    // A fresh heartbeat moves the actor past the cutoff and out of the sweep.
    expect(store.renewRunLiveness(runId, new Date().toISOString())).toBe(true);
    expect(store.listStalledRuns("2026-07-22T10:00:00.000Z")).toEqual([]);
  });

  it("keeps direct-run liveness on the run row", () => {
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-direct",
      taskType: "implement",
      tokenHash: "d".repeat(64),
      expiresAt: "2026-07-23T00:00:00.000Z",
    })).toBe(true);
    expect(store.renewRunLiveness("run-direct", "2026-07-22T10:00:00.000Z")).toBe(true);

    expect(db.prepare(`
      SELECT actor_state, last_heartbeat_at, expires_at FROM runs WHERE id = 'run-direct'
    `).get()).toEqual({
      actor_state: "running",
      last_heartbeat_at: "2026-07-22T10:00:00.000Z",
      expires_at: "2026-07-23T00:00:00.000Z",
    });
  });
});
