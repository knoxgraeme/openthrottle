// Feature 1: the heartbeat-silence reaper.
//
// `expireRun` (run-lifecycle.ts) enforces the *hard* wall-clock cap: a run is
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

import type { Daytona } from "@daytona/sdk";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { TicketStore } from "./db.js";
import { terminateAndSettleActor } from "./actor-settlement.js";
import { tryPostError, type LinearOutboxProcessor } from "./linear-outbox.js";

export async function reapStalledRuns(params: {
  daytona: Daytona;
  store: TicketStore;
  linearOutbox: LinearOutboxProcessor;
  cfg: Config;
}): Promise<void> {
  const { daytona, store, linearOutbox, cfg } = params;
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
        const message = `OpenThrottle ${run.task_type} run reaped — no executor heartbeat for over ${cfg.stallTimeoutSeconds}s (stalled).`;
        const ticket = store.getByIssueId(run.linear_issue_id);
        if (!ticket) continue;
        const settlement = await terminateAndSettleActor({
          daytona,
          store,
          runId: run.id,
          sandboxId: ticket.sandbox_id,
          owner,
          reason: message,
          status: "timed_out",
          ticketState: "error",
        });
        if (settlement.kind === "quarantined") {
          await tryPostError(
            store,
            linearOutbox,
            run.linear_session_id ?? ticket.linear_session_id,
            ticket.linear_issue_id,
            settlement.message
          );
        } else if (settlement.kind === "settled") {
          await tryPostError(
            store,
            linearOutbox,
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
