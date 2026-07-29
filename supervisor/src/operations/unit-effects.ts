import type { ExecutionUnitStore, ExecutionWorkAttempt } from "../pipeline/store.js";

export interface UnitEffectRuntime {
  dispatchUnitAction(action: ExecutionWorkAttempt): Promise<{
    requestHash: string;
    nativeSessionId?: string | null;
  }>;
  collectUnitAction(action: ExecutionWorkAttempt): Promise<{
    resultHash: string;
    outputSubject: string | null;
    nativeSessionId?: string | null;
    outcome?: "success" | "failure" | "needs_human" | "retryable_infrastructure_failure";
    reason?: string;
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
      const requestlessDispatch = action.status === "dispatched" && !action.request_hash && !action.native_session_id;
      if (!requestlessDispatch) {
        const recovered = await input.runtime.collectUnitAction(action);
        if (recovered) {
          if ((recovered.outcome ?? "success") === "success") {
            if (!recovered.outputSubject) throw new Error(`unit action ${action.id} completed without an output subject`);
            input.store.completeUnitAction({
              actionId: action.id,
              resultHash: recovered.resultHash,
              outputSubject: recovered.outputSubject,
              nativeSessionId: recovered.nativeSessionId ?? null,
            });
          } else {
            input.store.failUnitAction({
              actionId: action.id,
              resultHash: recovered.resultHash,
              outputSubject: recovered.outputSubject,
              nativeSessionId: recovered.nativeSessionId ?? null,
              reason: recovered.reason ?? `child action returned ${recovered.outcome}`,
            });
          }
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
