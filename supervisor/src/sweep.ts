import type { Daytona } from "@daytona/sdk";
import type { Config } from "./config.js";
import type { TicketStore } from "./db.js";
import { deleteSandbox, listLabeledSandboxes } from "./daytona.js";
import { commentCreate, type LinearClient } from "./linear.js";
import { createLinearOutboxProcessor } from "./linear-outbox.js";
import { expireRun } from "./server.js";
import { redrainStalledSessionWork } from "./run-lifecycle.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Cron sweep, per SPEC "Event flows > 4. Sweep":
 *  - active rows older than SWEEP_MAX_AGE_DAYS with no PR → notify + delete
 *    sandbox + mark `expired`.
 *  - Daytona sandboxes labeled openthrottle=true with no matching DB row →
 *    delete (orphans).
 */
export async function runSweep(
  daytona: Daytona,
  store: TicketStore,
  linear: LinearClient | undefined,
  cfg: Config
): Promise<void> {
  const linearOutbox = createLinearOutboxProcessor({
    store,
    getLinearClient: async () => linear,
  });
  for (const run of store.listExpiredRuns(new Date().toISOString())) {
    await expireRun(daytona, store, linearOutbox, run);
  }
  await expireStaleTickets(daytona, store, linear, cfg);
  await deleteOrphanSandboxes(daytona, store, cfg);
  // Recover any feedback work that was enqueued but never drained (a completeRun
  // drain that was skipped or failed): without this, one missed drain strands a
  // PR review forever, since nothing else re-triggers a drain.
  await redrainStalledSessionWork({ cfg, store, daytona, linear, linearOutbox });
  const retentionCutoff = new Date(Date.now() - 7 * DAY_MS).toISOString();
  store.pruneDeliveries(retentionCutoff);
  store.pruneSandboxEvents(retentionCutoff);
}

async function expireStaleTickets(
  daytona: Daytona,
  store: TicketStore,
  linear: LinearClient | undefined,
  cfg: Config
): Promise<void> {
  const maxAgeMs = cfg.sweepMaxAgeDays * DAY_MS;
  const now = Date.now();

  for (const ticket of store.listActive()) {
    if (ticket.pr_url) continue; // has PR activity — leave alone
    const createdMs = Date.parse(ticket.created_at);
    if (Number.isNaN(createdMs)) continue;
    if (now - createdMs < maxAgeMs) continue;

    console.log(
      `[sweep] expiring ticket ${ticket.linear_issue_identifier} (age > ${cfg.sweepMaxAgeDays}d, no PR)`
    );

    if (linear) {
      try {
        await commentCreate(linear, {
          issueId: ticket.linear_issue_id,
          body: `OpenThrottle: this workspace has been idle for over ${cfg.sweepMaxAgeDays} days with no PR opened, so it has been cleaned up. Re-delegate the issue to start fresh.`,
        });
      } catch (err) {
        console.error(
          `[sweep] failed to post expiry comment for ${ticket.linear_issue_identifier}:`,
          err
        );
      }
    }

    if (ticket.sandbox_id) {
      try {
        await deleteSandbox(daytona, ticket.sandbox_id);
      } catch (err) {
        console.error(
          `[sweep] failed to delete sandbox ${ticket.sandbox_id} for ${ticket.linear_issue_identifier}:`,
          err
        );
      }
    }

    store.setState(ticket.linear_issue_id, "expired");
  }
}

async function deleteOrphanSandboxes(
  daytona: Daytona,
  store: TicketStore,
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
