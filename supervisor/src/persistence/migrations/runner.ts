import type Database from "better-sqlite3";
import { databaseMigrations } from "./definitions.js";

export { databaseMigrations } from "./definitions.js";

export const ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX = " [rollback-compatible:additive/v1]";
export const MIGRATION_ROLLBACK_COMPATIBILITY_CONTRACT = "schema-migrations-name-additive-rollback-compatible/v1";

function isMarkedRollbackCompatibleFutureMigration(name: string): boolean {
  return name.endsWith(ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX);
}

export function applyDatabaseMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const validateLedger = () => {
    const applied = db.prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version"
    ).all() as Array<{ version: number; name: string; checksum: string }>;
    const latestKnown = databaseMigrations.at(-1)?.version ?? 0;
    for (const row of applied) {
      const expected = databaseMigrations.find((migration) => migration.version === row.version);
      if (expected) {
        if (row.name !== expected.name || row.checksum !== expected.checksum) {
          throw new Error(`schema migration ${row.version} checksum mismatch`);
        }
        continue;
      }
      if (row.version > latestKnown && isMarkedRollbackCompatibleFutureMigration(row.name)) {
        continue;
      }
      if (row.version > latestKnown) {
        throw new Error(
          `database has incompatible newer schema version ${row.version}; this release supports ${latestKnown}`
        );
      }
      if (!expected) {
        throw new Error(`schema migration ${row.version} checksum mismatch`);
      }
    }
    return applied;
  };
  const initiallyApplied = new Set(validateLedger().map((row) => row.version));
  if (databaseMigrations.every((migration) => initiallyApplied.has(migration.version))) return;
  const applyOrdinaryBatch = (batch: typeof databaseMigrations): void => {
    if (batch.length === 0) return;
    db.transaction(() => {
      const applied = new Set(validateLedger().map((row) => row.version));
      for (const migration of batch) {
        if (applied.has(migration.version)) continue;
        migration.up(db);
        db.prepare(
          "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)"
        ).run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      }
    }).exclusive();
  };
  let ordinaryBatch: typeof databaseMigrations = [];
  for (const migration of databaseMigrations) {
    if (migration.mode !== "foreign-keys-off") {
      ordinaryBatch.push(migration);
      continue;
    }
    applyOrdinaryBatch(ordinaryBatch);
    ordinaryBatch = [];
    if (validateLedger().some((row) => row.version === migration.version)) continue;
    db.pragma("foreign_keys = OFF");
    try {
      db.exec("BEGIN EXCLUSIVE");
      const applied = validateLedger();
      if (!applied.some((row) => row.version === migration.version)) {
        migration.up(db);
        const violations = db.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) throw new Error(`schema migration ${migration.version} violates foreign keys`);
        db.prepare(
          "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)"
        ).run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      db.pragma("foreign_keys = ON");
    }
  }
  applyOrdinaryBatch(ordinaryBatch);
}
