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
  it("durably registers repositories and resolves Linear team IDs before keys", () => {
    const store = makeStore();
    store.registerRepository({
      linearTeamKey: "ENG",
      linearTeamId: "team-1",
      githubRepo: "acme/widget",
      baseBranch: "develop",
      webhookId: 42,
      snapshot: "openthrottle",
    });
    expect(store.getRepositoryRegistration(undefined, "eng")).toMatchObject({
      github_repo: "acme/widget",
      base_branch: "develop",
    });
    expect(store.getRepositoryRegistration("team-1", "OTHER")?.linear_team_key).toBe("ENG");
    expect(store.listRepositoryRegistrations()).toHaveLength(1);
    expect(store.hasRepositoryRegistrations()).toBe(true);

    store.registerRepository({
      linearTeamKey: "PLATFORM",
      linearTeamId: "team-1",
      githubRepo: "acme/platform",
      baseBranch: "main",
      webhookId: 43,
      snapshot: "openthrottle-v2",
    });
    expect(store.getRepositoryRegistration(undefined, "ENG")).toBeUndefined();
    expect(store.getRepositoryRegistration("team-1")?.github_repo).toBe("acme/platform");
  });

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
      logTail: "private durable log",
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
    expect(completed?.log_tail).toBe("private durable log");
    expect(store.getLatestRun("issue-1")?.id).toBe("run-1");
    expect(store.finishRun({ runId: "run-1", status: "completed" })).toBeUndefined();

    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-2",
      taskType: "resume",
      tokenHash: "hash-2",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).toBe(true);
    store.finishRun({ runId: "run-2", status: "completed", logTail: "new durable log" });
    expect(store.getRun("run-1")?.log_tail).toBeNull();
    expect(store.getLatestRun("issue-1")?.log_tail).toBe("new durable log");

    expect(store.beginRun({
      issueId: "issue-1",
      runId: "run-3",
      taskType: "resume",
      tokenHash: "hash-3",
      expiresAt: "2099-01-01T00:00:00.000Z",
    })).toBe(true);
    store.finishRun({ runId: "run-3", status: "failed" });
    expect(store.getLatestRun("issue-1")?.id).toBe("run-3");
    expect(store.getLatestRunWithLog("issue-1")?.id).toBe("run-2");
  });

  it("deduplicates webhook deliveries and persists settings", () => {
    const store = makeStore();
    const claim = { deliveryId: "delivery", source: "linear" as const, action: "created" };
    expect(store.claimDelivery(claim)).toBe(true);
    expect(store.claimDelivery(claim)).toBe(false);
    store.setSetting("key", "value");
    expect(store.getSetting("key")).toBe("value");
  });

  it("tracks session generations and enforces immutable ordered outbox rows", () => {
    const store = makeStore();
    const firstSession = store.getCurrentSession("issue-1");
    expect(firstSession).toMatchObject({
      id: "session-1",
      generation: 1,
      state: "current",
    });

    store.upsert({
      ...store.getByIssueId("issue-1")!,
      linear_session_id: "session-2",
    });
    expect(store.getSession("session-1")?.state).toBe("superseded");
    expect(store.getCurrentSession("issue-1")).toMatchObject({
      id: "session-2",
      generation: 2,
      state: "current",
    });

    const first = store.enqueueLinearOutbox({
      id: "11111111-1111-4111-8111-111111111111",
      linearSessionId: "session-2",
      issueId: "issue-1",
      kind: "activity",
      payload: JSON.stringify({ type: "activity", activity: { sessionId: "session-2", type: "response", body: "done" } }),
    });
    const second = store.enqueueLinearOutbox({
      linearSessionId: "session-2",
      issueId: "issue-1",
      kind: "session_update",
      payload: JSON.stringify({ type: "session_update", sessionId: "session-2" }),
    });
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(() =>
      store.enqueueLinearOutbox({
        id: "11111111-1111-4111-8111-111111111111",
        linearSessionId: "session-2",
        issueId: "issue-1",
        kind: "activity",
        payload: JSON.stringify({ type: "activity", activity: { sessionId: "session-2", type: "response", body: "changed" } }),
      })
    ).toThrow(/different intent/);
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

  it("persists Linear context and prunes only processed sandbox events", () => {
    const store = makeStore();
    store.setLinearContext("issue-1", "# OT-1\n\nApproved plan");
    store.beginRun({
      issueId: "issue-1",
      runId: "run-events",
      taskType: "implement",
      tokenHash: "hash",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    for (const eventId of [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]) {
      store.insertSandboxEvent({
        eventId,
        runId: "run-events",
        sandboxId: "sandbox-1",
        kind: "activity",
        payload: JSON.stringify({ type: "thought" }),
      });
    }
    store.claimSandboxEvent(
      "11111111-1111-4111-8111-111111111111",
      new Date().toISOString(),
      "2099-01-01T00:00:00.000Z"
    );
    store.markSandboxEventProcessed("11111111-1111-4111-8111-111111111111");
    db!.prepare("UPDATE sandbox_events SET processed_at = ?, created_at = ?").run(
      "2020-01-01T00:00:00.000Z",
      "2020-01-01T00:00:00.000Z"
    );

    expect(store.getByIssueId("issue-1")?.linear_context).toBe("# OT-1\n\nApproved plan");
    expect(store.pruneSandboxEvents("2021-01-01T00:00:00.000Z")).toBe(1);
    expect(store.getSandboxEvent("11111111-1111-4111-8111-111111111111")).toBeUndefined();
    expect(store.getSandboxEvent("22222222-2222-4222-8222-222222222222")).toBeDefined();
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

  it("adds durable log storage to an existing runs table", () => {
    const dir = mkdtempSync(join(tmpdir(), "openthrottle-runs-db-"));
    tempDirs.push(dir);
    const path = join(dir, "legacy-runs.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        linear_issue_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        started_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        completed_at TEXT,
        exit_code INTEGER,
        cost_usd REAL,
        pr_url TEXT,
        failure_tail TEXT
      );
    `);
    legacy.close();

    db = openDb(path);
    const columns = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("log_tail");
  });

  it("adds the per-ticket base branch to an existing tickets table", () => {
    const dir = mkdtempSync(join(tmpdir(), "openthrottle-tickets-db-"));
    tempDirs.push(dir);
    const path = join(dir, "legacy-tickets.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE tickets (
        linear_issue_id TEXT PRIMARY KEY,
        linear_issue_identifier TEXT NOT NULL,
        linear_session_id TEXT NOT NULL,
        sandbox_id TEXT,
        branch TEXT NOT NULL,
        agent TEXT NOT NULL DEFAULT 'claude',
        repo TEXT NOT NULL,
        pr_url TEXT,
        state TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO tickets VALUES (
        'issue-legacy', 'OT-LEGACY', 'session', NULL, 'ot/legacy', 'codex',
        'owner/repo', NULL, 'active', '2026-01-01', '2026-01-01'
      );
    `);
    legacy.close();
    db = openDb(path);
    expect(createTicketStore(db).getByIssueId("issue-legacy")?.base_branch).toBe("main");
  });

  it("backfills current agent sessions for legacy tickets", () => {
    const dir = mkdtempSync(join(tmpdir(), "openthrottle-sessions-db-"));
    tempDirs.push(dir);
    const path = join(dir, "legacy-sessions.db");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE tickets (
        linear_issue_id TEXT PRIMARY KEY,
        linear_issue_identifier TEXT NOT NULL,
        linear_session_id TEXT NOT NULL,
        sandbox_id TEXT,
        branch TEXT NOT NULL,
        agent TEXT NOT NULL DEFAULT 'claude',
        repo TEXT NOT NULL,
        pr_url TEXT,
        state TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO tickets VALUES (
        'issue-legacy', 'OT-LEGACY', 'session-legacy', NULL, 'ot/legacy',
        'codex', 'owner/repo', NULL, 'active', '2026-01-01', '2026-01-02'
      );
    `);
    legacy.close();

    db = openDb(path);
    const store = createTicketStore(db);

    expect(store.getSession("session-legacy")).toMatchObject({
      id: "session-legacy",
      linear_issue_id: "issue-legacy",
      generation: 1,
      state: "current",
      created_at: "2026-01-01",
      updated_at: "2026-01-02",
    });
    expect(
      store.enqueueSessionWork({
        id: "prompt-legacy",
        linearSessionId: "session-legacy",
        issueId: "issue-legacy",
        source: "human",
        body: "continue",
      })
    ).toBe(true);
  });
});
