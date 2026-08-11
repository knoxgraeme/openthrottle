import type Database from "better-sqlite3";

export const schema = `
CREATE TABLE IF NOT EXISTS tickets (
  linear_issue_id TEXT PRIMARY KEY,
  linear_issue_identifier TEXT NOT NULL,
  linear_session_id TEXT NOT NULL,
  control_provider TEXT NOT NULL DEFAULT 'linear' CHECK(control_provider IN ('linear', 'github')),
  external_thread_id TEXT,
  external_thread_reference TEXT,
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
CREATE INDEX IF NOT EXISTS runs_linear_issue_idx ON runs(linear_issue_id, started_at);
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
  ingestion_diagnosed_at TEXT,
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
  redelivered_at TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_received_idx
  ON webhook_deliveries(received_at);

CREATE TABLE IF NOT EXISTS github_webhook_redelivery_requests (
  repository TEXT NOT NULL COLLATE NOCASE,
  webhook_id INTEGER NOT NULL,
  delivery_id INTEGER NOT NULL,
  delivery_guid TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('claimed', 'accepted', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  accepted_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(repository, webhook_id, delivery_id)
);
CREATE INDEX IF NOT EXISTS github_webhook_redelivery_process_idx
  ON github_webhook_redelivery_requests(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS repository_registrations (
  github_repo TEXT PRIMARY KEY COLLATE NOCASE,
  control_provider TEXT NOT NULL DEFAULT 'linear' CHECK(control_provider IN ('linear', 'github')),
  linear_team_key TEXT COLLATE NOCASE,
  linear_team_id TEXT,
  base_branch TEXT NOT NULL,
  webhook_id INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(control_provider <> 'linear' OR linear_team_key IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`;

const ticketMigrations: Array<[string, string]> = [
  ["running_since", "ALTER TABLE tickets ADD COLUMN running_since TEXT"],
  ["run_id", "ALTER TABLE tickets ADD COLUMN run_id TEXT"],
  ["total_cost_usd", "ALTER TABLE tickets ADD COLUMN total_cost_usd REAL NOT NULL DEFAULT 0"],
  ["last_error", "ALTER TABLE tickets ADD COLUMN last_error TEXT"],
  ["linear_context", "ALTER TABLE tickets ADD COLUMN linear_context TEXT"],
  ["control_provider", "ALTER TABLE tickets ADD COLUMN control_provider TEXT NOT NULL DEFAULT 'linear' CHECK(control_provider IN ('linear', 'github'))"],
  ["external_thread_id", "ALTER TABLE tickets ADD COLUMN external_thread_id TEXT"],
  ["external_thread_reference", "ALTER TABLE tickets ADD COLUMN external_thread_reference TEXT"],
  ["base_branch", "ALTER TABLE tickets ADD COLUMN base_branch TEXT NOT NULL DEFAULT 'main'"],
];

const neutralTicketMigrations: Array<[string, string]> = [
  ["running_since", "ALTER TABLE tickets ADD COLUMN running_since TEXT"],
  ["run_id", "ALTER TABLE tickets ADD COLUMN run_id TEXT"],
  ["total_cost_usd", "ALTER TABLE tickets ADD COLUMN total_cost_usd REAL NOT NULL DEFAULT 0"],
  ["last_error", "ALTER TABLE tickets ADD COLUMN last_error TEXT"],
  ["context", "ALTER TABLE tickets ADD COLUMN context TEXT"],
  ["control_provider", "ALTER TABLE tickets ADD COLUMN control_provider TEXT NOT NULL DEFAULT 'linear' CHECK(control_provider IN ('linear', 'github'))"],
  ["external_thread_id", "ALTER TABLE tickets ADD COLUMN external_thread_id TEXT"],
  ["external_thread_reference", "ALTER TABLE tickets ADD COLUMN external_thread_reference TEXT"],
  ["base_branch", "ALTER TABLE tickets ADD COLUMN base_branch TEXT NOT NULL DEFAULT 'main'"],
];

const runMigrations: Array<[string, string]> = [
  ["linear_session_id", "ALTER TABLE runs ADD COLUMN linear_session_id TEXT"],
  ["session_generation", "ALTER TABLE runs ADD COLUMN session_generation INTEGER"],
  ["log_tail", "ALTER TABLE runs ADD COLUMN log_tail TEXT"],
];

const neutralRunMigrations: Array<[string, string]> = [
  ["session_generation", "ALTER TABLE runs ADD COLUMN session_generation INTEGER"],
  ["log_tail", "ALTER TABLE runs ADD COLUMN log_tail TEXT"],
];

const deliveryMigrations: Array<[string, string]> = [
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
  const ticketColumns = new Set(
    (db.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  const sessionColumns = new Set(
    (db.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  const ticketIdColumn = ticketColumns.has("ticket_id") ? "ticket_id" : "linear_issue_id";
  const sessionIdColumn = ticketColumns.has("session_id") ? "session_id" : "linear_session_id";
  const sessionTicketIdColumn = sessionColumns.has("ticket_id") ? "ticket_id" : "linear_issue_id";
  db.prepare(`
    INSERT OR IGNORE INTO agent_sessions (
      id, ${sessionTicketIdColumn}, generation, state, created_at, updated_at
    )
    SELECT
      tickets.${sessionIdColumn},
      tickets.${ticketIdColumn},
      1,
      CASE tickets.state WHEN 'stopped' THEN 'stopped' ELSE 'current' END,
      COALESCE(tickets.created_at, ?),
      COALESCE(tickets.updated_at, ?)
    FROM tickets
    WHERE tickets.${sessionIdColumn} IS NOT NULL
      AND tickets.${sessionIdColumn} <> ''
      AND NOT EXISTS (
        SELECT 1 FROM agent_sessions
        WHERE agent_sessions.${sessionTicketIdColumn} = tickets.${ticketIdColumn}
      )
  `).run(timestamp, timestamp);
}

export function applyBaseSchema(db: Database.Database): void {
  const neutralOutboxAlreadyExists = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'control_outbox'").get()
  );
  if (neutralOutboxAlreadyExists) {
    const outboxStart = schema.indexOf("CREATE TABLE IF NOT EXISTS linear_outbox (");
    const outboxEndMarker = "  ON linear_outbox(linear_session_id, sequence);";
    const outboxEnd = schema.indexOf(outboxEndMarker, outboxStart);
    if (outboxStart < 0 || outboxEnd < 0) {
      throw new Error("legacy outbox bootstrap boundary is invalid");
    }
    db.exec(schema.slice(0, outboxStart) + schema.slice(outboxEnd + outboxEndMarker.length));
  } else {
    db.exec(schema);
  }
  const ticketColumns = new Set(
    (db.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  const runColumns = new Set(
    (db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  applyColumnMigrations(
    db,
    "tickets",
    ticketColumns.has("ticket_id") ? neutralTicketMigrations : ticketMigrations
  );
  applyColumnMigrations(db, "webhook_deliveries", deliveryMigrations);
  applyColumnMigrations(
    db,
    "runs",
    runColumns.has("session_id") ? neutralRunMigrations : runMigrations
  );
  backfillAgentSessions(db);
}

export function applyCompatibilityIndexes(db: Database.Database): void {
  db.exec(
    "CREATE INDEX IF NOT EXISTS tickets_repo_branch_idx ON tickets(repo, branch);" +
      "CREATE INDEX IF NOT EXISTS tickets_sandbox_idx ON tickets(sandbox_id);" +
      "CREATE INDEX IF NOT EXISTS webhook_deliveries_process_idx ON webhook_deliveries(status, next_attempt_at);"
  );
  const runColumns = new Set(
    (db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  if (runColumns.has("session_id")) {
    db.exec("CREATE INDEX IF NOT EXISTS runs_session_idx ON runs(session_id, session_generation);");
  } else {
    db.exec("CREATE INDEX IF NOT EXISTS runs_session_idx ON runs(linear_session_id, session_generation);");
  }
  const registrationColumns = new Set(
    (db.prepare("PRAGMA table_info(repository_registrations)").all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  // These partial indexes reference the provider discriminator introduced by
  // migration 33. Creating them in the bootstrap schema would make an upgrade
  // fail before that migration can rebuild the legacy registration table.
  if (registrationColumns.has("control_provider")) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS repository_registrations_linear_team_key_idx
        ON repository_registrations(linear_team_key)
        WHERE control_provider = 'linear' AND linear_team_key IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS repository_registrations_linear_team_id_idx
        ON repository_registrations(linear_team_id)
        WHERE control_provider = 'linear' AND linear_team_id IS NOT NULL;
    `);
  }
}
