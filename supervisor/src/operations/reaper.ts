// Feature 1: the heartbeat-silence reaper.
//
// `reapExpiredRuns` enforces the *hard* wall-clock cap: a run is
// killed once `runs.expires_at` passes, regardless of what it is doing. That
// does nothing for a run that wedges early — an agent that stops emitting
// anything while still an hour short of the 2h cap keeps a live Daytona sandbox
// burning for nothing.
//
// This reaper is the *liveness* cap. `store.listStalledRuns` returns running
// runs whose sealed executor heartbeat — or `started_at` before the first
// heartbeat — is at or before the stall cutoff. The reaper first claims a
// non-dispatchable state, then confirms termination before releasing ticket
// exclusivity. Failed termination is quarantined and remains operator-visible.

import { randomUUID } from "node:crypto";
import type { Config } from "../app/config.js";
import type { ActivityPublicationPort } from "../app/ports.js";
import type { SupervisorStore } from "../persistence/store.js";
import { terminateAndSettleActor } from "./actor-settlement.js";
import type { PipelineStore } from "../pipeline/store.js";
import { processPipelineInfrastructureFailure } from "../pipeline/control.js";
import { PIPELINE_OUTCOMES } from "../pipeline/manifest.js";
import type { RuntimeStopper } from "../runtime/contracts.js";

const TERMINAL_PIPELINE_STATUSES = new Set<string>(PIPELINE_OUTCOMES);
const ACTIVE_ATTEMPT_STATUSES = new Set([
  "pending",
  "leased",
  "dispatched",
  "acknowledged",
  "running",
]);

function pipelineRemainsHealthyAfterRunReap(params: {
  pipeline: ReturnType<PipelineStore["getInstance"]> | undefined;
  pipelineAttempt: ReturnType<PipelineStore["getAttemptForRun"]> | undefined;
}): boolean {
  if (!params.pipeline || !params.pipelineAttempt) return false;
  if (params.pipeline.terminal_outcome !== null || TERMINAL_PIPELINE_STATUSES.has(params.pipeline.status)) {
    return false;
  }
  return !ACTIVE_ATTEMPT_STATUSES.has(params.pipelineAttempt.status);
}

export async function reapStalledRuns(params: {
  runtime: RuntimeStopper;
  store: SupervisorStore;
  activityPublisher: Pick<ActivityPublicationPort, "publishError">;
  cfg: Config;
  pipelines?: PipelineStore;
}): Promise<void> {
  const { runtime, store, activityPublisher, cfg } = params;
  const now = new Date();
  const cutoffIso = new Date(now.getTime() - cfg.stallTimeoutSeconds * 1000).toISOString();
  const owner = `reaper-${randomUUID()}`;
  const renewLease = () => {
    const leaseNow = new Date();
    return store.acquireSupervisorLease(
      "stalled-run-reaper",
      owner,
      leaseNow.toISOString(),
      new Date(leaseNow.getTime() + 120_000).toISOString()
    );
  };
  if (!renewLease()) return;

  try {
    for (const run of store.listStalledRuns(cutoffIso)) {
      // Daytona stop is bounded to 60s, so renewing before every iteration
      // keeps this 120s lease live for arbitrarily large stalled backlogs.
      if (!renewLease()) {
        console.warn("[reaper] lost the stalled-run-reaper lease; ending this sweep");
        return;
      }
      try {
        const message = `OpenThrottle ${run.task_type} run reaped — no executor progress for over ${cfg.stallTimeoutSeconds}s. The stage executor likely crashed, never started, or exited without reporting a result; check the stage attempt logs.`;
        const ticket = store.getByIssueId(run.linear_issue_id);
        if (!ticket) continue;
        const pipelineAttempt = params.pipelines?.getAttemptForRun(run.id);
        const pipeline = pipelineAttempt
          ? params.pipelines?.getInstance(pipelineAttempt.pipeline_instance_id)
          : undefined;
        const pipelineStillHealthy = pipelineRemainsHealthyAfterRunReap({ pipeline, pipelineAttempt });
        const settlement = await terminateAndSettleActor({
          runtime,
          store,
          runId: run.id,
          sandboxId: ticket.sandbox_id,
          owner,
          reason: message,
          status: "timed_out",
          ticketState: pipelineStillHealthy ? "active" : "error",
          onSettled: pipeline
            ? () => processPipelineInfrastructureFailure({ store: params.pipelines!, runId: run.id })
            : undefined,
        });
        if (settlement.kind === "quarantined") {
          if (pipeline && params.pipelines?.getRuntimeResource(pipeline.id)) {
            params.pipelines.setRuntimeResourceStatus(pipeline.id, "quarantined");
          }
          await activityPublisher.publishError(
            run.linear_session_id ?? ticket.linear_session_id,
            ticket.linear_issue_id,
            settlement.message
          );
        } else if (settlement.kind === "settled" && !pipelineStillHealthy) {
          await activityPublisher.publishError(
            run.linear_session_id ?? ticket.linear_session_id,
            ticket.linear_issue_id,
            message
          );
        }
      } catch (error) {
        console.error(`[reaper] failed to reap stalled run ${run.id}:`, error);
      }
    }
  } finally {
    store.releaseSupervisorLease("stalled-run-reaper", owner);
  }
}

export async function reapExpiredRuns(params: {
  runtime: RuntimeStopper;
  store: SupervisorStore;
  activityPublisher: Pick<ActivityPublicationPort, "publishError">;
  pipelines: PipelineStore;
}): Promise<void> {
  const owner = `expiry-reaper-${randomUUID()}`;
  for (const run of params.store.listExpiredRuns(new Date().toISOString())) {
    const ticket = params.store.getByIssueId(run.linear_issue_id);
    if (!ticket) continue;
    const attempt = params.pipelines.getAttemptForRun(run.id);
    if (!attempt) continue;
    const pipeline = params.pipelines.getInstance(attempt.pipeline_instance_id);
    if (!pipeline) continue;
    const message = `OpenThrottle ${run.task_type} stage exceeded its hard execution timeout.`;
    const pipelineStillHealthy = pipelineRemainsHealthyAfterRunReap({
      pipeline,
      pipelineAttempt: attempt,
    });
    try {
      const settlement = await terminateAndSettleActor({
        runtime: params.runtime,
        store: params.store,
        runId: run.id,
        sandboxId: ticket.sandbox_id,
        owner,
        reason: message,
        status: "timed_out",
        ticketState: pipelineStillHealthy ? "active" : "error",
        onSettled: () => processPipelineInfrastructureFailure({
          store: params.pipelines,
          runId: run.id,
        }),
      });
      if (settlement.kind === "quarantined") {
        if (params.pipelines.getRuntimeResource(pipeline.id)) {
          params.pipelines.setRuntimeResourceStatus(pipeline.id, "quarantined");
        }
        await params.activityPublisher.publishError(
          run.linear_session_id ?? ticket.linear_session_id,
          ticket.linear_issue_id,
          settlement.message
        );
      } else if (settlement.kind === "settled" && !pipelineStillHealthy) {
        await params.activityPublisher.publishError(
          run.linear_session_id ?? ticket.linear_session_id,
          ticket.linear_issue_id,
          message
        );
      }
    } catch (error) {
      console.error(`[reaper] failed to reap expired run ${run.id}:`, error);
    }
  }
}
