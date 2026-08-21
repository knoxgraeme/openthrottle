import type { EffectIntent, JsonValue } from "@openthrottle/contracts";

export type KernelEffectIdempotencyStrategy = "provider_native" | "deterministic_target";

export type KernelEffectProviderObservation =
  | { kind: "found"; status: "confirmed" | "rejected"; payload: JsonValue }
  | { kind: "not_found" }
  | { kind: "unknown"; detail: string };

export interface KernelEffectDispatchFence {
  lease_id: string;
  worker_id: string;
}

export interface KernelEffectReconciliationRequest {
  intent: Readonly<EffectIntent>;
  external_identity: string;
  dispatch_fence: KernelEffectDispatchFence | null;
}

export interface KernelEffectDispatchRequest extends KernelEffectReconciliationRequest {
  deduplication: {
    strategy: KernelEffectIdempotencyStrategy;
    key: string;
    target: string;
  };
}

export interface KernelEffectRuntimeAdapter {
  reconcile(input: KernelEffectReconciliationRequest): Promise<KernelEffectProviderObservation>;
  dispatch(input: KernelEffectDispatchRequest): Promise<void>;
}

export interface KernelEffectAdapterBinding {
  effect_kind: string;
  provider: string;
  operation: "mutation" | "observation";
  idempotency_strategy: KernelEffectIdempotencyStrategy;
  adapter: KernelEffectRuntimeAdapter;
}

export interface KernelEffectAdapterRegistry {
  bindingFor(effectKind: string): KernelEffectAdapterBinding;
  effectKinds(): readonly string[];
}
