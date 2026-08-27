import {
  compareCodeUnits,
  type AttemptCheckpoint,
  type CompiledPipelineStage,
  type DecisionRecord,
  type ExecutionRecord,
  type ResultRecord,
} from "@openthrottle/contracts";
import type { OrdinaryKernelSettlementPlanner } from "../pipeline/kernel/ordinary-coordinator.js";
import {
  createPipelineDecisionRecord,
  type EvaluatedKernelResult,
} from "../pipeline/kernel/evaluator-registry.js";
import type {
  KernelAttemptRequestInputs,
  KernelStructuredPlanningReadPort,
  SettledStructuredPlanningAttempt,
} from "../pipeline/kernel/ports.js";
import { frontierMemberKey } from "../pipeline/kernel/reducer.js";
import { sortedUnique } from "../pipeline/kernel/reducer-support.js";
import { structuredDecisionOutcome } from "../pipeline/kernel/structured-coordinator.js";
import { kernelSuccessorStageId } from "../pipeline/kernel/successor-attempt.js";
import type {
  AttemptScope,
  KernelAttempt,
  KernelFrontierMember,
} from "../pipeline/kernel/types.js";
import {
  assertStructuredSettledEvidence,
  projectCurrentStructuredEvidence,
} from "./kernel-structured-evidence.js";

type OrdinaryInput = Parameters<OrdinaryKernelSettlementPlanner["plan"]>[0];

export interface StructuredWaveEvidence extends SettledStructuredPlanningAttempt {
  member_id: string;
  member_index: number;
}

export type StructuredLoopStage = Extract<CompiledPipelineStage, { kind: "agent" }> & {
  loop: NonNullable<Extract<CompiledPipelineStage, { kind: "agent" }>["loop"]> & {
    body: string[];
  };
};

export function sortedUniqueStructuredIds(values: readonly string[]): string[] {
  return sortedUnique(values);
}

export function structuredStageFor(
  input: { view: OrdinaryInput["view"] },
  stageId: string,
): CompiledPipelineStage {
  const stage = input.view.manifest.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new Error(`structured manifest does not contain stage ${stageId}`);
  return stage;
}

export function structuredNextStageId(input: {
  view: OrdinaryInput["view"];
  stage: CompiledPipelineStage;
  outcome: string;
}): string | null {
  return kernelSuccessorStageId({
    manifest: input.view.manifest,
    run: input.view.run,
    stage: input.stage,
    outcome: input.outcome,
  });
}

function scopeMember(scope: Exclude<AttemptScope, { kind: "stage" }>): {
  member_id: string;
  member_index: number;
  parent_attempt_id: string;
  group_id: string;
} {
  return scope.kind === "loop_item"
    ? {
      member_id: scope.item_id,
      member_index: scope.item_index,
      parent_attempt_id: scope.parent_attempt_id,
      group_id: scope.loop_id,
    }
    : {
      member_id: scope.member_id,
      member_index: scope.member_index,
      parent_attempt_id: scope.parent_attempt_id,
      group_id: scope.fanout_id,
    };
}

function sameWaveMember(
  frontier: KernelFrontierMember,
  current: Exclude<AttemptScope, { kind: "stage" }>,
): boolean {
  const scope = frontier.scope;
  if (scope.kind !== current.kind || scope.stage_id !== current.stage_id) return false;
  if (scope.kind === "loop_item" && current.kind === "loop_item") {
    return scope.parent_attempt_id === current.parent_attempt_id &&
      scope.loop_id === current.loop_id;
  }
  return scope.kind === "fanout_member" && current.kind === "fanout_member" &&
    scope.parent_attempt_id === current.parent_attempt_id &&
    scope.fanout_id === current.fanout_id;
}

export function structuredBarrierCompletesWithCurrent(input: OrdinaryInput): boolean {
  const barrier = input.view.run.cursor.barrier;
  if (barrier?.kind !== "all") throw new Error("structured attempt has no all-member barrier");
  const currentKey = frontierMemberKey(input.attempt);
  if (!barrier.member_scope_keys.includes(currentKey)) {
    throw new Error(`structured attempt ${input.attempt.id} is outside its barrier`);
  }
  const completed = new Set([...input.view.run.cursor.completed_scope_keys, currentKey]);
  return barrier.member_scope_keys.every((key) => completed.has(key));
}

function withMemberIdentity(
  evidence: SettledStructuredPlanningAttempt,
): StructuredWaveEvidence {
  if (evidence.attempt.scope.kind === "stage") {
    throw new Error(`structured planning returned unscoped attempt ${evidence.attempt.id}`);
  }
  const member = scopeMember(evidence.attempt.scope);
  return { ...evidence, member_id: member.member_id, member_index: member.member_index };
}

function decisionEvaluation(decision: DecisionRecord): EvaluatedKernelResult {
  if (
    decision.payload_schema !== "openthrottle.pipeline-decision-record/v1" ||
    !("inline" in decision.payload) || !decision.payload.inline ||
    typeof decision.payload.inline !== "object" || Array.isArray(decision.payload.inline)
  ) throw new Error(`structured DecisionRecord ${decision.id} has no inline decision payload`);
  const payload = decision.payload.inline as Record<string, unknown>;
  if (
    payload.schema !== "openthrottle.pipeline-decision-record/v1" ||
    typeof payload.evaluator !== "string" || typeof payload.outcome !== "string" ||
    typeof payload.reason !== "string"
  ) throw new Error(`structured DecisionRecord ${decision.id} has an invalid decision payload`);
  return {
    evaluator: payload.evaluator,
    outcome: payload.outcome,
    reason: payload.reason,
  };
}

function preferredDivergentOutcome(outcomes: readonly string[]): string {
  const precedence = [
    "needs_human",
    "failure",
    "exited",
    "semantic_repair_required",
    "retryable_infrastructure_failure",
    "success",
    "no_change",
  ];
  const selected = precedence.find((outcome) => outcomes.includes(outcome));
  if (!selected) {
    throw new Error(
      `structured wave has unsupported divergent outcomes: ${sortedUniqueStructuredIds(outcomes).join(", ")}`,
    );
  }
  return selected;
}

export function settleStructuredWaveDecision(input: {
  view: OrdinaryInput["view"];
  stage: OrdinaryInput["stage"];
  current_attempt: KernelAttempt;
  current_result: ResultRecord;
  current_decision: DecisionRecord;
  evidence: readonly StructuredWaveEvidence[];
  additional_input_records?: readonly ExecutionRecord[];
  created_at: string;
}): {
  decision: DecisionRecord;
  outcome: string;
  target_stage_id: string | null;
  input_records: readonly ExecutionRecord[];
  aggregate: boolean;
} {
  const transitions = input.evidence.map((evidence) => {
    const outcome = structuredDecisionOutcome(evidence.decision);
    return {
      evidence,
      outcome,
      target_stage_id: structuredNextStageId({ view: input.view, stage: input.stage, outcome }),
    };
  });
  const targets = new Set(transitions.map(({ target_stage_id: target }) => target));
  const additionalInputs = input.additional_input_records ?? [];
  const lineageInputs = [...new Map([
    ...input.evidence.flatMap((source) => source.decision_input_records
      .filter(({ id }) => id !== source.result.id)),
    ...additionalInputs,
  ].map((record) => [record.id, record])).values()]
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  if (targets.size === 1) {
    const outcome = structuredDecisionOutcome(input.current_decision);
    const inputRecords = [...new Map([
      input.current_result,
      ...lineageInputs,
    ].map((record) => [record.id, record])).values()]
      .sort((left, right) => compareCodeUnits(left.id, right.id));
    const currentInputIds = [...input.current_decision.input_record_ids].sort(compareCodeUnits);
    const inputRecordIds = inputRecords.map(({ id }) => id);
    const decision = currentInputIds.length === inputRecordIds.length &&
        currentInputIds.every((id, index) => id === inputRecordIds[index])
      ? input.current_decision
      : createPipelineDecisionRecord({
        attempt: input.current_attempt,
        result: input.current_result,
        additional_input_records: inputRecords
          .filter(({ id }) => id !== input.current_result.id),
        evaluated: decisionEvaluation(input.current_decision),
        created_at: input.created_at,
      });
    return {
      decision,
      outcome,
      target_stage_id: transitions[0]!.target_stage_id,
      input_records: inputRecords,
      aggregate: false,
    };
  }
  const outcome = preferredDivergentOutcome(transitions.map((transition) => transition.outcome));
  const selected = transitions.find((transition) => transition.outcome === outcome)!;
  const inputRecords = [...new Map([
    ...input.evidence.map(({ result }) => result),
    ...lineageInputs,
  ].map((record) => [record.id, record])).values()]
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const decision = createPipelineDecisionRecord({
    attempt: input.current_attempt,
    result: input.current_result,
    additional_input_records: inputRecords.filter(({ id }) => id !== input.current_result.id),
    evaluated: decisionEvaluation(selected.evidence.decision),
    created_at: input.created_at,
  });
  return {
    decision,
    outcome,
    target_stage_id: selected.target_stage_id,
    input_records: inputRecords,
    aggregate: true,
  };
}

export function structuredSuccessorCheckpoints(
  evidence: StructuredWaveEvidence,
): AttemptCheckpoint[] {
  const successorSubject = evidence.attempt.output_subject ?? evidence.attempt.input_subject;
  const inherited = [...evidence.request_inputs.context.checkpoints.values()]
    .filter((checkpoint) => checkpoint.output_subject === successorSubject);
  let candidates: AttemptCheckpoint[];
  if (
    evidence.attempt.output_subject !== null &&
    evidence.attempt.output_subject !== evidence.attempt.input_subject
  ) {
    candidates = [evidence.checkpoint];
  } else if (evidence.attempt.output_subject === evidence.attempt.input_subject) {
    candidates = inherited.length === 0 ? [evidence.checkpoint] : inherited;
  } else {
    candidates = inherited;
  }
  const exact = [...new Map(candidates.map((checkpoint) => [checkpoint.id, checkpoint])).values()];
  if (exact.length > 1) {
    throw new Error(
      `structured successor for ${evidence.member_id} has ambiguous checkpoint materialization`,
    );
  }
  return exact;
}

export function boundedStructuredDependencies(
  attempts: readonly KernelAttempt[],
  maxParallel: number,
): Readonly<Record<string, readonly string[]>> {
  const dependencies: Record<string, readonly string[]> = {};
  attempts.forEach((attempt, index) => {
    dependencies[frontierMemberKey(attempt)] = index < maxParallel
      ? []
      : [frontierMemberKey(attempts[index - maxParallel]!)];
  });
  return dependencies;
}

export function structuredLoopRoot(input: OrdinaryInput): StructuredLoopStage {
  if (input.attempt.scope.kind !== "loop_item") {
    throw new Error("structured unit planning requires loop-item scope");
  }
  const scope = input.attempt.scope;
  const matches = input.view.manifest.stages.filter((candidate): candidate is
    StructuredLoopStage => candidate.kind === "agent" && candidate.loop !== undefined &&
      candidate.loop.body !== undefined && candidate.loop.over === scope.loop_id &&
      candidate.loop.body.includes(input.stage.id));
  if (matches.length !== 1 || matches[0]!.id !== "implement_unit") {
    throw new Error(`structured unit scope ${scope.loop_id} has no exact compiled root`);
  }
  return matches[0]!;
}

export async function loadCompletedStructuredWave(input: {
  store: KernelStructuredPlanningReadPort;
  ordinary: OrdinaryInput;
  current_decision: DecisionRecord;
  current_request: KernelAttemptRequestInputs;
}): Promise<StructuredWaveEvidence[]> {
  const { ordinary } = input;
  if (ordinary.attempt.scope.kind === "stage") {
    throw new Error("structured wave planning requires scoped attempt identity");
  }
  const currentScope = ordinary.attempt.scope;
  const frontier = ordinary.view.run.cursor.frontier.filter(
    (member) => sameWaveMember(member, currentScope),
  );
  if (frontier.length !== ordinary.view.run.cursor.frontier.length || frontier.length === 0) {
    throw new Error("structured cursor mixes unrelated frontier scopes");
  }
  const currentFrontier = frontier.find(({ attempt_id: id }) => id === ordinary.attempt.id);
  if (!currentFrontier) throw new Error("structured current Attempt is absent from its frontier");
  const members = frontier.map(({ scope }) => {
    if (scope.kind === "stage") throw new Error("structured frontier contains a stage scope");
    return scopeMember(scope);
  });
  const currentIdentity = scopeMember(currentScope);
  const prior = await input.store.listSettledStructuredPlanningAttempts({
    pipeline_run_id: ordinary.view.run.id,
    definition_bundle_hash: ordinary.view.run.definition_bundle_hash,
    scope_kind: currentScope.kind,
    parent_attempt_id: currentIdentity.parent_attempt_id,
    scope_group_id: currentIdentity.group_id,
    stage_ids: [ordinary.stage.id],
    member_ids: sortedUniqueStructuredIds(members.map(({ member_id }) => member_id)),
  });
  const activeIds = new Set(frontier.map(({ attempt_id }) => attempt_id));
  const byAttempt = new Map<string, StructuredWaveEvidence>();
  for (const evidence of prior) {
    if (!activeIds.has(evidence.attempt.id)) continue;
    assertStructuredSettledEvidence(evidence);
    if (evidence.attempt.scope.kind !== currentScope.kind ||
        !sameWaveMember({
          scope_key: frontierMemberKey(evidence.attempt),
          attempt_id: evidence.attempt.id,
          scope: evidence.attempt.scope,
          depends_on: [],
        }, currentScope)) {
      throw new Error(`structured planning returned out-of-wave attempt ${evidence.attempt.id}`);
    }
    if (byAttempt.has(evidence.attempt.id)) {
      throw new Error(`structured planning returned duplicate attempt ${evidence.attempt.id}`);
    }
    byAttempt.set(evidence.attempt.id, withMemberIdentity(evidence));
  }
  const current = withMemberIdentity(projectCurrentStructuredEvidence({
    attempt: ordinary.attempt,
    result: ordinary.result,
    decision: input.current_decision,
    checkpoint: ordinary.checkpoint,
    request_inputs: input.current_request,
    decision_input_records: [
      ordinary.result,
      ...(ordinary.additional_input_records ?? []),
    ],
  }));
  byAttempt.set(current.attempt.id, current);
  const missing = frontier.find(({ attempt_id }) => !byAttempt.has(attempt_id));
  if (missing || byAttempt.size !== frontier.length) {
    throw new Error(
      `structured wave is missing exact settled evidence for ${missing?.attempt_id ?? "a member"}`,
    );
  }
  return [...byAttempt.values()].sort((left, right) =>
    left.member_index - right.member_index || compareCodeUnits(left.member_id, right.member_id));
}
