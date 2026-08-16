import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../app/config.js";
import type { SupervisorStore } from "../persistence/store.js";
import { createSupervisorStore } from "../persistence/store.js";
import { openDb } from "../persistence/database.js";
import { setupPipelineStore, ticket } from "../__fixtures__/pipeline-store.js";
import { createLinearActivityPublisher, createLinearOutboxProcessor } from "../providers/linear/outbox.js";
import { reapExpiredRuns, reapStalledRuns } from "./reaper.js";
import type { PipelineStore } from "../pipeline/store.js";
import type { LinearOutboxRecord } from "../persistence/delivery-store.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

const listLinearOutbox = (): LinearOutboxRecord[] =>
  db!.prepare("SELECT * FROM control_outbox ORDER BY created_at, sequence").all() as LinearOutboxRecord[];

const cfg = { stallTimeoutSeconds: 900 } as Config;

function makeDaytona(stopError?: Error) {
  const stop = vi.fn(async () => {
    if (stopError) throw stopError;
  });
  const runtime = { stopResource: stop };
  return { runtime, sandbox: { stop } };
}

// No Linear client: enqueue succeeds, delivery throws and is swallowed by
// tryPostError, so the enqueued error row stays visible in the outbox.
const makeOutbox = (store: SupervisorStore) =>
  createLinearOutboxProcessor({ store, getLinearClient: async () => undefined });

const makeActivityPublisher = (store: SupervisorStore, outbox: ReturnType<typeof makeOutbox>) =>
  createLinearActivityPublisher(store, outbox);

const addTicket = (store: SupervisorStore, id: string, sandboxId: string | null) =>
  store.upsert({
    ticket_id: id,
    ticket_reference: id.toUpperCase(),
    session_id: `session-${id}`,
    sandbox_id: sandboxId,
    branch: `ot/${id}`,
    agent: "claude",
    repo: "owner/repo",
    pr_url: null,
    state: "active",
  });

describe("reapStalledRuns", () => {
  it("honors a structured parent hard deadline across the ordinary task timeout boundary", async () => {
    vi.useFakeTimers();
    try {
      const fixture = setupPipelineStore();
      db = fixture.db;
      const store = fixture.tickets;
      const { runtime } = makeDaytona();
      const linearOutbox = makeOutbox(store);
      const manifest = fixture.catalog.manifests.get("fixture/command@2")!;
      store.upsert({
        ...ticket("session-structured-expiry", "issue-structured-expiry"),
        sandbox_id: "sandbox-structured-expiry",
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
      const instance = fixture.pipelines.getInstanceForSession("session-structured-expiry")!;
      const attempt = fixture.pipelines.getActiveAttempt(instance.id)!;
      const runId = attempt.planned_run_id!;
      const expiresAt = "2026-01-02T00:00:00.000Z";
      const reapExpired = () => reapExpiredRuns({
        runtime,
        store,
        activityPublisher: makeActivityPublisher(store, linearOutbox),
        pipelines: fixture.pipelines,
      });
      expect(store.beginRun({
        issueId: "issue-structured-expiry",
        runId,
        taskType: "implement",
        tokenHash: "hash",
        expiresAt,
      })).toBe(true);
      store.renewRunLiveness(runId, "2026-01-01T01:59:59.000Z");
      const initialOutboxCount = listLinearOutbox().length;

      vi.setSystemTime(new Date("2026-01-01T02:00:00.000Z"));
      await reapExpired();
      expect(store.getRun(runId)?.status).toBe("running");
      expect(store.getRun(runId)?.expires_at).toBe(expiresAt);
      expect(listLinearOutbox()).toHaveLength(initialOutboxCount);

      store.renewRunLiveness(runId, "2026-01-01T23:59:59.000Z");
      vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
      await reapExpired();
      expect(store.getRun(runId)?.status).toBe("timed_out");
      expect(store.getRun(runId)?.expires_at).toBe(expiresAt);
      expect(listLinearOutbox().length).toBeGreaterThan(initialOutboxCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reaps a silent run, settles its sandbox, and leaves fresh runs alone", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
    const { runtime, sandbox } = makeDaytona();
    const linearOutbox = makeOutbox(store);

    addTicket(store, "stalled", "sandbox-1");
    addTicket(store, "fresh", "sandbox-2");
    store.beginRun({
      issueId: "stalled",
      runId: "run-stalled",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    store.enqueueInbox({
      id: "steer-stalled",
      issueId: "stalled",
      sessionId: "session-stalled",
      runId: "run-stalled",
      source: "operator",
      body: "steering for the stalled run",
    });
    store.markInboxDispatched("steer-stalled");
    store.beginRun({
      issueId: "fresh",
      runId: "run-fresh",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    // The stalled run emitted a heartbeat once, then went silent — age its only
    // event before the cutoff so MAX(event) governs and it is reaped.
    store.insertSandboxEvent({
      eventId: "evt-stalled",
      runId: "run-stalled",
      sandboxId: "sandbox-1",
      kind: "activity",
      payload: JSON.stringify({ type: "thought", ephemeral: true }),
    });
    db.prepare("UPDATE sandbox_events SET created_at = ? WHERE event_id = ?").run(
      "2020-01-01T00:00:00.000Z",
      "evt-stalled"
    );
    store.renewRunLiveness("run-stalled", "2020-01-01T00:00:00.000Z");

    await reapStalledRuns({ runtime, store, activityPublisher: makeActivityPublisher(store, linearOutbox), cfg });

    // The stalled run is reaped: run terminal, ticket errored, run_id cleared.
    expect(store.getRun("run-stalled")?.status).toBe("timed_out");
    // A stall is executor/runner territory, not a semantic agent defect --
    // see the fault_attribution stamp at the reaping claim.
    expect(store.getRun("run-stalled")?.fault_attribution).toBe("executor");
    const stalledTicket = store.getByIssueId("stalled");
    expect(stalledTicket?.state).toBe("error");
    expect(stalledTicket?.run_id).toBeNull();
    expect(store.getInbox("steer-stalled")?.status).toBe("canceled");

    // An error activity was enqueued for the reaped run.
    const rows = listLinearOutbox();
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload) as {
      type: string;
      activity: { type: string; body: string };
    };
    expect(payload.type).toBe("activity");
    expect(payload.activity.type).toBe("error");
    // The reaper cannot distinguish a stalled executor from one that crashed or
    // never started, so the message must not misattribute the cause.
    expect(payload.activity.body).toContain("run reaped — no executor progress for over 900s");
    expect(payload.activity.body).toContain(
      "crashed, never started, or exited without reporting a result"
    );
    expect(payload.activity.body).not.toContain("heartbeat");

    // The actor was stopped before ticket exclusivity was released.
    expect(sandbox.stop).toHaveBeenCalledWith("sandbox-1", expect.stringContaining("run reaped"));

    // The freshly-started run is untouched.
    expect(store.getRun("run-fresh")?.status).toBe("running");
    expect(store.getByIssueId("fresh")?.run_id).toBe("run-fresh");
  });

  it("does not reap a run kept alive by a recent sandbox event", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
    const { runtime } = makeDaytona();
    const linearOutbox = makeOutbox(store);

    addTicket(store, "beating", "sandbox-1");
    store.beginRun({
      issueId: "beating",
      runId: "run-beating",
      taskType: "investigate",
      tokenHash: "hash",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    // Started long ago, but a heartbeat landed just now → MAX(event) > cutoff.
    db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(
      "2020-01-01T00:00:00.000Z",
      "run-beating"
    );
    store.insertSandboxEvent({
      eventId: "evt-1",
      runId: "run-beating",
      sandboxId: "sandbox-1",
      kind: "activity",
      payload: JSON.stringify({ type: "thought", ephemeral: true }),
    });
    store.renewRunLiveness("run-beating", new Date().toISOString());

    await reapStalledRuns({ runtime, store, activityPublisher: makeActivityPublisher(store, linearOutbox), cfg });

    expect(store.getRun("run-beating")?.status).toBe("running");
    expect(store.getByIssueId("beating")?.run_id).toBe("run-beating");
    expect(listLinearOutbox()).toHaveLength(0);
  });

  it("reaps a bootstrapping run from started_at when no heartbeat ever arrives", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
    const { runtime } = makeDaytona();
    const linearOutbox = makeOutbox(store);

    addTicket(store, "booting", "sandbox-1");
    store.beginRun({
      issueId: "booting",
      runId: "run-booting",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    // A wedged bootstrap cannot hide forever behind an absence of agent output;
    // started_at is authoritative until the first sealed executor heartbeat.
    db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(
      "2020-01-01T00:00:00.000Z",
      "run-booting"
    );

    await reapStalledRuns({ runtime, store, activityPublisher: makeActivityPublisher(store, linearOutbox), cfg });

    expect(store.getRun("run-booting")?.status).toBe("timed_out");
    expect(store.getByIssueId("booting")?.run_id).toBeNull();
    expect(listLinearOutbox()).toHaveLength(1);
  });

  it("reaps a stalled attempt-backed run through the pipeline actor table", async () => {
    const fixture = setupPipelineStore();
    db = fixture.db;
    const store = fixture.tickets;
    const { runtime, sandbox } = makeDaytona();
    const linearOutbox = makeOutbox(store);
    const manifest = fixture.catalog.manifests.get("fixture/command@2")!;
    store.upsert({
      ...ticket("session-stalled", "issue-stalled"),
      sandbox_id: "sandbox-1",
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
    const instance = fixture.pipelines.getInstanceForSession("session-stalled")!;
    const attempt = fixture.pipelines.getActiveAttempt(instance.id)!;
    const runId = attempt.planned_run_id!;
    expect(store.beginRun({
      issueId: "issue-stalled",
      runId,
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2999-01-01T00:00:00.000Z",
    })).toBe(true);
    fixture.pipelines.bindStageRun(attempt.id, runId);
    // The sealed executor heartbeat went silent long before the stall cutoff.
    // The whole stall-reap -> claim -> settle path runs against the owning
    // run row.
    store.renewRunLiveness(runId, "2020-01-01T00:00:00.000Z");
    expect(db.prepare("SELECT actor_state FROM runs WHERE id = ?").get(runId))
      .toEqual({ actor_state: "running" });

    await reapStalledRuns({
      runtime,
      store,
      activityPublisher: makeActivityPublisher(store, linearOutbox),
      cfg,
      pipelines: fixture.pipelines,
    });

    expect(store.getRun(runId)?.status).toBe("timed_out");
    expect(store.getByIssueId("issue-stalled")).toMatchObject({ state: "error", run_id: null });
    expect(db.prepare(`
      SELECT actor_state, settlement_reason, termination_confirmed_at
      FROM runs WHERE id = ?
    `).get(runId)).toMatchObject({
      actor_state: "settled",
      settlement_reason: expect.stringContaining("run reaped"),
      termination_confirmed_at: expect.any(String),
    });
    expect(sandbox.stop).toHaveBeenCalledWith("sandbox-1", expect.stringContaining("run reaped"));
    // Settlement re-entered the pipeline as a bounded infrastructure retry.
    expect(fixture.pipelines.getAttempt(attempt.id)).toMatchObject({
      status: "failed",
      outcome: "retryable_infrastructure_failure",
    });
    expect(fixture.pipelines.getActiveAttempt(instance.id)).toMatchObject({
      stage_id: "test",
      reentry_ordinal: 1,
    });
    // Alongside the pipeline_receipt publications, exactly one reap error
    // activity was enqueued for the settled run.
    const activities = listLinearOutbox().filter((row) => row.kind === "activity");
    expect(activities).toHaveLength(1);
    expect(JSON.parse(activities[0].payload)).toMatchObject({
      type: "activity",
      activity: { type: "error", body: expect.stringContaining("run reaped") },
    });
  });

  it("keeps the ticket active when reaping a stale run from an already-settled attempt of a live instance", async () => {
    const fixture = setupPipelineStore();
    db = fixture.db;
    const store = fixture.tickets;
    const { runtime } = makeDaytona();
    const linearOutbox = makeOutbox(store);
    const manifest = fixture.catalog.manifests.get("fixture/command@2")!;
    store.upsert({
      ...ticket("session-stale", "issue-stale"),
      sandbox_id: "sandbox-stale",
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
    const instance = fixture.pipelines.getInstanceForSession("session-stale")!;
    const attempt = fixture.pipelines.getActiveAttempt(instance.id)!;
    const runId = attempt.planned_run_id!;
    expect(store.beginRun({
      issueId: "issue-stale",
      runId,
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2999-01-01T00:00:00.000Z",
    })).toBe(true);
    fixture.pipelines.bindStageRun(attempt.id, runId);
    db.prepare(`
      UPDATE pipeline_stage_attempts
      SET status = 'completed', outcome = 'success', completed_at = ?
      WHERE id = ?
    `).run("2026-07-26T00:00:00.000Z", attempt.id);
    db.prepare(`
      UPDATE pipeline_instances
      SET status = 'waiting_provider', active_stage_id = 'provider', published_commit = ?
      WHERE id = ?
    `).run("c".repeat(40), instance.id);
    store.renewRunLiveness(runId, "2020-01-01T00:00:00.000Z");

    await reapStalledRuns({
      runtime,
      store,
      activityPublisher: makeActivityPublisher(store, linearOutbox),
      cfg,
      pipelines: fixture.pipelines,
    });

    expect(store.getRun(runId)?.status).toBe("timed_out");
    expect(store.getByIssueId("issue-stale")).toMatchObject({
      state: "active",
      run_id: null,
      last_error: null,
    });
    expect(fixture.pipelines.getInstance(instance.id)).toMatchObject({ status: "waiting_provider" });
    expect(listLinearOutbox().filter((row) => row.kind === "activity")).toHaveLength(0);
  });

  it("quarantines a claimed run when termination cannot be confirmed", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
    const { runtime } = makeDaytona(new Error("provider timeout"));
    const linearOutbox = makeOutbox(store);
    addTicket(store, "wedged", "sandbox-1");
    store.beginRun({
      issueId: "wedged",
      runId: "run-wedged",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    store.enqueueInbox({
      id: "steer-wedged",
      issueId: "wedged",
      sessionId: "session-wedged",
      runId: "run-wedged",
      source: "operator",
      body: "steering for the quarantined run",
    });
    store.markInboxDispatched("steer-wedged");
    db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(
      "2020-01-01T00:00:00.000Z",
      "run-wedged"
    );

    await reapStalledRuns({ runtime, store, activityPublisher: makeActivityPublisher(store, linearOutbox), cfg });

    expect(store.getRun("run-wedged")?.status).toBe("quarantined");
    expect(store.getByIssueId("wedged")).toMatchObject({
      state: "error",
      run_id: "run-wedged",
    });
    expect(store.getInbox("steer-wedged")?.status).toBe("dispatched");
    expect(store.beginRun({
      issueId: "wedged",
      runId: "replacement",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2999-01-01T00:00:00.000Z",
    })).toBe(false);
    expect(listLinearOutbox()).toHaveLength(1);

    expect(store.settleQuarantinedRun({
      runId: "run-wedged",
      status: "stopped",
      ticketState: "stopped",
      failureTail: "termination later confirmed",
    })).toMatchObject({ status: "stopped" });
    expect(store.getByIssueId("wedged")).toMatchObject({ state: "stopped", run_id: null });
    expect(store.getInbox("steer-wedged")?.status).toBe("canceled");
  });

  it("quarantines a pipeline resource without advancing to a retry before actor termination", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
    const { runtime } = makeDaytona(new Error("provider timeout"));
    const linearOutbox = makeOutbox(store);
    addTicket(store, "pipeline-wedged", "sandbox-1");
    store.beginRun({
      issueId: "pipeline-wedged",
      runId: "run-pipeline-wedged",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(
      "2020-01-01T00:00:00.000Z",
      "run-pipeline-wedged"
    );
    const setRuntimeResourceStatus = vi.fn();
    const getActiveAttempt = vi.fn();
    const recordJournalEntry = vi.fn(() => {
      throw new Error("journal unavailable");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pipelines = {
      getAttemptForRun: vi.fn(() => ({ pipeline_instance_id: "pipeline-1" })),
      getInstance: vi.fn(() => ({ id: "pipeline-1" })),
      getRuntimeResource: vi.fn(() => ({ provider_resource_id: "sandbox-1" })),
      setRuntimeResourceStatus,
      getActiveAttempt,
      recordJournalEntry,
    } as unknown as PipelineStore;

    await reapStalledRuns({ runtime, store, activityPublisher: makeActivityPublisher(store, linearOutbox), cfg, pipelines });

    expect(recordJournalEntry).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[reaper] failed to record orchestration journal entry:",
      "Error: journal unavailable"
    );
    warn.mockRestore();
    expect(setRuntimeResourceStatus).toHaveBeenCalledWith("pipeline-1", "quarantined");
    expect(getActiveAttempt).not.toHaveBeenCalled();
    expect(store.getRun("run-pipeline-wedged")?.status).toBe("quarantined");
  });

  it("allows only the settlement owner to finish a reaping run", () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
    addTicket(store, "race", null);
    store.beginRun({
      issueId: "race",
      runId: "run-race",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    expect(store.claimRunForReaping("run-race", "reaper-a", "stalled", "executor")?.status).toBe("reaping");
    expect(store.finishRun({ runId: "run-race", status: "completed" })).toBeUndefined();
    expect(store.finishReapingRun({
      runId: "run-race",
      owner: "reaper-b",
      status: "timed_out",
    })).toBeUndefined();
    expect(store.finishReapingRun({
      runId: "run-race",
      owner: "reaper-a",
      status: "timed_out",
      ticketState: "error",
    })?.status).toBe("timed_out");
  });

  it("holds an exclusive supervisor lease across the termination call", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
    addTicket(store, "overlap", "sandbox-1");
    store.beginRun({
      issueId: "overlap",
      runId: "run-overlap",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(
      "2020-01-01T00:00:00.000Z",
      "run-overlap"
    );
    let confirmStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { confirmStop = resolve; });
    const sandbox = { id: "sandbox-1", stop: vi.fn(async () => stopGate) };
    const runtime = { stopResource: sandbox.stop };
    const linearOutbox = makeOutbox(store);

    const first = reapStalledRuns({ runtime, store, activityPublisher: makeActivityPublisher(store, linearOutbox), cfg });
    await vi.waitFor(() => expect(sandbox.stop).toHaveBeenCalledOnce());
    await reapStalledRuns({ runtime, store, activityPublisher: makeActivityPublisher(store, linearOutbox), cfg });
    expect(runtime.stopResource).toHaveBeenCalledOnce();

    confirmStop();
    await first;
    expect(store.getRun("run-overlap")?.status).toBe("timed_out");
  });

  it("renews the supervisor lease before every stalled actor", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
    const { runtime } = makeDaytona();
    const linearOutbox = makeOutbox(store);
    for (const id of ["first", "second"]) {
      addTicket(store, id, "sandbox-1");
      store.beginRun({
        issueId: id,
        runId: `run-${id}`,
        taskType: "implement",
        tokenHash: "hash",
        expiresAt: "2999-01-01T00:00:00.000Z",
      });
      db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(
        "2020-01-01T00:00:00.000Z",
        `run-${id}`
      );
    }
    const acquire = vi.spyOn(store, "acquireSupervisorLease");

    await reapStalledRuns({ runtime, store, activityPublisher: makeActivityPublisher(store, linearOutbox), cfg });

    expect(acquire).toHaveBeenCalledTimes(3); // initial acquisition + each actor
    expect(store.getRun("run-first")?.status).toBe("timed_out");
    expect(store.getRun("run-second")?.status).toBe("timed_out");
  });

  it("is a no-op when there are no stalled runs", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
    const { runtime } = makeDaytona();
    const linearOutbox = makeOutbox(store);

    await expect(
      reapStalledRuns({ runtime, store, activityPublisher: makeActivityPublisher(store, linearOutbox), cfg })
    ).resolves.toBeUndefined();
    expect(listLinearOutbox()).toHaveLength(0);
  });
});
