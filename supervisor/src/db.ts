import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
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
  base_branch TEXT NOT NULL DEFAULT 'main',
  pending_re_review INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_repo_branch_idx ON tickets(repo, branch);
CREATE INDEX IF NOT EXISTS tickets_sandbox_idx ON tickets(sandbox_id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  linear_issue_id TEXT NOT NULL,
  linear_session_id TEXT,
  session_generation INTEGER,
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
  log_tail TEXT,
  FOREIGN KEY(linear_issue_id) REFERENCES tickets(linear_issue_id)
);
CREATE INDEX IF NOT EXISTS runs_ticket_idx ON runs(linear_issue_id, started_at);
CREATE INDEX IF NOT EXISTS runs_expiry_idx ON runs(status, expires_at);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  linear_issue_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'current',
  provider_conversation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  superseded_at TEXT,
  UNIQUE(linear_issue_id, generation),
  FOREIGN KEY(linear_issue_id) REFERENCES tickets(linear_issue_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_current_issue_idx
  ON agent_sessions(linear_issue_id)
  WHERE state = 'current';
CREATE INDEX IF NOT EXISTS agent_sessions_issue_generation_idx
  ON agent_sessions(linear_issue_id, generation);

CREATE TABLE IF NOT EXISTS session_work (
  id TEXT PRIMARY KEY,
  linear_session_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  source TEXT NOT NULL,
  priority INTEGER NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  claimed_run_id TEXT,
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  canceled_at TEXT,
  UNIQUE(linear_session_id, source, id),
  FOREIGN KEY(linear_session_id) REFERENCES agent_sessions(id),
  FOREIGN KEY(linear_issue_id) REFERENCES tickets(linear_issue_id)
);
CREATE INDEX IF NOT EXISTS session_work_claim_idx
  ON session_work(linear_session_id, status, priority, created_at);

CREATE TABLE IF NOT EXISTS linear_outbox (
  id TEXT PRIMARY KEY,
  linear_session_id TEXT,
  linear_issue_id TEXT,
  run_id TEXT,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  processed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(linear_session_id, sequence),
  FOREIGN KEY(run_id) REFERENCES runs(id)
);
CREATE INDEX IF NOT EXISTS linear_outbox_process_idx
  ON linear_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS linear_outbox_session_order_idx
  ON linear_outbox(linear_session_id, sequence);

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

CREATE TABLE IF NOT EXISTS repository_registrations (
  linear_team_key TEXT PRIMARY KEY COLLATE NOCASE,
  linear_team_id TEXT UNIQUE,
  github_repo TEXT NOT NULL COLLATE NOCASE,
  base_branch TEXT NOT NULL,
  webhook_id INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS repository_registrations_repo_idx
  ON repository_registrations(github_repo);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`;

const TICKET_MIGRATIONS: Array<[string, string]> = [
  ["running_since", "ALTER TABLE tickets ADD COLUMN running_since TEXT"],
  ["run_id", "ALTER TABLE tickets ADD COLUMN run_id TEXT"],
  ["total_cost_usd", "ALTER TABLE tickets ADD COLUMN total_cost_usd REAL NOT NULL DEFAULT 0"],
  ["last_error", "ALTER TABLE tickets ADD COLUMN last_error TEXT"],
  ["preview_token_hash", "ALTER TABLE tickets ADD COLUMN preview_token_hash TEXT"],
  ["linear_context", "ALTER TABLE tickets ADD COLUMN linear_context TEXT"],
  ["base_branch", "ALTER TABLE tickets ADD COLUMN base_branch TEXT NOT NULL DEFAULT 'main'"],
  ["pending_re_review", "ALTER TABLE tickets ADD COLUMN pending_re_review INTEGER NOT NULL DEFAULT 0"],
];

const RUN_MIGRATIONS: Array<[string, string]> = [
  ["linear_session_id", "ALTER TABLE runs ADD COLUMN linear_session_id TEXT"],
  ["session_generation", "ALTER TABLE runs ADD COLUMN session_generation INTEGER"],
  ["log_tail", "ALTER TABLE runs ADD COLUMN log_tail TEXT"],
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

function applyColumnMigrations(
  db: Database.Database,
  table: "tickets" | "webhook_deliveries" | "runs",
  migrations: Array<[string, string]>
): void {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  for (const [column, sql] of migrations) {
    if (!columns.has(column)) db.exec(sql);
  }
}

function backfillAgentSessions(db: Database.Database): void {
  const timestamp = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO agent_sessions (
      id, linear_issue_id, generation, state, created_at, updated_at
    )
    SELECT
      tickets.linear_session_id,
      tickets.linear_issue_id,
      1,
      CASE tickets.state WHEN 'stopped' THEN 'stopped' ELSE 'current' END,
      COALESCE(tickets.created_at, ?),
      COALESCE(tickets.updated_at, ?)
    FROM tickets
    WHERE tickets.linear_session_id IS NOT NULL
      AND tickets.linear_session_id <> ''
      AND NOT EXISTS (
        SELECT 1 FROM agent_sessions
        WHERE agent_sessions.linear_issue_id = tickets.linear_issue_id
      )
  `).run(timestamp, timestamp);
}

export type Agent = "claude" | "codex" | "opencode";
type TicketState = "active" | "closed" | "expired" | "error" | "stopped";
// Task taxonomy: implement (feature/bug plan) and investigate (debugging) are the
// two loops; resume is the single continuation mechanism for either loop, fed by
// a human reply or queued GitHub feedback. `review`/`review-fix` were removed —
// see docs/SIMPLIFICATION-PLAN.md Phase 1. This is an additive migration: any
// historical `runs` rows already written with the old task types are left as
// free-form text (there is no CHECK constraint to violate), and the ticket's
// `pending_re_review` column stays in the schema — no code reads or writes it
// anymore.
export type TaskType = "implement" | "resume" | "investigate";
type RunStatus = "running" | "completed" | "failed" | "timed_out" | "stopped";

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
  base_branch: string;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  linear_issue_id: string;
  linear_session_id: string | null;
  session_generation: number | null;
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
  log_tail: string | null;
}

type TicketUpsert = Pick<
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
> & { base_branch?: string };

interface RepositoryRegistration {
  linear_team_key: string;
  linear_team_id: string | null;
  github_repo: string;
  base_branch: string;
  webhook_id: number;
  snapshot: string;
  created_at: string;
  updated_at: string;
}

interface RepositoryRegistrationInput {
  linearTeamKey: string;
  linearTeamId?: string;
  githubRepo: string;
  baseBranch: string;
  webhookId: number;
  snapshot: string;
}

interface DeliveryClaim {
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

interface SandboxEventRecord {
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

interface AgentSession {
  id: string;
  linear_issue_id: string;
  generation: number;
  state: "current" | "stopping" | "stopped" | "superseded";
  provider_conversation_id: string | null;
  created_at: string;
  updated_at: string;
  superseded_at: string | null;
}

export interface LinearOutboxRecord {
  id: string;
  linear_session_id: string | null;
  linear_issue_id: string | null;
  run_id: string | null;
  sequence: number;
  kind: "activity" | "session_update";
  payload: string;
  payload_hash: string;
  status: "pending" | "processing" | "failed" | "processed" | "dead";
  attempts: number;
  next_attempt_at: string;
  processed_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface SessionWork {
  id: string;
  linear_session_id: string;
  linear_issue_id: string;
  source: "human" | "automatic";
  priority: number;
  body: string;
  status: "pending" | "claimed" | "consumed" | "canceled";
  claimed_run_id: string | null;
  available_at: string;
  created_at: string;
  consumed_at: string | null;
  canceled_at: string | null;
}

interface FinishRunParams {
  runId: string;
  status: Exclude<RunStatus, "running">;
  exitCode?: number;
  costUsd?: number;
  prUrl?: string;
  failureTail?: string;
  logTail?: string;
  ticketState?: TicketState;
}

export function openDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  applyColumnMigrations(db, "tickets", TICKET_MIGRATIONS);
  applyColumnMigrations(db, "webhook_deliveries", DELIVERY_MIGRATIONS);
  applyColumnMigrations(db, "runs", RUN_MIGRATIONS);
  backfillAgentSessions(db);
  db.exec(
    "CREATE INDEX IF NOT EXISTS tickets_repo_branch_idx ON tickets(repo, branch);" +
      "CREATE INDEX IF NOT EXISTS tickets_sandbox_idx ON tickets(sandbox_id);" +
      "CREATE INDEX IF NOT EXISTS runs_session_idx ON runs(linear_session_id, session_generation);" +
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
  getByPrUrl(repo: string, prUrl: string): Ticket | undefined;
  getBySandboxId(sandboxId: string): Ticket | undefined;
  setSandboxId(issueId: string, sandboxId: string | null): void;
  setState(issueId: string, state: TicketState, lastError?: string): void;
  setPrUrl(issueId: string, prUrl: string): void;
  setPreviewTokenHash(issueId: string, tokenHash: string): void;
  setLinearContext(issueId: string, context: string): void;
  listActive(): Ticket[];
  listRunning(): Ticket[];
  listAll(): Ticket[];
  getCurrentSession(issueId: string): AgentSession | undefined;
  getSession(sessionId: string): AgentSession | undefined;
  supersedeCurrentSession(issueId: string, newSessionId: string): AgentSession;
  markSessionState(sessionId: string, state: AgentSession["state"]): void;
  enqueueSessionWork(params: {
    id: string;
    linearSessionId: string;
    issueId: string;
    source: "human" | "automatic";
    body: string;
    priority?: number;
  }): boolean;
  claimNextSessionWork(linearSessionId: string, nowIso: string): SessionWork | undefined;
  markSessionWorkConsumed(workId: string, runId: string): void;
  releaseSessionWork(workId: string): void;
  cancelPendingSessionWork(linearSessionId: string): number;
  cancelSessionWork(workId: string): void;
  countConsumedAutomaticSessionWork(issueId: string): number;
  getConsumedSessionWorkForRun(runId: string): SessionWork | undefined;
  enqueueLinearOutbox(params: {
    id?: string;
    linearSessionId?: string | null;
    issueId?: string | null;
    runId?: string | null;
    kind: LinearOutboxRecord["kind"];
    payload: string;
  }): LinearOutboxRecord;
  claimLinearOutbox(nowIso: string, leaseUntilIso: string, limit: number): LinearOutboxRecord[];
  markLinearOutboxProcessed(id: string): void;
  markLinearOutboxFailed(id: string, error: string, retryAt: string | null): void;
  getLinearOutbox(id: string): LinearOutboxRecord | undefined;
  listLinearOutbox(): LinearOutboxRecord[];
  registerRepository(input: RepositoryRegistrationInput): RepositoryRegistration;
  getRepositoryRegistration(teamId?: string, teamKey?: string): RepositoryRegistration | undefined;
  hasRepositoryRegistrations(): boolean;
  listRepositoryRegistrations(): RepositoryRegistration[];
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
  getLatestRun(issueId: string): Run | undefined;
  getLatestRunWithLog(issueId: string): Run | undefined;
  countRunsByType(issueId: string, taskType: TaskType): number;
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
  const hashPayload = (payload: string) => createHash("sha256").update(payload).digest("hex");
  const upsertStmt = db.prepare(`
    INSERT INTO tickets (
      linear_issue_id, linear_issue_identifier, linear_session_id,
      sandbox_id, branch, agent, repo, pr_url, state, base_branch, created_at, updated_at
    ) VALUES (
      @linear_issue_id, @linear_issue_identifier, @linear_session_id,
      @sandbox_id, @branch, @agent, @repo, @pr_url, @state, @base_branch, @created_at, @updated_at
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
      base_branch = excluded.base_branch,
      updated_at = excluded.updated_at
  `);
  const getByIssueIdStmt = db.prepare("SELECT * FROM tickets WHERE linear_issue_id = ?");
  const getByIdentifierStmt = db.prepare(
    "SELECT * FROM tickets WHERE lower(linear_issue_identifier) = lower(?)"
  );
  const getByBranchStmt = db.prepare("SELECT * FROM tickets WHERE repo = ? AND branch = ?");
  const getByPrUrlStmt = db.prepare(
    "SELECT * FROM tickets WHERE lower(repo) = lower(?) AND lower(pr_url) = lower(?)"
  );
  const countRunsByTypeStmt = db.prepare(
    "SELECT COUNT(*) AS count FROM runs WHERE linear_issue_id = ? AND task_type = ?"
  );
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
  const getRepositoryByTeamIdStmt = db.prepare(
    "SELECT * FROM repository_registrations WHERE linear_team_id = ?"
  );
  const getRepositoryByTeamKeyStmt = db.prepare(
    "SELECT * FROM repository_registrations WHERE lower(linear_team_key) = lower(?)"
  );
  const listRepositoryRegistrationsStmt = db.prepare(
    "SELECT * FROM repository_registrations ORDER BY linear_team_key"
  );
  const hasRepositoryRegistrationsStmt = db.prepare(
    "SELECT 1 AS found FROM repository_registrations LIMIT 1"
  );
  const upsertRepositoryRegistrationStmt = db.prepare(`
    INSERT INTO repository_registrations (
      linear_team_key, linear_team_id, github_repo, base_branch,
      webhook_id, snapshot, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(linear_team_key) DO UPDATE SET
      linear_team_id = excluded.linear_team_id,
      github_repo = excluded.github_repo,
      base_branch = excluded.base_branch,
      webhook_id = excluded.webhook_id,
      snapshot = excluded.snapshot,
      updated_at = excluded.updated_at
  `);
  const getCurrentSessionStmt = db.prepare(
    "SELECT * FROM agent_sessions WHERE linear_issue_id = ? AND state = 'current'"
  );
  const getSessionStmt = db.prepare("SELECT * FROM agent_sessions WHERE id = ?");
  const maxSessionGenerationStmt = db.prepare(
    "SELECT COALESCE(MAX(generation), 0) AS generation FROM agent_sessions WHERE linear_issue_id = ?"
  );
  const insertSessionStmt = db.prepare(`
    INSERT OR IGNORE INTO agent_sessions (
      id, linear_issue_id, generation, state, created_at, updated_at
    ) VALUES (?, ?, ?, 'current', ?, ?)
  `);
  const supersedeSessionStmt = db.prepare(`
    UPDATE agent_sessions
    SET state = 'superseded', superseded_at = ?, updated_at = ?
    WHERE linear_issue_id = ? AND state = 'current' AND id <> ?
  `);
  const markSessionStateStmt = db.prepare(
    "UPDATE agent_sessions SET state = ?, updated_at = ? WHERE id = ?"
  );
  const insertSessionWorkStmt = db.prepare(`
    INSERT OR IGNORE INTO session_work (
      id, linear_session_id, linear_issue_id, source, priority, body,
      status, available_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `);
  const cancelPendingSessionWorkStmt = db.prepare(`
    UPDATE session_work
    SET status = 'canceled', canceled_at = ?
    WHERE linear_session_id = ? AND status = 'pending'
  `);
  const cancelSessionWorkStmt = db.prepare(`
    UPDATE session_work
    SET status = 'canceled', canceled_at = ?
    WHERE id = ? AND status IN ('pending', 'claimed')
  `);
  const countConsumedAutomaticSessionWorkStmt = db.prepare(`
    SELECT COUNT(*) AS count FROM session_work
    WHERE linear_issue_id = ? AND source = 'automatic' AND status = 'consumed'
  `);
  const getConsumedSessionWorkForRunStmt = db.prepare(`
    SELECT * FROM session_work WHERE claimed_run_id = ? AND status = 'consumed' LIMIT 1
  `);
  const getSessionWorkStmt = db.prepare("SELECT * FROM session_work WHERE id = ?");
  const nextSessionWorkStmt = db.prepare(`
    SELECT * FROM session_work
    WHERE linear_session_id = ? AND status = 'pending' AND available_at <= ?
    ORDER BY priority ASC, created_at ASC, id ASC
    LIMIT 1
  `);
  const nextOutboxSequenceStmt = db.prepare(
    "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM linear_outbox WHERE linear_session_id IS ?"
  );
  const insertLinearOutboxStmt = db.prepare(`
    INSERT INTO linear_outbox (
      id, linear_session_id, linear_issue_id, run_id, sequence, kind,
      payload, payload_hash, status, attempts, next_attempt_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `);
  const getLinearOutboxStmt = db.prepare("SELECT * FROM linear_outbox WHERE id = ?");
  const listLinearOutboxStmt = db.prepare("SELECT * FROM linear_outbox ORDER BY created_at, sequence");
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
  const getLatestRunStmt = db.prepare(
    "SELECT * FROM runs WHERE linear_issue_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1"
  );
  const getLatestRunWithLogStmt = db.prepare(
    `SELECT * FROM runs
     WHERE linear_issue_id = ? AND log_tail IS NOT NULL
     ORDER BY started_at DESC, rowid DESC LIMIT 1`
  );
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

  const registerRepositoryTransaction = db.transaction(
    (input: RepositoryRegistrationInput): RepositoryRegistration => {
      const timestamp = now();
      const existing = getRepositoryByTeamKeyStmt.get(input.linearTeamKey) as
        | RepositoryRegistration
        | undefined;
      if (input.linearTeamId) {
        db.prepare(
          `DELETE FROM repository_registrations
           WHERE linear_team_id = ? AND lower(linear_team_key) <> lower(?)`
        ).run(input.linearTeamId, input.linearTeamKey);
      }
      upsertRepositoryRegistrationStmt.run(
        input.linearTeamKey,
        input.linearTeamId ?? null,
        input.githubRepo,
        input.baseBranch,
        input.webhookId,
        input.snapshot,
        existing?.created_at ?? timestamp,
        timestamp
      );
      return getRepositoryByTeamKeyStmt.get(input.linearTeamKey) as RepositoryRegistration;
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
      const ticket = getByIssueIdStmt.get(params.issueId) as Ticket | undefined;
      const currentSession = getCurrentSessionStmt.get(params.issueId) as AgentSession | undefined;
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
          id, linear_issue_id, linear_session_id, session_generation,
          task_type, token_hash, status, started_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
      `).run(
        params.runId,
        params.issueId,
        currentSession?.id ?? ticket?.linear_session_id ?? null,
        currentSession?.generation ?? null,
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
        status = ?, completed_at = ?, exit_code = ?, cost_usd = ?, pr_url = ?, failure_tail = ?, log_tail = ?
      WHERE id = ? AND status = 'running'
    `).run(
      params.status,
      completedAt,
      params.exitCode ?? null,
      params.costUsd ?? null,
      params.prUrl ?? null,
      params.failureTail ?? null,
      params.logTail ?? null,
      params.runId
    );
    if (params.logTail !== undefined) {
      db.prepare(`
        UPDATE runs SET log_tail = NULL
        WHERE linear_issue_id = ? AND id <> ? AND log_tail IS NOT NULL
      `).run(existing.linear_issue_id, params.runId);
    }
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

  const supersedeCurrentSessionTransaction = db.transaction(
    (issueId: string, newSessionId: string): AgentSession => {
      const timestamp = now();
      const existing = getSessionStmt.get(newSessionId) as AgentSession | undefined;
      if (existing) {
        supersedeSessionStmt.run(timestamp, timestamp, issueId, newSessionId);
        markSessionStateStmt.run("current", timestamp, newSessionId);
        return getSessionStmt.get(newSessionId) as AgentSession;
      }
      const generation =
        ((maxSessionGenerationStmt.get(issueId) as { generation: number } | undefined)
          ?.generation ?? 0) + 1;
      supersedeSessionStmt.run(timestamp, timestamp, issueId, newSessionId);
      insertSessionStmt.run(newSessionId, issueId, generation, timestamp, timestamp);
      return getSessionStmt.get(newSessionId) as AgentSession;
    }
  );

  const enqueueLinearOutboxTransaction = db.transaction(
    (params: {
      id?: string;
      linearSessionId?: string | null;
      issueId?: string | null;
      runId?: string | null;
      kind: LinearOutboxRecord["kind"];
      payload: string;
    }): LinearOutboxRecord => {
      const timestamp = now();
      const id = params.id ?? randomUUID();
      const existing = getLinearOutboxStmt.get(id) as LinearOutboxRecord | undefined;
      const payloadHash = hashPayload(params.payload);
      if (existing) {
        if (
          existing.linear_session_id !== (params.linearSessionId ?? null) ||
          existing.linear_issue_id !== (params.issueId ?? null) ||
          existing.run_id !== (params.runId ?? null) ||
          existing.kind !== params.kind ||
          existing.payload_hash !== payloadHash
        ) {
          throw new Error(`linear outbox id ${id} already exists with different intent`);
        }
        return existing;
      }
      const sequence = (nextOutboxSequenceStmt.get(params.linearSessionId ?? null) as {
        sequence: number;
      }).sequence;
      insertLinearOutboxStmt.run(
        id,
        params.linearSessionId ?? null,
        params.issueId ?? null,
        params.runId ?? null,
        sequence,
        params.kind,
        params.payload,
        payloadHash,
        timestamp,
        timestamp
      );
      return getLinearOutboxStmt.get(id) as LinearOutboxRecord;
    }
  );

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
      db.transaction(() => {
        upsertStmt.run({
        ...ticket,
        base_branch: ticket.base_branch ?? existing?.base_branch ?? "main",
        created_at: existing?.created_at ?? now(),
        updated_at: now(),
        });
        supersedeCurrentSessionTransaction(ticket.linear_issue_id, ticket.linear_session_id);
      })();
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
    getByPrUrl(repo, prUrl) {
      return getByPrUrlStmt.get(repo, prUrl) as Ticket | undefined;
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
    getCurrentSession(issueId) {
      return getCurrentSessionStmt.get(issueId) as AgentSession | undefined;
    },
    getSession(sessionId) {
      return getSessionStmt.get(sessionId) as AgentSession | undefined;
    },
    supersedeCurrentSession(issueId, newSessionId) {
      return supersedeCurrentSessionTransaction(issueId, newSessionId);
    },
    markSessionState(sessionId, state) {
      markSessionStateStmt.run(state, now(), sessionId);
    },
    enqueueSessionWork(params) {
      const timestamp = now();
      return (
        insertSessionWorkStmt.run(
          params.id,
          params.linearSessionId,
          params.issueId,
          params.source,
          params.priority ?? (params.source === "human" ? 0 : 10),
          params.body,
          timestamp,
          timestamp
        ).changes === 1
      );
    },
    claimNextSessionWork(linearSessionId, nowIso) {
      const candidate = nextSessionWorkStmt.get(linearSessionId, nowIso) as SessionWork | undefined;
      if (!candidate) return undefined;
      const update = db.prepare(`
        UPDATE session_work
        SET status = 'claimed'
        WHERE id = ? AND status = 'pending'
      `).run(candidate.id);
      return update.changes === 1
        ? (getSessionWorkStmt.get(candidate.id) as SessionWork)
        : undefined;
    },
    markSessionWorkConsumed(workId, runId) {
      const timestamp = now();
      db.prepare(`
        UPDATE session_work
        SET status = 'consumed', claimed_run_id = ?, consumed_at = ?
        WHERE id = ? AND status IN ('pending', 'claimed')
      `).run(runId, timestamp, workId);
    },
    releaseSessionWork(workId) {
      db.prepare(`
        UPDATE session_work
        SET status = 'pending'
        WHERE id = ? AND status = 'claimed'
      `).run(workId);
    },
    cancelPendingSessionWork(linearSessionId) {
      return cancelPendingSessionWorkStmt.run(now(), linearSessionId).changes;
    },
    cancelSessionWork(workId) {
      cancelSessionWorkStmt.run(now(), workId);
    },
    countConsumedAutomaticSessionWork(issueId) {
      return (countConsumedAutomaticSessionWorkStmt.get(issueId) as { count: number }).count;
    },
    getConsumedSessionWorkForRun(runId) {
      return getConsumedSessionWorkForRunStmt.get(runId) as SessionWork | undefined;
    },
    enqueueLinearOutbox(params) {
      return enqueueLinearOutboxTransaction(params);
    },
    claimLinearOutbox(nowIso, leaseUntilIso, limit) {
      const rows = db.prepare(`
        SELECT * FROM linear_outbox candidate
        WHERE ((candidate.status IN ('pending', 'failed') AND candidate.next_attempt_at <= ?)
          OR (candidate.status = 'processing' AND candidate.next_attempt_at <= ?))
          AND NOT EXISTS (
            SELECT 1 FROM linear_outbox earlier
            WHERE earlier.linear_session_id IS candidate.linear_session_id
              AND earlier.sequence < candidate.sequence
              AND earlier.status IN ('pending', 'processing', 'failed')
          )
        ORDER BY candidate.created_at, candidate.sequence
        LIMIT ?
      `).all(nowIso, nowIso, limit) as LinearOutboxRecord[];
      const claimed: LinearOutboxRecord[] = [];
      for (const row of rows) {
        const update = db.prepare(`
          UPDATE linear_outbox
          SET status = 'processing', attempts = attempts + 1,
              next_attempt_at = ?, last_error = NULL
          WHERE id = ?
            AND ((status IN ('pending', 'failed') AND next_attempt_at <= ?)
              OR (status = 'processing' AND next_attempt_at <= ?))
        `).run(leaseUntilIso, row.id, nowIso, nowIso);
        if (update.changes === 1) claimed.push(getLinearOutboxStmt.get(row.id) as LinearOutboxRecord);
      }
      return claimed;
    },
    markLinearOutboxProcessed(id) {
      const processedAt = now();
      db.prepare(`
        UPDATE linear_outbox
        SET status = 'processed', processed_at = ?, next_attempt_at = ?, last_error = NULL
        WHERE id = ?
      `).run(processedAt, processedAt, id);
    },
    markLinearOutboxFailed(id, error, retryAt) {
      db.prepare(`
        UPDATE linear_outbox
        SET status = ?, next_attempt_at = ?, last_error = ?
        WHERE id = ?
      `).run(retryAt ? "failed" : "dead", retryAt ?? now(), error, id);
    },
    getLinearOutbox(id) {
      return getLinearOutboxStmt.get(id) as LinearOutboxRecord | undefined;
    },
    listLinearOutbox() {
      return listLinearOutboxStmt.all() as LinearOutboxRecord[];
    },
    registerRepository(input) {
      return registerRepositoryTransaction(input);
    },
    getRepositoryRegistration(teamId, teamKey) {
      if (teamId) {
        const byId = getRepositoryByTeamIdStmt.get(teamId) as RepositoryRegistration | undefined;
        if (byId) return byId;
      }
      return teamKey
        ? (getRepositoryByTeamKeyStmt.get(teamKey) as RepositoryRegistration | undefined)
        : undefined;
    },
    hasRepositoryRegistrations() {
      return Boolean(hasRepositoryRegistrationsStmt.get());
    },
    listRepositoryRegistrations() {
      return listRepositoryRegistrationsStmt.all() as RepositoryRegistration[];
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
    getLatestRun(issueId) {
      return getLatestRunStmt.get(issueId) as Run | undefined;
    },
    getLatestRunWithLog(issueId) {
      return getLatestRunWithLogStmt.get(issueId) as Run | undefined;
    },
    countRunsByType(issueId, taskType) {
      return (countRunsByTypeStmt.get(issueId, taskType) as { count: number }).count;
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
