import { canonicalJson, digestNormalized } from "./pipeline-manifest.js";
import { coordinatePipelineEvent } from "./pipeline-coordinator.js";
import type { PipelineInstance, PipelineStore } from "./pipeline-store.js";

const TERMINAL_STATUSES = new Set([
  "shipped",
  "no_change",
  "needs_human",
  "canceled",
  "superseded",
  "failed",
]);

export function requestPipelineStop(input: {
  store: PipelineStore;
  sessionId: string;
  eventId: string;
  reason: string;
  ticketState?: "stopped" | "closed";
}): PipelineInstance | undefined {
  const instance = input.store.getInstanceForSession(input.sessionId);
  if (!instance || TERMINAL_STATUSES.has(instance.status)) return instance;
  const attempt = input.store.getActiveAttempt(instance.id);
  // A stage result may already have settled the attempt while its terminal
  // publication is still draining. There is no live actor to cancel then.
  if (!attempt) return instance;
  const resultPayload = canonicalJson({
    schema: "openthrottle.pipeline-control/v1",
    command: "stop",
    pipeline_instance_id: instance.id,
    generation: instance.generation,
    reason: input.reason,
    ticket_state: input.ticketState ?? "stopped",
  });
  return coordinatePipelineEvent(input.store, {
    id: input.eventId,
    kind: "stop",
    instanceId: instance.id,
    generation: instance.generation,
    attemptId: attempt.id,
    requestHash: attempt.request_hash,
    outcome: "canceled",
    resultHash: digestNormalized(resultPayload),
    subject: instance.immutable_subject,
    nativeSessionId: attempt.native_session_id,
    controlTicketState: input.ticketState,
  });
}

export function canSteerPipelineRun(input: {
  store: PipelineStore;
  sessionId: string;
  runId: string | null;
  agent: "claude" | "codex" | "opencode";
}): boolean {
  if (!input.runId || input.agent === "opencode") return false;
  const instance = input.store.getInstanceForSession(input.sessionId);
  if (!instance || instance.status !== "running") return false;
  const attempt = input.store.getActiveAttempt(instance.id);
  if (!attempt || attempt.run_id !== input.runId || attempt.status !== "running") return false;
  const request = input.store.getStageRequest(attempt.id);
  return request.runId === input.runId && request.liveSteering;
}

export function processPipelineInfrastructureFailure(input: {
  store: PipelineStore;
  runId: string;
}): PipelineInstance | undefined {
  const attempt = input.store.getAttemptForRun(input.runId);
  if (!attempt) return undefined;
  const instance = input.store.getInstance(attempt.pipeline_instance_id);
  if (!instance) throw new Error(`pipeline run ${input.runId} has no pinned instance`);
  const resultPayload = canonicalJson({
    schema: "openthrottle.pipeline-control/v1",
    event: "actor_lease_expired",
    pipeline_instance_id: instance.id,
    attempt_id: attempt.id,
    run_id: input.runId,
  });
  return coordinatePipelineEvent(input.store, {
    id: `pipeline-run-failed:${input.runId}`,
    kind: "effect_failed",
    instanceId: instance.id,
    generation: instance.generation,
    runId: input.runId,
    stageId: attempt.stage_id,
    attemptId: attempt.id,
    requestHash: attempt.request_hash,
    outcome: "retryable_infrastructure_failure",
    resultHash: digestNormalized(resultPayload),
    subject: attempt.expected_subject ?? instance.immutable_subject,
    nativeSessionId: attempt.native_session_id,
  });
}
