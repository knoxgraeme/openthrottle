import type { KernelInboxEvent } from "../persistence/kernel-inbox-store.js";

const DEFAULT_MAX_CONCURRENCY = 4;

export interface KernelLinearSessionStartRequest {
  inbox_event_id: string;
  webhook_id: string;
  session_id: string;
}

/**
 * A narrow application-owned boundary for satisfying Linear's AgentSession
 * start acknowledgement before normal inbox processing continues.
 */
export interface KernelLinearSessionStartPort {
  ensureStarted(input: Readonly<KernelLinearSessionStartRequest>): Promise<void>;
}

export interface KernelLinearSessionStartWakePort {
  wake(event: KernelInboxEvent): boolean;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Derive the stable provider request from the durable event. Both the HTTP
 * fast path and inbox recovery use this one parser.
 */
export function kernelLinearSessionStartRequest(
  event: KernelInboxEvent,
): KernelLinearSessionStartRequest | null {
  if (
    event.source_provider !== "linear" ||
    event.kind !== "linear/agent-session-event/created@1"
  ) return null;
  const payload = object(event.payload);
  const session = object(payload?.agentSession);
  if (typeof payload?.webhookId !== "string" || payload.webhookId.length === 0) {
    throw new Error("Linear created event has no webhook identity");
  }
  if (typeof session?.id !== "string" || session.id.length === 0) {
    throw new Error("Linear created event has no AgentSession identity");
  }
  return {
    inbox_event_id: event.id,
    webhook_id: payload.webhookId,
    session_id: session.id,
  };
}

/**
 * Runs the timing-critical Linear handshake independently of the serial kernel
 * worker. Fast-path wakes never queue when saturated; the durable handler can
 * wait for capacity and remains the retry authority.
 */
export class KernelLinearSessionStartDispatcher implements
  KernelLinearSessionStartPort,
  KernelLinearSessionStartWakePort {
  readonly #downstream: KernelLinearSessionStartPort;
  readonly #maxConcurrency: number;
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #waiters: Array<() => void> = [];
  #active = 0;

  constructor(input: {
    downstream: KernelLinearSessionStartPort;
    max_concurrency?: number;
  }) {
    this.#downstream = input.downstream;
    this.#maxConcurrency = input.max_concurrency ?? DEFAULT_MAX_CONCURRENCY;
    if (
      !Number.isSafeInteger(this.#maxConcurrency) ||
      this.#maxConcurrency < 1 || this.#maxConcurrency > 64
    ) throw new Error("Linear session-start concurrency must be between 1 and 64");
  }

  ensureStarted(input: Readonly<KernelLinearSessionStartRequest>): Promise<void> {
    const key = this.#key(input);
    const existing = this.#inFlight.get(key);
    if (existing) return existing;
    return this.#track(key, this.#runQueued(input));
  }

  wake(event: KernelInboxEvent): boolean {
    let request: KernelLinearSessionStartRequest | null;
    try {
      request = kernelLinearSessionStartRequest(event);
    } catch {
      return false;
    }
    if (!request) return false;
    const key = this.#key(request);
    const existing = this.#inFlight.get(key);
    if (existing) {
      void existing.catch(() => {});
      return true;
    }
    if (!this.#tryAcquire()) return false;
    const task = this.#track(key, this.#runAcquired(request));
    void task.catch(() => {});
    return true;
  }

  #key(input: Readonly<KernelLinearSessionStartRequest>): string {
    return JSON.stringify([input.inbox_event_id, input.webhook_id, input.session_id]);
  }

  #track(key: string, task: Promise<void>): Promise<void> {
    this.#inFlight.set(key, task);
    void task.then(
      () => {
        if (this.#inFlight.get(key) === task) this.#inFlight.delete(key);
      },
      () => {
        if (this.#inFlight.get(key) === task) this.#inFlight.delete(key);
      },
    );
    return task;
  }

  async #runQueued(input: Readonly<KernelLinearSessionStartRequest>): Promise<void> {
    await this.#acquire();
    await this.#runAcquired(input);
  }

  async #runAcquired(input: Readonly<KernelLinearSessionStartRequest>): Promise<void> {
    try {
      await this.#downstream.ensureStarted(input);
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    if (this.#tryAcquire()) return;
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  #tryAcquire(): boolean {
    if (this.#active >= this.#maxConcurrency) return false;
    this.#active += 1;
    return true;
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next) {
      next();
      return;
    }
    this.#active -= 1;
  }
}
