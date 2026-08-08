// The reclaim path for OPE-75: a terminal pipeline instance whose runtime
// resource was stopped-but-preserved (today, only the needs_human cleanup
// effect does this deliberately — see coordinator.ts terminalCleanupEffect)
// keeps billing Daytona memory forever, since nothing ever deletes it. This
// module is the bounded-retention reaper for that state: it finds terminal
// instances whose resource has sat `stopped` past the configured diagnostic
// window with nothing left that could still touch it, then deletes.
//
// Reused from two call sites with the same eligibility rule (never widened
// for urgency): the periodic sweep (operations/sweep.ts) walks the full
// backlog on the configured retention cutoff, and the capacity-constrained
// admission preflight (app/admission-preflight.ts, via a callback wired in
// index.ts) runs the identical pass once before rejecting a new delegation.
// Bypassing the retention window under capacity pressure would let an
// unrelated queue-full moment destroy another operator's still-fresh
// needs_human diagnostic workspace, so both paths honor it identically.
import type { PipelineInstance, PipelineRuntimeResource, PipelineStore } from "../pipeline/store.js";
import type { SupervisorStore } from "../persistence/store.js";
import type { SandboxRuntime } from "../runtime/contracts.js";
import { sanitizeText } from "../shared/sanitize.js";

export interface RuntimeResourceReclaimResult {
  reclaimed: number;
  candidates: number;
}

function eligibleBinding(store: PipelineStore, instance: PipelineInstance): PipelineRuntimeResource | undefined {
  if (!instance.terminal_outcome || !instance.runtime_provider_resource_id) return undefined;
  const binding = store.getRuntimeResource(instance.id);
  if (!binding || binding.status !== "stopped") return undefined;
  // No live action: a terminal instance should never have an active attempt,
  // but this is the exact safety this reclaim path must never get wrong, so
  // re-check rather than trust the (possibly stale) listing snapshot.
  if (store.getActiveAttempt(instance.id)) return undefined;
  // No unsettled effect: a crash mid-stop/mid-cleanup can leave the resource
  // `stopped` with its effect intent still pending or processing (claimed by
  // a lease, mid-retry). Deleting underneath that in-flight effect would
  // race its own idempotent cleanup call. Let it finish first.
  const unsettled = store.listEffects(instance.id).some(
    (effect) => effect.status === "pending" || effect.status === "processing"
  );
  return unsettled ? undefined : binding;
}

export async function reclaimEligibleRuntimeResources(params: {
  store: PipelineStore;
  tickets: SupervisorStore;
  runtime: Pick<SandboxRuntime, "cleanup">;
  cutoffIso: string;
  limit?: number;
  trigger: string;
}): Promise<RuntimeResourceReclaimResult> {
  const candidates = params.store.listReclaimableRuntimeResources(params.cutoffIso, params.limit ?? 50);
  let reclaimed = 0;
  for (const candidate of candidates) {
    // Re-fetch: the listing above can be stale by the time we act on it.
    const instance = params.store.getInstance(candidate.id);
    const binding = instance && eligibleBinding(params.store, instance);
    if (!instance || !binding) continue;
    try {
      // The Daytona adapter's cleanup() already treats provider "not found"
      // as success (duplicate cleanup / already-deleted converge for free);
      // the DB only records `cleaned` once this resolves.
      await params.runtime.cleanup({ providerResourceId: binding.provider_resource_id });
    } catch (error) {
      console.error(
        `[runtime-resource-reclaim] failed to delete runtime resource ${binding.provider_resource_id} for instance ${instance.id}:`,
        sanitizeText(String(error)).slice(-500)
      );
      continue;
    }
    params.store.setRuntimeResourceStatus(instance.id, "cleaned");
    const ticket = params.tickets.getByIssueId(instance.linear_issue_id);
    if (ticket?.linear_session_id === instance.linear_session_id &&
        ticket.sandbox_id === binding.provider_resource_id) {
      params.tickets.setSandboxId(instance.linear_issue_id, null);
    }
    try {
      params.store.recordJournalEntry({
        id: `journal-reclaim-${instance.id}`,
        issueId: instance.linear_issue_id,
        instanceId: instance.id,
        actor: "supervisor",
        kind: "run_note",
        trigger: params.trigger,
        action: "Reclaimed a stopped terminal runtime resource after its diagnostic-retention window elapsed.",
        outcome: instance.terminal_outcome,
        refs: {
          provider: binding.provider,
          provider_resource_id: binding.provider_resource_id,
          generation: instance.generation,
        },
      });
    } catch (error) {
      console.warn("[runtime-resource-reclaim] failed to record orchestration journal entry:", sanitizeText(String(error)));
    }
    reclaimed++;
  }
  return { reclaimed, candidates: candidates.length };
}
