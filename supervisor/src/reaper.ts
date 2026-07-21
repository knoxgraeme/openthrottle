// Feature 1: the heartbeat-silence reaper.
//
// `expireRun` (run-lifecycle.ts) enforces the *hard* wall-clock cap: a run is
// killed once `runs.expires_at` passes, regardless of what it is doing. That
// does nothing for a run that wedges early — an agent that stops emitting
// anything while still an hour short of the 2h cap keeps a live Daytona sandbox
// burning for nothing.
//
// This reaper is the *liveness* cap. `store.listStalledRuns` returns running
// runs whose most recent `sandbox_events.created_at` — or `started_at`, if the
// run has produced no events yet — is at or before the stall cutoff. Because
// `runner/normalize.mjs` emits throttled heartbeat `thought`s, a genuinely
// working agent keeps refreshing that timestamp; only true silence trips this.
// Per-run handling mirrors `expireRun`: finish the run `timed_out`, flip the
// ticket to `error` (which clears its run_id/running_since so the sandbox
// naturally idles), settle the sandbox, and post an error activity to Linear.

import type { Daytona } from "@daytona/sdk";
import type { Config } from "./config.js";
import type { TicketStore } from "./db.js";
import { scheduleSandboxSettlement } from "./run-lifecycle.js";
import { tryPostError, type LinearOutboxProcessor } from "./linear-outbox.js";

export async function reapStalledRuns(params: {
  daytona: Daytona;
  store: TicketStore;
  linearOutbox: LinearOutboxProcessor;
  cfg: Config;
}): Promise<void> {
  const { daytona, store, linearOutbox, cfg } = params;
  const cutoffIso = new Date(Date.now() - cfg.stallTimeoutSeconds * 1000).toISOString();

  for (const run of store.listStalledRuns(cutoffIso)) {
    // Match sweep.ts resilience: one wedged run must not abort the reap of the
    // others, so each is isolated in its own try/catch.
    try {
      const message = `OpenThrottle ${run.task_type} run reaped — no sandbox activity for over ${cfg.stallTimeoutSeconds}s (stalled).`;
      store.finishRun({
        runId: run.id,
        status: "timed_out",
        failureTail: message,
        ticketState: "error",
      });
      const ticket = store.getByIssueId(run.linear_issue_id);
      if (ticket) {
        scheduleSandboxSettlement({ daytona, store, ticket, taskType: run.task_type });
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
}
