import { evaluateStageGate } from "./gates.js";
import { coordinatePipelineEvent, type PipelineCoordinatorEvent } from "./coordinator.js";
import type { PipelineInstance, PipelineStore } from "./store.js";

// The stage settlement composes a persistence-facing run settlement with the
// deterministic pipeline reduction. It is typed against this narrow interface
// so pipeline/ stays free of concrete persistence imports; SupervisorStore
// satisfies it structurally.
export interface StageSettlementStore {
  finishRunAndThen<T>(
    params: {
      runId: string;
      status: "completed";
      exitCode: number;
      ticketState: "active";
    },
    after: () => T
  ): T;
}

// Settles the stage attempt actor and commits the pipeline transition in one
// replayable transaction: the fenced gate evaluation happens first, then the
// run's terminal settlement wraps the coordinator reduction so neither can be
// observed without the other.
export function completeStageAttemptActor(
  pipelines: PipelineStore,
  tickets: StageSettlementStore,
  event: PipelineCoordinatorEvent,
  options: { observedSubject?: string; faultAfterWrite?: (writeCount: number) => void } = {}
): PipelineInstance {
  const evaluated = evaluateStageGate(pipelines, event, options);
  if (!event.runId) throw new Error(`pipeline stage event ${event.id} has no run binding`);
  return tickets.finishRunAndThen(
    {
      runId: event.runId,
      status: "completed",
      exitCode: 0,
      ticketState: "active",
    },
    () => coordinatePipelineEvent(pipelines, evaluated.event, options.faultAfterWrite, evaluated.receipt)
  );
}
