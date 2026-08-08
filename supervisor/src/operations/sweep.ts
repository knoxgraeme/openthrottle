import type { Config } from "../app/config.js";
import type { ActivityPublicationPort } from "../app/ports.js";
import type { SupervisorStore } from "../persistence/store.js";
import type { PipelineStore } from "../pipeline/store.js";
import type { RuntimeInventory, RuntimeInventoryResource, RuntimeStopper, SandboxRuntime } from "../runtime/contracts.js";
import { reapExpiredRuns } from "./reaper.js";
import { reclaimEligibleRuntimeResources } from "./runtime-resource-reclaim.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

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
  reconcileWebhooks?: () => Promise<void>
): Promise<void> {
  await reapExpiredRuns({ runtime, store, activityPublisher, pipelines });
  try {
    await reconcileWebhooks?.();
  } catch (error) {
    console.error("[sweep] webhook reconciliation failed:", error);
  }
  await deleteOrphanSandboxes(runtime, store, cfg);
  try {
    await reclaimEligibleRuntimeResources({
      store: pipelines,
      tickets: store,
      runtime,
      cutoffIso: minutesAgoIso(cfg.runtimeResourceRetentionMinutes),
      trigger: "runtime-resource-retention sweep",
    });
  } catch (error) {
    console.error("[sweep] runtime resource reclaim failed:", error);
  }
  const retentionCutoff = daysAgoIso(7);
  store.pruneDeliveries(retentionCutoff);
  store.pruneSandboxEvents(retentionCutoff);
  store.pruneEphemeralLinearOutbox(retentionCutoff);
  pipelines.pruneRunOutcomes(daysAgoIso(cfg.runOutcomeRetentionDays));
}

async function deleteOrphanSandboxes(
  runtime: RuntimeInventory,
  store: SupervisorStore,
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
