import type { Daytona } from "@daytona/sdk";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import type { LinearClient } from "./linear.js";
import type { LinearOutboxProcessor } from "./linear-outbox.js";
import type { LaunchExistingTask } from "./scheduler.js";
import { createTicketStore, openDb, type TicketStore } from "./db.js";
import { redrainStalledSessionWork } from "./run-lifecycle.js";

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
