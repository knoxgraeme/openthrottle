import {
  STAGE_OUTCOMES,
  canonicalJson,
  digestNormalized,
  type AssuranceClass,
  type PipelineManifest,
  type PipelineStage,
  type StageOutcome,
} from "./manifest.js";
import { UNIT_PHASE_IDS, type GraphUnitPhaseId } from "@openthrottle/contracts";
import type { PipelineCoordinatorEvent, PipelineEventArtifact } from "./coordinator.js";
import {
  commandDecisionForEvidence,
  semanticDecisionForEvidence,
  type GateResult,
} from "./gates.js";
import type { PipelineInstance, PipelineStageAttempt } from "./store.js";

export interface ExecutionPlanUnit {
  id: string;
  dependencies?: readonly string[];
}

// The durable per-unit sequence: implement/repair produces a unit_completion
// receipt, simplify tidies the diff, command runs each configured command,
// candidate captures executor-verified subject evidence, lead binds a
// scope-match decision to that exact candidate and its command receipts, and
// only then may integrate run. See RR15/RAE10.
export const BUILTIN_UNIT_PHASES = UNIT_PHASE_IDS;
export type UnitPhase = GraphUnitPhaseId;

export const UNIT_ACTION_KINDS = [
  "implement", "repair", "simplify", "command", "candidate", "lead", "integrate",
  "final_command", "final_review", "final_repair", "aggregate", "stop", "cleanup",
] as const;
export type UnitActionKind = (typeof UNIT_ACTION_KINDS)[number];

// Whole-change final phases run once every unit has settled: full commands
// rerun against the final integrated subject, then one fresh report-only
// review, with bounded repair looping back to a clean command rerun.
export const FINAL_PHASES = ["command", "review", "repair", "done"] as const;
export type FinalPhase = (typeof FINAL_PHASES)[number];

export interface ExecutionUnitState {
  id: string;
  unitId: string;
  ordinal: number;
  dependencies: readonly string[];
  status: "pending" | "running" | "integrated" | "completed" | "exited" | "failed";
  activeActionId: string | null;
  phase: UnitPhase;
  currentCycle: number;
  repairRounds: number;
  commandIndex: number;
  acceptedCandidateSubject: string | null;
  integrationSubject: string | null;
  terminalLevel: UnitTerminalLevel | null;
  alarm: boolean;
}

export function actionKindForUnitPhase(phase: UnitPhase, currentCycle: number): UnitActionKind {
  if (phase === "implement") return currentCycle > 1 ? "repair" : "implement";
  return phase;
}

export function nextUnitPhase(phase: UnitPhase, phases: readonly UnitPhase[] = BUILTIN_UNIT_PHASES): UnitPhase | undefined {
  return phases[phases.indexOf(phase) + 1];
}

export function repairCyclePhaseSequence(phases: readonly UnitPhase[] = BUILTIN_UNIT_PHASES): UnitPhase[] {
  const repairOrder: readonly UnitPhase[] = ["implement", "simplify", "command", "candidate", "lead", "integrate"];
  return repairOrder.filter((phase) => phases.includes(phase));
}

export function nextUnitPhaseForCycle(
  phase: UnitPhase,
  currentCycle: number,
  phases: readonly UnitPhase[] = BUILTIN_UNIT_PHASES
): UnitPhase | undefined {
  return nextUnitPhase(phase, currentCycle > 1 ? repairCyclePhaseSequence(phases) : phases);
}

export function assertValidUnitPhaseSequence(phases: readonly UnitPhase[]): void {
  if (phases.length === 0) throw new Error("execution graph unit phases must not be empty");
  const seen = new Set<UnitPhase>();
  let integrateIndex = -1;
  let leadIndex = -1;
  let candidateIndex = -1;
  let implementIndex = -1;
  let simplifyIndex = -1;
  for (const [index, phase] of phases.entries()) {
    if (!BUILTIN_UNIT_PHASES.includes(phase)) throw new Error(`execution graph unit phase ${phase} is not recognized`);
    if (seen.has(phase)) throw new Error("execution graph unit phases must not contain duplicate phases");
    seen.add(phase);
    if (phase === "implement") implementIndex = index;
    if (phase === "simplify") simplifyIndex = index;
    if (phase === "integrate") integrateIndex = index;
    if (phase === "lead") leadIndex = index;
    if (phase === "candidate") candidateIndex = index;
  }
  for (const required of ["implement", "candidate", "lead", "integrate"] as const) {
    if (!seen.has(required)) throw new Error(`execution graph unit phases must include ${required}`);
  }
  if (integrateIndex !== phases.length - 1) throw new Error("execution graph integrate phase must be last");
  if (simplifyIndex !== -1 && simplifyIndex < implementIndex) {
    throw new Error("execution graph simplify phase must not precede implement");
  }
  if (leadIndex !== integrateIndex - 1) throw new Error("execution graph lead phase must immediately precede integrate");
  if (candidateIndex !== leadIndex - 1) throw new Error("execution graph candidate phase must immediately precede lead");
}

export type UnitAcceptanceRouting =
  | { action: "integrate" }
  | { action: "repair"; repairRounds: number }
  | { action: "settle"; reason: "defect" }
  | { action: "escalate"; reason: string };

// Command failure (or any other non-accept lead result) repairs the unit back
// to implement, then traverses the graph-declared repair-cycle sequence with
// fresh evidence until candidate/lead/integrate. The max repair bound makes a
// unit that cannot converge settle as failed instead of looping forever.
export function routeUnitAcceptanceDecision(input: {
  outcome: StageOutcome;
  reason: string;
  repairRounds: number;
  maxRepairRounds: number;
}): UnitAcceptanceRouting {
  if (input.outcome === "success") return { action: "integrate" };
  if (input.outcome === "semantic_repair_required") {
    if (input.repairRounds + 1 > input.maxRepairRounds) return { action: "settle", reason: "defect" };
    return { action: "repair", repairRounds: input.repairRounds + 1 };
  }
  return { action: "escalate", reason: input.reason };
}

export type IntegrationRouting =
  | { action: "settle_completed" }
  | { action: "escalate"; reason: string };

export function routeIntegrationDecision(input: { outcome: StageOutcome; reason: string }): IntegrationRouting {
  if (input.outcome === "success") return { action: "settle_completed" };
  return { action: "escalate", reason: input.reason };
}

export type FinalReviewRouting =
  | { action: "done" }
  | { action: "repair"; repairRounds: number }
  | { action: "escalate"; reason: string };

export function routeFinalReviewDecision(input: {
  outcome: StageOutcome;
  reason: string;
  repairRounds: number;
  maxRepairRounds: number;
}): FinalReviewRouting {
  if (input.outcome === "success" || input.outcome === "no_change") return { action: "done" };
  if (input.outcome === "semantic_repair_required") {
    if (input.repairRounds + 1 > input.maxRepairRounds) {
      return { action: "escalate", reason: "final_review_repair_rounds_exhausted" };
    }
    return { action: "repair", repairRounds: input.repairRounds + 1 };
  }
  return { action: "escalate", reason: input.reason };
}

export type UnitTerminalReason = "acceptance_passed" | "structural_exit" | "defect";
export type UnitTerminalLevel = "completed" | "exited" | "failed";

export interface UnitTerminalState {
  status: Extract<ExecutionUnitState["status"], UnitTerminalLevel>;
  terminalLevel: UnitTerminalLevel;
  alarm: boolean;
}

export interface UnitBudgetState {
  manifestMaxRepairRounds?: number;
  instanceReentryCount: number;
  transitionMaxReentries?: number;
  transitionOnExhausted?: "failed" | "needs_human";
  targetStageReentryCount: number;
  manifestMaxAttempts: number;
  instanceAttemptCount: number;
}

export type UnitBudgetDecision =
  | { allowed: true }
  | { allowed: false; exhausted: "repair_rounds" | "reentries" | "attempts"; terminal: "failed" | "needs_human"; reason: string };

type ArtifactResult = StageOutcome | "not_configured";
type ChildGateKind = "unit_completion" | "unit_command" | "unit_acceptance" | "final_semantic";
export type ChildGateEvaluatorKind = "semantic" | "command" | "human" | "publish_subject";
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SUBJECT = /^[a-f0-9]{40,64}$/;
const FINDING_SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);

export interface ChildGateEvidence {
  schema: "openthrottle.child-gate-evidence/v1";
  producer: {
    capability: string;
    runtime_release: string;
    capability_digest: string;
    version: number;
  };
  pipeline: { instance_id: string; manifest_digest: string };
  parent: { attempt_id: string; run_id: string; request_hash: string };
  unit: { id: string; action_id: string };
  run: { generation: number; native_session_id: string | null };
  repository: {
    subject: string;
    pre_subject: string;
    post_subject: string;
  };
  result: ArtifactResult;
  findings: Array<{ severity: string }>;
  command?: {
    not_configured: boolean;
    timed_out: boolean;
    exit_code: number | null;
    signal: string | null;
  };
  artifact_hashes: string[];
  completed_at: string;
}

export interface ChildGateFence {
  pipelineInstanceId: string;
  manifestDigest: string;
  parentAttemptId: string;
  parentRunId: string;
  requestHash: string;
  unitId: string;
  actionId: string;
  producerCapability: string;
  runtimeRelease: string;
  capabilityDigest: string;
  generation: number;
  inputSubject: string;
  currentSubject: string;
  nativeSessionId?: string | null;
}

export interface ChildGateDecision {
  gateKind: ChildGateKind;
  evaluatorKind: ChildGateEvaluatorKind;
  subject: string;
  result: GateResult;
  outcome: StageOutcome;
  reason: string;
  artifactHashes: string[];
  payload: string;
  hash: string;
}

export interface DownstreamContextRecordInput {
  toUnitId: string;
  payload: Record<string, unknown>;
}

export type DownstreamContextDecision =
  | {
      outcome: "success";
      reason: "accepted_downstream_context";
      records: Array<DownstreamContextRecordInput & { fromUnitId: string; payloadHash: string }>;
    }
  | {
      outcome: "needs_human";
      reason:
        | "topology_change_rejected"
        | "downstream_context_source_unknown"
        | "downstream_context_source_not_integrated"
        | "downstream_context_target_unknown"
        | "downstream_context_target_not_pending";
      records: [];
    };

export function selectNextReadyUnit(units: readonly ExecutionUnitState[]): ExecutionUnitState | undefined {
  if (units.some((unit) => unit.activeActionId || unit.status === "running")) return undefined;
  const completed = new Set(
    units
      .filter((unit) => unit.status === "integrated" || unit.status === "completed")
      .map((unit) => unit.unitId)
  );
  let ready: ExecutionUnitState | undefined;
  for (const unit of units) {
    if (unit.status !== "pending" || !unit.dependencies.every((dependency) => completed.has(dependency))) continue;
    if (!ready || unit.ordinal < ready.ordinal || (unit.ordinal === ready.ordinal && unit.unitId.localeCompare(ready.unitId) < 0)) {
      ready = unit;
    }
  }
  return ready;
}

export function deriveUnitTerminalState(reason: UnitTerminalReason): UnitTerminalState {
  if (reason === "acceptance_passed") {
    return { status: "completed", terminalLevel: "completed", alarm: false };
  }
  if (reason === "structural_exit") {
    return { status: "exited", terminalLevel: "exited", alarm: false };
  }
  return { status: "failed", terminalLevel: "failed", alarm: true };
}

function assertChildGateFence(evidence: ChildGateEvidence, expected: ChildGateFence): void {
  if (evidence.schema !== "openthrottle.child-gate-evidence/v1") throw new Error("child gate evidence schema mismatch");
  if (![...STAGE_OUTCOMES, "not_configured"].includes(evidence.result)) {
    throw new Error("child gate evidence result is invalid");
  }
  if (!Array.isArray(evidence.findings) || evidence.findings.length > 50 ||
      evidence.findings.some((finding) => !finding || typeof finding !== "object" || !FINDING_SEVERITIES.has(finding.severity))) {
    throw new Error("child gate evidence findings are invalid");
  }
  if (!Array.isArray(evidence.artifact_hashes) || evidence.artifact_hashes.some((hash) => !SHA256.test(hash))) {
    throw new Error("child gate evidence artifact hashes are invalid");
  }
  if (!GIT_SUBJECT.test(evidence.repository.subject) ||
      !GIT_SUBJECT.test(evidence.repository.pre_subject) ||
      !GIT_SUBJECT.test(evidence.repository.post_subject)) {
    throw new Error("child gate evidence repository subject is invalid");
  }
  if (
    evidence.producer.capability !== expected.producerCapability ||
    evidence.producer.runtime_release !== expected.runtimeRelease ||
    evidence.producer.capability_digest !== expected.capabilityDigest ||
    evidence.producer.version !== 1 ||
    evidence.pipeline.instance_id !== expected.pipelineInstanceId ||
    evidence.pipeline.manifest_digest !== expected.manifestDigest ||
    evidence.parent.attempt_id !== expected.parentAttemptId ||
    evidence.parent.run_id !== expected.parentRunId ||
    evidence.unit.id !== expected.unitId ||
    evidence.unit.action_id !== expected.actionId ||
    evidence.run.generation !== expected.generation ||
    evidence.run.native_session_id !== (expected.nativeSessionId ?? null)
  ) throw new Error("child gate evidence producer fence mismatch");
  if (evidence.parent.request_hash !== expected.requestHash) {
    throw new Error("child gate evidence freshness fence mismatch");
  }
  if (
    evidence.repository.pre_subject !== expected.inputSubject ||
    evidence.repository.subject !== expected.currentSubject ||
    evidence.repository.post_subject !== expected.currentSubject
  ) throw new Error("child gate evidence subject fence mismatch");
  if (Number.isNaN(Date.parse(evidence.completed_at))) throw new Error("child gate evidence completed_at is invalid");
}

export function decideChildGate(input: {
  gateKind: ChildGateKind;
  evaluatorKind: ChildGateEvaluatorKind;
  expected: ChildGateFence;
  evidence: ChildGateEvidence;
}): ChildGateDecision {
  assertChildGateFence(input.evidence, input.expected);
  if (input.evaluatorKind === "command" && !input.evidence.command) {
    throw new Error("child command gate is missing command evidence");
  }
  if (input.evaluatorKind !== "command" && input.evaluatorKind !== "semantic") {
    throw new Error(`child gate evaluator ${input.evaluatorKind} is not supported`);
  }
  if (input.evaluatorKind === "command") {
    const command = input.evidence.command!;
    if (
      typeof command.not_configured !== "boolean" ||
      typeof command.timed_out !== "boolean" ||
      (command.exit_code !== null && !Number.isInteger(command.exit_code)) ||
      (command.signal !== null && typeof command.signal !== "string")
    ) throw new Error("child command gate has invalid command evidence");
  }
  const decision = input.evaluatorKind === "command"
    ? commandDecisionForEvidence(input.evidence.command!)
    : semanticDecisionForEvidence({
        result: input.evidence.result,
        findings: input.evidence.findings,
        repository: input.evidence.repository,
      });
  const artifactHashes = [...input.evidence.artifact_hashes].sort();
  const payload = canonicalJson({
    schema: "openthrottle.child-gate-receipt/v1",
    parent_attempt_id: input.expected.parentAttemptId,
    parent_run_id: input.expected.parentRunId,
    request_hash: input.expected.requestHash,
    unit_id: input.expected.unitId,
    action_id: input.expected.actionId,
    gate_kind: input.gateKind,
    evaluator_kind: input.evaluatorKind,
    input_subject: input.expected.inputSubject,
    subject: input.expected.currentSubject,
    proposed_result: input.evidence.result,
    decision: decision.result,
    outcome: decision.outcome,
    reason: decision.reason,
    artifact_hashes: artifactHashes,
  });
  return {
    gateKind: input.gateKind,
    evaluatorKind: input.evaluatorKind,
    subject: input.expected.currentSubject,
    result: decision.result,
    outcome: decision.outcome,
    reason: decision.reason,
    artifactHashes,
    payload,
    hash: digestNormalized(payload),
  };
}

export function decideDownstreamContext(input: {
  units: readonly ExecutionUnitState[];
  fromUnitId: string;
  records: readonly DownstreamContextRecordInput[];
  topologyChange?: { kind: string; summary: string };
}): DownstreamContextDecision {
  if (input.topologyChange) return { outcome: "needs_human", reason: "topology_change_rejected", records: [] };
  const unitById = new Map(input.units.map((unit) => [unit.unitId, unit]));
  const source = unitById.get(input.fromUnitId);
  if (!source) {
    return { outcome: "needs_human", reason: "downstream_context_source_unknown", records: [] };
  }
  if (source.status !== "integrated" && source.status !== "completed") {
    return { outcome: "needs_human", reason: "downstream_context_source_not_integrated", records: [] };
  }
  for (const record of input.records) {
    const target = unitById.get(record.toUnitId);
    if (!target) return { outcome: "needs_human", reason: "downstream_context_target_unknown", records: [] };
    if (target.status !== "pending") {
      return { outcome: "needs_human", reason: "downstream_context_target_not_pending", records: [] };
    }
  }
  return {
    outcome: "success",
    reason: "accepted_downstream_context",
    records: input.records.map((record) => ({
      fromUnitId: input.fromUnitId,
      toUnitId: record.toUnitId,
      payload: record.payload,
      payloadHash: digestNormalized(canonicalJson(record.payload)),
    })),
  };
}

export function unitBudgetDecision(input: UnitBudgetState): UnitBudgetDecision {
  if (input.manifestMaxRepairRounds !== undefined &&
      input.instanceReentryCount >= input.manifestMaxRepairRounds) {
    return {
      allowed: false,
      exhausted: "repair_rounds",
      terminal: "failed",
      reason: `pipeline repair round limit ${input.manifestMaxRepairRounds} exhausted`,
    };
  }
  if (input.transitionMaxReentries !== undefined &&
      input.targetStageReentryCount >= input.transitionMaxReentries) {
    return {
      allowed: false,
      exhausted: "reentries",
      terminal: input.transitionOnExhausted ?? "needs_human",
      reason: "unit re-entry limit exhausted",
    };
  }
  if (input.instanceAttemptCount >= input.manifestMaxAttempts) {
    return {
      allowed: false,
      exhausted: "attempts",
      terminal: "failed",
      reason: `pipeline attempt limit ${input.manifestMaxAttempts} exhausted`,
    };
  }
  return { allowed: true };
}

export function buildExecutionGraphResultArtifact(input: {
  instance: PipelineInstance;
  parentAttempt: PipelineStageAttempt;
  stage: PipelineStage;
  units: readonly ExecutionUnitState[];
  subject: string | null;
  result?: StageOutcome;
  completedAt?: string;
  assurance?: AssuranceClass;
}): PipelineEventArtifact {
  const ordered = [...input.units].sort((left, right) => left.ordinal - right.ordinal || left.unitId.localeCompare(right.unitId));
  const completedAt = input.completedAt ?? input.parentAttempt.completed_at ?? input.parentAttempt.updated_at;
  const payload = canonicalJson({
    ...typedArtifactBase({
      kind: "execution_graph_result",
      instance: input.instance,
      parentAttempt: input.parentAttempt,
      stage: input.stage,
      subject: input.subject,
      assurance: input.assurance ?? input.stage.evaluator.assurance,
      result: input.result ?? "success",
      completedAt,
    }),
    summary: "Structured execution units completed.",
    evidence: [],
    findings: [],
    actions: [],
    uncertainty: [],
    details: {
      units: ordered.map((unit) => ({
        id: unit.unitId,
        status: unit.status,
        terminal_level: unit.terminalLevel,
        alarm: unit.alarm,
        integration_subject: unit.integrationSubject,
      })),
    },
  });
  return {
    kind: "execution_graph_result",
    schemaVersion: 1,
    assurance: input.assurance ?? input.stage.evaluator.assurance,
    subject: input.subject,
    payload,
    hash: digestNormalized(payload),
  };
}

export function buildAggregateStageEvent(input: {
  id: string;
  manifest: PipelineManifest;
  instance: PipelineInstance;
  parentAttempt: PipelineStageAttempt;
  outcome?: StageOutcome;
  subject: string | null;
  nativeSessionId?: string | null;
  completedAt?: string;
  units: readonly ExecutionUnitState[];
}): PipelineCoordinatorEvent {
  const stage = input.manifest.stages.find((candidate) => candidate.id === input.parentAttempt.stage_id);
  if (!stage) throw new Error(`parent stage ${input.parentAttempt.stage_id} is absent from the pinned manifest`);
  const graphResult = buildExecutionGraphResultArtifact({
    instance: input.instance,
    parentAttempt: input.parentAttempt,
    stage,
    units: input.units,
    subject: input.subject,
    result: input.outcome ?? "success",
    completedAt: input.completedAt,
  });
  const completedAt = input.completedAt ?? input.parentAttempt.completed_at ?? input.parentAttempt.updated_at;
  const stagePayload = canonicalJson({
    ...typedArtifactBase({
      kind: "stage_result",
      instance: input.instance,
      parentAttempt: input.parentAttempt,
      stage,
      subject: input.subject,
      assurance: stage.evaluator.assurance,
      result: input.outcome ?? "success",
      completedAt,
    }),
    summary: "Structured execution units completed.",
    evidence: [graphResult.hash],
    findings: [],
    actions: [],
    uncertainty: [],
    details: {
      execution_graph_result_hash: graphResult.hash,
    },
  });
  const stageResult: PipelineEventArtifact = {
    kind: "stage_result",
    schemaVersion: 1,
    assurance: stage.evaluator.assurance,
    subject: input.subject,
    payload: stagePayload,
    hash: digestNormalized(stagePayload),
  };
  return {
    id: input.id,
    kind: "stage_result",
    instanceId: input.instance.id,
    generation: input.instance.generation,
    runId: input.parentAttempt.run_id ?? input.parentAttempt.planned_run_id ?? undefined,
    stageId: input.parentAttempt.stage_id,
    attemptId: input.parentAttempt.id,
    requestHash: input.parentAttempt.request_hash,
    outcome: input.outcome ?? "success",
    resultHash: stageResult.hash,
    subject: input.subject,
    nativeSessionId: input.nativeSessionId ?? input.parentAttempt.native_session_id,
    artifacts: [stageResult, graphResult],
  };
}

function typedArtifactBase(input: {
  kind: string;
  instance: PipelineInstance;
  parentAttempt: PipelineStageAttempt;
  stage: PipelineStage;
  subject: string | null;
  assurance: AssuranceClass;
  result: StageOutcome;
  completedAt: string;
}): Record<string, unknown> {
  if (!input.subject) throw new Error(`artifact ${input.kind} requires a gated subject`);
  const runId = input.parentAttempt.run_id ?? input.parentAttempt.planned_run_id;
  if (!runId) throw new Error(`artifact ${input.kind} requires a parent run binding`);
  const startedAt = input.parentAttempt.started_at ?? input.parentAttempt.created_at;
  return {
    schema: `openthrottle.artifact/${input.kind}@1`,
    kind: input.kind,
    producer: {
      capability: input.stage.executor.capability,
      runtime_release: input.instance.runtime_release,
      capability_digest: input.instance.capability_digest,
      version: 1,
    },
    pipeline: {
      instance_id: input.instance.id,
      manifest_digest: input.instance.manifest_digest,
    },
    stage: {
      id: input.stage.id,
      attempt_id: input.parentAttempt.id,
      request_hash: input.parentAttempt.request_hash,
      context_revision: input.parentAttempt.context_revision,
      context_policy: input.parentAttempt.native_context_policy,
    },
    run: {
      id: runId,
      ticket_id: input.instance.linear_issue_id,
      session_id: input.instance.linear_session_id,
      generation: input.instance.generation,
      native_session_id: input.parentAttempt.native_session_id,
    },
    repository: {
      name: input.instance.repository,
      base_commit: input.instance.base_commit,
      subject: input.subject,
      pre_subject: input.parentAttempt.expected_subject ?? input.subject,
      post_subject: input.subject,
    },
    assurance: input.assurance,
    result: input.result,
    started_at: startedAt,
    completed_at: input.completedAt,
  };
}
