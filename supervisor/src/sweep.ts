import type { Config } from "./config.js";
import type { TicketStore } from "./db.js";
import type { SpritesClient } from "./sprites.js";
import { deleteSandbox, listLabeledSandboxes } from "./sprites.js";
import { commentCreate, type LinearClient } from "./linear.js";
import { createLinearOutboxProcessor } from "./linear-outbox.js";
import { drainSpooledEventsForRun, expireRun } from "./server.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Cron sweep, per SPEC "Event flows > 4. Sweep":
 *  - overdue runs → best-effort drain of any events the sandbox spooled to disk
 *    (push-failure fallback), then time out whatever is still running.
 *  - active rows older than SWEEP_MAX_AGE_DAYS with no PR → notify + delete
 *    sandbox + mark `expired`.
 *  - Sprites labeled `ot-*` with no matching DB row → delete (orphans).
 */
export async function runSweep(
  sprites: SpritesClient,
  store: TicketStore,
  linear: LinearClient | undefined,
  cfg: Config
): Promise<void> {
  const linearOutbox = createLinearOutboxProcessor({
    store,
    getLinearClient: async () => linear,
  });
  const getLinearClient = async () => linear;
  for (const run of store.listExpiredRuns(new Date().toISOString())) {
    await drainSpooledEventsForRun(
      { cfg, store, sprites, getLinearClient, linearOutbox },
      run
    );
    const current = store.getRun(run.id);
    if (current?.status === "running") {
      await expireRun(store, linearOutbox, current);
    }
  }
  await expireStaleTickets(sprites, store, linear, cfg);
  await deleteOrphanSandboxes(sprites, store, cfg);
  const retentionCutoff = new Date(Date.now() - 7 * DAY_MS).toISOString();
  store.pruneDeliveries(retentionCutoff);
  store.pruneSandboxEvents(retentionCutoff);
}

async function expireStaleTickets(
  sprites: SpritesClient,
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
        await deleteSandbox(sprites, ticket.sandbox_id);
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
  sprites: SpritesClient,
  store: TicketStore,
  cfg: Config
): Promise<void> {
  let sandboxes;
  try {
    sandboxes = await listLabeledSandboxes(sprites);
  } catch (err) {
    console.error("[sweep] failed to list sprites:", err);
    return;
  }

  for (const sandbox of sandboxes) {
    const ticket = store.getBySandboxId(sandbox.name);
    if (ticket && ticket.state !== "closed" && ticket.state !== "expired") {
      continue; // active, stopped, and error workspaces remain reusable
    }

    // A sprite can become visible to list() before handleCreated persists its
    // name. Never sweep inside that provisioning window: sprite handles expose
    // `updatedAt`, so a recently-touched orphan is left for a later sweep.
    // Missing/unparseable timestamps are treated conservatively and retried.
    if (!ticket) {
      const updatedAt = sandbox.updatedAt ? Date.parse(sandbox.updatedAt) : Number.NaN;
      if (
        Number.isNaN(updatedAt) ||
        Date.now() - updatedAt < cfg.orphanGraceMinutes * 60 * 1000
      ) {
        continue;
      }
    }

    console.log(`[sweep] deleting orphan sprite ${sandbox.name}`);
    try {
      await deleteSandbox(sprites, sandbox.name);
    } catch (err) {
      console.error(`[sweep] failed to delete orphan sprite ${sandbox.name}:`, err);
    }
  }
}
