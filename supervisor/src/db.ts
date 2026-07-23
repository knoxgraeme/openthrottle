import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { applyDatabaseMigrations } from "./db-migrations.js";
import {
  createWorkStore,
  type WorkBinding,
  type WorkDelivery,
  type WorkItem,
} from "./work-store.js";
import {
  createFeedbackStore,
  type FeedbackRecordParams,
  type FeedbackSnapshot,
  type FeedbackSnapshotEvent,
} from "./feedback-store.js";
import {
  createPipelineStore,
  type PipelineInstanceSeed,
} from "./pipeline-store.js";

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
  linear_context TEXT,
  base_branch TEXT NOT NULL DEFAULT 'main',
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
CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_identity_idx
  ON agent_sessions(id, linear_issue_id, generation);

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
  external_id TEXT,
  external_url TEXT,
  attachment_url TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(linear_session_id, sequence),
  FOREIGN KEY(run_id) REFERENCES runs(id)
);
CREATE INDEX IF NOT EXISTS linear_outbox_process_idx
  ON linear_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS linear_outbox_session_order_idx
  ON linear_outbox(linear_session_id, sequence);

-- Inbound counterpart of linear_outbox: durable, per-issue steering messages.
-- A message is leased and dispatched into ~/.ot/inbox, then becomes consumable
-- only after the sandbox records an acknowledgement for the exact fenced
-- delivery. See docs/SPEC.md "Mid-run steering".
CREATE TABLE IF NOT EXISTS session_inbox (
  id TEXT PRIMARY KEY,
  linear_issue_id TEXT NOT NULL,
  linear_session_id TEXT NOT NULL,
  run_id TEXT,
  source TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  FOREIGN KEY(linear_issue_id) REFERENCES tickets(linear_issue_id)
);
CREATE INDEX IF NOT EXISTS session_inbox_delivery_idx
  ON session_inbox(linear_issue_id, status, created_at);

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
  ["linear_context", "ALTER TABLE tickets ADD COLUMN linear_context TEXT"],
  ["base_branch", "ALTER TABLE tickets ADD COLUMN base_branch TEXT NOT NULL DEFAULT 'main'"],
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
// The pipeline intent is selected at delegation. Continuation happens inside
// stage attempts through pinned native-session policy, not as a task type.
export type TaskType = "implement" | "investigate";
type TerminalRunStatus = "completed" | "failed" | "timed_out" | "stopped";
type RunStatus = "running" | "reaping" | "quarantined" | TerminalRunStatus;

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
> & {
  base_branch?: string;
  pipeline?: Omit<PipelineInstanceSeed, "issueId" | "sessionId" | "generation" | "branch" | "agent">;
};

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
  kind: "activity" | "plan" | "heartbeat" | "stage_result";
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
  kind: "activity" | "session_update" | "pipeline_receipt";
  payload: string;
  payload_hash: string;
  status: "pending" | "processing" | "failed" | "processed" | "dead";
  attempts: number;
  next_attempt_at: string;
  processed_at: string | null;
  last_error: string | null;
  external_id: string | null;
  external_url: string | null;
  attachment_url: string | null;
  created_at: string;
}

export interface SteerInboxRecord {
  id: string;
  linear_issue_id: string;
  linear_session_id: string;
  run_id: string | null;
  source: "human" | "operator";
  body: string;
  status: "pending" | "dispatched" | "acknowledged" | "canceled";
  created_at: string;
  delivered_at: string | null;
  delivery_id: string | null;
  request_hash: string | null;
  generation: number | null;
  context_revision: number | null;
  native_session_id: string | null;
  lease_until: string | null;
}

interface FinishRunParams {
  runId: string;
  status: TerminalRunStatus;
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
  applyDatabaseMigrations(db);
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
  upsertUnpinned(ticket: Omit<TicketUpsert, "pipeline">): void;
  getByIssueId(issueId: string): Ticket | undefined;
  getByIdentifier(identifier: string): Ticket | undefined;
  getByBranch(repo: string, branch: string): Ticket | undefined;
  getByPrUrl(repo: string, prUrl: string): Ticket | undefined;
  getBySandboxId(sandboxId: string): Ticket | undefined;
  setSandboxId(issueId: string, sandboxId: string | null): void;
  setState(issueId: string, state: TicketState, lastError?: string): void;
  setPrUrl(issueId: string, prUrl: string): void;
  setLinearContext(issueId: string, context: string): void;
  listRunning(): Ticket[];
  listAll(): Ticket[];
  getCurrentSession(issueId: string): AgentSession | undefined;
  getSession(sessionId: string): AgentSession | undefined;
  markSessionState(sessionId: string, state: AgentSession["state"]): void;
  recordProviderFeedback(params: FeedbackRecordParams): {
    snapshot: FeedbackSnapshot;
    eventInserted: boolean;
    snapshotCreated: boolean;
  };
  listPendingFeedbackSnapshots(linearSessionId: string, limit?: number): FeedbackSnapshot[];
  claimFeedbackSnapshot(snapshotId: string, maxRounds: number):
    | { status: "claimed"; snapshot: FeedbackSnapshot; events: FeedbackSnapshotEvent[] }
    | { status: "exhausted"; completedRounds: number }
    | { status: "stale" };
  consumeFeedbackSnapshot(snapshotId: string): boolean;
  enqueueLinearOutbox(params: {
    id?: string;
    linearSessionId?: string | null;
    issueId?: string | null;
    runId?: string | null;
    kind: LinearOutboxRecord["kind"];
    payload: string;
  }): LinearOutboxRecord;
  claimLinearOutbox(nowIso: string, leaseUntilIso: string, limit: number): LinearOutboxRecord[];
  markLinearOutboxProcessed(id: string, receipt?: {
    externalId?: string | null;
    externalUrl?: string | null;
    attachmentUrl?: string | null;
  }): void;
  markLinearOutboxFailed(id: string, error: string, retryAt: string | null): void;
  recordLinearOutboxAttachment(id: string, attachmentUrl: string): void;
  getLinearOutbox(id: string): LinearOutboxRecord | undefined;
  listLinearOutbox(): LinearOutboxRecord[];
  registerRepository(input: RepositoryRegistrationInput): RepositoryRegistration;
  getRepositoryRegistration(teamId?: string, teamKey?: string): RepositoryRegistration | undefined;
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
  getLatestRunWithLog(issueId: string): Run | undefined;
  finishRun(params: FinishRunParams): Run | undefined;
  claimRunForReaping(runId: string, owner: string, reason: string): Run | undefined;
  finishReapingRun(params: FinishRunParams & { owner: string }): Run | undefined;
  quarantineRun(runId: string, owner: string, reason: string): Run | undefined;
  settleQuarantinedRun(params: FinishRunParams): Run | undefined;
  renewRunLiveness(runId: string, heartbeatAt: string): boolean;
  listExpiredRuns(nowIso: string): Run[];
  // Running actors whose sealed executor heartbeat is at or before `cutoffIso`.
  // Before the first heartbeat, started_at is the liveness baseline so a wedged
  // bootstrap is still bounded independently of semantic agent output.
  listStalledRuns(cutoffIso: string): Run[];
  // Feature 5 (mid-run steering inbox): the inbound counterpart of the Linear
  // outbox. Messages are leased and dispatched into ~/.ot/inbox, then become
  // consumable only after an exact fenced acknowledgement.
  enqueueInbox(params: {
    id?: string;
    issueId: string;
    sessionId: string;
    runId?: string | null;
    source: "human" | "operator";
    body: string;
  }): SteerInboxRecord;
  listPendingInbox(issueId: string): SteerInboxRecord[];
  markInboxDispatched(id: string): void;
  acknowledgeInboxDelivery(deliveryId: string, binding: WorkBinding & { requestHash: string }): void;
  cancelPendingInbox(issueId: string): number;
  getInbox(id: string): SteerInboxRecord | undefined;
  getWorkItem(id: string): WorkItem | undefined;
  getWorkDelivery(id: string): WorkDelivery | undefined;
  insertSandboxEvent(params: {
    eventId: string;
    runId: string;
    sandboxId: string;
    kind: "activity" | "plan" | "heartbeat" | "stage_result";
    payload: string;
  }): SandboxEventRecord;
  getSandboxEvent(eventId: string): SandboxEventRecord | undefined;
  claimSandboxEvent(eventId: string, nowIso: string, leaseUntilIso: string): SandboxEventRecord | undefined;
  markSandboxEventProcessed(eventId: string): void;
  markSandboxEventFailed(eventId: string, error: string, retryAt: string): void;
  pruneSandboxEvents(beforeIso: string): number;
  pruneEphemeralLinearOutbox(beforeIso: string): number;
  acquireSupervisorLease(name: string, owner: string, nowIso: string, leaseUntilIso: string): boolean;
  releaseSupervisorLease(name: string, owner: string): boolean;
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
}

export function createTicketStore(db: Database.Database): TicketStore {
  const now = () => new Date().toISOString();
  const workStore = createWorkStore(db);
  const feedbackStore = createFeedbackStore(db);
  const pipelineStore = createPipelineStore(db);
  const hashPayload = (payload: string) => createHash("sha256").update(payload).digest("hex");
  const claimFeedbackSnapshot = (snapshot: FeedbackSnapshot, maxRounds: number) => {
    const events = feedbackStore.listEvents(snapshot.id);
    const isConversationSnapshot = events.length > 0 &&
      events.every((event) => event.kind === "issue_comment");
    const currentHead = (db.prepare("SELECT value FROM settings WHERE key = ?").get(
      `github-head:${snapshot.linear_issue_id}`
    ) as { value: string } | undefined)?.value;
    if (!isConversationSnapshot && currentHead && currentHead !== snapshot.head_sha) {
      db.prepare(`
        UPDATE feedback_snapshots SET status = 'stale'
        WHERE id = ? AND status IN ('collecting', 'claimed')
      `).run(snapshot.id);
      return { status: "stale" as const };
    }
    const claim = feedbackStore.claim(snapshot.id, maxRounds);
    return claim.status === "claimed"
      ? { ...claim, events }
      : claim;
  };
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
  const setLinearContextStmt = db.prepare(
    "UPDATE tickets SET linear_context = ?, updated_at = ? WHERE linear_issue_id = ?"
  );
  const listRunningStmt = db.prepare(`
    SELECT t.* FROM tickets t
    JOIN runs r ON r.id = t.run_id
    WHERE t.run_id IS NOT NULL AND t.running_since IS NOT NULL AND r.status = 'running'
    ORDER BY t.running_since
  `);
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
  const pruneSandboxEventsStmt = db.prepare(`
    DELETE FROM sandbox_events
    WHERE status = 'processed' AND processed_at < ?
      AND (kind = 'heartbeat'
        OR (kind = 'activity' AND json_extract(payload, '$.ephemeral') IS 1))
  `);
  const pruneEphemeralLinearOutboxStmt = db.prepare(`
    DELETE FROM linear_outbox
    WHERE status = 'processed' AND processed_at < ?
      AND kind = 'activity'
      AND json_extract(payload, '$.activity.ephemeral') IS 1
  `);
  const getRunStmt = db.prepare("SELECT * FROM runs WHERE id = ?");
  const getLatestRunWithLogStmt = db.prepare(
    `SELECT * FROM runs
     WHERE linear_issue_id = ? AND log_tail IS NOT NULL
     ORDER BY started_at DESC, rowid DESC LIMIT 1`
  );
  const listExpiredRunsStmt = db.prepare(
    "SELECT * FROM runs WHERE status = 'running' AND expires_at <= ? ORDER BY expires_at"
  );
  // Liveness is an executor-owned lease, independent of semantic agent output.
  // Before the first sealed heartbeat, started_at is authoritative so a wedged
  // bootstrap is bounded too.
  const listStalledRunsStmt = db.prepare(`
    SELECT r.* FROM runs r
    JOIN run_liveness l ON l.run_id = r.id
    WHERE r.status = 'running' AND l.actor_state = 'running'
      AND COALESCE(l.last_heartbeat_at, r.started_at) <= ?
    ORDER BY r.started_at
  `);
  const insertInboxStmt = db.prepare(`
    INSERT OR IGNORE INTO session_inbox (
      id, linear_issue_id, linear_session_id, run_id, source, body, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  const listPendingInboxStmt = db.prepare(`
    SELECT si.*, wi.active_delivery_id AS delivery_id, wi.request_hash,
      wi.generation, wi.context_revision, wi.native_session_id,
      wd.lease_until
    FROM session_inbox si
    LEFT JOIN work_items wi ON wi.id = si.id
    LEFT JOIN work_deliveries wd ON wd.id = wi.active_delivery_id
    WHERE si.linear_issue_id = ?
      AND (si.status = 'pending'
        OR (si.status = 'dispatched' AND (
          wd.lease_until <= ? OR wd.run_id IS NOT (
            SELECT t.run_id FROM tickets t WHERE t.linear_issue_id = si.linear_issue_id
          )
        )))
    ORDER BY si.created_at ASC, si.id ASC
  `);
  const markInboxDispatchedStmt = db.prepare(
    "UPDATE session_inbox SET status = 'dispatched', delivered_at = ? WHERE id = ? AND status IN ('pending', 'dispatched')"
  );
  const cancelPendingInboxStmt = db.prepare(
    "UPDATE session_inbox SET status = 'canceled' WHERE linear_issue_id = ? AND status IN ('pending', 'dispatched')"
  );
  const cancelInboxStmt = db.prepare(
    "UPDATE session_inbox SET status = 'canceled' WHERE id = ? AND status IN ('pending', 'dispatched')"
  );
  const getInboxStmt = db.prepare(`
    SELECT si.*, wi.active_delivery_id AS delivery_id, wi.request_hash,
      wi.generation, wi.context_revision, wi.native_session_id,
      wd.lease_until
    FROM session_inbox si
    LEFT JOIN work_items wi ON wi.id = si.id
    LEFT JOIN work_deliveries wd ON wd.id = wi.active_delivery_id
    WHERE si.id = ?
  `);
  const insertSandboxEventStmt = db.prepare(`
    INSERT OR IGNORE INTO sandbox_events (
      event_id, run_id, sandbox_id, kind, payload, status,
      attempts, next_attempt_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `);
  const getSandboxEventStmt = db.prepare("SELECT * FROM sandbox_events WHERE event_id = ?");
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
            AND state NOT IN ('stopped', 'closed', 'expired')
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
      db.prepare(`
        INSERT INTO run_liveness (run_id, actor_state, updated_at)
        VALUES (?, 'running', ?)
      `).run(params.runId, startedAt);
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
    db.prepare(`
      UPDATE run_liveness
      SET actor_state = 'settled', settlement_reason = ?, updated_at = ?
      WHERE run_id = ? AND actor_state = 'running'
    `).run(params.status, completedAt, params.runId);
    workStore.consumeAcknowledgedForRun(params.runId, params.runId);
    workStore.releaseUnacknowledgedForRun(
      params.runId,
      `owning run ${params.runId} ended before acknowledgement`
    );
    return getRunStmt.get(params.runId) as Run;
  });

  const claimRunForReapingTransaction = db.transaction(
    (runId: string, owner: string, reason: string): Run | undefined => {
      const timestamp = now();
      const existing = getRunStmt.get(runId) as Run | undefined;
      if (existing?.status === "reaping") {
        const liveness = db.prepare(`
          SELECT settlement_owner FROM run_liveness
          WHERE run_id = ? AND actor_state = 'reaping'
        `).get(runId) as { settlement_owner: string | null } | undefined;
        return liveness?.settlement_owner === owner ? existing : undefined;
      }
      const update = db.prepare(
        "UPDATE runs SET status = 'reaping' WHERE id = ? AND status = 'running'"
      ).run(runId);
      if (update.changes !== 1) return undefined;
      const liveness = db.prepare(`
        UPDATE run_liveness
        SET actor_state = 'reaping', settlement_owner = ?, settlement_reason = ?, updated_at = ?
        WHERE run_id = ? AND actor_state = 'running'
      `).run(owner, reason, timestamp, runId);
      if (liveness.changes !== 1) throw new Error(`run ${runId} has inconsistent liveness state`);
      return getRunStmt.get(runId) as Run;
    }
  );

  const finishReapingRunTransaction = db.transaction(
    (params: FinishRunParams & { owner: string }): Run | undefined => {
      const existing = getRunStmt.get(params.runId) as Run | undefined;
      if (!existing || existing.status !== "reaping") return undefined;
      const completedAt = now();
      const update = db.prepare(`
        UPDATE runs SET
          status = ?, completed_at = ?, exit_code = ?, cost_usd = ?,
          pr_url = ?, failure_tail = ?, log_tail = ?
        WHERE id = ? AND status = 'reaping'
          AND EXISTS (
            SELECT 1 FROM run_liveness l
            WHERE l.run_id = runs.id AND l.actor_state = 'reaping' AND l.settlement_owner = ?
          )
      `).run(
        params.status,
        completedAt,
        params.exitCode ?? null,
        params.costUsd ?? null,
        params.prUrl ?? null,
        params.failureTail ?? null,
        params.logTail ?? null,
        params.runId,
        params.owner
      );
      if (update.changes !== 1) return undefined;
      const ticket = getByIssueIdStmt.get(existing.linear_issue_id) as Ticket | undefined;
      if (existing.linear_session_id && ticket?.linear_session_id !== existing.linear_session_id) {
        // A newer delegated session may retain the old run id solely as an
        // exclusivity fence while its predecessor stops. Release that fence,
        // but do not project the predecessor's state, PR, cost, or error onto
        // the replacement session.
        db.prepare(`
          UPDATE tickets SET running_since = NULL, run_id = NULL, updated_at = ?
          WHERE linear_issue_id = ? AND run_id = ?
        `).run(completedAt, existing.linear_issue_id, params.runId);
      } else {
        db.prepare(`
          UPDATE tickets SET
            running_since = NULL, run_id = NULL,
            state = COALESCE(?, state), pr_url = COALESCE(?, pr_url),
            total_cost_usd = total_cost_usd + COALESCE(?, 0),
            last_error = ?, updated_at = ?
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
      }
      db.prepare(`
        UPDATE run_liveness
        SET actor_state = 'settled', termination_confirmed_at = ?, updated_at = ?
        WHERE run_id = ? AND actor_state = 'reaping' AND settlement_owner = ?
      `).run(completedAt, completedAt, params.runId, params.owner);
      workStore.consumeAcknowledgedForRun(params.runId, params.runId);
      workStore.releaseUnacknowledgedForRun(
        params.runId,
        `owning run ${params.runId} ended before acknowledgement`
      );
      return getRunStmt.get(params.runId) as Run;
    }
  );

  const quarantineRunTransaction = db.transaction(
    (runId: string, owner: string, reason: string): Run | undefined => {
      const timestamp = now();
      const existing = getRunStmt.get(runId) as Run | undefined;
      if (existing?.status === "quarantined") {
        const liveness = db.prepare(`
          SELECT settlement_owner FROM run_liveness
          WHERE run_id = ? AND actor_state = 'quarantined'
        `).get(runId) as { settlement_owner: string | null } | undefined;
        return liveness?.settlement_owner === owner ? existing : undefined;
      }
      const update = db.prepare(`
        UPDATE runs SET status = 'quarantined', failure_tail = ?
        WHERE id = ? AND status = 'reaping'
          AND EXISTS (
            SELECT 1 FROM run_liveness l
            WHERE l.run_id = runs.id AND l.actor_state = 'reaping' AND l.settlement_owner = ?
          )
      `).run(reason, runId, owner);
      if (update.changes !== 1) return undefined;
      db.prepare(`
        UPDATE run_liveness
        SET actor_state = 'quarantined', quarantine_reason = ?, updated_at = ?
        WHERE run_id = ? AND settlement_owner = ?
      `).run(reason, timestamp, runId, owner);
      const run = getRunStmt.get(runId) as Run;
      // Preserve run_id/running_since: quarantine intentionally retains ticket
      // exclusivity until an operator proves the old actor is gone.
      const ticket = getByIssueIdStmt.get(run.linear_issue_id) as Ticket | undefined;
      if (!run.linear_session_id || ticket?.linear_session_id === run.linear_session_id) {
        db.prepare(`
          UPDATE tickets SET state = 'error', last_error = ?, updated_at = ?
          WHERE linear_issue_id = ? AND run_id = ?
        `).run(reason, timestamp, run.linear_issue_id, runId);
      }
      return run;
    }
  );

  const settleQuarantinedRunTransaction = db.transaction((params: FinishRunParams): Run | undefined => {
    const existing = getRunStmt.get(params.runId) as Run | undefined;
    if (!existing || existing.status !== "quarantined") return undefined;
    const completedAt = now();
    db.prepare(`
      UPDATE runs SET status = ?, completed_at = ?, failure_tail = ?, pr_url = COALESCE(?, pr_url)
      WHERE id = ? AND status = 'quarantined'
    `).run(params.status, completedAt, params.failureTail ?? null, params.prUrl ?? null, params.runId);
    const ticket = getByIssueIdStmt.get(existing.linear_issue_id) as Ticket | undefined;
    if (existing.linear_session_id && ticket?.linear_session_id !== existing.linear_session_id) {
      db.prepare(`
        UPDATE tickets SET running_since = NULL, run_id = NULL, updated_at = ?
        WHERE linear_issue_id = ? AND run_id = ?
      `).run(completedAt, existing.linear_issue_id, params.runId);
    } else {
      db.prepare(`
        UPDATE tickets SET running_since = NULL, run_id = NULL,
          state = COALESCE(?, state), pr_url = COALESCE(?, pr_url),
          last_error = ?, updated_at = ?
        WHERE linear_issue_id = ? AND run_id = ?
      `).run(
        params.ticketState ?? null,
        params.prUrl ?? null,
        params.failureTail ?? null,
        completedAt,
        existing.linear_issue_id,
        params.runId
      );
    }
    db.prepare(`
      UPDATE run_liveness SET actor_state = 'settled', termination_confirmed_at = ?, updated_at = ?
      WHERE run_id = ? AND actor_state = 'quarantined'
    `).run(completedAt, completedAt, params.runId);
    workStore.consumeAcknowledgedForRun(params.runId, params.runId);
    workStore.releaseUnacknowledgedForRun(
      params.runId,
      `owning run ${params.runId} ended after confirmed quarantine recovery`
    );
    return getRunStmt.get(params.runId) as Run;
  });

  const acquireSupervisorLeaseTransaction = db.transaction(
    (name: string, owner: string, nowIso: string, leaseUntilIso: string): boolean => {
      const existing = db.prepare(
        "SELECT owner, lease_until FROM supervisor_leases WHERE name = ?"
      ).get(name) as { owner: string; lease_until: string } | undefined;
      if (existing && existing.owner !== owner && existing.lease_until > nowIso) return false;
      db.prepare(`
        INSERT INTO supervisor_leases(name, owner, lease_until, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          owner = excluded.owner,
          lease_until = excluded.lease_until,
          updated_at = excluded.updated_at
      `).run(name, owner, leaseUntilIso, nowIso);
      return true;
    }
  );

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
        const { pipeline, ...ticketRow } = ticket;
        upsertStmt.run({
          ...ticketRow,
          base_branch: ticket.base_branch ?? existing?.base_branch ?? "main",
          created_at: existing?.created_at ?? now(),
          updated_at: now(),
        });
        const session = supersedeCurrentSessionTransaction(
          ticket.linear_issue_id,
          ticket.linear_session_id
        );
        pipelineStore.supersedeOtherInstances(
          ticket.linear_issue_id,
          ticket.linear_session_id
        );
        if (pipeline) {
          pipelineStore.createInstance({
            ...pipeline,
            issueId: ticket.linear_issue_id,
            sessionId: ticket.linear_session_id,
            generation: session.generation,
            branch: ticket.branch,
            agent: ticket.agent,
          });
        }
      })();
    },
    upsertUnpinned(ticket) {
      const existing = getByIssueIdStmt.get(ticket.linear_issue_id) as Ticket | undefined;
      db.transaction(() => {
        upsertStmt.run({
          ...ticket,
          base_branch: ticket.base_branch ?? existing?.base_branch ?? "main",
          created_at: existing?.created_at ?? now(),
          updated_at: now(),
        });
        supersedeCurrentSessionTransaction(ticket.linear_issue_id, ticket.linear_session_id);
        pipelineStore.supersedeOtherInstances(ticket.linear_issue_id, ticket.linear_session_id);
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
    setLinearContext(issueId, context) {
      setLinearContextStmt.run(context, now(), issueId);
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
    markSessionState(sessionId, state) {
      markSessionStateStmt.run(state, now(), sessionId);
    },
    recordProviderFeedback(params) {
      return feedbackStore.record(params);
    },
    listPendingFeedbackSnapshots(linearSessionId, limit = 50) {
      return db.prepare(`
        SELECT * FROM feedback_snapshots
        WHERE linear_session_id = ? AND status IN ('collecting', 'claimed')
        ORDER BY created_at, id LIMIT ?
      `).all(linearSessionId, limit) as FeedbackSnapshot[];
    },
    claimFeedbackSnapshot(snapshotId, maxRounds) {
      const snapshot = feedbackStore.get(snapshotId);
      if (!snapshot) return { status: "stale" as const };
      return claimFeedbackSnapshot(snapshot, maxRounds);
    },
    consumeFeedbackSnapshot(snapshotId) {
      return feedbackStore.consume(snapshotId);
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
    markLinearOutboxProcessed(id, receipt) {
      db.transaction(() => {
        const processedAt = now();
        db.prepare(`
          UPDATE linear_outbox
          SET status = 'processed', processed_at = ?, next_attempt_at = ?, last_error = NULL,
              external_id = COALESCE(?, external_id),
              external_url = COALESCE(?, external_url),
              attachment_url = COALESCE(?, attachment_url)
          WHERE id = ?
        `).run(
          processedAt,
          processedAt,
          receipt?.externalId ?? null,
          receipt?.externalUrl ?? null,
          receipt?.attachmentUrl ?? null,
          id
        );
        const publication = db.prepare(`
          SELECT * FROM pipeline_publication_receipts WHERE id = ?
        `).get(id) as {
          pipeline_instance_id: string;
          resume_status: string | null;
          status: string;
        } | undefined;
        if (!publication) return;
        db.prepare(`
          UPDATE pipeline_publication_receipts
          SET status = 'acknowledged', external_id = COALESCE(?, external_id),
              external_url = COALESCE(?, external_url),
              attachment_url = COALESCE(?, attachment_url), acknowledged_at = ?,
              last_error = NULL, updated_at = ?
          WHERE id = ?
        `).run(
          receipt?.externalId ?? null,
          receipt?.externalUrl ?? null,
          receipt?.attachmentUrl ?? null,
          processedAt,
          processedAt,
          id
        );
        if (publication.resume_status) {
          db.prepare(`
            UPDATE pipeline_instances
            SET status = ?, state_version = state_version + 1,
                wait_reason = CASE WHEN ? = 'waiting_human' THEN wait_reason ELSE NULL END,
                updated_at = ?
            WHERE id = ? AND status = 'completion_pending_publication'
          `).run(
            publication.resume_status,
            publication.resume_status,
            processedAt,
            publication.pipeline_instance_id
          );
        }
      })();
    },
    markLinearOutboxFailed(id, error, retryAt) {
      db.transaction(() => {
        const timestamp = now();
        const status = retryAt ? "failed" : "dead";
        db.prepare(`
          UPDATE linear_outbox
          SET status = ?, next_attempt_at = ?, last_error = ?
          WHERE id = ?
        `).run(status, retryAt ?? timestamp, error, id);
        const publication = db.prepare(`
          SELECT pipeline_instance_id FROM pipeline_publication_receipts WHERE id = ?
        `).get(id) as { pipeline_instance_id: string } | undefined;
        if (!publication) return;
        const instanceStatus = db.prepare(
          "SELECT status FROM pipeline_instances WHERE id = ?"
        ).pluck().get(publication.pipeline_instance_id) as string | undefined;
        db.prepare(`
          UPDATE pipeline_publication_receipts
          SET status = ?, attempts = (
                SELECT attempts FROM linear_outbox WHERE linear_outbox.id = pipeline_publication_receipts.id
              ),
              next_attempt_at = ?, last_error = ?, updated_at = ?,
              blocked_from_status = CASE WHEN ? = 'dead' THEN COALESCE(
                blocked_from_status, ?
              ) ELSE blocked_from_status END
          WHERE id = ?
        `).run(status, retryAt ?? timestamp, error, timestamp, status, instanceStatus ?? null, id);
        if (status === "dead") {
          db.prepare(`
            UPDATE pipeline_instances
            SET status = 'publication_blocked', state_version = state_version + 1,
                wait_reason = 'permanent publication failure', updated_at = ?
            WHERE id = ? AND status NOT IN (
              'shipped', 'no_change', 'needs_human', 'canceled', 'superseded', 'failed',
              'publication_blocked'
            )
          `).run(timestamp, publication.pipeline_instance_id);
        }
      })();
    },
    recordLinearOutboxAttachment(id, attachmentUrl) {
      const updated = db.prepare(`
        UPDATE linear_outbox SET attachment_url = ?
        WHERE id = ? AND status = 'processing'
      `).run(attachmentUrl, id);
      if (updated.changes !== 1) throw new Error(`linear outbox ${id} is not processing`);
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
      return beginRunTransaction.immediate(params);
    },
    getRun(runId) {
      return getRunStmt.get(runId) as Run | undefined;
    },
    getLatestRunWithLog(issueId) {
      return getLatestRunWithLogStmt.get(issueId) as Run | undefined;
    },
    finishRun(params) {
      return finishRunTransaction.immediate(params);
    },
    claimRunForReaping(runId, owner, reason) {
      return claimRunForReapingTransaction.immediate(runId, owner, reason);
    },
    finishReapingRun(params) {
      return finishReapingRunTransaction.immediate(params);
    },
    quarantineRun(runId, owner, reason) {
      return quarantineRunTransaction.immediate(runId, owner, reason);
    },
    settleQuarantinedRun(params) {
      return settleQuarantinedRunTransaction.immediate(params);
    },
    renewRunLiveness(runId, heartbeatAt) {
      return db.prepare(`
        UPDATE run_liveness
        SET last_heartbeat_at = CASE
              WHEN last_heartbeat_at IS NULL OR last_heartbeat_at < ? THEN ?
              ELSE last_heartbeat_at
            END,
            updated_at = ?
        WHERE run_id = ? AND actor_state = 'running'
      `).run(heartbeatAt, heartbeatAt, now(), runId).changes === 1;
    },
    listExpiredRuns(nowIso) {
      return listExpiredRunsStmt.all(nowIso) as Run[];
    },
    listStalledRuns(cutoffIso) {
      return listStalledRunsStmt.all(cutoffIso) as Run[];
    },
    enqueueInbox(params) {
      const id = params.id ?? randomUUID();
      db.transaction(() => {
        const timestamp = now();
        insertInboxStmt.run(
          id,
          params.issueId,
          params.sessionId,
          params.runId ?? null,
          params.source,
          params.body,
          timestamp
        );
        const session = getSessionStmt.get(params.sessionId) as AgentSession | undefined;
        const ticket = getByIssueIdStmt.get(params.issueId) as Ticket | undefined;
        const runId = params.runId ?? ticket?.run_id;
        let item = workStore.get(id);
        if (!item) {
          item = workStore.enqueue({
            id,
            issueId: params.issueId,
            sessionId: params.sessionId,
            generation: session?.generation ?? 1,
            contextRevision: 0,
            nativeSessionId: session?.provider_conversation_id ?? null,
            source: params.source,
            body: params.body,
          });
        }
        db.prepare(
          "INSERT OR IGNORE INTO work_item_sources(source_table, source_id, work_item_id) VALUES ('session_inbox', ?, ?)"
        ).run(id, id);
        if (
          runId &&
          ticket?.run_id === runId &&
          ticket.agent !== "opencode" &&
          (getRunStmt.get(runId) as Run | undefined)?.status === "running"
        ) {
          workStore.lease({
            workItemId: id,
            issueId: params.issueId,
            sessionId: params.sessionId,
            runId,
            nativeSessionId: item.native_session_id,
            generation: item.generation,
            contextRevision: item.context_revision,
            leaseUntil: new Date(Date.now() + 30_000).toISOString(),
          });
        }
      })();
      return getInboxStmt.get(id) as SteerInboxRecord;
    },
    listPendingInbox(issueId) {
      const timestamp = now();
      const records = listPendingInboxStmt.all(issueId, timestamp) as SteerInboxRecord[];
      const deliverable: SteerInboxRecord[] = [];
      for (const record of records) {
        const item = workStore.get(record.id);
        const activeRunId =
          (getByIssueIdStmt.get(record.linear_issue_id) as Ticket | undefined)?.run_id;
        if (!item || !activeRunId) continue;
        const activeDelivery = record.delivery_id
          ? workStore.getDelivery(record.delivery_id)
          : undefined;
        if (record.run_id !== activeRunId || (activeDelivery && activeDelivery.run_id !== activeRunId)) {
          db.transaction(() => {
            if (activeDelivery) {
              workStore.expireUnacknowledged(
                activeDelivery.id,
                activeDelivery.run_id,
                `owning run ${activeDelivery.run_id} ended before acknowledgement`
              );
            }
            cancelInboxStmt.run(record.id);
            workStore.cancel(record.id, `steering was fenced to ended run ${record.run_id ?? "unknown"}`);
          })();
          continue;
        }
        if (record.status === "pending" && record.delivery_id) {
          deliverable.push(getInboxStmt.get(record.id) as SteerInboxRecord);
          continue;
        }
        workStore.lease({
          workItemId: record.id,
          issueId: record.linear_issue_id,
          sessionId: record.linear_session_id,
          runId: activeRunId,
          nativeSessionId: item.native_session_id,
          generation: item.generation,
          contextRevision: item.context_revision,
          now: timestamp,
          leaseUntil: new Date(Date.now() + 30_000).toISOString(),
        });
        deliverable.push(getInboxStmt.get(record.id) as SteerInboxRecord);
      }
      return deliverable;
    },
    markInboxDispatched(id) {
      const record = getInboxStmt.get(id) as SteerInboxRecord | undefined;
      if (!record?.delivery_id || !record.run_id || record.generation === null || record.context_revision === null) {
        throw new Error(`inbox work ${id} has no leased delivery`);
      }
      const binding = {
        issueId: record.linear_issue_id,
        sessionId: record.linear_session_id,
        runId: record.run_id,
        nativeSessionId: record.native_session_id,
        generation: record.generation,
        contextRevision: record.context_revision,
      };
      db.transaction(() => {
        workStore.markDispatched(record.delivery_id!, binding);
        markInboxDispatchedStmt.run(now(), id);
      })();
    },
    acknowledgeInboxDelivery(deliveryId, binding) {
      const delivery = workStore.getDelivery(deliveryId);
      if (!delivery || delivery.request_hash !== binding.requestHash) {
        throw new Error(`inbox acknowledgement ${deliveryId} request hash mismatch`);
      }
      db.transaction(() => {
        workStore.acknowledge(deliveryId, binding);
        db.prepare(
          "UPDATE session_inbox SET status = 'acknowledged' WHERE id = ? AND status = 'dispatched'"
        ).run(delivery.work_item_id);
      })();
    },
    cancelPendingInbox(issueId) {
      return db.transaction(() => {
        const ids = db.prepare(
          "SELECT id FROM session_inbox WHERE linear_issue_id = ? AND status IN ('pending', 'dispatched')"
        ).all(issueId) as Array<{ id: string }>;
        const changes = cancelPendingInboxStmt.run(issueId).changes;
        for (const { id } of ids) workStore.cancel(id, "inbox canceled");
        return changes;
      })();
    },
    getInbox(id) {
      return getInboxStmt.get(id) as SteerInboxRecord | undefined;
    },
    getWorkItem(id) {
      return workStore.get(id);
    },
    getWorkDelivery(id) {
      return workStore.getDelivery(id);
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
    pruneEphemeralLinearOutbox(beforeIso) {
      return pruneEphemeralLinearOutboxStmt.run(beforeIso).changes;
    },
    acquireSupervisorLease(name, owner, nowIso, leaseUntilIso) {
      return acquireSupervisorLeaseTransaction.immediate(name, owner, nowIso, leaseUntilIso);
    },
    releaseSupervisorLease(name, owner) {
      return db.prepare(
        "DELETE FROM supervisor_leases WHERE name = ? AND owner = ?"
      ).run(name, owner).changes === 1;
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
