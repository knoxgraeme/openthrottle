import { randomUUID } from "node:crypto";
import type { Daytona } from "@daytona/sdk";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";
import type { AgentActivityInput, LinearClient } from "./linear.js";
import type { LinearOutboxProcessor } from "./linear-outbox.js";
import type { LaunchExistingTask } from "./scheduler.js";
import { createTicketStore, openDb, type TaskType, type TicketStore } from "./db.js";
import {
  classifyExecutionOutcome,
  completeRun,
  redrainStalledSessionWork,
  tokenHash,
} from "./run-lifecycle.js";

let db: Database.Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

const cfg = { reviewMaxRounds: 10 } as Config;
const linear = { accessToken: "oauth" } as unknown as LinearClient;
const linearOutbox = {} as LinearOutboxProcessor;
const daytona = {} as Daytona;

function addTicket(store: TicketStore, id: string): void {
  store.upsert({
    linear_issue_id: id,
    linear_issue_identifier: id.toUpperCase(),
    linear_session_id: `session-${id}`,
    sandbox_id: `sbx-${id}`,
    branch: `ot/${id}`,
    agent: "claude",
    repo: "owner/repo",
    pr_url: null,
    state: "active",
  });
}

function enqueueCi(store: TicketStore, id: string, workId: string): void {
  store.enqueueSessionWork({
    id: workId,
    linearSessionId: `session-${id}`,
    issueId: id,
    source: "automatic",
    body: "ci failed",
  });
}

describe("redrainStalledSessionWork", () => {
  it("re-drains idle tickets with stranded work but never a session parked on an elicitation", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);

    // drains: idle, active, pending work, no terminal elicitation → re-drained.
    addTicket(store, "drains");
    enqueueCi(store, "drains", "gh-ci-drains");

    // parked: idle with pending work, but its last run parked on an elicitation
    // (awaiting a human answer) → must be left pending, exactly as completeRun.
    addTicket(store, "parked");
    enqueueCi(store, "parked", "gh-ci-parked");
    store.beginRun({
      issueId: "parked",
      runId: "run-parked",
      taskType: "resume",
      tokenHash: "hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    store.finishRun({
      runId: "run-parked",
      status: "completed",
      exitCode: 0,
      ticketState: "active",
    });
    const nowIso = new Date().toISOString();
    db.prepare(
      `INSERT INTO sandbox_events
        (event_id, run_id, sandbox_id, kind, payload, status, attempts, next_attempt_at, processed_at, created_at)
       VALUES (?, ?, ?, 'activity', ?, 'processed', 0, ?, ?, ?)`
    ).run(
      "evt-parked",
      "run-parked",
      "sbx-parked",
      JSON.stringify({ type: "elicitation" }),
      nowIso,
      nowIso,
      nowIso
    );

    const launched: string[] = [];
    const launch: LaunchExistingTask = async (params) => {
      launched.push(params.ticket.linear_issue_id);
      return true;
    };

    await redrainStalledSessionWork({ cfg, store, daytona, linear, linearOutbox, launch });

    expect(launched).toEqual(["drains"]);
  });

  it("no-ops without a Linear client so the work is retried on a later sweep", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    addTicket(store, "drains");
    enqueueCi(store, "drains", "gh-ci-drains");

    const launched: string[] = [];
    const launch: LaunchExistingTask = async (params) => {
      launched.push(params.ticket.linear_issue_id);
      return true;
    };

    await redrainStalledSessionWork({
      cfg,
      store,
      daytona,
      linear: undefined,
      linearOutbox,
      launch,
    });

    expect(launched).toEqual([]);
    // Still pending, so a later sweep that does have a client can pick it up.
    expect(
      store
        .listTicketsWithPendingSessionWork(new Date().toISOString())
        .map((t) => t.linear_issue_id)
    ).toEqual(["drains"]);
  });
});

// U2 / audit E4 (+ the E3 "exit zero conflates success" precedence slice): the
// wrapper/process exit code is the authoritative execution signal, and a
// nonzero result must never be converted to success by a later completion
// marker, a stale success-shaped terminal response, or a cleanup path.

describe("classifyExecutionOutcome", () => {
  it("treats only exit zero as success, resource-termination codes as infrastructure, and other nonzero as failure", () => {
    expect(classifyExecutionOutcome(0)).toBe("success");
    expect(classifyExecutionOutcome(1)).toBe("failure");
    expect(classifyExecutionOutcome(2)).toBe("failure");
    // 137 = 128 + SIGKILL(9): the OOM / resource-kill class.
    expect(classifyExecutionOutcome(137)).toBe("infrastructure_failure");
    // 143 = SIGTERM, 139 = SIGSEGV — also infrastructure terminations.
    expect(classifyExecutionOutcome(143)).toBe("infrastructure_failure");
    expect(classifyExecutionOutcome(139)).toBe("infrastructure_failure");
  });
});

describe("completeRun failure precedence", () => {
  const completeCfg = { reviewMaxRounds: 10, reviewNudgeComment: "" } as Config;

  beforeEach(() => {
    // Sandbox settlement runs against a stub Daytona and logs its (caught)
    // failure; keep the test output clean.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function seedRun(
    store: TicketStore,
    id: string,
    token: string,
    taskType: TaskType = "implement"
  ): void {
    addTicket(store, id);
    store.beginRun({
      issueId: id,
      runId: `run-${id}`,
      taskType,
      tokenHash: tokenHash(token),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  }

  function seedTerminalActivity(
    store: TicketStore,
    runId: string,
    sandboxId: string,
    type: "response" | "error" | "elicitation"
  ): void {
    const eventId = randomUUID();
    store.insertSandboxEvent({
      eventId,
      runId,
      sandboxId,
      kind: "activity",
      payload: JSON.stringify({ type }),
    });
    store.claimSandboxEvent(eventId, new Date().toISOString(), "2099-01-01T00:00:00.000Z");
    store.markSandboxEventProcessed(eventId);
  }

  function outboxActivities(store: TicketStore): Array<{ type: string; body?: string }> {
    return store
      .listLinearOutbox()
      .map(
        (row) =>
          JSON.parse(row.payload) as {
            type: string;
            activity?: AgentActivityInput & { body?: string };
          }
      )
      .filter((payload) => payload.type === "activity" && payload.activity !== undefined)
      .map((payload) => payload.activity as AgentActivityInput & { body?: string });
  }

  function makeDeps(store: TicketStore): {
    deps: Parameters<typeof completeRun>[0];
    background: Promise<void>[];
  } {
    const background: Promise<void>[] = [];
    const outbox: LinearOutboxProcessor = {
      process: async () => undefined,
      drain: async () => undefined,
    };
    const deps = {
      cfg: completeCfg,
      store,
      daytona,
      getLinearClient: async () => undefined,
      linearOutbox: outbox,
      schedule: (task: Promise<void>) => {
        background.push(task.catch(() => undefined));
      },
    };
    return { deps, background };
  }

  it("keeps a nonzero wrapper exit failed and still reports the failure despite a prior success-shaped terminal response (E4)", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    seedRun(store, "mask", "tok-mask");
    // A stale, success-shaped terminal response from the agent must NOT hide the
    // wrapper's later nonzero failure — it can neither flip the run to success
    // nor suppress the human-facing failure notice.
    seedTerminalActivity(store, "run-mask", "sbx-mask", "response");

    const { deps, background } = makeDeps(store);
    const result = await completeRun(deps, {
      runId: "run-mask",
      token: "tok-mask",
      exitCode: 1,
    });
    await Promise.all(background);

    expect(result.status).toBe(200);
    expect(store.getRun("run-mask")?.status).toBe("failed");
    expect(store.getByIssueId("mask")?.state).toBe("error");
    const errors = outboxActivities(store).filter((activity) => activity.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.body).toContain("exit 1");
  });

  it("suppresses the synthetic failure notice only when an error activity already represents the failure", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    seedRun(store, "dedup", "tok-dedup");
    seedTerminalActivity(store, "run-dedup", "sbx-dedup", "error");

    const { deps, background } = makeDeps(store);
    await completeRun(deps, { runId: "run-dedup", token: "tok-dedup", exitCode: 1 });
    await Promise.all(background);

    expect(store.getRun("run-dedup")?.status).toBe("failed");
    // The agent's own error already represents the failure — do not double-report.
    expect(outboxActivities(store).filter((activity) => activity.type === "error")).toHaveLength(0);
  });

  it("classifies exit 137 as an infrastructure failure and never a success, even behind a stale success response (E4 / R22)", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    seedRun(store, "oom", "tok-oom");
    seedTerminalActivity(store, "run-oom", "sbx-oom", "response");

    const { deps, background } = makeDeps(store);
    await completeRun(deps, { runId: "run-oom", token: "tok-oom", exitCode: 137 });
    await Promise.all(background);

    expect(store.getRun("run-oom")?.status).toBe("failed");
    expect(store.getByIssueId("oom")?.state).toBe("error");
    const errors = outboxActivities(store).filter((activity) => activity.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.body).toContain("exit 137");
    expect(errors[0]?.body?.toLowerCase()).toContain("infrastructure");
  });

  it("does not treat exit zero without a valid completion marker as success, and keeps the healthy exit-zero path (E3 precedence / R22)", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);

    // No valid exit-code marker → the callback is rejected and the run is never
    // flipped to a completed/success state (exit zero alone is not success).
    seedRun(store, "nomarker", "tok-nomarker");
    const noMarker = makeDeps(store);
    const rejected = await completeRun(noMarker.deps, {
      runId: "run-nomarker",
      token: "tok-nomarker",
      exitCode: undefined,
    });
    await Promise.all(noMarker.background);
    expect(rejected.status).toBe(400);
    expect(store.getRun("run-nomarker")?.status).toBe("running");

    // Exit zero WITH the required completion marker is the only success path and
    // must keep working for the healthy case.
    seedRun(store, "ok", "tok-ok");
    const healthy = makeDeps(store);
    const passed = await completeRun(healthy.deps, {
      runId: "run-ok",
      token: "tok-ok",
      exitCode: 0,
    });
    await Promise.all(healthy.background);
    expect(passed.status).toBe(200);
    expect(store.getRun("run-ok")?.status).toBe("completed");
    expect(store.getByIssueId("ok")?.state).toBe("active");
    expect(outboxActivities(store).some((activity) => activity.type === "response")).toBe(true);
  });
});
