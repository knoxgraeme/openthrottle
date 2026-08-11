// The reclaim path for OPE-75: a terminal pipeline instance whose runtime
// resource was stopped-but-preserved (today, only the needs_human cleanup
// effect does this deliberately — see coordinator.ts terminalCleanupEffect)
// keeps billing Daytona memory forever, since nothing ever deletes it. This
// module is the bounded-retention reaper for that state: it finds terminal
// instances whose resource has sat `stopped` past the configured diagnostic
// window with nothing left that could still touch it, then deletes.
//
// Reused from all cleanup triggers with the same eligibility rule (never
// widened for urgency): the periodic sweep (operations/sweep.ts) walks a
// larger batch on the configured retention cutoff, while capacity-constrained
// hot paths run one bounded pass before rejecting or retrying. One production
// single-flight coordinates those triggers so slow provider calls do not
// multiply under concurrent admissions/effect drains.
// Bypassing the retention window under capacity pressure would let an
// unrelated queue-full moment destroy another operator's still-fresh
// needs_human diagnostic workspace, so every path honors it identically.
import type { PipelineInstance, PipelineRuntimeResource, PipelineStore } from "../pipeline/store.js";
import type { SupervisorStore } from "../persistence/store.js";
import type { SandboxRuntime } from "../runtime/contracts.js";
import { sanitizeText } from "../shared/sanitize.js";

export interface RuntimeResourceReclaimResult {
  reclaimed: number;
  candidates: number;
}

export interface RuntimeResourceReclaimRequest {
  cutoffIso: string;
  limit?: number;
  trigger: string;
  /**
   * Bound how long a latency-sensitive caller waits for the shared pass. The
   * provider operation is deliberately allowed to finish in the background;
   * the single-flight reconciler keeps ownership until it settles so another
   * trigger cannot overlap the same cleanup work.
   */
  waitTimeoutMs?: number;
}

export type RuntimeResourceReconciler = (
  request: RuntimeResourceReclaimRequest
) => Promise<RuntimeResourceReclaimResult>;

export const HOT_PATH_RECLAIM_LIMIT = 1;
export const HOT_PATH_RECLAIM_WAIT_TIMEOUT_MS = 5_000;
export const PERIODIC_RECLAIM_LIMIT = 50;

function eligibleBinding(
  store: PipelineStore,
  instance: PipelineInstance,
  cutoffIso: string
): PipelineRuntimeResource | undefined {
  if (!instance.terminal_outcome || !instance.runtime_provider_resource_id) return undefined;
  const binding = store.getRuntimeResource(instance.id);
  if (!binding || binding.status !== "stopped") return undefined;
  // The candidate listing is only a snapshot. A concurrent stop/re-stop can
  // refresh this timestamp while the pass is waiting on an earlier provider
  // deletion, starting a new diagnostic-retention window. Re-check the exact
  // binding immediately before deletion rather than trusting the stale row.
  if (binding.updated_at > cutoffIso) return undefined;
  // No live action: a terminal instance should never have an active attempt,
  // but this is the exact safety this reclaim path must never get wrong, so
  // re-check rather than trust the (possibly stale) listing snapshot.
  if (store.getActiveAttempt(instance.id)) return undefined;
  // No unsettled effect: a crash mid-stop/mid-cleanup can leave the resource
  // `stopped` with its effect intent still pending, processing (claimed by a
  // lease), or retryable failed. Deleting underneath that unsettled effect would
  // race its own idempotent cleanup call. Let it finish first.
  const unsettled = store.listEffects(instance.id).some(
    (effect) => effect.status !== "acknowledged" && effect.status !== "dead"
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
  const candidates = params.store.listReclaimableRuntimeResources(
    params.cutoffIso,
    params.limit ?? PERIODIC_RECLAIM_LIMIT
  );
  let reclaimed = 0;
  for (const candidate of candidates) {
    // Re-fetch: the listing above can be stale by the time we act on it.
    const instance = params.store.getInstance(candidate.id);
    const binding = instance && eligibleBinding(params.store, instance, params.cutoffIso);
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
    const ticket = params.tickets.getByIssueId(instance.ticket_id);
    if (ticket?.session_id === instance.session_id &&
        ticket.sandbox_id === binding.provider_resource_id) {
      params.tickets.setSandboxId(instance.ticket_id, null);
    }
    try {
      params.store.recordJournalEntry({
        id: `journal-reclaim-${instance.id}`,
        issueId: instance.ticket_id,
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

function waitForPass(
  pass: Promise<RuntimeResourceReclaimResult>,
  timeoutMs: number
): Promise<RuntimeResourceReclaimResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => resolve({ reclaimed: 0, candidates: 0 }),
      Math.max(0, timeoutMs)
    );
    pass.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Serialize all local reclaim triggers for one supervisor composition root.
 * A latency-sensitive caller may stop waiting after its small budget, but the
 * provider cleanup retains the single-flight slot until it actually settles.
 * Periodic sweeps wait for any hot-path pass, then start their own bulk pass so
 * candidates beyond the hot-path limit remain durably queued for the sweep.
 */
export function createRuntimeResourceReconciler(deps: {
  store: PipelineStore;
  tickets: SupervisorStore;
  runtime: Pick<SandboxRuntime, "cleanup">;
}): RuntimeResourceReconciler {
  let active: Promise<RuntimeResourceReclaimResult> | undefined;

  const start = (request: RuntimeResourceReclaimRequest): Promise<RuntimeResourceReclaimResult> => {
    const pass = reclaimEligibleRuntimeResources({
      ...deps,
      cutoffIso: request.cutoffIso,
      limit: request.limit,
      trigger: request.trigger,
    });
    active = pass;
    const clear = () => {
      if (active === pass) active = undefined;
    };
    // Register both outcomes so a timed-out caller never leaves a background
    // rejection unobserved. The original promise still rejects for a caller
    // that remained within its wait budget.
    pass.then(clear, clear);
    return pass;
  };

  return async (request) => {
    if (request.waitTimeoutMs !== undefined) {
      const pass = active ?? start(request);
      return waitForPass(pass, request.waitTimeoutMs);
    }

    // A periodic bulk sweep should not overlap a hot pass, but it also should
    // not lose its larger batch merely because a one-candidate pass was active
    // when the interval fired.
    while (active) {
      try {
        await active;
      } catch {
        // The bulk pass below gets an independent opportunity to recover.
      }
    }
    return start(request);
  };
}
