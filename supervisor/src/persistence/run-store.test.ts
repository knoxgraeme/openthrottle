import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupPipelineStore, ticket } from "../__fixtures__/pipeline-store.js";
import { openDb } from "./database.js";
import { createSupervisorStore, type SupervisorStore } from "./store.js";
import { createWorkStore } from "./work-store.js";

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

  function enqueueDispatchedSteering(id: string, runId: string): void {
    store.enqueueInbox({
      id,
      issueId: "issue-1",
      sessionId: "session-1",
      runId,
      source: "operator",
      body: `steering for ${runId}`,
    });
    store.markInboxDispatched(id);
  }

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

  it("settles run-bound steering immediately with a direct run finish", () => {
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-direct-steering",
      taskType: "implement",
      tokenHash: "a".repeat(64),
      expiresAt: "2026-07-23T00:00:00.000Z",
    })).toBe(true);
    enqueueDispatchedSteering("steer-direct", "run-direct-steering");

    store.finishRun({ runId: "run-direct-steering", status: "completed" });

    expect(store.getInbox("steer-direct")?.status).toBe("canceled");
  });

  it("leaves retired WorkStore history untouched during run settlement", () => {
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-legacy-history",
      taskType: "implement",
      tokenHash: "a".repeat(64),
      expiresAt: "2026-07-23T00:00:00.000Z",
    })).toBe(true);
    const legacy = createWorkStore(db);
    const item = legacy.enqueue({
      id: "legacy-steer",
      issueId: "issue-1",
      sessionId: "session-1",
      generation: 1,
      contextRevision: 0,
      source: "operator",
      body: "retained migration history",
    });
    const binding = {
      issueId: "issue-1",
      sessionId: "session-1",
      runId: "run-legacy-history",
      nativeSessionId: null,
      generation: 1,
      contextRevision: 0,
    };
    const delivery = legacy.lease({
      ...binding,
      workItemId: item.id,
      leaseUntil: "2099-01-01T00:00:00.000Z",
    });
    legacy.markDispatched(delivery.id, binding);

    store.finishRun({ runId: "run-legacy-history", status: "completed" });

    expect(legacy.get(item.id)?.status).toBe("dispatched");
    expect(legacy.getDelivery(delivery.id)?.status).toBe("dispatched");
  });

  it("settles run-bound steering immediately when a reaper finishes its claim", () => {
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-reaped-steering",
      taskType: "implement",
      tokenHash: "a".repeat(64),
      expiresAt: "2026-07-23T00:00:00.000Z",
    })).toBe(true);
    enqueueDispatchedSteering("steer-reaped", "run-reaped-steering");
    store.claimRunForReaping("run-reaped-steering", "reaper-a", "stalled", "executor");

    store.finishReapingRun({
      runId: "run-reaped-steering",
      owner: "reaper-a",
      status: "timed_out",
    });

    expect(store.getInbox("steer-reaped")?.status).toBe("canceled");
  });

  it("settles run-bound steering immediately after confirmed quarantine recovery", () => {
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-quarantined-steering",
      taskType: "implement",
      tokenHash: "a".repeat(64),
      expiresAt: "2026-07-23T00:00:00.000Z",
    })).toBe(true);
    enqueueDispatchedSteering("steer-quarantined", "run-quarantined-steering");
    store.claimRunForReaping("run-quarantined-steering", "reaper-a", "stalled", "executor");
    store.quarantineRun("run-quarantined-steering", "reaper-a", "termination unconfirmed");
    expect(store.getInbox("steer-quarantined")?.status).toBe("dispatched");

    store.settleQuarantinedRun({
      runId: "run-quarantined-steering",
      status: "stopped",
    });

    expect(store.getInbox("steer-quarantined")?.status).toBe("canceled");
  });

  it("rolls steering settlement back with a failed direct-settlement continuation", () => {
    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-atomic-steering",
      taskType: "implement",
      tokenHash: "a".repeat(64),
      expiresAt: "2026-07-23T00:00:00.000Z",
    })).toBe(true);
    enqueueDispatchedSteering("steer-atomic", "run-atomic-steering");

    expect(() => store.finishRunAndThen(
      { runId: "run-atomic-steering", status: "completed" },
      () => {
        throw new Error("continuation failed");
      }
    )).toThrow("continuation failed");

    expect(store.getRun("run-atomic-steering")?.status).toBe("running");
    expect(store.getInbox("steer-atomic")?.status).toBe("dispatched");
  });

  it("roots pipeline actor liveness on the run row", () => {
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

    // The attempt row carries no actor lifecycle state of its own; the run
    // row is the single owner for pipeline-backed and direct runs alike.
    expect(
      (db.prepare("PRAGMA table_info(pipeline_stage_attempts)").all() as Array<{ name: string }>)
        .map((column) => column.name)
    ).not.toContain("actor_state");
    expect(db.prepare(`
      SELECT actor_state, last_heartbeat_at, expires_at FROM runs WHERE id = ?
    `).get(runId)).toEqual({
      actor_state: "running",
      last_heartbeat_at: "2026-07-22T10:00:00.000Z",
      expires_at: "2026-07-23T00:00:00.000Z",
    });
  });

  it("lists a stalled pipeline-backed run through the run-row actor", () => {
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
    // The run-row actor state is the only stall source used by the reaper.
    expect(db.prepare("SELECT actor_state FROM runs WHERE id = ?").get(runId))
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
