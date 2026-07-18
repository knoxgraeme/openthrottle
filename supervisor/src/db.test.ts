import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTicketStore, openDb } from "./db.js";

let db: Database.Database | undefined;
const tempDirs: string[] = [];
afterEach(() => {
  db?.close();
  db = undefined;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStore() {
  db = openDb(":memory:");
  const store = createTicketStore(db);
  store.upsert({
    linear_issue_id: "issue-1",
    linear_issue_identifier: "OT-1",
    linear_session_id: "session-1",
    sandbox_id: null,
    branch: "ot/ot-1",
    agent: "claude",
    repo: "owner/repo",
    pr_url: null,
    state: "active",
  });
  return store;
}

describe("TicketStore", () => {
  it("serializes runs atomically and records completion/cost", () => {
    const store = makeStore();
    const first = store.beginRun({
      issueId: "issue-1",
      runId: "run-1",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const second = store.beginRun({
      issueId: "issue-1",
      runId: "run-2",
      taskType: "resume",
      tokenHash: "hash2",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(first).toBe(true);
    expect(second).toBe(false);

    const completed = store.finishRun({
      runId: "run-1",
      status: "completed",
      exitCode: 0,
      costUsd: 1.25,
      prUrl: "https://github.com/owner/repo/pull/1",
      ticketState: "active",
    });
    expect(store.getByIssueId("issue-1")).toMatchObject({
      run_id: null,
      running_since: null,
      total_cost_usd: 1.25,
      pr_url: "https://github.com/owner/repo/pull/1",
    });
    expect(store.getRun("run-1")).toMatchObject({ status: "completed", exit_code: 0 });
    expect(completed?.status).toBe("completed");
    expect(store.finishRun({ runId: "run-1", status: "completed" })).toBeUndefined();
  });

  it("deduplicates webhook deliveries and persists settings", () => {
    const store = makeStore();
    const claim = { deliveryId: "delivery", source: "linear" as const, action: "created" };
    expect(store.claimDelivery(claim)).toBe(true);
    expect(store.claimDelivery(claim)).toBe(false);
    store.setSetting("key", "value");
    expect(store.getSetting("key")).toBe("value");
  });

  it("finds expired running work", () => {
    const store = makeStore();
    store.beginRun({
      issueId: "issue-1",
      runId: "run-1",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(store.listExpiredRuns("2021-01-01T00:00:00.000Z")).toHaveLength(1);
  });

  it("migrates legacy delivery rows without replaying already acknowledged events", () => {
    const dir = mkdtempSync(join(tmpdir(), "openthrottle-db-"));
    tempDirs.push(dir);
    const path = join(dir, "legacy.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        session_id TEXT,
        action TEXT NOT NULL,
        activity_id TEXT,
        received_at TEXT NOT NULL
      );
      INSERT INTO webhook_deliveries (
        delivery_id, source, session_id, action, activity_id, received_at
      ) VALUES (
        'legacy-delivery', 'linear', 'session-1', 'created', NULL,
        '2026-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    db = openDb(path);
    const store = createTicketStore(db);
    expect(
      db.prepare(
        "SELECT status, attempts, payload, processed_at, last_error FROM webhook_deliveries WHERE delivery_id = ?"
      ).get("legacy-delivery")
    ).toEqual({
      status: "processed",
      attempts: 0,
      payload: null,
      processed_at: null,
      last_error: null,
    });
    expect(store.listProcessableDeliveries("2099-01-01T00:00:00.000Z", 10)).toEqual([]);

    expect(
      store.claimDelivery({
        deliveryId: "new-delivery",
        source: "github",
        action: "closed",
        eventName: "pull_request",
        payload: "{}",
      })
    ).toBe(true);
    expect(store.listProcessableDeliveries("2099-01-01T00:00:00.000Z", 10)).toEqual([
      expect.objectContaining({ id: "new-delivery", status: "pending", attempts: 0 }),
    ]);
  });
});
