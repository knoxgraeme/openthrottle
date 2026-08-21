import type Database from "better-sqlite3";
/** Narrow settings-table authority for the centrally rotated Codex token. */
export class SqliteKernelCodexAuthStore {
  readonly #db: Database.Database;
  readonly #now: () => string;

  constructor(input: { db: Database.Database; now?: () => string }) {
    this.#db = input.db;
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  getSetting(key: string): string | undefined {
    const row = this.#db.prepare(`
      SELECT value_json, value_type, mutable FROM settings WHERE key = ?
    `).get(key) as {
      value_json: string;
      value_type: string;
      mutable: number;
    } | undefined;
    if (!row) return undefined;
    if (row.value_type !== "string" || row.mutable !== 1) {
      throw new Error(`kernel credential setting ${key} has invalid ownership`);
    }
    const value: unknown = JSON.parse(row.value_json);
    if (typeof value !== "string") throw new Error(`kernel credential setting ${key} is invalid`);
    return value;
  }

  setSetting(key: string, value: string): void {
    if (typeof value !== "string" || value.length < 1 || value.length > 256 * 1024) {
      throw new Error("kernel credential setting value is invalid");
    }
    const now = this.#now();
    const existing = this.getSetting(key);
    if (existing === value) return;
    if (existing === undefined) {
      this.#db.prepare(`
        INSERT INTO settings (key, value_json, value_type, mutable, version, updated_at)
        VALUES (?, ?, 'string', 1, 0, ?)
      `).run(key, JSON.stringify(value), now);
      return;
    }
    const changed = this.#db.prepare(`
      UPDATE settings SET value_json = ?, version = version + 1, updated_at = ?
      WHERE key = ? AND value_type = 'string' AND mutable = 1
    `).run(JSON.stringify(value), now, key);
    if (changed.changes !== 1) throw new Error(`kernel credential setting ${key} update failed`);
  }
}
