import type { Daytona } from "@daytona/sdk";
import type { Config } from "./app/config.js";
import type { SupervisorStore } from "./persistence/store.js";
import { listLabeledSandboxes } from "./daytona.js";
import type { LinearOutboxProcessor } from "./linear-outbox.js";
import type { PipelineStore } from "./pipeline/store.js";
import { reapExpiredRuns } from "./reaper.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Cron sweep, per SPEC "Event flows > 4. Sweep":
 *  - expired pipeline runs → stop/clean through coordinator effects
 *    sandbox + mark `expired`.
 *  - Daytona sandboxes labeled openthrottle=true with no matching DB row →
 *    delete (orphans).
 */
export async function runSweep(
  daytona: Daytona,
  store: SupervisorStore,
  cfg: Config,
  pipelines: PipelineStore,
  linearOutbox: LinearOutboxProcessor
): Promise<void> {
  await reapExpiredRuns({ daytona, store, linearOutbox, pipelines });
  await deleteOrphanSandboxes(daytona, store, cfg);
  const retentionCutoff = new Date(Date.now() - 7 * DAY_MS).toISOString();
  store.pruneDeliveries(retentionCutoff);
  store.pruneSandboxEvents(retentionCutoff);
  store.pruneEphemeralLinearOutbox(retentionCutoff);
}

async function deleteOrphanSandboxes(
  daytona: Daytona,
  store: SupervisorStore,
  cfg: Config
): Promise<void> {
  let sandboxes;
  try {
    sandboxes = await listLabeledSandboxes(daytona);
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
      await daytona.delete(sandbox, 60, false);
    } catch (err) {
      console.error(`[sweep] failed to delete orphan sandbox ${sandbox.id}:`, err);
    }
  }
}
