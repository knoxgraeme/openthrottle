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
import { KernelWorkerMonitor } from "./kernel-worker-monitor.js";

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
  options: { initial_inbox_event?: KernelInboxEvent | null; execution_width?: number } = {},
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
      execution_width: options.execution_width ?? 1,
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
  it("marks repeated SQLITE_FULL cycle failures unhealthy and rate-limits error logs", async () => {
    const fixture = workerFixture(async () => "consumed");
    const sqliteFull = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    vi.mocked(fixture.attempts.recoverExpiredAttemptLeases).mockRejectedValue(sqliteFull);
    const error = vi.fn();
    const monitor = new KernelWorkerMonitor({
      worker: fixture.worker,
      now: () => new Date(NOW),
      repeated_failure_log_interval: 3,
      logger: { error },
    });

    await monitor.runCycle();
    expect(monitor.snapshot()).toMatchObject({
      ok: false,
      condition: "disk_full",
      message: "disk full",
      worker: { status: "unhealthy", consecutiveFailures: 1 },
    });
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining(
      "consecutive_failures=1, condition=disk_full): SQLITE_FULL: database or disk is full",
    ));

    await monitor.runCycle();
    expect(error).toHaveBeenCalledOnce();
    await monitor.runCycle();
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining("consecutive_failures=3"));
  });

  it("keeps successful cycles healthy and marks a frozen worker stale after the threshold", async () => {
    const fixture = workerFixture(async () => "consumed", { initial_inbox_event: null });
    let now = new Date(NOW);
    const monitor = new KernelWorkerMonitor({
      worker: fixture.worker,
      now: () => now,
      stale_after_ms: 120_000,
    });

    await monitor.runCycle();
    now = new Date("2026-08-20T12:02:00.000Z");
    expect(monitor.snapshot()).toMatchObject({ ok: true, worker: { status: "healthy" } });

    now = new Date("2026-08-20T12:02:00.001Z");
    expect(monitor.snapshot()).toMatchObject({
      ok: false,
      condition: "worker_stalled",
      worker: { status: "unhealthy", lastSuccessfulCycleAt: NOW },
    });
  });

  it("keeps an actively heartbeating long-running cycle healthy", async () => {
    let now = new Date(NOW);
    let cycleCount = 0;
    let reportActivity: (() => void) | undefined;
    let finishLongCycle: (() => void) | undefined;
    const longCycleFinished = new Promise<void>((resolve) => {
      finishLongCycle = resolve;
    });
    const monitor = new KernelWorkerMonitor({
      worker: {
        async runCycle(_signal?: AbortSignal, onActivity?: () => void) {
          cycleCount += 1;
          if (cycleCount === 1) return 0;
          reportActivity = onActivity;
          await longCycleFinished;
          return 1;
        },
      },
      now: () => now,
      stale_after_ms: 120_000,
    });

    await monitor.runCycle();
    now = new Date("2026-08-20T12:02:00.001Z");
    const longCycle = monitor.runCycle();
    reportActivity!();

    now = new Date("2026-08-20T12:04:00.001Z");
    expect(monitor.snapshot()).toMatchObject({
      ok: true,
      worker: { status: "healthy", lastSuccessfulCycleAt: NOW },
    });

    finishLongCycle!();
    await longCycle;
  });

  it("does not let activity from a failed cycle refresh successful-cycle liveness", async () => {
    let now = new Date(NOW);
    let cycleCount = 0;
    const monitor = new KernelWorkerMonitor({
      worker: {
        async runCycle(_signal?: AbortSignal, onActivity?: () => void) {
          cycleCount += 1;
          onActivity?.();
          if (cycleCount > 1) throw new Error("late cycle failure");
          return 1;
        },
      },
      now: () => now,
      stale_after_ms: 120_000,
    });

    await monitor.runCycle();
    now = new Date("2026-08-20T12:01:00.000Z");
    await monitor.runCycle();

    now = new Date("2026-08-20T12:02:00.001Z");
    expect(monitor.snapshot()).toMatchObject({
      ok: false,
      condition: "worker_stalled",
      worker: { status: "unhealthy", lastSuccessfulCycleAt: NOW, consecutiveFailures: 1 },
    });
  });

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

  it("executes a width-two cross-run batch concurrently and counts interleaved settlements", async () => {
    const fixture = workerFixture(async () => "consumed", {
      initial_inbox_event: null,
      execution_width: 2,
    });
    const first = {
      run_id: "run-1",
      attempt: { id: "attempt-1" },
      lease: { id: "lease-1", generation: 0 },
    } as never;
    const second = {
      run_id: "run-2",
      attempt: { id: "attempt-2" },
      lease: { id: "lease-2", generation: 0 },
    } as never;
    const available = [first, second];
    vi.mocked(fixture.attempts.leaseNextEligibleAttempt)
      .mockImplementation(async () => available.shift() ?? null);
    const releases = new Map<string, () => void>();
    const settlementOrder: string[] = [];
    vi.mocked(fixture.ordinary.executeLeasedAttempt).mockImplementation(async (leased) => {
      await new Promise<void>((resolve) => releases.set(leased.attempt.id, resolve));
      settlementOrder.push(leased.attempt.id);
      return {
        disposition: "settled" as const,
        pipeline_run_id: leased.run_id,
        attempt_id: leased.attempt.id,
        stage_id: "implement",
        run_status: "completed" as const,
        next_stage_id: null,
      };
    });

    const cycle = fixture.worker.runCycle();
    await vi.waitFor(() => expect(fixture.ordinary.executeLeasedAttempt).toHaveBeenCalledTimes(2));
    releases.get("attempt-2")!();
    await vi.waitFor(() => expect(settlementOrder).toEqual(["attempt-2"]));
    releases.get("attempt-1")!();

    await expect(cycle).resolves.toBe(2);
    expect(settlementOrder).toEqual(["attempt-2", "attempt-1"]);
    expect(fixture.attempts.leaseNextEligibleAttempt).toHaveBeenCalledTimes(2);
  });
});
