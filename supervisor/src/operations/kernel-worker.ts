import { randomUUID } from "node:crypto";
import type { KernelInboxDeliveryPort, KernelInboxEvent } from "../persistence/kernel-inbox-store.js";
import type { KernelAttemptLeasePort } from "../pipeline/kernel/ports.js";
import type { OrdinaryKernelCoordinator, OrdinaryKernelStep } from "../pipeline/kernel/ordinary-coordinator.js";
import type { KernelExternalBoundaryCoordinator } from "./kernel-external-boundary.js";
import type { KernelEffectExecutionService } from "./kernel-effects.js";

export interface KernelInboxHandler {
  handle(event: KernelInboxEvent): Promise<"consumed" | "stale" | "dead">;
}

export class KernelWorker {
  readonly #attempts: KernelAttemptLeasePort;
  readonly #ordinary: OrdinaryKernelCoordinator;
  readonly #external: KernelExternalBoundaryCoordinator;
  readonly #effects: KernelEffectExecutionService;
  readonly #inbox: KernelInboxDeliveryPort;
  readonly #inboxHandler: KernelInboxHandler;
  readonly #workerId: string;
  readonly #leaseMs: number;
  readonly #cycleLimit: number;
  readonly #now: () => Date;

  constructor(input: {
    attempts: KernelAttemptLeasePort;
    ordinary: OrdinaryKernelCoordinator;
    external: KernelExternalBoundaryCoordinator;
    effects: KernelEffectExecutionService;
    inbox: KernelInboxDeliveryPort;
    inbox_handler: KernelInboxHandler;
    worker_id: string;
    lease_seconds: number;
    cycle_limit: number;
    now?: () => Date;
  }) {
    this.#attempts = input.attempts;
    this.#ordinary = input.ordinary;
    this.#external = input.external;
    this.#effects = input.effects;
    this.#inbox = input.inbox;
    this.#inboxHandler = input.inbox_handler;
    this.#workerId = input.worker_id;
    this.#leaseMs = input.lease_seconds * 1_000;
    this.#cycleLimit = input.cycle_limit;
    this.#now = input.now ?? (() => new Date());
  }

  #fence(prefix: string) {
    const observed = this.#now();
    return {
      lease_id: `${prefix}-${randomUUID()}`,
      expires_at: new Date(observed.getTime() + this.#leaseMs).toISOString(),
      observed_at: observed.toISOString(),
    };
  }

  #inboxRetryAt(version: number): string {
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error("leased inbox event has an invalid version");
    }
    const delayMs = Math.min(1_000 * (2 ** Math.min(version - 1, 8)), 5 * 60_000);
    return new Date(this.#now().getTime() + delayMs).toISOString();
  }

  async #executeAttempt(step: Promise<OrdinaryKernelStep>): Promise<boolean> {
    const result = await step;
    if (result.disposition === "idle") return false;
    if (result.disposition === "external_boundary") {
      await this.#external.executeLeasedAttempt(result.leased);
    }
    return true;
  }

  /** Performs a bounded fair pass. Every durable queue gets progress opportunity. */
  async runCycle(signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) return 0;
    let progressed = 0;
    const recoveryFence = this.#fence("attempt-recovery");
    const recovered = await this.#attempts.recoverExpiredAttemptLeases({
      observed_at: recoveryFence.observed_at,
      expires_at: recoveryFence.expires_at,
      limit: this.#cycleLimit,
    });
    for (const leased of recovered) {
      if (signal?.aborted) return progressed;
      if (await this.#executeAttempt(this.#ordinary.executeLeasedAttempt(leased))) progressed += 1;
    }

    for (let index = 0; index < this.#cycleLimit && !signal?.aborted; index += 1) {
      const inboxFence = this.#fence("inbox");
      const event = this.#inbox.leaseNext({
        owner_id: this.#workerId,
        lease_id: inboxFence.lease_id,
        expires_at: inboxFence.expires_at,
      });
      if (!event) break;
      try {
        const outcome = await this.#inboxHandler.handle(event);
        this.#inbox.complete({
          event_id: event.id,
          owner_id: this.#workerId,
          lease_id: inboxFence.lease_id,
          outcome,
        });
      } catch {
        this.#inbox.retry({
          event_id: event.id,
          owner_id: this.#workerId,
          lease_id: inboxFence.lease_id,
          available_at: this.#inboxRetryAt(event.version),
        });
      }
      progressed += 1;
    }

    for (let index = 0; index < this.#cycleLimit && !signal?.aborted; index += 1) {
      const attemptFence = this.#fence("attempt");
      const didWork = await this.#executeAttempt(this.#ordinary.leaseAndExecuteNext({
        worker_id: this.#workerId,
        lease_id: attemptFence.lease_id,
        expires_at: attemptFence.expires_at,
      }));
      if (!didWork) break;
      progressed += 1;
    }

    for (let index = 0; index < this.#cycleLimit && !signal?.aborted; index += 1) {
      const effectFence = this.#fence("effect");
      const result = await this.#effects.drainOne({
        worker_id: this.#workerId,
        lease_id: effectFence.lease_id,
        expires_at: effectFence.expires_at,
        ...(signal ? { signal } : {}),
      });
      if (result.kind === "idle") break;
      progressed += 1;
    }

    for (let index = 0; index < this.#cycleLimit && !signal?.aborted; index += 1) {
      const result = await this.#external.resumeReadyAttempt();
      if (result.disposition === "idle") break;
      progressed += 1;
      if (result.disposition === "waiting") break;
    }
    return progressed;
  }
}
