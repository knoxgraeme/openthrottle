import type Database from "better-sqlite3";

export interface SettingsStore {
  acquireSupervisorLease(name: string, owner: string, nowIso: string, leaseUntilIso: string): boolean;
  releaseSupervisorLease(name: string, owner: string): boolean;
  getSetting(key: string): string | undefined;
  listSettings(prefix: string): Array<{ key: string; value: string }>;
  setSetting(key: string, value: string): void;
  setSettings(entries: ReadonlyArray<{ key: string; value: string }>): void;
}

export function createSettingsStore(db: Database.Database): SettingsStore {
  const getSettingStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
  const setSettingStmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const setSettingsTransaction = db.transaction(
    (entries: ReadonlyArray<{ key: string; value: string }>): void => {
      for (const entry of entries) setSettingStmt.run(entry.key, entry.value);
    }
  );
  const acquireSupervisorLeaseTransaction = db.transaction(
    (name: string, owner: string, nowIso: string, leaseUntilIso: string): boolean => {
      const existing = db.prepare(
        "SELECT owner, lease_until FROM supervisor_leases WHERE name = ?"
      ).get(name) as { owner: string; lease_until: string } | undefined;
      if (existing && existing.owner !== owner && existing.lease_until > nowIso) return false;
      db.prepare(`
        INSERT INTO supervisor_leases(name, owner, lease_until, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          owner = excluded.owner,
          lease_until = excluded.lease_until,
          updated_at = excluded.updated_at
      `).run(name, owner, leaseUntilIso, nowIso);
      return true;
    }
  );
  return {
    acquireSupervisorLease(name, owner, nowIso, leaseUntilIso) {
      return acquireSupervisorLeaseTransaction.immediate(name, owner, nowIso, leaseUntilIso);
    },
    releaseSupervisorLease(name, owner) {
      return db.prepare(
        "DELETE FROM supervisor_leases WHERE name = ? AND owner = ?"
      ).run(name, owner).changes === 1;
    },
    getSetting(key) {
      const row = getSettingStmt.get(key) as { value: string } | undefined;
      return row?.value;
    },
    listSettings(prefix) {
      return db.prepare(`
        SELECT key, value FROM settings
        WHERE key >= ? AND key < ?
        ORDER BY key
      `).all(prefix, `${prefix}\uffff`) as Array<{ key: string; value: string }>;
    },
    setSetting(key, value) {
      setSettingStmt.run(key, value);
    },
    setSettings(entries) {
      setSettingsTransaction.immediate(entries);
    },
  };
}
