import type Database from "better-sqlite3";
import { canonicalJson } from "../../pipeline/manifest.js";
import {
  selectNextReadyUnit,
  type ExecutionPlanUnit,
  type ExecutionUnitState,
} from "../../pipeline/unit-coordinator.js";
import { deterministicId } from "./helpers.js";

export interface ExecutionUnitGraph {
  id: string;
  pipeline_instance_id: string;
  parent_attempt_id: string;
  parent_stage_id: string;
  parent_run_id: string;
  graph_digest: string;
  plan_digest: string;
  integration_subject: string | null;
  aggregate_artifact_hash: string | null;
  aggregate_emitted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExecutionWorkAttempt {
  id: string;
  execution_graph_id: string;
  execution_unit_id: string;
  pipeline_instance_id: string;
  parent_attempt_id: string;
  parent_run_id: string;
  unit_id: string;
  attempt_ordinal: number;
  action_kind: "implement" | "simplify" | "command" | "candidate" | "integrate" | "aggregate" | "stop" | "cleanup";
  idempotency_key: string;
  request_hash: string | null;
  result_hash: string | null;
  native_session_id: string | null;
  status: "pending" | "leased" | "dispatched" | "running" | "completed" | "failed" | "dead";
  lease_owner: string | null;
  lease_until: string | null;
  output_subject: string | null;
  payload: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  last_error: string | null;
}

export interface ExecutionUnitStore {
  createGraph(input: {
    pipelineInstanceId: string;
    parentAttemptId: string;
    parentStageId: string;
    parentRunId: string;
    graphDigest: string;
    planDigest: string;
    units: readonly ExecutionPlanUnit[];
  }): ExecutionUnitGraph;
  getGraphForAttempt(parentAttemptId: string): ExecutionUnitGraph | undefined;
  listUnits(parentAttemptId: string): ExecutionUnitState[];
  leaseNextUnitAction(input: {
    parentAttemptId: string;
    leaseOwner: string;
    nowIso: string;
    leaseUntilIso: string;
  }): ExecutionWorkAttempt | undefined;
  markActionDispatching(actionId: string): void;
  markActionDispatched(actionId: string, requestHash: string, nativeSessionId?: string | null): void;
  completeUnitAction(input: {
    actionId: string;
    resultHash: string;
    outputSubject: string;
  }): ExecutionWorkAttempt;
  emitAggregateOnce(input: {
    parentAttemptId: string;
    artifactHash: string;
    integrationSubject: string | null;
  }): "emitted" | "already_emitted";
}

type ExecutionUnitRow = {
  id: string;
  unit_id: string;
  authored_order: number;
  dependency_unit_ids: string;
  status: ExecutionUnitState["status"];
  active_work_attempt_id: string | null;
  integration_subject: string | null;
};

function dependenciesFor(row: { dependency_unit_ids: string }): string[] {
  const parsed = JSON.parse(row.dependency_unit_ids) as unknown;
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

function unitState(row: ExecutionUnitRow): ExecutionUnitState {
  return {
    id: row.id,
    unitId: row.unit_id,
    ordinal: row.authored_order,
    dependencies: dependenciesFor(row),
    status: row.status,
    activeActionId: row.active_work_attempt_id,
    integrationSubject: row.integration_subject,
  };
}

export function createExecutionUnitStore(db: Database.Database, now: () => string): ExecutionUnitStore {
  const graphStmt = db.prepare("SELECT * FROM execution_graphs WHERE parent_attempt_id = ?");
  const listUnitRows = (parentAttemptId: string): ExecutionUnitRow[] =>
    db.prepare(`
      SELECT id, unit_id, authored_order, dependency_unit_ids, status,
        active_work_attempt_id, integration_subject
      FROM execution_units WHERE parent_attempt_id = ?
      ORDER BY authored_order, unit_id
    `).all(parentAttemptId) as ExecutionUnitRow[];

  function assertGraphReplayMatches(input: Parameters<ExecutionUnitStore["createGraph"]>[0], existing: ExecutionUnitGraph): void {
    if (
      existing.pipeline_instance_id !== input.pipelineInstanceId ||
      existing.parent_stage_id !== input.parentStageId ||
      existing.parent_run_id !== input.parentRunId ||
      existing.graph_digest !== input.graphDigest ||
      existing.plan_digest !== input.planDigest
    ) {
      throw new Error(`execution graph ${existing.id} replay fence mismatch`);
    }
    const expectedUnits = input.units.map((unit, index) => canonicalJson({
      unit_id: unit.id,
      authored_order: index,
      dependency_unit_ids: [...(unit.dependencies ?? [])].sort(),
    }));
    const actualUnits = listUnitRows(input.parentAttemptId).map((row) => canonicalJson({
      unit_id: row.unit_id,
      authored_order: row.authored_order,
      dependency_unit_ids: dependenciesFor(row),
    }));
    if (canonicalJson(actualUnits) !== canonicalJson(expectedUnits)) {
      throw new Error(`execution graph ${existing.id} replay unit set mismatch`);
    }
  }

  const createGraph = db.transaction((input: Parameters<ExecutionUnitStore["createGraph"]>[0]): ExecutionUnitGraph => {
    const timestamp = now();
    const graphId = deterministicId("execution-graph", [input.pipelineInstanceId, input.parentAttemptId]);
    const existing = graphStmt.get(input.parentAttemptId) as ExecutionUnitGraph | undefined;
    if (existing) {
      assertGraphReplayMatches(input, existing);
      return existing;
    }
    db.prepare(`
      INSERT INTO execution_graphs (
        id, pipeline_instance_id, parent_attempt_id, parent_stage_id, parent_run_id,
        graph_digest, plan_digest, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(parent_attempt_id) DO NOTHING
    `).run(
      graphId,
      input.pipelineInstanceId,
      input.parentAttemptId,
      input.parentStageId,
      input.parentRunId,
      input.graphDigest,
      input.planDigest,
      timestamp,
      timestamp
    );
    for (const [index, unit] of input.units.entries()) {
      db.prepare(`
        INSERT INTO execution_units (
          id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id,
          authored_order, dependency_unit_ids, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(parent_attempt_id, unit_id) DO NOTHING
      `).run(
        deterministicId("execution-unit", [input.parentAttemptId, unit.id]),
        graphId,
        input.pipelineInstanceId,
        input.parentAttemptId,
        unit.id,
        index,
        canonicalJson([...(unit.dependencies ?? [])].sort()),
        timestamp,
        timestamp
      );
    }
    return graphStmt.get(input.parentAttemptId) as ExecutionUnitGraph;
  });

  const leaseNextUnitAction = db.transaction((
    input: Parameters<ExecutionUnitStore["leaseNextUnitAction"]>[0]
  ): ExecutionWorkAttempt | undefined => {
    const graph = graphStmt.get(input.parentAttemptId) as ExecutionUnitGraph | undefined;
    if (!graph || graph.aggregate_emitted_at) return undefined;
    db.prepare(`
      UPDATE execution_units
      SET status = 'pending', active_work_attempt_id = NULL, updated_at = ?
      WHERE parent_attempt_id = ? AND active_work_attempt_id IN (
        SELECT id FROM execution_work_attempts
        WHERE parent_attempt_id = ? AND status = 'leased'
          AND lease_until IS NOT NULL AND lease_until <= ?
      )
    `).run(input.nowIso, input.parentAttemptId, input.parentAttemptId, input.nowIso);
    db.prepare(`
      UPDATE execution_work_attempts
      SET status = 'failed', updated_at = ?, last_error = 'lease expired before acknowledgement'
      WHERE parent_attempt_id = ? AND status = 'leased'
        AND lease_until IS NOT NULL AND lease_until <= ?
    `).run(input.nowIso, input.parentAttemptId, input.nowIso);
    const dispatched = db.prepare(`
      SELECT * FROM execution_work_attempts
      WHERE parent_attempt_id = ? AND status IN ('dispatched', 'running')
      ORDER BY created_at, id
      LIMIT 1
    `).get(input.parentAttemptId) as ExecutionWorkAttempt | undefined;
    if (dispatched) {
      db.prepare(`
        UPDATE execution_work_attempts
        SET lease_owner = ?, lease_until = ?, updated_at = ?
        WHERE id = ? AND status IN ('dispatched', 'running')
      `).run(input.leaseOwner, input.leaseUntilIso, input.nowIso, dispatched.id);
      return db.prepare("SELECT * FROM execution_work_attempts WHERE id = ?").get(dispatched.id) as ExecutionWorkAttempt;
    }
    const active = db.prepare(`
      SELECT 1 FROM execution_work_attempts
      WHERE parent_attempt_id = ? AND status = 'leased'
        AND (lease_until IS NULL OR lease_until > ?)
    `).get(input.parentAttemptId, input.nowIso);
    if (active) return undefined;
    const rows = listUnitRows(input.parentAttemptId);
    const selection = selectNextReadyUnit(rows.map(unitState));
    if (!selection) return undefined;
    const next = rows.find((row) => row.id === selection.id)!;
    const ordinal = (db.prepare(`
      SELECT COALESCE(MAX(attempt_ordinal), 0) + 1 AS ordinal
      FROM execution_work_attempts WHERE execution_unit_id = ? AND action_kind = 'implement'
    `).get(next.id) as { ordinal: number }).ordinal;
    const idempotencyKey = `unit-action:${input.parentAttemptId}:${next.unit_id}:${ordinal}`;
    const actionId = deterministicId("execution-work", [input.parentAttemptId, next.unit_id, ordinal, "implement"]);
    const payload = canonicalJson({
      parent_attempt_id: input.parentAttemptId,
      parent_run_id: graph.parent_run_id,
      unit_id: next.unit_id,
      action_kind: "implement",
    });
    db.prepare(`
      INSERT INTO execution_work_attempts (
        id, execution_graph_id, execution_unit_id, pipeline_instance_id, parent_attempt_id,
        parent_run_id, unit_id, attempt_ordinal, action_kind, idempotency_key,
        status, lease_owner, lease_until, payload, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'implement', ?, 'leased', ?, ?, ?, ?, ?)
    `).run(
      actionId,
      graph.id,
      next.id,
      graph.pipeline_instance_id,
      input.parentAttemptId,
      graph.parent_run_id,
      next.unit_id,
      ordinal,
      idempotencyKey,
      input.leaseOwner,
      input.leaseUntilIso,
      payload,
      input.nowIso,
      input.nowIso
    );
    db.prepare(`
      UPDATE execution_units
      SET status = 'running', active_work_attempt_id = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(actionId, input.nowIso, next.id);
    return db.prepare("SELECT * FROM execution_work_attempts WHERE id = ?").get(actionId) as ExecutionWorkAttempt;
  });

  const completeUnitAction = db.transaction((
    input: Parameters<ExecutionUnitStore["completeUnitAction"]>[0]
  ): ExecutionWorkAttempt => {
    const timestamp = now();
    const action = db.prepare("SELECT * FROM execution_work_attempts WHERE id = ?")
      .get(input.actionId) as ExecutionWorkAttempt | undefined;
    if (!action) throw new Error(`unknown execution work attempt ${input.actionId}`);
    if (action.status === "completed") return action;
    if (!["leased", "dispatched", "running"].includes(action.status)) {
      throw new Error(`execution work attempt ${input.actionId} is not active`);
    }
    db.prepare(`
      UPDATE execution_work_attempts
      SET status = 'completed', result_hash = ?, output_subject = ?,
          completed_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('leased', 'dispatched', 'running')
    `).run(input.resultHash, input.outputSubject, timestamp, timestamp, input.actionId);
    db.prepare(`
      UPDATE execution_units
      SET status = 'integrated', active_work_attempt_id = NULL,
          accepted_candidate_subject = ?, integration_subject = ?, updated_at = ?
      WHERE id = ? AND active_work_attempt_id = ?
    `).run(input.outputSubject, input.outputSubject, timestamp, action.execution_unit_id, input.actionId);
    return db.prepare("SELECT * FROM execution_work_attempts WHERE id = ?").get(input.actionId) as ExecutionWorkAttempt;
  });

  const emitAggregateOnce = db.transaction((
    input: Parameters<ExecutionUnitStore["emitAggregateOnce"]>[0]
  ): "emitted" | "already_emitted" => {
    const graph = graphStmt.get(input.parentAttemptId) as ExecutionUnitGraph | undefined;
    if (!graph) throw new Error(`execution graph for parent attempt ${input.parentAttemptId} is missing`);
    if (graph.aggregate_emitted_at) {
      if (graph.aggregate_artifact_hash !== input.artifactHash) {
        throw new Error(`execution graph ${graph.id} already emitted a different aggregate`);
      }
      return "already_emitted";
    }
    const unfinished = db.prepare(`
      SELECT 1 FROM execution_units
      WHERE parent_attempt_id = ? AND status NOT IN ('integrated', 'completed')
      LIMIT 1
    `).get(input.parentAttemptId);
    if (unfinished) throw new Error(`execution graph ${graph.id} has unfinished units`);
    const timestamp = now();
    const update = db.prepare(`
      UPDATE execution_graphs
      SET aggregate_artifact_hash = ?, aggregate_emitted_at = ?,
          integration_subject = ?, updated_at = ?
      WHERE parent_attempt_id = ? AND aggregate_emitted_at IS NULL
    `).run(input.artifactHash, timestamp, input.integrationSubject, timestamp, input.parentAttemptId);
    if (update.changes !== 1) throw new Error(`execution graph ${graph.id} aggregate compare-and-set failed`);
    return "emitted";
  });

  return {
    createGraph,
    getGraphForAttempt(parentAttemptId) {
      return graphStmt.get(parentAttemptId) as ExecutionUnitGraph | undefined;
    },
    listUnits(parentAttemptId) {
      return listUnitRows(parentAttemptId).map(unitState);
    },
    leaseNextUnitAction,
    markActionDispatching(actionId) {
      const timestamp = now();
      const update = db.prepare(`
        UPDATE execution_work_attempts
        SET status = 'dispatched', updated_at = ?
        WHERE id = ? AND status = 'leased'
      `).run(timestamp, actionId);
      if (update.changes !== 1) throw new Error(`execution work attempt ${actionId} is not leased`);
    },
    markActionDispatched(actionId, requestHash, nativeSessionId = null) {
      const timestamp = now();
      const update = db.prepare(`
        UPDATE execution_work_attempts
        SET status = 'dispatched', request_hash = ?, native_session_id = ?, updated_at = ?
        WHERE id = ? AND status IN ('leased', 'dispatched', 'running')
      `).run(requestHash, nativeSessionId, timestamp, actionId);
      if (update.changes !== 1) throw new Error(`execution work attempt ${actionId} is not active`);
    },
    completeUnitAction,
    emitAggregateOnce,
  };
}
