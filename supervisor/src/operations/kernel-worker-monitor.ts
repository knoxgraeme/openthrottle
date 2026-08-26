import { sanitizeText } from "../shared/sanitize.js";
import type {
  KernelWorkerHealthPort,
  KernelWorkerHealthSnapshot,
} from "../shared/kernel-worker-health.js";

export const KERNEL_WORKER_STALE_AFTER_MS = 120_000;
const DEFAULT_REPEATED_FAILURE_LOG_INTERVAL = 60;

interface KernelWorkerCyclePort {
  runCycle(signal?: AbortSignal, onActivity?: () => void): Promise<number>;
}

interface KernelWorkerErrorLogger {
  error(message: string): void;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function isSqliteFull(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const code = errorCode(current);
    const message = current instanceof Error ? current.message : "";
    if (code === "SQLITE_FULL" || /\bSQLITE_FULL\b|database or disk is full/i.test(message)) {
      return true;
    }
    current = Reflect.get(current, "cause");
  }
  return false;
}

function errorCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  const cause = code && !message.includes(code) ? `${code}: ${message}` : message;
  return sanitizeText(cause).replace(/\s+/g, " ").slice(0, 1_500) || "unknown error";
}

export class KernelWorkerMonitor implements KernelWorkerHealthPort {
  readonly #worker: KernelWorkerCyclePort;
  readonly #now: () => Date;
  readonly #startedAtMs: number;
  readonly #staleAfterMs: number;
  readonly #repeatedFailureLogInterval: number;
  readonly #logger: KernelWorkerErrorLogger;
  #lastSuccessfulCycleAt: Date | null = null;
  #lastSuccessfulActivityAt: Date | null = null;
  #consecutiveFailures = 0;
  #diskFullDuringFailureStreak = false;

  constructor(input: {
    worker: KernelWorkerCyclePort;
    now?: () => Date;
    stale_after_ms?: number;
    repeated_failure_log_interval?: number;
    logger?: KernelWorkerErrorLogger;
  }) {
    this.#worker = input.worker;
    this.#now = input.now ?? (() => new Date());
    this.#startedAtMs = this.#now().getTime();
    this.#staleAfterMs = input.stale_after_ms ?? KERNEL_WORKER_STALE_AFTER_MS;
    this.#repeatedFailureLogInterval = input.repeated_failure_log_interval
      ?? DEFAULT_REPEATED_FAILURE_LOG_INTERVAL;
    this.#logger = input.logger ?? console;
    if (!Number.isSafeInteger(this.#staleAfterMs) || this.#staleAfterMs < 1) {
      throw new Error("stale_after_ms must be a positive integer");
    }
    if (
      !Number.isSafeInteger(this.#repeatedFailureLogInterval)
      || this.#repeatedFailureLogInterval < 1
    ) {
      throw new Error("repeated_failure_log_interval must be a positive integer");
    }
  }

  async runCycle(signal?: AbortSignal): Promise<void> {
    const previousActivityAt = this.#lastSuccessfulActivityAt;
    try {
      await this.#worker.runCycle(signal, () => {
        this.#lastSuccessfulActivityAt = this.#now();
      });
      const completedAt = this.#now();
      this.#lastSuccessfulCycleAt = completedAt;
      this.#lastSuccessfulActivityAt = completedAt;
      this.#consecutiveFailures = 0;
      this.#diskFullDuringFailureStreak = false;
    } catch (error) {
      this.#lastSuccessfulActivityAt = previousActivityAt;
      this.#consecutiveFailures += 1;
      const diskFull = isSqliteFull(error);
      const firstDiskFull = diskFull && !this.#diskFullDuringFailureStreak;
      this.#diskFullDuringFailureStreak ||= diskFull;
      if (
        this.#consecutiveFailures === 1
        || this.#consecutiveFailures % this.#repeatedFailureLogInterval === 0
        || firstDiskFull
      ) {
        const condition = diskFull ? "disk_full" : "cycle_failure";
        this.#logger.error(
          `[kernel-worker] cycle failed (consecutive_failures=${this.#consecutiveFailures}, `
          + `condition=${condition}): ${errorCause(error)}`,
        );
      }
    }
  }

  snapshot(): KernelWorkerHealthSnapshot {
    const referenceMs = this.#lastSuccessfulActivityAt?.getTime() ?? this.#startedAtMs;
    const stale = this.#now().getTime() - referenceMs > this.#staleAfterMs;
    const unhealthy = this.#diskFullDuringFailureStreak || stale;
    let status: KernelWorkerHealthSnapshot["worker"]["status"] = "starting";
    if (unhealthy) status = "unhealthy";
    else if (this.#consecutiveFailures > 0) status = "degraded";
    else if (this.#lastSuccessfulActivityAt) status = "healthy";
    const worker = {
      status,
      lastSuccessfulCycleAt: this.#lastSuccessfulCycleAt?.toISOString() ?? null,
      consecutiveFailures: this.#consecutiveFailures,
      staleAfterSeconds: this.#staleAfterMs / 1_000,
    };
    if (this.#diskFullDuringFailureStreak) {
      return { ok: false, condition: "disk_full", message: "disk full", worker };
    }
    if (stale) {
      return {
        ok: false,
        condition: "worker_stalled",
        message: "kernel worker has not completed a cycle within the liveness threshold",
        worker,
      };
    }
    return { ok: true, worker };
  }
}
