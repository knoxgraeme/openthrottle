import { Buffer } from "node:buffer";
import {
  assertSameIdempotentEffect,
  canonicalJson,
  digestCanonicalJson,
  jsonValueAt,
  validateEffectIntent,
  type DecisionRecord,
  type DeliveryRecord,
  type EffectIntent,
  type JsonValue,
} from "@openthrottle/contracts";

export const EFFECT_CONTINUATION_STATE_SCHEMA =
  "openthrottle.effect-continuation/v1" as const;
export const EFFECT_CONTINUATION_STATE_MAX_BYTES = 65_536;
const EFFECT_CONTINUATION_STATE_FIELDS = new Set([
  "schema",
  "retry_deadline",
  "payload",
]);

export interface EffectContinuationState {
  schema: typeof EFFECT_CONTINUATION_STATE_SCHEMA;
  retry_deadline: string;
  payload: JsonValue;
}

export function validateEffectContinuationState(
  value: unknown,
  path = "effect_continuation_state",
): EffectContinuationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: must be an object`);
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input)
    .find((key) => !EFFECT_CONTINUATION_STATE_FIELDS.has(key));
  if (unknown) throw new Error(`${path}.${unknown}: unknown field`);
  if (input.schema !== EFFECT_CONTINUATION_STATE_SCHEMA) {
    throw new Error(`${path}.schema: must be ${EFFECT_CONTINUATION_STATE_SCHEMA}`);
  }
  if (typeof input.retry_deadline !== "string") {
    throw new Error(`${path}.retry_deadline: must be a canonical timestamp`);
  }
  const deadlineMs = Date.parse(input.retry_deadline);
  if (
    !Number.isFinite(deadlineMs) ||
    new Date(deadlineMs).toISOString() !== input.retry_deadline
  ) throw new Error(`${path}.retry_deadline: must be a canonical timestamp`);
  if (!("payload" in input)) throw new Error(`${path}.payload: is required`);
  const state: EffectContinuationState = {
    schema: EFFECT_CONTINUATION_STATE_SCHEMA,
    retry_deadline: input.retry_deadline,
    payload: jsonValueAt(input.payload, `${path}.payload`),
  };
  if (Buffer.byteLength(canonicalJson(state), "utf8") > EFFECT_CONTINUATION_STATE_MAX_BYTES) {
    throw new Error(`${path}: exceeds ${EFFECT_CONTINUATION_STATE_MAX_BYTES} canonical JSON bytes`);
  }
  return state;
}

export interface ObservedEffectDelivery {
  kind: "found";
  external_identity: string;
  delivery: DeliveryRecord;
}

export interface ObservedEffectAbsence {
  kind: "not_found";
  external_identity: string;
}

export interface UnknownEffectObservation {
  kind: "unknown";
  external_identity: string;
  detail: string;
}

export type EffectObservation =
  | ObservedEffectDelivery
  | ObservedEffectAbsence
  | UnknownEffectObservation;

export type EffectReconciliation =
  | { kind: "append_delivery"; delivery: DeliveryRecord }
  | { kind: "execute"; intent: EffectIntent }
  | {
    kind: "hold_unknown";
    effect_id: string;
    external_identity: string;
    detail: string;
    retry_at: string;
    continuation_state?: EffectContinuationState | null;
  };

export function authorizeEffectIntent(
  intent: EffectIntent,
  decision: DecisionRecord,
  pipelineRunId: string,
): EffectIntent {
  const validated = validateEffectIntent(intent, { source: "effect_intent" }).value;
  if (decision.kind !== "decision") throw new Error("effect intent owner must be a DecisionRecord");
  if (decision.pipeline_run_id !== pipelineRunId) {
    throw new Error("effect intent decision belongs to another pipeline run");
  }
  if (validated.pipeline_run_id !== pipelineRunId) {
    throw new Error("effect intent belongs to another pipeline run");
  }
  if (validated.decision_record_id !== decision.id) {
    throw new Error("effect intent is not owned by the supplied DecisionRecord");
  }
  return validated;
}

export function effectIntentContentHash(intent: EffectIntent): string {
  return digestCanonicalJson(validateEffectIntent(intent).value);
}

export function assertImmutableEffectReplay(
  existing: Readonly<EffectIntent>,
  replay: Readonly<EffectIntent>,
): void {
  assertSameIdempotentEffect(
    validateEffectIntent(existing, { source: "existing_effect_intent" }),
    validateEffectIntent(replay, { source: "replay_effect_intent" }),
  );
}

export function reconcileEffectIntent(input: {
  intent: Readonly<EffectIntent>;
  observation: EffectObservation;
  retry_at?: string;
  continuation_state?: EffectContinuationState | null;
}): EffectReconciliation {
  const intent = validateEffectIntent(input.intent, { source: "effect_reconciliation.intent" }).value;
  if (input.observation.external_identity !== intent.target) {
    throw new Error("effect observation does not match the deterministic external identity");
  }
  if (input.observation.kind === "unknown") {
    if (input.retry_at === undefined) {
      throw new Error("unknown effect reconciliation requires an executor retry_at");
    }
    return {
      kind: "hold_unknown",
      effect_id: intent.id,
      external_identity: input.observation.external_identity,
      detail: input.observation.detail,
      retry_at: input.retry_at,
      ...(input.continuation_state === undefined ? {} : {
        continuation_state: input.continuation_state === null
          ? null
          : validateEffectContinuationState(input.continuation_state),
      }),
    };
  }
  if (input.observation.kind === "not_found") {
    return { kind: "execute", intent };
  }

  const delivery = input.observation.delivery;
  if (delivery.kind !== "delivery") throw new Error("effect observation must contain a DeliveryRecord");
  if (delivery.pipeline_run_id !== intent.pipeline_run_id) {
    throw new Error("effect delivery belongs to another pipeline run");
  }
  if (delivery.effect_id !== intent.id) {
    throw new Error("effect delivery belongs to another effect intent");
  }
  if (delivery.idempotency_key !== intent.idempotency_key) {
    throw new Error("effect delivery idempotency key does not match its intent");
  }
  if (delivery.external_identity !== intent.target) {
    throw new Error("effect delivery external identity does not match its intent");
  }
  return { kind: "append_delivery", delivery };
}
