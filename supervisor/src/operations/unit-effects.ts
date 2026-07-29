import type { ExecutionUnitStore, ExecutionWorkAttempt } from "../persistence/pipeline/unit-store.js";

export interface UnitEffectRuntime {
  dispatchUnitAction(action: ExecutionWorkAttempt): Promise<{
    requestHash: string;
    nativeSessionId?: string | null;
  }>;
  collectUnitAction(action: ExecutionWorkAttempt): Promise<{
    resultHash: string;
    outputSubject: string;
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
          input.store.completeUnitAction({
            actionId: action.id,
            resultHash: recovered.resultHash,
            outputSubject: recovered.outputSubject,
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
