import {
  canonicalJson,
  digestNormalized,
  type AssuranceClass,
  type PipelineManifest,
  type PipelineStage,
  type StageOutcome,
} from "./manifest.js";
import type { PipelineCoordinatorEvent, PipelineEventArtifact } from "./coordinator.js";
import type { PipelineInstance, PipelineStageAttempt } from "./store.js";

export interface ExecutionPlanUnit {
  id: string;
  dependencies?: readonly string[];
}

export interface ExecutionUnitState {
  id: string;
  unitId: string;
  ordinal: number;
  dependencies: readonly string[];
  status: "pending" | "running" | "integrated" | "completed" | "exited" | "failed";
  activeActionId: string | null;
  integrationSubject: string | null;
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
