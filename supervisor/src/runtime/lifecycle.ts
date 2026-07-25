import type { SupervisorStore } from "../persistence/store.js";
import type { SandboxAutostopRuntime } from "./contracts.js";

const MAX_RECONCILIATION_ATTEMPTS = 3;

export async function reconcileSandboxAutostop(params: {
  runtime: SandboxAutostopRuntime;
  store: SupervisorStore;
  issueId: string;
  providerResourceId: string;
}): Promise<void> {
  const { runtime, store, issueId, providerResourceId } = params;

  for (let attempt = 0; attempt < MAX_RECONCILIATION_ATTEMPTS; attempt += 1) {
    const shouldBeActive = Boolean(store.getByIssueId(issueId)?.run_id);
    if (shouldBeActive) await runtime.setActive(providerResourceId);
    else await runtime.setIdle(providerResourceId);

    if (Boolean(store.getByIssueId(issueId)?.run_id) === shouldBeActive) return;
  }

  throw new Error(`sandbox ${providerResourceId} lifecycle did not stabilize`);
}
