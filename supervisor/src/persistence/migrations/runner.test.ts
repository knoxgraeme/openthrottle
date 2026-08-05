import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../database.js";
import { parsePipelineManifest } from "../../pipeline/manifest.js";
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
      "1b7f1245f97725dfe081493638283b38fec8f363138fe5b8c4450ba9220ee84c",
      "5a368da3f7ec165fef42cdb27545534372e6344c3283f185e65e5c447a671dee",
      "927f4e9a8a9583b52fed3f537a364ba4a57c47ea9afa4b9475286e2ec8605b71",
      "e9a57fd85fbca09daeb1b87dbeab27d9cf696da3cb6e00a4a0ee7652bb72d6e2",
      "f8bdad88455442e46d1951f7fe48050f9367d83273ed94c8eaf7f610666fb809",
      "5327e028894aeac2334d4fd63da3937cdb3470419d9cde8aa7f20832280aa6ad",
      "438e4388d9f50e29233a33c86065e97e0e958b9c1e39a04e0c6be74c279c805f",
      "23f09c8fd9f001ea824f86a24edd3d496949594af5dfeb9ad835fc109942ac97",
      "5cf580fcb6d73b2b4ff4fdaa5cf4e1a7c14b2f84b945fcdf313caf36ca4cf662",
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
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_journal'"
    ).get()).toEqual({ name: "orchestration_journal" });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'orchestration_journal_issue_recorded_idx'
    `).get()).toEqual({ name: "orchestration_journal_issue_recorded_idx" });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'orchestration_journal_issue_lower_recorded_idx'
    `).get()).toEqual({ name: "orchestration_journal_issue_lower_recorded_idx" });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'orchestration_journal_repository_recorded_idx'
    `).get()).toEqual({ name: "orchestration_journal_repository_recorded_idx" });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'orchestration_journal_repository_lower_recorded_idx'
    `).get()).toEqual({ name: "orchestration_journal_repository_lower_recorded_idx" });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_units'"
    ).get()).toEqual({ name: "execution_units" });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_gate_receipts'"
    ).get()).toEqual({ name: "execution_gate_receipts" });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_downstream_context'"
    ).get()).toEqual({ name: "execution_downstream_context" });
    expect(db.prepare(`
      SELECT name FROM pragma_table_info('execution_graphs') WHERE name = 'stopped_at'
    `).get()).toEqual({ name: "stopped_at" });
    expect(db.prepare(`
      SELECT name FROM pragma_table_info('execution_graphs') WHERE name = 'stop_reason'
    `).get()).toEqual({ name: "stop_reason" });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'execution_work_one_active_idx'
    `).get()).toEqual({ name: "execution_work_one_active_idx" });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'execution_units_graph_status_idx'
    `).get()).toEqual({ name: "execution_units_graph_status_idx" });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM pragma_foreign_key_list('execution_units')
      WHERE "table" = 'execution_graphs'
    `).get()).toEqual({ count: 3 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM pragma_foreign_key_list('execution_work_attempts')
      WHERE "table" = 'execution_units'
    `).get()).toEqual({ count: 5 });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM pragma_foreign_key_list('execution_units')
      WHERE "table" = 'execution_work_attempts'
    `).get()).toEqual({ count: 6 });
  });

  it("does not stamp v18 when composite identity prerequisites are missing", () => {
    const scenarios = [
      {
        schema: `
          CREATE TABLE pipeline_instances (id TEXT PRIMARY KEY);
          CREATE TABLE pipeline_stage_attempts (
            id TEXT PRIMARY KEY,
            pipeline_instance_id TEXT NOT NULL,
            planned_run_id TEXT
          );
          CREATE TABLE execution_graphs (id TEXT PRIMARY KEY);
          CREATE TABLE execution_work_attempts (id TEXT PRIMARY KEY);
          CREATE TABLE execution_gate_receipts (id TEXT PRIMARY KEY);
          CREATE TABLE execution_downstream_context (id TEXT PRIMARY KEY);
        `,
        error: /missing execution_units/,
      },
      {
        schema: `
          CREATE TABLE pipeline_instances (id TEXT PRIMARY KEY);
          CREATE TABLE pipeline_stage_attempts (
            id TEXT PRIMARY KEY,
            pipeline_instance_id TEXT NOT NULL
          );
          CREATE TABLE execution_graphs (id TEXT PRIMARY KEY);
          CREATE TABLE execution_units (id TEXT PRIMARY KEY);
          CREATE TABLE execution_work_attempts (id TEXT PRIMARY KEY);
          CREATE TABLE execution_gate_receipts (id TEXT PRIMARY KEY);
          CREATE TABLE execution_downstream_context (id TEXT PRIMARY KEY);
        `,
        error: /missing pipeline_stage_attempts\.planned_run_id/,
      },
    ];

    for (const scenario of scenarios) {
      db = new Database(":memory:");
      db.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        ${scenario.schema}
      `);
      for (const migration of databaseMigrations.filter((candidate) => candidate.version <= 17)) {
        db.prepare(`
          INSERT INTO schema_migrations(version, name, checksum, applied_at)
          VALUES (?, ?, ?, '2026-07-29T00:00:00.000Z')
        `).run(migration.version, migration.name, migration.checksum);
      }

      expect(() => applyDatabaseMigrations(db!)).toThrow(scenario.error);
      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 18").get()).toBeUndefined();
      db.close();
      db = undefined;
    }
  });

  it("preserves valid active child pointers while rebuilding the composite identity", () => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    for (const migration of databaseMigrations.filter((candidate) => candidate.version <= 17)) {
      migration.up(db);
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-07-29T00:00:00.000Z')
      `).run(migration.version, migration.name, migration.checksum);
    }
    const now = "2026-07-29T00:00:00.000Z";
    db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        linear_issue_id TEXT PRIMARY KEY,
        linear_issue_identifier TEXT NOT NULL,
        linear_session_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        agent TEXT NOT NULL,
        repo TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        linear_issue_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(id, linear_issue_id, generation)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        linear_issue_id TEXT NOT NULL,
        linear_session_id TEXT NOT NULL,
        session_generation INTEGER NOT NULL,
        task_type TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        expires_at TEXT
      );
      INSERT INTO tickets (
        linear_issue_id, linear_issue_identifier, linear_session_id, branch, agent,
        repo, base_branch, created_at, updated_at
      ) VALUES ('issue-1', 'OPE-1', 'session-1', 'ot/ope-1', 'codex', 'owner/repo', 'main', '${now}', '${now}');
      INSERT INTO agent_sessions (
        id, linear_issue_id, generation, state, created_at, updated_at
      ) VALUES ('session-1', 'issue-1', 1, 'current', '${now}', '${now}');
      INSERT INTO runs (
        id, linear_issue_id, linear_session_id, session_generation, task_type,
        token_hash, status, started_at, expires_at
      ) VALUES (
        'run-parent', 'issue-1', 'session-1', 1, 'implement', 'request-hash',
        'running', '${now}', '2026-07-29T01:00:00.000Z'
      );
      INSERT INTO repository_config_snapshots (
        id, repository, base_commit, blob_sha, digest, normalized_config, created_at
      ) VALUES ('config-1', 'owner/repo', '${"a".repeat(40)}', '${"b".repeat(40)}', '${"c".repeat(64)}', '{}', '${now}');
      INSERT INTO runtime_capability_descriptors (
        runtime_release, digest, protocol, normalized_descriptor, accepted_at
      ) VALUES ('runtime/v1', '${"d".repeat(64)}', 'stage-executor@1', '{}', '${now}');
      INSERT INTO pipeline_catalog_entries (
        pipeline_id, version, digest, normalized_manifest, accepted_at
      ) VALUES ('structured', 1, '${"e".repeat(64)}', '{}', '${now}');
      INSERT INTO pipeline_instances (
        id, linear_issue_id, linear_session_id, generation, pipeline_id, pipeline_version,
        manifest_digest, normalized_manifest, repository, base_commit, branch,
        repository_config_snapshot_id, repository_config_digest, runtime_release, capability_digest,
        executor_protocol, authorized_capabilities, status, active_stage_id, state_version,
        attempt_count, created_at, updated_at
      ) VALUES (
        'instance-1', 'issue-1', 'session-1', 1, 'structured', 1, '${"e".repeat(64)}',
        '{}', 'owner/repo', '${"a".repeat(40)}', 'ot/ope-1', 'config-1', '${"c".repeat(64)}',
        'runtime/v1', '${"d".repeat(64)}', 'stage-executor@1', '[]', 'running',
        'units', 1, 1, '${now}', '${now}'
      );
      INSERT INTO pipeline_instance_stages (
        pipeline_instance_id, stage_id, ordinal, status, attempt_count, created_at, updated_at
      ) VALUES ('instance-1', 'units', 1, 'running', 1, '${now}', '${now}');
      INSERT INTO pipeline_stage_attempts (
        id, pipeline_instance_id, stage_id, attempt_ordinal, reentry_ordinal,
        request_hash, idempotency_key, context_revision, native_context_policy,
        planned_run_id, run_id, status, created_at, updated_at
      ) VALUES (
        'attempt-parent', 'instance-1', 'units', 1, 0, '${"f".repeat(64)}',
        'attempt-key', 0, 'none', 'run-parent', 'run-parent', 'running', '${now}', '${now}'
      );
      INSERT INTO execution_graphs (
        id, pipeline_instance_id, parent_attempt_id, parent_stage_id, parent_run_id,
        graph_digest, plan_digest, created_at, updated_at
      ) VALUES (
        'graph-1', 'instance-1', 'attempt-parent', 'units', 'run-parent',
        'graph-digest', 'plan-digest', '${now}', '${now}'
      );
      INSERT INTO execution_units (
        id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id,
        authored_order, dependency_unit_ids, status, active_work_attempt_id,
        created_at, updated_at
      ) VALUES (
        'unit-1', 'graph-1', 'instance-1', 'attempt-parent', 'a',
        0, '[]', 'running', 'action-1', '${now}', '${now}'
      );
      INSERT INTO execution_work_attempts (
        id, execution_graph_id, execution_unit_id, pipeline_instance_id, parent_attempt_id,
        parent_run_id, unit_id, attempt_ordinal, action_kind, idempotency_key,
        status, payload, created_at, updated_at
      ) VALUES (
        'action-1', 'graph-1', 'unit-1', 'instance-1', 'attempt-parent',
        'run-parent', 'a', 1, 'implement', 'action-key-1',
        'leased', '{}', '${now}', '${now}'
      );
    `);

    applyDatabaseMigrations(db);

    expect(db.prepare(`
      SELECT active_work_attempt_id FROM execution_units
      WHERE id = 'unit-1'
    `).get()).toEqual({ active_work_attempt_id: "action-1" });
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 18").get()).toEqual({
      version: 18,
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("upgrades databases already stamped with the immutable v16 checksum through v17", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    for (const migration of databaseMigrations.filter((candidate) => candidate.version <= 16)) {
      migration.up(db);
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-07-29T00:00:00.000Z')
      `).run(migration.version, migration.name, migration.checksum);
    }
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_gate_receipts'"
    ).get()).toBeUndefined();

    applyDatabaseMigrations(db);

    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_gate_receipts'"
    ).get()).toEqual({ name: "execution_gate_receipts" });
    expect(db.prepare(`
      SELECT name FROM pragma_table_info('execution_graphs') WHERE name = 'stopped_at'
    `).get()).toEqual({ name: "stopped_at" });
    expect(db.prepare(
      "SELECT version, checksum FROM schema_migrations WHERE version = 17"
    ).get()).toEqual({ version: 17, checksum: databaseMigrations[16]!.checksum });
  });

  it("persists execution graph result artifacts after the child reducer migration", () => {
    db = openDb(":memory:");
    const now = "2026-07-29T00:00:00.000Z";
    db.exec(`
      INSERT INTO tickets (
        linear_issue_id, linear_issue_identifier, linear_session_id, branch, agent,
        repo, base_branch, created_at, updated_at
      ) VALUES ('issue-1', 'OPE-1', 'session-1', 'ot/ope-1', 'codex', 'owner/repo', 'main', '${now}', '${now}');
      INSERT INTO agent_sessions (
        id, linear_issue_id, generation, state, created_at, updated_at
      ) VALUES ('session-1', 'issue-1', 1, 'current', '${now}', '${now}');
      INSERT INTO runs (
        id, linear_issue_id, linear_session_id, session_generation, task_type,
        token_hash, status, started_at, expires_at
      ) VALUES (
        'run-parent', 'issue-1', 'session-1', 1, 'implement', 'request-hash',
        'running', '${now}', '2026-07-29T01:00:00.000Z'
      );
      INSERT INTO repository_config_snapshots (
        id, repository, base_commit, blob_sha, digest, normalized_config, created_at
      ) VALUES ('config-1', 'owner/repo', '${"a".repeat(40)}', '${"b".repeat(40)}', '${"c".repeat(64)}', '{}', '${now}');
      INSERT INTO runtime_capability_descriptors (
        runtime_release, digest, protocol, normalized_descriptor, accepted_at
      ) VALUES ('runtime/v1', '${"d".repeat(64)}', 'stage-executor@1', '{}', '${now}');
      INSERT INTO pipeline_catalog_entries (
        pipeline_id, version, digest, normalized_manifest, accepted_at
      ) VALUES ('structured', 1, '${"e".repeat(64)}', '{}', '${now}');
      INSERT INTO pipeline_instances (
        id, linear_issue_id, linear_session_id, generation, pipeline_id, pipeline_version,
        manifest_digest, normalized_manifest, repository, base_commit, branch,
        repository_config_snapshot_id, repository_config_digest, runtime_release, capability_digest,
        executor_protocol, authorized_capabilities, status, active_stage_id, state_version,
        attempt_count, created_at, updated_at
      ) VALUES (
        'instance-1', 'issue-1', 'session-1', 1, 'structured', 1, '${"e".repeat(64)}',
        '{}', 'owner/repo', '${"a".repeat(40)}', 'ot/ope-1', 'config-1', '${"c".repeat(64)}',
        'runtime/v1', '${"d".repeat(64)}', 'stage-executor@1', '[]', 'running',
        'units', 1, 1, '${now}', '${now}'
      );
      INSERT INTO pipeline_instance_stages (
        pipeline_instance_id, stage_id, ordinal, status, attempt_count, created_at, updated_at
      ) VALUES ('instance-1', 'units', 1, 'running', 1, '${now}', '${now}');
      INSERT INTO pipeline_stage_attempts (
        id, pipeline_instance_id, stage_id, attempt_ordinal, reentry_ordinal,
        request_hash, idempotency_key, context_revision, native_context_policy,
        planned_run_id, run_id, status, created_at, updated_at
      ) VALUES (
        'attempt-parent', 'instance-1', 'units', 1, 0, '${"f".repeat(64)}',
        'attempt-key', 0, 'none', 'run-parent', 'run-parent', 'running', '${now}', '${now}'
      );
    `);

    expect(() => db!.prepare(`
      INSERT INTO pipeline_artifacts (
        id, pipeline_instance_id, attempt_id, kind, schema_version,
        assurance, subject, payload, artifact_hash, created_at
      ) VALUES (
        'artifact-graph-result', 'instance-1', 'attempt-parent', 'execution_graph_result',
        1, 'executor_verified', '${"a".repeat(40)}', '{}', '${"b".repeat(64)}', '${now}'
      )
    `).run()).not.toThrow();
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

  it("widens pipeline idle effects without losing queued effect data", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    for (const migration of databaseMigrations.slice(0, 10)) {
      db.prepare(`
        INSERT INTO schema_migrations(version, name, checksum, applied_at)
        VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')
      `).run(migration.version, migration.name, migration.checksum);
    }
    db.exec(`
      CREATE TABLE pipeline_instances (id TEXT PRIMARY KEY);
      INSERT INTO pipeline_instances VALUES ('instance-1');
      CREATE TABLE pipeline_stage_attempts (
        id TEXT PRIMARY KEY,
        pipeline_instance_id TEXT,
        planned_run_id TEXT
      );
      CREATE TABLE pipeline_effect_intents (
        id TEXT PRIMARY KEY,
        pipeline_instance_id TEXT NOT NULL,
        transition_version INTEGER NOT NULL CHECK(transition_version >= 1),
        kind TEXT NOT NULL CHECK(kind IN (
          'provision', 'bootstrap', 'dispatch_stage', 'stop', 'quarantine', 'cleanup',
          'publish_linear', 'publish_github', 'publish_pr'
        )),
        idempotency_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'acknowledged', 'failed', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        acknowledged_at TEXT,
        last_error TEXT,
        FOREIGN KEY(pipeline_instance_id) REFERENCES pipeline_instances(id) ON DELETE RESTRICT,
        UNIQUE(pipeline_instance_id, transition_version, kind, idempotency_key)
      );
      CREATE INDEX pipeline_effects_pending_idx ON pipeline_effect_intents(status, next_attempt_at);
      INSERT INTO pipeline_effect_intents (
        id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, attempts, next_attempt_at, created_at,
        acknowledged_at, last_error
      ) VALUES (
        'dispatch-1', 'instance-1', 1, 'dispatch_stage', 'dispatch-key',
        '{"dispatch":true}', 'hash-1', 'failed', 3, '2026-01-01T00:00:01.000Z',
        '2026-01-01T00:00:00.000Z', NULL, 'retry me'
      );
    `);

    applyDatabaseMigrations(db);

    expect(db.prepare(`
      SELECT id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, attempts, next_attempt_at, created_at,
        acknowledged_at, last_error
      FROM pipeline_effect_intents WHERE id = 'dispatch-1'
    `).get()).toEqual({
      id: "dispatch-1",
      pipeline_instance_id: "instance-1",
      transition_version: 1,
      kind: "dispatch_stage",
      idempotency_key: "dispatch-key",
      payload: "{\"dispatch\":true}",
      payload_hash: "hash-1",
      status: "failed",
      attempts: 3,
      next_attempt_at: "2026-01-01T00:00:01.000Z",
      created_at: "2026-01-01T00:00:00.000Z",
      acknowledged_at: null,
      last_error: "retry me",
    });
    expect(() => db!.prepare(`
      INSERT INTO pipeline_effect_intents (
        id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, next_attempt_at, created_at
      ) VALUES (
        'idle-1', 'instance-1', 2, 'idle', 'idle-key', '{}', 'hash-2',
        'pending', '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'
      )
    `).run()).not.toThrow();
    expect(() => db!.prepare(`
      INSERT INTO pipeline_effect_intents (
        id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, next_attempt_at, created_at
      ) VALUES (
        'invalid-1', 'instance-1', 3, 'invalid', 'invalid-key', '{}', 'hash-3',
        'pending', '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z'
      )
    `).run()).toThrow();
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'pipeline_effect_intents' AND name = 'pipeline_effects_pending_idx'
    `).get()).toEqual({ name: "pipeline_effects_pending_idx" });
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
    expect(db.prepare(`
      SELECT id, actor_state, actor_created_at, actor_updated_at FROM runs ORDER BY id
    `).all()).toEqual([
      {
        id: "legacy-complete",
        actor_state: "settled",
        actor_created_at: "2025-01-01T00:00:00.000Z",
        actor_updated_at: "2025-01-01T00:00:00.000Z",
      },
      {
        id: "legacy-running",
        actor_state: "running",
        actor_created_at: "2026-01-01T00:00:00.000Z",
        actor_updated_at: "2026-01-01T00:00:00.000Z",
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
      CREATE TABLE pipeline_instances (id TEXT PRIMARY KEY);
      CREATE TABLE run_liveness (
        run_id TEXT PRIMARY KEY, actor_state TEXT NOT NULL,
        last_heartbeat_at TEXT, settlement_owner TEXT, settlement_reason TEXT,
        termination_confirmed_at TEXT, quarantine_reason TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE pipeline_stage_attempts (
        id TEXT PRIMARY KEY, pipeline_instance_id TEXT, run_id TEXT, planned_run_id TEXT,
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
        'attempt-bound', NULL, 'run-bound', 'run-bound',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO pipeline_stage_attempts VALUES (
        'attempt-planned', NULL, NULL, 'run-planned',
        '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'
      );
      INSERT INTO pipeline_stage_attempts VALUES (
        'attempt-quarantined', NULL, 'run-quarantined', 'run-quarantined',
        '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'
      );
      INSERT INTO pipeline_stage_attempts VALUES (
        'attempt-settled', NULL, 'run-settled', 'run-settled',
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
    expect(db.prepare(`
      SELECT id, actor_state, last_heartbeat_at, settlement_owner,
        settlement_reason, termination_confirmed_at, quarantine_reason
      FROM pipeline_stage_attempts ORDER BY id
    `).all()).toEqual([
      {
        id: "attempt-bound",
        actor_state: "running",
        last_heartbeat_at: "2026-01-01T00:00:02.000Z",
        settlement_owner: null,
        settlement_reason: null,
        termination_confirmed_at: null,
        quarantine_reason: null,
      },
      {
        id: "attempt-planned",
        actor_state: "reaping",
        last_heartbeat_at: "2026-01-01T00:00:04.000Z",
        settlement_owner: "owner-1",
        settlement_reason: "stalled",
        termination_confirmed_at: null,
        quarantine_reason: null,
      },
      {
        id: "attempt-quarantined",
        actor_state: "quarantined",
        last_heartbeat_at: "2026-01-01T00:00:06.000Z",
        settlement_owner: "owner-2",
        settlement_reason: "stalled",
        termination_confirmed_at: null,
        quarantine_reason: "stop unconfirmed",
      },
      {
        id: "attempt-settled",
        actor_state: "settled",
        last_heartbeat_at: "2026-01-01T00:00:08.000Z",
        settlement_owner: "owner-3",
        settlement_reason: "completed",
        termination_confirmed_at: "2026-01-01T00:00:09.000Z",
        quarantine_reason: null,
      },
    ]);
  });

  it("backfills missing selection publications from the migration ledger", () => {
    db = openDb(":memory:");
    db.prepare("DELETE FROM schema_migrations WHERE version >= 13").run();
    const now = "2026-01-01T00:00:00.000Z";
    const manifest = parsePipelineManifest(readFileSync(
      join(process.cwd(), "src/__fixtures__/pipelines/command-fixture-v1.yaml"),
      "utf8"
    ));
    db.prepare(`
      INSERT INTO tickets (
        linear_issue_id, linear_issue_identifier, linear_session_id, branch, agent,
        repo, state, base_branch, created_at, updated_at
      ) VALUES (
        'issue-selection', 'OPE-SELECT', 'session-selection', 'ot/issue-selection',
        'codex', 'owner/repo', 'active', 'main', ?, ?
      )
    `).run(now, now);
    db.prepare(`
      INSERT INTO agent_sessions (
        id, linear_issue_id, generation, state, provider_conversation_id,
        created_at, updated_at
      ) VALUES (
        'session-selection', 'issue-selection', 1, 'current', NULL, ?, ?
      )
    `).run(now, now);
    db.prepare(`
      INSERT INTO pipeline_catalog_entries (
        pipeline_id, version, digest, normalized_manifest, accepted_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(manifest.manifest.id, manifest.manifest.version, manifest.digest, manifest.normalized, now);
    db.prepare(`
      INSERT INTO runtime_capability_descriptors (
        runtime_release, digest, protocol, normalized_descriptor, accepted_at
      ) VALUES ('runtime-v1', 'capability-digest', 'openthrottle-stage-request/v1', '{"capabilities":[]}', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO repository_config_snapshots (
        id, repository, base_commit, blob_sha, digest, normalized_config, created_at
      ) VALUES ('config-selection', 'owner/repo', ?, 'blob-selection', 'config-digest', '{}', ?)
    `).run("a".repeat(40), now);
    db.prepare(`
      INSERT INTO pipeline_instances (
        id, linear_issue_id, linear_session_id, generation, pipeline_id, pipeline_version,
        manifest_digest, normalized_manifest, repository, base_commit,
        repository_config_snapshot_id, repository_config_digest, runtime_release,
        capability_digest, executor_protocol, authorized_capabilities, status,
        active_stage_id, wait_reason, created_at, updated_at, branch, agent,
        task_type, base_branch
      ) VALUES (
        'instance-selection', 'issue-selection', 'session-selection', 1,
        ?, ?, ?, ?,
        'owner/repo', ?, 'config-selection', 'config-digest', 'runtime-v1',
        'capability-digest', 'openthrottle-stage-request/v1', '[]',
        'dispatchable', NULL, NULL, ?, ?, 'ot/issue-selection', 'codex',
        'implement', 'main'
      )
    `).run(
      manifest.manifest.id,
      manifest.manifest.version,
      manifest.digest,
      manifest.normalized,
      "a".repeat(40),
      now,
      now
    );

    applyDatabaseMigrations(db);

    expect(db.prepare(`
      SELECT kind FROM pipeline_publication_receipts
      WHERE pipeline_instance_id = 'instance-selection'
      ORDER BY kind
    `).all()).toEqual([
      { kind: "github_summary" },
      { kind: "linear_ledger" },
    ]);
  });

  it("contracts satellite table data onto owner rows", () => {
    db = openDb(":memory:");
    db.prepare("DELETE FROM schema_migrations WHERE version >= 14").run();
    const now = "2026-01-01T00:00:00.000Z";
    db.prepare(`
      INSERT INTO tickets (
        linear_issue_id, linear_issue_identifier, linear_session_id, branch, agent,
        repo, state, base_branch, created_at, updated_at
      ) VALUES (
        'issue-contract', 'OPE-CONTRACT', 'session-contract', 'ot/issue-contract',
        'codex', 'owner/repo', 'active', 'main', ?, ?
      )
    `).run(now, now);
    db.prepare(`
      INSERT INTO agent_sessions (
        id, linear_issue_id, generation, state, provider_conversation_id,
        created_at, updated_at, execution_mode, pipeline_instance_id
      ) VALUES (
        'session-contract', 'issue-contract', 1, 'current', NULL, ?, ?,
        NULL, NULL
      )
    `).run(now, now);
    db.prepare(`
      INSERT INTO pipeline_catalog_entries (
        pipeline_id, version, digest, normalized_manifest, accepted_at
      ) VALUES ('fixture/command', 1, ?, '{}', ?)
    `).run("a".repeat(64), now);
    db.prepare(`
      INSERT INTO runtime_capability_descriptors (
        runtime_release, digest, protocol, normalized_descriptor, accepted_at
      ) VALUES ('runtime-v1', 'capability-digest', 'openthrottle-stage-request/v1', '{"capabilities":[]}', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO repository_config_snapshots (
        id, repository, base_commit, blob_sha, digest, normalized_config, created_at
      ) VALUES ('config-contract', 'owner/repo', ?, 'blob-contract', 'config-digest', '{}', ?)
    `).run("a".repeat(40), now);
    db.prepare(`
      INSERT INTO pipeline_instances (
        id, linear_issue_id, linear_session_id, generation, pipeline_id, pipeline_version,
        manifest_digest, normalized_manifest, repository, base_commit,
        repository_config_snapshot_id, repository_config_digest, runtime_release,
        capability_digest, executor_protocol, authorized_capabilities, status,
        active_stage_id, wait_reason, created_at, updated_at, branch, agent,
        task_type, base_branch, runtime_provider, runtime_provider_resource_id,
        runtime_resource_status, runtime_resource_created_at, runtime_resource_updated_at
      ) VALUES (
        'instance-contract', 'issue-contract', 'session-contract', 1,
        'fixture/command', 1, ?, '{}',
        'owner/repo', ?, 'config-contract', 'config-digest', 'runtime-v1',
        'capability-digest', 'openthrottle-stage-request/v1', '[]',
        'dispatchable', NULL, NULL, ?, ?, 'ot/issue-contract', 'codex',
        'implement', 'main', NULL, NULL, NULL, NULL, NULL
      )
    `).run("a".repeat(64), "a".repeat(40), now, now);
    db.prepare(`
      INSERT INTO session_executions (
        linear_session_id, linear_issue_id, generation, execution_mode,
        pipeline_instance_id, pinned_at
      ) VALUES (
        'session-contract', 'issue-contract', 1, 'pipeline', 'instance-contract', ?
      )
    `).run(now);
    db.prepare(`
      INSERT INTO pipeline_runtime_resources (
        pipeline_instance_id, provider, provider_resource_id, status, created_at, updated_at
      ) VALUES ('instance-contract', 'daytona', 'sandbox-contract', 'active', ?, ?)
    `).run(now, now);

    applyDatabaseMigrations(db);

    expect(db.prepare(`
      SELECT execution_mode, pipeline_instance_id FROM agent_sessions WHERE id = 'session-contract'
    `).get()).toEqual({
      execution_mode: "pipeline",
      pipeline_instance_id: "instance-contract",
    });
    expect(db.prepare(`
      SELECT runtime_provider, runtime_provider_resource_id, runtime_resource_status
      FROM pipeline_instances WHERE id = 'instance-contract'
    `).get()).toEqual({
      runtime_provider: "daytona",
      runtime_provider_resource_id: "sandbox-contract",
      runtime_resource_status: "active",
    });
  });

  it("folds the authoritative attempt actor onto runs when run_liveness is stale", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    // Mark everything up to (and excluding) the satellite-table contraction as
    // applied so applyDatabaseMigrations runs only migration 14 against the
    // hand-built pre-contraction fixture below.
    for (const migration of databaseMigrations.slice(0, 13)) {
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
      CREATE TABLE pipeline_instances (id TEXT PRIMARY KEY);
      CREATE TABLE run_liveness (
        run_id TEXT PRIMARY KEY, actor_state TEXT NOT NULL,
        last_heartbeat_at TEXT, settlement_owner TEXT, settlement_reason TEXT,
        termination_confirmed_at TEXT, quarantine_reason TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE pipeline_stage_attempts (
        id TEXT PRIMARY KEY, pipeline_instance_id TEXT, run_id TEXT, planned_run_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE pipeline_attempt_actors (
        attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, actor_state TEXT NOT NULL,
        last_heartbeat_at TEXT, settlement_owner TEXT, settlement_reason TEXT,
        termination_confirmed_at TEXT, quarantine_reason TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );

      -- Two pipeline-backed runs that existed when migration 9 ran and were
      -- later reaped / settled: the run store wrote those transitions to
      -- pipeline_attempt_actors and left run_liveness lagging at 'running'.
      INSERT INTO runs VALUES ('run-reaping', 'reaping', '2026-01-01T00:00:00.000Z', NULL);
      INSERT INTO runs VALUES (
        'run-settled', 'stopped', '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:20.000Z'
      );
      -- A legacy run with no attempt actor: run_liveness is still authoritative.
      INSERT INTO runs VALUES ('run-legacy', 'quarantined', '2026-01-01T00:00:02.000Z', NULL);

      INSERT INTO run_liveness VALUES (
        'run-reaping', 'running', '2026-01-01T00:00:05.000Z', NULL, NULL, NULL, NULL,
        '2026-01-01T00:00:05.000Z'
      );
      INSERT INTO run_liveness VALUES (
        'run-settled', 'running', '2026-01-01T00:00:06.000Z', NULL, NULL, NULL, NULL,
        '2026-01-01T00:00:06.000Z'
      );
      INSERT INTO run_liveness VALUES (
        'run-legacy', 'quarantined', '2026-01-01T00:00:07.000Z', 'legacy-owner',
        'legacy stall', NULL, 'legacy quarantine', '2026-01-01T00:00:08.000Z'
      );

      INSERT INTO pipeline_stage_attempts VALUES (
        'attempt-reaping', NULL, 'run-reaping', 'run-reaping',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO pipeline_stage_attempts VALUES (
        'attempt-settled', NULL, 'run-settled', 'run-settled',
        '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'
      );

      INSERT INTO pipeline_attempt_actors (
        attempt_id, run_id, actor_state, last_heartbeat_at, settlement_owner,
        settlement_reason, termination_confirmed_at, quarantine_reason, created_at, updated_at
      ) VALUES (
        'attempt-reaping', 'run-reaping', 'reaping', '2026-01-01T00:00:12.000Z', 'reaper-1',
        'stalled heartbeat', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:12.000Z'
      );
      INSERT INTO pipeline_attempt_actors (
        attempt_id, run_id, actor_state, last_heartbeat_at, settlement_owner,
        settlement_reason, termination_confirmed_at, quarantine_reason, created_at, updated_at
      ) VALUES (
        'attempt-settled', 'run-settled', 'settled', '2026-01-01T00:00:13.000Z', 'reaper-2',
        'operator stop', '2026-01-01T00:00:14.000Z', NULL,
        '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:14.000Z'
      );
    `);

    applyDatabaseMigrations(db);

    const ownerColumns = `actor_state, last_heartbeat_at, settlement_owner, settlement_reason,
      termination_confirmed_at, quarantine_reason, actor_created_at, actor_updated_at`;
    const runOwner = (runId: string) =>
      db!.prepare(`SELECT ${ownerColumns} FROM runs WHERE id = ?`).get(runId);
    const attemptOwner = (attemptId: string) =>
      db!.prepare(`SELECT ${ownerColumns} FROM pipeline_stage_attempts WHERE id = ?`).get(attemptId);

    // The reaping run folds from the authoritative attempt actor, NOT the stale
    // 'running' run_liveness row, and matches its own attempt owner row exactly.
    const reapingRunOwner = {
      actor_state: "reaping",
      last_heartbeat_at: "2026-01-01T00:00:12.000Z",
      settlement_owner: "reaper-1",
      settlement_reason: "stalled heartbeat",
      termination_confirmed_at: null,
      quarantine_reason: null,
      actor_created_at: "2026-01-01T00:00:00.000Z",
      actor_updated_at: "2026-01-01T00:00:12.000Z",
    };
    expect(runOwner("run-reaping")).toEqual(reapingRunOwner);
    expect(attemptOwner("attempt-reaping")).toEqual(reapingRunOwner);

    // The settled run likewise folds the current settled/terminated state.
    const settledRunOwner = {
      actor_state: "settled",
      last_heartbeat_at: "2026-01-01T00:00:13.000Z",
      settlement_owner: "reaper-2",
      settlement_reason: "operator stop",
      termination_confirmed_at: "2026-01-01T00:00:14.000Z",
      quarantine_reason: null,
      actor_created_at: "2026-01-01T00:00:01.000Z",
      actor_updated_at: "2026-01-01T00:00:14.000Z",
    };
    expect(runOwner("run-settled")).toEqual(settledRunOwner);
    expect(attemptOwner("attempt-settled")).toEqual(settledRunOwner);

    // The legacy run keeps folding from run_liveness (fallback path intact).
    expect(runOwner("run-legacy")).toEqual({
      actor_state: "quarantined",
      last_heartbeat_at: "2026-01-01T00:00:07.000Z",
      settlement_owner: "legacy-owner",
      settlement_reason: "legacy stall",
      termination_confirmed_at: null,
      quarantine_reason: "legacy quarantine",
      actor_created_at: "2026-01-01T00:00:02.000Z",
      actor_updated_at: "2026-01-01T00:00:08.000Z",
    });

    // A conditional finish-reaping settlement update on the folded actor_state
    // now matches, where the stale run_liveness fold would have made it miss.
    const settlement = db.prepare(`
      UPDATE runs
      SET actor_state = 'settled', termination_confirmed_at = ?, actor_updated_at = ?
      WHERE id = ? AND actor_state = 'reaping' AND settlement_owner = ?
    `).run("2026-01-01T00:00:30.000Z", "2026-01-01T00:00:30.000Z", "run-reaping", "reaper-1");
    expect(settlement.changes).toBe(1);
    expect(
      db.prepare("SELECT actor_state FROM runs WHERE id = 'run-reaping'").get()
    ).toEqual({ actor_state: "settled" });
  });
});
