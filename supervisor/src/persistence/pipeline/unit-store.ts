import type Database from "better-sqlite3";
import { canonicalJson, digestNormalized, type StageOutcome } from "../../pipeline/manifest.js";
import {
  decideDownstreamContext,
  deriveUnitTerminalState,
  selectNextReadyUnit,
  type ChildGateDecision,
  type ChildGateEvaluatorKind,
  type ExecutionPlanUnit,
  type ExecutionUnitState,
  type UnitTerminalReason,
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
  stopped_at: string | null;
  stop_reason: string | null;
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

export interface ExecutionGateReceipt {
  id: string;
  execution_graph_id: string;
  execution_unit_id: string;
  execution_work_attempt_id: string;
  parent_attempt_id: string;
  unit_id: string;
  gate_kind: ChildGateDecision["gateKind"];
  evaluator_kind: ChildGateEvaluatorKind;
  subject: string | null;
  result: ChildGateDecision["result"];
  outcome: StageOutcome;
  reason: string;
  artifact_hashes: string;
  payload: string;
  receipt_hash: string;
  created_at: string;
}

export interface ExecutionDownstreamContext {
  id: string;
  execution_graph_id: string;
  pipeline_instance_id: string;
  parent_attempt_id: string;
  from_execution_unit_id: string;
  to_execution_unit_id: string;
  from_unit_id: string;
  to_unit_id: string;
  payload: string;
  payload_hash: string;
  created_at: string;
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
  recordGateReceipt(input: {
    actionId: string;
    gateKind: ChildGateDecision["gateKind"];
    evaluatorKind: ChildGateEvaluatorKind;
    subject: string | null;
    result: ChildGateDecision["result"];
    outcome: StageOutcome;
    reason: string;
    artifactHashes: readonly string[];
    payload: string;
    hash: string;
  }): "recorded" | "already_recorded";
  listGateReceipts(parentAttemptId: string): ExecutionGateReceipt[];
  appendDownstreamContext(input: {
    parentAttemptId: string;
    fromUnitId: string;
    records: readonly { toUnitId: string; payload: Record<string, unknown> }[];
  }): ExecutionDownstreamContext[];
  listDownstreamContext(parentAttemptId: string, toUnitId?: string): ExecutionDownstreamContext[];
  stopActiveWork(input: {
    parentAttemptId: string;
    reason: string;
  }): "stopped" | "already_stopped";
  settleUnitTerminal(input: {
    parentAttemptId: string;
    unitId: string;
    reason: UnitTerminalReason;
  }): "settled" | "already_settled";
  healStaleChildActions(input: {
    parentAttemptId: string;
    nowIso: string;
    reason: string;
  }): Array<{ actionId: string; unitId: string }>;
  renewChildActionLiveness(input: {
    parentRunId: string;
    actionId: string;
    heartbeatAtIso: string;
    leaseUntilIso: string;
  }): boolean;
}

type ExecutionUnitRow = {
  id: string;
  unit_id: string;
  authored_order: number;
  dependency_unit_ids: string;
  status: ExecutionUnitState["status"];
  active_work_attempt_id: string | null;
  integration_subject: string | null;
  terminal_level: ExecutionUnitState["terminalLevel"];
  alarm: number;
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
    terminalLevel: row.terminal_level,
    alarm: row.alarm === 1,
  };
}

export function createExecutionUnitStore(db: Database.Database, now: () => string): ExecutionUnitStore {
  const graphStmt = db.prepare("SELECT * FROM execution_graphs WHERE parent_attempt_id = ?");
  const listUnitRows = (parentAttemptId: string): ExecutionUnitRow[] =>
    db.prepare(`
      SELECT id, unit_id, authored_order, dependency_unit_ids, status,
        active_work_attempt_id, integration_subject, terminal_level, alarm
      FROM execution_units WHERE parent_attempt_id = ?
      ORDER BY authored_order, unit_id
    `).all(parentAttemptId) as ExecutionUnitRow[];

  function settleUnitRow(input: {
    parentAttemptId: string;
    unitId: string;
    reason: UnitTerminalReason;
    timestamp: string;
  }): "settled" | "already_settled" {
    const terminal = deriveUnitTerminalState(input.reason);
    const existing = db.prepare(`
      SELECT status, terminal_level, alarm FROM execution_units
      WHERE parent_attempt_id = ? AND unit_id = ?
    `).get(input.parentAttemptId, input.unitId) as
      | { status: ExecutionUnitState["status"]; terminal_level: ExecutionUnitState["terminalLevel"]; alarm: number }
      | undefined;
    if (!existing) throw new Error(`unknown execution unit ${input.unitId}`);
    if (existing.terminal_level) {
      if (
        existing.status !== terminal.status ||
        existing.terminal_level !== terminal.terminalLevel ||
        (existing.alarm === 1) !== terminal.alarm
      ) {
        throw new Error(`execution unit ${input.unitId} already has a different terminal level`);
      }
      return "already_settled";
    }
    const update = db.prepare(`
      UPDATE execution_units
      SET status = ?, terminal_level = ?, alarm = ?, active_work_attempt_id = NULL, updated_at = ?
      WHERE parent_attempt_id = ? AND unit_id = ? AND terminal_level IS NULL
    `).run(
      terminal.status,
      terminal.terminalLevel,
      terminal.alarm ? 1 : 0,
      input.timestamp,
      input.parentAttemptId,
      input.unitId
    );
    if (update.changes !== 1) throw new Error(`execution unit ${input.unitId} terminal compare-and-set failed`);
    return "settled";
  }

  function healStaleChildActionRows(input: {
    parentAttemptId: string;
    nowIso: string;
    reason: string;
  }): Array<{ actionId: string; unitId: string }> {
    const stale = db.prepare(`
      SELECT id, unit_id FROM execution_work_attempts
      WHERE parent_attempt_id = ? AND status IN ('dispatched', 'running')
        AND lease_until IS NOT NULL AND lease_until <= ?
      ORDER BY created_at, id
    `).all(input.parentAttemptId, input.nowIso) as Array<{ id: string; unit_id: string }>;
    for (const action of stale) {
      db.prepare(`
        UPDATE execution_work_attempts
        SET status = 'dead', lease_until = NULL, completed_at = COALESCE(completed_at, ?),
            last_error = ?, updated_at = ?
        WHERE id = ? AND status IN ('dispatched', 'running')
      `).run(input.nowIso, input.reason, input.nowIso, action.id);
      settleUnitRow({
        parentAttemptId: input.parentAttemptId,
        unitId: action.unit_id,
        reason: "structural_exit",
        timestamp: input.nowIso,
      });
    }
    settleStructurallyBlockedDependents(input.parentAttemptId, input.nowIso);
    return stale.map((action) => ({ actionId: action.id, unitId: action.unit_id }));
  }

  function settleStructurallyBlockedDependents(parentAttemptId: string, timestamp: string): void {
    for (;;) {
      const rows = listUnitRows(parentAttemptId);
      const blockingTerminals = new Set(
        rows
          .filter((row) => row.terminal_level === "exited" || row.terminal_level === "failed")
          .map((row) => row.unit_id)
      );
      const blocked = rows.find((row) =>
        row.status === "pending" &&
        row.terminal_level === null &&
        dependenciesFor(row).some((dependency) => blockingTerminals.has(dependency))
      );
      if (!blocked) return;
      settleUnitRow({
        parentAttemptId,
        unitId: blocked.unit_id,
        reason: "structural_exit",
        timestamp,
      });
    }
  }

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
    if (!graph || graph.aggregate_emitted_at || graph.stopped_at) return undefined;
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
    healStaleChildActionRows({
      parentAttemptId: input.parentAttemptId,
      nowIso: input.nowIso,
      reason: "child action missed heartbeat fence",
    });
    const dispatched = db.prepare(`
      SELECT * FROM execution_work_attempts
      WHERE parent_attempt_id = ? AND status IN ('dispatched', 'running')
      ORDER BY created_at, id
      LIMIT 1
    `).get(input.parentAttemptId) as ExecutionWorkAttempt | undefined;
    if (dispatched) {
      return dispatched;
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
      WHERE parent_attempt_id = ? AND status NOT IN ('integrated', 'completed', 'exited')
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

  const recordGateReceipt = db.transaction((
    input: Parameters<ExecutionUnitStore["recordGateReceipt"]>[0]
  ): "recorded" | "already_recorded" => {
    if (digestNormalized(input.payload) !== input.hash) throw new Error("execution gate receipt hash mismatch");
    const action = db.prepare("SELECT * FROM execution_work_attempts WHERE id = ?")
      .get(input.actionId) as ExecutionWorkAttempt | undefined;
    if (!action) throw new Error(`unknown execution work attempt ${input.actionId}`);
    const existing = db.prepare(`
      SELECT * FROM execution_gate_receipts
      WHERE execution_work_attempt_id = ? AND gate_kind = ?
    `).get(input.actionId, input.gateKind) as ExecutionGateReceipt | undefined;
    if (existing) {
      if (
        existing.evaluator_kind !== input.evaluatorKind ||
        existing.subject !== input.subject ||
        existing.result !== input.result ||
        existing.outcome !== input.outcome ||
        existing.reason !== input.reason ||
        existing.artifact_hashes !== canonicalJson([...input.artifactHashes].sort()) ||
        existing.payload !== input.payload ||
        existing.receipt_hash !== input.hash
      ) throw new Error(`execution work attempt ${input.actionId} already recorded a different gate receipt`);
      return "already_recorded";
    }
    if (!["leased", "dispatched", "running", "completed"].includes(action.status)) {
      throw new Error(`execution work attempt ${input.actionId} is not receivable`);
    }
    const timestamp = now();
    db.prepare(`
      INSERT INTO execution_gate_receipts (
        id, execution_graph_id, execution_unit_id, execution_work_attempt_id,
        parent_attempt_id, unit_id, gate_kind, evaluator_kind, subject, result,
        outcome, reason, artifact_hashes, payload, receipt_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deterministicId("execution-gate", [action.id, input.gateKind]),
      action.execution_graph_id,
      action.execution_unit_id,
      action.id,
      action.parent_attempt_id,
      action.unit_id,
      input.gateKind,
      input.evaluatorKind,
      input.subject,
      input.result,
      input.outcome,
      input.reason,
      canonicalJson([...input.artifactHashes].sort()),
      input.payload,
      input.hash,
      timestamp
    );
    return "recorded";
  });

  const appendDownstreamContext = db.transaction((
    input: Parameters<ExecutionUnitStore["appendDownstreamContext"]>[0]
  ): ExecutionDownstreamContext[] => {
    const graph = graphStmt.get(input.parentAttemptId) as ExecutionUnitGraph | undefined;
    if (!graph) throw new Error(`execution graph for parent attempt ${input.parentAttemptId} is missing`);
    const rows = listUnitRows(input.parentAttemptId);
    const decision = decideDownstreamContext({
      units: rows.map(unitState),
      fromUnitId: input.fromUnitId,
      records: input.records,
    });
    if (decision.outcome !== "success") {
      const target = input.records[0]?.toUnitId ?? "<none>";
      if (decision.reason === "downstream_context_target_unknown") {
        throw new Error(`unknown downstream context target ${target}`);
      }
      if (decision.reason === "downstream_context_target_not_pending") {
        throw new Error(`downstream context target ${target} is not pending`);
      }
      if (decision.reason === "downstream_context_source_not_integrated") {
        throw new Error(`downstream context source ${input.fromUnitId} is not integrated`);
      }
      throw new Error(decision.reason);
    }
    const unitRowsById = new Map(rows.map((row) => [row.unit_id, row]));
    const from = unitRowsById.get(input.fromUnitId)!;
    const timestamp = now();
    const output: ExecutionDownstreamContext[] = [];
    for (const record of decision.records) {
      const to = unitRowsById.get(record.toUnitId)!;
      const payload = canonicalJson(record.payload);
      const id = deterministicId("execution-context", [input.parentAttemptId, input.fromUnitId, record.toUnitId, record.payloadHash]);
      db.prepare(`
        INSERT INTO execution_downstream_context (
          id, execution_graph_id, pipeline_instance_id, parent_attempt_id,
          from_execution_unit_id, to_execution_unit_id, from_unit_id, to_unit_id,
          payload, payload_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(parent_attempt_id, from_unit_id, to_unit_id, payload_hash) DO NOTHING
      `).run(
        id,
        graph.id,
        graph.pipeline_instance_id,
        input.parentAttemptId,
        from.id,
        to.id,
        input.fromUnitId,
        record.toUnitId,
        payload,
        record.payloadHash,
        timestamp
      );
      output.push(db.prepare("SELECT * FROM execution_downstream_context WHERE id = ?")
        .get(id) as ExecutionDownstreamContext);
    }
    return output;
  });

  const stopActiveWork = db.transaction((
    input: Parameters<ExecutionUnitStore["stopActiveWork"]>[0]
  ): "stopped" | "already_stopped" => {
    const timestamp = now();
    const graph = graphStmt.get(input.parentAttemptId) as ExecutionUnitGraph | undefined;
    if (!graph) return "already_stopped";
    if (graph.aggregate_emitted_at || graph.stopped_at) return "already_stopped";
    const activeActionIds = (db.prepare(`
      SELECT id FROM execution_work_attempts
      WHERE parent_attempt_id = ? AND status IN ('leased', 'dispatched', 'running')
      ORDER BY created_at, id
    `).all(input.parentAttemptId) as Array<{ id: string }>).map((action) => action.id);
    db.prepare(`
      UPDATE execution_graphs
      SET stopped_at = ?, stop_reason = ?, updated_at = ?
      WHERE parent_attempt_id = ? AND stopped_at IS NULL
    `).run(timestamp, input.reason, timestamp, input.parentAttemptId);
    if (activeActionIds.length > 0) {
      db.prepare(`
        UPDATE execution_work_attempts
        SET status = 'dead', lease_until = NULL, last_error = ?, updated_at = ?, completed_at = COALESCE(completed_at, ?)
        WHERE parent_attempt_id = ? AND status IN ('leased', 'dispatched', 'running')
      `).run(input.reason, timestamp, timestamp, input.parentAttemptId);
      db.prepare(`
        UPDATE execution_units
        SET status = 'exited', terminal_level = 'exited', alarm = 0,
            active_work_attempt_id = NULL, updated_at = ?
        WHERE parent_attempt_id = ? AND active_work_attempt_id IN (${activeActionIds.map(() => "?").join(",")})
      `).run(timestamp, input.parentAttemptId, ...activeActionIds);
    }
    db.prepare(`
      UPDATE execution_units
      SET status = 'exited', terminal_level = 'exited', alarm = 0,
          active_work_attempt_id = NULL, updated_at = ?
      WHERE parent_attempt_id = ? AND terminal_level IS NULL
    `).run(timestamp, input.parentAttemptId);
    return "stopped";
  });

  const settleUnitTerminal = db.transaction((
    input: Parameters<ExecutionUnitStore["settleUnitTerminal"]>[0]
  ): "settled" | "already_settled" => {
    const timestamp = now();
    const result = settleUnitRow({
      parentAttemptId: input.parentAttemptId,
      unitId: input.unitId,
      reason: input.reason,
      timestamp,
    });
    if (input.reason === "structural_exit") settleStructurallyBlockedDependents(input.parentAttemptId, timestamp);
    return result;
  });

  const healStaleChildActions = db.transaction((
    input: Parameters<ExecutionUnitStore["healStaleChildActions"]>[0]
  ): Array<{ actionId: string; unitId: string }> => healStaleChildActionRows(input));

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
    recordGateReceipt,
    listGateReceipts(parentAttemptId) {
      return db.prepare(`
        SELECT * FROM execution_gate_receipts
        WHERE parent_attempt_id = ?
        ORDER BY created_at, id
      `).all(parentAttemptId) as ExecutionGateReceipt[];
    },
    appendDownstreamContext,
    listDownstreamContext(parentAttemptId, toUnitId) {
      if (toUnitId != null) {
        return db.prepare(`
          SELECT * FROM execution_downstream_context
          WHERE parent_attempt_id = ? AND to_unit_id = ?
          ORDER BY created_at, id
        `).all(parentAttemptId, toUnitId) as ExecutionDownstreamContext[];
      }
      return db.prepare(`
        SELECT * FROM execution_downstream_context
        WHERE parent_attempt_id = ?
        ORDER BY created_at, id
      `).all(parentAttemptId) as ExecutionDownstreamContext[];
    },
    stopActiveWork,
    settleUnitTerminal,
    healStaleChildActions,
    renewChildActionLiveness(input) {
      const timestamp = now();
      return db.prepare(`
        UPDATE execution_work_attempts
        SET lease_until = CASE
              WHEN lease_until IS NULL OR lease_until < ? THEN ?
              ELSE lease_until
            END,
            updated_at = ?
        WHERE id = ? AND parent_run_id = ?
          AND status IN ('leased', 'dispatched', 'running')
      `).run(
        input.leaseUntilIso,
        input.leaseUntilIso,
        timestamp,
        input.actionId,
        input.parentRunId
      ).changes === 1;
    },
  };
}
