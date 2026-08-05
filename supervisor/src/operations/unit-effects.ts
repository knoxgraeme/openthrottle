import type { ExecutionUnitStore, ExecutionWorkAttempt } from "../persistence/pipeline/unit-store.js";
import type { ExecutionGateDecision } from "../pipeline/execution-gates.js";

export interface UnitEffectRuntime {
  dispatchUnitAction(action: ExecutionWorkAttempt): Promise<{
    requestHash: string;
    nativeSessionId?: string | null;
  }>;
  collectUnitAction(action: ExecutionWorkAttempt): Promise<{
    terminal?: false;
    resultHash: string;
    outputSubject: string;
    receipt?: string;
    nativeSessionId?: string | null;
    decision?: ExecutionGateDecision;
  } | {
    terminal: true;
    resultHash: string;
    outcome: "failure" | "needs_human" | "retryable_infrastructure_failure";
    lastError: string;
    nativeSessionId?: string | null;
  } | null>;
}

export interface UnitEffectProcessor {
  drain(parentAttemptId: string): Promise<ExecutionWorkAttempt | undefined>;
}

export function createUnitEffectProcessor(input: {
  store: ExecutionUnitStore;
  runtime: UnitEffectRuntime;
  leaseOwner: string;
  now: () => Date;
  leaseMs?: number;
}): UnitEffectProcessor {
  const leaseMs = input.leaseMs ?? 60_000;
  return {
    async drain(parentAttemptId) {
      const leasedAt = input.now();
      const nowIso = leasedAt.toISOString();
      const action = input.store.leaseNextUnitAction({
        parentAttemptId,
        leaseOwner: input.leaseOwner,
        nowIso,
        leaseUntilIso: new Date(leasedAt.getTime() + leaseMs).toISOString(),
      });
      if (!action) return undefined;
      const requestlessDispatch = action.status === "dispatched" && !action.request_hash;
      if (!requestlessDispatch) {
        const recovered = await input.runtime.collectUnitAction(action);
        if (recovered) {
          if (recovered.terminal) {
            if (recovered.outcome === "retryable_infrastructure_failure") {
              throw new Error(recovered.lastError);
            }
            input.store.failUnitAction({
              actionId: action.id,
              resultHash: recovered.resultHash,
              outcome: recovered.outcome,
              lastError: recovered.lastError,
              nativeSessionId: recovered.nativeSessionId,
            });
            return action;
          }
          if (recovered.decision) {
            input.store.completeGatedAction({
              actionId: action.id,
              resultHash: recovered.resultHash,
              outputSubject: recovered.outputSubject,
              receipt: recovered.receipt,
              nativeSessionId: recovered.nativeSessionId,
              decision: recovered.decision,
            });
          } else {
            input.store.completeUnitAction({
              actionId: action.id,
              resultHash: recovered.resultHash,
              outputSubject: recovered.outputSubject,
              receipt: recovered.receipt,
              nativeSessionId: recovered.nativeSessionId,
            });
          }
          return action;
        }
        if (
          (action.status === "dispatched" || action.status === "running") &&
          action.lease_until != null &&
          action.lease_until <= nowIso
        ) {
          input.store.healExpiredCurrentChildAction({
            parentAttemptId,
            actionId: action.id,
            nowIso,
            reason: "child action missed heartbeat fence",
          });
          return action;
        }
      }
      const shouldDispatch = action.status === "leased" || requestlessDispatch;
      if (!shouldDispatch) return action;
      if (action.status === "leased") input.store.markActionDispatching(action.id);
      const dispatched = await input.runtime.dispatchUnitAction(action);
      input.store.markActionDispatched(action.id, dispatched.requestHash, dispatched.nativeSessionId ?? null);
      return action;
    },
  };
}
