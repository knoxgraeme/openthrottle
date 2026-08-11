import type { Config } from "../app/config.js";
import type { ActivityPublicationPort } from "../app/ports.js";
import type { SupervisorStore } from "../persistence/store.js";
import type { PipelineStore } from "../pipeline/store.js";
import type { RuntimeInventory, RuntimeInventoryResource, RuntimeStopper, SandboxRuntime } from "../runtime/contracts.js";
import { reapExpiredRuns } from "./reaper.js";
import {
  PERIODIC_RECLAIM_LIMIT,
  reclaimEligibleRuntimeResources,
  type RuntimeResourceReconciler,
} from "./runtime-resource-reclaim.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const WEBHOOK_REDELIVERY_PRUNE_LIMIT = 1_000;

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * MINUTE_MS).toISOString();
}

/**
 * Cron sweep, per SPEC "Event flows > 4. Sweep":
 *  - expired pipeline runs → stop/clean through coordinator effects
 *    sandbox + mark `expired`.
 *  - Daytona sandboxes labeled openthrottle=true with no matching DB row →
 *    delete (orphans).
 */
export async function runSweep(
  runtime: RuntimeInventory & RuntimeStopper & Pick<SandboxRuntime, "cleanup">,
  store: SupervisorStore,
  cfg: Config,
  pipelines: PipelineStore,
  activityPublisher: Pick<ActivityPublicationPort, "publishError">,
  reconcileWebhooks?: () => Promise<void>,
  reconcileRuntimeResources?: RuntimeResourceReconciler
): Promise<void> {
  await reapExpiredRuns({ runtime, store, activityPublisher, pipelines });
  try {
    await reconcileWebhooks?.();
  } catch (error) {
    console.error("[sweep] webhook reconciliation failed:", error);
  }
  await deleteOrphanSandboxes(runtime, store, pipelines, cfg);
  try {
    const reconcile = reconcileRuntimeResources ?? ((request) =>
      reclaimEligibleRuntimeResources({
        store: pipelines,
        tickets: store,
        runtime,
        cutoffIso: request.cutoffIso,
        limit: request.limit,
        trigger: request.trigger,
      }));
    await reconcile({
      cutoffIso: minutesAgoIso(cfg.runtimeResourceRetentionMinutes),
      limit: PERIODIC_RECLAIM_LIMIT,
      trigger: "runtime-resource-retention sweep",
    });
  } catch (error) {
    console.error("[sweep] runtime resource reclaim failed:", error);
  }
  const retentionCutoff = daysAgoIso(7);
  store.pruneDeliveries(retentionCutoff);
  store.pruneAcceptedGithubWebhookRedeliveryRequests(
    retentionCutoff,
    WEBHOOK_REDELIVERY_PRUNE_LIMIT
  );
  store.pruneSandboxEvents(retentionCutoff);
  store.pruneEphemeralLinearOutbox(retentionCutoff);
  pipelines.pruneRunOutcomes(daysAgoIso(cfg.runOutcomeRetentionDays));
}

async function deleteOrphanSandboxes(
  runtime: RuntimeInventory,
  store: SupervisorStore,
  pipelines: PipelineStore,
  cfg: Config
): Promise<void> {
  let sandboxes: RuntimeInventoryResource[];
  try {
    sandboxes = await runtime.listLabeledResources();
  } catch (err) {
    console.error("[sweep] failed to list Daytona sandboxes:", err);
    return;
  }

  for (const sandbox of sandboxes) {
    const ticket = store.getBySandboxId(sandbox.id);
    if (ticket && ticket.state !== "closed" && ticket.state !== "expired") {
      continue; // active, stopped, and error workspaces remain reusable
    }

    // tickets.sandbox_id is a projection a newer generation's delegation
    // overwrites (setSandboxId), so an older generation's still-bound
    // resource can look orphaned here even though a pipeline_instances row
    // still owns it -- the exact OPE-75 hole a review caught: this path's
    // ORPHAN_GRACE_MINUTES otherwise bypasses RUNTIME_RESOURCE_RETENTION_MINUTES
    // and the eligibility checks reclaimEligibleRuntimeResources enforces.
    // Defer entirely to that reconciler for anything still pipeline-bound.
    const boundInstance = pipelines.getInstanceByRuntimeResourceId(sandbox.id);
    if (boundInstance && pipelines.getRuntimeResource(boundInstance.id)?.status !== "cleaned") {
      continue;
    }

    // A sandbox can become visible to list() before handleCreated persists its
    // ID. Never sweep inside that provisioning window. Missing timestamps are
    // treated conservatively and retried on a later sweep.
    const createdAt = sandbox.createdAt ? Date.parse(sandbox.createdAt) : Number.NaN;
    if (
      Number.isNaN(createdAt) ||
      Date.now() - createdAt < cfg.orphanGraceMinutes * 60 * 1000
    ) {
      continue;
    }

    console.log(`[sweep] deleting orphan sandbox ${sandbox.id} (label ticket=${sandbox.labels?.ticket ?? "?"})`);
    try {
      await runtime.deleteResource(sandbox.id);
    } catch (err) {
      console.error(`[sweep] failed to delete orphan sandbox ${sandbox.id}:`, err);
    }
  }
}
