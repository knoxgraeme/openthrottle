import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../database.js";
import { createDeliveryStore } from "../delivery-store.js";
import {
  assertRollbackPair,
  exportRehydratableConfiguration,
  importRehydratableConfiguration,
  type SchemaEpochBackupManifest,
} from "../schema-epoch.js";
import {
  applyDatabaseMigrations,
  assertDatabaseEpoch,
  databaseMigrations,
  SCHEMA_EPOCH,
} from "./runner.js";

const removedTables = [
  "session_inbox",
  "work_items",
  "work_deliveries",
  "run_stage_bindings",
  "pipeline_work_bindings",
];

const backup: SchemaEpochBackupManifest = {
  application_sha: "b95b1a2805899fac7ade8d1ab3d63b8e5e02246d",
  sqlite_sha256: "a".repeat(64),
  wal_sha256: "b".repeat(64),
  sealed_at: "2026-08-20T00:00:00.000Z",
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("schema epoch 1 baseline", () => {
  it("bootstraps one checksum-pinned baseline and audits the final schema", () => {
    const db = openDb(":memory:", "new-application-sha");
    try {
      expect(databaseMigrations).toHaveLength(1);
      expect(databaseMigrations[0]).toMatchObject({
        version: 1,
        name: "schema-epoch-1-baseline",
      });
      expect(databaseMigrations[0]!.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(db.prepare(
        "SELECT version, name, checksum FROM schema_migrations"
      ).all()).toEqual([{
        version: 1,
        name: "schema-epoch-1-baseline",
        checksum: databaseMigrations[0]!.checksum,
      }]);
      expect(assertDatabaseEpoch(db, SCHEMA_EPOCH)).toMatchObject({
        schema_epoch: 1,
        baseline_checksum: databaseMigrations[0]!.checksum,
        application_sha: "new-application-sha",
        first_write_at: null,
      });

      const tables = new Set(
        (db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).all() as Array<{ name: string }>).map((row) => row.name)
      );
      for (const expected of [
        "schema_authority",
        "schema_migrations",
        "tickets",
        "runs",
        "steering_items",
        "pipeline_instances",
        "execution_graphs",
        "execution_units",
        "execution_work_attempts",
      ]) {
        expect(tables.has(expected), `missing baseline table ${expected}`).toBe(true);
      }
      for (const removed of removedTables) {
        expect(tables.has(removed), `retired table ${removed} survived baseline`).toBe(false);
      }
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");

      applyDatabaseMigrations(db, "different-new-build-sha");
      expect(db.prepare("SELECT COUNT(*) FROM schema_migrations").pluck().get()).toBe(1);
    } finally {
      db.close();
    }
  });

  it("never applies the baseline to an old or partially initialized database", () => {
    for (const sql of [
      "CREATE TABLE tickets(id TEXT PRIMARY KEY)",
      "CREATE TABLE schema_authority(singleton INTEGER PRIMARY KEY)",
      `CREATE TABLE schema_migrations (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         checksum TEXT NOT NULL,
         applied_at TEXT NOT NULL
       )`,
    ]) {
      const db = new Database(":memory:");
      try {
        db.exec(sql);
        expect(() => applyDatabaseMigrations(db, "new-build")).toThrow(
          /refusing schema epoch 1 baseline against a non-empty database|schema_authority is malformed/
        );
        const authorityTable = db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_authority'"
        ).get();
        if (sql.includes("CREATE TABLE schema_authority")) {
          expect(authorityTable).toEqual({ name: "schema_authority" });
        } else {
          expect(authorityTable).toBeUndefined();
        }
      } finally {
        db.close();
      }
    }
  });

  it("rejects tampered authority and migration ledgers on reopen", () => {
    const db = openDb(":memory:", "new-build");
    try {
      db.prepare("UPDATE schema_migrations SET checksum = 'tampered'").run();
      expect(() => applyDatabaseMigrations(db, "new-build")).toThrow(
        /baseline checksum mismatch/
      );
      db.prepare("UPDATE schema_migrations SET checksum = ?").run(
        databaseMigrations[0]!.checksum
      );
      db.prepare("UPDATE schema_authority SET baseline_checksum = 'tampered'").run();
      expect(() => applyDatabaseMigrations(db, "new-build")).toThrow(
        /baseline checksum mismatch/
      );
    } finally {
      db.close();
    }
  });
});

describe("schema epoch cutover authority", () => {
  it("rejects stale pre-reset webhook and runtime events", () => {
    const db = openDb(":memory:", "new-build");
    try {
      const deliveries = createDeliveryStore(db);
      expect(() => deliveries.claimDelivery({
        deliveryId: "old-webhook",
        source: "github",
        action: "issues:labeled",
        schemaEpoch: 0,
      })).toThrow(/stale inbound event schema epoch 0/);
      expect(() => deliveries.insertSandboxEvent({
        eventId: "old-runtime-event",
        runId: "old-run",
        sandboxId: "old-sandbox",
        kind: "heartbeat",
        payload: "{}",
        schemaEpoch: 0,
      })).toThrow(/stale inbound event schema epoch 0/);
      expect(db.prepare("SELECT COUNT(*) FROM webhook_deliveries").pluck().get()).toBe(0);
      expect(db.prepare("SELECT COUNT(*) FROM sandbox_events").pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rehydrates only inventoried operator settings and repository registrations", () => {
    const oldDb = new Database(":memory:");
    const newDb = openDb(":memory:", "new-build");
    try {
      oldDb.exec(`
        CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
        CREATE TABLE repository_registrations (
          github_repo TEXT PRIMARY KEY,
          control_provider TEXT NOT NULL,
          linear_team_key TEXT,
          linear_team_id TEXT,
          base_branch TEXT NOT NULL,
          webhook_id INTEGER NOT NULL,
          snapshot TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE runs(id TEXT PRIMARY KEY);
        INSERT INTO settings VALUES
          ('linear_access_token', 'operator-token', NULL),
          ('github-head:linear:issue-1', 'historical-head', NULL);
        INSERT INTO repository_registrations VALUES (
          'owner/repo', 'linear', 'OT', 'team-1', 'main', 42, '{}',
          '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z'
        );
        INSERT INTO runs VALUES ('historical-run');
      `);
      const artifact = exportRehydratableConfiguration(oldDb, backup);
      expect(artifact.settings).toEqual([
        { key: "linear_access_token", value: "operator-token" },
      ]);
      expect(JSON.stringify(artifact)).not.toContain("historical-run");
      expect(JSON.stringify(artifact)).not.toContain("historical-head");
      expect(() => exportRehydratableConfiguration(newDb, backup)).toThrow(
        /incompatible with code schema epoch 0/
      );

      importRehydratableConfiguration(
        newDb,
        artifact,
        "2026-08-20T01:00:00.000Z"
      );
      expect(newDb.prepare("SELECT key, value FROM settings").all()).toEqual([
        { key: "linear_access_token", value: "operator-token" },
      ]);
      expect(newDb.prepare(
        "SELECT github_repo, control_provider, linear_team_key FROM repository_registrations"
      ).all()).toEqual([{
        github_repo: "owner/repo",
        control_provider: "linear",
        linear_team_key: "OT",
      }]);
      expect(newDb.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(0);
      expect(newDb.prepare(
        "SELECT first_write_at FROM schema_authority WHERE singleton = 1"
      ).get()).toEqual({ first_write_at: "2026-08-20T01:00:00.000Z" });
      expect(() => importRehydratableConfiguration(newDb, artifact)).toThrow(
        /requires a fresh epoch-1 database/
      );

      const withHistoricalSetting = {
        ...artifact,
        settings: [...artifact.settings, { key: "github-head:issue", value: "sha" }],
      };
      const emptyDb = openDb(":memory:", "new-build");
      try {
        expect(() => importRehydratableConfiguration(emptyDb, withHistoricalSetting))
          .toThrow(/not in the operator rehydration inventory/);
      } finally {
        emptyDb.close();
      }
    } finally {
      oldDb.close();
      newDb.close();
    }
  });

  it("pairs rollback builds with their exact backups and forbids mixed epochs", () => {
    assertRollbackPair({
      backup,
      backupSchemaEpoch: 0,
      buildApplicationSha: backup.application_sha,
      buildSchemaEpoch: 0,
      newEpochHasWrites: false,
    });
    expect(() => assertRollbackPair({
      backup,
      backupSchemaEpoch: 0,
      buildApplicationSha: "different-old-build",
      buildSchemaEpoch: 0,
      newEpochHasWrites: false,
    })).toThrow(/build SHA does not match/);
    expect(() => assertRollbackPair({
      backup,
      backupSchemaEpoch: 0,
      buildApplicationSha: backup.application_sha,
      buildSchemaEpoch: 1,
      newEpochHasWrites: false,
    })).toThrow(/schema epochs must match/);
    expect(() => assertRollbackPair({
      backup,
      backupSchemaEpoch: 0,
      buildApplicationSha: backup.application_sha,
      buildSchemaEpoch: 0,
      newEpochHasWrites: true,
    })).toThrow(/forbidden after the first schema epoch 1 write/);

    const directory = mkdtempSync(join(tmpdir(), "openthrottle-epoch-rollback-"));
    temporaryDirectories.push(directory);
    const oldPath = join(directory, "old-backup.db");
    const oldBuild = new Database(oldPath);
    oldBuild.exec("CREATE TABLE old_runtime_state(id TEXT PRIMARY KEY)");
    oldBuild.close();

    const matchingOldBuild = new Database(oldPath, { readonly: true });
    try {
      expect(assertDatabaseEpoch(matchingOldBuild, 0)).toBeUndefined();
      expect(() => assertDatabaseEpoch(matchingOldBuild, 1)).toThrow(
        /no schema epoch authority/
      );
    } finally {
      matchingOldBuild.close();
    }

    const newDb = openDb(":memory:", "new-build");
    try {
      expect(assertDatabaseEpoch(newDb, 1)?.schema_epoch).toBe(1);
      expect(() => assertDatabaseEpoch(newDb, 0)).toThrow(
        /incompatible with code schema epoch 0/
      );
    } finally {
      newDb.close();
    }
  });
});
