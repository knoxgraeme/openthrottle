import type Database from "better-sqlite3";
import type { TaskType } from "../pipeline/types.js";
import type { FaultAttribution } from "../pipeline/fault-attribution.js";
import type { WorkStore } from "./work-store.js";
import type { DirectFinishRunParams, FinishRunParams, Run, Ticket } from "./store.js";

export interface RunStore {
  listRunning(): Ticket[];
  beginRun(params: {
    issueId: string;
    runId: string;
    taskType: TaskType;
    tokenHash: string;
    expiresAt: string;
  }): boolean;
  getRun(runId: string): Run | undefined;
  getLatestRunWithLog(issueId: string): Run | undefined;
  finishRun(params: DirectFinishRunParams): Run | undefined;
  finishRunAndThen<T>(params: DirectFinishRunParams, after: () => T): T;
  claimRunForReaping(
    runId: string,
    owner: string,
    reason: string,
    faultAttribution: FaultAttribution | null
  ): Run | undefined;
  finishReapingRun(params: FinishRunParams & { owner: string }): Run | undefined;
  finishReapingRunAndThen(
    params: FinishRunParams & { owner: string },
    after: (run: Run) => void
  ): Run | undefined;
  quarantineRun(runId: string, owner: string, reason: string): Run | undefined;
  settleQuarantinedRun(params: FinishRunParams): Run | undefined;
  renewRunLiveness(runId: string, heartbeatAt: string): boolean;
  listExpiredRuns(nowIso: string): Run[];
  listStalledRuns(cutoffIso: string): Run[];
}

export function createRunStore(db: Database.Database, workStore: WorkStore): RunStore {
  const now = () => new Date().toISOString();
  const ticketFailureTail = (params: FinishRunParams): string | null =>
    params.ticketFailureTail === undefined
      ? params.failureTail ?? null
      : params.ticketFailureTail;
  const getByIssueIdStmt = db.prepare("SELECT * FROM tickets WHERE ticket_id = ?");
  const getCurrentSessionStmt = db.prepare(
    "SELECT * FROM agent_sessions WHERE ticket_id = ? AND state = 'current'"
  );
  const getRunStmt = db.prepare("SELECT * FROM runs WHERE id = ?");
  const getAttemptActorStmt = db.prepare("SELECT * FROM pipeline_stage_attempts WHERE run_id = ? OR planned_run_id = ? ORDER BY CASE WHEN run_id = ? THEN 0 ELSE 1 END LIMIT 1");
  const getLatestRunWithLogStmt = db.prepare(
    `SELECT * FROM runs
     WHERE ticket_id = ? AND log_tail IS NOT NULL
     ORDER BY started_at DESC, rowid DESC LIMIT 1`
  );
  const listRunningStmt = db.prepare(`
    SELECT t.* FROM tickets t
    JOIN runs r ON r.id = t.run_id
    WHERE t.run_id IS NOT NULL AND t.running_since IS NOT NULL AND r.status = 'running'
    ORDER BY t.running_since
  `);
  const listExpiredRunsStmt = db.prepare(
    "SELECT * FROM runs WHERE status = 'running' AND expires_at <= ? ORDER BY expires_at"
  );
  const listStalledRunsStmt = db.prepare(`
    SELECT r.* FROM runs r
    LEFT JOIN pipeline_stage_attempts a
      ON a.run_id = r.id OR (a.run_id IS NULL AND a.planned_run_id = r.id)
    WHERE r.status = 'running'
      AND COALESCE(a.actor_state, r.actor_state) = 'running'
      AND COALESCE(a.last_heartbeat_at, r.last_heartbeat_at, r.started_at) <= ?
    ORDER BY started_at
  `);
  const ownedReapingActorPredicate = `
    EXISTS (
      SELECT 1 FROM pipeline_stage_attempts a
      WHERE (a.run_id = runs.id OR (a.run_id IS NULL AND a.planned_run_id = runs.id))
        AND a.actor_state = 'reaping'
        AND a.settlement_owner = ?
    )
    OR (runs.actor_state = 'reaping' AND runs.settlement_owner = ?)
  `;
  const beginAttemptActorStmt = db.prepare(`
    UPDATE pipeline_stage_attempts
    SET actor_state = 'running',
        actor_created_at = COALESCE(actor_created_at, ?),
        actor_updated_at = ?
    WHERE planned_run_id = ?
  `);
  const settleRunningAttemptActorStmt = db.prepare(`
    UPDATE pipeline_stage_attempts
    SET actor_state = 'settled', settlement_reason = ?, actor_updated_at = ?
    WHERE (run_id = ? OR (run_id IS NULL AND planned_run_id = ?)) AND actor_state = 'running'
  `);
  const claimAttemptActorForReapingStmt = db.prepare(`
    UPDATE pipeline_stage_attempts
    SET actor_state = 'reaping', settlement_owner = ?, settlement_reason = ?, actor_updated_at = ?
    WHERE (run_id = ? OR (run_id IS NULL AND planned_run_id = ?)) AND actor_state = 'running'
  `);
  const finishReapingAttemptActorStmt = db.prepare(`
    UPDATE pipeline_stage_attempts
    SET actor_state = 'settled', termination_confirmed_at = ?, actor_updated_at = ?
    WHERE (run_id = ? OR (run_id IS NULL AND planned_run_id = ?))
      AND actor_state = 'reaping' AND settlement_owner = ?
  `);
  const quarantineAttemptActorStmt = db.prepare(`
    UPDATE pipeline_stage_attempts
    SET actor_state = 'quarantined', quarantine_reason = ?, actor_updated_at = ?
    WHERE (run_id = ? OR (run_id IS NULL AND planned_run_id = ?)) AND settlement_owner = ?
  `);
  const settleQuarantinedAttemptActorStmt = db.prepare(`
    UPDATE pipeline_stage_attempts SET actor_state = 'settled', termination_confirmed_at = ?, actor_updated_at = ?
    WHERE (run_id = ? OR (run_id IS NULL AND planned_run_id = ?)) AND actor_state = 'quarantined'
  `);
  const renewAttemptActorStmt = db.prepare(`
    UPDATE pipeline_stage_attempts
    SET last_heartbeat_at = CASE
          WHEN last_heartbeat_at IS NULL OR last_heartbeat_at < ? THEN ?
          ELSE last_heartbeat_at
        END,
        actor_updated_at = ?
    WHERE (run_id = ? OR (run_id IS NULL AND planned_run_id = ?)) AND actor_state = 'running'
  `);
  const beginRunTransaction = db.transaction(
    (params: {
      issueId: string;
      runId: string;
      taskType: TaskType;
      tokenHash: string;
      expiresAt: string;
    }): boolean => {
      const startedAt = now();
      const ticket = getByIssueIdStmt.get(params.issueId) as Ticket | undefined;
      const currentSession = getCurrentSessionStmt.get(params.issueId) as
        | { id: string; generation: number }
        | undefined;
      const update = db.prepare(`
        UPDATE tickets
        SET running_since = ?, run_id = ?, state = 'active', last_error = NULL, updated_at = ?
        WHERE ticket_id = ? AND running_since IS NULL
          AND state NOT IN ('stopped', 'closed', 'expired')
      `).run(startedAt, params.runId, startedAt, params.issueId);
      if (update.changes !== 1) return false;
      db.prepare(`
        INSERT INTO runs (
          id, ticket_id, session_id, session_generation,
          task_type, token_hash, status, started_at, expires_at,
          actor_state, actor_created_at, actor_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, 'running', ?, ?)
      `).run(
        params.runId,
        params.issueId,
        currentSession?.id ?? ticket?.session_id ?? null,
        currentSession?.generation ?? null,
        params.taskType,
        params.tokenHash,
        startedAt,
        params.expiresAt,
        startedAt,
        startedAt
      );
      beginAttemptActorStmt.run(startedAt, startedAt, params.runId);
      return true;
    }
  );
  const finishRunTransaction = db.transaction((params: DirectFinishRunParams): Run | undefined => {
    const existing = getRunStmt.get(params.runId) as Run | undefined;
    if (!existing || existing.status !== "running") return undefined;
    const completedAt = now();
    db.prepare(`
      UPDATE runs SET
        status = ?, completed_at = ?, exit_code = ?, cost_usd = ?, pr_url = ?, failure_tail = ?, log_tail = ?
      WHERE id = ? AND status = 'running'
    `).run(
      params.status,
      completedAt,
      params.exitCode ?? null,
      params.costUsd ?? null,
      params.prUrl ?? null,
      params.failureTail ?? null,
      params.logTail ?? null,
      params.runId
    );
    if (params.logTail !== undefined) {
      db.prepare(`
        UPDATE runs SET log_tail = NULL
        WHERE ticket_id = ? AND id <> ? AND log_tail IS NOT NULL
      `).run(existing.ticket_id, params.runId);
    }
    db.prepare(`
      UPDATE tickets SET
        running_since = NULL,
        run_id = NULL,
        state = COALESCE(?, state),
        pr_url = COALESCE(?, pr_url),
        total_cost_usd = total_cost_usd + COALESCE(?, 0),
        last_error = ?,
        updated_at = ?
      WHERE ticket_id = ? AND run_id = ?
    `).run(
      params.ticketState ?? null,
      params.prUrl ?? null,
      params.costUsd ?? null,
      ticketFailureTail(params),
      completedAt,
      existing.ticket_id,
      params.runId
    );
    settleRunningAttemptActorStmt.run(params.status, completedAt, params.runId, params.runId);
    db.prepare(`
      UPDATE runs
      SET actor_state = 'settled', settlement_reason = ?, fault_attribution = ?, actor_updated_at = ?
      WHERE id = ? AND actor_state = 'running'
    `).run(params.status, params.faultAttribution ?? null, completedAt, params.runId);
    workStore.consumeAcknowledgedForRun(params.runId, params.runId);
    workStore.releaseUnacknowledgedForRun(
      params.runId,
      `owning run ${params.runId} ended before acknowledgement`
    );
    return getRunStmt.get(params.runId) as Run;
  });
  const claimRunForReapingTransaction = db.transaction(
    (runId: string, owner: string, reason: string, faultAttribution: FaultAttribution | null): Run | undefined => {
      const timestamp = now();
      const existing = getRunStmt.get(runId) as Run | undefined;
      if (existing?.status === "reaping") {
        const actor = getAttemptActorStmt.get(runId, runId, runId) as { settlement_owner: string | null } | undefined;
        if (actor) return actor.settlement_owner === owner ? existing : undefined;
        return existing.settlement_owner === owner ? existing : undefined;
      }
      const update = db.prepare(
        "UPDATE runs SET status = 'reaping' WHERE id = ? AND status = 'running'"
      ).run(runId);
      if (update.changes !== 1) return undefined;
      claimAttemptActorForReapingStmt.run(owner, reason, timestamp, runId, runId);
      const liveness = db.prepare(`
        UPDATE runs
        SET actor_state = 'reaping', settlement_owner = ?, settlement_reason = ?, fault_attribution = ?, actor_updated_at = ?
        WHERE id = ? AND actor_state = 'running'
      `).run(owner, reason, faultAttribution, timestamp, runId);
      if (liveness.changes !== 1) throw new Error(`run ${runId} has inconsistent actor state`);
      return getRunStmt.get(runId) as Run;
    }
  );
  const finishReapingRunTransaction = db.transaction(
    (params: FinishRunParams & { owner: string }): Run | undefined => {
      const existing = getRunStmt.get(params.runId) as Run | undefined;
      if (!existing || existing.status !== "reaping") return undefined;
      const completedAt = now();
      const update = db.prepare(`
        UPDATE runs SET
          status = ?, completed_at = ?, exit_code = ?, cost_usd = ?,
          pr_url = ?, failure_tail = ?, log_tail = ?
        WHERE id = ? AND status = 'reaping'
          AND (${ownedReapingActorPredicate})
      `).run(
        params.status,
        completedAt,
        params.exitCode ?? null,
        params.costUsd ?? null,
        params.prUrl ?? null,
        params.failureTail ?? null,
        params.logTail ?? null,
        params.runId,
        params.owner,
        params.owner
      );
      if (update.changes !== 1) return undefined;
      const ticket = getByIssueIdStmt.get(existing.ticket_id) as Ticket | undefined;
      if (existing.session_id && ticket?.session_id !== existing.session_id) {
        db.prepare(`
          UPDATE tickets SET running_since = NULL, run_id = NULL, updated_at = ?
          WHERE ticket_id = ? AND run_id = ?
        `).run(completedAt, existing.ticket_id, params.runId);
      } else {
        db.prepare(`
          UPDATE tickets SET
            running_since = NULL, run_id = NULL,
            state = COALESCE(?, state), pr_url = COALESCE(?, pr_url),
            total_cost_usd = total_cost_usd + COALESCE(?, 0),
            last_error = ?, updated_at = ?
          WHERE ticket_id = ? AND run_id = ?
        `).run(
          params.ticketState ?? null,
          params.prUrl ?? null,
          params.costUsd ?? null,
          ticketFailureTail(params),
          completedAt,
          existing.ticket_id,
          params.runId
        );
      }
      finishReapingAttemptActorStmt.run(completedAt, completedAt, params.runId, params.runId, params.owner);
      db.prepare(`
        UPDATE runs
        SET actor_state = 'settled', termination_confirmed_at = ?, actor_updated_at = ?
        WHERE id = ? AND actor_state = 'reaping' AND settlement_owner = ?
      `).run(completedAt, completedAt, params.runId, params.owner);
      workStore.consumeAcknowledgedForRun(params.runId, params.runId);
      workStore.releaseUnacknowledgedForRun(
        params.runId,
        `owning run ${params.runId} ended before acknowledgement`
      );
      return getRunStmt.get(params.runId) as Run;
    }
  );
  const quarantineRunTransaction = db.transaction(
    (runId: string, owner: string, reason: string): Run | undefined => {
      const timestamp = now();
      const existing = getRunStmt.get(runId) as Run | undefined;
      if (existing?.status === "quarantined") {
        const actor = getAttemptActorStmt.get(runId, runId, runId) as { settlement_owner: string | null } | undefined;
        if (actor) return actor.settlement_owner === owner ? existing : undefined;
        return existing.settlement_owner === owner ? existing : undefined;
      }
      const update = db.prepare(`
        UPDATE runs SET status = 'quarantined', failure_tail = ?
        WHERE id = ? AND status = 'reaping'
          AND (${ownedReapingActorPredicate})
      `).run(reason, runId, owner, owner);
      if (update.changes !== 1) return undefined;
      quarantineAttemptActorStmt.run(reason, timestamp, runId, runId, owner);
      db.prepare(`
        UPDATE runs
        SET actor_state = 'quarantined', quarantine_reason = ?, actor_updated_at = ?
        WHERE id = ? AND settlement_owner = ?
      `).run(reason, timestamp, runId, owner);
      const run = getRunStmt.get(runId) as Run;
      const ticket = getByIssueIdStmt.get(run.ticket_id) as Ticket | undefined;
      if (!run.session_id || ticket?.session_id === run.session_id) {
        db.prepare(`
          UPDATE tickets SET state = 'error', last_error = ?, updated_at = ?
          WHERE ticket_id = ? AND run_id = ?
        `).run(reason, timestamp, run.ticket_id, runId);
      }
      return run;
    }
  );
  const settleQuarantinedRunTransaction = db.transaction((params: FinishRunParams): Run | undefined => {
    const existing = getRunStmt.get(params.runId) as Run | undefined;
    if (!existing || existing.status !== "quarantined") return undefined;
    const completedAt = now();
    db.prepare(`
      UPDATE runs SET status = ?, completed_at = ?, failure_tail = ?, pr_url = COALESCE(?, pr_url)
      WHERE id = ? AND status = 'quarantined'
    `).run(params.status, completedAt, params.failureTail ?? null, params.prUrl ?? null, params.runId);
    const ticket = getByIssueIdStmt.get(existing.ticket_id) as Ticket | undefined;
    if (existing.session_id && ticket?.session_id !== existing.session_id) {
      db.prepare(`
        UPDATE tickets SET running_since = NULL, run_id = NULL, updated_at = ?
        WHERE ticket_id = ? AND run_id = ?
      `).run(completedAt, existing.ticket_id, params.runId);
    } else {
      db.prepare(`
        UPDATE tickets SET running_since = NULL, run_id = NULL,
          state = COALESCE(?, state), pr_url = COALESCE(?, pr_url),
          last_error = ?, updated_at = ?
        WHERE ticket_id = ? AND run_id = ?
      `).run(
        params.ticketState ?? null,
        params.prUrl ?? null,
        ticketFailureTail(params),
        completedAt,
        existing.ticket_id,
        params.runId
      );
    }
    settleQuarantinedAttemptActorStmt.run(completedAt, completedAt, params.runId, params.runId);
    db.prepare(`
      UPDATE runs
      SET actor_state = 'settled', termination_confirmed_at = ?, actor_updated_at = ?
      WHERE id = ? AND actor_state = 'quarantined'
    `).run(completedAt, completedAt, params.runId);
    workStore.consumeAcknowledgedForRun(params.runId, params.runId);
    workStore.releaseUnacknowledgedForRun(
      params.runId,
      `owning run ${params.runId} ended after confirmed quarantine recovery`
    );
    return getRunStmt.get(params.runId) as Run;
  });
  return {
    listRunning() {
      return listRunningStmt.all() as Ticket[];
    },
    beginRun(params) {
      return beginRunTransaction.immediate(params);
    },
    getRun(runId) {
      return getRunStmt.get(runId) as Run | undefined;
    },
    getLatestRunWithLog(issueId) {
      return getLatestRunWithLogStmt.get(issueId) as Run | undefined;
    },
    finishRun(params) {
      return finishRunTransaction.immediate(params);
    },
    finishRunAndThen(params, after) {
      return db.transaction(() => {
        const settled = finishRunTransaction(params);
        if (!settled && (getRunStmt.get(params.runId) as Run | undefined)?.status !== params.status) {
          throw new Error(`run ${params.runId} lost terminal settlement`);
        }
        return after();
      }).immediate();
    },
    claimRunForReaping(runId, owner, reason, faultAttribution) {
      return claimRunForReapingTransaction.immediate(runId, owner, reason, faultAttribution);
    },
    finishReapingRun(params) {
      return finishReapingRunTransaction.immediate(params);
    },
    finishReapingRunAndThen(params, after) {
      return db.transaction(() => {
        const result = finishReapingRunTransaction(params);
        if (result) after(result);
        return result;
      }).immediate();
    },
    quarantineRun(runId, owner, reason) {
      return quarantineRunTransaction.immediate(runId, owner, reason);
    },
    settleQuarantinedRun(params) {
      return settleQuarantinedRunTransaction.immediate(params);
    },
    renewRunLiveness(runId, heartbeatAt) {
      const updatedAt = now();
      renewAttemptActorStmt.run(heartbeatAt, heartbeatAt, updatedAt, runId, runId);
      return db.prepare(`
        UPDATE runs
        SET last_heartbeat_at = CASE
              WHEN last_heartbeat_at IS NULL OR last_heartbeat_at < ? THEN ?
              ELSE last_heartbeat_at
            END,
            actor_updated_at = ?
        WHERE id = ? AND actor_state = 'running'
      `).run(heartbeatAt, heartbeatAt, updatedAt, runId).changes === 1;
    },
    listExpiredRuns(nowIso) {
      return listExpiredRunsStmt.all(nowIso) as Run[];
    },
    listStalledRuns(cutoffIso) {
      return listStalledRunsStmt.all(cutoffIso) as Run[];
    },
  };
}
