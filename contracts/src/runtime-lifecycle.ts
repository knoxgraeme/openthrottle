import {
  PIPELINE_TERMINAL_OUTCOMES,
  type CompiledPipelineStage,
  type PipelineTerminalOutcome,
} from "./pipeline.js";
import { fail } from "./validation.js";

export const RUNTIME_PROVISION_STAGE_ID = "ot_runtime_provision";

export function runtimeStopStageId(outcome: PipelineTerminalOutcome): string {
  return `ot_runtime_stop_${outcome}`;
}

export function runtimeCleanupStageId(outcome: PipelineTerminalOutcome): string {
  return `ot_runtime_cleanup_${outcome}`;
}

/**
 * Adds private resource provisioning and reclamation to an authored pipeline.
 * These stages are runtime protocol, never filesystem authoring ceremony.
 */
export function expandCompiledRuntimeLifecycle(input: {
  entry_stage: string;
  stages: readonly CompiledPipelineStage[];
}): { entry_stage: string; stages: CompiledPipelineStage[] } {
  const reserved = new Set([
    RUNTIME_PROVISION_STAGE_ID,
    ...PIPELINE_TERMINAL_OUTCOMES.flatMap((outcome) => [
      runtimeStopStageId(outcome),
      runtimeCleanupStageId(outcome),
    ]),
  ]);
  const collision = input.stages.find(({ id }) => reserved.has(id));
  if (collision) fail(`pipeline.stages.${collision.id}`, "uses a compiler-reserved runtime stage ID");

  const rewritten = input.stages.map((stage): CompiledPipelineStage => ({
    ...stage,
    on: Object.fromEntries(Object.entries(stage.on).map(([outcome, transition]) => [
      outcome,
      transition.terminal === undefined
        ? transition
        : { to: runtimeStopStageId(transition.terminal) },
    ])),
  }));
  const lifecycle: CompiledPipelineStage[] = [{
    id: RUNTIME_PROVISION_STAGE_ID,
    kind: "effect",
    effect: "core/daytona-provision@1",
    on: {
      ...Object.fromEntries(PIPELINE_TERMINAL_OUTCOMES.map((outcome) => [
        `runtime_terminal_${outcome}`,
        { to: runtimeStopStageId(outcome) },
      ])),
      success: { to: input.entry_stage },
      no_change: { to: input.entry_stage },
      retryable_infrastructure_failure: {
        to: RUNTIME_PROVISION_STAGE_ID,
        max_reentries: 2,
        on_exhausted: "failed",
      },
      failure: { to: runtimeStopStageId("failed") },
      no_resource: { terminal: "failed" },
    },
  }];
  // A stop, supersede, or failure can occur from any authored stage, so each
  // terminal outcome needs a reclamation route even without an authored edge.
  for (const outcome of PIPELINE_TERMINAL_OUTCOMES) {
    const cleanupId = runtimeCleanupStageId(outcome);
    lifecycle.push({
      id: runtimeStopStageId(outcome),
      kind: "effect",
      effect: "core/daytona-stop@1",
      on: {
        success: { to: cleanupId },
        no_change: { to: cleanupId },
        retryable_infrastructure_failure: {
          to: runtimeStopStageId(outcome),
          max_reentries: 2,
          on_exhausted: "failed",
        },
        failure: { to: cleanupId },
      },
    });
    lifecycle.push({
      id: cleanupId,
      kind: "effect",
      effect: "core/daytona-cleanup@1",
      on: {
        success: { terminal: outcome },
        no_change: { terminal: outcome },
        retryable_infrastructure_failure: {
          to: cleanupId,
          max_reentries: 2,
          on_exhausted: "failed",
        },
        failure: { terminal: "failed" },
      },
    });
  }
  return {
    entry_stage: RUNTIME_PROVISION_STAGE_ID,
    stages: [...lifecycle, ...rewritten],
  };
}
