import type { Run, Ticket, SupervisorStore } from "../persistence/store.js";
import type { FaultAttribution } from "../pipeline/fault-attribution.js";
import type { RuntimeStopper } from "../runtime/contracts.js";
import { sanitizeText } from "../shared/sanitize.js";

export type ActorSettlementResult =
  | { kind: "settled"; run: Run }
  | { kind: "quarantined"; run: Run; message: string }
  | { kind: "lost" };

// Shared stop/settlement primitive. The database claim makes the actor
// non-dispatchable first; ticket exclusivity is released only after Daytona
// confirms termination. Callers publish effects only for the returned winner.
export async function terminateAndSettleActor(params: {
  runtime: RuntimeStopper;
  store: SupervisorStore;
  runId: string;
  sandboxId: string | null;
  owner: string;
  reason: string;
  // Stamped on the run alongside settlement_reason at reaping-claim time (see
  // run-store.ts claimRunForReapingTransaction). The caller already knows why
  // it is terminating this actor, so it is required rather than derived here.
  // NULL means no fault domain applies (an operator/system-initiated stop),
  // distinct from the first-class 'unknown' fault value.
  faultAttribution: FaultAttribution | null;
  status: "timed_out" | "stopped";
  ticketState?: Ticket["state"];
  failureTail?: string;
  ticketFailureTail?: string | null;
  prUrl?: string;
  quarantineOnStopFailure?: boolean;
  onTerminated?: () => void;
  onSettled?: (run: Run) => void;
}): Promise<ActorSettlementResult> {
  const claimed = params.store.claimRunForReaping(
    params.runId,
    params.owner,
    params.reason,
    params.faultAttribution
  );
  if (!claimed) return { kind: "lost" };

  try {
    if (params.sandboxId) await params.runtime.stopResource(params.sandboxId, params.reason);
    params.onTerminated?.();
  } catch (error) {
    if (params.quarantineOnStopFailure === false) throw error;
    const message = sanitizeText(
      `${params.reason} Actor termination could not be confirmed; the ticket remains quarantined: ${String(error)}`
    ).slice(0, 4_000);
    const quarantined = params.store.quarantineRun(params.runId, params.owner, message);
    return quarantined
      ? { kind: "quarantined", run: quarantined, message }
      : { kind: "lost" };
  }

  const settled = params.store.finishReapingRunAndThen(
    {
      runId: params.runId,
      owner: params.owner,
      status: params.status,
      failureTail: params.failureTail ?? params.reason,
      ticketFailureTail: params.ticketFailureTail,
      ticketState: params.ticketState,
      prUrl: params.prUrl,
    },
    (run) => params.onSettled?.(run)
  );
  return settled ? { kind: "settled", run: settled } : { kind: "lost" };
}
