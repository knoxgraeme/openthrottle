import type { Daytona } from "@daytona/sdk";
import type { Run, Ticket, TicketStore } from "./db.js";
import { stopSandbox } from "./daytona.js";
import { sanitizeText } from "./sanitize.js";

export type ActorSettlementResult =
  | { kind: "settled"; run: Run }
  | { kind: "quarantined"; run: Run; message: string }
  | { kind: "lost" };

// Shared stop/settlement primitive. The database claim makes the actor
// non-dispatchable first; ticket exclusivity is released only after Daytona
// confirms termination. Callers publish effects only for the returned winner.
export async function terminateAndSettleActor(params: {
  daytona: Daytona;
  store: TicketStore;
  runId: string;
  sandboxId: string | null;
  owner: string;
  reason: string;
  status: "timed_out" | "stopped";
  ticketState: Ticket["state"];
  prUrl?: string;
  onSettled?: (run: Run) => void;
}): Promise<ActorSettlementResult> {
  const claimed = params.store.claimRunForReaping(params.runId, params.owner, params.reason);
  if (!claimed) return { kind: "lost" };

  try {
    if (params.sandboxId) await stopSandbox(params.daytona, params.sandboxId);
  } catch (error) {
    const message = sanitizeText(
      `${params.reason} Actor termination could not be confirmed; the ticket remains quarantined: ${String(error)}`
    ).slice(0, 4_000);
    const quarantined = params.store.quarantineRun(params.runId, params.owner, message);
    return quarantined
      ? { kind: "quarantined", run: quarantined, message }
      : { kind: "lost" };
  }

  const settled = params.store.db.transaction(() => {
    const result = params.store.finishReapingRun({
      runId: params.runId,
      owner: params.owner,
      status: params.status,
      failureTail: params.reason,
      ticketState: params.ticketState,
      prUrl: params.prUrl,
    });
    if (result) params.onSettled?.(result);
    return result;
  }).immediate();
  return settled ? { kind: "settled", run: settled } : { kind: "lost" };
}
