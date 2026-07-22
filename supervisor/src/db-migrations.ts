import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

interface DatabaseMigrationDefinition {
  version: number;
  name: string;
  source: string;
  up(db: Database.Database): void;
}

export interface DatabaseMigration extends DatabaseMigrationDefinition {
  checksum: string;
}

const durableWorkSchema = `
CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  linear_issue_id TEXT NOT NULL,
  linear_session_id TEXT NOT NULL,
  pipeline_instance_id TEXT,
  run_id TEXT,
  native_session_id TEXT,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  context_revision INTEGER NOT NULL CHECK(context_revision >= 0),
  source TEXT NOT NULL,
  priority INTEGER NOT NULL,
  body TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'pending', 'leased', 'dispatched', 'acknowledged', 'consumed',
    'canceled', 'dead', 'reconciliation'
  )),
  active_delivery_id TEXT,
  consumed_by_attempt_id TEXT,
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  consumed_at TEXT,
  canceled_at TEXT
);
CREATE INDEX work_items_claim_idx
  ON work_items(linear_session_id, status, priority, available_at, created_at);

CREATE TABLE work_item_sources (
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  PRIMARY KEY(source_table, source_id),
  FOREIGN KEY(work_item_id) REFERENCES work_items(id) ON DELETE RESTRICT
);

CREATE TABLE work_deliveries (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  attempt_ordinal INTEGER NOT NULL CHECK(attempt_ordinal >= 1),
  idempotency_key TEXT NOT NULL UNIQUE,
  linear_issue_id TEXT NOT NULL,
  linear_session_id TEXT NOT NULL,
  pipeline_instance_id TEXT,
  run_id TEXT NOT NULL,
  native_session_id TEXT,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  context_revision INTEGER NOT NULL CHECK(context_revision >= 0),
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'leased', 'dispatched', 'acknowledged', 'consumed',
    'canceled', 'dead', 'expired'
  )),
  lease_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  acknowledged_at TEXT,
  consumed_at TEXT,
  last_error TEXT,
  UNIQUE(work_item_id, attempt_ordinal),
  FOREIGN KEY(work_item_id) REFERENCES work_items(id) ON DELETE RESTRICT
);
CREATE INDEX work_deliveries_lease_idx ON work_deliveries(status, lease_until);

CREATE TABLE migration_reconciliation (
  migration_version INTEGER NOT NULL,
  category TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(migration_version, category)
);
`;

const lifecycleSchema = `
CREATE TABLE run_liveness (
  run_id TEXT PRIMARY KEY,
  actor_state TEXT NOT NULL DEFAULT 'running'
    CHECK(actor_state IN ('running', 'reaping', 'quarantined', 'settled')),
  last_heartbeat_at TEXT,
  settlement_owner TEXT,
  settlement_reason TEXT,
  termination_confirmed_at TEXT,
  quarantine_reason TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE RESTRICT
);
CREATE INDEX run_liveness_state_idx ON run_liveness(actor_state, last_heartbeat_at);

CREATE TABLE supervisor_leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE provider_events (
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  linear_session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  repository TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  snapshot_id TEXT,
  PRIMARY KEY(provider, provider_event_id)
);
CREATE INDEX provider_events_snapshot_idx
  ON provider_events(linear_issue_id, generation, head_sha, snapshot_id, received_at);

CREATE TABLE feedback_snapshots (
  id TEXT PRIMARY KEY,
  linear_issue_id TEXT NOT NULL,
  linear_session_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  provider_watermark TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('collecting', 'claimed', 'consumed', 'stale')),
  repair_round INTEGER CHECK(repair_round IS NULL OR repair_round >= 1),
  work_item_id TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  consumed_at TEXT,
  UNIQUE(linear_issue_id, generation, head_sha, repair_round)
);

CREATE TABLE feedback_snapshot_events (
  snapshot_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, provider, provider_event_id),
  FOREIGN KEY(snapshot_id) REFERENCES feedback_snapshots(id) ON DELETE RESTRICT,
  FOREIGN KEY(provider, provider_event_id)
    REFERENCES provider_events(provider, provider_event_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX feedback_snapshots_collecting_unique
  ON feedback_snapshots(linear_issue_id, linear_session_id, generation, head_sha)
  WHERE status = 'collecting';
CREATE UNIQUE INDEX feedback_snapshots_work_item_unique
  ON feedback_snapshots(work_item_id)
  WHERE work_item_id IS NOT NULL;
`;

const lifecycleEventIndex = `
CREATE INDEX sandbox_events_run_liveness_idx
  ON sandbox_events(run_id, kind, created_at);
`;

// Checksums must be identical in the source (tsx/vitest) and compiled Node
// runtimes. Function#toString is transpiler-dependent, so each migration owns a
// stable source manifest alongside its executable implementation. Never edit a
// shipped manifest; append a new migration instead.
const durableWorkMigrationSource = `${durableWorkSchema}
backfill-contract:legacy-session-work-and-inbox/v1
legacy claimed and unowned consumed rows -> reconciliation
legacy delivered inbox with a current run -> dispatched-unverified
source identity or body mismatch -> reconciliation
record source, mapped, delivery, terminal, and reconciliation counts`;
const lifecycleMigrationSource = `${lifecycleSchema}
backfill-contract:active-run-liveness/v1
running legacy run -> running liveness rooted at started_at`;
const lifecycleEventIndexMigrationSource = `${lifecycleEventIndex}
index-contract:create-only-when-sandbox-events-exists/v1`;

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  );
}

function hasColumns(db: Database.Database, table: string, columns: string[]): boolean {
  if (!hasTable(db, table)) return false;
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  return columns.every((column) => present.has(column));
}

function backfillRunLiveness(db: Database.Database): void {
  if (!hasColumns(db, "runs", ["id", "status", "started_at"])) return;
  db.prepare(`
    INSERT OR IGNORE INTO run_liveness(run_id, actor_state, updated_at)
    SELECT id, 'running', started_at FROM runs WHERE status = 'running'
  `).run();
}

function backfillLegacyWork(db: Database.Database): void {
  if (!hasTable(db, "session_work")) return;
  const timestamp = new Date().toISOString();
  const legacyRows = db.prepare(`
    SELECT sw.*, COALESCE(s.generation, r.session_generation, 1) AS resolved_generation
    FROM session_work sw
    LEFT JOIN agent_sessions s ON s.id = sw.linear_session_id
    LEFT JOIN runs r ON r.id = sw.claimed_run_id
  `).all() as Array<{
    id: string;
    linear_issue_id: string;
    linear_session_id: string;
    claimed_run_id: string | null;
    source: string;
    priority: number;
    body: string;
    status: string;
    available_at: string;
    created_at: string;
    consumed_at: string | null;
    canceled_at: string | null;
    resolved_generation: number;
  }>;
  const insertWork = db.prepare(`
    INSERT OR IGNORE INTO work_items (
      id, linear_issue_id, linear_session_id, run_id, generation,
      context_revision, source, priority, body, request_hash, status,
      available_at, created_at, updated_at, consumed_at, canceled_at
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of legacyRows) {
    let status = "reconciliation";
    if (row.status === "pending") status = "pending";
    else if (row.status === "consumed" && row.claimed_run_id) status = "consumed";
    else if (row.status === "canceled") status = "canceled";
    const hash = createHash("sha256")
      .update(JSON.stringify([row.id, row.linear_session_id, row.body]))
      .digest("hex");
    insertWork.run(
      row.id,
      row.linear_issue_id,
      row.linear_session_id,
      row.claimed_run_id,
      row.resolved_generation,
      row.source,
      row.priority,
      row.body,
      hash,
      status,
      row.available_at,
      row.created_at,
      timestamp,
      row.consumed_at,
      row.canceled_at
    );
    if (status === "consumed") {
      db.prepare(
        "UPDATE work_items SET consumed_by_attempt_id = ? WHERE id = ? AND status = 'consumed'"
      ).run(row.claimed_run_id, row.id);
    }
  }
  db.prepare(`
    INSERT OR IGNORE INTO work_item_sources(source_table, source_id, work_item_id)
    SELECT 'session_work', id, id FROM session_work
  `).run();

  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM session_work) AS source_count,
      (SELECT COUNT(*) FROM work_item_sources WHERE source_table = 'session_work') AS mapped_count
  `).get() as { source_count: number; mapped_count: number };
  const insert = db.prepare(`
    INSERT OR REPLACE INTO migration_reconciliation
      (migration_version, category, row_count, recorded_at)
    VALUES (1, ?, ?, ?)
  `);
  insert.run("legacy_session_work", counts.source_count, timestamp);
  insert.run("mapped_session_work", counts.mapped_count, timestamp);
  if (counts.source_count !== counts.mapped_count) {
    throw new Error("legacy work reconciliation failed: not every source row was mapped");
  }

  const recordFinalCounts = () => {
    const final = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM work_items) AS authoritative_count,
        (SELECT COUNT(*) FROM work_deliveries) AS delivery_count,
        (SELECT COUNT(*) FROM work_items WHERE status IN ('consumed', 'canceled', 'dead')) AS terminal_count,
        (SELECT COUNT(*) FROM work_items WHERE status = 'reconciliation') AS reconciliation_count
    `).get() as {
      authoritative_count: number;
      delivery_count: number;
      terminal_count: number;
      reconciliation_count: number;
    };
    insert.run("authoritative_work_items", final.authoritative_count, timestamp);
    insert.run("legacy_work_deliveries", final.delivery_count, timestamp);
    insert.run("legacy_terminal_work", final.terminal_count, timestamp);
    insert.run("operator_reconciliation", final.reconciliation_count, timestamp);
  };

  if (!hasTable(db, "session_inbox")) {
    recordFinalCounts();
    return;
  }
  const inboxRows = db.prepare(`
    SELECT si.*, COALESCE(s.generation, r.session_generation, 1) AS resolved_generation,
      s.provider_conversation_id
    FROM session_inbox si
    LEFT JOIN agent_sessions s ON s.id = si.linear_session_id
    LEFT JOIN runs r ON r.id = si.run_id
  `).all() as Array<{
    id: string;
    linear_issue_id: string;
    linear_session_id: string;
    run_id: string | null;
    source: string;
    body: string;
    status: string;
    created_at: string;
    delivered_at: string | null;
    resolved_generation: number;
    provider_conversation_id: string | null;
  }>;
  for (const row of inboxRows) {
    let item = db.prepare("SELECT * FROM work_items WHERE id = ?").get(row.id) as
      | {
          id: string;
          linear_issue_id: string;
          linear_session_id: string;
          run_id: string | null;
          body: string;
          request_hash: string;
          status: string;
        }
      | undefined;
    if (!item) {
      const hash = createHash("sha256")
        .update(JSON.stringify([row.id, row.linear_session_id, row.body]))
        .digest("hex");
      insertWork.run(
        row.id,
        row.linear_issue_id,
        row.linear_session_id,
        row.run_id,
        row.resolved_generation,
        row.source,
        row.source === "human" ? 0 : 10,
        row.body,
        hash,
        row.status === "canceled" ? "canceled" : row.status === "delivered" ? "dispatched" : "pending",
        row.created_at,
        row.created_at,
        timestamp,
        null,
        row.status === "canceled" ? timestamp : null
      );
      item = db.prepare("SELECT * FROM work_items WHERE id = ?").get(row.id) as {
        id: string;
        linear_issue_id: string;
        linear_session_id: string;
        run_id: string | null;
        body: string;
        request_hash: string;
        status: string;
      };
    }
    db.prepare(
      "INSERT OR IGNORE INTO work_item_sources(source_table, source_id, work_item_id) VALUES ('session_inbox', ?, ?)"
    ).run(row.id, row.id);
    if (
      item.linear_issue_id !== row.linear_issue_id ||
      item.linear_session_id !== row.linear_session_id ||
      item.body !== row.body
    ) {
      db.prepare(`
        UPDATE work_items
        SET status = 'reconciliation', active_delivery_id = NULL,
            consumed_by_attempt_id = NULL, consumed_at = NULL, canceled_at = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(timestamp, row.id);
      continue;
    }
    const corroboratedLegacyClaim =
      item.status === "reconciliation" &&
      row.status === "delivered" &&
      row.run_id !== null &&
      item.run_id === row.run_id;
    if (
      ["consumed", "canceled", "dead"].includes(item.status) ||
      (item.status === "reconciliation" && !corroboratedLegacyClaim)
    ) {
      continue;
    }
    if (row.status !== "delivered") continue;
    if (!row.run_id) {
      db.prepare(
        "UPDATE work_items SET status = 'reconciliation', updated_at = ? WHERE id = ? AND status NOT IN ('consumed', 'canceled')"
      ).run(timestamp, row.id);
      continue;
    }
    const deliveryId = `legacy-inbox-${row.id}`;
    db.prepare(`
      INSERT OR IGNORE INTO work_deliveries (
        id, work_item_id, attempt_ordinal, idempotency_key,
        linear_issue_id, linear_session_id, run_id, native_session_id,
        generation, context_revision, request_hash, status, lease_until,
        created_at, dispatched_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 0, ?, 'dispatched', ?, ?, ?)
    `).run(
      deliveryId,
      row.id,
      createHash("sha256").update(`legacy\0${row.id}`).digest("hex"),
      row.linear_issue_id,
      row.linear_session_id,
      row.run_id,
      row.provider_conversation_id,
      row.resolved_generation,
      item.request_hash,
      row.delivered_at ?? row.created_at,
      row.created_at,
      row.delivered_at ?? row.created_at
    );
    db.prepare(
      "UPDATE work_items SET status = 'dispatched', active_delivery_id = ?, updated_at = ? WHERE id = ? AND status NOT IN ('consumed', 'canceled')"
    ).run(deliveryId, timestamp, row.id);
    db.prepare("UPDATE session_inbox SET status = 'dispatched' WHERE id = ?").run(row.id);
  }
  const inboxCounts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM session_inbox) AS source_count,
      (SELECT COUNT(*) FROM work_item_sources WHERE source_table = 'session_inbox') AS mapped_count
  `).get() as { source_count: number; mapped_count: number };
  insert.run("legacy_session_inbox", inboxCounts.source_count, timestamp);
  insert.run("mapped_session_inbox", inboxCounts.mapped_count, timestamp);
  if (inboxCounts.source_count !== inboxCounts.mapped_count) {
    throw new Error("legacy inbox reconciliation failed: not every source row was mapped");
  }
  recordFinalCounts();
}

const definitions: DatabaseMigrationDefinition[] = [
  {
    version: 1,
    name: "durable-work-delivery",
    source: durableWorkMigrationSource,
    up(db) {
      db.exec(durableWorkSchema);
      backfillLegacyWork(db);
    },
  },
  {
    version: 2,
    name: "exclusive-actor-lifecycle-and-feedback",
    source: lifecycleMigrationSource,
    up(db) {
      db.exec(lifecycleSchema);
      backfillRunLiveness(db);
    },
  },
  {
    version: 3,
    name: "sandbox-liveness-event-index",
    source: lifecycleEventIndexMigrationSource,
    up(db) {
      if (hasTable(db, "sandbox_events")) db.exec(lifecycleEventIndex);
    },
  },
];

export const databaseMigrations: DatabaseMigration[] = definitions.map((migration) => ({
  ...migration,
  checksum: createHash("sha256")
    .update(`${migration.version}\0${migration.name}\0${migration.source}`)
    .digest("hex"),
}));

export function applyDatabaseMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  db.transaction(() => {
    // Read the ledger only after the exclusive lock is held. A second
    // supervisor starting concurrently then observes the first one's committed
    // ledger instead of replaying a migration from a stale pre-lock snapshot.
    const applied = db.prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version"
    ).all() as Array<{ version: number; name: string; checksum: string }>;
    const latestKnown = databaseMigrations.at(-1)?.version ?? 0;
    const future = applied.find((row) => row.version > latestKnown);
    if (future) {
      throw new Error(`database has newer schema version ${future.version}; this release supports ${latestKnown}`);
    }
    for (const row of applied) {
      const expected = databaseMigrations.find((migration) => migration.version === row.version);
      if (!expected || row.name !== expected.name || row.checksum !== expected.checksum) {
        throw new Error(`schema migration ${row.version} checksum mismatch`);
      }
    }
    for (const migration of databaseMigrations) {
      if (applied.some((row) => row.version === migration.version)) continue;
      migration.up(db);
      db.prepare(
        "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)"
      ).run(migration.version, migration.name, migration.checksum, new Date().toISOString());
    }
  }).exclusive();
}
