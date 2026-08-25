import { randomUUID } from "node:crypto";
import type { KernelInboxDeliveryPort, KernelInboxEvent } from "../persistence/kernel-inbox-store.js";
import type { KernelAttemptLeasePort, LeasedAttemptView } from "../pipeline/kernel/ports.js";
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
  readonly #executionWidth: number;
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
    execution_width: number;
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
    if (!Number.isSafeInteger(input.execution_width) || input.execution_width < 1) {
      throw new Error("execution_width must be a positive integer");
    }
    this.#executionWidth = input.execution_width;
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

  async #executeLeasedAttempt(leased: LeasedAttemptView): Promise<boolean> {
    try {
      const result = await this.#ordinary.executeLeasedAttempt(leased);
      if (result.disposition === "idle") return false;
      if (result.disposition === "external_boundary") {
        await this.#external.executeLeasedAttempt(result.leased);
      }
      return true;
    } catch (error) {
      try {
        return await this.#ordinary.terminalizeExhaustedRecovery(leased, error) !== null;
      } catch {
        return false;
      }
    }
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
      if (await this.#executeLeasedAttempt(leased)) progressed += 1;
    }

    for (let index = 0; index < this.#cycleLimit && !signal?.aborted; index += 1) {
      let result: OrdinaryKernelStep;
      try {
        result = await this.#ordinary.resumeReadyAttempt();
      } catch {
        break;
      }
      if (result.disposition === "idle") break;
      if (result.disposition === "external_boundary") {
        throw new Error("ordinary restart continuation crossed into an external boundary");
      }
      progressed += 1;
    }

    for (let index = 0; index < this.#cycleLimit && !signal?.aborted; index += 1) {
      const inboxFence = this.#fence("inbox");
      let event: KernelInboxEvent | null;
      try {
        event = this.#inbox.leaseNext({
          owner_id: this.#workerId,
          lease_id: inboxFence.lease_id,
          expires_at: inboxFence.expires_at,
        });
      } catch {
        break;
      }
      if (!event) break;
      let outcome: "consumed" | "stale" | "dead";
      try {
        outcome = await this.#inboxHandler.handle(event);
      } catch {
        try {
          this.#inbox.retry({
            event_id: event.id,
            owner_id: this.#workerId,
            lease_id: inboxFence.lease_id,
            available_at: this.#inboxRetryAt(event.version),
          });
        } catch {
          // The expired processing lease remains recoverable; one bad queue must not starve others.
        }
        progressed += 1;
        continue;
      }
      try {
        this.#inbox.complete({
          event_id: event.id,
          owner_id: this.#workerId,
          lease_id: inboxFence.lease_id,
          outcome,
        });
      } catch {
        // Handler success and completion bookkeeping have distinct retry contracts.
      }
      progressed += 1;
    }

    // Fresh Attempts may run long enough for a control event to arrive. Lease
    // one fixed cross-run batch, then yield so the next cycle traverses the
    // durable inbox before any newly eligible successor can start.
    if (this.#cycleLimit > 0 && !signal?.aborted) {
      const leasedAttempts: LeasedAttemptView[] = [];
      for (let index = 0; index < this.#executionWidth && !signal?.aborted; index += 1) {
        const attemptFence = this.#fence("attempt");
        let leased: Awaited<ReturnType<KernelAttemptLeasePort["leaseNextEligibleAttempt"]>>;
        try {
          leased = await this.#attempts.leaseNextEligibleAttempt({
            worker_id: this.#workerId,
            lease_id: attemptFence.lease_id,
            expires_at: attemptFence.expires_at,
          });
        } catch {
          break;
        }
        if (!leased) break;
        leasedAttempts.push(leased);
      }
      const executions = await Promise.all(
        leasedAttempts.map((leased) => this.#executeLeasedAttempt(leased)),
      );
      progressed += executions.filter(Boolean).length;
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
