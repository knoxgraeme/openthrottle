import type Database from "better-sqlite3";
import {
  databaseMigrations,
  SCHEMA_BASELINE_NAME,
  type DatabaseMigration,
} from "./definitions.js";
import { SCHEMA_EPOCH } from "../schema.js";

export {
  databaseMigrations,
  SCHEMA_BASELINE_NAME,
  SCHEMA_EPOCH_CONTRACT,
} from "./definitions.js";
export { SCHEMA_EPOCH } from "../schema.js";

export interface SchemaAuthority {
  schema_epoch: number;
  baseline_checksum: string;
  application_sha: string;
  first_write_at: string | null;
  created_at: string;
}

export interface DatabaseMigrationAuthority {
  migrations: readonly DatabaseMigration[];
  schemaEpoch: number;
}

function userSchemaObjects(db: Database.Database): string[] {
  return (db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>).map((row) => row.name);
}

function readSchemaAuthority(db: Database.Database): SchemaAuthority | undefined {
  const authorityTable = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_authority'"
  ).get();
  if (!authorityTable) return undefined;
  const columns = new Set(
    (db.prepare("PRAGMA table_info(schema_authority)").all() as Array<{ name: string }>)
      .map((column) => column.name)
  );
  for (const required of [
    "singleton",
    "schema_epoch",
    "baseline_checksum",
    "application_sha",
    "first_write_at",
    "created_at",
  ]) {
    if (!columns.has(required)) {
      throw new Error("database schema_authority is malformed; refusing code/database mix");
    }
  }
  return db.prepare(`
    SELECT schema_epoch, baseline_checksum, application_sha, first_write_at, created_at
    FROM schema_authority
    WHERE singleton = 1
  `).get() as SchemaAuthority | undefined;
}

function validateApplicationSha(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new Error("application SHA must be a non-empty value of at most 200 characters");
  }
  return normalized;
}

export function currentApplicationSha(): string {
  return validateApplicationSha(
    process.env.OT_APPLICATION_SHA ??
      process.env.FLY_IMAGE_REF ??
      "development"
  );
}

export function assertDatabaseEpoch(
  db: Database.Database,
  expectedEpoch: number
): SchemaAuthority | undefined {
  const authority = readSchemaAuthority(db);
  if (expectedEpoch === 0 && !authority) return undefined;
  if (!authority) {
    throw new Error(
      `database has no schema epoch authority; refusing schema epoch ${expectedEpoch} code/database mix`
    );
  }
  if (authority.schema_epoch !== expectedEpoch) {
    throw new Error(
      `database schema epoch ${authority.schema_epoch} is incompatible with code schema epoch ${expectedEpoch}`
    );
  }
  return authority;
}

export function applyDatabaseMigrationsForAuthority(
  db: Database.Database,
  authority: DatabaseMigrationAuthority,
  applicationSha = currentApplicationSha()
): void {
  const migrations = authority.migrations;
  if (
    authority.schemaEpoch !== SCHEMA_EPOCH ||
    migrations.length !== 1 ||
    migrations[0]?.version !== SCHEMA_EPOCH ||
    migrations[0]?.name !== SCHEMA_BASELINE_NAME
  ) {
    throw new Error("schema epoch 1 requires exactly its pinned baseline");
  }
  const baseline = migrations[0];
  const existing = readSchemaAuthority(db);
  if (existing) {
    assertDatabaseEpoch(db, authority.schemaEpoch);
    const ledger = db.prepare(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version"
    ).all() as Array<{ version: number; name: string; checksum: string }>;
    if (
      ledger.length !== 1 ||
      ledger[0]?.version !== baseline.version ||
      ledger[0]?.name !== baseline.name ||
      ledger[0]?.checksum !== baseline.checksum ||
      existing.baseline_checksum !== baseline.checksum
    ) {
      throw new Error("schema epoch 1 baseline checksum mismatch");
    }
    return;
  }

  const objects = userSchemaObjects(db);
  if (objects.length > 0) {
    throw new Error(
      `refusing schema epoch 1 baseline against a non-empty database: ${objects.slice(0, 5).join(", ")}`
    );
  }

  const timestamp = new Date().toISOString();
  const sha = validateApplicationSha(applicationSha);
  db.transaction(() => {
    baseline.up(db);
    db.prepare(`
      INSERT INTO schema_migrations(version, name, checksum, applied_at)
      VALUES (?, ?, ?, ?)
    `).run(baseline.version, baseline.name, baseline.checksum, timestamp);
    db.prepare(`
      INSERT INTO schema_authority(
        singleton, schema_epoch, baseline_checksum, application_sha, created_at
      ) VALUES (1, ?, ?, ?, ?)
    `).run(authority.schemaEpoch, baseline.checksum, sha, timestamp);
  }).exclusive();
}

export function applyDatabaseMigrations(
  db: Database.Database,
  applicationSha = currentApplicationSha()
): void {
  applyDatabaseMigrationsForAuthority(
    db,
    { migrations: databaseMigrations, schemaEpoch: SCHEMA_EPOCH },
    applicationSha
  );
}
