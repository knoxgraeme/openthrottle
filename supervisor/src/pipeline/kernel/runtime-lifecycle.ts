import {
  PIPELINE_TERMINAL_OUTCOMES,
  RUNTIME_PROVISION_STAGE_ID,
  runtimeCleanupStageId,
  runtimeStopStageId,
  type CompiledPipelineStage,
  type PipelineTerminalOutcome,
} from "@openthrottle/contracts";

function matchingOutcome(
  stage: CompiledPipelineStage,
  idFor: (outcome: PipelineTerminalOutcome) => string,
  effect: string,
): PipelineTerminalOutcome | null {
  if (stage.kind !== "effect" || stage.effect !== effect) return null;
  return PIPELINE_TERMINAL_OUTCOMES.find((outcome) => stage.id === idFor(outcome)) ?? null;
}

export function runtimeStopOutcome(
  stage: CompiledPipelineStage,
): PipelineTerminalOutcome | null {
  return matchingOutcome(stage, runtimeStopStageId, "core/daytona-stop@1");
}

export function runtimeCleanupOutcome(
  stage: CompiledPipelineStage,
): PipelineTerminalOutcome | null {
  return matchingOutcome(stage, runtimeCleanupStageId, "core/daytona-cleanup@1");
}

/** Runtime retry exhaustion still follows reclamation instead of terminalizing early. */
export function runtimeExhaustionDestination(
  stage: CompiledPipelineStage,
): string | null {
  if (
    stage.id === RUNTIME_PROVISION_STAGE_ID && stage.kind === "effect" &&
    stage.effect === "core/daytona-provision@1"
  ) return runtimeStopStageId("failed");
  const stopOutcome = runtimeStopOutcome(stage);
  return stopOutcome === null ? null : runtimeCleanupStageId(stopOutcome);
}
