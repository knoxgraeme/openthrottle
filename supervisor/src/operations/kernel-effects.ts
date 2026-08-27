import { Buffer } from "node:buffer";
import {
  EXECUTION_RECORD_SCHEMA,
  INLINE_RECORD_PAYLOAD_MAX_BYTES,
  canonicalJson,
  digestCanonicalJson,
  jsonValueAt,
  validateEffectIntent,
  type DeliveryRecord,
  type EffectIntent,
  type ExecutionRecordPayloadContract,
  type JsonValue,
} from "@openthrottle/contracts";
import type {
  KernelEffectPort,
  LeasedEffectView,
} from "../pipeline/kernel/ports.js";
import {
  assertImmutableEffectReplay,
  reconcileEffectIntent,
} from "../pipeline/kernel/effect-intent.js";
import {
  OPERATOR_EFFECT_REJECTION_EFFECT_KIND,
  parseOperatorEffectRejectionEvidence,
} from "../pipeline/kernel/operator-effect-rejection.js";
import type {
  KernelEffectAdapterBinding,
  KernelEffectAdapterRegistry,
  KernelEffectDispatchFence,
  KernelEffectDispatchRequest,
  KernelEffectProviderObservation,
} from "../app/kernel-effect-ports.js";
export type {
  KernelEffectAdapterBinding,
  KernelEffectAdapterRegistry,
  KernelEffectDispatchRequest,
  KernelEffectIdempotencyStrategy,
  KernelEffectProviderObservation,
  KernelEffectReconciliationRequest,
  KernelEffectRuntimeAdapter,
} from "../app/kernel-effect-ports.js";
import { sanitizeText } from "../shared/sanitize.js";

const EFFECT_KIND = /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*@\d+$/;
const PROVIDER = /^[a-z][a-z0-9_-]{0,63}$/;
const UNKNOWN_DETAIL_MAX_LENGTH = 1_500;
const UNKNOWN_RETRY_BASE_MS = 5_000;
const UNKNOWN_RETRY_MAX_MS = 5 * 60_000;
const EFFECT_RETRY_CONTINUATION_SCHEMA = "openthrottle.effect-retry-continuation/v1";

export const KERNEL_EFFECT_DELIVERY_PAYLOAD_SCHEMA =
  "openthrottle.effect-delivery/v1" as const;

export type KernelEffectExecutionResult =
  | { kind: "idle" }
  | {
    kind: "delivered";
    effect_id: string;
    delivery_record_id: string;
    status: "confirmed" | "rejected";
    path: "reconciled" | "dispatched_then_reconciled";
  }
  | {
    kind: "held_unknown";
    effect_id: string;
    external_identity: string;
    detail: string;
    retry_at: string;
  };

export interface KernelEffectExecutionService {
  drainOne(input: {
    worker_id: string;
    lease_id: string;
    expires_at: string;
    signal?: AbortSignal;
  }): Promise<KernelEffectExecutionResult>;
}

function assertBinding(binding: KernelEffectAdapterBinding): void {
  if (!EFFECT_KIND.test(binding.effect_kind)) {
    throw new Error(`invalid effect kind ${JSON.stringify(binding.effect_kind)}`);
  }
  if (!PROVIDER.test(binding.provider)) {
    throw new Error(`invalid effect provider ${JSON.stringify(binding.provider)}`);
  }
  if (
    binding.operation !== "mutation" && binding.operation !== "observation"
  ) {
    throw new Error(`invalid effect operation for ${binding.effect_kind}`);
  }
  if (
    binding.idempotency_strategy !== "provider_native" &&
    binding.idempotency_strategy !== "deterministic_target"
  ) {
    throw new Error(`invalid idempotency strategy for ${binding.effect_kind}`);
  }
  if (
    !binding.adapter ||
    typeof binding.adapter.reconcile !== "function" ||
    (
      binding.adapter.prepareDispatch !== undefined &&
      typeof binding.adapter.prepareDispatch !== "function"
    ) ||
    typeof binding.adapter.dispatch !== "function"
  ) {
    throw new Error(`effect adapter ${binding.effect_kind} is incomplete`);
  }
}

function kernelEffectDeliveryPayload(value: unknown, path: string): JsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: must be an object`);
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["effect_kind", "provider", "observed_via", "result"]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${path}.${unknown}: unknown field`);
  if (typeof input.effect_kind !== "string" || !EFFECT_KIND.test(input.effect_kind)) {
    throw new Error(`${path}.effect_kind: must be a versioned effect kind`);
  }
  if (typeof input.provider !== "string" || !PROVIDER.test(input.provider)) {
    throw new Error(`${path}.provider: must be a provider identifier`);
  }
  if (
    input.observed_via !== "reconciliation" &&
    input.observed_via !== "post_dispatch_reconciliation" &&
    input.observed_via !== "operator_resolution"
  ) {
    throw new Error(`${path}.observed_via: has an invalid value`);
  }
  if (!("result" in input)) throw new Error(`${path}.result: is required`);
  if (input.observed_via === "operator_resolution") {
    if (input.provider !== "operator") {
      throw new Error(`${path}.provider: operator resolution requires the operator provider`);
    }
    if (input.effect_kind !== OPERATOR_EFFECT_REJECTION_EFFECT_KIND) {
      throw new Error(`${path}.effect_kind: operator resolution is not allowed for this effect kind`);
    }
  } else if (input.provider === "operator") {
    throw new Error(`${path}.provider: operator is reserved for operator resolution`);
  }
  return {
    effect_kind: input.effect_kind,
    provider: input.provider,
    observed_via: input.observed_via,
    result: input.observed_via === "operator_resolution"
      ? parseOperatorEffectRejectionEvidence(input.result, `${path}.result`) as JsonValue
      : jsonValueAt(input.result, `${path}.result`),
  };
}

export const KERNEL_EFFECT_DELIVERY_PAYLOAD_CONTRACT: ExecutionRecordPayloadContract =
  Object.freeze({
    kind: "delivery" as const,
    parseInline(value: unknown, path: string): unknown {
      return kernelEffectDeliveryPayload(value, path);
    },
  });

export function createKernelEffectAdapterRegistry(
  bindings: readonly KernelEffectAdapterBinding[],
): KernelEffectAdapterRegistry {
  const byKind = new Map<string, KernelEffectAdapterBinding>();
  for (const candidate of bindings) {
    assertBinding(candidate);
    if (byKind.has(candidate.effect_kind)) {
      throw new Error(`duplicate effect adapter binding for ${candidate.effect_kind}`);
    }
    byKind.set(candidate.effect_kind, Object.freeze({ ...candidate }));
  }
  const kinds = Object.freeze([...byKind.keys()].sort());
  return Object.freeze({
    bindingFor(effectKind: string): KernelEffectAdapterBinding {
      const binding = byKind.get(effectKind);
      if (!binding) throw new Error(`no adapter is registered for exact effect kind ${effectKind}`);
      return binding;
    },
    effectKinds(): readonly string[] {
      return kinds;
    },
  });
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function immutableIntent(input: EffectIntent): Readonly<EffectIntent> {
  const validated = validateEffectIntent(input, { source: "leased_effect.intent" }).value;
  const clone = JSON.parse(canonicalJson(validated)) as EffectIntent;
  return deepFreeze(clone);
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("kernel effect execution aborted");
}

function diagnostic(error: unknown): string {
  let text: string;
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message !== "[object Object]") {
      text = message;
    } else {
      const evidence: Record<string, unknown> = { ...error };
      if (error.cause !== undefined) evidence.cause = error.cause;
      try {
        text = Object.keys(evidence).length > 0
          ? canonicalJson(jsonValueAt(evidence, "provider_diagnostic"))
          : "provider returned an unrepresentable diagnostic";
      } catch {
        text = "provider returned an unrepresentable diagnostic";
      }
    }
  } else if (typeof error === "string") {
    text = error;
  } else {
    try {
      text = canonicalJson(jsonValueAt(error, "provider_diagnostic"));
    } catch {
      text = "provider returned an unrepresentable diagnostic";
    }
  }
  return sanitizeText(text).slice(0, UNKNOWN_DETAIL_MAX_LENGTH) || "provider outcome is unknown";
}

function normalizeObservation(value: KernelEffectProviderObservation): KernelEffectProviderObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("provider reconciliation must return an object");
  }
  if (value.kind === "not_found") return { kind: "not_found" };
  if (value.kind === "dispatch_not_started") return { kind: "dispatch_not_started" };
  if (value.kind === "unknown") {
    if (typeof value.detail !== "string" || value.detail.trim().length === 0) {
      throw new Error("unknown provider reconciliation requires detail");
    }
    return { kind: "unknown", detail: diagnostic(value.detail) };
  }
  if (value.kind === "retry") {
    if (typeof value.detail !== "string" || value.detail.trim().length === 0) {
      throw new Error("retryable provider reconciliation requires detail");
    }
    return {
      kind: "retry",
      detail: diagnostic(value.detail),
      continuation: jsonValueAt(value.continuation, "effect_observation.continuation"),
    };
  }
  if (value.kind === "found") {
    if (value.status !== "confirmed" && value.status !== "rejected") {
      throw new Error("found provider reconciliation has an invalid delivery status");
    }
    return {
      kind: "found",
      status: value.status,
      payload: jsonValueAt(value.payload, "effect_observation.payload"),
    };
  }
  throw new Error("provider reconciliation returned an unknown observation kind");
}

function dispatchRequest(input: {
  binding: KernelEffectAdapterBinding;
  intent: Readonly<EffectIntent>;
  dispatch_fence: KernelEffectDispatchFence;
}): KernelEffectDispatchRequest {
  return {
    intent: input.intent,
    external_identity: input.intent.target,
    deduplication: {
      strategy: input.binding.idempotency_strategy,
      key: input.intent.idempotency_key,
      target: input.intent.target,
    },
    dispatch_fence: input.dispatch_fence,
  };
}

function retryContinuation(detail: string | null): JsonValue | null {
  if (detail === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(detail);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join("\0") !== ["continuation", "detail", "schema"].sort().join("\0") ||
    input.schema !== EFFECT_RETRY_CONTINUATION_SCHEMA ||
    typeof input.detail !== "string"
  ) return null;
  try {
    return jsonValueAt(input.continuation, "effect_retry.continuation");
  } catch {
    return null;
  }
}

function retryDetail(detail: string, continuation: JsonValue): string {
  return canonicalJson({
    schema: EFFECT_RETRY_CONTINUATION_SCHEMA,
    detail,
    continuation,
  });
}

async function observe(input: {
  binding: KernelEffectAdapterBinding;
  intent: Readonly<EffectIntent>;
  dispatch_fence: LeasedEffectView["dispatch_fence"];
  observed_at: string;
  continuation: JsonValue | null;
  signal?: AbortSignal;
}): Promise<KernelEffectProviderObservation> {
  abortIfRequested(input.signal);
  try {
    const result = await input.binding.adapter.reconcile({
      intent: input.intent,
      external_identity: input.intent.target,
      dispatch_fence: input.dispatch_fence,
      observed_at: input.observed_at,
      continuation: input.continuation,
    });
    abortIfRequested(input.signal);
    return normalizeObservation(result);
  } catch (error) {
    abortIfRequested(input.signal);
    return { kind: "unknown", detail: diagnostic(error) };
  }
}

function deliveryRecord(input: {
  binding: KernelEffectAdapterBinding;
  intent: Readonly<EffectIntent>;
  observation: Extract<KernelEffectProviderObservation, { kind: "found" }>;
  observedVia: "reconciliation" | "post_dispatch_reconciliation";
  createdAt: string;
}): DeliveryRecord {
  const payload = kernelEffectDeliveryPayload({
    effect_kind: input.intent.kind,
    provider: input.binding.provider,
    observed_via: input.observedVia,
    result: input.observation.payload,
  }, "effect_delivery.payload");
  if (Buffer.byteLength(canonicalJson(payload), "utf8") > INLINE_RECORD_PAYLOAD_MAX_BYTES) {
    throw new Error(`effect delivery payload exceeds ${INLINE_RECORD_PAYLOAD_MAX_BYTES} canonical JSON bytes`);
  }
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: `delivery-${digestCanonicalJson({
      schema: "openthrottle.effect-delivery-identity/v1",
      effect_id: input.intent.id,
      idempotency_key: input.intent.idempotency_key,
      external_identity: input.intent.target,
    })}`,
    kind: "delivery",
    pipeline_run_id: input.intent.pipeline_run_id,
    effect_id: input.intent.id,
    idempotency_key: input.intent.idempotency_key,
    external_identity: input.intent.target,
    status: input.observation.status,
    payload_schema: KERNEL_EFFECT_DELIVERY_PAYLOAD_SCHEMA,
    payload: { inline: payload },
    created_at: input.createdAt,
  };
}

export function createKernelEffectExecutionService(input: {
  effects: KernelEffectPort;
  adapters: KernelEffectAdapterRegistry;
  now?: () => string;
}): KernelEffectExecutionService {
  const now = input.now ?? (() => new Date().toISOString());

  function retryAt(ordinal: number): string {
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
      throw new Error("effect lease has an invalid reconciliation ordinal");
    }
    const nowValue = now();
    const nowMs = Date.parse(nowValue);
    if (!Number.isFinite(nowMs) || new Date(nowMs).toISOString() !== nowValue) {
      throw new Error("effect executor clock did not return a canonical timestamp");
    }
    const exponent = Math.min(ordinal - 1, 16);
    const delay = Math.min(UNKNOWN_RETRY_BASE_MS * (2 ** exponent), UNKNOWN_RETRY_MAX_MS);
    return new Date(nowMs + delay).toISOString();
  }

  async function holdUnknown(
    leased: LeasedEffectView,
    workerId: string,
    detailInput: string,
    continuation: JsonValue | null = null,
  ): Promise<Extract<KernelEffectExecutionResult, { kind: "held_unknown" }>> {
    const detail = diagnostic(detailInput);
    const persistedDetail = continuation === null ? detail : retryDetail(detail, continuation);
    const retry_at = retryAt(leased.reconciliation_ordinal);
    const reconciliation = reconcileEffectIntent({
      intent: leased.intent,
      observation: {
        kind: "unknown",
        external_identity: leased.intent.target,
        detail: persistedDetail,
      },
      retry_at,
    });
    if (reconciliation.kind !== "hold_unknown") {
      throw new Error("unknown effect observation produced an invalid reconciliation");
    }
    await input.effects.completeLeasedEffect({
      effect_id: leased.intent.id,
      lease_id: leased.lease_id,
      worker_id: workerId,
      reconciliation,
    });
    return {
      kind: "held_unknown",
      effect_id: reconciliation.effect_id,
      external_identity: reconciliation.external_identity,
      detail,
      retry_at: reconciliation.retry_at,
    };
  }

  async function appendDelivery(
    leased: LeasedEffectView,
    binding: KernelEffectAdapterBinding,
    intent: Readonly<EffectIntent>,
    observation: Extract<KernelEffectProviderObservation, { kind: "found" }>,
    observedVia: "reconciliation" | "post_dispatch_reconciliation",
    workerId: string,
  ): Promise<KernelEffectExecutionResult> {
    let delivery: DeliveryRecord;
    try {
      delivery = deliveryRecord({
        binding,
        intent,
        observation,
        observedVia,
        createdAt: now(),
      });
    } catch (error) {
      return holdUnknown(leased, workerId, `invalid provider delivery observation: ${diagnostic(error)}`);
    }
    const reconciliation = reconcileEffectIntent({
      intent,
      observation: {
        kind: "found",
        external_identity: intent.target,
        delivery,
      },
    });
    if (reconciliation.kind !== "append_delivery") {
      throw new Error("found effect observation produced an invalid reconciliation");
    }
    await input.effects.completeLeasedEffect({
      effect_id: intent.id,
      lease_id: leased.lease_id,
      worker_id: workerId,
      reconciliation,
    });
    return {
      kind: "delivered",
      effect_id: intent.id,
      delivery_record_id: delivery.id,
      status: delivery.status,
      path: observedVia === "reconciliation" ? "reconciled" : "dispatched_then_reconciled",
    };
  }

  return {
    async drainOne(request): Promise<KernelEffectExecutionResult> {
      abortIfRequested(request.signal);
      const leased = await input.effects.leaseNextEffect({
        worker_id: request.worker_id,
        lease_id: request.lease_id,
        expires_at: request.expires_at,
      });
      if (!leased) return { kind: "idle" };
      if (leased.lease_id !== request.lease_id || leased.expires_at !== request.expires_at) {
        throw new Error("effect store returned a lease outside the requested fence");
      }
      const intent = immutableIntent(leased.intent);
      const continuation = retryContinuation(leased.prior_unknown_detail);
      let binding: KernelEffectAdapterBinding;
      try {
        binding = input.adapters.bindingFor(intent.kind);
      } catch (error) {
        return holdUnknown(leased, request.worker_id, diagnostic(error));
      }

      const initial = await observe({
        binding,
        intent,
        dispatch_fence: leased.dispatch_fence,
        observed_at: now(),
        continuation,
        signal: request.signal,
      });
      if (initial.kind === "found") {
        return appendDelivery(
          leased,
          binding,
          intent,
          initial,
          "reconciliation",
          request.worker_id,
        );
      }
      if (initial.kind === "unknown") {
        return holdUnknown(leased, request.worker_id, initial.detail, continuation);
      }
      if (initial.kind === "retry") {
        return holdUnknown(leased, request.worker_id, initial.detail, initial.continuation);
      }
      let dispatchFence: KernelEffectDispatchFence;
      if (initial.kind === "dispatch_not_started") {
        if (
          binding.operation !== "mutation" ||
          leased.execution_mode !== "reconcile_only" ||
          leased.dispatch_fence === null
        ) {
          return holdUnknown(
            leased,
            request.worker_id,
            "dispatch-not-started observation is invalid without a reconcile-only persisted dispatch fence",
          );
        }
        dispatchFence = leased.dispatch_fence;
      } else {
        if (binding.operation === "observation") {
          return holdUnknown(
            leased,
            request.worker_id,
            "observed target is not present yet; the observation will be reconciled again",
          );
        }
        if (leased.execution_mode === "reconcile_only") {
          return holdUnknown(
            leased,
            request.worker_id,
            "reconcile-only effect target remains absent; operator reconciliation is required",
          );
        }

        const reconciliation = reconcileEffectIntent({
          intent,
          observation: { kind: "not_found", external_identity: intent.target },
        });
        if (reconciliation.kind !== "execute") {
          throw new Error("absent effect observation produced an invalid reconciliation");
        }

        const proposedFence = {
          lease_id: leased.lease_id,
          worker_id: request.worker_id,
        };
        if (binding.adapter.prepareDispatch) {
          abortIfRequested(request.signal);
          try {
            await binding.adapter.prepareDispatch(dispatchRequest({
              binding,
              intent,
              dispatch_fence: proposedFence,
            }));
            abortIfRequested(request.signal);
          } catch (error) {
            abortIfRequested(request.signal);
            return holdUnknown(
              leased,
              request.worker_id,
              `dispatch preparation returned an error: ${diagnostic(error)}`,
            );
          }
        }

        abortIfRequested(request.signal);
        const dispatchLease = await input.effects.markLeasedEffectDispatchStarted({
          effect_id: intent.id,
          lease_id: leased.lease_id,
          worker_id: request.worker_id,
        });
        const persistedFence = dispatchLease.dispatch_fence;
        if (
          dispatchLease.lease_id !== leased.lease_id ||
          dispatchLease.expires_at !== leased.expires_at ||
          dispatchLease.execution_mode !== "reconcile_only" ||
          persistedFence === null ||
          persistedFence.lease_id !== proposedFence.lease_id ||
          persistedFence.worker_id !== proposedFence.worker_id
        ) {
          throw new Error("effect store returned an invalid dispatch-start fence");
        }
        try {
          assertImmutableEffectReplay(reconciliation.intent, dispatchLease.intent);
        } catch {
          throw new Error("effect store returned an invalid dispatch-start fence");
        }
        dispatchFence = persistedFence;
      }

      abortIfRequested(request.signal);
      let dispatchFailure: string | null = null;
      try {
        await binding.adapter.dispatch(dispatchRequest({
          binding,
          intent,
          dispatch_fence: dispatchFence,
        }));
        abortIfRequested(request.signal);
      } catch (error) {
        abortIfRequested(request.signal);
        dispatchFailure = diagnostic(error);
      }

      const afterDispatch = await observe({
        binding,
        intent,
        dispatch_fence: dispatchFence,
        observed_at: now(),
        continuation,
        signal: request.signal,
      });
      if (afterDispatch.kind === "found") {
        return appendDelivery(
          leased,
          binding,
          intent,
          afterDispatch,
          "post_dispatch_reconciliation",
          request.worker_id,
        );
      }
      if (afterDispatch.kind === "unknown") {
        return holdUnknown(leased, request.worker_id, [
          dispatchFailure ? `dispatch returned an error: ${dispatchFailure}` : null,
          afterDispatch.detail,
        ].filter((entry): entry is string => entry !== null).join("; "));
      }
      if (afterDispatch.kind === "retry") {
        return holdUnknown(
          leased,
          request.worker_id,
          afterDispatch.detail,
          afterDispatch.continuation,
        );
      }
      if (afterDispatch.kind === "dispatch_not_started") {
        return holdUnknown(leased, request.worker_id, [
          dispatchFailure ? `dispatch returned an error: ${dispatchFailure}` : null,
          "provider proved dispatch-not-started; retry the exact fenced dispatch on a later reconciliation lease",
        ].filter((entry): entry is string => entry !== null).join("; "));
      }
      return holdUnknown(leased, request.worker_id, [
        dispatchFailure ? `dispatch returned an error: ${dispatchFailure}` : null,
        "deterministic target remained absent after dispatch; outcome is indeterminate",
      ].filter((entry): entry is string => entry !== null).join("; "));
    },
  };
}
