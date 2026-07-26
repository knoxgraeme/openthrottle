import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyDatabaseMigrations, databaseMigrations } from "./runner.js";

let db: Database.Database | undefined;
const temporaryDirectories: string[] = [];

afterEach(() => {
  db?.close();
  db = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database migrations", () => {
  it("records immutable checksums and is idempotent", () => {
    db = new Database(":memory:");
    applyDatabaseMigrations(db);
    applyDatabaseMigrations(db);

    const rows = db.prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version"
    ).all() as Array<{ version: number; name: string; checksum: string }>;
    expect(rows).toHaveLength(databaseMigrations.length);
    expect(rows.map((row) => row.version)).toEqual(databaseMigrations.map((migration) => migration.version));
    expect(rows.every((row) => /^[a-f0-9]{64}$/.test(row.checksum))).toBe(true);
    // These hashes come only from stable migration manifests, never transpiled
    // Function#toString output. Changing one means adding a new migration, not
    // rewriting an already accepted ledger entry.
    expect(databaseMigrations.map((migration) => migration.checksum)).toEqual([
      "b94ca61aba6b4e06872210f58f19d7dc8c53fbdec42f6ad238be7cf4d96bebef",
      "504d954a847f08dbd3db3f144c208b3270de4ecd8b52cddcbb02893353c40b68",
      "140f060d9f9b340c994776f60e97a5e5945e1648fff18879ff5548f29a4618be",
      "4d2bb23002c3c517560bc0ef43e0e9af732ce0dfc9d180129e2b1b23138c928c",
      "bed5e9e1ce85b323ebb87d4dd70148bae8a44e64017eec6d25484cb433079c65",
      "a25c3d25dbbbabaeb00a7b74d77ff186706f92579333aeee8b78f18eb1de4644",
      "3da725659a91d7b2babf5a2dac20f1cca26cbe7957d238c5f1877f7bf38de40a",
      "e2cd34be32f4dd0ab9fdacb87732dae7121574efb7bd1aa166090e3591b851e6",
      "a8687cedc0fd1fc88b1cc8a6c39589d9cbe3279f6360195975de9f87e1d25ba3",
      "3ad35a452352b7cd5db98b32ba67b2f6906c465fa263a8396cae4ad09b7a3ab7",
    ]);
  });

  it("commits a complete ledger that reopens idempotently from a real SQLite file", () => {
    const directory = mkdtempSync(join(tmpdir(), "openthrottle-migration-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "supervisor.db");
    db = new Database(path);
    applyDatabaseMigrations(db);
    db.close();

    db = new Database(path);
    applyDatabaseMigrations(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
      count: databaseMigrations.length,
    });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_deliveries'"
    ).get()).toEqual({ name: "work_deliveries" });
  });

  it("fails closed on a checksum mismatch or unknown newer version", () => {
    db = new Database(":memory:");
    applyDatabaseMigrations(db);
    db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
    expect(() => applyDatabaseMigrations(db!)).toThrow(/checksum mismatch/i);

    db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run(
      databaseMigrations[0].checksum
    );
    db.prepare(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (999, 'future', 'x', '2026-01-01T00:00:00.000Z')"
    ).run();
    expect(() => applyDatabaseMigrations(db!)).toThrow(/newer schema version/i);
  });

  it("backfills liveness ownership for a pre-upgrade active actor", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL);
      INSERT INTO runs VALUES ('legacy-running', 'running', '2026-01-01T00:00:00.000Z');
      INSERT INTO runs VALUES ('legacy-complete', 'completed', '2025-01-01T00:00:00.000Z');
    `);

    applyDatabaseMigrations(db);

    expect(db.prepare("SELECT run_id, actor_state, updated_at FROM run_liveness").all()).toEqual([
      {
        run_id: "legacy-running",
        actor_state: "running",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("backfills pipeline attempt actors from legacy liveness state", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    for (const migration of databaseMigrations.slice(0, 8)) {
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')
      `).run(migration.version, migration.name, migration.checksum);
    }
    db.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE run_liveness (
        run_id TEXT PRIMARY KEY, actor_state TEXT NOT NULL,
        last_heartbeat_at TEXT, settlement_owner TEXT, settlement_reason TEXT,
        termination_confirmed_at TEXT, quarantine_reason TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE pipeline_stage_attempts (
        id TEXT PRIMARY KEY, run_id TEXT, planned_run_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO runs VALUES ('run-bound', 'running', '2026-01-01T00:00:00.000Z', NULL);
      INSERT INTO runs VALUES ('run-planned', 'reaping', '2026-01-01T00:00:01.000Z', NULL);
      INSERT INTO runs VALUES ('run-quarantined', 'quarantined', '2026-01-01T00:00:02.000Z', NULL);
      INSERT INTO runs VALUES (
        'run-settled', 'completed', '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:09.000Z'
      );
      INSERT INTO run_liveness VALUES (
        'run-bound', 'running', '2026-01-01T00:00:02.000Z', NULL, NULL, NULL, NULL,
        '2026-01-01T00:00:03.000Z'
      );
      INSERT INTO run_liveness VALUES (
        'run-planned', 'reaping', '2026-01-01T00:00:04.000Z', 'owner-1',
        'stalled', NULL, NULL, '2026-01-01T00:00:05.000Z'
      );
      INSERT INTO run_liveness VALUES (
        'run-quarantined', 'quarantined', '2026-01-01T00:00:06.000Z', 'owner-2',
        'stalled', NULL, 'stop unconfirmed', '2026-01-01T00:00:07.000Z'
      );
      INSERT INTO run_liveness VALUES (
        'run-settled', 'settled', '2026-01-01T00:00:08.000Z', 'owner-3',
        'completed', '2026-01-01T00:00:09.000Z', NULL, '2026-01-01T00:00:09.000Z'
      );
      INSERT INTO pipeline_stage_attempts VALUES (
        'attempt-bound', 'run-bound', 'run-bound',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO pipeline_stage_attempts VALUES (
        'attempt-planned', NULL, 'run-planned',
        '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'
      );
      INSERT INTO pipeline_stage_attempts VALUES (
        'attempt-quarantined', 'run-quarantined', 'run-quarantined',
        '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'
      );
      INSERT INTO pipeline_stage_attempts VALUES (
        'attempt-settled', 'run-settled', 'run-settled',
        '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z'
      );
    `);

    applyDatabaseMigrations(db);

    expect(db.prepare(`
      SELECT attempt_id, run_id, actor_state, last_heartbeat_at, settlement_owner,
        settlement_reason, termination_confirmed_at, quarantine_reason
      FROM pipeline_attempt_actors ORDER BY attempt_id
    `).all()).toEqual([
      {
        attempt_id: "attempt-bound",
        run_id: "run-bound",
        actor_state: "running",
        last_heartbeat_at: "2026-01-01T00:00:02.000Z",
        settlement_owner: null,
        settlement_reason: null,
        termination_confirmed_at: null,
        quarantine_reason: null,
      },
      {
        attempt_id: "attempt-planned",
        run_id: "run-planned",
        actor_state: "reaping",
        last_heartbeat_at: "2026-01-01T00:00:04.000Z",
        settlement_owner: "owner-1",
        settlement_reason: "stalled",
        termination_confirmed_at: null,
        quarantine_reason: null,
      },
      {
        attempt_id: "attempt-quarantined",
        run_id: "run-quarantined",
        actor_state: "quarantined",
        last_heartbeat_at: "2026-01-01T00:00:06.000Z",
        settlement_owner: "owner-2",
        settlement_reason: "stalled",
        termination_confirmed_at: null,
        quarantine_reason: "stop unconfirmed",
      },
      {
        attempt_id: "attempt-settled",
        run_id: "run-settled",
        actor_state: "settled",
        last_heartbeat_at: "2026-01-01T00:00:08.000Z",
        settlement_owner: "owner-3",
        settlement_reason: "completed",
        termination_confirmed_at: "2026-01-01T00:00:09.000Z",
        quarantine_reason: null,
      },
    ]);
  });

  it("maps legacy claims conservatively and never invents inbox acknowledgement", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY, generation INTEGER NOT NULL, provider_conversation_id TEXT
      );
      CREATE TABLE runs (id TEXT PRIMARY KEY, session_generation INTEGER);
      CREATE TABLE session_work (
        id TEXT PRIMARY KEY, linear_session_id TEXT NOT NULL, linear_issue_id TEXT NOT NULL,
        source TEXT NOT NULL, priority INTEGER NOT NULL, body TEXT NOT NULL,
        status TEXT NOT NULL, claimed_run_id TEXT, available_at TEXT NOT NULL,
        created_at TEXT NOT NULL, consumed_at TEXT, canceled_at TEXT
      );
      CREATE TABLE session_inbox (
        id TEXT PRIMARY KEY, linear_issue_id TEXT NOT NULL, linear_session_id TEXT NOT NULL,
        run_id TEXT, source TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, delivered_at TEXT
      );
      INSERT INTO agent_sessions VALUES ('session-1', 4, 'native-1');
      INSERT INTO runs VALUES ('run-1', 4);
      INSERT INTO session_work VALUES (
        'work-1', 'session-1', 'issue-1', 'human', 0, 'steer',
        'claimed', 'run-1', '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', NULL, NULL
      );
      INSERT INTO session_inbox VALUES (
        'work-1', 'issue-1', 'session-1', 'run-1', 'human', 'steer',
        'delivered', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z'
      );
    `);

    applyDatabaseMigrations(db);

    expect(db.prepare("SELECT status FROM work_items WHERE id = 'work-1'").get()).toEqual({
      status: "dispatched",
    });
    expect(db.prepare(
      "SELECT status, acknowledged_at FROM work_deliveries WHERE work_item_id = 'work-1'"
    ).get()).toEqual({ status: "dispatched", acknowledged_at: null });
    expect(db.prepare(
      "SELECT category, row_count FROM migration_reconciliation ORDER BY category"
    ).all()).toEqual(expect.arrayContaining([
      { category: "legacy_session_inbox", row_count: 1 },
      { category: "legacy_session_work", row_count: 1 },
      { category: "mapped_session_inbox", row_count: 1 },
      { category: "mapped_session_work", row_count: 1 },
      { category: "authoritative_work_items", row_count: 1 },
      { category: "legacy_work_deliveries", row_count: 1 },
      { category: "operator_reconciliation", row_count: 0 },
    ]));
  });

  it("maps every legacy assurance class without upgrading ambiguous evidence", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY, generation INTEGER NOT NULL, provider_conversation_id TEXT
      );
      CREATE TABLE runs (id TEXT PRIMARY KEY, session_generation INTEGER);
      CREATE TABLE session_work (
        id TEXT PRIMARY KEY, linear_session_id TEXT NOT NULL, linear_issue_id TEXT NOT NULL,
        source TEXT NOT NULL, priority INTEGER NOT NULL, body TEXT NOT NULL,
        status TEXT NOT NULL, claimed_run_id TEXT, available_at TEXT NOT NULL,
        created_at TEXT NOT NULL, consumed_at TEXT, canceled_at TEXT
      );
      CREATE TABLE session_inbox (
        id TEXT PRIMARY KEY, linear_issue_id TEXT NOT NULL, linear_session_id TEXT NOT NULL,
        run_id TEXT, source TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, delivered_at TEXT
      );
      INSERT INTO agent_sessions VALUES ('session-1', 3, 'native-1');
      INSERT INTO runs VALUES ('run-1', 3);
      INSERT INTO session_work VALUES
        ('pending', 'session-1', 'issue-1', 'human', 0, 'p', 'pending', NULL, '2026-01-01', '2026-01-01', NULL, NULL),
        ('claimed', 'session-1', 'issue-1', 'human', 0, 'c', 'claimed', 'run-1', '2026-01-01', '2026-01-01', NULL, NULL),
        ('consumed', 'session-1', 'issue-1', 'automatic', 10, 'done', 'consumed', 'run-1', '2026-01-01', '2026-01-01', '2026-01-02', NULL),
        ('unowned-consumed', 'session-1', 'issue-1', 'automatic', 10, 'ambiguous', 'consumed', NULL, '2026-01-01', '2026-01-01', '2026-01-02', NULL),
        ('canceled', 'session-1', 'issue-1', 'human', 0, 'x', 'canceled', NULL, '2026-01-01', '2026-01-01', NULL, '2026-01-02');
      INSERT INTO session_inbox VALUES
        ('inbox-pending', 'issue-1', 'session-1', NULL, 'human', 'ip', 'pending', '2026-01-01', NULL),
        ('inbox-unbound', 'issue-1', 'session-1', NULL, 'human', 'iu', 'delivered', '2026-01-01', '2026-01-02'),
        ('inbox-dispatched', 'issue-1', 'session-1', 'run-1', 'human', 'id', 'delivered', '2026-01-01', '2026-01-02');
    `);

    applyDatabaseMigrations(db);

    expect(db.prepare("SELECT id, status FROM work_items ORDER BY id").all()).toEqual([
      { id: "canceled", status: "canceled" },
      { id: "claimed", status: "reconciliation" },
      { id: "consumed", status: "consumed" },
      { id: "inbox-dispatched", status: "dispatched" },
      { id: "inbox-pending", status: "pending" },
      { id: "inbox-unbound", status: "reconciliation" },
      { id: "pending", status: "pending" },
      { id: "unowned-consumed", status: "reconciliation" },
    ]);
    expect(db.prepare(
      "SELECT consumed_by_attempt_id FROM work_items WHERE id = 'consumed'"
    ).get()).toEqual({ consumed_by_attempt_id: "run-1" });
    expect(db.prepare(
      "SELECT status, acknowledged_at FROM work_deliveries WHERE work_item_id = 'inbox-dispatched'"
    ).get()).toEqual({ status: "dispatched", acknowledged_at: null });
    expect(db.prepare(
      "SELECT row_count FROM migration_reconciliation WHERE category = 'operator_reconciliation'"
    ).get()).toEqual({ row_count: 3 });
  });

  it("routes colliding legacy identities with different bodies to reconciliation", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY, generation INTEGER NOT NULL, provider_conversation_id TEXT
      );
      CREATE TABLE runs (id TEXT PRIMARY KEY, session_generation INTEGER);
      CREATE TABLE session_work (
        id TEXT PRIMARY KEY, linear_session_id TEXT NOT NULL, linear_issue_id TEXT NOT NULL,
        source TEXT NOT NULL, priority INTEGER NOT NULL, body TEXT NOT NULL,
        status TEXT NOT NULL, claimed_run_id TEXT, available_at TEXT NOT NULL,
        created_at TEXT NOT NULL, consumed_at TEXT, canceled_at TEXT
      );
      CREATE TABLE session_inbox (
        id TEXT PRIMARY KEY, linear_issue_id TEXT NOT NULL, linear_session_id TEXT NOT NULL,
        run_id TEXT, source TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, delivered_at TEXT
      );
      INSERT INTO agent_sessions VALUES ('session-1', 1, 'native-1');
      INSERT INTO runs VALUES ('run-1', 1);
      INSERT INTO session_work VALUES (
        'collision', 'session-1', 'issue-1', 'human', 0, 'original body',
        'claimed', 'run-1', '2026-01-01', '2026-01-01', NULL, NULL
      );
      INSERT INTO session_inbox VALUES (
        'collision', 'issue-1', 'session-1', 'run-1', 'human', 'different body',
        'delivered', '2026-01-01', '2026-01-02'
      );
    `);

    applyDatabaseMigrations(db);

    expect(db.prepare("SELECT status FROM work_items WHERE id = 'collision'").get()).toEqual({
      status: "reconciliation",
    });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM work_deliveries WHERE work_item_id = 'collision'"
    ).get()).toEqual({ count: 0 });
  });
});
