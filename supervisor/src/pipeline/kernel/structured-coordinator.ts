import {
  canonicalJson,
  compareCodeUnits,
  digestCanonicalJson,
  type AttemptCheckpoint,
  type CompiledPipelineManifest,
  type CompiledPipelineStage,
  type DecisionRecord,
  type DefinitionBundle,
  type DeliveryRecord,
  type ExecutionRecord,
  type ResultRecord,
  type ExecutionPlanContractV2,
} from "@openthrottle/contracts";
import {
  createPendingKernelAttempt,
  exactKernelContext,
  type KernelActionInputs,
} from "./action-request.js";
import {
  PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA,
  createPipelineDecisionRecord,
} from "./evaluator-registry.js";
import {
  parseStructuredExecutionPlan,
} from "./structured-plan.js";
export {
  parseStructuredExecutionPlan,
  selectedStructuredReviewPersonas,
} from "./structured-plan.js";
import type {
  KernelContextPort,
  ExternalScheduleView,
  ReductionView,
  ResolvedKernelContext,
} from "./ports.js";
import type { EvaluatedKernelResult } from "./evaluator-registry.js";
import {
  compileKernelCursor,
  frontierMemberKey,
  reduceKernelCommand,
} from "./reducer.js";
import type {
  AtomicTransitionBundle,
  KernelAttempt,
  KernelCommand,
  KernelCursor,
} from "./types.js";
import {
  exactKernelRuntimeCleanupDeliveries,
  exactKernelRuntimeResourceDeliveries,
  resolveKernelRuntimeResourceIdentity,
} from "./runtime-resource.js";
import { sortedUnique } from "./reducer-support.js";
import {
  deriveKernelTerminalCleanupAttempt,
  mergeCausalGithubPushContext,
} from "./successor-attempt.js";

const MAX_STRUCTURED_MEMBERS = 64;
const MAX_STRUCTURED_ROUNDS = 100;
const GIT_SUBJECT = /^[a-f0-9]{40,64}$/;
export interface StructuredLoopMember {
  id: string;
  depends_on: readonly string[];
  action_inputs: KernelActionInputs;
}

export interface StructuredFanoutMember {
  id: string;
  action_inputs: KernelActionInputs;
}

export interface StructuredMemberCompletionEvidence {
  member_id: string;
  attempt: KernelAttempt;
  result: ResultRecord;
  decision: DecisionRecord;
  checkpoint: AttemptCheckpoint;
}

export interface StructuredSettledAttemptEvidence {
  attempt: KernelAttempt;
  result: ResultRecord;
  decision: DecisionRecord;
  checkpoint: AttemptCheckpoint;
  action_inputs: KernelActionInputs;
}

export interface StructuredAcceptedUnitEvidence {
  member_id: string;
  acceptance: StructuredSettledAttemptEvidence;
  candidate_checkpoint: AttemptCheckpoint;
}

export type StructuredIntegrationEvidence = StructuredMemberCompletionEvidence;

export interface StructuredFrontierCompilation {
  attempts: readonly KernelAttempt[];
  dependencies: Readonly<Record<string, readonly string[]>>;
  cursor: KernelCursor;
}

interface FrontierBase {
  pipeline_run_id: string;
  parent_attempt_id: string;
  stage_id: string;
  round: number;
  input_subject: string;
  cursor_version: number;
  completed_scope_keys: readonly string[];
  max_parallel: number;
  bundle: DefinitionBundle;
  manifest: CompiledPipelineManifest;
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function assertGitSubject(value: string, label: string): void {
  if (!GIT_SUBJECT.test(value)) throw new Error(`${label} is invalid`);
}

export function structuredIntegrationCheckpointChain(input: {
  completed_integrations: ReadonlyMap<string, StructuredIntegrationEvidence>;
  checkpoint_base_subject: string;
  current_subject: string;
}): AttemptCheckpoint[] {
  assertGitSubject(input.checkpoint_base_subject, "structured integration checkpoint base subject");
  assertGitSubject(input.current_subject, "structured integration current subject");
  if (input.completed_integrations.size > MAX_STRUCTURED_MEMBERS) {
    throw new Error(`structured integration ancestry exceeds ${MAX_STRUCTURED_MEMBERS} checkpoints`);
  }
  const checkpoints = [...input.completed_integrations.values()].map(({ checkpoint }) => checkpoint);
  const byInput = new Map<string, AttemptCheckpoint>();
  const byOutput = new Map<string, AttemptCheckpoint>();
  const checkpointIds = new Set<string>();
  for (const checkpoint of checkpoints) {
    if (
      checkpoint.output_subject === null ||
      checkpoint.output_subject === checkpoint.input_subject
    ) throw new Error("structured integration ancestry contains a non-advancing checkpoint edge");
    assertGitSubject(checkpoint.input_subject, "structured integration ancestry input subject");
    assertGitSubject(checkpoint.output_subject, "structured integration ancestry output subject");
    if (
      checkpointIds.has(checkpoint.id) ||
      byInput.has(checkpoint.input_subject) ||
      byOutput.has(checkpoint.output_subject)
    ) throw new Error("structured integration ancestry contains a fork or duplicate checkpoint edge");
    checkpointIds.add(checkpoint.id);
    byInput.set(checkpoint.input_subject, checkpoint);
    byOutput.set(checkpoint.output_subject, checkpoint);
  }
  const reversed: AttemptCheckpoint[] = [];
  const consumed = new Set<string>();
  let cursor = input.current_subject;
  while (cursor !== input.checkpoint_base_subject) {
    const checkpoint = byOutput.get(cursor);
    if (!checkpoint) {
      throw new Error("structured integration ancestry contains a gap before the current subject");
    }
    if (consumed.has(checkpoint.id)) {
      throw new Error("structured integration ancestry contains a cycle");
    }
    consumed.add(checkpoint.id);
    reversed.push(checkpoint);
    cursor = checkpoint.input_subject;
  }
  if (consumed.size !== checkpoints.length) {
    throw new Error("structured integration ancestry contains disconnected extra checkpoints");
  }
  return reversed.reverse();
}

function assertFrontierBounds(input: FrontierBase, memberCount: number): void {
  if (!Number.isSafeInteger(input.round) || input.round < 0 || input.round >= MAX_STRUCTURED_ROUNDS) {
    throw new Error(`structured round must be between 0 and ${MAX_STRUCTURED_ROUNDS - 1}`);
  }
  if (
    !Number.isSafeInteger(input.max_parallel) || input.max_parallel < 1 ||
    input.max_parallel > MAX_STRUCTURED_MEMBERS
  ) {
    throw new Error(`structured max_parallel must be between 1 and ${MAX_STRUCTURED_MEMBERS}`);
  }
  if (memberCount < 1 || memberCount > MAX_STRUCTURED_MEMBERS) {
    throw new Error(`structured frontier must contain between 1 and ${MAX_STRUCTURED_MEMBERS} members`);
  }
  assertIdentifier(input.parent_attempt_id, "structured parent attempt ID");
  assertIdentifier(input.stage_id, "structured stage ID");
  const stage = input.manifest.stages.find((candidate) => candidate.id === input.stage_id);
  if (!stage) throw new Error(`compiled manifest does not contain structured stage ${input.stage_id}`);
  if (stage.loop && input.max_parallel > stage.loop.max_parallel) {
    throw new Error(`structured max_parallel exceeds stage ${stage.id} bound`);
  }
  if (stage.loop && input.round >= stage.loop.max_rounds) {
    throw new Error(`structured round exceeds stage ${stage.id} bound`);
  }
}

function deterministicAttemptId(kind: string, identity: unknown): string {
  return `attempt-${digestCanonicalJson({
    schema: `openthrottle.${kind}-attempt-identity/v1`,
    identity,
  }).slice(0, 48)}`;
}

function canonicalMembers<T extends { id: string }>(members: readonly T[], label: string): T[] {
  const ordered = [...members].sort((left, right) => compareCodeUnits(left.id, right.id));
  for (const member of ordered) assertIdentifier(member.id, `${label} member ID`);
  if (new Set(ordered.map(({ id }) => id)).size !== ordered.length) {
    throw new Error(`${label} member IDs must be unique`);
  }
  return ordered;
}

function exactAdd<T extends { id: string }>(target: Map<string, T>, value: T, label: string): void {
  const existing = target.get(value.id);
  if (existing && canonicalJson(existing) !== canonicalJson(value)) {
    throw new Error(`${label} ${value.id} conflicts with existing context`);
  }
  target.set(value.id, value);
}

function mergedActionInputs(
  base: KernelActionInputs,
  dependencies: readonly StructuredIntegrationEvidence[],
): KernelActionInputs {
  const records = new Map<string, ExecutionRecord>();
  const checkpoints = new Map<string, AttemptCheckpoint>();
  for (const record of base.context.records) exactAdd(records, record, "record");
  for (const checkpoint of base.context.checkpoints) exactAdd(checkpoints, checkpoint, "checkpoint");
  for (const dependency of dependencies) {
    exactAdd(records, dependency.result, "record");
    exactAdd(records, dependency.decision, "record");
    exactAdd(checkpoints, dependency.checkpoint, "checkpoint");
  }
  return {
    task_prompt: base.task_prompt,
    context: exactKernelContext({ records, checkpoints }),
  };
}

function decisionPayload(decision: DecisionRecord): Record<string, unknown> {
  if (
    decision.payload_schema !== PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA ||
    !("inline" in decision.payload) || !decision.payload.inline ||
    typeof decision.payload.inline !== "object" || Array.isArray(decision.payload.inline)
  ) {
    throw new Error(`DecisionRecord ${decision.id} has no materialized pipeline decision payload`);
  }
  const payload = decision.payload.inline as Record<string, unknown>;
  if (payload.schema !== PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA) {
    throw new Error(`DecisionRecord ${decision.id} has an unsupported payload schema`);
  }
  return payload;
}

export function structuredDecisionOutcome(decision: DecisionRecord): string {
  const outcome = decisionPayload(decision).outcome;
  if (typeof outcome !== "string") {
    throw new Error(`DecisionRecord ${decision.id} has no deterministic outcome`);
  }
  return outcome;
}

function assertExactResultIdentity(input: {
  attempt: KernelAttempt;
  result: ResultRecord;
  decision: DecisionRecord;
  allow_additional_decision_inputs?: boolean;
}): void {
  const { attempt, result, decision } = input;
  if (
    result.pipeline_run_id !== attempt.pipeline_run_id ||
    result.attempt_id !== attempt.id ||
    result.request_hash !== attempt.request_hash ||
    result.definition_bundle_hash !== attempt.definition_bundle_hash ||
    result.input_subject !== attempt.input_subject ||
    result.output_subject !== attempt.output_subject ||
    attempt.result_record_id !== result.id
  ) {
    throw new Error(`ResultRecord ${result.id} does not match the complete attempt identity`);
  }
  if (
    decision.pipeline_run_id !== attempt.pipeline_run_id ||
    (input.allow_additional_decision_inputs
      ? !decision.input_record_ids.includes(result.id)
      : decision.input_record_ids.length !== 1 || decision.input_record_ids[0] !== result.id)
  ) {
    throw new Error(
      input.allow_additional_decision_inputs
        ? `DecisionRecord ${decision.id} must cite ResultRecord ${result.id}`
        : `DecisionRecord ${decision.id} must cite exactly ResultRecord ${result.id}`,
    );
  }
  const payload = decisionPayload(decision);
  if (payload.stage_id !== attempt.scope.stage_id) {
    throw new Error(`DecisionRecord ${decision.id} targets another stage`);
  }
}

function assertIntegrationEvidence(
  evidence: StructuredIntegrationEvidence,
  expectedRunId: string,
  manifest: CompiledPipelineManifest,
  expectedStageId: string,
): void {
  const { attempt, checkpoint, result, decision } = evidence;
  integrationEffectStage(manifest, expectedStageId);
  if (
    attempt.pipeline_run_id !== expectedRunId ||
    attempt.definition_bundle_hash !== manifest.definition_bundle_hash ||
    attempt.scope.kind !== "loop_item" ||
    attempt.scope.stage_id !== expectedStageId ||
    attempt.scope.item_id !== evidence.member_id ||
    attempt.repository_authority !== "inspect" ||
    attempt.status !== "settled" ||
    attempt.output_subject === null
  ) {
    throw new Error(`integration evidence for ${evidence.member_id} has no settled integration effect attempt`);
  }
  // External effect settlement decisions also cite the phase DeliveryRecords.
  // The indexed evidence shape intentionally carries only the attempt/result/
  // decision/checkpoint tuple, so exact delivery-set validation remains at the
  // external settlement boundary; structured planning can still prove that
  // the decision cites this attempt's exact ResultRecord.
  assertExactResultIdentity({
    attempt,
    result,
    decision,
    allow_additional_decision_inputs: true,
  });
  if (
    checkpoint.pipeline_run_id !== attempt.pipeline_run_id ||
    checkpoint.attempt_id !== attempt.id ||
    checkpoint.request_hash !== attempt.request_hash ||
    checkpoint.definition_bundle_hash !== attempt.definition_bundle_hash ||
    checkpoint.input_subject !== attempt.input_subject ||
    checkpoint.output_subject !== attempt.output_subject ||
    checkpoint.id !== attempt.checkpoint_id ||
    checkpoint.native_session_id !== attempt.native_session_id
  ) {
    throw new Error(`integration checkpoint ${checkpoint.id} does not match its exact output identity`);
  }
  const outcome = structuredDecisionOutcome(decision);
  if (!["next_integration", "next_unit", "all_integrated"].includes(outcome)) {
    throw new Error(`integration DecisionRecord ${decision.id} did not accept its ResultRecord`);
  }
}

function exactRuntimeDeliveries(records: readonly ExecutionRecord[]): DeliveryRecord[] {
  const identity = resolveKernelRuntimeResourceIdentity(records);
  if (identity === null) return [];
  const byId = new Map(records.flatMap((record) =>
    record.kind === "delivery" ? [[record.id, record] as const] : []));
  return identity.delivery_record_ids.map((id) => byId.get(id)!);
}

function assertAcceptedUnitEvidence(
  source: StructuredAcceptedUnitEvidence,
  expectedRunId: string,
  expectedBundleHash: string,
): void {
  const { attempt, result, decision, checkpoint, action_inputs: actionInputs } = source.acceptance;
  if (
    attempt.pipeline_run_id !== expectedRunId ||
    attempt.definition_bundle_hash !== expectedBundleHash ||
    attempt.scope.kind !== "loop_item" ||
    attempt.scope.item_id !== source.member_id ||
    attempt.repository_authority !== "inspect" ||
    attempt.status !== "settled" ||
    attempt.output_subject !== null
  ) throw new Error(`accepted unit ${source.member_id} has no settled inspect acceptance`);
  assertExactResultIdentity({ attempt, result, decision });
  const outcome = structuredDecisionOutcome(decision);
  if (outcome !== "success" && outcome !== "no_change") {
    throw new Error(`accepted unit ${source.member_id} has no accepting DecisionRecord`);
  }
  if (
    checkpoint.id !== attempt.checkpoint_id ||
    checkpoint.attempt_id !== attempt.id ||
    checkpoint.request_hash !== attempt.request_hash ||
    checkpoint.definition_bundle_hash !== attempt.definition_bundle_hash ||
    checkpoint.input_subject !== attempt.input_subject ||
    checkpoint.output_subject !== null
  ) throw new Error(`accepted unit ${source.member_id} has an invalid inspect checkpoint`);
  const contextRecordIds = actionInputs.context.records.map(({ id }) => id).sort(compareCodeUnits);
  const contextCheckpointIds = actionInputs.context.checkpoints.map(({ id }) => id).sort(compareCodeUnits);
  if (
    canonicalJson(contextRecordIds) !== canonicalJson(attempt.context_record_ids) ||
    canonicalJson(contextCheckpointIds) !== canonicalJson(attempt.context_checkpoint_ids)
  ) throw new Error(`accepted unit ${source.member_id} action context is not exact`);
  const candidate = actionInputs.context.checkpoints.filter(
    (candidateCheckpoint) => candidateCheckpoint.output_subject === attempt.input_subject,
  );
  if (
    candidate.length !== 1 ||
    canonicalJson(candidate[0]) !== canonicalJson(source.candidate_checkpoint) ||
    source.candidate_checkpoint.pipeline_run_id !== expectedRunId ||
    source.candidate_checkpoint.definition_bundle_hash !== expectedBundleHash
  ) throw new Error(`accepted unit ${source.member_id} must bind one exact edited candidate checkpoint`);
  exactRuntimeDeliveries(actionInputs.context.records);
}

function assertDependencyOrdering(members: readonly StructuredLoopMember[]): void {
  const ids = new Set(members.map(({ id }) => id));
  const dependencies = new Map<string, readonly string[]>();
  for (const member of members) {
    const canonical = sortedUnique(member.depends_on);
    if (canonical.length !== member.depends_on.length) {
      throw new Error(`structured member ${member.id} dependencies must be unique`);
    }
    if (canonical.includes(member.id)) throw new Error(`structured member ${member.id} depends on itself`);
    const unknown = canonical.find((dependency) => !ids.has(dependency));
    if (unknown) throw new Error(`structured member ${member.id} depends on unknown member ${unknown}`);
    dependencies.set(member.id, canonical);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (memberId: string): void => {
    if (visiting.has(memberId)) throw new Error("structured member dependencies contain a cycle");
    if (visited.has(memberId)) return;
    visiting.add(memberId);
    for (const dependency of dependencies.get(memberId) ?? []) visit(dependency);
    visiting.delete(memberId);
    visited.add(memberId);
  };
  for (const member of members) visit(member.id);
}

function compileBoundedFrontier(input: {
  base: FrontierBase;
  attempts: readonly KernelAttempt[];
}): StructuredFrontierCompilation {
  const dependencies: Record<string, readonly string[]> = {};
  input.attempts.forEach((attempt, index) => {
    const dependency = index < input.base.max_parallel
      ? []
      : [frontierMemberKey(input.attempts[index - input.base.max_parallel]!)];
    dependencies[frontierMemberKey(attempt)] = dependency;
  });
  return {
    attempts: input.attempts,
    dependencies,
    cursor: compileKernelCursor({
      stage_id: input.base.stage_id,
      version: input.base.cursor_version,
      attempts: input.attempts,
      dependencies,
      completed_scope_keys: input.base.completed_scope_keys,
    }),
  };
}

export function compileStructuredLoopFrontier(input: FrontierBase & {
  loop_id: string;
  integration_stage_id: string;
  members: readonly StructuredLoopMember[];
  completed_integrations: ReadonlyMap<string, StructuredIntegrationEvidence>;
}): StructuredFrontierCompilation | null {
  assertFrontierBounds(input, input.members.length);
  assertIdentifier(input.loop_id, "structured loop ID");
  integrationEffectStage(input.manifest, input.integration_stage_id);
  const members = canonicalMembers(input.members, "structured loop");
  assertDependencyOrdering(members);
  const byId = new Map(members.map((member) => [member.id, member]));
  for (const [memberId, evidence] of input.completed_integrations) {
    if (!byId.has(memberId) || evidence.member_id !== memberId) {
      throw new Error(`integration evidence names unknown member ${memberId}`);
    }
    assertIntegrationEvidence(
      evidence,
      input.pipeline_run_id,
      input.manifest,
      input.integration_stage_id,
    );
  }
  for (const member of members) {
    if (!input.completed_integrations.has(member.id)) continue;
    const missing = member.depends_on.find((dependency) => !input.completed_integrations.has(dependency));
    if (missing) {
      throw new Error(`completed member ${member.id} is missing integration dependency ${missing}`);
    }
  }
  if (input.completed_integrations.size > 0) {
    structuredIntegrationCheckpointChain({
      completed_integrations: input.completed_integrations,
      checkpoint_base_subject: input.bundle.source_commit,
      current_subject: input.input_subject,
    });
  }
  if (input.completed_integrations.size === members.length) return null;
  const ready = members.filter((member) =>
    !input.completed_integrations.has(member.id) &&
    member.depends_on.every((dependency) => input.completed_integrations.has(dependency)));
  if (ready.length === 0) {
    throw new Error("structured loop has unfinished members but no integration-ready members");
  }
  const indexById = new Map(members.map((member, index) => [member.id, index]));
  const attempts = ready.map((member) => {
    const itemIndex = indexById.get(member.id)!;
    const scope = {
      kind: "loop_item" as const,
      stage_id: input.stage_id,
      parent_attempt_id: input.parent_attempt_id,
      loop_id: input.loop_id,
      item_id: member.id,
      item_index: itemIndex,
    };
    const dependencyEvidence = sortedUnique(member.depends_on)
      .map((dependency) => input.completed_integrations.get(dependency)!);
    const id = deterministicAttemptId("structured-loop-member", {
      pipeline_run_id: input.pipeline_run_id,
      parent_attempt_id: input.parent_attempt_id,
      stage_id: input.stage_id,
      loop_id: input.loop_id,
      member_id: member.id,
      member_index: itemIndex,
      round: input.round,
    });
    return createPendingKernelAttempt({
      id,
      pipeline_run_id: input.pipeline_run_id,
      scope,
      input_subject: input.input_subject,
      bundle: input.bundle,
      manifest: input.manifest,
      action_inputs: mergedActionInputs(member.action_inputs, dependencyEvidence),
    });
  });
  return compileBoundedFrontier({ base: input, attempts });
}

export interface StructuredProvisionSettlement {
  decision: DecisionRecord;
  outcome: string;
  next_attempts: readonly KernelAttempt[];
  next_dependencies: Readonly<Record<string, readonly string[]>>;
}

/** Compiles the first restart-safe unit wave from the durable provision boundary. */
export function buildStructuredProvisionSettlement(input: {
  view: ReductionView;
  stage: Extract<CompiledPipelineStage, { kind: "effect" }>;
  attempt: KernelAttempt;
  result: ResultRecord;
  bundle: DefinitionBundle;
  schedules: readonly ExternalScheduleView[];
  evaluated: EvaluatedKernelResult;
  task_prompt: string;
  execution_plan?: ExecutionPlanContractV2;
  planning_context_records?: readonly ExecutionRecord[];
  created_at: string;
}): StructuredProvisionSettlement {
  if (input.stage.effect !== "core/daytona-provision@1") {
    throw new Error("structured provision planner requires the runtime provision effect");
  }
  const deliveries = input.schedules.flatMap((schedule) => schedule.effects.map(({ delivery }) => {
    if (delivery === null) throw new Error("structured provision schedule is incomplete");
    return delivery;
  })).sort((left, right) => compareCodeUnits(left.id, right.id));
  const runtime = resolveKernelRuntimeResourceIdentity(deliveries);
  if (
    runtime === null || deliveries.length !== runtime.delivery_record_ids.length ||
    canonicalJson(deliveries.map(({ id }) => id)) !== canonicalJson(runtime.delivery_record_ids)
  ) throw new Error("structured provision requires exactly one confirmed Daytona create/start pair");
  const plan = input.execution_plan ??
    parseStructuredExecutionPlan(input.task_prompt, input.view.manifest.pipeline_id);
  if (plan.pipeline_id !== input.view.manifest.pipeline_id) {
    throw new Error("structured execution plan names another compiled pipeline");
  }
  const transition = input.stage.on[input.evaluated.outcome];
  const target = transition?.to === undefined
    ? undefined
    : input.view.manifest.stages.find(({ id }) => id === transition.to);
  if (target?.kind !== "agent" || !target.loop) {
    throw new Error("structured provision does not target a bounded unit loop");
  }
  const integrationStages = input.view.manifest.stages.filter(
    (candidate) => candidate.kind === "effect" && candidate.effect === "core/integrate-unit@1",
  );
  if (integrationStages.length !== 1) {
    throw new Error("structured pipeline must contain one integration effect stage");
  }
  const decision = createPipelineDecisionRecord({
    attempt: input.attempt,
    result: input.result,
    additional_input_records: deliveries,
    evaluated: input.evaluated,
    created_at: input.created_at,
  });
  const frontier = compileStructuredLoopFrontier({
    pipeline_run_id: input.view.run.id,
    parent_attempt_id: input.attempt.id,
    stage_id: target.id,
    loop_id: target.loop.over,
    integration_stage_id: integrationStages[0]!.id,
    round: 0,
    input_subject: input.view.run.current_subject,
    cursor_version: input.view.run.cursor.version + 1,
    completed_scope_keys: input.view.run.cursor.completed_scope_keys,
    max_parallel: target.loop.max_parallel,
    members: plan.units.map((unit) => ({
      id: unit.id,
      depends_on: unit.depends_on,
      action_inputs: {
        task_prompt: input.task_prompt,
        context: {
          records: [...deliveries, ...(input.planning_context_records ?? [])]
            .sort((left, right) => compareCodeUnits(left.id, right.id)),
          checkpoints: [],
        },
      },
    })),
    completed_integrations: new Map(),
    bundle: input.bundle,
    manifest: input.view.manifest,
  });
  if (frontier === null) throw new Error("fresh structured plan produced no initial unit frontier");
  return {
    decision,
    outcome: input.evaluated.outcome,
    next_attempts: frontier.attempts,
    next_dependencies: frontier.dependencies,
  };
}

export function compileReviewFanoutFrontier(input: FrontierBase & {
  fanout_id: string;
  members: readonly StructuredFanoutMember[];
}): StructuredFrontierCompilation {
  assertFrontierBounds(input, input.members.length);
  assertIdentifier(input.fanout_id, "review fanout ID");
  const stage = input.manifest.stages.find((candidate) => candidate.id === input.stage_id);
  if (stage?.kind !== "agent" || stage.repository_authority !== "inspect") {
    throw new Error(`review fanout stage ${input.stage_id} must have inspect authority`);
  }
  const members = canonicalMembers(input.members, "review fanout");
  const attempts = members.map((member, memberIndex) => {
    const scope = {
      kind: "fanout_member" as const,
      stage_id: input.stage_id,
      parent_attempt_id: input.parent_attempt_id,
      fanout_id: input.fanout_id,
      member_id: member.id,
      member_index: memberIndex,
    };
    return createPendingKernelAttempt({
      id: deterministicAttemptId("review-fanout-member", {
        pipeline_run_id: input.pipeline_run_id,
        parent_attempt_id: input.parent_attempt_id,
        stage_id: input.stage_id,
        fanout_id: input.fanout_id,
        member_id: member.id,
        member_index: memberIndex,
        round: input.round,
      }),
      pipeline_run_id: input.pipeline_run_id,
      scope,
      input_subject: input.input_subject,
      bundle: input.bundle,
      manifest: input.manifest,
      action_inputs: member.action_inputs,
    });
  });
  return compileBoundedFrontier({ base: input, attempts });
}

function editAgentStage(manifest: CompiledPipelineManifest, stageId: string): void {
  const stage = manifest.stages.find((candidate) => candidate.id === stageId);
  if (stage?.kind !== "agent" || stage.repository_authority !== "edit") {
    throw new Error(`structured continuation stage ${stageId} must have edit authority`);
  }
}

function integrationEffectStage(
  manifest: CompiledPipelineManifest,
  stageId: string,
): Extract<CompiledPipelineManifest["stages"][number], { kind: "effect" }> {
  const stage = manifest.stages.find((candidate) => candidate.id === stageId);
  if (stage?.kind !== "effect") {
    throw new Error(`structured integration stage ${stageId} must be the subject-advancing integrate effect`);
  }
  return stage;
}

export function createStructuredIntegrationAttempt(input: {
  pipeline_run_id: string;
  parent_attempt_id: string;
  member_id: string;
  round: number;
  stage_id: string;
  input_subject: string;
  task_prompt: string;
  source: StructuredAcceptedUnitEvidence;
  current_ancestry_checkpoints: readonly AttemptCheckpoint[];
  planning_context_records?: readonly ExecutionRecord[];
  bundle: DefinitionBundle;
  manifest: CompiledPipelineManifest;
}): KernelAttempt {
  assertIdentifier(input.parent_attempt_id, "integration parent attempt ID");
  assertIdentifier(input.member_id, "integration member ID");
  if (!Number.isSafeInteger(input.round) || input.round < 0 || input.round >= MAX_STRUCTURED_ROUNDS) {
    throw new Error("integration round is invalid");
  }
  if (input.source.member_id !== input.member_id) {
    throw new Error("integration source names another structured member");
  }
  assertAcceptedUnitEvidence(
    input.source,
    input.pipeline_run_id,
    input.manifest.definition_bundle_hash,
  );
  integrationEffectStage(input.manifest, input.stage_id);
  if (
    input.source.acceptance.attempt.scope.kind !== "loop_item" ||
    input.source.acceptance.attempt.scope.parent_attempt_id !== input.parent_attempt_id
  ) {
    throw new Error("integration source does not retain the expected loop parent identity");
  }
  const currentAncestry = [...input.current_ancestry_checkpoints];
  if (currentAncestry.length > MAX_STRUCTURED_MEMBERS) {
    throw new Error(`integration current ancestry exceeds ${MAX_STRUCTURED_MEMBERS} checkpoints`);
  }
  const ancestryIds = new Set<string>();
  let ancestrySubject = input.source.candidate_checkpoint.input_subject;
  for (const checkpoint of currentAncestry) {
    if (
      checkpoint.pipeline_run_id !== input.pipeline_run_id ||
      checkpoint.definition_bundle_hash !== input.manifest.definition_bundle_hash ||
      checkpoint.output_subject === null ||
      checkpoint.output_subject === checkpoint.input_subject ||
      checkpoint.input_subject !== ancestrySubject ||
      checkpoint.id === input.source.candidate_checkpoint.id ||
      ancestryIds.has(checkpoint.id)
    ) throw new Error("integration current ancestry contains a gap, fork, or foreign checkpoint");
    ancestryIds.add(checkpoint.id);
    ancestrySubject = checkpoint.output_subject;
  }
  if (currentAncestry.length > 0 && ancestrySubject !== input.input_subject) {
    throw new Error("integration current ancestry does not end at the integration input subject");
  }
  const scope = {
    ...input.source.acceptance.attempt.scope,
    stage_id: input.stage_id,
  };
  const id = deterministicAttemptId("structured-integration", {
    pipeline_run_id: input.pipeline_run_id,
    parent_attempt_id: input.parent_attempt_id,
    member_id: input.member_id,
    stage_id: input.stage_id,
    round: input.round,
    source_result_id: input.source.acceptance.result.id,
    source_decision_id: input.source.acceptance.decision.id,
    source_checkpoint_id: input.source.candidate_checkpoint.id,
    current_ancestry_checkpoint_ids: currentAncestry.map(({ id: checkpointId }) => checkpointId),
    scope,
  });
  return createPendingKernelAttempt({
    id,
    pipeline_run_id: input.pipeline_run_id,
    scope,
    input_subject: input.input_subject,
    bundle: input.bundle,
    manifest: input.manifest,
    action_inputs: {
      task_prompt: input.task_prompt,
      context: {
        records: mergeCausalGithubPushContext({
          pipeline_run_id: input.pipeline_run_id,
          base_records: [
            input.source.acceptance.decision,
            input.source.acceptance.result,
            ...exactRuntimeDeliveries(input.source.acceptance.action_inputs.context.records),
          ],
          inherited_records: input.source.acceptance.action_inputs.context.records,
          additional_records: input.planning_context_records,
        }),
        checkpoints: [input.source.candidate_checkpoint, ...currentAncestry],
      },
    },
  });
}

export function createBlockingReviewRemediationAttempt(input: {
  pipeline_run_id: string;
  stage_id: string;
  round: number;
  input_subject: string;
  task_prompt: string;
  attempt: KernelAttempt;
  result: ResultRecord;
  decision: DecisionRecord;
  checkpoints: readonly AttemptCheckpoint[];
  runtime_delivery_records: readonly ExecutionRecord[];
  bundle: DefinitionBundle;
  manifest: CompiledPipelineManifest;
}): KernelAttempt {
  if (
    input.attempt.pipeline_run_id !== input.pipeline_run_id ||
    input.attempt.definition_bundle_hash !== input.manifest.definition_bundle_hash ||
    input.attempt.repository_authority !== "inspect" ||
    input.attempt.status !== "settled" ||
    input.attempt.output_subject !== null
  ) {
    throw new Error("blocking review remediation requires one settled inspect attempt");
  }
  if (input.input_subject !== input.attempt.input_subject) {
    throw new Error("remediation input subject must equal the reviewed input subject");
  }
  assertExactResultIdentity(input);
  const payload = decisionPayload(input.decision);
  if (
    payload.evaluator !== "core/review-outcome@1" ||
    payload.outcome !== "semantic_repair_required" ||
    payload.reason !== "blocking_review_finding"
  ) {
    throw new Error("remediation requires one blocking review DecisionRecord");
  }
  editAgentStage(input.manifest, input.stage_id);
  if (!Number.isSafeInteger(input.round) || input.round < 0 || input.round >= MAX_STRUCTURED_ROUNDS) {
    throw new Error("remediation round is invalid");
  }
  const checkpoints = [...input.checkpoints]
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const checkpointIds = checkpoints.map(({ id }) => id);
  if (
    new Set(checkpointIds).size !== checkpointIds.length ||
    canonicalJson(checkpointIds) !== canonicalJson(input.attempt.context_checkpoint_ids)
  ) {
    throw new Error("remediation requires the exact review checkpoint IDs without missing or widened context");
  }
  for (const checkpoint of checkpoints) {
    if (
      checkpoint.pipeline_run_id !== input.attempt.pipeline_run_id ||
      checkpoint.definition_bundle_hash !== input.attempt.definition_bundle_hash
    ) {
      throw new Error(`review checkpoint ${checkpoint.id} must use the review run and definition bundle`);
    }
  }
  const acceptedBoundaries = checkpoints.filter(
    (checkpoint) => checkpoint.output_subject === input.attempt.input_subject,
  );
  if (acceptedBoundaries.length !== 1) {
    throw new Error("review checkpoint context must contain exactly one boundary for the reviewed input subject");
  }
  const runtimeDeliveries = exactKernelRuntimeResourceDeliveries(input.runtime_delivery_records);
  if (
    runtimeDeliveries === null ||
    runtimeDeliveries.some(({ id }) => !input.attempt.context_record_ids.includes(id))
  ) {
    throw new Error("review remediation requires the exact runtime DeliveryRecords from its sealed context");
  }
  return createPendingKernelAttempt({
    id: deterministicAttemptId("blocking-review-remediation", {
      pipeline_run_id: input.pipeline_run_id,
      review_attempt_id: input.attempt.id,
      decision_id: input.decision.id,
      review_checkpoint_ids: checkpointIds,
      stage_id: input.stage_id,
      round: input.round,
    }),
    pipeline_run_id: input.pipeline_run_id,
    scope: { kind: "stage", stage_id: input.stage_id },
    input_subject: input.input_subject,
    bundle: input.bundle,
    manifest: input.manifest,
    action_inputs: {
      task_prompt: input.task_prompt,
      context: {
        records: mergeCausalGithubPushContext({
          pipeline_run_id: input.pipeline_run_id,
          base_records: [input.decision, input.result, ...runtimeDeliveries],
          inherited_records: input.runtime_delivery_records,
        }),
        checkpoints,
      },
    },
  });
}

function assertExactResolvedIds(
  resolved: ResolvedKernelContext,
  attempt: KernelAttempt,
): void {
  const recordIds = [...resolved.records.keys()].sort(compareCodeUnits);
  const checkpointIds = [...resolved.checkpoints.keys()].sort(compareCodeUnits);
  if (
    canonicalJson(recordIds) !== canonicalJson(attempt.context_record_ids) ||
    canonicalJson(checkpointIds) !== canonicalJson(attempt.context_checkpoint_ids)
  ) {
    throw new Error(`context resolver widened or narrowed attempt ${attempt.id}`);
  }
  for (const record of resolved.records.values()) {
    if (record.pipeline_run_id !== attempt.pipeline_run_id) {
      throw new Error(`context resolver returned another run's record ${record.id}`);
    }
  }
  for (const checkpoint of resolved.checkpoints.values()) {
    if (checkpoint.pipeline_run_id !== attempt.pipeline_run_id) {
      throw new Error(`context resolver returned another run's checkpoint ${checkpoint.id}`);
    }
  }
}

export async function resolveStructuredAttemptContext(input: {
  port: KernelContextPort;
  attempt: KernelAttempt;
}): Promise<ResolvedKernelContext> {
  const resolved = await input.port.resolveExactContext({
    pipeline_run_id: input.attempt.pipeline_run_id,
    attempt_id: input.attempt.id,
    allowed_record_ids: input.attempt.context_record_ids,
    allowed_checkpoint_ids: input.attempt.context_checkpoint_ids,
  });
  assertExactResolvedIds(resolved, input.attempt);
  return resolved;
}

export function buildStructuredTerminalTransition(input: {
  view: ReductionView;
  outcome: "needs_human" | "canceled" | "superseded";
  reason: string;
  created_at: string;
  bundle: DefinitionBundle;
  task_prompt: string;
  runtime_delivery_records: readonly ExecutionRecord[];
}): AtomicTransitionBundle {
  const attempt = input.view.current_attempt;
  if (!attempt) throw new Error("structured terminal transition requires one exact active attempt");
  const runtimeDeliveries = exactKernelRuntimeCleanupDeliveries(input.runtime_delivery_records);
  if (runtimeDeliveries === null) {
    throw new Error("structured terminal transition requires exact runtime cleanup evidence");
  }
  const decision = createPipelineDecisionRecord({
    attempt,
    result: null,
    additional_input_records: runtimeDeliveries,
    evaluated: {
      evaluator: "core/operational-outcome@1",
      outcome: input.outcome,
      reason: input.reason,
    },
    created_at: input.created_at,
  });
  const commandId = `structured-${input.outcome}-${digestCanonicalJson({
    pipeline_run_id: input.view.run.id,
    attempt_id: attempt.id,
    decision_id: decision.id,
  }).slice(0, 48)}`;
  const command: KernelCommand = input.outcome === "needs_human"
    ? {
      type: "needs_human",
      command_id: commandId,
      attempt_id: attempt.id,
      decision_record_id: decision.id,
      reason: input.reason,
      resource_disposition: {
        kind: "cleanup",
        runtime_delivery_record_ids: runtimeDeliveries.map(({ id }) => id),
        cleanup_attempt: deriveKernelTerminalCleanupAttempt({
          view: input.view,
          current: attempt,
          decision,
          bundle: input.bundle,
          outcome: input.outcome,
          task_prompt: input.task_prompt,
          runtime_delivery_records: runtimeDeliveries,
        }),
      },
    }
    : input.outcome === "canceled"
      ? {
        type: "stop",
        command_id: commandId,
        decision_record_id: decision.id,
        reason: input.reason,
        resource_disposition: {
          kind: "cleanup",
          runtime_delivery_record_ids: runtimeDeliveries.map(({ id }) => id),
          cleanup_attempt: deriveKernelTerminalCleanupAttempt({
            view: input.view,
            current: attempt,
            decision,
            bundle: input.bundle,
            outcome: input.outcome,
            task_prompt: input.task_prompt,
            runtime_delivery_records: runtimeDeliveries,
          }),
        },
      }
      : {
        type: "supersede",
        command_id: commandId,
        decision_record_id: decision.id,
        reason: input.reason,
        resource_disposition: {
          kind: "cleanup",
          runtime_delivery_record_ids: runtimeDeliveries.map(({ id }) => id),
          cleanup_attempt: deriveKernelTerminalCleanupAttempt({
            view: input.view,
            current: attempt,
            decision,
            bundle: input.bundle,
            outcome: input.outcome,
            task_prompt: input.task_prompt,
            runtime_delivery_records: runtimeDeliveries,
          }),
        },
      };
  return reduceKernelCommand({
    manifest: input.view.manifest,
    run: input.view.run,
    current_attempt: attempt,
    records: new Map<string, ExecutionRecord>([
      ...runtimeDeliveries.map((record) => [record.id, record] as const),
      [decision.id, decision] as const,
    ]),
    checkpoints: new Map(),
    command,
  });
}
