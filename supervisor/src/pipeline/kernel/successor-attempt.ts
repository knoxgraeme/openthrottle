import {
  compareCodeUnits,
  digestCanonicalJson,
  runtimeStopStageId,
  type AttemptCheckpoint,
  type DecisionRecord,
  type DefinitionBundle,
  type CompiledPipelineManifest,
  type CompiledPipelineStage,
  type ExecutionRecord,
  type ResultRecord,
  type PipelineTerminalOutcome,
} from "@openthrottle/contracts";
import { createPendingKernelAttempt } from "./action-request.js";
import type { KernelAttemptRequestInputs, ReductionView } from "./ports.js";
import type { AttemptScope, KernelAttempt } from "./types.js";
import type { KernelRun } from "./types.js";
import {
  exactKernelRuntimeCleanupDeliveries,
  exactKernelRuntimeResourcePoolDeliveries,
} from "./runtime-resource.js";
import { exactSandboxRecoveryRecord } from "./sandbox-recovery.js";
import {
  runtimeCleanupOutcome,
  runtimeExhaustionDestination,
} from "./runtime-lifecycle.js";
import {
  exactConfirmedGithubPushDelivery,
  isGithubPushDelivery,
} from "./github-push-delivery.js";
import { sessionEvidenceRecords } from "./session-evidence.js";

export function mergeCausalGithubPushContext(input: {
  pipeline_run_id: string;
  base_records: readonly ExecutionRecord[];
  inherited_records: readonly ExecutionRecord[];
  additional_records?: readonly ExecutionRecord[];
}): ExecutionRecord[] {
  const additional = input.additional_records ?? [];
  const override = exactConfirmedGithubPushDelivery({
    // A rejected publication is causal failure evidence, not a reusable
    // publication anchor. The settlement DecisionRecord already cites it;
    // successor context retains only the last exact confirmed push.
    records: additional.filter((record) =>
      isGithubPushDelivery(record) && record.status === "confirmed"
    ),
    label: "additional context",
    pipeline_run_id: input.pipeline_run_id,
  });
  const inherited = override === null
    ? exactConfirmedGithubPushDelivery({
      records: input.inherited_records.filter((record) =>
        isGithubPushDelivery(record) && record.status === "confirmed"
      ),
      label: "inherited context",
      pipeline_run_id: input.pipeline_run_id,
    })
    : null;
  const selected = override ?? inherited;
  return [...new Map([
    ...input.base_records.filter((record) => !isGithubPushDelivery(record)),
    ...sessionEvidenceRecords(input.inherited_records),
    ...additional.filter((record) => !isGithubPushDelivery(record)),
    ...(selected === null ? [] : [selected.record]),
  ].map((record) => [record.id, record])).values()]
    .sort((left, right) => compareCodeUnits(left.id, right.id));
}

export function kernelSuccessorStageId(input: {
  manifest: CompiledPipelineManifest;
  run: KernelRun;
  stage: CompiledPipelineStage;
  outcome: string;
}): string | null {
  const transition = input.stage.on[input.outcome];
  if (!transition) throw new Error(`stage ${input.stage.id} has no transition for ${input.outcome}`);
  if (transition.terminal !== undefined) return null;
  if (transition.to === undefined) throw new Error("pipeline transition has no destination");
  if (transition.max_reentries !== undefined) {
    const edge = `${input.stage.id}:${input.outcome}:${transition.to}`;
    if ((input.run.cursor.reentries[edge] ?? 0) >= transition.max_reentries) {
      if (runtimeCleanupOutcome(input.stage) !== null) return null;
      return runtimeExhaustionDestination(input.stage) ??
        runtimeStopStageId(transition.on_exhausted!);
    }
  }
  return transition.to;
}

export function deriveKernelSuccessorAttempt(input: {
  view: ReductionView;
  current: KernelAttempt;
  result: ResultRecord;
  decision: DecisionRecord;
  bundle: DefinitionBundle;
  target_scope: AttemptScope;
  request_inputs: KernelAttemptRequestInputs;
  checkpoint_override?: readonly AttemptCheckpoint[];
  additional_context_records?: readonly ExecutionRecord[];
}): KernelAttempt {
  const id = `attempt-${digestCanonicalJson({
    schema: "openthrottle.kernel-successor-attempt/v1",
    pipeline_run_id: input.view.run.id,
    from_attempt_id: input.current.id,
    decision_id: input.decision.id,
    target_scope: input.target_scope,
    next_cursor_version: input.view.run.cursor.version + 1,
  }).slice(0, 48)}`;
  const inheritedRecords = [...input.request_inputs.context.records.values()];
  const targetStage = input.view.manifest.stages.find(
    ({ id }) => id === input.target_scope.stage_id,
  );
  const cleanupOutcome = targetStage === undefined ? null : runtimeCleanupOutcome(targetStage);
  const runtimeResourceRecords = cleanupOutcome === null
    ? exactKernelRuntimeResourcePoolDeliveries(inheritedRecords) ?? []
    : exactKernelRuntimeCleanupDeliveries(inheritedRecords);
  if (runtimeResourceRecords === null) {
    throw new Error("runtime cleanup successor requires exact confirmed Daytona create evidence");
  }
  const recoveryRecord = exactSandboxRecoveryRecord(
    inheritedRecords,
  );
  const uniqueRecords = mergeCausalGithubPushContext({
    pipeline_run_id: input.view.run.id,
    base_records: [
      input.result,
      input.decision,
      ...runtimeResourceRecords,
      ...(recoveryRecord === null ? [] : [recoveryRecord]),
    ],
    inherited_records: inheritedRecords,
    additional_records: input.additional_context_records,
  });
  const checkpoints = [
    ...(input.checkpoint_override ?? input.request_inputs.context.checkpoints.values()),
  ]
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  return createPendingKernelAttempt({
    id,
    pipeline_run_id: input.view.run.id,
    scope: input.target_scope,
    input_subject: input.current.output_subject ?? input.current.input_subject,
    bundle: input.bundle,
    manifest: input.view.manifest,
    action_inputs: {
      task_prompt: input.request_inputs.task_prompt,
      context: { records: uniqueRecords, checkpoints },
    },
  });
}

export function deriveKernelTerminalCleanupAttempt(input: {
  view: ReductionView;
  current: KernelAttempt;
  decision: DecisionRecord;
  bundle: DefinitionBundle;
  outcome: PipelineTerminalOutcome;
  task_prompt: string;
  runtime_delivery_records: readonly ExecutionRecord[];
  diagnostic_records?: readonly ExecutionRecord[];
  recovery_frontier_records?: readonly ExecutionRecord[];
  recovery_trigger_records?: readonly ExecutionRecord[];
}): KernelAttempt {
  const deliveries = exactKernelRuntimeCleanupDeliveries(input.runtime_delivery_records);
  if (deliveries === null) {
    throw new Error("terminal cleanup requires exact confirmed Daytona create evidence for every target");
  }
  const targetStageId = runtimeStopStageId(input.outcome);
  const target = input.view.manifest.stages.find(({ id }) => id === targetStageId);
  if (!target || target.kind !== "effect" || target.effect !== "core/daytona-stop@1") {
    throw new Error(`compiled manifest has no exact runtime stop stage for ${input.outcome}`);
  }
  const records: ExecutionRecord[] = [
    input.decision,
    ...(input.recovery_frontier_records ?? []),
    ...(input.recovery_trigger_records ?? []),
    ...(input.diagnostic_records ?? []),
    ...deliveries,
  ]
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  return createPendingKernelAttempt({
    id: `attempt-${digestCanonicalJson({
      schema: "openthrottle.kernel-terminal-cleanup-attempt/v1",
      pipeline_run_id: input.view.run.id,
      from_attempt_id: input.current.id,
      decision_id: input.decision.id,
      outcome: input.outcome,
      target_stage_id: targetStageId,
      next_cursor_version: input.view.run.cursor.version + 1,
    }).slice(0, 48)}`,
    pipeline_run_id: input.view.run.id,
    scope: { kind: "stage", stage_id: targetStageId },
    input_subject: input.view.run.current_subject,
    bundle: input.bundle,
    manifest: input.view.manifest,
    action_inputs: {
      task_prompt: input.task_prompt,
      context: { records, checkpoints: [] },
    },
  });
}
