import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (
  linear_issue_id TEXT PRIMARY KEY,
  linear_issue_identifier TEXT NOT NULL,
  linear_session_id TEXT NOT NULL,
  sandbox_id TEXT,
  branch TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT 'claude',
  repo TEXT NOT NULL,
  pr_url TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  running_since TEXT,
  run_id TEXT,
  total_cost_usd REAL NOT NULL DEFAULT 0,
  last_error TEXT,
  preview_token_hash TEXT,
  linear_context TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_repo_branch_idx ON tickets(repo, branch);
CREATE INDEX IF NOT EXISTS tickets_sandbox_idx ON tickets(sandbox_id);

CREATE TABLE IF NOT EXISTS runs (
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
  failure_tail TEXT,
  FOREIGN KEY(linear_issue_id) REFERENCES tickets(linear_issue_id)
);
CREATE INDEX IF NOT EXISTS runs_ticket_idx ON runs(linear_issue_id, started_at);
CREATE INDEX IF NOT EXISTS runs_expiry_idx ON runs(status, expires_at);

CREATE TABLE IF NOT EXISTS sandbox_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  processed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id)
);
CREATE INDEX IF NOT EXISTS sandbox_events_process_idx
  ON sandbox_events(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  session_id TEXT,
  action TEXT NOT NULL,
  activity_id TEXT,
  event_name TEXT,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'processed',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  processed_at TEXT,
  last_error TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_received_idx
  ON webhook_deliveries(received_at);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`;

const TICKET_MIGRATIONS: Array<[string, string]> = [
  ["running_since", "ALTER TABLE tickets ADD COLUMN running_since TEXT"],
  ["run_id", "ALTER TABLE tickets ADD COLUMN run_id TEXT"],
  ["total_cost_usd", "ALTER TABLE tickets ADD COLUMN total_cost_usd REAL NOT NULL DEFAULT 0"],
  ["last_error", "ALTER TABLE tickets ADD COLUMN last_error TEXT"],
  ["preview_token_hash", "ALTER TABLE tickets ADD COLUMN preview_token_hash TEXT"],
  ["linear_context", "ALTER TABLE tickets ADD COLUMN linear_context TEXT"],
];

const DELIVERY_MIGRATIONS: Array<[string, string]> = [
  ["event_name", "ALTER TABLE webhook_deliveries ADD COLUMN event_name TEXT"],
  ["payload", "ALTER TABLE webhook_deliveries ADD COLUMN payload TEXT"],
  ["status", "ALTER TABLE webhook_deliveries ADD COLUMN status TEXT NOT NULL DEFAULT 'processed'"],
  ["attempts", "ALTER TABLE webhook_deliveries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0"],
  ["next_attempt_at", "ALTER TABLE webhook_deliveries ADD COLUMN next_attempt_at TEXT"],
  ["processed_at", "ALTER TABLE webhook_deliveries ADD COLUMN processed_at TEXT"],
  ["last_error", "ALTER TABLE webhook_deliveries ADD COLUMN last_error TEXT"],
];

export type Agent = "claude" | "codex";
export type TicketState = "active" | "closed" | "expired" | "error" | "stopped";
export type TaskType = "implement" | "resume" | "review" | "review-fix" | "investigate";
export type RunStatus = "running" | "completed" | "failed" | "timed_out" | "stopped";

export interface Ticket {
  linear_issue_id: string;
  linear_issue_identifier: string;
  linear_session_id: string;
  sandbox_id: string | null;
  branch: string;
  agent: Agent;
  repo: string;
  pr_url: string | null;
  state: TicketState;
  running_since: string | null;
  run_id: string | null;
  total_cost_usd: number;
  last_error: string | null;
  preview_token_hash: string | null;
  linear_context: string | null;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  linear_issue_id: string;
  task_type: TaskType;
  token_hash: string;
  status: RunStatus;
  started_at: string;
  expires_at: string;
  completed_at: string | null;
  exit_code: number | null;
  cost_usd: number | null;
  pr_url: string | null;
  failure_tail: string | null;
}

export type TicketUpsert = Pick<
  Ticket,
  | "linear_issue_id"
  | "linear_issue_identifier"
  | "linear_session_id"
  | "sandbox_id"
  | "branch"
  | "agent"
  | "repo"
  | "pr_url"
  | "state"
>;

export interface DeliveryClaim {
  deliveryId: string;
  source: "linear" | "github";
  sessionId?: string;
  action: string;
  activityId?: string;
  eventName?: string;
  payload?: string;
}

export interface WebhookDelivery {
  id: string;
  source: "linear" | "github";
  session_id: string | null;
  action: string;
  activity_id: string | null;
  event_name: string | null;
  payload: string | null;
  status: "pending" | "processing" | "failed" | "processed" | "dead";
  attempts: number;
  next_attempt_at: string | null;
  processed_at: string | null;
  last_error: string | null;
  received_at: string;
}

export interface SandboxEventRecord {
  event_id: string;
  run_id: string;
  sandbox_id: string;
  kind: "activity" | "completion";
  payload: string;
  status: "pending" | "processing" | "failed" | "processed";
  attempts: number;
  next_attempt_at: string;
  processed_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface FinishRunParams {
  runId: string;
  status: Exclude<RunStatus, "running">;
  exitCode?: number;
  costUsd?: number;
  prUrl?: string;
  failureTail?: string;
  ticketState?: TicketState;
}

export function openDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  const columns = new Set(
    (db.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  for (const [column, sql] of TICKET_MIGRATIONS) {
    if (!columns.has(column)) db.exec(sql);
  }
  const deliveryColumns = new Set(
    (db.prepare("PRAGMA table_info(webhook_deliveries)").all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  for (const [column, sql] of DELIVERY_MIGRATIONS) {
    if (!deliveryColumns.has(column)) db.exec(sql);
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS tickets_repo_branch_idx ON tickets(repo, branch);" +
      "CREATE INDEX IF NOT EXISTS tickets_sandbox_idx ON tickets(sandbox_id);" +
      "CREATE INDEX IF NOT EXISTS webhook_deliveries_process_idx ON webhook_deliveries(status, next_attempt_at);"
  );
  return db;
}

export interface TicketStore {
  db: Database.Database;
  upsert(ticket: TicketUpsert): void;
  getByIssueId(issueId: string): Ticket | undefined;
  getByIdentifier(identifier: string): Ticket | undefined;
  getByBranch(repo: string, branch: string): Ticket | undefined;
  getBySandboxId(sandboxId: string): Ticket | undefined;
  setSandboxId(issueId: string, sandboxId: string | null): void;
  setState(issueId: string, state: TicketState, lastError?: string): void;
  setPrUrl(issueId: string, prUrl: string): void;
  setPreviewTokenHash(issueId: string, tokenHash: string): void;
  setLinearContext(issueId: string, context: string): void;
  listActive(): Ticket[];
  listRunning(): Ticket[];
  listAll(): Ticket[];
  claimDelivery(claim: DeliveryClaim): boolean;
  claimDeliveryForProcessing(params: {
    deliveryId: string;
    nowIso: string;
    leaseUntilIso: string;
  }): WebhookDelivery | undefined;
  markDeliveryProcessed(deliveryId: string): void;
  markDeliveryFailed(deliveryId: string, error: string, retryAt: string | null): void;
  listProcessableDeliveries(nowIso: string, limit: number): WebhookDelivery[];
  pruneDeliveries(beforeIso: string): number;
  beginRun(params: {
    issueId: string;
    runId: string;
    taskType: TaskType;
    tokenHash: string;
    expiresAt: string;
  }): boolean;
  getRun(runId: string): Run | undefined;
  finishRun(params: FinishRunParams): Run | undefined;
  listExpiredRuns(nowIso: string): Run[];
  insertSandboxEvent(params: {
    eventId: string;
    runId: string;
    sandboxId: string;
    kind: "activity" | "completion";
    payload: string;
  }): SandboxEventRecord;
  getSandboxEvent(eventId: string): SandboxEventRecord | undefined;
  getLastProcessedSandboxActivity(runId: string): SandboxEventRecord | undefined;
  claimSandboxEvent(eventId: string, nowIso: string, leaseUntilIso: string): SandboxEventRecord | undefined;
  markSandboxEventProcessed(eventId: string): void;
  markSandboxEventFailed(eventId: string, error: string, retryAt: string): void;
  pruneSandboxEvents(beforeIso: string): number;
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
}

export function createTicketStore(db: Database.Database): TicketStore {
  const now = () => new Date().toISOString();
  const upsertStmt = db.prepare(`
    INSERT INTO tickets (
      linear_issue_id, linear_issue_identifier, linear_session_id,
      sandbox_id, branch, agent, repo, pr_url, state, created_at, updated_at
    ) VALUES (
      @linear_issue_id, @linear_issue_identifier, @linear_session_id,
      @sandbox_id, @branch, @agent, @repo, @pr_url, @state, @created_at, @updated_at
    )
    ON CONFLICT(linear_issue_id) DO UPDATE SET
      linear_issue_identifier = excluded.linear_issue_identifier,
      linear_session_id = excluded.linear_session_id,
      sandbox_id = excluded.sandbox_id,
      branch = excluded.branch,
      agent = excluded.agent,
      repo = excluded.repo,
      pr_url = excluded.pr_url,
      state = excluded.state,
      updated_at = excluded.updated_at
  `);
  const getByIssueIdStmt = db.prepare("SELECT * FROM tickets WHERE linear_issue_id = ?");
  const getByIdentifierStmt = db.prepare(
    "SELECT * FROM tickets WHERE lower(linear_issue_identifier) = lower(?)"
  );
  const getByBranchStmt = db.prepare("SELECT * FROM tickets WHERE repo = ? AND branch = ?");
  const getBySandboxIdStmt = db.prepare("SELECT * FROM tickets WHERE sandbox_id = ?");
  const setSandboxIdStmt = db.prepare(
    "UPDATE tickets SET sandbox_id = ?, updated_at = ? WHERE linear_issue_id = ?"
  );
  const setStateStmt = db.prepare(
    "UPDATE tickets SET state = ?, last_error = ?, updated_at = ? WHERE linear_issue_id = ?"
  );
  const setPrUrlStmt = db.prepare(
    "UPDATE tickets SET pr_url = ?, updated_at = ? WHERE linear_issue_id = ?"
  );
  const setPreviewTokenHashStmt = db.prepare(
    "UPDATE tickets SET preview_token_hash = ?, updated_at = ? WHERE linear_issue_id = ?"
  );
  const setLinearContextStmt = db.prepare(
    "UPDATE tickets SET linear_context = ?, updated_at = ? WHERE linear_issue_id = ?"
  );
  const listActiveStmt = db.prepare("SELECT * FROM tickets WHERE state = 'active'");
  const listRunningStmt = db.prepare(
    "SELECT * FROM tickets WHERE run_id IS NOT NULL AND running_since IS NOT NULL ORDER BY running_since"
  );
  const listAllStmt = db.prepare("SELECT * FROM tickets ORDER BY created_at DESC");
  const claimDeliveryStmt = db.prepare(`
    INSERT OR IGNORE INTO webhook_deliveries (
      delivery_id, source, session_id, action, activity_id, event_name,
      payload, status, attempts, next_attempt_at, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `);
  const pruneDeliveriesStmt = db.prepare(
    "DELETE FROM webhook_deliveries WHERE received_at < ?"
  );
  const pruneSandboxEventsStmt = db.prepare(
    "DELETE FROM sandbox_events WHERE status = 'processed' AND processed_at < ?"
  );
  const getRunStmt = db.prepare("SELECT * FROM runs WHERE id = ?");
  const listExpiredRunsStmt = db.prepare(
    "SELECT * FROM runs WHERE status = 'running' AND expires_at <= ? ORDER BY expires_at"
  );
  const insertSandboxEventStmt = db.prepare(`
    INSERT OR IGNORE INTO sandbox_events (
      event_id, run_id, sandbox_id, kind, payload, status,
      attempts, next_attempt_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `);
  const getSandboxEventStmt = db.prepare("SELECT * FROM sandbox_events WHERE event_id = ?");
  const getLastProcessedSandboxActivityStmt = db.prepare(`
    SELECT * FROM sandbox_events
    WHERE run_id = ? AND kind = 'activity' AND status = 'processed'
    ORDER BY processed_at DESC, created_at DESC
    LIMIT 1
  `);
  const getSettingStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
  const setSettingStmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const getDeliveryStmt = db.prepare(
    "SELECT delivery_id AS id, * FROM webhook_deliveries WHERE delivery_id = ?"
  );
  const listProcessableDeliveriesStmt = db.prepare(`
    SELECT delivery_id AS id, * FROM webhook_deliveries
    WHERE ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
      OR (status = 'processing' AND next_attempt_at <= ?))
    ORDER BY received_at
    LIMIT ?
  `);

  const claimDeliveryForProcessingTransaction = db.transaction(
    (params: {
      deliveryId: string;
      nowIso: string;
      leaseUntilIso: string;
    }): WebhookDelivery | undefined => {
      const update = db.prepare(`
        UPDATE webhook_deliveries
        SET status = 'processing', attempts = attempts + 1,
            next_attempt_at = ?, last_error = NULL
        WHERE delivery_id = ?
          AND ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
            OR (status = 'processing' AND next_attempt_at <= ?))
      `).run(params.leaseUntilIso, params.deliveryId, params.nowIso, params.nowIso);
      if (update.changes !== 1) return undefined;
      return getDeliveryStmt.get(params.deliveryId) as WebhookDelivery;
    }
  );

  const beginRunTransaction = db.transaction(
    (params: {
      issueId: string;
      runId: string;
      taskType: TaskType;
      tokenHash: string;
      expiresAt: string;
    }): boolean => {
      const startedAt = now();
      const update = db
        .prepare(`
          UPDATE tickets
          SET running_since = ?, run_id = ?, state = 'active', last_error = NULL, updated_at = ?
          WHERE linear_issue_id = ? AND running_since IS NULL
        `)
        .run(startedAt, params.runId, startedAt, params.issueId);
      if (update.changes !== 1) return false;
      db.prepare(`
        INSERT INTO runs (
          id, linear_issue_id, task_type, token_hash, status, started_at, expires_at
        ) VALUES (?, ?, ?, ?, 'running', ?, ?)
      `).run(
        params.runId,
        params.issueId,
        params.taskType,
        params.tokenHash,
        startedAt,
        params.expiresAt
      );
      return true;
    }
  );

  const finishRunTransaction = db.transaction((params: FinishRunParams): Run | undefined => {
    const existing = getRunStmt.get(params.runId) as Run | undefined;
    if (!existing || existing.status !== "running") return undefined;
    const completedAt = now();
    db.prepare(`
      UPDATE runs SET
        status = ?, completed_at = ?, exit_code = ?, cost_usd = ?, pr_url = ?, failure_tail = ?
      WHERE id = ? AND status = 'running'
    `).run(
      params.status,
      completedAt,
      params.exitCode ?? null,
      params.costUsd ?? null,
      params.prUrl ?? null,
      params.failureTail ?? null,
      params.runId
    );
    db.prepare(`
      UPDATE tickets SET
        running_since = NULL,
        run_id = NULL,
        state = COALESCE(?, state),
        pr_url = COALESCE(?, pr_url),
        total_cost_usd = total_cost_usd + COALESCE(?, 0),
        last_error = ?,
        updated_at = ?
      WHERE linear_issue_id = ? AND run_id = ?
    `).run(
      params.ticketState ?? null,
      params.prUrl ?? null,
      params.costUsd ?? null,
      params.failureTail ?? null,
      completedAt,
      existing.linear_issue_id,
      params.runId
    );
    return getRunStmt.get(params.runId) as Run;
  });

  const claimSandboxEventTransaction = db.transaction(
    (eventId: string, nowIso: string, leaseUntilIso: string): SandboxEventRecord | undefined => {
      const updated = db.prepare(`
        UPDATE sandbox_events
        SET status = 'processing', attempts = attempts + 1,
            next_attempt_at = ?, last_error = NULL
        WHERE event_id = ?
          AND ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
            OR (status = 'processing' AND next_attempt_at <= ?))
      `).run(leaseUntilIso, eventId, nowIso, nowIso);
      if (updated.changes !== 1) return undefined;
      return getSandboxEventStmt.get(eventId) as SandboxEventRecord;
    }
  );

  return {
    db,
    upsert(ticket) {
      const existing = getByIssueIdStmt.get(ticket.linear_issue_id) as Ticket | undefined;
      upsertStmt.run({
        ...ticket,
        created_at: existing?.created_at ?? now(),
        updated_at: now(),
      });
    },
    getByIssueId(issueId) {
      return getByIssueIdStmt.get(issueId) as Ticket | undefined;
    },
    getByIdentifier(identifier) {
      return getByIdentifierStmt.get(identifier) as Ticket | undefined;
    },
    getByBranch(repo, branch) {
      return getByBranchStmt.get(repo, branch) as Ticket | undefined;
    },
    getBySandboxId(sandboxId) {
      return getBySandboxIdStmt.get(sandboxId) as Ticket | undefined;
    },
    setSandboxId(issueId, sandboxId) {
      setSandboxIdStmt.run(sandboxId, now(), issueId);
    },
    setState(issueId, state, lastError) {
      setStateStmt.run(state, lastError ?? null, now(), issueId);
    },
    setPrUrl(issueId, prUrl) {
      setPrUrlStmt.run(prUrl, now(), issueId);
    },
    setPreviewTokenHash(issueId, tokenHash) {
      setPreviewTokenHashStmt.run(tokenHash, now(), issueId);
    },
    setLinearContext(issueId, context) {
      setLinearContextStmt.run(context, now(), issueId);
    },
    listActive() {
      return listActiveStmt.all() as Ticket[];
    },
    listRunning() {
      return listRunningStmt.all() as Ticket[];
    },
    listAll() {
      return listAllStmt.all() as Ticket[];
    },
    claimDelivery(claim) {
      const receivedAt = now();
      return (
        claimDeliveryStmt.run(
          claim.deliveryId,
          claim.source,
          claim.sessionId ?? null,
          claim.action,
          claim.activityId ?? null,
          claim.eventName ?? null,
          claim.payload ?? null,
          receivedAt,
          receivedAt
        ).changes === 1
      );
    },
    claimDeliveryForProcessing(params) {
      return claimDeliveryForProcessingTransaction(params);
    },
    markDeliveryProcessed(deliveryId) {
      const processedAt = now();
      db.prepare(`
        UPDATE webhook_deliveries
        SET status = 'processed', processed_at = ?, next_attempt_at = NULL, last_error = NULL
        WHERE delivery_id = ?
      `).run(processedAt, deliveryId);
    },
    markDeliveryFailed(deliveryId, error, retryAt) {
      db.prepare(`
        UPDATE webhook_deliveries
        SET status = ?, next_attempt_at = ?, last_error = ?
        WHERE delivery_id = ?
      `).run(retryAt ? "failed" : "dead", retryAt, error, deliveryId);
    },
    listProcessableDeliveries(nowIso, limit) {
      return listProcessableDeliveriesStmt.all(nowIso, nowIso, limit) as WebhookDelivery[];
    },
    pruneDeliveries(beforeIso) {
      return pruneDeliveriesStmt.run(beforeIso).changes;
    },
    beginRun(params) {
      return beginRunTransaction(params);
    },
    getRun(runId) {
      return getRunStmt.get(runId) as Run | undefined;
    },
    finishRun(params) {
      return finishRunTransaction(params);
    },
    listExpiredRuns(nowIso) {
      return listExpiredRunsStmt.all(nowIso) as Run[];
    },
    insertSandboxEvent(params) {
      const createdAt = now();
      insertSandboxEventStmt.run(
        params.eventId,
        params.runId,
        params.sandboxId,
        params.kind,
        params.payload,
        createdAt,
        createdAt
      );
      return getSandboxEventStmt.get(params.eventId) as SandboxEventRecord;
    },
    getSandboxEvent(eventId) {
      return getSandboxEventStmt.get(eventId) as SandboxEventRecord | undefined;
    },
    getLastProcessedSandboxActivity(runId) {
      return getLastProcessedSandboxActivityStmt.get(runId) as SandboxEventRecord | undefined;
    },
    claimSandboxEvent(eventId, nowIso, leaseUntilIso) {
      return claimSandboxEventTransaction(eventId, nowIso, leaseUntilIso);
    },
    markSandboxEventProcessed(eventId) {
      const processedAt = now();
      db.prepare(`
        UPDATE sandbox_events
        SET status = 'processed', processed_at = ?, next_attempt_at = ?, last_error = NULL
        WHERE event_id = ?
      `).run(processedAt, processedAt, eventId);
    },
    markSandboxEventFailed(eventId, error, retryAt) {
      db.prepare(`
        UPDATE sandbox_events
        SET status = 'failed', next_attempt_at = ?, last_error = ?
        WHERE event_id = ?
      `).run(retryAt, error, eventId);
    },
    pruneSandboxEvents(beforeIso) {
      return pruneSandboxEventsStmt.run(beforeIso).changes;
    },
    getSetting(key) {
      const row = getSettingStmt.get(key) as { value: string } | undefined;
      return row?.value;
    },
    setSetting(key, value) {
      setSettingStmt.run(key, value);
    },
  };
}
