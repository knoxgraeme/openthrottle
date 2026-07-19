import type { Daytona } from "@daytona/sdk";
import type { TicketStore } from "./db.js";
import { setSandboxActive, setSandboxIdle } from "./daytona.js";

const MAX_RECONCILIATION_ATTEMPTS = 3;

export async function reconcileSandboxAutostop(params: {
  daytona: Daytona;
  store: TicketStore;
  issueId: string;
  sandboxId: string;
}): Promise<void> {
  const { daytona, store, issueId, sandboxId } = params;

  for (let attempt = 0; attempt < MAX_RECONCILIATION_ATTEMPTS; attempt += 1) {
    const shouldBeActive = Boolean(store.getByIssueId(issueId)?.run_id);
    if (shouldBeActive) await setSandboxActive(daytona, sandboxId);
    else await setSandboxIdle(daytona, sandboxId);

    if (Boolean(store.getByIssueId(issueId)?.run_id) === shouldBeActive) return;
  }

  throw new Error(`sandbox ${sandboxId} lifecycle did not stabilize`);
}
