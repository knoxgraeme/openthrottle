import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { applyDatabaseMigrations } from "./migrations/runner.js";

export function openDb(path: string, applicationSha?: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    applyDatabaseMigrations(db, applicationSha);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
