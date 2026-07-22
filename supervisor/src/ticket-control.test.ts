import type { Daytona } from "@daytona/sdk";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTicketStore, openDb, type TicketStore } from "./db.js";
import type { LinearOutboxProcessor } from "./linear-outbox.js";
import { stopTicket } from "./ticket-control.js";

let db: Database.Database | undefined;
afterEach(() => db?.close());

function addRunningTicket(store: TicketStore) {
  store.upsert({
    linear_issue_id: "issue-1",
    linear_issue_identifier: "OT-1",
    linear_session_id: "session-1",
    sandbox_id: "sandbox-1",
    branch: "ot/ot-1",
    agent: "claude",
    repo: "owner/repo",
    pr_url: null,
    state: "active",
  });
  store.beginRun({
    issueId: "issue-1",
    runId: "run-1",
    taskType: "implement",
    tokenHash: "hash",
    expiresAt: "2999-01-01T00:00:00.000Z",
  });
  return store.getByIssueId("issue-1")!;
}

function makeOutbox(): LinearOutboxProcessor {
  return {
    process: vi.fn(async () => undefined),
    drain: vi.fn(async () => undefined),
  };
}

describe("exclusive ticket settlement", () => {
  it("keeps the run non-dispatchable until stop confirms actor termination", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    const ticket = addRunningTicket(store);
    let statusDuringStop: string | undefined;
    const sandbox = {
      stop: vi.fn(async () => {
        statusDuringStop = store.getRun("run-1")?.status;
        expect(store.getByIssueId("issue-1")?.run_id).toBe("run-1");
      }),
    };
    const daytona = { get: vi.fn(async () => sandbox) } as unknown as Daytona;

    await stopTicket({
      store,
      daytona,
      linear: undefined,
      linearOutbox: makeOutbox(),
      ticket,
      reason: "Stopped by operator.",
    });

    expect(statusDuringStop).toBe("reaping");
    expect(store.getRun("run-1")?.status).toBe("stopped");
    expect(store.getByIssueId("issue-1")).toMatchObject({
      state: "stopped",
      run_id: null,
    });
  });

  it("does no stop or publication side effects when completion wins the CAS", async () => {
    db = openDb(":memory:");
    const store = createTicketStore(db);
    const staleTicket = addRunningTicket(store);
    store.finishRun({ runId: "run-1", status: "completed" });
    const sandbox = { stop: vi.fn(async () => undefined) };
    const daytona = { get: vi.fn(async () => sandbox) } as unknown as Daytona;
    const linearOutbox = makeOutbox();

    await stopTicket({
      store,
      daytona,
      linear: undefined,
      linearOutbox,
      ticket: staleTicket,
      reason: "Stopped by operator.",
    });

    expect(daytona.get).not.toHaveBeenCalled();
    expect(store.listLinearOutbox()).toHaveLength(0);
    expect(linearOutbox.process).not.toHaveBeenCalled();
    expect(linearOutbox.drain).not.toHaveBeenCalled();
    expect(store.getRun("run-1")?.status).toBe("completed");
  });
});
