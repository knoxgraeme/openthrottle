import type Database from "better-sqlite3";
import {
  canonicalJson,
  type PipelineUnitPhaseBinding,
  type StageOutcome,
  unitPhaseBindingCommandNames,
  unitPhaseBindingIds,
} from "../../pipeline/manifest.js";
import { buildExecutionPublicationSnapshot } from "../../pipeline/execution-publication.js";
import type { ExecutionGateDecision } from "../../pipeline/execution-gates.js";
import {
  decideDownstreamContext,
  deriveUnitTerminalState,
  assertValidUnitPhaseSequence,
  nextUnitPhase,
  routeFinalReviewDecision,
  routeIntegrationDecision,
  routeUnitAcceptanceDecision,
  selectNextReadyUnit,
  type ChildGateDecision,
  type ChildGateEvaluatorKind,
  type ExecutionPlanUnit,
  type ExecutionUnitState,
  type FinalPhase,
  type UnitActionKind,
  type UnitPhase,
  type UnitTerminalReason,
} from "../../pipeline/unit-coordinator.js";
import { deterministicId } from "./helpers.js";
import {
  createOrResumeFinalAction,
  createOrResumeUnitAction,
  DEFAULT_MAX_REPAIR_ROUNDS,
  dependenciesFor,
  GATED_ACTION_KINDS,
  insertGateReceipt,
  listUnitRowsForParentAttempt,
  loadActiveAction,
  markActionCompleted,
  nextUnitPhaseAfterCompletion,
  PHASE_FOR_COMPLETING_ACTION_KIND,
  phaseSequenceOf,
  unitPhasesOf,
  unitState,
  type ExecutionUnitRow,
} from "./unit-store-phase-reducer.js";

export type ExecutionGateKind = ChildGateDecision["gateKind"] | "integration" | "final_review";

export interface ExecutionUnitGraph {
  id: string;
  pipeline_instance_id: string;
  parent_attempt_id: string;
  parent_stage_id: string;
  parent_run_id: string;
  graph_digest: string;
  plan_digest: string;
  command_names: string;
  unit_phases: string;
  unit_phase_bindings: string;
  max_repair_rounds: number;
  final_phase: FinalPhase | null;
  final_command_index: number;
  final_cycle: number;
  final_repair_rounds: number;
  final_review_passed_at: string | null;
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
  execution_unit_id: string | null;
  pipeline_instance_id: string;
  parent_attempt_id: string;
  parent_run_id: string;
  unit_id: string | null;
  attempt_ordinal: number;
  action_kind: UnitActionKind;
  cycle: number;
  command_name: string | null;
  idempotency_key: string;
  request_hash: string | null;
  result_hash: string | null;
  receipt: string | null;
  receipt_hash: string | null;
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
  execution_unit_id: string | null;
  execution_work_attempt_id: string;
  parent_attempt_id: string;
  unit_id: string | null;
  gate_kind: ExecutionGateKind;
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
    commandNames?: readonly string[];
    unitPhases?: readonly UnitPhase[];
    unitPhaseBindings?: readonly PipelineUnitPhaseBinding[];
    maxRepairRounds?: number;
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
    receipt?: string;
  }): ExecutionWorkAttempt;
  completeGatedAction(input: {
    actionId: string;
    resultHash: string;
    outputSubject: string;
    receipt?: string;
    decision: ExecutionGateDecision;
  }): ExecutionWorkAttempt;
  emitAggregateOnce(input: {
    parentAttemptId: string;
    artifactHash: string;
    integrationSubject: string | null;
  }): "emitted" | "already_emitted";
  recordGateReceipt(input: {
    actionId: string;
    gateKind: ExecutionGateKind;
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
  healExpiredCurrentChildAction(input: {
    parentAttemptId: string;
    actionId: string;
    nowIso: string;
    reason: string;
  }): "healed" | "not_current";
  renewChildActionLiveness(input: {
    parentRunId: string;
    actionId: string;
    heartbeatAtIso: string;
    leaseUntilIso: string;
  }): boolean;
  getStructuredExecutionPublication(parentAttemptId: string): ReturnType<typeof buildExecutionPublicationSnapshot>;
}

export function getStructuredExecutionPublicationForAttempt(
  db: Database.Database,
  parentAttemptId: string
): ReturnType<typeof buildExecutionPublicationSnapshot> {
  const graph = db.prepare("SELECT * FROM execution_graphs WHERE parent_attempt_id = ?")
    .get(parentAttemptId) as ExecutionUnitGraph | undefined;
  if (!graph) return undefined;
  const attempts = db.prepare(`
    SELECT * FROM (
      SELECT * FROM (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY unit_id
            ORDER BY attempt_ordinal DESC, created_at DESC, id DESC
          ) AS row_number
        FROM execution_work_attempts
        WHERE parent_attempt_id = ? AND unit_id IS NOT NULL
      )
      WHERE row_number <= 3
    )
    ORDER BY unit_id, attempt_ordinal, created_at, id
  `).all(parentAttemptId) as ExecutionWorkAttempt[];
  const gates = db.prepare(`
    SELECT * FROM execution_gate_receipts
    WHERE parent_attempt_id = ? AND unit_id IS NOT NULL
    ORDER BY unit_id, created_at, id
  `).all(parentAttemptId) as ExecutionGateReceipt[];
  const downstreamContext = db.prepare(`
    SELECT * FROM (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY from_unit_id
          ORDER BY created_at, id
        ) AS row_number
      FROM execution_downstream_context
      WHERE parent_attempt_id = ?
    )
    WHERE row_number <= 3
    ORDER BY from_unit_id, created_at, id
  `).all(parentAttemptId) as ExecutionDownstreamContext[];
  return buildExecutionPublicationSnapshot({
    graph,
    units: listUnitRowsForParentAttempt(db, parentAttemptId).map(unitState),
    attempts: attempts as Array<ExecutionWorkAttempt & { unit_id: string }>,
    gates: gates as Array<ExecutionGateReceipt & { unit_id: string }>,
    downstreamContext,
  });
}

export function createExecutionUnitStore(db: Database.Database, now: () => string): ExecutionUnitStore {
  const graphStmt = db.prepare("SELECT * FROM execution_graphs WHERE parent_attempt_id = ?");
  const listUnitRows = (parentAttemptId: string): ExecutionUnitRow[] =>
    listUnitRowsForParentAttempt(db, parentAttemptId);

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

  function assertGraphReplayMatches(
    input: Parameters<ExecutionUnitStore["createGraph"]>[0],
    existing: ExecutionUnitGraph,
    phaseProjection: UnitPhaseProjection
  ): void {
    const expectedCommandNames = canonicalJson(phaseProjection.commandNames);
    const persistedUnitPhases = unitPhasesOf(existing);
    const requestedUnitPhases = phaseProjection.unitPhases.length > 0 ? phaseProjection.unitPhases : persistedUnitPhases;
    const expectedUnitPhases = canonicalJson(requestedUnitPhases);
    const expectedUnitPhaseBindings = canonicalJson([...phaseProjection.unitPhaseBindings]);
    const legacyBuiltinUnitPhasesReplay =
      persistedUnitPhases.length === 0 &&
      expectedUnitPhases === canonicalJson(phaseSequenceOf(existing));
    const unitPhaseBindingsMigratedAt = (db.prepare(
      "SELECT applied_at FROM schema_migrations WHERE version = 21"
    ).get() as { applied_at: string } | undefined)?.applied_at;
    const legacyUnboundPhaseReplay =
      existing.unit_phase_bindings === "[]" &&
      unitPhaseBindingsMigratedAt !== undefined &&
      existing.created_at < unitPhaseBindingsMigratedAt &&
      phaseProjection.unitPhaseBindings.length > 0 &&
      (existing.unit_phases === expectedUnitPhases || legacyBuiltinUnitPhasesReplay) &&
      existing.command_names === expectedCommandNames;
    const expectedMaxRepairRounds = input.maxRepairRounds ?? DEFAULT_MAX_REPAIR_ROUNDS;
    if (
      existing.pipeline_instance_id !== input.pipelineInstanceId ||
      existing.parent_stage_id !== input.parentStageId ||
      existing.parent_run_id !== input.parentRunId ||
      existing.graph_digest !== input.graphDigest ||
      existing.plan_digest !== input.planDigest ||
      existing.command_names !== expectedCommandNames ||
      (existing.unit_phases !== expectedUnitPhases && !legacyBuiltinUnitPhasesReplay) ||
      (existing.unit_phase_bindings !== expectedUnitPhaseBindings && !legacyUnboundPhaseReplay) ||
      existing.max_repair_rounds !== expectedMaxRepairRounds
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

  function assertUnitPhaseBindingsMatch(input: Parameters<ExecutionUnitStore["createGraph"]>[0]): void {
    if (!input.unitPhaseBindings || input.unitPhaseBindings.length === 0) {
      throw new Error("execution graph unitPhaseBindings are required");
    }
    if (
      input.unitPhases &&
      canonicalJson(unitPhaseBindingIds(input.unitPhaseBindings)) !== canonicalJson([...input.unitPhases])
    ) {
      throw new Error("execution graph unitPhaseBindings must match unitPhases");
    }
    const boundCommandNames = unitPhaseBindingCommandNames(input.unitPhaseBindings);
    if (
      input.commandNames &&
      canonicalJson(boundCommandNames) !== canonicalJson([...input.commandNames])
    ) {
      throw new Error("execution graph unitPhaseBindings command phases must match commandNames");
    }
  }

  type UnitPhaseProjection = {
    commandNames: string[];
    unitPhases: UnitPhase[];
    unitPhaseBindings: readonly PipelineUnitPhaseBinding[];
  };

  function unitPhaseProjection(input: Parameters<ExecutionUnitStore["createGraph"]>[0]): UnitPhaseProjection {
    assertUnitPhaseBindingsMatch(input);
    const unitPhaseBindings = input.unitPhaseBindings!;
    return {
      commandNames: unitPhaseBindingCommandNames(unitPhaseBindings),
      unitPhases: unitPhaseBindingIds(unitPhaseBindings),
      unitPhaseBindings,
    };
  }

  const createGraph = db.transaction((input: Parameters<ExecutionUnitStore["createGraph"]>[0]): ExecutionUnitGraph => {
    const timestamp = now();
    const graphId = deterministicId("execution-graph", [input.pipelineInstanceId, input.parentAttemptId]);
    const phaseProjection = unitPhaseProjection(input);
    if (phaseProjection.unitPhases.length > 0) assertValidUnitPhaseSequence(phaseProjection.unitPhases);
    const existing = graphStmt.get(input.parentAttemptId) as ExecutionUnitGraph | undefined;
    if (existing) {
      assertGraphReplayMatches(input, existing, phaseProjection);
      return existing;
    }
    const commandNames = canonicalJson(phaseProjection.commandNames);
    const unitPhases = canonicalJson(phaseProjection.unitPhases);
    const unitPhaseBindings = canonicalJson([...phaseProjection.unitPhaseBindings]);
    const initialUnitPhase = phaseProjection.unitPhases[0] ?? "implement";
    const maxRepairRounds = input.maxRepairRounds ?? DEFAULT_MAX_REPAIR_ROUNDS;
    if (!Number.isInteger(maxRepairRounds) || maxRepairRounds < 0) {
      throw new Error("execution graph maxRepairRounds must be a non-negative integer");
    }
    db.prepare(`
      INSERT INTO execution_graphs (
        id, pipeline_instance_id, parent_attempt_id, parent_stage_id, parent_run_id,
        graph_digest, plan_digest, command_names, unit_phases, unit_phase_bindings,
        max_repair_rounds, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(parent_attempt_id) DO NOTHING
    `).run(
      graphId,
      input.pipelineInstanceId,
      input.parentAttemptId,
      input.parentStageId,
      input.parentRunId,
      input.graphDigest,
      input.planDigest,
      commandNames,
      unitPhases,
      unitPhaseBindings,
      maxRepairRounds,
      timestamp,
      timestamp
    );
    for (const [index, unit] of input.units.entries()) {
      db.prepare(`
        INSERT INTO execution_units (
          id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id,
          authored_order, dependency_unit_ids, status, phase, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        ON CONFLICT(parent_attempt_id, unit_id) DO NOTHING
      `).run(
        deterministicId("execution-unit", [input.parentAttemptId, unit.id]),
        graphId,
        input.pipelineInstanceId,
        input.parentAttemptId,
        unit.id,
        index,
        canonicalJson([...(unit.dependencies ?? [])].sort()),
        initialUnitPhase,
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
    const allSettled = rows.length > 0 && rows.every((row) => row.terminal_level !== null);
    if (!allSettled) {
      const resumable = rows.find((row) =>
        row.status === "running" && row.active_work_attempt_id === null && row.terminal_level === null
      );
      if (resumable) {
        return createOrResumeUnitAction(db, {
          unitRow: resumable,
          graph,
          leaseOwner: input.leaseOwner,
          nowIso: input.nowIso,
          leaseUntilIso: input.leaseUntilIso,
        });
      }
      const selection = selectNextReadyUnit(rows.map(unitState));
      if (!selection) return undefined;
      const next = rows.find((row) => row.id === selection.id)!;
      return createOrResumeUnitAction(db, {
        unitRow: next,
        graph,
        leaseOwner: input.leaseOwner,
        nowIso: input.nowIso,
        leaseUntilIso: input.leaseUntilIso,
      });
    }

    const hasCompletedUnit = rows.some((row) => row.terminal_level === "completed");
    if (!hasCompletedUnit) return undefined;
    return createOrResumeFinalAction(db, {
      graph,
      leaseOwner: input.leaseOwner,
      nowIso: input.nowIso,
      leaseUntilIso: input.leaseUntilIso,
    });
  });

  const completeUnitAction = db.transaction((
    input: Parameters<ExecutionUnitStore["completeUnitAction"]>[0]
  ): ExecutionWorkAttempt => {
    const timestamp = now();
    const action = loadActiveAction(db, input.actionId);
    if (action.status === "completed") return action;
    if (!["leased", "dispatched", "running"].includes(action.status)) {
      throw new Error(`execution work attempt ${input.actionId} is not active`);
    }
    if (GATED_ACTION_KINDS.has(action.action_kind)) {
      throw new Error(`execution work attempt ${input.actionId} requires a gate decision to complete`);
    }
    markActionCompleted(db, { action, resultHash: input.resultHash, outputSubject: input.outputSubject, receipt: input.receipt, timestamp });

    if (action.execution_unit_id) {
      const unitUpdate = db.prepare(`
        UPDATE execution_units
        SET active_work_attempt_id = NULL, updated_at = ?
        WHERE id = ? AND active_work_attempt_id = ?
      `).run(timestamp, action.execution_unit_id, action.id);
      if (unitUpdate.changes !== 1) {
        throw new Error(`execution work attempt ${input.actionId} is not the current active action`);
      }
      if (action.action_kind === "command") {
        db.prepare(`UPDATE execution_units SET command_index = command_index + 1, updated_at = ? WHERE id = ?`)
          .run(timestamp, action.execution_unit_id);
      } else if (PHASE_FOR_COMPLETING_ACTION_KIND[action.action_kind]) {
        const currentPhase = PHASE_FOR_COMPLETING_ACTION_KIND[action.action_kind]!;
        const graph = graphStmt.get(action.parent_attempt_id) as ExecutionUnitGraph;
        const nextPhase = nextUnitPhaseAfterCompletion(db, {
          unitRowId: action.execution_unit_id,
          currentPhase,
          currentCycle: action.cycle,
          phases: phaseSequenceOf(graph),
        });
        const next = nextPhase.phase;
        if (!next) throw new Error(`execution unit phase ${currentPhase} has no successor`);
        db.prepare(`
          UPDATE execution_units
          SET phase = ?, command_index = CASE WHEN ? = 1 THEN 0 ELSE command_index END, updated_at = ?
          WHERE id = ?
        `).run(next, nextPhase.resetCommandIndex ? 1 : 0, timestamp, action.execution_unit_id);
      } else {
        throw new Error(`execution work attempt ${input.actionId} action kind is not handled by completeUnitAction`);
      }
    } else {
      if (action.action_kind === "final_command") {
        db.prepare(`UPDATE execution_graphs SET final_command_index = final_command_index + 1, updated_at = ? WHERE id = ?`)
          .run(timestamp, action.execution_graph_id);
      } else if (action.action_kind === "final_repair") {
        db.prepare(`
          UPDATE execution_graphs
          SET final_phase = 'command', final_command_index = 0, final_cycle = final_cycle + 1, updated_at = ?
          WHERE id = ?
        `).run(timestamp, action.execution_graph_id);
      } else {
        throw new Error(`execution work attempt ${input.actionId} action kind is not handled by completeUnitAction`);
      }
    }
    return loadActiveAction(db, input.actionId);
  });

  const completeGatedAction = db.transaction((
    input: Parameters<ExecutionUnitStore["completeGatedAction"]>[0]
  ): ExecutionWorkAttempt => {
    const timestamp = now();
    const action = loadActiveAction(db, input.actionId);
    if (!GATED_ACTION_KINDS.has(action.action_kind)) {
      throw new Error(`execution work attempt ${input.actionId} is not a gated action`);
    }
    if (action.status !== "completed") {
      if (!["leased", "dispatched", "running"].includes(action.status)) {
        throw new Error(`execution work attempt ${input.actionId} is not active`);
      }
      markActionCompleted(db, { action, resultHash: input.resultHash, outputSubject: input.outputSubject, receipt: input.receipt, timestamp });
    }
    const completedAction = loadActiveAction(db, input.actionId);

    const evaluatorKind: ChildGateEvaluatorKind = input.decision.gateKind === "unit_acceptance"
      ? "human"
      : input.decision.gateKind === "integration"
        ? "publish_subject"
        : "semantic";
    const receiptOutcome = insertGateReceipt(db, now, {
      action: completedAction,
      gateKind: input.decision.gateKind,
      evaluatorKind,
      subject: input.decision.subject,
      result: input.decision.result,
      outcome: input.decision.outcome,
      reason: input.decision.reason,
      artifactHashes: input.decision.artifactHashes,
      payload: input.decision.payload,
      hash: input.decision.hash,
    });
    // A replayed gate decision (same action, same decision) must not re-apply
    // routing -- otherwise a repeated repair decision would double-increment
    // repair_rounds/current_cycle instead of being a no-op.
    if (receiptOutcome === "already_recorded") return completedAction;

    if (completedAction.execution_unit_id) {
      const unitRow = db.prepare(`
        SELECT id, unit_id, repair_rounds FROM execution_units WHERE id = ?
      `).get(completedAction.execution_unit_id) as { id: string; unit_id: string; repair_rounds: number } | undefined;
      if (!unitRow) throw new Error(`execution unit for work attempt ${input.actionId} is missing`);
      const unitClear = db.prepare(`
        UPDATE execution_units SET active_work_attempt_id = NULL, updated_at = ?
        WHERE id = ? AND active_work_attempt_id = ?
      `).run(timestamp, unitRow.id, completedAction.id);
      if (unitClear.changes !== 1) {
        throw new Error(`execution work attempt ${input.actionId} is not the current active action`);
      }

      const graph = graphStmt.get(completedAction.parent_attempt_id) as ExecutionUnitGraph;
      const phases = phaseSequenceOf(graph);
      if (input.decision.gateKind === "unit_acceptance") {
        const routing = routeUnitAcceptanceDecision({
          outcome: input.decision.outcome,
          reason: input.decision.reason,
          repairRounds: unitRow.repair_rounds,
          maxRepairRounds: graph.max_repair_rounds,
        });
        if (routing.action === "integrate") {
          const next = nextUnitPhase("lead", phases);
          if (next !== "integrate") throw new Error(`execution graph ${graph.id} lead phase does not route to integrate`);
          db.prepare(`
            UPDATE execution_units SET phase = ?, accepted_candidate_subject = ?, updated_at = ?
            WHERE id = ?
          `).run(next, input.decision.subject, timestamp, unitRow.id);
        } else if (routing.action === "repair") {
          const repairPhase = phases.find((phase) => phase === "implement");
          if (!repairPhase) throw new Error(`execution graph ${graph.id} repair phase is missing implement`);
          db.prepare(`
            UPDATE execution_units
            SET phase = ?, current_cycle = current_cycle + 1, command_index = 0, repair_rounds = ?, updated_at = ?
            WHERE id = ?
          `).run(repairPhase, routing.repairRounds, timestamp, unitRow.id);
        } else if (routing.action === "settle") {
          settleUnitRow({ parentAttemptId: completedAction.parent_attempt_id, unitId: unitRow.unit_id, reason: "defect", timestamp });
          settleStructurallyBlockedDependents(completedAction.parent_attempt_id, timestamp);
        } else {
          stopActiveWork({ parentAttemptId: completedAction.parent_attempt_id, reason: routing.reason });
        }
      } else if (input.decision.gateKind === "integration") {
        const routing = routeIntegrationDecision({ outcome: input.decision.outcome, reason: input.decision.reason });
        if (routing.action === "settle_completed") {
          db.prepare(`UPDATE execution_units SET integration_subject = ?, updated_at = ? WHERE id = ?`)
            .run(input.decision.subject, timestamp, unitRow.id);
          settleUnitRow({ parentAttemptId: completedAction.parent_attempt_id, unitId: unitRow.unit_id, reason: "acceptance_passed", timestamp });
        } else {
          stopActiveWork({ parentAttemptId: completedAction.parent_attempt_id, reason: routing.reason });
        }
      } else {
        throw new Error(`execution work attempt ${input.actionId} gate kind ${input.decision.gateKind} is not valid for a unit action`);
      }
    } else {
      if (input.decision.gateKind !== "final_review") {
        throw new Error(`execution work attempt ${input.actionId} gate kind ${input.decision.gateKind} is not valid for a final action`);
      }
      const graph = graphStmt.get(completedAction.parent_attempt_id) as ExecutionUnitGraph;
      const routing = routeFinalReviewDecision({
        outcome: input.decision.outcome,
        reason: input.decision.reason,
        repairRounds: graph.final_repair_rounds,
        maxRepairRounds: graph.max_repair_rounds,
      });
      if (routing.action === "done") {
        db.prepare(`
          UPDATE execution_graphs SET final_phase = 'done', final_review_passed_at = ?, updated_at = ? WHERE id = ?
        `).run(timestamp, timestamp, graph.id);
      } else if (routing.action === "repair") {
        db.prepare(`
          UPDATE execution_graphs SET final_phase = 'repair', final_repair_rounds = ?, updated_at = ? WHERE id = ?
        `).run(routing.repairRounds, timestamp, graph.id);
      } else {
        stopActiveWork({ parentAttemptId: completedAction.parent_attempt_id, reason: routing.reason });
      }
    }
    return loadActiveAction(db, input.actionId);
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
      WHERE parent_attempt_id = ? AND status NOT IN ('integrated', 'completed', 'exited', 'failed')
      LIMIT 1
    `).get(input.parentAttemptId);
    if (unfinished) throw new Error(`execution graph ${graph.id} has unfinished units`);
    const hasCompletedUnit = db.prepare(`
      SELECT 1 FROM execution_units WHERE parent_attempt_id = ? AND terminal_level = 'completed' LIMIT 1
    `).get(input.parentAttemptId);
    if (hasCompletedUnit && graph.final_phase !== "done") {
      throw new Error(`execution graph ${graph.id} whole-change final review has not passed`);
    }
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
    const action = db.prepare("SELECT * FROM execution_work_attempts WHERE id = ?")
      .get(input.actionId) as ExecutionWorkAttempt | undefined;
    if (!action) throw new Error(`unknown execution work attempt ${input.actionId}`);
    if (!["leased", "dispatched", "running", "completed"].includes(action.status)) {
      throw new Error(`execution work attempt ${input.actionId} is not receivable`);
    }
    return insertGateReceipt(db, now, {
      action,
      gateKind: input.gateKind,
      evaluatorKind: input.evaluatorKind,
      subject: input.subject,
      result: input.result,
      outcome: input.outcome,
      reason: input.reason,
      artifactHashes: input.artifactHashes,
      payload: input.payload,
      hash: input.hash,
    });
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

  const healExpiredCurrentChildAction = db.transaction((
    input: Parameters<ExecutionUnitStore["healExpiredCurrentChildAction"]>[0]
  ): "healed" | "not_current" => {
    const action = db.prepare(`
      SELECT unit_id FROM execution_work_attempts
      WHERE id = ? AND parent_attempt_id = ? AND status IN ('dispatched', 'running')
        AND lease_until IS NOT NULL AND lease_until <= ?
    `).get(input.actionId, input.parentAttemptId, input.nowIso) as { unit_id: string | null } | undefined;
    if (!action) return "not_current";
    const update = db.prepare(`
      UPDATE execution_work_attempts
      SET status = 'dead', lease_until = NULL, completed_at = COALESCE(completed_at, ?),
          last_error = ?, updated_at = ?
      WHERE id = ? AND parent_attempt_id = ? AND status IN ('dispatched', 'running')
        AND lease_until IS NOT NULL AND lease_until <= ?
        AND (
          unit_id IS NULL
          OR EXISTS (
            SELECT 1 FROM execution_units
            WHERE id = execution_work_attempts.execution_unit_id
              AND active_work_attempt_id = execution_work_attempts.id
          )
        )
    `).run(input.nowIso, input.reason, input.nowIso, input.actionId, input.parentAttemptId, input.nowIso);
    if (update.changes !== 1) return "not_current";
    if (action.unit_id) {
      settleUnitRow({
        parentAttemptId: input.parentAttemptId,
        unitId: action.unit_id,
        reason: "structural_exit",
        timestamp: input.nowIso,
      });
      settleStructurallyBlockedDependents(input.parentAttemptId, input.nowIso);
    } else {
      stopActiveWork({ parentAttemptId: input.parentAttemptId, reason: input.reason });
    }
    return "healed";
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
    completeGatedAction,
    emitAggregateOnce,
    recordGateReceipt,
    listGateReceipts(parentAttemptId) {
      return db.prepare(`
        SELECT * FROM execution_gate_receipts
        WHERE parent_attempt_id = ?
        ORDER BY created_at, id
      `).all(parentAttemptId) as ExecutionGateReceipt[];
    },
    getStructuredExecutionPublication(parentAttemptId) {
      return getStructuredExecutionPublicationForAttempt(db, parentAttemptId);
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
    healExpiredCurrentChildAction,
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
