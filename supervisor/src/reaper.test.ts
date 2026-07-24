import type { Daytona } from "@daytona/sdk";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./app/config.js";
import type { SupervisorStore } from "./persistence/store.js";
import { createSupervisorStore } from "./persistence/store.js";
import { openDb } from "./persistence/database.js";
import { createLinearOutboxProcessor } from "./linear-outbox.js";
import { reapStalledRuns } from "./reaper.js";
import type { PipelineStore } from "./pipeline/store.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

const cfg = { stallTimeoutSeconds: 900 } as Config;

function makeDaytona(stopError?: Error) {
  const sandbox = {
    id: "sandbox-1",
    stop: vi.fn(async () => {
      if (stopError) throw stopError;
    }),
  };
  const daytona = { get: vi.fn(async () => sandbox) } as unknown as Daytona;
  return { daytona, sandbox };
}

// No Linear client: enqueue succeeds, delivery throws and is swallowed by
// tryPostError, so the enqueued error row stays visible in listLinearOutbox().
const makeOutbox = (store: SupervisorStore) =>
  createLinearOutboxProcessor({ store, getLinearClient: async () => undefined });

const addTicket = (store: SupervisorStore, id: string, sandboxId: string | null) =>
  store.upsert({
    linear_issue_id: id,
    linear_issue_identifier: id.toUpperCase(),
    linear_session_id: `session-${id}`,
    sandbox_id: sandboxId,
    branch: `ot/${id}`,
    agent: "claude",
    repo: "owner/repo",
    pr_url: null,
    state: "active",
  });

describe("reapStalledRuns", () => {
  it("reaps a silent run, settles its sandbox, and leaves fresh runs alone", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
    const { daytona, sandbox } = makeDaytona();
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

    await reapStalledRuns({ daytona, store, linearOutbox, cfg });

    // The stalled run is reaped: run terminal, ticket errored, run_id cleared.
    expect(store.getRun("run-stalled")?.status).toBe("timed_out");
    const stalledTicket = store.getByIssueId("stalled");
    expect(stalledTicket?.state).toBe("error");
    expect(stalledTicket?.run_id).toBeNull();

    // An error activity was enqueued for the reaped run.
    const rows = store.listLinearOutbox();
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
    expect(sandbox.stop).toHaveBeenCalledWith(60, true);

    // The freshly-started run is untouched.
    expect(store.getRun("run-fresh")?.status).toBe("running");
    expect(store.getByIssueId("fresh")?.run_id).toBe("run-fresh");
  });

  it("does not reap a run kept alive by a recent sandbox event", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
    const { daytona } = makeDaytona();
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

    await reapStalledRuns({ daytona, store, linearOutbox, cfg });

    expect(store.getRun("run-beating")?.status).toBe("running");
    expect(store.getByIssueId("beating")?.run_id).toBe("run-beating");
    expect(store.listLinearOutbox()).toHaveLength(0);
  });

  it("reaps a bootstrapping run from started_at when no heartbeat ever arrives", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
    const { daytona } = makeDaytona();
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

    await reapStalledRuns({ daytona, store, linearOutbox, cfg });

    expect(store.getRun("run-booting")?.status).toBe("timed_out");
    expect(store.getByIssueId("booting")?.run_id).toBeNull();
    expect(store.listLinearOutbox()).toHaveLength(1);
  });

  it("quarantines a claimed run when termination cannot be confirmed", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
    const { daytona } = makeDaytona(new Error("provider timeout"));
    const linearOutbox = makeOutbox(store);
    addTicket(store, "wedged", "sandbox-1");
    store.beginRun({
      issueId: "wedged",
      runId: "run-wedged",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(
      "2020-01-01T00:00:00.000Z",
      "run-wedged"
    );

    await reapStalledRuns({ daytona, store, linearOutbox, cfg });

    expect(store.getRun("run-wedged")?.status).toBe("quarantined");
    expect(store.getByIssueId("wedged")).toMatchObject({
      state: "error",
      run_id: "run-wedged",
    });
    expect(store.beginRun({
      issueId: "wedged",
      runId: "replacement",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2999-01-01T00:00:00.000Z",
    })).toBe(false);
    expect(store.listLinearOutbox()).toHaveLength(1);

    expect(store.settleQuarantinedRun({
      runId: "run-wedged",
      status: "stopped",
      ticketState: "stopped",
      failureTail: "termination later confirmed",
    })).toMatchObject({ status: "stopped" });
    expect(store.getByIssueId("wedged")).toMatchObject({ state: "stopped", run_id: null });
  });

  it("quarantines a pipeline resource without advancing to a retry before actor termination", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
    const { daytona } = makeDaytona(new Error("provider timeout"));
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
    const pipelines = {
      getAttemptForRun: vi.fn(() => ({ pipeline_instance_id: "pipeline-1" })),
      getInstance: vi.fn(() => ({ id: "pipeline-1" })),
      getRuntimeResource: vi.fn(() => ({ provider_resource_id: "sandbox-1" })),
      setRuntimeResourceStatus,
      getActiveAttempt,
    } as unknown as PipelineStore;

    await reapStalledRuns({ daytona, store, linearOutbox, cfg, pipelines });

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
    expect(store.claimRunForReaping("run-race", "reaper-a", "stalled")?.status).toBe("reaping");
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
    const daytona = { get: vi.fn(async () => sandbox) } as unknown as Daytona;
    const linearOutbox = makeOutbox(store);

    const first = reapStalledRuns({ daytona, store, linearOutbox, cfg });
    await vi.waitFor(() => expect(sandbox.stop).toHaveBeenCalledOnce());
    await reapStalledRuns({ daytona, store, linearOutbox, cfg });
    expect(daytona.get).toHaveBeenCalledOnce();

    confirmStop();
    await first;
    expect(store.getRun("run-overlap")?.status).toBe("timed_out");
  });

  it("renews the supervisor lease before every stalled actor", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
    const { daytona } = makeDaytona();
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

    await reapStalledRuns({ daytona, store, linearOutbox, cfg });

    expect(acquire).toHaveBeenCalledTimes(3); // initial acquisition + each actor
    expect(store.getRun("run-first")?.status).toBe("timed_out");
    expect(store.getRun("run-second")?.status).toBe("timed_out");
  });

  it("is a no-op when there are no stalled runs", async () => {
    db = openDb(":memory:");
    const store = createSupervisorStore(db);
    const { daytona } = makeDaytona();
    const linearOutbox = makeOutbox(store);

    await expect(
      reapStalledRuns({ daytona, store, linearOutbox, cfg })
    ).resolves.toBeUndefined();
    expect(store.listLinearOutbox()).toHaveLength(0);
  });
});
