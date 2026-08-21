import {
  assertSameIdempotentEffect,
  digestCanonicalJson,
  validateEffectIntent,
  type DecisionRecord,
  type DeliveryRecord,
  type EffectIntent,
} from "@openthrottle/contracts";

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

export function assertImmutableEffectReplay(existing: EffectIntent, replay: EffectIntent): void {
  assertSameIdempotentEffect(
    validateEffectIntent(existing, { source: "existing_effect_intent" }),
    validateEffectIntent(replay, { source: "replay_effect_intent" }),
  );
}

export function reconcileEffectIntent(input: {
  intent: EffectIntent;
  decision: DecisionRecord;
  observation: EffectObservation;
  retry_at?: string;
}): EffectReconciliation {
  const intent = authorizeEffectIntent(
    input.intent,
    input.decision,
    input.decision.pipeline_run_id,
  );
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
