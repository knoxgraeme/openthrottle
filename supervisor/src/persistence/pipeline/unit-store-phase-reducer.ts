import type Database from "better-sqlite3";
import { canonicalJson, digestNormalized, type StageOutcome } from "../../pipeline/manifest.js";
import {
  assertValidUnitPhaseSequence,
  actionKindForUnitPhase,
  BUILTIN_UNIT_PHASES,
  nextUnitPhaseForCycle,
  type ChildGateDecision,
  type ChildGateEvaluatorKind,
  type ExecutionUnitState,
  type FinalPhase,
  type UnitActionKind,
  type UnitPhase,
} from "../../pipeline/unit-coordinator.js";
import { deterministicId } from "./helpers.js";
import type {
  ExecutionGateKind,
  ExecutionGateReceipt,
  ExecutionUnitGraph,
  ExecutionWorkAttempt,
} from "./unit-store.js";

// This module owns the mechanics of the durable per-unit and whole-change
// phase machine: which action kind to lease next for a given phase, how a
// new work attempt is inserted, and how a completed action's receipt is
// validated and persisted. unit-store.ts owns the public ExecutionUnitStore
// surface (createGraph, lease/complete/gate transactions, terminal
// settlement) and calls into these functions with its own `db`/`now`.

export const DEFAULT_MAX_REPAIR_ROUNDS = 3;

// A unit-scoped action produces one of these receipt types; the store stores
// them verbatim (opaque JSON) as durable evidence, but only the caller (via
// execution-gates.ts) interprets their contents. 'simplify' has no receipt
// type of its own -- it is an optional tidy-up pass, not gated evidence.
export const RECEIPT_TYPE_FOR_ACTION_KIND: Partial<Record<UnitActionKind, string>> = {
  implement: "unit_completion",
  repair: "unit_completion",
  command: "command_result",
  final_command: "command_result",
  candidate: "candidate_evidence",
};

export const GATED_ACTION_KINDS = new Set<UnitActionKind>(["lead", "integrate", "final_review"]);

// The reverse of actionKindForUnitPhase (unit-coordinator.ts): which phase an
// action kind represents while it is the unit's active action, for action
// kinds whose completion advances the unit to the next phase via nextUnitPhase.
export const PHASE_FOR_COMPLETING_ACTION_KIND: Partial<Record<UnitActionKind, UnitPhase>> = {
  implement: "implement",
  repair: "implement",
  simplify: "simplify",
  candidate: "candidate",
};

export type ExecutionUnitRow = {
  id: string;
  unit_id: string;
  authored_order: number;
  dependency_unit_ids: string;
  status: ExecutionUnitState["status"];
  phase: UnitPhase;
  current_cycle: number;
  repair_rounds: number;
  command_index: number;
  active_work_attempt_id: string | null;
  accepted_candidate_subject: string | null;
  integration_subject: string | null;
  terminal_level: ExecutionUnitState["terminalLevel"];
  alarm: number;
};

export function parseJsonStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

export function dependenciesFor(row: { dependency_unit_ids: string }): string[] {
  return parseJsonStringArray(row.dependency_unit_ids);
}

export function unitState(row: ExecutionUnitRow): ExecutionUnitState {
  return {
    id: row.id,
    unitId: row.unit_id,
    ordinal: row.authored_order,
    dependencies: dependenciesFor(row),
    status: row.status,
    activeActionId: row.active_work_attempt_id,
    phase: row.phase,
    currentCycle: row.current_cycle,
    repairRounds: row.repair_rounds,
    commandIndex: row.command_index,
    acceptedCandidateSubject: row.accepted_candidate_subject,
    integrationSubject: row.integration_subject,
    terminalLevel: row.terminal_level,
    alarm: row.alarm === 1,
  };
}

export function commandNamesOf(graph: { command_names: string }): string[] {
  return parseJsonStringArray(graph.command_names);
}

export function unitPhasesOf(graph: { unit_phases?: string }): UnitPhase[] {
  const value = graph.unit_phases ? JSON.parse(graph.unit_phases) as unknown : [];
  if (!Array.isArray(value)) throw new Error("execution graph unit phases must be a JSON array");
  const parsed = value.map((entry) => {
    if (typeof entry !== "string") throw new Error("execution graph unit phases must contain only strings");
    return entry;
  });
  const invalid = parsed.find((entry) => !BUILTIN_UNIT_PHASES.includes(entry as UnitPhase));
  if (invalid) throw new Error(`execution graph unit phase ${invalid} is not recognized`);
  const phases = parsed as UnitPhase[];
  if (phases.length > 0) assertValidUnitPhaseSequence(phases);
  return phases;
}

export function phaseSequenceOf(graph: { unit_phases?: string }): UnitPhase[] {
  const phases = unitPhasesOf(graph);
  return phases.length > 0 ? phases : [...BUILTIN_UNIT_PHASES];
}

export function listUnitRowsForParentAttempt(db: Database.Database, parentAttemptId: string): ExecutionUnitRow[] {
  return db.prepare(`
    SELECT id, unit_id, authored_order, dependency_unit_ids, status, phase, current_cycle,
      repair_rounds, command_index, active_work_attempt_id, accepted_candidate_subject,
      integration_subject, terminal_level, alarm
    FROM execution_units WHERE parent_attempt_id = ?
    ORDER BY authored_order, unit_id
  `).all(parentAttemptId) as ExecutionUnitRow[];
}

export function nextOrdinal(
  db: Database.Database,
  input: { unitRowId: string | null; graphId: string; actionKind: UnitActionKind }
): number {
  if (input.unitRowId) {
    return (db.prepare(`
      SELECT COALESCE(MAX(attempt_ordinal), 0) + 1 AS ordinal
      FROM execution_work_attempts WHERE execution_unit_id = ? AND action_kind = ?
    `).get(input.unitRowId, input.actionKind) as { ordinal: number }).ordinal;
  }
  return (db.prepare(`
    SELECT COALESCE(MAX(attempt_ordinal), 0) + 1 AS ordinal
    FROM execution_work_attempts
    WHERE execution_graph_id = ? AND execution_unit_id IS NULL AND action_kind = ?
  `).get(input.graphId, input.actionKind) as { ordinal: number }).ordinal;
}

export function priorSessionId(
  db: Database.Database,
  input: { unitRowId: string | null; graphId: string; kinds: readonly UnitActionKind[] }
): string | null {
  const scope = input.unitRowId
    ? { clause: "execution_unit_id = ?", param: input.unitRowId }
    : { clause: "execution_graph_id = ? AND execution_unit_id IS NULL", param: input.graphId };
  const placeholders = input.kinds.map(() => "?").join(", ");
  const row = db.prepare(`
    SELECT native_session_id FROM execution_work_attempts
    WHERE ${scope.clause} AND action_kind IN (${placeholders})
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(scope.param, ...input.kinds) as { native_session_id: string | null } | undefined;
  return row?.native_session_id ?? null;
}

export function insertWorkAttempt(
  db: Database.Database,
  input: {
    unitRow: ExecutionUnitRow | null;
    graph: ExecutionUnitGraph;
    actionKind: UnitActionKind;
    cycle: number;
    commandName: string | null;
    resumeNativeSessionId: string | null;
    leaseOwner: string;
    nowIso: string;
    leaseUntilIso: string;
  }
): ExecutionWorkAttempt {
  const unitRowId = input.unitRow?.id ?? null;
  const unitId = input.unitRow?.unit_id ?? null;
  const ordinal = nextOrdinal(db, { unitRowId, graphId: input.graph.id, actionKind: input.actionKind });
  const actionId = deterministicId("execution-work", [
    input.graph.parent_attempt_id, unitId ?? "__final__", input.actionKind, input.commandName ?? null, ordinal,
  ]);
  const idempotencyKey = `unit-action:${input.graph.parent_attempt_id}:${unitId ?? "final"}:${input.actionKind}:${input.commandName ?? ""}:${ordinal}`;
  const payload = canonicalJson({
    parent_attempt_id: input.graph.parent_attempt_id,
    parent_run_id: input.graph.parent_run_id,
    unit_id: unitId,
    action_kind: input.actionKind,
    cycle: input.cycle,
    ...(input.commandName ? { command_name: input.commandName } : {}),
    ...(input.resumeNativeSessionId ? { resume_native_session_id: input.resumeNativeSessionId } : {}),
  });
  db.prepare(`
    INSERT INTO execution_work_attempts (
      id, execution_graph_id, execution_unit_id, pipeline_instance_id, parent_attempt_id,
      parent_run_id, unit_id, attempt_ordinal, action_kind, cycle, command_name, idempotency_key,
      status, lease_owner, lease_until, payload, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'leased', ?, ?, ?, ?, ?)
  `).run(
    actionId,
    input.graph.id,
    unitRowId,
    input.graph.pipeline_instance_id,
    input.graph.parent_attempt_id,
    input.graph.parent_run_id,
    unitId,
    ordinal,
    input.actionKind,
    input.cycle,
    input.commandName,
    idempotencyKey,
    input.leaseOwner,
    input.leaseUntilIso,
    payload,
    input.nowIso,
    input.nowIso
  );
  if (input.unitRow) {
    db.prepare(`
      UPDATE execution_units
      SET status = 'running', active_work_attempt_id = ?, updated_at = ?
      WHERE id = ?
    `).run(actionId, input.nowIso, input.unitRow.id);
  }
  return db.prepare("SELECT * FROM execution_work_attempts WHERE id = ?").get(actionId) as ExecutionWorkAttempt;
}

export function createOrResumeUnitAction(
  db: Database.Database,
  input: {
    unitRow: ExecutionUnitRow;
    graph: ExecutionUnitGraph;
    leaseOwner: string;
    nowIso: string;
    leaseUntilIso: string;
  }
): ExecutionWorkAttempt {
  let unitRow = input.unitRow;
  const commandNames = commandNamesOf(input.graph);
  const phases = phaseSequenceOf(input.graph);
  for (let guard = 0; guard < phases.length + commandNames.length + 1; guard += 1) {
    if (unitRow.phase === "command" && unitRow.command_index >= commandNames.length) {
      const next = nextUnitPhaseForCycle("command", unitRow.current_cycle, phases);
      if (!next) throw new Error(`execution unit ${unitRow.unit_id} command phase has no successor`);
      db.prepare(`UPDATE execution_units SET phase = ?, updated_at = ? WHERE id = ?`)
        .run(next, input.nowIso, unitRow.id);
      unitRow = { ...unitRow, phase: next };
      continue;
    }
    const actionKind = actionKindForUnitPhase(unitRow.phase, unitRow.current_cycle);
    const commandName = unitRow.phase === "command" ? commandNames[unitRow.command_index]! : null;
    const resumeNativeSessionId = actionKind === "repair"
      ? priorSessionId(db, { unitRowId: unitRow.id, graphId: input.graph.id, kinds: ["implement", "repair"] })
      : null;
    return insertWorkAttempt(db, {
      unitRow,
      graph: input.graph,
      actionKind,
      cycle: unitRow.current_cycle,
      commandName,
      resumeNativeSessionId,
      leaseOwner: input.leaseOwner,
      nowIso: input.nowIso,
      leaseUntilIso: input.leaseUntilIso,
    });
  }
  throw new Error(`execution unit ${unitRow.unit_id} phase advancement did not converge`);
}

export function createOrResumeFinalAction(
  db: Database.Database,
  input: {
    graph: ExecutionUnitGraph;
    leaseOwner: string;
    nowIso: string;
    leaseUntilIso: string;
  }
): ExecutionWorkAttempt | undefined {
  let graph = input.graph;
  const commandNames = commandNamesOf(graph);
  for (let guard = 0; guard < commandNames.length + 3; guard += 1) {
    const phase: FinalPhase = graph.final_phase ?? "command";
    if (phase === "done") return undefined;
    if (phase === "command" && graph.final_command_index >= commandNames.length) {
      db.prepare(`UPDATE execution_graphs SET final_phase = 'review', updated_at = ? WHERE id = ?`)
        .run(input.nowIso, graph.id);
      graph = { ...graph, final_phase: "review" };
      continue;
    }
    if (phase === "command") {
      const commandName = commandNames[graph.final_command_index]!;
      return insertWorkAttempt(db, {
        unitRow: null,
        graph,
        actionKind: "final_command",
        cycle: graph.final_cycle,
        commandName,
        resumeNativeSessionId: null,
        leaseOwner: input.leaseOwner,
        nowIso: input.nowIso,
        leaseUntilIso: input.leaseUntilIso,
      });
    }
    if (phase === "review") {
      return insertWorkAttempt(db, {
        unitRow: null,
        graph,
        actionKind: "final_review",
        cycle: graph.final_cycle,
        commandName: null,
        resumeNativeSessionId: null,
        leaseOwner: input.leaseOwner,
        nowIso: input.nowIso,
        leaseUntilIso: input.leaseUntilIso,
      });
    }
    // phase === "repair"
    const resumeNativeSessionId = priorSessionId(db, {
      unitRowId: null,
      graphId: graph.id,
      kinds: ["final_repair"],
    });
    return insertWorkAttempt(db, {
      unitRow: null,
      graph,
      actionKind: "final_repair",
      cycle: graph.final_cycle,
      commandName: null,
      resumeNativeSessionId,
      leaseOwner: input.leaseOwner,
      nowIso: input.nowIso,
      leaseUntilIso: input.leaseUntilIso,
    });
  }
  throw new Error(`execution graph ${graph.id} final phase advancement did not converge`);
}

export function loadActiveAction(db: Database.Database, actionId: string): ExecutionWorkAttempt {
  const action = db.prepare("SELECT * FROM execution_work_attempts WHERE id = ?")
    .get(actionId) as ExecutionWorkAttempt | undefined;
  if (!action) throw new Error(`unknown execution work attempt ${actionId}`);
  return action;
}

export function markActionCompleted(
  db: Database.Database,
  input: {
    action: ExecutionWorkAttempt;
    resultHash: string;
    outputSubject: string;
    receipt?: string;
    timestamp: string;
  }
): void {
  const expectedType = RECEIPT_TYPE_FOR_ACTION_KIND[input.action.action_kind];
  let receiptJson: string | null = null;
  let receiptHash: string | null = null;
  if (expectedType) {
    if (!input.receipt) throw new Error(`execution work attempt ${input.action.id} requires a ${expectedType} receipt`);
    const parsed = JSON.parse(input.receipt) as { type?: string; payload?: { command?: string } };
    if (parsed.type !== undefined && parsed.type !== expectedType) {
      throw new Error(`execution work attempt ${input.action.id} receipt type mismatch`);
    }
    if (input.action.command_name && parsed.payload?.command !== undefined && parsed.payload.command !== input.action.command_name) {
      throw new Error(`execution work attempt ${input.action.id} receipt command name mismatch`);
    }
    receiptJson = input.receipt;
    receiptHash = digestNormalized(input.receipt);
  } else if (input.receipt) {
    receiptJson = input.receipt;
    receiptHash = digestNormalized(input.receipt);
  }
  db.prepare(`
    UPDATE execution_work_attempts
    SET status = 'completed', result_hash = ?, output_subject = ?, receipt = ?, receipt_hash = ?,
        completed_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('leased', 'dispatched', 'running')
  `).run(input.resultHash, input.outputSubject, receiptJson, receiptHash, input.timestamp, input.timestamp, input.action.id);
}

export function insertGateReceipt(
  db: Database.Database,
  now: () => string,
  input: {
    action: ExecutionWorkAttempt;
    gateKind: ExecutionGateKind;
    evaluatorKind: ChildGateEvaluatorKind;
    subject: string | null;
    result: ChildGateDecision["result"];
    outcome: StageOutcome;
    reason: string;
    artifactHashes: readonly string[];
    payload: string;
    hash: string;
  }
): "recorded" | "already_recorded" {
  if (digestNormalized(input.payload) !== input.hash) throw new Error("execution gate receipt hash mismatch");
  const existing = db.prepare(`
    SELECT * FROM execution_gate_receipts
    WHERE execution_work_attempt_id = ? AND gate_kind = ?
  `).get(input.action.id, input.gateKind) as ExecutionGateReceipt | undefined;
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
    ) throw new Error(`execution work attempt ${input.action.id} already recorded a different gate receipt`);
    return "already_recorded";
  }
  const timestamp = now();
  db.prepare(`
    INSERT INTO execution_gate_receipts (
      id, execution_graph_id, execution_unit_id, execution_work_attempt_id,
      parent_attempt_id, unit_id, gate_kind, evaluator_kind, subject, result,
      outcome, reason, artifact_hashes, payload, receipt_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    deterministicId("execution-gate", [input.action.id, input.gateKind]),
    input.action.execution_graph_id,
    input.action.execution_unit_id,
    input.action.id,
    input.action.parent_attempt_id,
    input.action.unit_id,
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
}
