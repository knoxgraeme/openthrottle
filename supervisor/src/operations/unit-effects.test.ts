import { describe, expect, it, vi } from "vitest";
import { createUnitEffectProcessor, type UnitEffectRuntime } from "./unit-effects.js";
import type { ExecutionUnitStore, ExecutionWorkAttempt } from "../persistence/pipeline/unit-store.js";

function action(overrides: Partial<ExecutionWorkAttempt> = {}): ExecutionWorkAttempt {
  return {
    id: "action-1",
    execution_graph_id: "graph-1",
    execution_unit_id: "unit-1",
    pipeline_instance_id: "instance-1",
    parent_attempt_id: "attempt-parent",
    parent_run_id: "run-parent",
    unit_id: "a",
    attempt_ordinal: 1,
    action_kind: "implement",
    cycle: 1,
    command_name: null,
    idempotency_key: "unit-action:attempt-parent:a:1",
    request_hash: null,
    result_hash: null,
    receipt: null,
    receipt_hash: null,
    native_session_id: null,
    status: "leased",
    lease_owner: "owner",
    lease_until: "2026-07-29T00:01:00.000Z",
    output_subject: null,
    payload: "{}",
    created_at: "2026-07-29T00:00:00.000Z",
    updated_at: "2026-07-29T00:00:00.000Z",
    completed_at: null,
    last_error: null,
    ...overrides,
  };
}

function storeFor(leased: ExecutionWorkAttempt): ExecutionUnitStore {
  return {
    leaseNextUnitAction: vi.fn(() => leased),
    markActionDispatching: vi.fn(),
    markActionDispatched: vi.fn(),
    completeUnitAction: vi.fn(),
    failUnitAction: vi.fn(),
    healExpiredCurrentChildAction: vi.fn(),
  } as unknown as ExecutionUnitStore;
}

describe("unit effect processor", () => {
  it("dispatches one leased child action", async () => {
    const leased = action();
    const store = storeFor(leased);
    const runtime: UnitEffectRuntime = {
      collectUnitAction: vi.fn(async () => null),
      dispatchUnitAction: vi.fn(async () => ({ requestHash: "request-hash", nativeSessionId: "native-1" })),
    };

    await createUnitEffectProcessor({
      store,
      runtime,
      leaseOwner: "owner",
      now: () => new Date("2026-07-29T00:00:00.000Z"),
    }).drain("attempt-parent");

    expect(store.leaseNextUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      parentAttemptId: "attempt-parent",
      leaseOwner: "owner",
    }));
    expect(store.markActionDispatching).toHaveBeenCalledWith("action-1");
    expect(runtime.dispatchUnitAction).toHaveBeenCalledWith(leased);
    expect(store.markActionDispatched).toHaveBeenCalledWith("action-1", "request-hash", "native-1");
  });

  it("acknowledges recovered child actions without duplicate dispatch", async () => {
    const leased = action();
    const store = storeFor(leased);
    const runtime: UnitEffectRuntime = {
      collectUnitAction: vi.fn(async () => ({ resultHash: "result-hash", outputSubject: "abc123", nativeSessionId: "native-1" })),
      dispatchUnitAction: vi.fn(),
    };

    await createUnitEffectProcessor({
      store,
      runtime,
      leaseOwner: "owner",
      now: () => new Date("2026-07-29T00:00:00.000Z"),
    }).drain("attempt-parent");

    expect(runtime.dispatchUnitAction).not.toHaveBeenCalled();
    expect(store.markActionDispatching).not.toHaveBeenCalled();
    expect(store.completeUnitAction).toHaveBeenCalledWith({
      actionId: "action-1",
      resultHash: "result-hash",
      outputSubject: "abc123",
      nativeSessionId: "native-1",
    });
  });

  it("persists collected terminal child failures without duplicate dispatch", async () => {
    const leased = action({ status: "running", request_hash: "request-hash" });
    const store = storeFor(leased);
    const runtime: UnitEffectRuntime = {
      collectUnitAction: vi.fn(async () => ({
        terminal: true as const,
        outcome: "retryable_infrastructure_failure" as const,
        resultHash: "result-hash",
        lastError: "child action failed",
        nativeSessionId: null,
      })),
      dispatchUnitAction: vi.fn(),
    };

    await createUnitEffectProcessor({
      store,
      runtime,
      leaseOwner: "owner",
      now: () => new Date("2026-07-29T00:00:00.000Z"),
    }).drain("attempt-parent");

    expect(store.failUnitAction).toHaveBeenCalledWith({
      actionId: "action-1",
      resultHash: "result-hash",
      outcome: "retryable_infrastructure_failure",
      lastError: "child action failed",
      nativeSessionId: null,
    });
    expect(store.completeUnitAction).not.toHaveBeenCalled();
    expect(runtime.dispatchUnitAction).not.toHaveBeenCalled();
  });

  it("collects an already-dispatched child action without duplicate dispatch", async () => {
    const leased = action({ status: "dispatched", request_hash: "request-hash", native_session_id: "native-1" });
    const store = storeFor(leased);
    const runtime: UnitEffectRuntime = {
      collectUnitAction: vi.fn(async () => null),
      dispatchUnitAction: vi.fn(),
    };

    await createUnitEffectProcessor({
      store,
      runtime,
      leaseOwner: "owner",
      now: () => new Date("2026-07-29T00:00:00.000Z"),
    }).drain("attempt-parent");

    expect(runtime.collectUnitAction).toHaveBeenCalledWith(leased);
    expect(runtime.dispatchUnitAction).not.toHaveBeenCalled();
    expect(store.markActionDispatching).not.toHaveBeenCalled();
    expect(store.markActionDispatched).not.toHaveBeenCalled();
  });

  it("reissues a request-less dispatched action with the same idempotency key", async () => {
    const leased = action({ status: "dispatched", native_session_id: "native-before-request" });
    const store = storeFor(leased);
    const runtime: UnitEffectRuntime = {
      collectUnitAction: vi.fn(async () => {
        throw new Error("missing runtime request");
      }),
      dispatchUnitAction: vi.fn(async () => ({ requestHash: "request-hash", nativeSessionId: "native-1" })),
    };

    await createUnitEffectProcessor({
      store,
      runtime,
      leaseOwner: "owner",
      now: () => new Date("2026-07-29T00:00:00.000Z"),
    }).drain("attempt-parent");

    expect(store.markActionDispatching).not.toHaveBeenCalled();
    expect(runtime.collectUnitAction).not.toHaveBeenCalled();
    expect(runtime.dispatchUnitAction).toHaveBeenCalledWith(leased);
    expect(store.markActionDispatched).toHaveBeenCalledWith("action-1", "request-hash", "native-1");
  });

  it("heals an expired dispatched action only after collection confirms no result", async () => {
    const expired = action({
      status: "dispatched",
      request_hash: "request-hash",
      native_session_id: "native-1",
      lease_until: "2026-07-28T23:59:59.000Z",
    });
    const store = storeFor(expired);
    const runtime: UnitEffectRuntime = {
      collectUnitAction: vi.fn(async () => null),
      dispatchUnitAction: vi.fn(),
    };

    await createUnitEffectProcessor({
      store,
      runtime,
      leaseOwner: "owner",
      now: () => new Date("2026-07-29T00:00:00.000Z"),
    }).drain("attempt-parent");

    expect(runtime.collectUnitAction).toHaveBeenCalledWith(expired);
    expect(store.healExpiredCurrentChildAction).toHaveBeenCalledWith({
      parentAttemptId: "attempt-parent",
      actionId: "action-1",
      nowIso: "2026-07-29T00:00:00.000Z",
      reason: "child action missed heartbeat fence",
    });
    expect(store.completeUnitAction).not.toHaveBeenCalled();
    expect(runtime.dispatchUnitAction).not.toHaveBeenCalled();
  });

  it("retains an expired action when collection errors", async () => {
    const expired = action({
      status: "running",
      request_hash: "request-hash",
      native_session_id: "native-1",
      lease_until: "2026-07-28T23:59:59.000Z",
    });
    const store = storeFor(expired);
    const runtime: UnitEffectRuntime = {
      collectUnitAction: vi.fn(async () => {
        throw new Error("runtime unavailable");
      }),
      dispatchUnitAction: vi.fn(),
    };

    await expect(createUnitEffectProcessor({
      store,
      runtime,
      leaseOwner: "owner",
      now: () => new Date("2026-07-29T00:00:00.000Z"),
    }).drain("attempt-parent")).rejects.toThrow(/runtime unavailable/);

    expect(store.healExpiredCurrentChildAction).not.toHaveBeenCalled();
    expect(store.completeUnitAction).not.toHaveBeenCalled();
    expect(runtime.dispatchUnitAction).not.toHaveBeenCalled();
  });
});
