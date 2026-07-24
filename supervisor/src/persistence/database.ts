import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { applyDatabaseMigrations } from "./migrations/runner.js";
import { applyBaseSchema, applyCompatibilityIndexes } from "./schema.js";

export function openDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applyBaseSchema(db);
  applyDatabaseMigrations(db);
  applyCompatibilityIndexes(db);
  return db;
}
