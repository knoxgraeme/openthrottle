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
    terminal_result_outcome: null,
    receipt: null,
    receipt_hash: null,
    native_session_id: null,
    status: "leased",
    lease_owner: "owner",
    lease_until: "2026-07-29T00:01:00.000Z",
    observation_failure_count: 0,
    observation_retry_at: null,
    observation_epoch: 0,
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
    clearActionObservationFailure: vi.fn(() => "cleared"),
    recordActionObservationFailure: vi.fn(),
    completeUnitAction: vi.fn(),
    failUnitAction: vi.fn(),
    stopRetryableUnitAction: vi.fn(),
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

  it("backs off retryable final-review dispatch failures through the observation budget", async () => {
    const leased = action({
      action_kind: "final_review",
      unit_id: null,
      lease_until: "2026-07-28T23:59:59.000Z",
    });
    const store = storeFor(leased);
    const runtime: UnitEffectRuntime = {
      collectUnitAction: vi.fn(),
      dispatchUnitAction: vi.fn(async () => {
        throw Object.assign(new Error("review selector launch throttled"), { statusCode: 429 });
      }),
    };

    await expect(createUnitEffectProcessor({
      store,
      runtime,
      leaseOwner: "owner",
      now: () => new Date("2026-07-29T00:00:00.000Z"),
    }).drain("attempt-parent")).resolves.toEqual(leased);

    expect(store.recordActionObservationFailure).toHaveBeenCalledWith({
      actionId: "action-1",
      expectedFailureCount: 0,
      expectedEpoch: 1,
      lastError: expect.stringMatching(/observation_attempt=1\/3 .*retryable=true status=429/),
      retryAtIso: "2026-07-29T00:00:05.000Z",
    });
    expect(store.healExpiredCurrentChildAction).not.toHaveBeenCalled();
    expect(store.stopRetryableUnitAction).not.toHaveBeenCalled();
    expect(store.markActionDispatched).not.toHaveBeenCalled();
  });

  it("anchors collection backoff after slow failing provider I/O", async () => {
    let currentMs = Date.parse("2026-07-29T00:00:00.000Z");
    const leased = action({ status: "running", request_hash: "request-hash" });
    const store = storeFor(leased);
    const runtime: UnitEffectRuntime = {
      collectUnitAction: vi.fn(async () => {
        currentMs += 6_000;
        throw new Error("slow collection failed");
      }),
      dispatchUnitAction: vi.fn(),
    };

    await createUnitEffectProcessor({
      store,
      runtime,
      leaseOwner: "owner",
      now: () => new Date(currentMs),
    }).drain("attempt-parent");

    expect(store.recordActionObservationFailure).toHaveBeenCalledWith(expect.objectContaining({
      retryAtIso: "2026-07-29T00:00:11.000Z",
      lastError: "observation_attempt=1/3 slow collection failed",
    }));
  });

  it("anchors exponential dispatch backoff after slow failing provider I/O", async () => {
    let currentMs = Date.parse("2026-07-29T00:00:00.000Z");
    const leased = action({
      action_kind: "final_review",
      unit_id: null,
      status: "dispatched",
      request_hash: "request-hash",
      request_payload: "{}",
      request_launch_state: "prepared",
      observation_failure_count: 1,
      observation_epoch: 3,
    });
    const store = storeFor(leased);
    const runtime: UnitEffectRuntime = {
      collectUnitAction: vi.fn(),
      dispatchUnitAction: vi.fn(async () => {
        currentMs += 6_000;
        throw Object.assign(new Error("slow selector dispatch failed"), { statusCode: 502 });
      }),
    };

    await createUnitEffectProcessor({
      store,
      runtime,
      leaseOwner: "owner",
      now: () => new Date(currentMs),
    }).drain("attempt-parent");

    expect(store.recordActionObservationFailure).toHaveBeenCalledWith(expect.objectContaining({
      expectedFailureCount: 1,
      expectedEpoch: 3,
      retryAtIso: "2026-07-29T00:00:16.000Z",
      lastError: expect.stringMatching(/observation_attempt=2\/3 .*retryable=true status=502/),
    }));
  });

  it("terminalizes a deterministic final-review dispatch failure through the action fail path", async () => {
    const leased = action({ action_kind: "final_review", unit_id: null });
    const store = storeFor(leased);
    const runtime: UnitEffectRuntime = {
      collectUnitAction: vi.fn(async () => null),
      dispatchUnitAction: vi.fn(async () => {
        throw Object.assign(new Error("selector authorization denied"), { statusCode: 403 });
      }),
    };

    await expect(createUnitEffectProcessor({
      store,
      runtime,
      leaseOwner: "owner",
      now: () => new Date("2026-07-29T00:00:00.000Z"),
    }).drain("attempt-parent")).resolves.toEqual(leased);

    expect(store.failUnitAction).toHaveBeenCalledWith({
      actionId: "action-1",
      resultHash: expect.any(String),
      outcome: "failure",
      lastError: expect.stringMatching(/final-review dispatch failed: .*retryable=false status=403/),
      nativeSessionId: null,
    });
    expect(store.recordActionObservationFailure).not.toHaveBeenCalled();
    expect(store.stopRetryableUnitAction).not.toHaveBeenCalled();
    expect(store.markActionDispatched).not.toHaveBeenCalled();
  });

  it("backs off retryable non-final-review dispatch failures through the observation budget", async () => {
    const leased = action({ action_kind: "implement" });
    const store = storeFor(leased);
    const runtime: UnitEffectRuntime = {
      collectUnitAction: vi.fn(async () => null),
      dispatchUnitAction: vi.fn(async () => {
        throw Object.assign(new Error("worker provider unavailable"), { statusCode: 502 });
      }),
    };

    await expect(createUnitEffectProcessor({
      store,
      runtime,
      leaseOwner: "owner",
      now: () => new Date("2026-07-29T00:00:00.000Z"),
    }).drain("attempt-parent")).resolves.toEqual(leased);

    expect(store.recordActionObservationFailure).toHaveBeenCalledWith({
      actionId: "action-1",
      expectedFailureCount: 0,
      expectedEpoch: 1,
      lastError: expect.stringMatching(/observation_attempt=1\/3 .*retryable=true status=502/),
      retryAtIso: "2026-07-29T00:00:05.000Z",
    });
    expect(store.failUnitAction).not.toHaveBeenCalled();
    expect(store.stopRetryableUnitAction).not.toHaveBeenCalled();
    expect(store.markActionDispatched).not.toHaveBeenCalled();
  });

  it("terminalizes exhausted retryable non-final-review dispatch failures through the retryable stop", async () => {
    const leased = action({
      action_kind: "implement",
      status: "dispatched",
      request_hash: "request-hash",
      request_payload: "{}",
      request_launch_state: "prepared",
      observation_failure_count: 2,
    });
    const store = storeFor(leased);
    const runtime: UnitEffectRuntime = {
      collectUnitAction: vi.fn(),
      dispatchUnitAction: vi.fn(async () => {
        throw Object.assign(new Error("worker provider unavailable"), { statusCode: 502 });
      }),
    };

    await createUnitEffectProcessor({
      store,
      runtime,
      leaseOwner: "owner",
      now: () => new Date("2026-07-29T00:00:00.000Z"),
    }).drain("attempt-parent");

    expect(store.stopRetryableUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "action-1",
      lastError: expect.stringMatching(/observation_attempt=3\/3 .*retryable=true status=502/),
      observationExhaustion: {
        expectedFailureCount: 2,
        expectedEpoch: 0,
        exhaustedFailureCount: 3,
      },
    }));
    expect(store.failUnitAction).not.toHaveBeenCalled();
    expect(store.markActionDispatched).not.toHaveBeenCalled();
  });

  it("terminalizes a deterministic non-final-review dispatch failure through the action fail path", async () => {
    const leased = action({ action_kind: "implement" });
    const store = storeFor(leased);
    const runtime: UnitEffectRuntime = {
      collectUnitAction: vi.fn(async () => null),
      dispatchUnitAction: vi.fn(async () => {
        throw Object.assign(new Error("worker authorization denied"), { statusCode: 403 });
      }),
    };

    await expect(createUnitEffectProcessor({
      store,
      runtime,
      leaseOwner: "owner",
      now: () => new Date("2026-07-29T00:00:00.000Z"),
    }).drain("attempt-parent")).resolves.toEqual(leased);

    expect(store.failUnitAction).toHaveBeenCalledWith({
      actionId: "action-1",
      resultHash: expect.any(String),
      outcome: "failure",
      lastError: expect.stringMatching(/implement dispatch failed: .*retryable=false status=403/),
      nativeSessionId: null,
    });
    expect(store.recordActionObservationFailure).not.toHaveBeenCalled();
    expect(store.stopRetryableUnitAction).not.toHaveBeenCalled();
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
    expect(store.clearActionObservationFailure).toHaveBeenCalledWith({
      actionId: "action-1",
      expectedFailureCount: 0,
      expectedEpoch: 0,
    });
  });

  it("persists collected terminal child failures without duplicate dispatch", async () => {
    const leased = action({ status: "running", request_hash: "request-hash" });
    const store = storeFor(leased);
    const runtime: UnitEffectRuntime = {
      collectUnitAction: vi.fn(async () => ({
        terminal: true as const,
        outcome: "failure" as const,
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
      outcome: "failure",
      lastError: "child action failed",
      nativeSessionId: null,
    });
    expect(store.completeUnitAction).not.toHaveBeenCalled();
    expect(runtime.dispatchUnitAction).not.toHaveBeenCalled();
  });

  it("persists retryable terminal child failures through the graph stop path", async () => {
    const leased = action({ status: "running", request_hash: "request-hash" });
    const store = storeFor(leased);
    const runtime: UnitEffectRuntime = {
      collectUnitAction: vi.fn(async () => ({
        terminal: true as const,
        outcome: "retryable_infrastructure_failure" as const,
        resultHash: "result-hash",
        lastError: "sandbox result collection failed",
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

    expect(store.stopRetryableUnitAction).toHaveBeenCalledWith({
      actionId: "action-1",
      resultHash: "result-hash",
      lastError: "sandbox result collection failed",
      nativeSessionId: null,
    });
    expect(store.failUnitAction).not.toHaveBeenCalled();
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
    expect(store.clearActionObservationFailure).toHaveBeenCalledWith({
      actionId: "action-1",
      expectedFailureCount: 0,
      expectedEpoch: 0,
    });
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

  it("backs off an expired action when transient collection observation errors remain within budget", async () => {
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
    }).drain("attempt-parent")).resolves.toEqual(expired);

    expect(store.recordActionObservationFailure).toHaveBeenCalledWith({
      actionId: "action-1",
      expectedFailureCount: 0,
      expectedEpoch: 0,
      lastError: "observation_attempt=1/3 runtime unavailable",
      retryAtIso: "2026-07-29T00:00:05.000Z",
    });
    expect(store.healExpiredCurrentChildAction).not.toHaveBeenCalled();
    expect(store.stopRetryableUnitAction).not.toHaveBeenCalled();
    expect(store.completeUnitAction).not.toHaveBeenCalled();
    expect(runtime.dispatchUnitAction).not.toHaveBeenCalled();
  });

  it("terminalizes repeated transient collection observation errors when the budget is exhausted", async () => {
    const expired = action({
      status: "running",
      request_hash: "request-hash",
      native_session_id: "native-1",
      lease_until: "2026-07-28T23:59:59.000Z",
      observation_failure_count: 2,
    });
    const store = storeFor(expired);
    const runtime: UnitEffectRuntime = {
      collectUnitAction: vi.fn(async () => {
        throw new Error("runtime unavailable");
      }),
      dispatchUnitAction: vi.fn(),
    };

    await createUnitEffectProcessor({
      store,
      runtime,
      leaseOwner: "owner",
      now: () => new Date("2026-07-29T00:00:00.000Z"),
    }).drain("attempt-parent");

    expect(store.stopRetryableUnitAction).toHaveBeenCalledWith({
      actionId: "action-1",
      resultHash: expect.any(String),
      lastError: "observation_attempt=3/3 runtime unavailable",
      nativeSessionId: "native-1",
      observationExhaustion: {
        expectedFailureCount: 2,
        expectedEpoch: 0,
        exhaustedFailureCount: 3,
      },
    });
    expect(store.recordActionObservationFailure).not.toHaveBeenCalled();
    expect(store.healExpiredCurrentChildAction).not.toHaveBeenCalled();
    expect(runtime.dispatchUnitAction).not.toHaveBeenCalled();
  });

  it("starts a fresh observation budget after a successful null collection", async () => {
    let failureCount = 1;
    let epoch = 0;
    const store = storeFor(action({
      status: "running",
      request_hash: "request-hash",
      observation_failure_count: failureCount,
      observation_retry_at: "2026-07-29T00:00:00.000Z",
      last_error: "observation_attempt=1/3 operation=collect status=502",
    }));
    vi.mocked(store.clearActionObservationFailure).mockImplementation(({ expectedFailureCount, expectedEpoch }) => {
      if (failureCount !== expectedFailureCount || epoch !== expectedEpoch) return "stale";
      epoch += 1;
      failureCount = 0;
      return "cleared";
    });
    vi.mocked(store.recordActionObservationFailure).mockImplementation(({ expectedFailureCount, expectedEpoch }) => {
      if (failureCount !== expectedFailureCount || epoch !== expectedEpoch) return "stale";
      failureCount += 1;
      return "recorded";
    });
    const runtime: UnitEffectRuntime = {
      collectUnitAction: vi.fn()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error("operation=collect retryable=true status=502")),
      dispatchUnitAction: vi.fn(),
    };

    await createUnitEffectProcessor({
      store,
      runtime,
      leaseOwner: "owner",
      now: () => new Date("2026-07-29T00:00:01.000Z"),
    }).drain("attempt-parent");
    vi.mocked(store.leaseNextUnitAction).mockReturnValue(action({
      status: "running",
      request_hash: "request-hash",
      observation_failure_count: failureCount,
      observation_epoch: epoch,
    }));
    await createUnitEffectProcessor({
      store,
      runtime,
      leaseOwner: "owner",
      now: () => new Date("2026-07-29T00:00:02.000Z"),
    }).drain("attempt-parent");

    expect(store.clearActionObservationFailure).toHaveBeenCalledWith({
      actionId: "action-1",
      expectedFailureCount: 1,
      expectedEpoch: 0,
    });
    expect(store.recordActionObservationFailure).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "action-1",
      expectedFailureCount: 0,
      expectedEpoch: 1,
      lastError: "observation_attempt=1/3 operation=collect retryable=true status=502",
    }));
    expect(store.stopRetryableUnitAction).not.toHaveBeenCalled();
    expect(runtime.dispatchUnitAction).not.toHaveBeenCalled();
  });

  it("ignores a successful result when the observation reset fence is stale", async () => {
    const leased = action({
      status: "running",
      request_hash: "request-hash",
      observation_failure_count: 1,
    });
    const store = storeFor(leased);
    vi.mocked(store.clearActionObservationFailure).mockReturnValue("stale");
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

    expect(store.completeUnitAction).not.toHaveBeenCalled();
    expect(store.failUnitAction).not.toHaveBeenCalled();
    expect(runtime.dispatchUnitAction).not.toHaveBeenCalled();
  });
});
