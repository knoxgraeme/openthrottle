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
import type {
  KernelEffectAdapterBinding,
  KernelEffectAdapterRegistry,
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
    input.observed_via !== "post_dispatch_reconciliation"
  ) {
    throw new Error(`${path}.observed_via: has an invalid value`);
  }
  if (!("result" in input)) throw new Error(`${path}.result: is required`);
  return {
    effect_kind: input.effect_kind,
    provider: input.provider,
    observed_via: input.observed_via,
    result: jsonValueAt(input.result, `${path}.result`),
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
  const text = error instanceof Error ? error.message : String(error);
  return sanitizeText(text).slice(0, UNKNOWN_DETAIL_MAX_LENGTH) || "provider outcome is unknown";
}

function normalizeObservation(value: KernelEffectProviderObservation): KernelEffectProviderObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("provider reconciliation must return an object");
  }
  if (value.kind === "not_found") return { kind: "not_found" };
  if (value.kind === "unknown") {
    if (typeof value.detail !== "string" || value.detail.trim().length === 0) {
      throw new Error("unknown provider reconciliation requires detail");
    }
    return { kind: "unknown", detail: diagnostic(value.detail) };
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

async function observe(input: {
  binding: KernelEffectAdapterBinding;
  intent: Readonly<EffectIntent>;
  dispatch_fence: LeasedEffectView["dispatch_fence"];
  signal?: AbortSignal;
}): Promise<KernelEffectProviderObservation> {
  abortIfRequested(input.signal);
  try {
    const result = await input.binding.adapter.reconcile({
      intent: input.intent,
      external_identity: input.intent.target,
      dispatch_fence: input.dispatch_fence,
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
  ): Promise<Extract<KernelEffectExecutionResult, { kind: "held_unknown" }>> {
    const detail = diagnostic(detailInput);
    const retry_at = retryAt(leased.reconciliation_ordinal);
    await input.effects.completeLeasedEffect({
      effect_id: leased.intent.id,
      lease_id: leased.lease_id,
      worker_id: workerId,
      reconciliation: {
        kind: "hold_unknown",
        effect_id: leased.intent.id,
        external_identity: leased.intent.target,
        detail,
        retry_at,
      },
    });
    return {
      kind: "held_unknown",
      effect_id: leased.intent.id,
      external_identity: leased.intent.target,
      detail,
      retry_at,
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
    await input.effects.completeLeasedEffect({
      effect_id: intent.id,
      lease_id: leased.lease_id,
      worker_id: workerId,
      reconciliation: { kind: "append_delivery", delivery },
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
        return holdUnknown(leased, request.worker_id, initial.detail);
      }
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

      abortIfRequested(request.signal);
      const dispatchLease = await input.effects.markLeasedEffectDispatchStarted({
        effect_id: intent.id,
        lease_id: leased.lease_id,
        worker_id: request.worker_id,
      });
      if (
        dispatchLease.lease_id !== leased.lease_id ||
        dispatchLease.expires_at !== leased.expires_at ||
        dispatchLease.execution_mode !== "reconcile_only" ||
        canonicalJson(validateEffectIntent(dispatchLease.intent).value) !== canonicalJson(intent)
      ) {
        throw new Error("effect store returned an invalid dispatch-start fence");
      }
      abortIfRequested(request.signal);
      let dispatchFailure: string | null = null;
      try {
        await binding.adapter.dispatch({
          intent,
          external_identity: intent.target,
          deduplication: {
            strategy: binding.idempotency_strategy,
            key: intent.idempotency_key,
            target: intent.target,
          },
          dispatch_fence: dispatchLease.dispatch_fence,
        });
        abortIfRequested(request.signal);
      } catch (error) {
        abortIfRequested(request.signal);
        dispatchFailure = diagnostic(error);
      }

      const afterDispatch = await observe({
        binding,
        intent,
        dispatch_fence: dispatchLease.dispatch_fence,
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
      return holdUnknown(leased, request.worker_id, [
        dispatchFailure ? `dispatch returned an error: ${dispatchFailure}` : null,
        "deterministic target remained absent after dispatch; outcome is indeterminate",
      ].filter((entry): entry is string => entry !== null).join("; "));
    },
  };
}
