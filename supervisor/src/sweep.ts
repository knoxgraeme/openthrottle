import type { Daytona } from "@daytonaio/sdk";
import type { Config } from "./config.js";
import type { TicketStore } from "./db.js";
import { deleteSandbox, listLabeledSandboxes } from "./daytona.js";
import { commentCreate, type LinearClient } from "./linear.js";

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
  await expireStaleTickets(daytona, store, linear, cfg);
  await deleteOrphanSandboxes(daytona, store);
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
  store: TicketStore
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
    if (ticket && ticket.state === "active") continue; // known, still in use

    console.log(`[sweep] deleting orphan sandbox ${sandbox.id} (label ticket=${sandbox.labels?.ticket ?? "?"})`);
    try {
      await daytona.delete(sandbox, 60, false);
    } catch (err) {
      console.error(`[sweep] failed to delete orphan sandbox ${sandbox.id}:`, err);
    }
  }
}
