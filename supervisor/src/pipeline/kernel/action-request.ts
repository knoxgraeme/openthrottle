import {
  canonicalJson,
  compareCodeUnits,
  definitionEntryContentHash,
  digestCanonicalJson,
  validateEvalDefinition,
  validateFilesystemConfigContract,
  type AttemptCheckpoint,
  type CompiledPipelineManifest,
  type CompiledPipelineStage,
  type DefinitionBundle,
  type DefinitionBundleEntry,
  type ExecutionRecord,
} from "@openthrottle/contracts";
import {
  KERNEL_ACTION_REQUEST_SCHEMA,
  KERNEL_RESULT_CORRECTION_REQUEST_SCHEMA,
  type KernelActionContext,
  type KernelAgentAction,
  type KernelExecutableAction,
  type KernelResultCorrectionRequest,
  type KernelWorkActionRequest,
} from "../../runtime/kernel-contracts.js";
import {
  canonicalAttemptContextIds,
  KERNEL_ATTEMPT_SCHEMA,
  type KernelAttempt,
  type AttemptScope,
} from "./types.js";
import { resolveKernelRuntimeResourceIdentity } from "./runtime-resource.js";

const REQUEST_SEAL_SCHEMA = "openthrottle.kernel-request-seal/v1" as const;
const MAX_TASK_PROMPT_BYTES = 512 * 1024;

export interface KernelActionInputs {
  task_prompt: string;
  context: KernelActionContext;
}

interface ActionSelection {
  stage: CompiledPipelineStage;
  action: KernelExecutableAction;
  definition_hashes: readonly string[];
}

function assertTaskPrompt(value: string): string {
  if (
    typeof value !== "string" || value.trim().length === 0 || value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_TASK_PROMPT_BYTES
  ) {
    throw new Error("kernel action task prompt is invalid");
  }
  return value.replace(/\r\n?/g, "\n");
}

function assertBundleIdentity(
  bundle: DefinitionBundle,
  manifest: CompiledPipelineManifest,
  attempt: Pick<KernelAttempt, "definition_bundle_hash" | "scope">,
): void {
  const bundleHash = digestCanonicalJson(bundle);
  if (
    bundleHash !== attempt.definition_bundle_hash ||
    bundleHash !== manifest.definition_bundle_hash
  ) {
    throw new Error("action request does not use the attempt's exact DefinitionBundle");
  }
  if (
    bundle.pipeline_id !== manifest.pipeline_id ||
    bundle.compiler_version !== manifest.compiler_version ||
    bundle.runtime_capability_digest !== manifest.runtime_capability_digest
  ) {
    throw new Error("compiled manifest does not match the pinned DefinitionBundle");
  }
  for (const entry of bundle.entries) {
    if (definitionEntryContentHash(entry.normalized_payload) !== entry.content_hash) {
      throw new Error(`definition entry ${entry.definition_kind}:${entry.definition_id} failed content verification`);
    }
  }
  if (!manifest.stages.some((stage) => stage.id === attempt.scope.stage_id)) {
    throw new Error(`attempt stage ${attempt.scope.stage_id} is absent from its compiled manifest`);
  }
}

function exactEntry(
  bundle: DefinitionBundle,
  kind: DefinitionBundleEntry["definition_kind"],
  id: string,
): DefinitionBundleEntry {
  const matches = bundle.entries.filter(
    (entry) => entry.definition_kind === kind && entry.definition_id === id,
  );
  if (matches.length !== 1) {
    throw new Error(`sealed DefinitionBundle must contain exactly one ${kind}:${id}`);
  }
  return matches[0]!;
}

function configEntry(bundle: DefinitionBundle): DefinitionBundleEntry {
  return exactEntry(bundle, "config", "repository");
}

function stageFor(
  manifest: CompiledPipelineManifest,
  stageId: string,
): CompiledPipelineStage {
  const stage = manifest.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new Error(`compiled manifest does not contain stage ${stageId}`);
  return stage;
}

function selectAgentAction(
  bundle: DefinitionBundle,
  stage: Extract<CompiledPipelineStage, { kind: "agent" }>,
  scope: AttemptScope,
): ActionSelection {
  const config = configEntry(bundle);
  const parsedConfig = validateFilesystemConfigContract(config.normalized_payload, {
    source: "definition_bundle.config",
  }).value;
  if (parsedConfig.engine !== stage.engine) {
    throw new Error(`agent stage ${stage.id} engine differs from its sealed config`);
  }
  const agent = exactEntry(bundle, "agent", stage.agent_id);
  if (typeof agent.normalized_payload !== "string" || agent.normalized_payload.trim().length === 0) {
    throw new Error(`agent ${stage.agent_id} has invalid sealed instructions`);
  }
  const selectedSkillIds = scope.kind === "fanout_member"
    ? [scope.member_id]
    : [...stage.skills];
  if (selectedSkillIds.some((id) => !stage.skills.includes(id))) {
    throw new Error(`fanout member is not a sealed skill of agent stage ${stage.id}`);
  }
  const skills = selectedSkillIds.map((id) => exactEntry(bundle, "skill", id));
  const evaluation = exactEntry(bundle, "eval", stage.eval);
  const evalDefinition = validateEvalDefinition(evaluation.normalized_payload, {
    source: `definition_bundle.eval:${stage.eval}`,
  }).value;
  const selected = [agent, ...skills, evaluation];
  const action: KernelAgentAction = {
    kind: "agent",
    engine: stage.engine,
    model: parsedConfig.model ?? null,
    reasoning_effort: parsedConfig.reasoning_effort ?? null,
    agent_id: stage.agent_id,
    skill_ids: selectedSkillIds,
    entry_skill: scope.kind === "fanout_member"
      ? scope.member_id
      : stage.entry_skill ?? null,
    eval_id: stage.eval,
    semantic_result_schema: evalDefinition.result,
    definition_entries: selected,
  };
  return {
    stage,
    action,
    definition_hashes: [config, ...selected].map(({ definition_kind, definition_id, content_hash }) =>
      `${definition_kind}:${definition_id}:${content_hash}`),
  };
}

function selectCommandAction(
  bundle: DefinitionBundle,
  stage: Extract<CompiledPipelineStage, { kind: "command" }>,
): ActionSelection {
  const config = configEntry(bundle);
  const parsed = validateFilesystemConfigContract(config.normalized_payload, {
    source: "definition_bundle.config",
  }).value;
  const commandLine = parsed.commands?.[stage.command];
  if (!commandLine) throw new Error(`command ${stage.command} is absent from the sealed config`);
  return {
    stage,
    action: { kind: "command", command_id: stage.command, command_line: commandLine },
    definition_hashes: [`config:repository:${config.content_hash}`],
  };
}

export function selectKernelAction(input: {
  bundle: DefinitionBundle;
  manifest: CompiledPipelineManifest;
  attempt: Pick<KernelAttempt, "definition_bundle_hash" | "scope">;
}): ActionSelection {
  assertBundleIdentity(input.bundle, input.manifest, input.attempt);
  const stage = stageFor(input.manifest, input.attempt.scope.stage_id);
  if (stage.kind === "agent") return selectAgentAction(input.bundle, stage, input.attempt.scope);
  if (stage.kind === "command") return selectCommandAction(input.bundle, stage);
  throw new Error(`stage ${stage.id} is ${stage.kind}; U7 delegates it to the effect/runtime-resource worker`);
}

function canonicalContext(context: KernelActionContext): {
  records: readonly { id: string; digest: string }[];
  checkpoints: readonly { id: string; digest: string }[];
} {
  const records = [...context.records]
    .map((record) => ({ id: record.id, digest: digestCanonicalJson(record) }))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const checkpoints = [...context.checkpoints]
    .map((checkpoint) => ({ id: checkpoint.id, digest: digestCanonicalJson(checkpoint) }))
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  if (new Set(records.map(({ id }) => id)).size !== records.length) {
    throw new Error("kernel action context contains duplicate record IDs");
  }
  if (new Set(checkpoints.map(({ id }) => id)).size !== checkpoints.length) {
    throw new Error("kernel action context contains duplicate checkpoint IDs");
  }
  return { records, checkpoints };
}

function changeBoundary(input: {
  stage: CompiledPipelineStage;
  input_subject: string;
  context: KernelActionContext;
}): { checkpoint_id: string; input_subject: string; output_subject: string } | null {
  if (input.stage.kind !== "agent" || input.stage.repository_authority !== "inspect") return null;
  const matches = input.context.checkpoints.filter(
    (checkpoint) => checkpoint.output_subject === input.input_subject,
  );
  if (matches.length > 1) throw new Error("inspect action has an ambiguous accepted-edit boundary");
  const checkpoint = matches[0];
  const boundary = checkpoint?.output_subject === null || checkpoint === undefined
    ? null
    : {
      checkpoint_id: checkpoint.id,
      input_subject: checkpoint.input_subject,
      output_subject: checkpoint.output_subject,
    };
  if (input.stage.eval === "core/review-result" && boundary === null) {
    throw new Error(`review stage ${input.stage.id} requires its accepted edit checkpoint boundary`);
  }
  return boundary;
}

function contextIds(context: KernelActionContext): {
  record_ids: string[];
  checkpoint_ids: string[];
} {
  return {
    record_ids: canonicalAttemptContextIds(
      [...context.records].map(({ id }) => id).sort(compareCodeUnits),
      "action context record IDs",
    ),
    checkpoint_ids: canonicalAttemptContextIds(
      [...context.checkpoints].map(({ id }) => id).sort(compareCodeUnits),
      "action context checkpoint IDs",
    ),
  };
}

function requestSeal(input: {
  pipeline_run_id: string;
  attempt_id: string;
  input_subject: string;
  definition_bundle_hash: string;
  repository_authority: KernelAttempt["repository_authority"];
  scope: AttemptScope;
  selection: ActionSelection;
  action_inputs: KernelActionInputs;
}): Record<string, unknown> {
  const boundary = changeBoundary({
    stage: input.selection.stage,
    input_subject: input.input_subject,
    context: input.action_inputs.context,
  });
  const runtimeResource = resolveKernelRuntimeResourceIdentity(input.action_inputs.context.records);
  return {
    schema: REQUEST_SEAL_SCHEMA,
    pipeline_run_id: input.pipeline_run_id,
    attempt_id: input.attempt_id,
    stage_id: input.selection.stage.id,
    scope: input.scope,
    input_subject: input.input_subject,
    definition_bundle_hash: input.definition_bundle_hash,
    repository_authority: input.repository_authority,
    action: input.selection.action.kind === "agent"
      ? {
        kind: "agent",
        engine: input.selection.action.engine,
        model: input.selection.action.model,
        reasoning_effort: input.selection.action.reasoning_effort,
        agent_id: input.selection.action.agent_id,
        skill_ids: input.selection.action.skill_ids,
        entry_skill: input.selection.action.entry_skill,
        eval_id: input.selection.action.eval_id,
      }
      : input.selection.action,
    definition_hashes: [...input.selection.definition_hashes].sort(compareCodeUnits),
    task_prompt: assertTaskPrompt(input.action_inputs.task_prompt),
    context: canonicalContext(input.action_inputs.context),
    runtime_resource: runtimeResource,
    change_boundary: boundary,
    executor_policy: {
      git_administration: "executor_only",
      commit: false,
      push: false,
      publish: false,
    },
  };
}

function executorOnlyRequestSeal(input: {
  pipeline_run_id: string;
  attempt_id: string;
  input_subject: string;
  definition_bundle_hash: string;
  repository_authority: KernelAttempt["repository_authority"];
  scope: AttemptScope;
  bundle: DefinitionBundle;
  manifest: CompiledPipelineManifest;
  action_inputs: KernelActionInputs;
}): Record<string, unknown> {
  assertBundleIdentity(input.bundle, input.manifest, {
    definition_bundle_hash: input.definition_bundle_hash,
    scope: input.scope,
  });
  const stage = stageFor(input.manifest, input.scope.stage_id);
  if (stage.kind !== "effect" && stage.kind !== "wait") {
    throw new Error(`stage ${stage.id} is ${stage.kind}; it requires an executable action seal`);
  }
  return {
    schema: REQUEST_SEAL_SCHEMA,
    pipeline_run_id: input.pipeline_run_id,
    attempt_id: input.attempt_id,
    stage_id: stage.id,
    scope: input.scope,
    input_subject: input.input_subject,
    definition_bundle_hash: input.definition_bundle_hash,
    repository_authority: input.repository_authority,
    executor: stage.kind === "effect"
      ? { kind: "effect", effect_kind: stage.effect }
      : { kind: "wait", wait_kind: stage.wait },
    definition_hashes: [],
    task_prompt: assertTaskPrompt(input.action_inputs.task_prompt),
    context: canonicalContext(input.action_inputs.context),
    change_boundary: null,
    executor_policy: {
      git_administration: "executor_only",
      commit: false,
      push: false,
      publish: stage.kind === "effect",
    },
  };
}

export function kernelActionRequestHash(input: {
  pipeline_run_id: string;
  attempt_id: string;
  input_subject: string;
  definition_bundle_hash: string;
  repository_authority: KernelAttempt["repository_authority"];
  bundle: DefinitionBundle;
  manifest: CompiledPipelineManifest;
  scope: AttemptScope;
  action_inputs: KernelActionInputs;
}): string {
  const selection = selectKernelAction({
    bundle: input.bundle,
    manifest: input.manifest,
    attempt: {
      definition_bundle_hash: input.definition_bundle_hash,
      scope: input.scope,
    },
  });
  return digestCanonicalJson(requestSeal({ ...input, selection }));
}

/**
 * Seals the identity of every Attempt. Agent and command attempts bind their
 * executable action; effect and wait attempts bind executor-only metadata and
 * are never rendered as agent work requests.
 */
export function kernelAttemptRequestHash(input: {
  pipeline_run_id: string;
  attempt_id: string;
  input_subject: string;
  definition_bundle_hash: string;
  repository_authority: KernelAttempt["repository_authority"];
  bundle: DefinitionBundle;
  manifest: CompiledPipelineManifest;
  scope: AttemptScope;
  action_inputs: KernelActionInputs;
}): string {
  const stage = stageFor(input.manifest, input.scope.stage_id);
  return stage.kind === "agent" || stage.kind === "command"
    ? kernelActionRequestHash(input)
    : digestCanonicalJson(executorOnlyRequestSeal(input));
}

export function createPendingKernelAttempt(input: {
  id: string;
  pipeline_run_id: string;
  scope: AttemptScope;
  input_subject: string;
  bundle: DefinitionBundle;
  manifest: CompiledPipelineManifest;
  action_inputs: KernelActionInputs;
}): KernelAttempt {
  const stage = stageFor(input.manifest, input.scope.stage_id);
  const repositoryAuthority = stage.kind === "agent" ? stage.repository_authority : "inspect";
  const requestHash = kernelAttemptRequestHash({
    pipeline_run_id: input.pipeline_run_id,
    attempt_id: input.id,
    input_subject: input.input_subject,
    definition_bundle_hash: input.manifest.definition_bundle_hash,
    repository_authority: repositoryAuthority,
    bundle: input.bundle,
    manifest: input.manifest,
    scope: input.scope,
    action_inputs: input.action_inputs,
  });
  const bindings = contextIds(input.action_inputs.context);
  return {
    schema: KERNEL_ATTEMPT_SCHEMA,
    id: input.id,
    pipeline_run_id: input.pipeline_run_id,
    scope: input.scope,
    repository_authority: repositoryAuthority,
    request_hash: requestHash,
    definition_bundle_hash: input.manifest.definition_bundle_hash,
    input_subject: input.input_subject,
    context_record_ids: bindings.record_ids,
    context_checkpoint_ids: bindings.checkpoint_ids,
    output_subject: null,
    native_session_id: null,
    status: "pending",
    version: 0,
    work_retry_ordinal: 0,
    result_correction_count: 0,
    result_correction_deadline: null,
    lease: null,
    checkpoint_id: null,
    result_record_id: null,
    decision_record_id: null,
    pending_result: null,
  };
}

export function createPendingStageAttempt(input: {
  id: string;
  pipeline_run_id: string;
  stage_id: string;
  input_subject: string;
  bundle: DefinitionBundle;
  manifest: CompiledPipelineManifest;
  action_inputs: KernelActionInputs;
}): KernelAttempt {
  return createPendingKernelAttempt({
    ...input,
    scope: { kind: "stage", stage_id: input.stage_id },
  });
}

export function buildKernelWorkActionRequest(input: {
  attempt: KernelAttempt;
  bundle: DefinitionBundle;
  manifest: CompiledPipelineManifest;
  action_inputs: KernelActionInputs;
}): KernelWorkActionRequest {
  const { attempt } = input;
  if (attempt.status !== "running" || !attempt.lease?.started || attempt.lease.purpose !== "work") {
    throw new Error(`attempt ${attempt.id} does not hold a started work lease`);
  }
  const selection = selectKernelAction(input);
  const bindings = contextIds(input.action_inputs.context);
  if (
    canonicalJson(bindings.record_ids) !== canonicalJson(attempt.context_record_ids) ||
    canonicalJson(bindings.checkpoint_ids) !== canonicalJson(attempt.context_checkpoint_ids)
  ) {
    throw new Error(`attempt ${attempt.id} context does not match its persisted request bindings`);
  }
  const expectedHash = digestCanonicalJson(requestSeal({
    pipeline_run_id: attempt.pipeline_run_id,
    attempt_id: attempt.id,
    input_subject: attempt.input_subject,
    definition_bundle_hash: attempt.definition_bundle_hash,
    repository_authority: attempt.repository_authority,
    scope: attempt.scope,
    selection,
    action_inputs: input.action_inputs,
  }));
  if (attempt.request_hash !== expectedHash) {
    throw new Error(`attempt ${attempt.id} request hash does not match its sealed action request`);
  }
  return {
    schema: KERNEL_ACTION_REQUEST_SCHEMA,
    phase: "work",
    pipeline_run_id: attempt.pipeline_run_id,
    attempt_id: attempt.id,
    stage_id: attempt.scope.stage_id,
    scope: attempt.scope,
    request_hash: attempt.request_hash,
    definition_bundle_hash: attempt.definition_bundle_hash,
    input_subject: attempt.input_subject,
    repository_authority: attempt.repository_authority,
    lease_id: attempt.lease.id,
    worker_id: attempt.lease.worker_id,
    task_prompt: assertTaskPrompt(input.action_inputs.task_prompt),
    context: input.action_inputs.context,
    runtime_resource: resolveKernelRuntimeResourceIdentity(input.action_inputs.context.records),
    change_boundary: changeBoundary({
      stage: selection.stage,
      input_subject: attempt.input_subject,
      context: input.action_inputs.context,
    }),
    action: selection.action,
    executor_policy: {
      git_administration: "executor_only",
      commit: false,
      push: false,
      publish: false,
    },
  };
}

export function buildKernelResultCorrectionRequest(input: {
  attempt: KernelAttempt;
  checkpoint: AttemptCheckpoint;
  bundle: DefinitionBundle;
  manifest: CompiledPipelineManifest;
}): KernelResultCorrectionRequest {
  const { attempt, checkpoint } = input;
  if (
    attempt.status !== "result_pending" || !attempt.lease?.started ||
    attempt.lease.purpose !== "result_correction"
  ) {
    throw new Error(`attempt ${attempt.id} does not hold a started result-correction lease`);
  }
  if (
    !attempt.native_session_id || !attempt.result_correction_deadline || !attempt.pending_result ||
    checkpoint.id !== attempt.checkpoint_id || checkpoint.attempt_id !== attempt.id ||
    checkpoint.request_hash !== attempt.request_hash ||
    checkpoint.definition_bundle_hash !== attempt.definition_bundle_hash ||
    checkpoint.input_subject !== attempt.input_subject ||
    checkpoint.native_session_id !== attempt.native_session_id
  ) {
    throw new Error(`attempt ${attempt.id} result correction changed its checkpoint fence`);
  }
  const selection = selectKernelAction(input);
  if (selection.action.kind !== "agent") {
    throw new Error("only semantic agent actions may enter result correction");
  }
  const lockedSubject = checkpoint.output_subject ?? checkpoint.input_subject;
  return {
    schema: KERNEL_RESULT_CORRECTION_REQUEST_SCHEMA,
    phase: "result_correction",
    engine: selection.action.engine,
    model: selection.action.model,
    reasoning_effort: selection.action.reasoning_effort,
    pipeline_run_id: attempt.pipeline_run_id,
    attempt_id: attempt.id,
    stage_id: attempt.scope.stage_id,
    scope: attempt.scope,
    request_hash: attempt.request_hash,
    definition_bundle_hash: attempt.definition_bundle_hash,
    input_subject: attempt.input_subject,
    locked_subject: lockedSubject,
    completed_work_authority: attempt.repository_authority,
    checkpoint_id: checkpoint.id,
    native_session_id: attempt.native_session_id,
    lease_id: attempt.lease.id,
    worker_id: attempt.lease.worker_id,
    correction_deadline: attempt.result_correction_deadline,
    diagnostics: attempt.pending_result.diagnostics,
    semantic_result_schema: selection.action.semantic_result_schema,
    repository_authority: "inspect",
    tools: ["ot-result"],
    mcp: false,
    provider_access: false,
  };
}

export function exactKernelContext(input: {
  records: ReadonlyMap<string, ExecutionRecord>;
  checkpoints: ReadonlyMap<string, AttemptCheckpoint>;
}): KernelActionContext {
  return {
    records: [...input.records.values()].sort((left, right) => compareCodeUnits(left.id, right.id)),
    checkpoints: [...input.checkpoints.values()]
      .sort((left, right) => compareCodeUnits(left.id, right.id)),
  };
}
