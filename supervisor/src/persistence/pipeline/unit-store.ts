import type Database from "better-sqlite3";
import {
  canonicalJson,
  type ContextPolicy,
  digestNormalized,
  type PipelineUnitPhaseBinding,
  type StageOutcome,
  unitPhaseBindingCommandNames,
  unitPhaseBindingIds,
} from "../../pipeline/manifest.js";
import { buildExecutionPublicationSnapshot } from "../../pipeline/execution-publication.js";
import type { ExecutionGateDecision } from "../../pipeline/execution-gates.js";
import type { GateReceiptReason } from "../../pipeline/gates.js";
import { createStageRequestHash, type StageRequestEnvelope } from "../../pipeline/stage-request.js";
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
import {
  deterministicId,
  insertExecutionPublicationEvent,
  listExecutionPublicationEvents,
  migrateAggregatePublicationActivity,
} from "./helpers.js";
import {
  createOrResumeFinalAction,
  createOrResumeUnitAction,
  DEFAULT_MAX_REPAIR_ROUNDS,
  commandNamesForUnit,
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
import {
  MAX_DOWNSTREAM_CONTEXT_BYTES as MAX_DOWNSTREAM_CONTEXT_AGGREGATE_BYTES,
  MAX_DOWNSTREAM_CONTEXT_RECORDS,
} from "../../pipeline/structured-loop-limits.js";

export type ExecutionGateKind = ChildGateDecision["gateKind"] | "integration" | "final_review";

function assertGateMatchesAction(action: ExecutionWorkAttempt, gateKind: ExecutionGateKind): void {
  const expectedAction = gateKind === "unit_acceptance"
    ? "lead"
    : gateKind === "integration"
      ? "integrate"
      : "final_review";
  if (action.action_kind !== expectedAction) {
    throw new Error(`execution work attempt ${action.id} action ${action.action_kind} cannot complete ${gateKind} gate`);
  }
}

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
  request_payload?: string | null;
  request_launch_state?: "prepared" | "worktree_ready" | "launched" | null;
  result_hash: string | null;
  terminal_result_outcome: "failure" | "needs_human" | "retryable_infrastructure_failure" | null;
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
  reason: GateReceiptReason;
  artifact_hashes: string;
  payload: string;
  receipt_hash: string;
  created_at: string;
}

export interface PipelineArtifactRecord {
  id: string;
  pipeline_instance_id: string;
  attempt_id: string;
  kind: string;
  schema_version: number;
  assurance: string;
  subject: string | null;
  payload: string;
  artifact_hash: string;
  created_at: string;
}

type MigratedAggregateArtifact = {
  kind: string;
  schemaVersion: number;
  assurance: string;
  subject?: string | null;
  payload: string;
  hash: string;
};

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
  listWorkAttempts(parentAttemptId: string): ExecutionWorkAttempt[];
  leaseNextUnitAction(input: {
    parentAttemptId: string;
    leaseOwner: string;
    nowIso: string;
    leaseUntilIso: string;
  }): ExecutionWorkAttempt | undefined;
  markActionDispatching(actionId: string): void;
  prepareActionDispatch(input: {
    actionId: string;
    requestHash: string;
    requestPayload: string;
    nativeSessionId?: string | null;
  }): ExecutionWorkAttempt;
  markActionWorktreeReady(actionId: string): void;
  markActionDispatched(actionId: string, requestHash: string, nativeSessionId?: string | null): void;
  completeUnitAction(input: {
    actionId: string;
    resultHash: string;
    outputSubject: string;
    receipt?: string;
    nativeSessionId?: string | null;
  }): ExecutionWorkAttempt;
  completeGatedAction(input: {
    actionId: string;
    resultHash: string;
    outputSubject: string;
    receipt?: string;
    nativeSessionId?: string | null;
    decision: ExecutionGateDecision;
  }): ExecutionWorkAttempt;
  failUnitAction(input: {
    actionId: string;
    resultHash: string;
    outcome: "failure" | "needs_human" | "retryable_infrastructure_failure";
    lastError: string;
    nativeSessionId?: string | null;
  }): ExecutionWorkAttempt;
  stopRetryableUnitAction(input: {
    actionId: string;
    resultHash: string;
    lastError: string;
    nativeSessionId?: string | null;
  }): ExecutionWorkAttempt;
  emitAggregateOnce(input: {
    parentAttemptId: string;
    artifactHash: string;
    integrationSubject: string | null;
    emittedAt?: string;
    requireFinalReview?: boolean;
  }): "emitted" | "already_emitted";
  migrateAggregateArtifactHash(input: {
    parentAttemptId: string;
    fromArtifactHash: string;
    toArtifactHash: string;
    fromStageResultHash?: string;
    toStageResultHash?: string;
    canonicalStageArtifact?: MigratedAggregateArtifact;
    canonicalArtifact?: MigratedAggregateArtifact;
    fromSubject?: string;
    toSubject?: string;
    successorStageId?: string;
    publishStageId?: string;
  }): "migrated" | "already_canonical";
  getPipelineArtifactByHash(input: {
    pipelineInstanceId: string;
    attemptId: string;
    kind: string;
    artifactHash: string;
  }): PipelineArtifactRecord | undefined;
  listAggregatePublicationArtifactHashes(parentAttemptId: string): string[];
  recordGateReceipt(input: {
    actionId: string;
    gateKind: ExecutionGateKind;
    evaluatorKind: ChildGateEvaluatorKind;
    subject: string | null;
    result: ChildGateDecision["result"];
    outcome: StageOutcome;
    reason: GateReceiptReason;
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
  // Records that an operator steering reply arrived while this composite
  // run was active and could not be bound to a live child action fence
  // (there is none today -- see docs/SPEC.md "Live steering"), so it stays
  // audit-only instead of vanishing silently when it is later canceled.
  // A no-op when this parent attempt has no execution graph yet.
  recordSteeringCaptured(input: {
    parentAttemptId: string;
    id: string;
    body: string;
  }): void;
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
  getStructuredExecutionPublicationForInstance(pipelineInstanceId: string): ReturnType<typeof buildExecutionPublicationSnapshot>;
}

function buildExecutionPublicationSnapshotForGraph(
  db: Database.Database,
  graph: ExecutionUnitGraph
): ReturnType<typeof buildExecutionPublicationSnapshot> {
  const parentAttemptId = graph.parent_attempt_id;
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
  const activityLog = listExecutionPublicationEvents(db, parentAttemptId).map((event) => ({
    sequence: event.sequence,
    kind: event.kind,
    unit_id: event.unit_id,
    body: event.body,
  }));
  return buildExecutionPublicationSnapshot({
    graph,
    units: listUnitRowsForParentAttempt(db, parentAttemptId).map(unitState),
    attempts: attempts as Array<ExecutionWorkAttempt & { unit_id: string }>,
    gates: gates as Array<ExecutionGateReceipt & { unit_id: string }>,
    downstreamContext,
    activityLog,
  });
}

export function getStructuredExecutionPublicationForAttempt(
  db: Database.Database,
  parentAttemptId: string
): ReturnType<typeof buildExecutionPublicationSnapshot> {
  const graph = db.prepare("SELECT * FROM execution_graphs WHERE parent_attempt_id = ?")
    .get(parentAttemptId) as ExecutionUnitGraph | undefined;
  if (!graph) return undefined;
  return buildExecutionPublicationSnapshotForGraph(db, graph);
}

// The pipeline coordinator renders the structured ledger from whichever
// attempt is currently transitioning -- which, once the composite/structured
// stage hands off to a later stage (e.g. publish), is a different attempt id
// than the one that owns the execution graph. Each generation is its own
// pipeline_instances row (see supersedeOtherInstances), so the latest graph
// for this instance is unambiguously this generation's structured execution,
// independent of which attempt is currently active. Shared with
// run-outcome-store.ts's settlement rollup, which needs the same row for its
// graph id/plan digest join keys -- one tie-break definition for "the" graph
// of a pipeline instance, not two that could drift apart.
export function getLatestExecutionGraphForInstance(
  db: Database.Database,
  pipelineInstanceId: string
): ExecutionUnitGraph | undefined {
  return db.prepare(`
    SELECT * FROM execution_graphs WHERE pipeline_instance_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(pipelineInstanceId) as ExecutionUnitGraph | undefined;
}

export function getStructuredExecutionPublicationForInstance(
  db: Database.Database,
  pipelineInstanceId: string
): ReturnType<typeof buildExecutionPublicationSnapshot> {
  const graph = getLatestExecutionGraphForInstance(db, pipelineInstanceId);
  if (!graph) return undefined;
  return buildExecutionPublicationSnapshotForGraph(db, graph);
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
    const graph = graphStmt.get(input.parentAttemptId) as ExecutionUnitGraph;
    insertExecutionPublicationEvent({
      db,
      id: deterministicId("execution-activity-unit-settled", [input.parentAttemptId, input.unitId]),
      graph,
      unitId: input.unitId,
      kind: "unit_settled",
      body: `Unit ${input.unitId} ${terminal.terminalLevel}${terminal.alarm ? " (alarm)" : ""}: ${input.reason}.`,
      timestamp: input.timestamp,
    });
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

  function acceptedDownstreamContextRecords(input: {
    parentAttemptId: string;
    unitId: string;
    cycle: number;
  }): Array<{ toUnitId: string; payload: Record<string, unknown> }> {
    const rows = listUnitRows(input.parentAttemptId);
    const rowByUnitId = new Map(rows.map((row) => [row.unit_id, row]));
    const declaredDependents = new Set(rows
      .filter((row) => dependenciesFor(row).includes(input.unitId))
      .map((row) => row.unit_id));
    const receiptRows = db.prepare(`
      SELECT receipt FROM execution_work_attempts
      WHERE parent_attempt_id = ? AND unit_id = ? AND cycle = ? AND status = 'completed'
        AND action_kind IN ('implement', 'repair', 'lead') AND receipt IS NOT NULL
      ORDER BY created_at, id
    `).all(input.parentAttemptId, input.unitId, input.cycle) as Array<{ receipt: string }>;
    const records: Array<{ toUnitId: string; payload: Record<string, unknown> }> = [];
    for (const row of receiptRows) {
      const receipt = JSON.parse(row.receipt) as {
        type?: string;
        payload?: {
          downstream_context?: Array<{ unit_id: string; summary: string }>;
          context_updates?: Array<{ unit_id: string; summary: string }>;
        };
      };
      const contextRecords = receipt.type === "unit_completion"
        ? receipt.payload?.downstream_context ?? []
        : receipt.type === "unit_decision"
          ? receipt.payload?.context_updates ?? []
          : [];
      for (const record of contextRecords) {
        const target = rowByUnitId.get(record.unit_id);
        if (!target) throw new Error(`unknown downstream context target ${record.unit_id}`);
        if (!declaredDependents.has(record.unit_id)) {
          throw new Error(`downstream context target ${record.unit_id} is not a declared dependent of ${input.unitId}`);
        }
        if (target.status !== "pending" || target.terminal_level !== null) {
          throw new Error(`downstream context target ${record.unit_id} is not pending`);
        }
        records.push({
          toUnitId: record.unit_id,
          payload: {
            schema: "openthrottle.downstream-context/v1",
            from_unit_id: input.unitId,
            summary: record.summary,
          },
        });
      }
    }
    return records;
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
      command_names: [...(unit.commandNames ?? phaseProjection.commandNames)],
    }));
    const actualUnits = listUnitRows(input.parentAttemptId).map((row) => canonicalJson({
      unit_id: row.unit_id,
      authored_order: row.authored_order,
      dependency_unit_ids: dependenciesFor(row),
      command_names: commandNamesForUnit(row),
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
  }

  function assertCompletedActionReplayMatches(input: {
    action: ExecutionWorkAttempt;
    resultHash: string;
    outputSubject: string;
    receipt?: string;
    nativeSessionId?: string | null;
  }): void {
    const receiptHash = input.receipt === undefined ? null : digestNormalized(input.receipt);
    if (
      input.action.result_hash !== input.resultHash ||
      input.action.output_subject !== input.outputSubject ||
      input.action.receipt_hash !== receiptHash ||
      (input.receipt !== undefined && input.action.receipt !== input.receipt) ||
      (input.nativeSessionId !== undefined && input.action.native_session_id !== input.nativeSessionId)
    ) {
      throw new Error(`execution work attempt ${input.action.id} already completed with a different result`);
    }
  }

  function assertTerminalActionReplayMatches(input: {
    action: ExecutionWorkAttempt;
    status: "failed" | "dead";
    outcome: "failure" | "needs_human" | "retryable_infrastructure_failure";
    resultHash: string;
    nativeSessionId?: string | null;
    lastError: string;
  }): void {
    if (
      input.action.status !== input.status ||
      input.action.terminal_result_outcome !== input.outcome ||
      input.action.result_hash !== input.resultHash ||
      input.action.last_error !== input.lastError ||
      (input.nativeSessionId !== undefined && input.action.native_session_id !== input.nativeSessionId)
    ) {
      throw new Error(`execution work attempt ${input.action.id} already terminated with a different result`);
    }
  }

  function assertPreparedRequestReplayMatches(input: {
    action: ExecutionWorkAttempt;
    requestHash: string;
    requestPayload: string;
    nativeSessionId?: string | null;
  }): void {
    if (
      input.action.request_hash !== input.requestHash ||
      input.action.request_payload !== input.requestPayload ||
      (input.nativeSessionId !== undefined &&
        input.nativeSessionId !== null &&
        input.action.native_session_id !== null &&
        input.action.native_session_id !== input.nativeSessionId)
    ) {
      throw new Error(
        `execution work attempt ${input.action.id} already prepared a different request ` +
        `(existing_hash=${input.action.request_hash ?? "<none>"} new_hash=${input.requestHash} ` +
        `existing_payload=${input.action.request_payload == null ? "<none>" : "present"})`
      );
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
      commandNames: input.commandNames ? [...input.commandNames] : unitPhaseBindingCommandNames(unitPhaseBindings),
      unitPhases: unitPhaseBindingIds(unitPhaseBindings),
      unitPhaseBindings,
    };
  }

  const createGraph = db.transaction((input: Parameters<ExecutionUnitStore["createGraph"]>[0]): ExecutionUnitGraph => {
    const timestamp = now();
    const graphId = deterministicId("execution-graph", [input.pipelineInstanceId, input.parentAttemptId]);
    const phaseProjection = unitPhaseProjection(input);
    assertValidUnitPhaseSequence(phaseProjection.unitPhases);
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
      const unitCommandNames = canonicalJson([...(unit.commandNames ?? phaseProjection.commandNames)]);
      db.prepare(`
        INSERT INTO execution_units (
          id, execution_graph_id, pipeline_instance_id, parent_attempt_id, unit_id,
          authored_order, dependency_unit_ids, command_names, status, phase, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        ON CONFLICT(parent_attempt_id, unit_id) DO NOTHING
      `).run(
        deterministicId("execution-unit", [input.parentAttemptId, unit.id]),
        graphId,
        input.pipelineInstanceId,
        input.parentAttemptId,
        unit.id,
        index,
        canonicalJson([...(unit.dependencies ?? [])].sort()),
        unitCommandNames,
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
        AND request_hash IS NULL
        AND lease_until IS NOT NULL AND lease_until <= ?
    `).run(input.nowIso, input.parentAttemptId, input.nowIso);
    const prepared = db.prepare(`
      SELECT * FROM execution_work_attempts
      WHERE parent_attempt_id = ? AND status = 'leased' AND request_hash IS NOT NULL
      ORDER BY created_at, id
      LIMIT 1
    `).get(input.parentAttemptId) as ExecutionWorkAttempt | undefined;
    if (prepared) return prepared;
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
    if (action.status === "completed") {
      assertCompletedActionReplayMatches({ action, ...input });
      return action;
    }
    if (!["leased", "dispatched", "running"].includes(action.status)) {
      throw new Error(`execution work attempt ${input.actionId} is not active`);
    }
    if (GATED_ACTION_KINDS.has(action.action_kind)) {
      throw new Error(`execution work attempt ${input.actionId} requires a gate decision to complete`);
    }
    markActionCompleted(db, {
      action,
      resultHash: input.resultHash,
      outputSubject: input.outputSubject,
      receipt: input.receipt,
      nativeSessionId: input.nativeSessionId,
      timestamp,
    });

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
        db.prepare(`UPDATE execution_graphs SET updated_at = ? WHERE id = ?`)
          .run(timestamp, action.execution_graph_id);
      } else if (action.action_kind === "candidate") {
        db.prepare(`UPDATE execution_graphs SET updated_at = ? WHERE id = ?`)
          .run(timestamp, action.execution_graph_id);
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
    if (action.status === "completed") {
      assertCompletedActionReplayMatches({ action, ...input });
    }
    if (action.status !== "completed") {
      if (!["leased", "dispatched", "running"].includes(action.status)) {
        throw new Error(`execution work attempt ${input.actionId} is not active`);
      }
      markActionCompleted(db, {
        action,
        resultHash: input.resultHash,
        outputSubject: input.outputSubject,
        receipt: input.receipt,
        nativeSessionId: input.nativeSessionId,
        timestamp,
      });
    }
    const completedAction = loadActiveAction(db, input.actionId);
    assertGateMatchesAction(completedAction, input.decision.gateKind);

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
          db.prepare(`
            UPDATE execution_units
            SET phase = ?, current_cycle = current_cycle + 1, command_index = 0, repair_rounds = ?, updated_at = ?
            WHERE id = ?
          `).run("implement", routing.repairRounds, timestamp, unitRow.id);
          insertExecutionPublicationEvent({
            db,
            id: deterministicId("execution-activity-unit-repair", [
              completedAction.parent_attempt_id, unitRow.unit_id, routing.repairRounds,
            ]),
            graph,
            unitId: unitRow.unit_id,
            kind: "unit_repair",
            body: `Unit ${unitRow.unit_id} needs another implementation pass (repair round ${routing.repairRounds}/${graph.max_repair_rounds}): ${input.decision.reason}.`,
            timestamp,
          });
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
          db.prepare(`UPDATE execution_graphs SET integration_subject = ?, updated_at = ? WHERE parent_attempt_id = ?`)
            .run(input.decision.subject, timestamp, completedAction.parent_attempt_id);
          settleUnitRow({ parentAttemptId: completedAction.parent_attempt_id, unitId: unitRow.unit_id, reason: "acceptance_passed", timestamp });
          const contextRecords = acceptedDownstreamContextRecords({
            parentAttemptId: completedAction.parent_attempt_id,
            unitId: unitRow.unit_id,
            cycle: completedAction.cycle,
          });
          if (contextRecords.length > 0) {
            appendDownstreamContext({
              parentAttemptId: completedAction.parent_attempt_id,
              fromUnitId: unitRow.unit_id,
              records: contextRecords,
            });
          }
        } else {
          stopActiveWork({ parentAttemptId: completedAction.parent_attempt_id, reason: routing.reason });
        }
      } else {
        throw new Error(`execution work attempt ${input.actionId} gate kind ${input.decision.gateKind} is not valid for a unit action`);
      }
    } else {
      const graph = graphStmt.get(completedAction.parent_attempt_id) as ExecutionUnitGraph;
      if (input.decision.gateKind === "integration") {
        const routing = routeIntegrationDecision({ outcome: input.decision.outcome, reason: input.decision.reason });
        if (routing.action === "settle_completed") {
          db.prepare(`
            UPDATE execution_graphs SET integration_subject = ?, final_phase = 'command',
              final_command_index = 0, final_cycle = final_cycle + 1, updated_at = ?
            WHERE id = ?
          `).run(input.decision.subject, timestamp, graph.id);
        } else {
          stopActiveWork({ parentAttemptId: completedAction.parent_attempt_id, reason: routing.reason });
        }
        return loadActiveAction(db, input.actionId);
      }
      if (input.decision.gateKind !== "final_review") {
        throw new Error(`execution work attempt ${input.actionId} gate kind ${input.decision.gateKind} is not valid for a final action`);
      }
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
        insertExecutionPublicationEvent({
          db,
          id: deterministicId("execution-activity-final-review", [completedAction.parent_attempt_id, "done"]),
          graph,
          unitId: null,
          kind: "final_review",
          body: `Whole-change final review passed for ${completedAction.parent_attempt_id}.`,
          timestamp,
        });
      } else if (routing.action === "repair") {
        db.prepare(`
          UPDATE execution_graphs SET final_phase = 'repair', final_repair_rounds = ?, updated_at = ? WHERE id = ?
        `).run(routing.repairRounds, timestamp, graph.id);
        insertExecutionPublicationEvent({
          db,
          id: deterministicId("execution-activity-final-review", [completedAction.parent_attempt_id, "repair", routing.repairRounds]),
          graph,
          unitId: null,
          kind: "final_review",
          body: `Whole-change final review needs another repair pass (round ${routing.repairRounds}/${graph.max_repair_rounds}): ${input.decision.reason}.`,
          timestamp,
        });
      } else {
        stopActiveWork({ parentAttemptId: completedAction.parent_attempt_id, reason: routing.reason });
      }
    }
    return loadActiveAction(db, input.actionId);
  });

  const failUnitAction = db.transaction((
    input: Parameters<ExecutionUnitStore["failUnitAction"]>[0]
  ): ExecutionWorkAttempt => {
    const timestamp = now();
    const action = loadActiveAction(db, input.actionId);
    const lastError = input.lastError.slice(0, 2_000);
    if (action.status === "failed") {
      assertTerminalActionReplayMatches({
        action,
        status: "failed",
        outcome: input.outcome,
        resultHash: input.resultHash,
        nativeSessionId: input.nativeSessionId,
        lastError,
      });
      return action;
    }
    if (action.status === "dead") {
      throw new Error(`execution work attempt ${input.actionId} already terminated with a different result`);
    }
    if (!["leased", "dispatched", "running"].includes(action.status)) {
      throw new Error(`execution work attempt ${input.actionId} is not active`);
    }
    const update = db.prepare(`
      UPDATE execution_work_attempts
      SET status = 'failed', result_hash = ?, terminal_result_outcome = ?,
          native_session_id = COALESCE(?, native_session_id),
          lease_until = NULL, last_error = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('leased', 'dispatched', 'running')
    `).run(input.resultHash, input.outcome, input.nativeSessionId ?? null, lastError, timestamp, timestamp, input.actionId);
    if (update.changes !== 1) throw new Error(`execution work attempt ${input.actionId} failure compare-and-set failed`);
    if (action.execution_unit_id && action.unit_id) {
      const unitUpdate = db.prepare(`
        UPDATE execution_units SET active_work_attempt_id = NULL, updated_at = ?
        WHERE id = ? AND active_work_attempt_id = ?
      `).run(timestamp, action.execution_unit_id, action.id);
      if (unitUpdate.changes !== 1) {
        throw new Error(`execution work attempt ${input.actionId} is not the current active action`);
      }
      settleUnitRow({
        parentAttemptId: action.parent_attempt_id,
        unitId: action.unit_id,
        reason: input.outcome === "needs_human" ? "structural_exit" : "defect",
        timestamp,
      });
      settleStructurallyBlockedDependents(action.parent_attempt_id, timestamp);
    } else {
      stopActiveWork({ parentAttemptId: action.parent_attempt_id, reason: lastError });
    }
    return loadActiveAction(db, input.actionId);
  });

  const stopRetryableUnitAction = db.transaction((
    input: Parameters<ExecutionUnitStore["stopRetryableUnitAction"]>[0]
  ): ExecutionWorkAttempt => {
    const timestamp = now();
    const action = loadActiveAction(db, input.actionId);
    const lastError = `retryable_infrastructure_failure: ${input.lastError}`.slice(0, 2_000);
    if (action.status === "dead") {
      assertTerminalActionReplayMatches({
        action,
        status: "dead",
        outcome: "retryable_infrastructure_failure",
        resultHash: input.resultHash,
        nativeSessionId: input.nativeSessionId,
        lastError,
      });
      return action;
    }
    if (action.status === "failed") {
      throw new Error(`execution work attempt ${input.actionId} already terminated with a different result`);
    }
    if (!["leased", "dispatched", "running"].includes(action.status)) {
      throw new Error(`execution work attempt ${input.actionId} is not active`);
    }
    const update = db.prepare(`
      UPDATE execution_work_attempts
      SET status = 'dead', result_hash = ?, terminal_result_outcome = 'retryable_infrastructure_failure',
          native_session_id = COALESCE(?, native_session_id),
          lease_until = NULL, last_error = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('leased', 'dispatched', 'running')
    `).run(input.resultHash, input.nativeSessionId ?? null, lastError, timestamp, timestamp, input.actionId);
    if (update.changes !== 1) throw new Error(`execution work attempt ${input.actionId} retryable stop compare-and-set failed`);
    const graph = graphStmt.get(action.parent_attempt_id) as ExecutionUnitGraph | undefined;
    if (graph && !graph.aggregate_emitted_at && !graph.stopped_at) {
      db.prepare(`
        UPDATE execution_graphs
        SET stopped_at = ?, stop_reason = ?, updated_at = ?
        WHERE parent_attempt_id = ? AND stopped_at IS NULL
      `).run(timestamp, lastError, timestamp, action.parent_attempt_id);
      insertExecutionPublicationEvent({
        db,
        id: deterministicId("execution-activity-graph-stopped", [action.parent_attempt_id]),
        graph,
        unitId: null,
        kind: "graph_stopped",
        body: `Structured execution stopped: ${lastError}.`,
        timestamp,
      });
    }
    db.prepare(`
      UPDATE execution_units
      SET status = 'exited', terminal_level = 'exited', alarm = 0,
          active_work_attempt_id = NULL, updated_at = ?
      WHERE parent_attempt_id = ? AND terminal_level IS NULL
    `).run(timestamp, action.parent_attempt_id);
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
    if ((input.requireFinalReview ?? true) && hasCompletedUnit && graph.final_phase !== "done") {
      throw new Error(`execution graph ${graph.id} whole-change final review has not passed`);
    }
    const timestamp = input.emittedAt ?? now();
    const update = db.prepare(`
      UPDATE execution_graphs
      SET aggregate_artifact_hash = ?, aggregate_emitted_at = ?,
          integration_subject = ?, updated_at = ?
      WHERE parent_attempt_id = ? AND aggregate_emitted_at IS NULL
    `).run(input.artifactHash, timestamp, input.integrationSubject, timestamp, input.parentAttemptId);
    if (update.changes !== 1) throw new Error(`execution graph ${graph.id} aggregate compare-and-set failed`);
    const integratedUnits = (db.prepare(`
      SELECT COUNT(*) AS count FROM execution_units WHERE parent_attempt_id = ? AND terminal_level = 'completed'
    `).get(input.parentAttemptId) as { count: number }).count;
    insertExecutionPublicationEvent({
      db,
      id: deterministicId("execution-activity-aggregate", [input.parentAttemptId]),
      graph,
      unitId: null,
      kind: "aggregate",
      body: `Structured execution complete: ${integratedUnits} unit(s) integrated, aggregate ${input.artifactHash}.`,
      timestamp,
    });
    return "emitted";
  });

  function persistCanonicalMigratedArtifact(input: {
    graph: ExecutionUnitGraph;
    parentAttemptId: string;
    toArtifactHash: string;
    artifact: MigratedAggregateArtifact;
  }): void {
    if (
      input.artifact.hash !== input.toArtifactHash ||
      digestNormalized(input.artifact.payload) !== input.artifact.hash
    ) {
      throw new Error(`execution graph ${input.graph.id} canonical ${input.artifact.kind} artifact does not match migration target`);
    }
    const artifactId = deterministicId("artifact", [
      input.graph.pipeline_instance_id,
      input.parentAttemptId,
      input.artifact.kind,
      input.artifact.hash,
    ]);
    const existingArtifact = db.prepare(`
      SELECT pipeline_instance_id, attempt_id, kind, schema_version, assurance,
             subject, payload, artifact_hash
      FROM pipeline_artifacts WHERE id = ?
    `).get(artifactId) as
      | {
        pipeline_instance_id: string;
        attempt_id: string;
        kind: string;
        schema_version: number;
        assurance: string;
        subject: string | null;
        payload: string;
        artifact_hash: string;
      }
      | undefined;
    if (existingArtifact) {
      if (
        existingArtifact.pipeline_instance_id !== input.graph.pipeline_instance_id ||
        existingArtifact.attempt_id !== input.parentAttemptId ||
        existingArtifact.kind !== input.artifact.kind ||
        existingArtifact.schema_version !== input.artifact.schemaVersion ||
        existingArtifact.assurance !== input.artifact.assurance ||
        existingArtifact.subject !== (input.artifact.subject ?? null) ||
        existingArtifact.payload !== input.artifact.payload ||
        existingArtifact.artifact_hash !== input.artifact.hash
      ) {
        throw new Error(`execution graph ${input.graph.id} canonical ${input.artifact.kind} artifact conflicts with durable evidence`);
      }
      return;
    }
    db.prepare(`
      INSERT INTO pipeline_artifacts (
        id, pipeline_instance_id, attempt_id, kind, schema_version,
        assurance, subject, payload, artifact_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifactId,
      input.graph.pipeline_instance_id,
      input.parentAttemptId,
      input.artifact.kind,
      input.artifact.schemaVersion,
      input.artifact.assurance,
      input.artifact.subject ?? null,
      input.artifact.payload,
      input.artifact.hash,
      now()
    );
  }

  const migrateAggregateArtifactHash = db.transaction((
    input: Parameters<ExecutionUnitStore["migrateAggregateArtifactHash"]>[0]
  ): "migrated" | "already_canonical" => {
    const graph = graphStmt.get(input.parentAttemptId) as ExecutionUnitGraph | undefined;
    if (!graph) throw new Error(`execution graph for parent attempt ${input.parentAttemptId} is missing`);
    if (!graph.aggregate_emitted_at) {
      throw new Error(`execution graph ${graph.id} has no aggregate marker to migrate`);
    }
    if (input.canonicalArtifact?.kind !== undefined && input.canonicalArtifact.kind !== "execution_graph_result") {
      throw new Error(`execution graph ${graph.id} canonical aggregate artifact has wrong kind`);
    }
    if (input.canonicalStageArtifact?.kind !== undefined && input.canonicalStageArtifact.kind !== "stage_result") {
      throw new Error(`execution graph ${graph.id} canonical stage artifact has wrong kind`);
    }
    if (input.canonicalArtifact) {
      persistCanonicalMigratedArtifact({
        graph,
        parentAttemptId: input.parentAttemptId,
        toArtifactHash: input.toArtifactHash,
        artifact: input.canonicalArtifact,
      });
    }
    if (input.canonicalStageArtifact) {
      if (!input.fromStageResultHash || !input.toStageResultHash) {
        throw new Error(`execution graph ${graph.id} canonical stage artifact migration is missing stage hashes`);
      }
      persistCanonicalMigratedArtifact({
        graph,
        parentAttemptId: input.parentAttemptId,
        toArtifactHash: input.toStageResultHash,
        artifact: input.canonicalStageArtifact,
      });
      const attempt = db.prepare(`
        SELECT result_hash FROM pipeline_stage_attempts
        WHERE id = ? AND pipeline_instance_id = ?
      `).get(input.parentAttemptId, graph.pipeline_instance_id) as { result_hash: string | null } | undefined;
      if (!attempt) throw new Error(`parent attempt ${input.parentAttemptId} is missing for aggregate migration`);
      if (attempt.result_hash === input.toStageResultHash) {
        // Already migrated by a prior replay; keep the rest of the transaction idempotent.
      } else if (attempt.result_hash !== input.fromStageResultHash) {
        throw new Error(`parent attempt ${input.parentAttemptId} result hash does not match migration source`);
      } else {
        const attemptUpdate = db.prepare(`
          UPDATE pipeline_stage_attempts
          SET result_hash = ?, updated_at = ?
          WHERE id = ? AND pipeline_instance_id = ? AND result_hash = ?
        `).run(input.toStageResultHash, now(), input.parentAttemptId, graph.pipeline_instance_id, input.fromStageResultHash);
        if (attemptUpdate.changes !== 1) {
          throw new Error(`parent attempt ${input.parentAttemptId} result hash compare-and-set failed`);
        }
      }
    }
    const migrateActivity = (timestamp: string) => migrateAggregatePublicationActivity({
      db,
      graph,
      fromArtifactHash: input.fromArtifactHash,
      toArtifactHash: input.toArtifactHash,
      timestamp,
    });
    const migrateDownstream = () => {
      if (!input.fromSubject || !input.toSubject) return;
      migrateAggregateDownstreamStage({
        db,
        graph,
        fromSubject: input.fromSubject,
        toSubject: input.toSubject,
        stageId: input.successorStageId ?? input.publishStageId,
      });
    };
    if (graph.aggregate_artifact_hash === input.toArtifactHash) {
      migrateActivity(now());
      migrateDownstream();
      return "already_canonical";
    }
    if (graph.aggregate_artifact_hash !== input.fromArtifactHash) {
      throw new Error(`execution graph ${graph.id} aggregate marker does not match migration source`);
    }
    const timestamp = now();
    const update = db.prepare(`
      UPDATE execution_graphs
      SET aggregate_artifact_hash = ?, updated_at = ?
      WHERE parent_attempt_id = ?
        AND aggregate_emitted_at IS NOT NULL
        AND aggregate_artifact_hash = ?
    `).run(input.toArtifactHash, timestamp, input.parentAttemptId, input.fromArtifactHash);
    if (update.changes === 1) {
      migrateActivity(timestamp);
      migrateDownstream();
      return "migrated";
    }
    const current = graphStmt.get(input.parentAttemptId) as ExecutionUnitGraph | undefined;
    if (current?.aggregate_artifact_hash === input.toArtifactHash) {
      migrateDownstream();
      return "already_canonical";
    }
    throw new Error(`execution graph ${graph.id} aggregate marker compare-and-set failed`);
  });

  function migrateAggregateDownstreamStage(input: {
    db: Database.Database;
    graph: ExecutionUnitGraph;
    fromSubject: string;
    toSubject: string;
    stageId?: string;
  }): void {
    if (!input.stageId) return;
    const stageId = input.stageId;
    const nativeSessionForMigratedRequest = (
      policy: ContextPolicy,
      existingNativeSessionId: string | null
    ): string | null => {
      if (policy === "resume_required") {
        if (!existingNativeSessionId) {
          throw new Error(`downstream stage ${stageId} requires a native session for aggregate migration`);
        }
        return existingNativeSessionId;
      }
      if (policy === "prefer_resume") return existingNativeSessionId;
      if (policy === "fresh" || policy === "none") return null;
      throw new Error(`downstream stage ${stageId} has unsupported native context policy ${String(policy)}`);
    };
    const downstreamAttempts = input.db.prepare(`
      SELECT id, request_hash, idempotency_key, request_payload, planned_run_id,
             expected_subject, native_context_policy, native_session_id, status, run_id
      FROM pipeline_stage_attempts
      WHERE pipeline_instance_id = ? AND stage_id = ?
        AND status NOT IN ('completed', 'canceled', 'superseded', 'failed')
      ORDER BY attempt_ordinal, reentry_ordinal, created_at, id
    `).all(input.graph.pipeline_instance_id, stageId) as Array<{
      id: string;
      request_hash: string;
      idempotency_key: string;
      request_payload: string | null;
      planned_run_id: string | null;
      expected_subject: string | null;
      native_context_policy: ContextPolicy;
      native_session_id: string | null;
      status: string;
      run_id: string | null;
    }>;
    if (downstreamAttempts.length === 0) return;

    const instance = input.db.prepare(`
      SELECT immutable_subject FROM pipeline_instances WHERE id = ?
    `).get(input.graph.pipeline_instance_id) as { immutable_subject: string | null } | undefined;
    if (!instance) throw new Error(`pipeline instance ${input.graph.pipeline_instance_id} is missing`);
    if (instance.immutable_subject === input.fromSubject) {
      const instanceUpdate = input.db.prepare(`
        UPDATE pipeline_instances
        SET immutable_subject = ?,
            status = CASE WHEN active_stage_id = ? AND status = 'running' THEN 'dispatchable' ELSE status END
        WHERE id = ? AND immutable_subject = ?
      `).run(input.toSubject, stageId, input.graph.pipeline_instance_id, input.fromSubject);
      if (instanceUpdate.changes !== 1) {
        throw new Error(`execution graph ${input.graph.id} publication subject compare-and-set failed`);
      }
    } else if (instance.immutable_subject !== input.toSubject) {
      throw new Error(`execution graph ${input.graph.id} publication subject does not match migration source`);
    }

    for (const attempt of downstreamAttempts) {
      if (!attempt.request_payload) {
        throw new Error(`downstream attempt ${attempt.id} has no sealed request`);
      }
      const request = JSON.parse(attempt.request_payload) as StageRequestEnvelope;
      if (request.stageId !== stageId || request.attemptId !== attempt.id ||
          request.requestHash !== attempt.request_hash ||
          request.idempotencyKey !== attempt.idempotency_key ||
          request.runId !== attempt.planned_run_id ||
          request.contextPolicy !== attempt.native_context_policy ||
          request.nativeSessionId !== attempt.native_session_id ||
          request.expectedSubject !== attempt.expected_subject) {
        throw new Error(`downstream attempt ${attempt.id} stage request binding mismatch`);
      }
      if (attempt.expected_subject !== input.fromSubject && attempt.expected_subject !== input.toSubject) {
        throw new Error(`downstream attempt ${attempt.id} expected subject does not match aggregate migration`);
      }
      const withoutFence = (({ requestHash, idempotencyKey, ...rest }: StageRequestEnvelope) => {
        void requestHash;
        void idempotencyKey;
        return rest;
      })(request);
      const updatedRunId = attempt.run_id && attempt.expected_subject === input.fromSubject
        ? deterministicId("run", [attempt.id, input.toSubject, "aggregate-publication-restart"])
        : withoutFence.runId;
      const updatedWithoutFence = {
        ...withoutFence,
        runId: updatedRunId,
        expectedSubject: input.toSubject,
        nativeSessionId: nativeSessionForMigratedRequest(request.contextPolicy, attempt.native_session_id),
      };
      const updatedFence = createStageRequestHash(updatedWithoutFence);
      const updatedRequest = canonicalJson({ ...updatedWithoutFence, ...updatedFence });
      const oldEffectPayloadHash = digestNormalized(attempt.request_payload);
      const updatedEffectPayloadHash = digestNormalized(updatedRequest);

      if (attempt.expected_subject === input.fromSubject) {
        const attemptUpdate = input.db.prepare(`
          UPDATE pipeline_stage_attempts
          SET expected_subject = ?, request_hash = ?, idempotency_key = ?,
              planned_run_id = ?, run_id = NULL, native_session_id = ?,
              request_payload = ?, status = CASE WHEN status = 'running' THEN 'pending' ELSE status END
          WHERE id = ? AND request_hash = ? AND status NOT IN ('completed', 'canceled', 'superseded', 'failed')
        `).run(
          input.toSubject,
          updatedFence.requestHash,
          updatedFence.idempotencyKey,
          updatedRunId,
          updatedWithoutFence.nativeSessionId,
          updatedRequest,
          attempt.id,
          attempt.request_hash
        );
        if (attemptUpdate.changes !== 1) {
          throw new Error(`downstream attempt ${attempt.id} aggregate subject compare-and-set failed`);
        }
        input.db.prepare(`
          UPDATE pipeline_instance_stages
          SET status = CASE WHEN status = 'running' THEN 'dispatchable' ELSE status END
          WHERE pipeline_instance_id = ? AND stage_id = ?
        `).run(input.graph.pipeline_instance_id, stageId);
      } else if (
        attempt.request_hash !== updatedFence.requestHash ||
        attempt.idempotency_key !== updatedFence.idempotencyKey ||
        attempt.request_payload !== updatedRequest
      ) {
        throw new Error(`downstream attempt ${attempt.id} canonical request binding mismatch`);
      }

      let effect = input.db.prepare(`
        SELECT id, payload, payload_hash, idempotency_key, status
        FROM pipeline_effect_intents
        WHERE pipeline_instance_id = ? AND kind = 'dispatch_stage'
          AND status NOT IN ('acknowledged', 'dead')
          AND (idempotency_key IN (?, ?) OR payload_hash IN (?, ?))
        ORDER BY transition_version, created_at, id
        LIMIT 1
      `).get(
        input.graph.pipeline_instance_id,
        attempt.idempotency_key,
        updatedFence.idempotencyKey,
        oldEffectPayloadHash,
        updatedEffectPayloadHash
      ) as | {
        id: string;
        payload: string;
        payload_hash: string;
        idempotency_key: string;
        status: string;
      } | undefined;
      if (!effect && attempt.expected_subject === input.fromSubject) {
        const timestamp = now();
        const newEffectId = deterministicId("effect", [
          input.graph.pipeline_instance_id,
          attempt.id,
          updatedFence.idempotencyKey,
          "aggregate-publication-restart",
        ]);
        input.db.prepare(`
          INSERT INTO pipeline_effect_intents (
            id, pipeline_instance_id, transition_version, kind, idempotency_key,
            payload, payload_hash, status, attempts, next_attempt_at, created_at
          ) VALUES (?, ?, (
              SELECT COALESCE(MAX(transition_version), 0) + 1
              FROM pipeline_effect_intents WHERE pipeline_instance_id = ?
            ), 'dispatch_stage', ?, ?, ?, 'pending', 0, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `).run(
          newEffectId,
          input.graph.pipeline_instance_id,
          input.graph.pipeline_instance_id,
          updatedFence.idempotencyKey,
          updatedRequest,
          updatedEffectPayloadHash,
          timestamp,
          timestamp
        );
        effect = input.db.prepare("SELECT id, payload, payload_hash, idempotency_key, status FROM pipeline_effect_intents WHERE id = ?")
          .get(newEffectId) as typeof effect;
      }
      if (!effect && attempt.expected_subject === input.toSubject) continue;
      if (!effect) {
        throw new Error(`downstream attempt ${attempt.id} has no migratable dispatch effect`);
      }
      if (effect.status !== "pending" && effect.status !== "failed" && effect.status !== "processing") {
        throw new Error(`downstream attempt ${attempt.id} dispatch effect is already leased`);
      }
      if (effect.payload === updatedRequest && effect.idempotency_key === updatedFence.idempotencyKey) continue;
      if (effect.payload !== attempt.request_payload || effect.idempotency_key !== attempt.idempotency_key) {
        throw new Error(`downstream attempt ${attempt.id} dispatch effect does not match migration source`);
      }
      const effectUpdate = input.db.prepare(`
        UPDATE pipeline_effect_intents
        SET idempotency_key = ?, payload = ?, payload_hash = ?, attempts = 0, last_error = NULL
        WHERE id = ? AND status IN ('pending', 'failed', 'processing') AND payload_hash = ?
      `).run(
        updatedFence.idempotencyKey,
        updatedRequest,
        updatedEffectPayloadHash,
        effect.id,
        effect.payload_hash
      );
      if (effectUpdate.changes !== 1) {
        throw new Error(`downstream attempt ${attempt.id} dispatch effect compare-and-set failed`);
      }
    }
  }

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
    const existingByTarget = new Map<string, Array<{ fromUnitId: string; payloadHash: string; payload: Record<string, unknown> }>>();
    const existingRows = db.prepare(`
      SELECT from_unit_id, to_unit_id, payload_hash, payload
      FROM execution_downstream_context
      WHERE parent_attempt_id = ?
      ORDER BY created_at, id
    `).all(input.parentAttemptId) as Array<{
      from_unit_id: string;
      to_unit_id: string;
      payload_hash: string;
      payload: string;
    }>;
    for (const row of existingRows) {
      const records = existingByTarget.get(row.to_unit_id) ?? [];
      records.push({
        fromUnitId: row.from_unit_id,
        payloadHash: row.payload_hash,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      });
      existingByTarget.set(row.to_unit_id, records);
    }
    const candidateByTarget = new Map(existingByTarget);
    for (const record of decision.records) {
      const targetRecords = [...(candidateByTarget.get(record.toUnitId) ?? [])];
      const wireRecord = {
        fromUnitId: record.fromUnitId,
        payloadHash: record.payloadHash,
        payload: record.payload,
      };
      if (!targetRecords.some((existing) =>
        existing.fromUnitId === wireRecord.fromUnitId && existing.payloadHash === wireRecord.payloadHash
      )) {
        targetRecords.push(wireRecord);
      }
      candidateByTarget.set(record.toUnitId, targetRecords);
    }
    for (const [target, records] of candidateByTarget) {
      if (records.length > MAX_DOWNSTREAM_CONTEXT_RECORDS) {
        throw new Error(`downstream context target ${target} exceeds 32 records`);
      }
      if (Buffer.byteLength(canonicalJson(records), "utf8") > MAX_DOWNSTREAM_CONTEXT_AGGREGATE_BYTES) {
        throw new Error(`downstream context target ${target} exceeds 32768 bytes`);
      }
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
    insertExecutionPublicationEvent({
      db,
      id: deterministicId("execution-activity-graph-stopped", [input.parentAttemptId]),
      graph,
      unitId: null,
      kind: "graph_stopped",
      body: `Structured execution stopped: ${input.reason}.`,
      timestamp,
    });
    return "stopped";
  });

  const recordSteeringCaptured = db.transaction((
    input: Parameters<ExecutionUnitStore["recordSteeringCaptured"]>[0]
  ): void => {
    const graph = graphStmt.get(input.parentAttemptId) as ExecutionUnitGraph | undefined;
    if (!graph) return;
    insertExecutionPublicationEvent({
      db,
      id: deterministicId("execution-activity-steering-undelivered", [input.id]),
      graph,
      unitId: null,
      kind: "steering_undelivered",
      body: input.body,
      timestamp: now(),
    });
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
    listWorkAttempts(parentAttemptId) {
      return db.prepare(`
        SELECT * FROM execution_work_attempts
        WHERE parent_attempt_id = ?
        ORDER BY created_at, id
      `).all(parentAttemptId) as ExecutionWorkAttempt[];
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
    prepareActionDispatch(input) {
      const timestamp = now();
      const action = db.prepare("SELECT * FROM execution_work_attempts WHERE id = ?")
        .get(input.actionId) as ExecutionWorkAttempt | undefined;
      if (!action) throw new Error(`unknown execution work attempt ${input.actionId}`);
      if (action.request_hash != null || action.request_payload != null) {
        if (action.request_hash == null) {
          db.prepare(`
            UPDATE execution_work_attempts
            SET request_hash = ?, request_payload = ?, request_launch_state = COALESCE(request_launch_state, 'prepared'),
                native_session_id = COALESCE(?, native_session_id), updated_at = ?
            WHERE id = ? AND request_hash IS NULL
          `).run(input.requestHash, input.requestPayload, input.nativeSessionId ?? null, timestamp, input.actionId);
          return db.prepare("SELECT * FROM execution_work_attempts WHERE id = ?")
            .get(input.actionId) as ExecutionWorkAttempt;
        }
        if (action.request_hash === input.requestHash && action.request_payload == null) {
          db.prepare(`
            UPDATE execution_work_attempts
            SET request_payload = ?, request_launch_state = COALESCE(request_launch_state, 'prepared'),
                native_session_id = COALESCE(?, native_session_id), updated_at = ?
            WHERE id = ? AND request_hash = ? AND request_payload IS NULL
          `).run(input.requestPayload, input.nativeSessionId ?? null, timestamp, input.actionId, input.requestHash);
          return db.prepare("SELECT * FROM execution_work_attempts WHERE id = ?")
            .get(input.actionId) as ExecutionWorkAttempt;
        }
        assertPreparedRequestReplayMatches({ action, ...input });
        return action;
      }
      const update = db.prepare(`
        UPDATE execution_work_attempts
        SET request_hash = ?, request_payload = ?, request_launch_state = 'prepared',
            native_session_id = COALESCE(?, native_session_id), updated_at = ?
        WHERE id = ? AND status IN ('leased', 'dispatched')
          AND request_hash IS NULL AND request_payload IS NULL
      `).run(input.requestHash, input.requestPayload, input.nativeSessionId ?? null, timestamp, input.actionId);
      if (update.changes !== 1) throw new Error(`execution work attempt ${input.actionId} is not preparable`);
      return db.prepare("SELECT * FROM execution_work_attempts WHERE id = ?")
        .get(input.actionId) as ExecutionWorkAttempt;
    },
    markActionWorktreeReady(actionId) {
      const timestamp = now();
      const update = db.prepare(`
        UPDATE execution_work_attempts
        SET request_launch_state = 'worktree_ready', updated_at = ?
        WHERE id = ? AND request_hash IS NOT NULL AND request_payload IS NOT NULL
          AND (request_launch_state IS NULL OR request_launch_state IN ('prepared', 'worktree_ready'))
      `).run(timestamp, actionId);
      if (update.changes !== 1) return;
    },
    markActionDispatched(actionId, requestHash, nativeSessionId = null) {
      const timestamp = now();
      const action = db.prepare("SELECT * FROM execution_work_attempts WHERE id = ?")
        .get(actionId) as ExecutionWorkAttempt | undefined;
      if (!action) throw new Error(`unknown execution work attempt ${actionId}`);
      if (action.request_hash !== null && action.request_hash !== requestHash) {
        throw new Error(`execution work attempt ${actionId} already dispatched with a different request`);
      }
      if (action.native_session_id !== null && nativeSessionId !== null && action.native_session_id !== nativeSessionId) {
        throw new Error(`execution work attempt ${actionId} already dispatched with a different native session`);
      }
      const update = db.prepare(`
        UPDATE execution_work_attempts
        SET status = 'dispatched', request_hash = ?, request_launch_state = 'launched',
            native_session_id = COALESCE(?, native_session_id), updated_at = ?
        WHERE id = ? AND status IN ('leased', 'dispatched', 'running')
      `).run(requestHash, nativeSessionId, timestamp, actionId);
      if (update.changes !== 1) throw new Error(`execution work attempt ${actionId} is not active`);
    },
    completeUnitAction,
    completeGatedAction,
    failUnitAction,
    stopRetryableUnitAction,
    emitAggregateOnce,
    migrateAggregateArtifactHash,
    getPipelineArtifactByHash(input) {
      return db.prepare(`
        SELECT * FROM pipeline_artifacts
        WHERE pipeline_instance_id = ? AND attempt_id = ? AND kind = ? AND artifact_hash = ?
      `).get(
        input.pipelineInstanceId,
        input.attemptId,
        input.kind,
        input.artifactHash
      ) as PipelineArtifactRecord | undefined;
    },
    listAggregatePublicationArtifactHashes(parentAttemptId) {
      const rows = db.prepare(`
        SELECT e.body, o.payload AS outbox_payload
        FROM execution_publication_events e
        JOIN linear_outbox o ON o.id = e.linear_outbox_id
        WHERE e.parent_attempt_id = ? AND e.kind = 'aggregate'
        ORDER BY e.sequence ASC
      `).all(parentAttemptId) as Array<{ body: string; outbox_payload: string }>;
      const hashes = new Set<string>();
      const addHashes = (text: string): void => {
        for (const match of text.matchAll(/[a-f0-9]{64}/g)) hashes.add(match[0]!);
      };
      for (const row of rows) {
        addHashes(row.body);
        try {
          const payload = JSON.parse(row.outbox_payload) as { activity?: { body?: unknown } };
          if (typeof payload.activity?.body === "string") addHashes(payload.activity.body);
        } catch {
          addHashes(row.outbox_payload);
        }
      }
      return [...hashes].sort();
    },
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
    getStructuredExecutionPublicationForInstance(pipelineInstanceId) {
      return getStructuredExecutionPublicationForInstance(db, pipelineInstanceId);
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
    recordSteeringCaptured,
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
