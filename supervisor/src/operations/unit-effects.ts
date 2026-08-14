import { digestCanonicalJson } from "@openthrottle/contracts";
import type {
  ExecutionUnitStore,
  ExecutionWorkAttempt,
  ExecutionWorkPrivateArtifact,
} from "../persistence/pipeline/unit-store.js";
import type { ExecutionGateDecision } from "../pipeline/execution-gates.js";
import { serializeRuntimeObservationError } from "../runtime/observation-error.js";
import { sanitizeText } from "../shared/sanitize.js";

const OBSERVATION_FAILURE_MAX_ATTEMPTS = 3;
const OBSERVATION_FAILURE_RETRY_BASE_MS = 5_000;

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
    terminalPayload?: string;
    privateArtifact?: ExecutionWorkPrivateArtifact;
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
  const recordObservationFailure = (
    action: ExecutionWorkAttempt,
    error: unknown
  ): void => {
    // Backoff begins when the provider failure is observed, not when the
    // action lease was acquired before potentially slow I/O.
    const observedAt = input.now();
    const attempt = action.observation_failure_count + 1;
    const message = sanitizeText(error instanceof Error ? error.message : String(error)).slice(-1_500);
    const lastError = `observation_attempt=${attempt}/${OBSERVATION_FAILURE_MAX_ATTEMPTS} ${message}`;
    if (attempt >= OBSERVATION_FAILURE_MAX_ATTEMPTS) {
      input.store.stopRetryableUnitAction({
        actionId: action.id,
        resultHash: digestCanonicalJson({
          schema: "openthrottle.child-action-observation-exhausted/v1",
          action_id: action.id,
          attempt,
          error: lastError,
        }),
        lastError,
        nativeSessionId: action.native_session_id,
        observationExhaustion: {
          expectedFailureCount: action.observation_failure_count,
          expectedEpoch: action.observation_epoch,
          exhaustedFailureCount: OBSERVATION_FAILURE_MAX_ATTEMPTS,
        },
      });
      return;
    }
    const retryAtIso = new Date(
      observedAt.getTime() + OBSERVATION_FAILURE_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1)
    ).toISOString();
    input.store.recordActionObservationFailure({
      actionId: action.id,
      expectedFailureCount: action.observation_failure_count,
      expectedEpoch: action.observation_epoch,
      lastError,
      retryAtIso,
    });
  };
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
      let observationFence = action;
      const preparedNotLaunched = action.request_hash != null &&
        action.request_payload != null &&
        action.request_launch_state !== "launched";
      const requestlessDispatch = action.status === "dispatched" && !action.request_hash;
      if (!requestlessDispatch && !preparedNotLaunched) {
        let recovered: Awaited<ReturnType<UnitEffectRuntime["collectUnitAction"]>>;
        try {
          recovered = await input.runtime.collectUnitAction(action);
        } catch (error) {
          recordObservationFailure(observationFence, error);
          return action;
        }
        const observationClear = input.store.clearActionObservationFailure({
          actionId: action.id,
          expectedFailureCount: action.observation_failure_count,
          expectedEpoch: action.observation_epoch,
        });
        if (observationClear === "stale") return action;
        observationFence = {
          ...action,
          observation_failure_count: 0,
          observation_retry_at: null,
          observation_epoch: action.observation_epoch + 1,
          last_error: null,
        };
        if (recovered) {
          if (recovered.terminal) {
            if (recovered.outcome === "retryable_infrastructure_failure") {
              input.store.stopRetryableUnitAction({
                actionId: action.id,
                resultHash: recovered.resultHash,
                lastError: recovered.lastError,
                nativeSessionId: recovered.nativeSessionId,
                terminalPayload: recovered.terminalPayload,
                privateArtifact: recovered.privateArtifact,
              });
              return action;
            }
            input.store.failUnitAction({
              actionId: action.id,
              resultHash: recovered.resultHash,
              outcome: recovered.outcome,
              lastError: recovered.lastError,
              nativeSessionId: recovered.nativeSessionId,
              terminalPayload: recovered.terminalPayload,
              privateArtifact: recovered.privateArtifact,
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
      const shouldDispatch = action.status === "leased" || requestlessDispatch || preparedNotLaunched;
      if (!shouldDispatch) return action;
      if (action.status === "leased" && !action.request_hash) input.store.markActionDispatching(action.id);
      let dispatched: Awaited<ReturnType<UnitEffectRuntime["dispatchUnitAction"]>>;
      try {
        dispatched = await input.runtime.dispatchUnitAction(action);
      } catch (error) {
        // Every action kind takes the bounded path: retryable dispatch faults
        // burn the observation budget (terminalizing through the retryable
        // stop when it exhausts), deterministic ones terminal-fail at once.
        // Rethrowing here would retry identical dispatches without a budget
        // and abort the caller's whole per-ticket drain cycle.
        const observed = serializeRuntimeObservationError(`dispatch child action ${action.id}`, error);
        if (observed.retryable) {
          recordObservationFailure(observationFence, observed.text);
          return action;
        }
        const kindLabel = action.action_kind.replace(/_/g, "-");
        const lastError = `${kindLabel} dispatch failed: ${observed.text}`.slice(0, 2_000);
        input.store.failUnitAction({
          actionId: action.id,
          resultHash: digestCanonicalJson({
            schema: `openthrottle.${kindLabel}-dispatch-failure/v1`,
            action_id: action.id,
            error: observed.text,
          }),
          outcome: "failure",
          lastError,
          nativeSessionId: action.native_session_id,
        });
        return action;
      }
      input.store.markActionDispatched(action.id, dispatched.requestHash, dispatched.nativeSessionId ?? null);
      return action;
    },
  };
}
