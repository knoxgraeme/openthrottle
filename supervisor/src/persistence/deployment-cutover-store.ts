import type Database from "better-sqlite3";

export type DeploymentCutoverPhase =
  | "registered"
  | "paused"
  | "drain_clear"
  | "staged"
  | "deployed"
  | "verified"
  | "restored"
  | "recovery_required"
  | "resumed";

export interface DeploymentCutover {
  id: string;
  status: "active" | "completed" | "recovery_required";
  old_runtime_release: string;
  old_snapshot: string;
  candidate_snapshot: string;
  pause_epoch: number | null;
  phase: DeploymentCutoverPhase;
  evidence: string;
  recovery_command: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface DeploymentCutoverStore {
  beginDeploymentCutover(input: {
    id?: string;
    oldRuntimeRelease: string;
    oldSnapshot: string;
    candidateSnapshot: string;
    evidence?: string;
  }): DeploymentCutover;
  getOpenDeploymentCutover(): DeploymentCutover | undefined;
  advanceDeploymentCutover(input: {
    id: string;
    phase: DeploymentCutoverPhase;
    evidence?: string;
    pauseEpoch?: number;
    recoveryCommand?: string | null;
    status?: "active" | "completed" | "recovery_required";
  }): DeploymentCutover;
}

function defaultCutoverId(candidateSnapshot: string): string {
  return `snapshot-cutover:${candidateSnapshot}`;
}

export function createDeploymentCutoverStore(
  db: Database.Database,
  now: () => string = () => new Date().toISOString()
): DeploymentCutoverStore {
  const getStmt = db.prepare("SELECT * FROM deployment_cutovers WHERE id = ?");
  const getOpenStmt = db.prepare(`
    SELECT * FROM deployment_cutovers
    WHERE status IN ('active', 'recovery_required')
    ORDER BY created_at, id
    LIMIT 1
  `);
  const insertStmt = db.prepare(`
    INSERT INTO deployment_cutovers (
      id, status, old_runtime_release, old_snapshot, candidate_snapshot,
      pause_epoch, phase, evidence, recovery_command, created_at, updated_at, completed_at
    ) VALUES (?, 'active', ?, ?, ?, NULL, 'registered', ?, NULL, ?, ?, NULL)
  `);
  const updateStmt = db.prepare(`
    UPDATE deployment_cutovers
    SET status = ?, phase = ?, evidence = ?, pause_epoch = COALESCE(?, pause_epoch),
        recovery_command = ?, updated_at = ?, completed_at = ?
    WHERE id = ? AND status IN ('active', 'recovery_required')
  `);

  return {
    beginDeploymentCutover(input) {
      const timestamp = now();
      return db.transaction(() => {
        const open = getOpenStmt.get() as DeploymentCutover | undefined;
        if (open) {
          if (
            (input.id !== undefined && open.id !== input.id) ||
            open.old_runtime_release !== input.oldRuntimeRelease ||
            open.old_snapshot !== input.oldSnapshot ||
            open.candidate_snapshot !== input.candidateSnapshot
          ) {
            throw new Error(
              `deployment cutover ${open.id} is already ${open.status}; retry must adopt that transaction`
            );
          }
          return open;
        }
        const baseId = input.id ?? defaultCutoverId(input.candidateSnapshot);
        let id = baseId;
        if (input.id === undefined) {
          let attempt = 2;
          while (getStmt.get(id)) {
            id = `${baseId}:attempt-${attempt}`;
            attempt += 1;
          }
        } else if (getStmt.get(id)) {
          throw new Error(`deployment cutover ${id} is already completed; use a new transaction id`);
        }
        insertStmt.run(
          id,
          input.oldRuntimeRelease,
          input.oldSnapshot,
          input.candidateSnapshot,
          input.evidence ?? "",
          timestamp,
          timestamp
        );
        return getStmt.get(id) as DeploymentCutover;
      })();
    },
    getOpenDeploymentCutover() {
      return getOpenStmt.get() as DeploymentCutover | undefined;
    },
    advanceDeploymentCutover(input) {
      // The carried-forward fields (evidence, recovery_command, completed_at)
      // are read-modify-write, so the read and update commit as one
      // transaction (immediate, taking the write lock up front) the way
      // beginDeploymentCutover wraps its read-then-insert; a concurrent
      // advance cannot interleave between them and resurrect superseded state.
      return db.transaction(() => {
        const existing = getStmt.get(input.id) as DeploymentCutover | undefined;
        if (!existing) throw new Error(`deployment cutover ${input.id} does not exist`);
        const status = input.status ?? existing.status;
        const completedAt = status === "completed" ? now() : existing.completed_at;
        const recoveryCommand =
          input.recoveryCommand === undefined ? existing.recovery_command : input.recoveryCommand;
        const result = updateStmt.run(
          status,
          input.phase,
          input.evidence ?? existing.evidence,
          input.pauseEpoch ?? null,
          recoveryCommand,
          now(),
          completedAt,
          input.id
        );
        if (result.changes !== 1) {
          throw new Error(`deployment cutover ${input.id} is not open`);
        }
        return getStmt.get(input.id) as DeploymentCutover;
      }).immediate();
    },
  };
}
