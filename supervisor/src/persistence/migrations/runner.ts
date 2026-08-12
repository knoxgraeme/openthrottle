import type Database from "better-sqlite3";
import { databaseMigrations } from "./definitions.js";

export { databaseMigrations } from "./definitions.js";

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
    return applied;
  };
  const applyOrdinary = () => db.transaction(() => {
    const applied = validateLedger();
    for (const migration of databaseMigrations) {
      if (migration.mode === "foreign-keys-off" || applied.some((row) => row.version === migration.version)) continue;
      migration.up(db);
      db.prepare(
        "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)"
      ).run(migration.version, migration.name, migration.checksum, new Date().toISOString());
    }
  }).exclusive();
  applyOrdinary();
  for (const migration of databaseMigrations.filter((entry) => entry.mode === "foreign-keys-off")) {
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
}
