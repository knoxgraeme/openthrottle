import { describe, expect, it, vi } from "vitest";
import type {
  KernelInboxDeliveryPort,
  KernelInboxEvent,
} from "../persistence/kernel-inbox-store.js";
import type { KernelAttemptLeasePort } from "../pipeline/kernel/ports.js";
import type { OrdinaryKernelCoordinator } from "../pipeline/kernel/ordinary-coordinator.js";
import type { KernelExternalBoundaryCoordinator } from "./kernel-external-boundary.js";
import type { KernelEffectExecutionService } from "./kernel-effects.js";
import { KernelWorker } from "./kernel-worker.js";

const NOW = "2026-08-20T12:00:00.000Z";

function inboxEvent(): KernelInboxEvent {
  return {
    id: "inbox-1",
    source_provider: "github",
    delivery_id: "delivery-1",
    kind: "github/issues/opened@1",
    work_item_id: null,
    pipeline_run_id: null,
    attempt_id: null,
    generation: 0,
    event_group_key: "issue-1",
    delivery_attempt: 1,
    subject: null,
    payload_hash: "a".repeat(64),
    payload_schema: "provider-event/v1",
    payload: {},
    status: "processing",
    available_at: NOW,
    lease_id: "leased-by-worker",
    lease_owner_id: "worker-1",
    lease_expires_at: "2026-08-20T12:02:00.000Z",
    version: 1,
    created_at: NOW,
    consumed_at: null,
  };
}

function workerFixture(
  handler: (event: KernelInboxEvent) => Promise<"consumed" | "stale" | "dead">,
  options: { initial_inbox_event?: KernelInboxEvent | null } = {},
) {
  let next: KernelInboxEvent | null = options.initial_inbox_event === undefined
    ? inboxEvent()
    : options.initial_inbox_event;
  const leaseNext = vi.fn(() => {
    const leased = next;
    next = null;
    return leased;
  });
  const complete = vi.fn();
  const retry = vi.fn();
  const inbox: KernelInboxDeliveryPort = {
    leaseNext,
    complete,
    retry,
    get: () => undefined,
  };
  const attempts = {
    recoverExpiredAttemptLeases: vi.fn(async () => []),
    leaseNextEligibleAttempt: vi.fn(async () => null),
  } as unknown as KernelAttemptLeasePort;
  const ordinary = {
    resumeReadyAttempt: vi.fn(async () => ({ disposition: "idle" as const })),
    terminalizeExhaustedRecovery: vi.fn(async () => null),
    leaseAndExecuteNext: vi.fn(async () => ({ disposition: "idle" as const })),
    executeLeasedAttempt: vi.fn(),
  } as unknown as OrdinaryKernelCoordinator;
  const external = {
    resumeReadyAttempt: vi.fn(async () => ({ disposition: "idle" as const })),
  } as unknown as KernelExternalBoundaryCoordinator;
  const effects = {
    drainOne: vi.fn(async () => ({ kind: "idle" as const })),
  } as unknown as KernelEffectExecutionService;
  return {
    worker: new KernelWorker({
      attempts,
      ordinary,
      external,
      effects,
      inbox,
      inbox_handler: { handle: handler },
      worker_id: "worker-1",
      lease_seconds: 120,
      cycle_limit: 2,
      now: () => new Date(NOW),
    }),
    complete,
    retry,
    leaseNext,
    attempts,
    ordinary,
    external,
    effects,
    enqueueInboxEvent: (event: KernelInboxEvent) => { next = event; },
  };
}

describe("KernelWorker", () => {
  it("requeues a transient inbox handler failure with bounded backoff", async () => {
    const fixture = workerFixture(async () => { throw new Error("GitHub timed out"); });

    await expect(fixture.worker.runCycle()).resolves.toBe(1);
    expect(fixture.complete).not.toHaveBeenCalled();
    expect(fixture.retry).toHaveBeenCalledWith({
      event_id: "inbox-1",
      owner_id: "worker-1",
      lease_id: expect.stringMatching(/^inbox-/),
      available_at: "2026-08-20T12:00:01.000Z",
    });
    expect(fixture.attempts.leaseNextEligibleAttempt).toHaveBeenCalledOnce();
    expect(fixture.effects.drainOne).toHaveBeenCalledOnce();
    expect(fixture.external.resumeReadyAttempt).toHaveBeenCalledOnce();
  });

  it("completes only an explicit terminal inbox outcome", async () => {
    const fixture = workerFixture(async () => "dead");

    await expect(fixture.worker.runCycle()).resolves.toBe(1);
    expect(fixture.retry).not.toHaveBeenCalled();
    expect(fixture.complete).toHaveBeenCalledWith({
      event_id: "inbox-1",
      owner_id: "worker-1",
      lease_id: expect.stringMatching(/^inbox-/),
      outcome: "dead",
    });
  });

  it("does not redeliver a handled event when completion bookkeeping fails", async () => {
    const fixture = workerFixture(async () => "consumed");
    fixture.complete.mockImplementation(() => { throw new Error("completion database unavailable"); });

    await expect(fixture.worker.runCycle()).resolves.toBe(1);
    expect(fixture.retry).not.toHaveBeenCalled();
    expect(fixture.attempts.leaseNextEligibleAttempt).toHaveBeenCalledOnce();
    expect(fixture.effects.drainOne).toHaveBeenCalledOnce();
    expect(fixture.external.resumeReadyAttempt).toHaveBeenCalledOnce();
  });

  it("keeps other durable queues live when inbox leasing fails", async () => {
    const fixture = workerFixture(async () => "consumed");
    fixture.leaseNext.mockImplementation(() => { throw new Error("unreadable inbox head"); });

    await expect(fixture.worker.runCycle()).resolves.toBe(0);
    expect(fixture.attempts.leaseNextEligibleAttempt).toHaveBeenCalledOnce();
    expect(fixture.effects.drainOne).toHaveBeenCalledOnce();
    expect(fixture.external.resumeReadyAttempt).toHaveBeenCalledOnce();
  });

  it("keeps other durable queues live when retry bookkeeping fails", async () => {
    const fixture = workerFixture(async () => { throw new Error("handler failed"); });
    fixture.retry.mockImplementation(() => { throw new Error("retry database unavailable"); });

    await expect(fixture.worker.runCycle()).resolves.toBe(1);
    expect(fixture.attempts.leaseNextEligibleAttempt).toHaveBeenCalledOnce();
    expect(fixture.effects.drainOne).toHaveBeenCalledOnce();
    expect(fixture.external.resumeReadyAttempt).toHaveBeenCalledOnce();
  });

  it("bounds a repeatedly failing recovered Attempt without redispatching it", async () => {
    const fixture = workerFixture(async () => "consumed");
    const leased = {
      run_id: "run-poison",
      attempt: { id: "attempt-poison" },
      lease: { id: "lease-poison", generation: 2 },
    } as never;
    vi.mocked(fixture.attempts.recoverExpiredAttemptLeases).mockResolvedValue([leased]);
    vi.mocked(fixture.ordinary.executeLeasedAttempt)
      .mockRejectedValue(new Error("runtime reconciliation failed"));
    vi.mocked(fixture.ordinary.terminalizeExhaustedRecovery).mockResolvedValue({
      disposition: "terminal",
      pipeline_run_id: "run-poison",
      attempt_id: "attempt-poison",
      stage_id: "implement",
      run_status: "needs_human",
      next_stage_id: null,
    });

    await expect(fixture.worker.runCycle()).resolves.toBe(2);
    expect(fixture.ordinary.executeLeasedAttempt).toHaveBeenCalledOnce();
    expect(fixture.ordinary.terminalizeExhaustedRecovery).toHaveBeenCalledWith(
      leased,
      expect.objectContaining({ message: "runtime reconciliation failed" }),
    );
    expect(fixture.attempts.leaseNextEligibleAttempt).toHaveBeenCalledOnce();
  });

  it("gives a stop event arriving during work the next cycle before leasing a successor", async () => {
    let stopped = false;
    const stopEvent: KernelInboxEvent = {
      ...inboxEvent(),
      source_provider: "operator",
      kind: "control/stop@1",
      pipeline_run_id: "run-active",
      generation: 4,
      event_group_key: "control:run-active:stop:4",
      payload_schema: "openthrottle.operator-control/v1",
      payload: {
        schema: "openthrottle.operator-control/v1",
        pipeline_run_id: "run-active",
        action: "stop",
        cursor_version: 4,
        reason: "operator requested stop",
      },
    };
    const handle = vi.fn(async (event: KernelInboxEvent) => {
      expect(event).toBe(stopEvent);
      stopped = true;
      return "consumed" as const;
    });
    const fixture = workerFixture(handle, { initial_inbox_event: null });
    const first = {
      run_id: "run-active",
      attempt: { id: "attempt-first" },
      lease: { id: "lease-first", generation: 1 },
    } as never;
    const successor = {
      run_id: "run-active",
      attempt: { id: "attempt-successor" },
      lease: { id: "lease-successor", generation: 1 },
    } as never;
    const available = [first, successor];
    vi.mocked(fixture.attempts.leaseNextEligibleAttempt).mockImplementation(async () => {
      if (stopped) return null;
      return available.shift() ?? null;
    });
    vi.mocked(fixture.ordinary.executeLeasedAttempt).mockImplementation(async (leased) => {
      if (leased === first) {
        fixture.enqueueInboxEvent(stopEvent);
      }
      return {
        disposition: "settled" as const,
        pipeline_run_id: "run-active",
        attempt_id: leased.attempt.id,
        stage_id: "implement",
        run_status: "running" as const,
        next_stage_id: "review",
      };
    });

    await expect(fixture.worker.runCycle()).resolves.toBe(1);
    expect(fixture.attempts.leaseNextEligibleAttempt).toHaveBeenCalledOnce();
    expect(fixture.ordinary.executeLeasedAttempt).toHaveBeenCalledTimes(1);
    expect(fixture.ordinary.executeLeasedAttempt).toHaveBeenCalledWith(first);

    await expect(fixture.worker.runCycle()).resolves.toBe(1);
    expect(handle).toHaveBeenCalledOnce();
    expect(handle.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(fixture.attempts.leaseNextEligibleAttempt).mock.invocationCallOrder[1]!,
    );
    expect(fixture.attempts.leaseNextEligibleAttempt).toHaveBeenCalledTimes(2);
    expect(fixture.ordinary.executeLeasedAttempt).toHaveBeenCalledTimes(1);
    expect(available).toEqual([successor]);
  });
});
