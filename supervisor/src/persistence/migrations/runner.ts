import type Database from "better-sqlite3";
import {
  databaseMigrations,
  ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX,
  ROLLBACK_COMPATIBLE_MIGRATION_REQUIRED_FROM_VERSION,
  type DatabaseMigration,
} from "./definitions.js";

export {
  databaseMigrations,
  MIGRATION_ROLLBACK_COMPATIBILITY_CONTRACT,
  ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX,
} from "./definitions.js";

export interface DatabaseMigrationAuthority {
  migrations: readonly DatabaseMigration[];
  rollbackCompatibleMigrationNameSuffix: string;
}

/**
 * Run the production migration algorithm under an explicit release authority.
 *
 * Keeping the catalog and rollback marker in the authority lets compatibility
 * tests execute the same runtime path with a pinned predecessor catalog instead
 * of maintaining a test-local approximation of the runner.
 */
export function applyDatabaseMigrationsForAuthority(
  db: Database.Database,
  authority: DatabaseMigrationAuthority
): void {
  const { migrations, rollbackCompatibleMigrationNameSuffix } = authority;
  const unmarkedMigration = migrations.find(
    (migration) => migration.version >= ROLLBACK_COMPATIBLE_MIGRATION_REQUIRED_FROM_VERSION &&
      !migration.name.endsWith(rollbackCompatibleMigrationNameSuffix)
  );
  if (unmarkedMigration) {
    throw new Error(
      `database migration ${unmarkedMigration.version} is not rollback-compatible: ` +
      `name must end with ${JSON.stringify(rollbackCompatibleMigrationNameSuffix)}`
    );
  }
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
    const latestKnown = migrations.at(-1)?.version ?? 0;
    let hasFutureMigration = false;
    for (const row of applied) {
      const expected = migrations.find((migration) => migration.version === row.version);
      if (expected) {
        if (row.name !== expected.name || row.checksum !== expected.checksum) {
          throw new Error(`schema migration ${row.version} checksum mismatch`);
        }
        continue;
      }
      if (
        row.version > latestKnown &&
        row.name.endsWith(rollbackCompatibleMigrationNameSuffix)
      ) {
        hasFutureMigration = true;
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
    if (hasFutureMigration) {
      const missing = migrations.find(
        (migration) => !applied.some((row) => row.version === migration.version)
      );
      if (missing) {
        throw new Error(
          `database has rollback-compatible future migrations but is missing known schema migration ${missing.version}`
        );
      }
    }
    return applied;
  };
  const initiallyApplied = new Set(validateLedger().map((row) => row.version));
  if (migrations.every((migration) => initiallyApplied.has(migration.version))) return;
  const applyOrdinaryBatch = (batch: readonly DatabaseMigration[]): void => {
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
  let ordinaryBatch: DatabaseMigration[] = [];
  for (const migration of migrations) {
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

export function applyDatabaseMigrations(db: Database.Database): void {
  applyDatabaseMigrationsForAuthority(db, {
    migrations: databaseMigrations,
    rollbackCompatibleMigrationNameSuffix: ROLLBACK_COMPATIBLE_MIGRATION_NAME_SUFFIX,
  });
}
