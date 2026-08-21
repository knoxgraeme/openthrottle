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

function workerFixture(handler: () => Promise<"consumed" | "stale" | "dead">) {
  let next: KernelInboxEvent | null = inboxEvent();
  const complete = vi.fn();
  const retry = vi.fn();
  const inbox: KernelInboxDeliveryPort = {
    leaseNext: () => {
      const leased = next;
      next = null;
      return leased;
    },
    complete,
    retry,
    get: () => undefined,
  };
  const attempts = {
    recoverExpiredAttemptLeases: vi.fn(async () => []),
  } as unknown as KernelAttemptLeasePort;
  const ordinary = {
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
    ordinary,
    external,
    effects,
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
    expect(fixture.ordinary.leaseAndExecuteNext).toHaveBeenCalledOnce();
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
});
