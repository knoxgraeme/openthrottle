import { describe, expect, it } from "vitest";
import {
  digestCanonicalJson,
  validateExecutionRecord,
  type EffectIntent,
} from "@openthrottle/contracts";
import type {
  KernelEffectPort,
  LeasedEffectView,
} from "../pipeline/kernel/ports.js";
import {
  OPERATOR_EFFECT_REJECTION_RESULT_SCHEMA,
  OPERATOR_EFFECT_REJECTION_RUNTIME_SNAPSHOT,
} from "../pipeline/kernel/operator-effect-rejection.js";
import type { EffectReconciliation } from "../pipeline/kernel/effect-intent.js";
import {
  createKernelEffectAdapterRegistry,
  createKernelEffectExecutionService,
  KERNEL_EFFECT_DELIVERY_PAYLOAD_CONTRACT,
  KERNEL_EFFECT_DELIVERY_PAYLOAD_SCHEMA,
  type KernelEffectAdapterBinding,
  type KernelEffectProviderObservation,
  type KernelEffectRuntimeAdapter,
} from "./kernel-effects.js";

const NOW = "2026-08-20T12:00:00.000Z";
const SUBJECT = "a".repeat(40);

function effect(overrides: Partial<EffectIntent> = {}): EffectIntent {
  return {
    schema: "openthrottle.effect-intent/v1",
    id: "effect-1",
    pipeline_run_id: "run-1",
    decision_record_id: "decision-1",
    kind: "github/update-ref@1",
    idempotency_key: "run-1:update-ref",
    target: "github:owner/repo:refs/heads/ot/work",
    subject: SUBJECT,
    payload: { repository: "owner/repo", ref: "refs/heads/ot/work" },
    ...overrides,
  };
}

function operatorRejectionPayload(overrides: Record<string, unknown> = {}) {
  const priorUnknownDetail = "reconcile-only effect target remains absent";
  return {
    effect_kind: "daytona/integrate-checkpoint@1",
    provider: "operator",
    observed_via: "operator_resolution",
    result: {
      schema: OPERATOR_EFFECT_REJECTION_RESULT_SCHEMA,
      resolution_id: "resolution-integration-validation",
      reason_code: "legacy_integration_idempotency_key_rejected_before_mutation",
      reason: "The sealed sandbox request was rejected before repository mutation.",
      authorized_via: "deploy_token",
      maintenance_version: 2,
      captured_run_version: 17,
      captured_effect_version: 31,
      intent_hash: "b".repeat(64),
      dispatch_fence: { lease_id: "dispatch-lease-1", worker_id: "worker-1" },
      reconciliation_ordinal: 32,
      prior_unknown_detail: priorUnknownDetail,
      prior_unknown_detail_hash: digestCanonicalJson(priorUnknownDetail),
      runtime_snapshot: OPERATOR_EFFECT_REJECTION_RUNTIME_SNAPSHOT,
      runtime_identity: "f".repeat(64),
      runtime_create_effect_id: "effect-runtime-create",
      idempotency_key_length: 212,
      resolution_digest: "d".repeat(64),
    },
    ...overrides,
  };
}

function validateOperatorPayload(payload: unknown) {
  return validateExecutionRecord({
    schema: "openthrottle.record/v1",
    id: "delivery-operator-1",
    kind: "delivery",
    pipeline_run_id: "run-1",
    effect_id: "effect-1",
    idempotency_key: "run-1:integrate",
    external_identity: "daytona:integration:run-1",
    status: "rejected",
    payload_schema: KERNEL_EFFECT_DELIVERY_PAYLOAD_SCHEMA,
    payload: { inline: payload as never },
    created_at: NOW,
  }, {
    payloadSchemas: new Map([
      [KERNEL_EFFECT_DELIVERY_PAYLOAD_SCHEMA, KERNEL_EFFECT_DELIVERY_PAYLOAD_CONTRACT],
    ]),
  }).value;
}

function lease(
  intent: EffectIntent,
  executionMode: LeasedEffectView["execution_mode"] = "dispatch_or_reconcile",
  reconciliationOrdinal = 1,
): LeasedEffectView {
  return {
    intent,
    lease_id: "lease-1",
    expires_at: "2026-08-20T12:01:00.000Z",
    execution_mode: executionMode,
    reconciliation_ordinal: reconciliationOrdinal,
    dispatch_fence: executionMode === "reconcile_only" ? {
      lease_id: "dispatch-lease-1",
      worker_id: "worker-1",
    } : null,
  };
}

class FakeEffectPort implements KernelEffectPort {
  readonly completions: Array<{
    effect_id: string;
    lease_id: string;
    worker_id: string;
    reconciliation: EffectReconciliation;
  }> = [];
  readonly dispatchStarts: Array<{
    effect_id: string;
    lease_id: string;
    worker_id: string;
  }> = [];
  readonly #leases: LeasedEffectView[];
  readonly #throwAfterCompletion: boolean;
  readonly #onDispatchStarted: (() => void) | undefined;
  readonly #dispatchStartedIntent: EffectIntent | undefined;
  #current: LeasedEffectView | null = null;

  constructor(leases: readonly LeasedEffectView[], options: {
    throwAfterCompletion?: boolean;
    onDispatchStarted?: () => void;
    dispatchStartedIntent?: EffectIntent;
  } = {}) {
    this.#leases = [...leases];
    this.#throwAfterCompletion = options.throwAfterCompletion ?? false;
    this.#onDispatchStarted = options.onDispatchStarted;
    this.#dispatchStartedIntent = options.dispatchStartedIntent;
  }

  async leaseNextEffect(): Promise<LeasedEffectView | null> {
    this.#current = this.#leases.shift() ?? null;
    return this.#current;
  }

  async markLeasedEffectDispatchStarted(input: {
    effect_id: string;
    lease_id: string;
    worker_id: string;
  }): Promise<LeasedEffectView> {
    if (!this.#current || this.#current.intent.id !== input.effect_id || this.#current.lease_id !== input.lease_id) {
      throw new Error("dispatch-start lease fence mismatch");
    }
    this.dispatchStarts.push(input);
    this.#current = {
      ...this.#current,
      intent: this.#dispatchStartedIntent ?? this.#current.intent,
      execution_mode: "reconcile_only",
      dispatch_fence: { lease_id: input.lease_id, worker_id: input.worker_id },
    };
    this.#onDispatchStarted?.();
    return this.#current;
  }

  async completeLeasedEffect(input: {
    effect_id: string;
    lease_id: string;
    worker_id: string;
    reconciliation: EffectReconciliation;
  }): Promise<void> {
    this.completions.push(input);
    this.#current = null;
    if (this.#throwAfterCompletion) throw new Error("worker lost after durable completion");
  }
}

function scriptedAdapter(input: {
  observations: readonly KernelEffectProviderObservation[];
  events?: string[];
  onDispatch?: () => void;
}): KernelEffectRuntimeAdapter {
  const observations = [...input.observations];
  return {
    async reconcile(request) {
      input.events?.push(`reconcile:${request.external_identity}`);
      const observation = observations.shift();
      if (!observation) throw new Error("unexpected reconciliation");
      return observation;
    },
    async dispatch(request) {
      input.events?.push(
        `dispatch:${request.deduplication.strategy}:${request.deduplication.key}:${request.external_identity}`,
      );
      input.onDispatch?.();
    },
  };
}

function binding(
  adapter: KernelEffectRuntimeAdapter,
  overrides: Partial<KernelEffectAdapterBinding> = {},
): KernelEffectAdapterBinding {
  return {
    effect_kind: "github/update-ref@1",
    provider: "github",
    operation: "mutation",
    idempotency_strategy: "deterministic_target",
    adapter,
    ...overrides,
  };
}

function service(input: {
  port: KernelEffectPort;
  binding: KernelEffectAdapterBinding;
}) {
  return createKernelEffectExecutionService({
    effects: input.port,
    adapters: createKernelEffectAdapterRegistry([input.binding]),
    now: () => NOW,
  });
}

describe("kernel effect adapter registry", () => {
  it("binds each supported provider action by exact effect kind without a prefix fallback", () => {
    const noop = scriptedAdapter({ observations: [{ kind: "not_found" }] });
    const bindings: KernelEffectAdapterBinding[] = [
      ["github/update-ref@1", "github", "mutation", "deterministic_target"],
      ["github/push-checkpoint@1", "github", "mutation", "deterministic_target"],
      ["github/upsert-pull-request@1", "github", "mutation", "deterministic_target"],
      ["github/upsert-comment@1", "github", "mutation", "deterministic_target"],
      ["github/upsert-check@1", "github", "mutation", "deterministic_target"],
      ["linear/publish-activity@1", "linear", "mutation", "provider_native"],
      ["linear/update-state@1", "linear", "mutation", "deterministic_target"],
      ["daytona/create-sandbox@1", "daytona", "mutation", "deterministic_target"],
      ["daytona/start-sandbox@1", "daytona", "mutation", "deterministic_target"],
      ["daytona/stop-sandbox@1", "daytona", "mutation", "deterministic_target"],
      ["daytona/cleanup-sandbox@1", "daytona", "mutation", "deterministic_target"],
      ["github/provider-wait@1", "github", "observation", "deterministic_target"],
    ].map(([effectKind, provider, operation, strategy]) => ({
      effect_kind: effectKind!,
      provider: provider!,
      operation: operation as "mutation" | "observation",
      idempotency_strategy: strategy as "provider_native" | "deterministic_target",
      adapter: noop,
    }));
    const registry = createKernelEffectAdapterRegistry(bindings);

    expect(registry.effectKinds()).toEqual(bindings.map((entry) => entry.effect_kind).sort());
    expect(registry.bindingFor("github/upsert-check@1").provider).toBe("github");
    expect(() => registry.bindingFor("github/unregistered@1")).toThrow(/no adapter.*exact effect kind/i);
  });

  it("rejects duplicate or malformed bindings at composition time", () => {
    const adapter = scriptedAdapter({ observations: [{ kind: "not_found" }] });
    expect(() => createKernelEffectAdapterRegistry([binding(adapter), binding(adapter)]))
      .toThrow(/duplicate.*github\/update-ref@1/i);
    expect(() => createKernelEffectAdapterRegistry([
      binding(adapter, { effect_kind: "github/*" }),
    ])).toThrow(/invalid effect kind/i);
  });
});

describe("operator effect rejection evidence", () => {
  it("accepts the exact bounded operator-resolution envelope used for a definitive rejection", () => {
    expect(validateOperatorPayload(operatorRejectionPayload())).toMatchObject({
      kind: "delivery",
      status: "rejected",
      payload: { inline: {
        effect_kind: "daytona/integrate-checkpoint@1",
        provider: "operator",
        observed_via: "operator_resolution",
        result: {
          schema: OPERATOR_EFFECT_REJECTION_RESULT_SCHEMA,
          resolution_id: "resolution-integration-validation",
          authorized_via: "deploy_token",
        },
      } },
    });
  });

  it.each([
    ["non-operator provider", operatorRejectionPayload({ provider: "daytona" })],
    ["non-integration effect", operatorRejectionPayload({ effect_kind: "github/push-checkpoint@1" })],
    ["operator provider outside resolution", operatorRejectionPayload({ observed_via: "reconciliation" })],
    ["unknown outer field", operatorRejectionPayload({ actor: "operator@example.com" })],
    ["oversized reason", operatorRejectionPayload({
      result: { ...operatorRejectionPayload().result, reason: "x".repeat(1_501) },
    })],
    ["spoofed authorization", operatorRejectionPayload({
      result: { ...operatorRejectionPayload().result, authorized_via: "status_token" },
    })],
    ["zero reconciliation ordinal", operatorRejectionPayload({
      result: { ...operatorRejectionPayload().result, reconciliation_ordinal: 0 },
    })],
    ["mismatched prior detail hash", operatorRejectionPayload({
      result: { ...operatorRejectionPayload().result, prior_unknown_detail_hash: "c".repeat(64) },
    })],
  ] as const)("rejects %s", (_label, payload) => {
    expect(() => validateOperatorPayload(payload)).toThrow();
  });
});

describe("kernel effect execution", () => {
  it("reconciles first, dispatches once when absent, then appends an executor-authored delivery", async () => {
    const events: string[] = [];
    const adapter = scriptedAdapter({
      events,
      observations: [
        { kind: "not_found" },
        { kind: "found", status: "confirmed", payload: { ref: SUBJECT } },
      ],
    });
    const intent = effect();
    const port = new FakeEffectPort([lease(intent)]);

    const result = await service({
      port,
      binding: binding(adapter, { idempotency_strategy: "provider_native" }),
    }).drainOne({
      worker_id: "worker-1",
      lease_id: "lease-1",
      expires_at: "2026-08-20T12:01:00.000Z",
    });

    expect(events).toEqual([
      `reconcile:${intent.target}`,
      `dispatch:provider_native:${intent.idempotency_key}:${intent.target}`,
      `reconcile:${intent.target}`,
    ]);
    expect(port.dispatchStarts).toEqual([{
      effect_id: intent.id,
      lease_id: "lease-1",
      worker_id: "worker-1",
    }]);
    expect(result).toMatchObject({
      kind: "delivered",
      effect_id: intent.id,
      path: "dispatched_then_reconciled",
    });
    expect(port.completions).toHaveLength(1);
    const completion = port.completions[0]!;
    expect(completion).toMatchObject({
      effect_id: intent.id,
      lease_id: "lease-1",
      worker_id: "worker-1",
      reconciliation: { kind: "append_delivery" },
    });
    if (completion.reconciliation.kind !== "append_delivery") throw new Error("expected delivery");
    expect(completion.reconciliation.delivery).toMatchObject({
      schema: "openthrottle.record/v1",
      kind: "delivery",
      pipeline_run_id: intent.pipeline_run_id,
      effect_id: intent.id,
      idempotency_key: intent.idempotency_key,
      external_identity: intent.target,
      status: "confirmed",
      payload_schema: KERNEL_EFFECT_DELIVERY_PAYLOAD_SCHEMA,
      payload: {
        inline: {
          effect_kind: intent.kind,
          provider: "github",
          observed_via: "post_dispatch_reconciliation",
          result: { ref: SUBJECT },
        },
      },
      created_at: NOW,
    });
    expect(completion.reconciliation.delivery.id).toMatch(/^delivery-[a-f0-9]{64}$/);
    expect(validateExecutionRecord(completion.reconciliation.delivery, {
      payloadSchemas: new Map([
        [KERNEL_EFFECT_DELIVERY_PAYLOAD_SCHEMA, KERNEL_EFFECT_DELIVERY_PAYLOAD_CONTRACT],
      ]),
    }).value).toEqual(completion.reconciliation.delivery);
  });

  it("records a pre-existing provider result without issuing a mutation", async () => {
    const events: string[] = [];
    const adapter = scriptedAdapter({
      events,
      observations: [{ kind: "found", status: "confirmed", payload: { pull_request: 42 } }],
    });
    const intent = effect({ kind: "github/upsert-pull-request@1" });
    const port = new FakeEffectPort([lease(intent)]);

    const result = await service({
      port,
      binding: binding(adapter, { effect_kind: intent.kind }),
    }).drainOne({
      worker_id: "worker-1",
      lease_id: "lease-1",
      expires_at: "2026-08-20T12:01:00.000Z",
    });

    expect(events).toEqual([`reconcile:${intent.target}`]);
    expect(port.dispatchStarts).toHaveLength(0);
    expect(result).toMatchObject({ kind: "delivered", path: "reconciled" });
    expect(port.completions[0]?.reconciliation.kind).toBe("append_delivery");
  });

  it.each([
    ["base-contained pull-request race", "github/upsert-pull-request@1", "expected_head_already_in_base"],
    ["pruned create-mode publication parent", "github/push-checkpoint@1", "publication_parent_missing"],
  ] as const)("settles a %s as rejected without dispatching", async (_label, kind, reason) => {
    const events: string[] = [];
    const adapter = scriptedAdapter({
      events,
      observations: [{
        kind: "found",
        status: "rejected",
        payload: { reason },
      }],
    });
    const intent = effect({ kind });
    const port = new FakeEffectPort([lease(intent)]);

    await expect(service({
      port,
      binding: binding(adapter, { effect_kind: kind }),
    }).drainOne({
      worker_id: "worker-1",
      lease_id: "lease-1",
      expires_at: "2026-08-20T12:01:00.000Z",
    })).resolves.toMatchObject({ kind: "delivered", status: "rejected", path: "reconciled" });
    expect(events).toEqual([`reconcile:${intent.target}`]);
    expect(port.dispatchStarts).toHaveLength(0);
    expect(port.completions[0]?.reconciliation).toMatchObject({
      kind: "append_delivery",
      delivery: { status: "rejected", payload: { inline: { result: {
        reason,
      } } } },
    });
  });

  it("holds an unknown observation and sanitizes diagnostics without dispatching", async () => {
    const events: string[] = [];
    const adapter = scriptedAdapter({
      events,
      observations: [{ kind: "unknown", detail: "provider timed out with ghp_abc123secret" }],
    });
    const intent = effect();
    const port = new FakeEffectPort([lease(intent)]);

    const result = await service({ port, binding: binding(adapter) }).drainOne({
      worker_id: "worker-1",
      lease_id: "lease-1",
      expires_at: "2026-08-20T12:01:00.000Z",
    });

    expect(events).toEqual([`reconcile:${intent.target}`]);
    expect(port.dispatchStarts).toHaveLength(0);
    expect(result).toMatchObject({ kind: "held_unknown", effect_id: intent.id });
    expect(port.completions[0]?.reconciliation).toEqual({
      kind: "hold_unknown",
      effect_id: intent.id,
      external_identity: intent.target,
      detail: "provider timed out with [REDACTED]",
      retry_at: "2026-08-20T12:00:05.000Z",
    });
    expect(result).toMatchObject({ retry_at: "2026-08-20T12:00:05.000Z" });
  });

  it("does not let a provider adapter mutate the leased immutable intent", async () => {
    const intent = effect();
    const adapter: KernelEffectRuntimeAdapter = {
      async reconcile(request) {
        (request.intent.payload as { ref?: string }).ref = "refs/heads/forged";
        return { kind: "not_found" };
      },
      async dispatch() {
        throw new Error("dispatch must not run");
      },
    };
    const port = new FakeEffectPort([lease(intent)]);

    const result = await service({ port, binding: binding(adapter) }).drainOne({
      worker_id: "worker-1",
      lease_id: "lease-1",
      expires_at: "2026-08-20T12:01:00.000Z",
    });

    expect(result).toMatchObject({ kind: "held_unknown" });
    expect(intent.payload).toEqual({ repository: "owner/repo", ref: "refs/heads/ot/work" });
    expect(port.dispatchStarts).toHaveLength(0);
  });

  it("never dispatches a reconcile-only effect when the deterministic target is absent", async () => {
    const events: string[] = [];
    const adapter = scriptedAdapter({ events, observations: [{ kind: "not_found" }] });
    const intent = effect();
    const port = new FakeEffectPort([lease(intent, "reconcile_only")]);

    const result = await service({ port, binding: binding(adapter) }).drainOne({
      worker_id: "worker-1",
      lease_id: "lease-1",
      expires_at: "2026-08-20T12:01:00.000Z",
    });

    expect(events).toEqual([`reconcile:${intent.target}`]);
    expect(port.dispatchStarts).toHaveLength(0);
    expect(result).toMatchObject({ kind: "held_unknown" });
    expect(port.completions[0]?.reconciliation).toMatchObject({
      kind: "hold_unknown",
      detail: expect.stringMatching(/reconcile-only.*absent/i),
    });
  });

  it("never dispatches an observation-only wait when its target is not present yet", async () => {
    const events: string[] = [];
    const adapter = scriptedAdapter({ events, observations: [{ kind: "not_found" }] });
    const intent = effect({ kind: "github/provider-wait@1" });
    const port = new FakeEffectPort([lease(intent)]);

    const result = await service({
      port,
      binding: binding(adapter, { effect_kind: intent.kind, operation: "observation" }),
    }).drainOne({
      worker_id: "worker-1",
      lease_id: "lease-1",
      expires_at: "2026-08-20T12:01:00.000Z",
    });

    expect(result).toMatchObject({ kind: "held_unknown" });
    expect(events).toEqual([`reconcile:${intent.target}`]);
    expect(port.dispatchStarts).toHaveLength(0);
  });

  it("retains matched provider context and producer identities in the durable DeliveryRecord", async () => {
    const matched = [{
      kind: "check_run",
      id: 17,
      name: "quality",
      app_slug: "github-actions",
      status: "completed",
      conclusion: "success",
    }];
    const adapter = scriptedAdapter({ observations: [{
      kind: "found",
      status: "confirmed",
      payload: {
        schema: "openthrottle.github-provider-observation/v1",
        subject: SUBJECT,
        reason: "all_required_observations_succeeded",
        matched_observations: matched,
      },
    }] });
    const intent = effect({ kind: "github/provider-wait@1" });
    const port = new FakeEffectPort([lease(intent)]);

    await expect(service({
      port,
      binding: binding(adapter, { effect_kind: intent.kind, operation: "observation" }),
    }).drainOne({
      worker_id: "worker-1",
      lease_id: "lease-1",
      expires_at: "2026-08-20T12:01:00.000Z",
    })).resolves.toMatchObject({ kind: "delivered", status: "confirmed" });

    expect(port.completions[0]!.reconciliation).toMatchObject({
      kind: "append_delivery",
      delivery: {
        kind: "delivery",
        status: "confirmed",
        payload: { inline: { result: { matched_observations: matched } } },
      },
    });
  });

  it("holds instead of replaying when post-dispatch reconciliation is still absent", async () => {
    const events: string[] = [];
    const adapter = scriptedAdapter({
      events,
      observations: [{ kind: "not_found" }, { kind: "not_found" }],
    });
    const intent = effect();
    const port = new FakeEffectPort([lease(intent)]);

    const result = await service({ port, binding: binding(adapter) }).drainOne({
      worker_id: "worker-1",
      lease_id: "lease-1",
      expires_at: "2026-08-20T12:01:00.000Z",
    });

    expect(events.filter((event) => event.startsWith("dispatch:"))).toHaveLength(1);
    expect(port.dispatchStarts).toHaveLength(1);
    expect(result).toMatchObject({ kind: "held_unknown" });
    expect(port.completions[0]?.reconciliation).toMatchObject({
      kind: "hold_unknown",
      detail: expect.stringMatching(/absent after dispatch.*indeterminate/i),
    });
  });

  it("reconciles a provider timeout after acceptance instead of retrying dispatch", async () => {
    let providerHasTarget = false;
    let dispatches = 0;
    const adapter: KernelEffectRuntimeAdapter = {
      async reconcile() {
        return providerHasTarget
          ? { kind: "found", status: "confirmed", payload: { ref: SUBJECT } }
          : { kind: "not_found" };
      },
      async dispatch(request) {
        expect(request.deduplication).toEqual({
          strategy: "deterministic_target",
          key: "run-1:update-ref",
          target: "github:owner/repo:refs/heads/ot/work",
        });
        dispatches += 1;
        providerHasTarget = true;
        throw new Error("provider response timed out");
      },
    };
    const intent = effect();
    const port = new FakeEffectPort([lease(intent)]);

    const result = await service({ port, binding: binding(adapter) }).drainOne({
      worker_id: "worker-1",
      lease_id: "lease-1",
      expires_at: "2026-08-20T12:01:00.000Z",
    });

    expect(dispatches).toBe(1);
    expect(result).toMatchObject({
      kind: "delivered",
      path: "dispatched_then_reconciled",
    });
    expect(port.completions[0]?.reconciliation.kind).toBe("append_delivery");
  });

  it("replays safely after a kill before dispatch", async () => {
    const controller = new AbortController();
    const beforeKillEvents: string[] = [];
    const beforeKill = scriptedAdapter({
      events: beforeKillEvents,
      observations: [{ kind: "not_found" }],
    });
    const intent = effect();
    beforeKill.reconcile = async (request) => {
      beforeKillEvents.push(`reconcile:${request.external_identity}`);
      controller.abort(new Error("kill before dispatch"));
      return { kind: "not_found" };
    };
    const interruptedPort = new FakeEffectPort([lease(intent)]);

    await expect(service({ port: interruptedPort, binding: binding(beforeKill) }).drainOne({
      worker_id: "worker-1",
      lease_id: "lease-1",
      expires_at: "2026-08-20T12:01:00.000Z",
      signal: controller.signal,
    })).rejects.toThrow(/kill before dispatch/);
    expect(beforeKillEvents).toEqual([`reconcile:${intent.target}`]);
    expect(interruptedPort.completions).toHaveLength(0);
    expect(interruptedPort.dispatchStarts).toHaveLength(0);

    const replayEvents: string[] = [];
    const replay = scriptedAdapter({
      events: replayEvents,
      observations: [
        { kind: "not_found" },
        { kind: "found", status: "confirmed", payload: { ref: SUBJECT } },
      ],
    });
    const replayPort = new FakeEffectPort([{
      ...lease(intent),
      lease_id: "lease-2",
      expires_at: "2026-08-20T12:02:00.000Z",
    }]);
    await service({ port: replayPort, binding: binding(replay) }).drainOne({
      worker_id: "worker-2",
      lease_id: "lease-2",
      expires_at: "2026-08-20T12:02:00.000Z",
    });

    expect(replayEvents.filter((event) => event.startsWith("dispatch:"))).toHaveLength(1);
    expect(replayPort.dispatchStarts).toHaveLength(1);
  });

  it("rejects a conflicting immutable intent returned at the dispatch-start fence", async () => {
    const events: string[] = [];
    const adapter = scriptedAdapter({
      events,
      observations: [{ kind: "not_found" }],
    });
    const intent = effect();
    const port = new FakeEffectPort([lease(intent)], {
      dispatchStartedIntent: {
        ...intent,
        payload: { repository: "owner/other", ref: "refs/heads/ot/work" },
      },
    });

    await expect(service({ port, binding: binding(adapter) }).drainOne({
      worker_id: "worker-1",
      lease_id: "lease-1",
      expires_at: "2026-08-20T12:01:00.000Z",
    })).rejects.toThrow(/invalid dispatch-start fence/);

    expect(events).toEqual([`reconcile:${intent.target}`]);
    expect(port.dispatchStarts).toHaveLength(1);
    expect(port.completions).toHaveLength(0);
  });

  it("never sends after a kill at the persisted dispatch-start fence", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const adapter = scriptedAdapter({
      events,
      observations: [{ kind: "not_found" }, { kind: "not_found" }],
    });
    const intent = effect();
    const interruptedPort = new FakeEffectPort([lease(intent)], {
      onDispatchStarted: () => controller.abort(new Error("kill after dispatch fence")),
    });

    await expect(service({ port: interruptedPort, binding: binding(adapter) }).drainOne({
      worker_id: "worker-1",
      lease_id: "lease-1",
      expires_at: "2026-08-20T12:01:00.000Z",
      signal: controller.signal,
    })).rejects.toThrow(/kill after dispatch fence/);
    expect(events).toEqual([`reconcile:${intent.target}`]);
    expect(interruptedPort.dispatchStarts).toHaveLength(1);
    expect(interruptedPort.completions).toHaveLength(0);

    const recoveryPort = new FakeEffectPort([{
      ...lease(intent, "reconcile_only"),
      lease_id: "lease-2",
      expires_at: "2026-08-20T12:02:00.000Z",
    }]);
    const result = await service({ port: recoveryPort, binding: binding(adapter) }).drainOne({
      worker_id: "worker-2",
      lease_id: "lease-2",
      expires_at: "2026-08-20T12:02:00.000Z",
    });

    expect(result).toMatchObject({ kind: "held_unknown" });
    expect(events).toEqual([
      `reconcile:${intent.target}`,
      `reconcile:${intent.target}`,
    ]);
    expect(recoveryPort.dispatchStarts).toHaveLength(0);
  });

  it("reconciles without another send after provider acceptance and local acknowledgement loss", async () => {
    let providerHasTarget = false;
    let dispatches = 0;
    const controller = new AbortController();
    const adapter: KernelEffectRuntimeAdapter = {
      async reconcile() {
        return providerHasTarget
          ? { kind: "found", status: "confirmed", payload: { ref: SUBJECT } }
          : { kind: "not_found" };
      },
      async dispatch() {
        dispatches += 1;
        providerHasTarget = true;
        controller.abort(new Error("kill after provider acceptance"));
      },
    };
    const intent = effect();
    const interruptedPort = new FakeEffectPort([lease(intent)]);

    await expect(service({ port: interruptedPort, binding: binding(adapter) }).drainOne({
      worker_id: "worker-1",
      lease_id: "lease-1",
      expires_at: "2026-08-20T12:01:00.000Z",
      signal: controller.signal,
    })).rejects.toThrow(/kill after provider acceptance/);
    expect(interruptedPort.dispatchStarts).toHaveLength(1);
    expect(interruptedPort.completions).toHaveLength(0);

    const recoveryPort = new FakeEffectPort([{
      ...lease(intent, "reconcile_only"),
      lease_id: "lease-2",
      expires_at: "2026-08-20T12:02:00.000Z",
    }]);
    const result = await service({ port: recoveryPort, binding: binding(adapter) }).drainOne({
      worker_id: "worker-2",
      lease_id: "lease-2",
      expires_at: "2026-08-20T12:02:00.000Z",
    });

    expect(dispatches).toBe(1);
    expect(result).toMatchObject({ kind: "delivered", path: "reconciled" });
    expect(recoveryPort.completions[0]?.reconciliation.kind).toBe("append_delivery");
  });

  it("does not replay after the DeliveryRecord and settlement committed", async () => {
    let reconciliations = 0;
    const adapter: KernelEffectRuntimeAdapter = {
      async reconcile() {
        reconciliations += 1;
        return { kind: "found", status: "confirmed", payload: { ref: SUBJECT } };
      },
      async dispatch() {
        throw new Error("dispatch must not run");
      },
    };
    const intent = effect();
    const committedPort = new FakeEffectPort([lease(intent)], { throwAfterCompletion: true });
    const executor = service({ port: committedPort, binding: binding(adapter) });

    await expect(executor.drainOne({
      worker_id: "worker-1",
      lease_id: "lease-1",
      expires_at: "2026-08-20T12:01:00.000Z",
    })).rejects.toThrow(/lost after durable completion/);
    expect(await executor.drainOne({
      worker_id: "worker-2",
      lease_id: "lease-2",
      expires_at: "2026-08-20T12:02:00.000Z",
    })).toEqual({ kind: "idle" });
    expect(reconciliations).toBe(1);
  });
});
