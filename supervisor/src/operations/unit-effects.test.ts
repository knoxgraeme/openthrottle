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
    idempotency_key: "unit-action:attempt-parent:a:1",
    request_hash: null,
    result_hash: null,
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

describe("unit effect processor", () => {
  it("dispatches one leased child action", async () => {
    const leased = action();
    const store = {
      leaseNextUnitAction: vi.fn(() => leased),
      markActionDispatching: vi.fn(),
      markActionDispatched: vi.fn(),
      completeUnitAction: vi.fn(),
    } as unknown as ExecutionUnitStore;
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
    const store = {
      leaseNextUnitAction: vi.fn(() => leased),
      markActionDispatching: vi.fn(),
      markActionDispatched: vi.fn(),
      completeUnitAction: vi.fn(),
    } as unknown as ExecutionUnitStore;
    const runtime: UnitEffectRuntime = {
      collectUnitAction: vi.fn(async () => ({ resultHash: "result-hash", outputSubject: "abc123" })),
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
    });
  });

  it("collects an already-dispatched child action without duplicate dispatch", async () => {
    const leased = action({ status: "dispatched", request_hash: "request-hash", native_session_id: "native-1" });
    const store = {
      leaseNextUnitAction: vi.fn(() => leased),
      markActionDispatching: vi.fn(),
      markActionDispatched: vi.fn(),
      completeUnitAction: vi.fn(),
    } as unknown as ExecutionUnitStore;
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
    const leased = action({ status: "dispatched" });
    const store = {
      leaseNextUnitAction: vi.fn(() => leased),
      markActionDispatching: vi.fn(),
      markActionDispatched: vi.fn(),
      completeUnitAction: vi.fn(),
    } as unknown as ExecutionUnitStore;
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
});
