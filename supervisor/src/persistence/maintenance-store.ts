import type Database from "better-sqlite3";

export interface AdmissionMaintenanceState {
  key: "admission";
  paused: 0 | 1;
  epoch: number;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface MaintenanceStore {
  getAdmissionMaintenanceState(): AdmissionMaintenanceState;
  pauseAdmission(reason?: string): AdmissionMaintenanceState;
  resumeAdmission(): AdmissionMaintenanceState;
}

export class AdmissionMaintenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdmissionMaintenanceError";
  }
}

export function admissionMaintenanceError(reason: string): AdmissionMaintenanceError {
  return new AdmissionMaintenanceError(`retryable_infrastructure_failure: ${reason}`);
}

export function createMaintenanceStore(
  db: Database.Database,
  now: () => string = () => new Date().toISOString()
): MaintenanceStore {
  const getStmt = db.prepare("SELECT * FROM supervisor_maintenance WHERE key = 'admission'");
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO supervisor_maintenance (
      key, paused, epoch, reason, created_at, updated_at
    ) VALUES ('admission', 0, 0, NULL, ?, ?)
  `);
  const setPausedStmt = db.prepare(`
    UPDATE supervisor_maintenance
    SET paused = ?, epoch = epoch + 1, reason = ?, updated_at = ?
    WHERE key = 'admission'
  `);

  const ensure = (): AdmissionMaintenanceState => {
    const timestamp = now();
    insertStmt.run(timestamp, timestamp);
    return getStmt.get() as AdmissionMaintenanceState;
  };

  return {
    getAdmissionMaintenanceState() {
      return ensure();
    },
    pauseAdmission(reason) {
      ensure();
      setPausedStmt.run(1, reason ?? null, now());
      return getStmt.get() as AdmissionMaintenanceState;
    },
    resumeAdmission() {
      ensure();
      setPausedStmt.run(0, null, now());
      return getStmt.get() as AdmissionMaintenanceState;
    },
  };
}
