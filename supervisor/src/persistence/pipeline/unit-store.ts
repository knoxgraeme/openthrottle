import { createHash } from "node:crypto";
import { parseLoopReceiptRecoveryContract } from "@openthrottle/contracts";
import type Database from "better-sqlite3";
import {
  canonicalJson,
  digestNormalized,
  type PipelineUnitPhaseBinding,
  type StageOutcome,
  unitPhaseBindingCommandNames,
  unitPhaseBindingIds,
} from "../../pipeline/manifest.js";
import { buildExecutionPublicationSnapshot } from "../../pipeline/execution-publication.js";
import type { ExecutionGateDecision } from "../../pipeline/execution-gates.js";
import type { GateReceiptReason } from "../../pipeline/gates.js";
import {
  decideDownstreamContext,
  deriveUnitTerminalState,
  FINAL_REPAIR_MAX_ROUNDS,
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
import { deterministicId, insertExecutionPublicationEvent, listExecutionPublicationEvents } from "./helpers.js";
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
import {
  GIT_CHECKPOINT_OBJECT_SCHEMA,
  MAX_GIT_CHECKPOINT_OBJECT_BYTES,
  type GitCheckpointObject,
} from "../../pipeline/checkpoint-object.js";

export type ExecutionGateKind = ChildGateDecision["gateKind"] | "integration" | "final_review";

export type ExecutionGraphStopOutcome = "failure" | "needs_human" | "retryable_infrastructure_failure";

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
  initial_subject: string | null;
  command_names: string;
  unit_phases: string;
  unit_phase_bindings: string;
  max_repair_rounds: number;
  final_phase: FinalPhase | null;
  final_command_index: number;
  final_cycle: number;
  final_repair_rounds: number;
  integration_subject: string | null;
  aggregate_artifact_hash: string | null;
  aggregate_emitted_at: string | null;
  stopped_at: string | null;
  stop_reason: string | null;
  // Typed terminal outcome persisted alongside the free-text stop_reason so
  // the aggregate outcome never has to be inferred from sanitized agent text.
  // NULL on graphs stopped before the column existed and on semantic gate
  // routing stops that carry only a typed reason.
  stop_outcome: ExecutionGraphStopOutcome | null;
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
  observation_failure_count: number;
  observation_retry_at: string | null;
  observation_epoch: number;
  output_subject: string | null;
  checkpoint_expected_old_sha?: string | null;
  checkpoint_remote_sha?: string | null;
  checkpoint_status?: "pending" | "acknowledged" | "failed" | null;
  checkpoint_effect_id?: string | null;
  checkpoint_last_error?: string | null;
  checkpoint_acknowledged_at?: string | null;
  payload: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  last_error: string | null;
}

export interface ExecutionWorkPrivateArtifact {
  schema: "openthrottle.execution-work-private-artifact/v1";
  manifest: string;
  payload: Uint8Array;
  payloadSha256: string;
  payloadBytes: number;
}

export type ExecutionCheckpointObject = GitCheckpointObject;

export interface DurableExecutionCheckpointObject extends GitCheckpointObject {
  actionId: string;
  effectId: string;
}

interface StructuredTaskBranchRow {
  pipeline_instance_id: string;
  ticket_id: string;
  generation: number;
  repository: string;
  branch: string;
  plan_digest: string;
  lineage: string;
  accepted_integration_sha: string | null;
  acknowledged_remote_sha: string | null;
  status: "pending" | "reserved" | "checkpointed" | "published" | "failed";
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

export interface ExecutionReviewSubactionDispatch {
  parent_action_id: string;
  action_id: string;
  request_hash: string;
  idempotency_key: string;
  prepared_at: string;
  dispatched_at: string | null;
  dispatch_time_source: "acknowledged" | "prepared_fallback" | null;
}

export interface ExecutionUnitStore {
  createGraph(input: {
    pipelineInstanceId: string;
    parentAttemptId: string;
    parentStageId: string;
    parentRunId: string;
    graphDigest: string;
    planDigest: string;
    initialSubject?: string;
    units: readonly ExecutionPlanUnit[];
    commandNames?: readonly string[];
    unitPhases?: readonly UnitPhase[];
    unitPhaseBindings?: readonly PipelineUnitPhaseBinding[];
    maxRepairRounds?: number;
  }): ExecutionUnitGraph;
  getGraphForAttempt(parentAttemptId: string): ExecutionUnitGraph | undefined;
  listUnits(parentAttemptId: string): ExecutionUnitState[];
  listWorkAttempts(parentAttemptId: string): ExecutionWorkAttempt[];
  pruneExecutionWorkPrivateArtifacts(beforeIso: string, limit: number): number;
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
  clearActionObservationFailure(input: {
    actionId: string;
    expectedFailureCount: number;
    expectedEpoch: number;
  }): "cleared" | "stale";
  recordActionObservationFailure(input: {
    actionId: string;
    expectedFailureCount: number;
    expectedEpoch: number;
    lastError: string;
    retryAtIso: string;
  }): "recorded" | "stale";
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
    checkpointObject?: ExecutionCheckpointObject;
  }): ExecutionWorkAttempt;
  getCheckpointObject(effectId: string): DurableExecutionCheckpointObject | undefined;
  failUnitAction(input: {
    actionId: string;
    resultHash: string;
    outcome: "failure" | "needs_human" | "retryable_infrastructure_failure";
    lastError: string;
    nativeSessionId?: string | null;
    terminalPayload?: string;
    privateArtifact?: ExecutionWorkPrivateArtifact;
  }): ExecutionWorkAttempt;
  stopRetryableUnitAction(input: {
    actionId: string;
    resultHash: string;
    lastError: string;
    nativeSessionId?: string | null;
    terminalPayload?: string;
    privateArtifact?: ExecutionWorkPrivateArtifact;
    observationExhaustion?: {
      expectedFailureCount: number;
      expectedEpoch: number;
      exhaustedFailureCount: 3;
    };
  }): ExecutionWorkAttempt;
  emitAggregateOnce(input: {
    parentAttemptId: string;
    artifactHash: string;
    integrationSubject: string | null;
    emittedAt?: string;
    requireFinalReview?: boolean;
  }): "emitted" | "already_emitted";
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
  getReviewSubactionDispatch(
    parentActionId: string,
    actionId: string
  ): ExecutionReviewSubactionDispatch | undefined;
  prepareReviewSubactionDispatch(input: {
    parentActionId: string;
    actionId: string;
    requestHash: string;
    idempotencyKey: string;
  }): "recorded" | "already_recorded";
  markReviewSubactionDispatched(
    parentActionId: string,
    actionId: string,
    source: "acknowledged" | "prepared_fallback"
  ): void;
  appendDownstreamContext(input: {
    parentAttemptId: string;
    fromUnitId: string;
    records: readonly { toUnitId: string; payload: Record<string, unknown> }[];
  }): ExecutionDownstreamContext[];
  listDownstreamContext(parentAttemptId: string, toUnitId?: string): ExecutionDownstreamContext[];
  stopActiveWork(input: {
    parentAttemptId: string;
    reason: string;
    outcome?: ExecutionGraphStopOutcome;
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

  function queueAcceptedCheckpoint(input: {
    action: ExecutionWorkAttempt;
    subject: string;
    checkpointObject?: ExecutionCheckpointObject;
    timestamp: string;
  }): boolean {
    const branch = db.prepare(`
      SELECT * FROM pipeline_task_branches WHERE pipeline_instance_id = ?
    `).get(input.action.pipeline_instance_id) as StructuredTaskBranchRow | undefined;
    if (!branch) return false;
    const expectedOldSha = branch.acknowledged_remote_sha;
    if (!expectedOldSha) throw new Error("structured checkpoint requires an acknowledged task branch head");
    if (input.subject === expectedOldSha) return false;
    const object = input.checkpointObject;
    const payload = object ? Buffer.from(object.payload) : undefined;
    if (!object || object.schema !== GIT_CHECKPOINT_OBJECT_SCHEMA ||
        object.expectedOldSha !== expectedOldSha || object.expectedNewSha !== input.subject ||
        object.payloadBytes !== payload?.byteLength || object.payloadBytes < 1 ||
        object.payloadBytes > MAX_GIT_CHECKPOINT_OBJECT_BYTES ||
        object.payloadSha256 !== createHash("sha256").update(payload).digest("hex")) {
      throw new Error("accepted integration is missing its exact bounded checkpoint object");
    }
    if (!['reserved', 'checkpointed', 'published'].includes(branch.status) ||
        (branch.accepted_integration_sha !== null &&
          branch.accepted_integration_sha !== branch.acknowledged_remote_sha)) {
      throw new Error("structured checkpoint task branch already has an unsettled integration");
    }
    const control = canonicalJson({
      schema: "openthrottle.task-branch-effect/v1",
      pipelineInstanceId: input.action.pipeline_instance_id,
      ticketId: branch.ticket_id,
      generation: branch.generation,
      repository: branch.repository,
      ref: `refs/heads/${branch.branch}`,
      planDigest: branch.plan_digest,
      lineage: branch.lineage,
      expectedOldSha,
      expectedNewSha: input.subject,
    });
    const effectId = `task-branch-${digestNormalized(control).slice(0, 32)}`;
    const transitionVersion = (db.prepare(`
      SELECT COALESCE(MAX(transition_version), 0) + 1 AS version
      FROM pipeline_effect_intents WHERE pipeline_instance_id = ?
    `).get(input.action.pipeline_instance_id) as { version: number }).version;
    const accepted = db.prepare(`
      UPDATE pipeline_task_branches
      SET accepted_integration_sha = ?, status = 'reserved', last_error = NULL, updated_at = ?
      WHERE pipeline_instance_id = ? AND generation = ? AND lineage = ?
        AND acknowledged_remote_sha = ? AND status IN ('reserved', 'checkpointed', 'published')
        AND (accepted_integration_sha IS NULL OR accepted_integration_sha = acknowledged_remote_sha)
    `).run(
      input.subject, input.timestamp, input.action.pipeline_instance_id, branch.generation,
      branch.lineage, expectedOldSha
    );
    if (accepted.changes !== 1) throw new Error("task branch changed before structured checkpoint acceptance");
    db.prepare(`
      INSERT INTO pipeline_effect_intents (
        id, pipeline_instance_id, transition_version, kind, idempotency_key,
        payload, payload_hash, status, next_attempt_at, created_at
      ) VALUES (?, ?, ?, 'advance_task_branch', ?, ?, ?, 'pending', ?, ?)
    `).run(
      effectId, input.action.pipeline_instance_id, transitionVersion,
      `advance-task-branch:${branch.lineage}:${expectedOldSha}:${input.subject}`,
      control, digestNormalized(control), input.timestamp, input.timestamp
    );
    db.prepare(`
      INSERT INTO execution_checkpoint_objects (
        action_id, effect_id, expected_old_sha, expected_new_sha,
        payload_sha256, payload_bytes, payload, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.action.id, effectId, expectedOldSha, input.subject,
      object.payloadSha256, object.payloadBytes, payload, input.timestamp
    );
    db.prepare(`
      UPDATE execution_work_attempts
      SET checkpoint_expected_old_sha = ?, checkpoint_remote_sha = ?, checkpoint_status = 'pending',
          checkpoint_effect_id = ?, checkpoint_last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(expectedOldSha, input.subject, effectId, input.timestamp, input.action.id);
    return true;
  }

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
      (input.initialSubject !== undefined && existing.initial_subject !== input.initialSubject) ||
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
    terminalPayload?: string;
  }): void {
    if (
      input.action.status !== input.status ||
      input.action.terminal_result_outcome !== input.outcome ||
      input.action.result_hash !== input.resultHash ||
      input.action.last_error !== input.lastError ||
      (input.nativeSessionId !== undefined && input.action.native_session_id !== input.nativeSessionId) ||
      (input.terminalPayload !== undefined && input.action.payload !== input.terminalPayload)
    ) {
      throw new Error(`execution work attempt ${input.action.id} already terminated with a different result`);
    }
  }

  function persistPrivateArtifact(
    actionId: string,
    artifact: ExecutionWorkPrivateArtifact | undefined,
    timestamp: string
  ): void {
    if (!artifact) return;
    const payload = Buffer.from(artifact.payload);
    const payloadHash = createHash("sha256").update(payload).digest("hex");
    const manifest = parseLoopReceiptRecoveryContract(JSON.parse(artifact.manifest), {
      source: `execution_work_private_artifact.${actionId}.manifest`,
    }).value;
    const privatePayload = "private_payload" in manifest ? manifest.private_payload : undefined;
    if (artifact.schema !== "openthrottle.execution-work-private-artifact/v1" ||
        Buffer.byteLength(artifact.manifest, "utf8") > 128 * 1024 ||
        payload.byteLength === 0 || payload.byteLength > 8 * 1024 * 1024 ||
        artifact.payloadBytes !== payload.byteLength ||
        artifact.payloadSha256 !== payloadHash || manifest.action_id !== actionId ||
        !privatePayload || privatePayload.bytes !== payload.byteLength ||
        privatePayload.sha256 !== payloadHash) {
      throw new Error(`execution work attempt ${actionId} has an invalid private artifact`);
    }
    const existing = db.prepare(`
      SELECT schema, manifest, payload_sha256, payload_bytes
      FROM execution_work_private_artifacts WHERE action_id = ?
    `).get(actionId) as {
      schema: string;
      manifest: string;
      payload_sha256: string;
      payload_bytes: number;
    } | undefined;
    if (existing) {
      if (existing.schema !== artifact.schema || existing.manifest !== artifact.manifest ||
          existing.payload_sha256 !== payloadHash || existing.payload_bytes !== payload.byteLength) {
        throw new Error(`execution work attempt ${actionId} private artifact replay mismatch`);
      }
      return;
    }
    db.prepare(`
      INSERT INTO execution_work_private_artifacts (
        action_id, schema, manifest, payload, payload_sha256, payload_bytes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(actionId, artifact.schema, artifact.manifest, payload, payloadHash, payload.byteLength, timestamp);
  }

  function pruneExecutionWorkPrivateArtifacts(beforeIso: string, limit: number): number {
    if (typeof beforeIso !== "string" || Number.isNaN(Date.parse(beforeIso))) {
      throw new Error("execution work private artifact prune cutoff is invalid");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("execution work private artifact prune limit must be between 1 and 1000");
    }
    return db.prepare(`
      DELETE FROM execution_work_private_artifacts
      WHERE action_id IN (
        SELECT artifact.action_id
        FROM execution_work_private_artifacts AS artifact
        JOIN execution_work_attempts AS action ON action.id = artifact.action_id
        JOIN pipeline_instances AS instance ON instance.id = action.pipeline_instance_id
        WHERE artifact.created_at < ?
          AND instance.updated_at < ?
          AND action.status IN ('completed', 'failed', 'dead')
          AND instance.status IN (
            'shipped', 'no_change', 'needs_human', 'canceled', 'superseded',
            'failed', 'publication_blocked'
          )
        ORDER BY artifact.created_at, artifact.action_id
        LIMIT ?
      )
    `).run(beforeIso, beforeIso, limit).changes;
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
    if (input.initialSubject !== undefined && !/^[a-f0-9]{40}$/.test(input.initialSubject)) {
      throw new Error("execution graph initialSubject must be an exact Git commit");
    }
    db.prepare(`
      INSERT INTO execution_graphs (
        id, pipeline_instance_id, parent_attempt_id, parent_stage_id, parent_run_id,
        graph_digest, plan_digest, command_names, unit_phases, unit_phase_bindings,
        max_repair_rounds, initial_subject, integration_subject, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.initialSubject ?? null,
      input.initialSubject ?? null,
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
        AND (observation_retry_at IS NULL OR observation_retry_at <= ?)
      ORDER BY created_at, id
      LIMIT 1
    `).get(input.parentAttemptId, input.nowIso) as ExecutionWorkAttempt | undefined;
    if (dispatched) {
      return dispatched;
    }
    const observationBackoff = db.prepare(`
      SELECT 1 FROM execution_work_attempts
      WHERE parent_attempt_id = ? AND status IN ('dispatched', 'running')
        AND observation_retry_at IS NOT NULL AND observation_retry_at > ?
      LIMIT 1
    `).get(input.parentAttemptId, input.nowIso);
    if (observationBackoff) return undefined;
    const active = db.prepare(`
      SELECT 1 FROM execution_work_attempts
      WHERE parent_attempt_id = ? AND status = 'leased'
        AND (lease_until IS NULL OR lease_until > ?)
    `).get(input.parentAttemptId, input.nowIso);
    if (active) return undefined;
    const checkpointPending = db.prepare(`
      SELECT 1 FROM execution_work_attempts
      WHERE parent_attempt_id = ? AND checkpoint_status = 'pending'
      LIMIT 1
    `).get(input.parentAttemptId);
    if (checkpointPending) return undefined;

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
          const checkpointPending = queueAcceptedCheckpoint({
            action: completedAction,
            subject: input.decision.subject!,
            checkpointObject: input.checkpointObject,
            timestamp,
          });
          db.prepare(`
            UPDATE execution_units
            SET integration_subject = ?,
                status = CASE WHEN ? = 1 THEN 'integrated' ELSE status END,
                updated_at = ?
            WHERE id = ?
          `).run(input.decision.subject, checkpointPending ? 1 : 0, timestamp, unitRow.id);
          db.prepare(`UPDATE execution_graphs SET integration_subject = ?, updated_at = ? WHERE parent_attempt_id = ?`)
            .run(input.decision.subject, timestamp, completedAction.parent_attempt_id);
          if (!checkpointPending) {
            settleUnitRow({ parentAttemptId: completedAction.parent_attempt_id, unitId: unitRow.unit_id, reason: "acceptance_passed", timestamp });
          }
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
          const checkpointPending = queueAcceptedCheckpoint({
            action: completedAction,
            subject: input.decision.subject!,
            checkpointObject: input.checkpointObject,
            timestamp,
          });
          db.prepare(`
            UPDATE execution_graphs SET integration_subject = ?,
              final_phase = CASE WHEN ? = 1 THEN final_phase ELSE 'command' END,
              final_command_index = CASE WHEN ? = 1 THEN final_command_index ELSE 0 END,
              final_cycle = CASE WHEN ? = 1 THEN final_cycle ELSE final_cycle + 1 END,
              updated_at = ?
            WHERE id = ?
          `).run(input.decision.subject, checkpointPending ? 1 : 0, checkpointPending ? 1 : 0,
            checkpointPending ? 1 : 0, timestamp, graph.id);
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
        maxRepairRounds: FINAL_REPAIR_MAX_ROUNDS,
      });
      if (routing.action === "done") {
        db.prepare(`
          UPDATE execution_graphs SET final_phase = 'done', updated_at = ? WHERE id = ?
        `).run(timestamp, graph.id);
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
          body: `Whole-change final review needs another repair pass (round ${routing.repairRounds}/${FINAL_REPAIR_MAX_ROUNDS}): ${input.decision.reason}.`,
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
    persistPrivateArtifact(input.actionId, input.privateArtifact, timestamp);
    const lastError = input.lastError.slice(0, 2_000);
    if (action.status === "failed") {
      assertTerminalActionReplayMatches({
        action,
        status: "failed",
        outcome: input.outcome,
        resultHash: input.resultHash,
        nativeSessionId: input.nativeSessionId,
        lastError,
        terminalPayload: input.terminalPayload,
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
          payload = COALESCE(?, payload),
          lease_until = NULL, last_error = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('leased', 'dispatched', 'running')
    `).run(
      input.resultHash,
      input.outcome,
      input.nativeSessionId ?? null,
      input.terminalPayload ?? null,
      lastError,
      timestamp,
      timestamp,
      input.actionId
    );
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
      stopActiveWork({ parentAttemptId: action.parent_attempt_id, reason: lastError, outcome: input.outcome });
    }
    return loadActiveAction(db, input.actionId);
  });

  const stopRetryableUnitAction = db.transaction((
    input: Parameters<ExecutionUnitStore["stopRetryableUnitAction"]>[0]
  ): ExecutionWorkAttempt => {
    const timestamp = now();
    const action = loadActiveAction(db, input.actionId);
    persistPrivateArtifact(input.actionId, input.privateArtifact, timestamp);
    const observationExhaustion = input.observationExhaustion;
    if (
      observationExhaustion &&
      (
        !Number.isInteger(observationExhaustion.expectedFailureCount) ||
        observationExhaustion.expectedFailureCount < 0 ||
        !Number.isInteger(observationExhaustion.expectedEpoch) ||
        observationExhaustion.expectedEpoch < 0 ||
        observationExhaustion.exhaustedFailureCount !== 3 ||
        observationExhaustion.expectedFailureCount + 1 !== observationExhaustion.exhaustedFailureCount
      )
    ) {
      throw new Error(`execution work attempt ${input.actionId} has an invalid observation exhaustion fence`);
    }
    if (
      observationExhaustion &&
      (
        !["leased", "dispatched", "running"].includes(action.status) ||
        action.observation_failure_count !== observationExhaustion.expectedFailureCount ||
        action.observation_epoch !== observationExhaustion.expectedEpoch
      )
    ) {
      return action;
    }
    const lastError = `retryable_infrastructure_failure: ${input.lastError}`.slice(0, 2_000);
    if (action.status === "dead") {
      assertTerminalActionReplayMatches({
        action,
        status: "dead",
        outcome: "retryable_infrastructure_failure",
        resultHash: input.resultHash,
        nativeSessionId: input.nativeSessionId,
        lastError,
        terminalPayload: input.terminalPayload,
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
          payload = COALESCE(?, payload),
          lease_until = NULL,
          observation_failure_count = CASE WHEN ? IS NULL THEN observation_failure_count ELSE ? END,
          observation_retry_at = CASE WHEN ? IS NULL THEN observation_retry_at ELSE NULL END,
          last_error = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('leased', 'dispatched', 'running')
        AND (? IS NULL OR (observation_failure_count = ? AND observation_epoch = ?))
    `).run(
      input.resultHash,
      input.nativeSessionId ?? null,
      input.terminalPayload ?? null,
      observationExhaustion?.expectedFailureCount ?? null,
      observationExhaustion?.exhaustedFailureCount ?? null,
      observationExhaustion?.expectedFailureCount ?? null,
      lastError,
      timestamp,
      timestamp,
      input.actionId,
      observationExhaustion?.expectedFailureCount ?? null,
      observationExhaustion?.expectedFailureCount ?? null,
      observationExhaustion?.expectedEpoch ?? null
    );
    if (update.changes !== 1 && observationExhaustion) return loadActiveAction(db, input.actionId);
    if (update.changes !== 1) throw new Error(`execution work attempt ${input.actionId} retryable stop compare-and-set failed`);
    const priorRecovery = db.prepare(`
      SELECT 1 AS found FROM execution_work_attempts
      WHERE parent_attempt_id = ? AND unit_id IS ? AND action_kind = ? AND cycle = ?
        AND status = 'dead' AND id <> ?
        AND last_error LIKE 'retryable_infrastructure_failure:%'
      LIMIT 1
    `).get(
      action.parent_attempt_id, action.unit_id, action.action_kind, action.cycle, action.id
    ) as { found: 1 } | undefined;
    const recoverableCheckpoint = db.prepare(`
      SELECT acknowledged_remote_sha FROM pipeline_task_branches
      WHERE pipeline_instance_id = ? AND status = 'checkpointed'
        AND accepted_integration_sha = acknowledged_remote_sha
    `).get(action.pipeline_instance_id) as { acknowledged_remote_sha: string } | undefined;
    // One deterministic local recovery pass salvages the durable graph from
    // transient provider/disk faults. The acknowledged task-branch checkpoint
    // remains the frontier; completed units are untouched and only the active
    // action is recreated with a fresh ordinal. A repeated fault takes the
    // existing typed terminal path, preventing an autonomous retry loop.
    if (!priorRecovery && recoverableCheckpoint) {
      db.prepare(`
        UPDATE execution_work_attempts
        SET terminal_result_outcome = NULL,
            payload = json_set(payload, '$.recovery', json_object(
              'schema', 'openthrottle.structured-action-recovery/v1',
              'checkpoint_sha', (
                SELECT acknowledged_remote_sha FROM pipeline_task_branches
                WHERE pipeline_instance_id = execution_work_attempts.pipeline_instance_id
              ),
              'restarted_fresh', 1
            )),
            updated_at = ?
        WHERE id = ?
      `).run(timestamp, action.id);
      if (action.execution_unit_id) {
        db.prepare(`
          UPDATE execution_units
          SET status = 'running', active_work_attempt_id = NULL, updated_at = ?
          WHERE id = ? AND terminal_level IS NULL AND active_work_attempt_id = ?
        `).run(timestamp, action.execution_unit_id, action.id);
      }
      return loadActiveAction(db, input.actionId);
    }
    const graph = graphStmt.get(action.parent_attempt_id) as ExecutionUnitGraph | undefined;
    if (graph && !graph.aggregate_emitted_at && !graph.stopped_at) {
      db.prepare(`
        UPDATE execution_graphs
        SET stopped_at = ?, stop_reason = ?, stop_outcome = 'retryable_infrastructure_failure', updated_at = ?
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
      SET stopped_at = ?, stop_reason = ?, stop_outcome = ?, updated_at = ?
      WHERE parent_attempt_id = ? AND stopped_at IS NULL
    `).run(timestamp, input.reason, input.outcome ?? null, timestamp, input.parentAttemptId);
    if (activeActionIds.length > 0) {
      db.prepare(`
        UPDATE execution_work_attempts
        SET status = 'dead', lease_until = NULL, last_error = ?, updated_at = ?, completed_at = COALESCE(completed_at, ?)
        WHERE parent_attempt_id = ? AND status IN ('leased', 'dispatched', 'running')
      `).run(input.reason, timestamp, timestamp, input.parentAttemptId);
    }
    // This also exits every unit still bound to one of the actions killed
    // above: every terminal_level writer clears active_work_attempt_id in the
    // same statement and activation only targets non-terminal units, so a unit
    // with an active action always has terminal_level IS NULL.
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
      // Unlike markActionCompleted, changes !== 1 is a real (not merely
      // defensive) outcome here: a crash/redelivery re-dispatch of an action
      // that already reached request_launch_state = 'launched' re-creates the
      // worktree idempotently and re-marks readiness, and the fence above
      // correctly refuses to regress 'launched'. The caller then proceeds to
      // re-dispatch, so this stays a silent no-op rather than failing closed.
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
    clearActionObservationFailure(input) {
      if (
        !Number.isInteger(input.expectedFailureCount) || input.expectedFailureCount < 0 ||
        !Number.isInteger(input.expectedEpoch) || input.expectedEpoch < 0
      ) {
        throw new Error(`execution work attempt ${input.actionId} has an invalid observation clear fence`);
      }
      const update = db.prepare(`
        UPDATE execution_work_attempts
        SET observation_epoch = observation_epoch + 1,
            observation_failure_count = 0,
            observation_retry_at = NULL,
            last_error = NULL,
            updated_at = ?
        WHERE id = ? AND status IN ('leased', 'dispatched', 'running')
          AND observation_failure_count = ? AND observation_epoch = ?
      `).run(now(), input.actionId, input.expectedFailureCount, input.expectedEpoch);
      return update.changes === 1 ? "cleared" : "stale";
    },
    recordActionObservationFailure: db.transaction((input) => {
      if (
        !Number.isInteger(input.expectedFailureCount) ||
        input.expectedFailureCount < 0 || input.expectedFailureCount >= 2 ||
        !Number.isInteger(input.expectedEpoch) || input.expectedEpoch < 0
      ) {
        throw new Error(`execution work attempt ${input.actionId} has an invalid observation failure fence`);
      }
      const update = db.prepare(`
        UPDATE execution_work_attempts
        SET lease_owner = NULL, observation_failure_count = ?,
            observation_retry_at = ?, last_error = ?, updated_at = ?
        WHERE id = ? AND status IN ('leased', 'dispatched', 'running')
          AND observation_failure_count = ? AND observation_epoch = ?
      `).run(
        input.expectedFailureCount + 1,
        input.retryAtIso,
        input.lastError.slice(0, 2_000),
        now(),
        input.actionId,
        input.expectedFailureCount,
        input.expectedEpoch
      );
      return update.changes === 1 ? "recorded" : "stale";
    }),
    completeUnitAction,
    completeGatedAction,
    getCheckpointObject(effectId) {
      const row = db.prepare(`
        SELECT action_id, effect_id, expected_old_sha, expected_new_sha,
               payload_sha256, payload_bytes, payload
        FROM execution_checkpoint_objects
        WHERE effect_id = ?
      `).get(effectId) as {
        action_id: string;
        effect_id: string;
        expected_old_sha: string;
        expected_new_sha: string;
        payload_sha256: string;
        payload_bytes: number;
        payload: Buffer;
      } | undefined;
      return row ? {
          schema: GIT_CHECKPOINT_OBJECT_SCHEMA,
        actionId: row.action_id,
        effectId: row.effect_id,
        expectedOldSha: row.expected_old_sha,
        expectedNewSha: row.expected_new_sha,
        payloadSha256: row.payload_sha256,
        payloadBytes: row.payload_bytes,
        payload: row.payload,
      } : undefined;
    },
    failUnitAction,
    stopRetryableUnitAction,
    emitAggregateOnce,
    recordGateReceipt,
    listGateReceipts(parentAttemptId) {
      return db.prepare(`
        SELECT * FROM execution_gate_receipts
        WHERE parent_attempt_id = ?
        ORDER BY created_at, id
      `).all(parentAttemptId) as ExecutionGateReceipt[];
    },
    getReviewSubactionDispatch(parentActionId, actionId) {
      return db.prepare(`
        SELECT * FROM execution_review_subaction_dispatches
        WHERE parent_action_id = ? AND action_id = ?
      `).get(parentActionId, actionId) as ExecutionReviewSubactionDispatch | undefined;
    },
    prepareReviewSubactionDispatch(input) {
      const existing = db.prepare(`
        SELECT * FROM execution_review_subaction_dispatches
        WHERE parent_action_id = ? AND action_id = ?
      `).get(input.parentActionId, input.actionId) as ExecutionReviewSubactionDispatch | undefined;
      if (existing) {
        if (existing.request_hash !== input.requestHash || existing.idempotency_key !== input.idempotencyKey) {
          throw new Error(`review subaction ${input.actionId} already has a different dispatch fence`);
        }
        return "already_recorded";
      }
      const parent = db.prepare(`
        SELECT action_kind, status FROM execution_work_attempts WHERE id = ?
      `).get(input.parentActionId) as Pick<ExecutionWorkAttempt, "action_kind" | "status"> | undefined;
      if (!parent) throw new Error(`unknown parent review action ${input.parentActionId}`);
      if (parent.action_kind !== "final_review") {
        throw new Error(`review subaction ${input.actionId} parent is not a final review action`);
      }
      if (parent.status !== "leased" && parent.status !== "dispatched" && parent.status !== "running") {
        throw new Error(`review subaction ${input.actionId} parent is not active`);
      }
      db.prepare(`
        INSERT INTO execution_review_subaction_dispatches (
          parent_action_id, action_id, request_hash, idempotency_key,
          prepared_at, dispatched_at, dispatch_time_source
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL)
      `).run(input.parentActionId, input.actionId, input.requestHash, input.idempotencyKey, now());
      return "recorded";
    },
    markReviewSubactionDispatched(parentActionId, actionId, source) {
      const acknowledgedAt = now();
      const update = db.prepare(`
        UPDATE execution_review_subaction_dispatches
        SET dispatched_at = COALESCE(
              dispatched_at,
              CASE WHEN ? = 'acknowledged' THEN ? ELSE prepared_at END
            ),
            dispatch_time_source = COALESCE(dispatch_time_source, ?)
        WHERE parent_action_id = ? AND action_id = ?
      `).run(source, acknowledgedAt, source, parentActionId, actionId);
      if (update.changes !== 1) throw new Error(`unknown prepared review subaction ${actionId}`);
    },
    getStructuredExecutionPublicationForInstance(pipelineInstanceId) {
      return getStructuredExecutionPublicationForInstance(db, pipelineInstanceId);
    },
    pruneExecutionWorkPrivateArtifacts,
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
        WHERE parent_run_id = ?
          AND status IN ('leased', 'dispatched', 'running')
          AND (
            id = ? OR id = (
              SELECT parent_action_id
              FROM execution_review_subaction_dispatches
              WHERE action_id = ?
            )
          )
      `).run(
        input.leaseUntilIso,
        input.leaseUntilIso,
        timestamp,
        input.parentRunId,
        input.actionId,
        input.actionId
      ).changes === 1;
    },
  };
}
