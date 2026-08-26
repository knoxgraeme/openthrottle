import type Database from "better-sqlite3";
import {
  validateEffectIntent,
  type BlobPointer,
  type EffectIntent,
  type ExecutionRecord,
} from "@openthrottle/contracts";
import type { EffectReconciliation } from "../pipeline/kernel/effect-intent.js";
import type {
  AttemptLeaseRequest,
  LeasedAttemptView,
  LeasedEffectView,
} from "../pipeline/kernel/ports.js";
import type { KernelAttempt, KernelRun } from "../pipeline/kernel/types.js";
import {
  attemptFromRow,
  parseJson,
  payloadPointer,
  type AttemptRow,
  type EffectRow,
} from "./kernel-store-codecs.js";

const EXPIRED_EFFECT_RECOVERY_BATCH_SIZE = 100;

export class KernelLeaseOperations {
  readonly #db: Database.Database;
  readonly #now: () => string;
  readonly #attemptById: (id: string, runId: string) => KernelAttempt;
  readonly #advanceRunFence: (runId: string, transitionId: string, content: unknown) => KernelRun;
  readonly #insertRecord: (record: ExecutionRecord) => void;
  readonly #readEffectBlob: (runId: string, ownerId: string, pointer: BlobPointer) => Buffer;
  readonly #executionWidth: number;

  constructor(input: {
    db: Database.Database;
    now: () => string;
    attempt_by_id: (id: string, runId: string) => KernelAttempt;
    advance_run_fence: (runId: string, transitionId: string, content: unknown) => KernelRun;
    insert_record: (record: ExecutionRecord) => void;
    read_effect_blob: (runId: string, ownerId: string, pointer: BlobPointer) => Buffer;
    execution_policy: { readonly max_concurrent_attempts: 1 };
    execution_width: number;
  }) {
    this.#db = input.db;
    this.#now = input.now;
    this.#attemptById = input.attempt_by_id;
    this.#advanceRunFence = input.advance_run_fence;
    this.#insertRecord = input.insert_record;
    this.#readEffectBlob = input.read_effect_blob;
    const maxConcurrentAttempts = input.execution_policy.max_concurrent_attempts;
    if (!Object.isFrozen(input.execution_policy) || maxConcurrentAttempts !== 1) {
      throw new Error("Attempt lease policy must be frozen at the supported release limit 1");
    }
    if (!Number.isSafeInteger(input.execution_width) || input.execution_width < 1) {
      throw new Error("Attempt execution width must be a positive integer");
    }
    this.#executionWidth = input.execution_width;
  }

  async leaseNextEligibleAttempt(request: AttemptLeaseRequest): Promise<LeasedAttemptView | null> {
    return this.#db.transaction(() => {
      const now = this.#now();
      const replay = this.#db.prepare(`
        SELECT a.*, r.version AS run_version, r.cursor_version
        FROM attempts a JOIN pipeline_runs r ON r.id = a.pipeline_run_id
        WHERE a.lease_id = ?
      `).get(request.lease_id) as (AttemptRow & {
        run_version: number;
        cursor_version: number;
      }) | undefined;
      if (replay) {
        if (
          replay.lease_worker_id !== request.worker_id ||
          replay.lease_expires_at !== request.expires_at
        ) throw new Error(`attempt lease ${request.lease_id} conflicts with its immutable replay`);
        const attempt = attemptFromRow(replay);
        return {
          run_id: replay.pipeline_run_id,
          run_version: replay.run_version,
          cursor_version: replay.cursor_version,
          attempt,
          lease: attempt.lease!,
        };
      }
      const row = this.#db.prepare(`
        WITH live_attempts AS (
          SELECT pipeline_run_id FROM attempts WHERE lease_id IS NOT NULL
        ), sandbox_reservations AS (
          SELECT DISTINCT runtime_create.pipeline_run_id
          FROM effects runtime_create
          JOIN pipeline_runs r ON r.id = runtime_create.pipeline_run_id
          WHERE r.status IN ('pending', 'running')
            AND runtime_create.kind = 'daytona/create-sandbox@1'
            AND runtime_create.status IN ('pending', 'processing', 'unknown', 'acknowledged')
            AND NOT EXISTS (
              SELECT 1 FROM effects runtime_cleanup
              WHERE runtime_cleanup.pipeline_run_id = runtime_create.pipeline_run_id
                AND runtime_cleanup.kind = 'daytona/cleanup-sandbox@1'
                AND runtime_cleanup.status = 'acknowledged'
            )
        ), sandbox_slots AS (
          SELECT pipeline_run_id FROM live_attempts
          UNION
          SELECT pipeline_run_id FROM sandbox_reservations
        )
        SELECT a.* FROM attempts a
        JOIN pipeline_runs r ON r.id = a.pipeline_run_id
        WHERE r.status IN ('pending', 'running')
          AND a.status IN ('pending', 'result_pending')
          AND a.unmet_dependency_count = 0
          AND a.lease_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM live_attempts live
            WHERE live.pipeline_run_id = a.pipeline_run_id
          )
          AND (SELECT COUNT(*) FROM live_attempts) < ?
          AND (
            EXISTS (
              SELECT 1 FROM sandbox_reservations reserved
              WHERE reserved.pipeline_run_id = a.pipeline_run_id
            )
            OR (SELECT COUNT(*) FROM sandbox_slots) < ?
          )
        ORDER BY a.created_at, a.id
        LIMIT 1
      `).get(this.#executionWidth, this.#executionWidth) as AttemptRow | undefined;
      if (!row) return null;
      const purpose = row.status === "result_pending" ? "result_correction" : "work";
      const changed = this.#db.prepare(`
        UPDATE attempts
        SET lease_id = ?, lease_worker_id = ?, lease_purpose = ?, lease_expires_at = ?,
            lease_generation = 0, lease_started = 0, version = version + 1,
            result_correction_count = result_correction_count + ?, updated_at = ?
        WHERE id = ? AND pipeline_run_id = ? AND version = ? AND lease_id IS NULL
          AND unmet_dependency_count = 0
      `).run(
        request.lease_id,
        request.worker_id,
        purpose,
        request.expires_at,
        purpose === "result_correction" ? 1 : 0,
        now,
        row.id,
        row.pipeline_run_id,
        row.version,
      );
      if (changed.changes !== 1) throw new Error(`attempt ${row.id} lease compare-and-set failed`);
      const run = this.#advanceRunFence(row.pipeline_run_id, `attempt-lease:${request.lease_id}`, {
        attempt_id: row.id,
        lease_id: request.lease_id,
        generation: 0,
        worker_id: request.worker_id,
        expires_at: request.expires_at,
      });
      const attempt = this.#attemptById(row.id, row.pipeline_run_id);
      return {
        run_id: run.id,
        run_version: run.version,
        cursor_version: run.cursor.version,
        attempt,
        lease: attempt.lease!,
      };
    }).immediate();
  }

  async renewAttemptLease(input: {
    attempt_id: string;
    lease_id: string;
    lease_generation: number;
    worker_id: string;
    expires_at: string;
  }): Promise<NonNullable<KernelAttempt["lease"]>> {
    return this.#db.transaction(() => {
      const row = this.#db.prepare("SELECT * FROM attempts WHERE id = ?")
        .get(input.attempt_id) as AttemptRow | undefined;
      if (
        !row || row.lease_id !== input.lease_id ||
        row.lease_generation !== input.lease_generation ||
        row.lease_worker_id !== input.worker_id
      ) throw new Error("attempt lease fence does not match");
      const changed = this.#db.prepare(`
        UPDATE attempts SET lease_expires_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND lease_id = ? AND lease_generation = ?
          AND lease_worker_id = ? AND version = ?
      `).run(
        input.expires_at,
        this.#now(),
        row.id,
        input.lease_id,
        input.lease_generation,
        input.worker_id,
        row.version,
      );
      if (changed.changes !== 1) throw new Error("attempt lease renewal compare-and-set failed");
      this.#advanceRunFence(row.pipeline_run_id, `attempt-renew:${input.lease_id}:${row.version + 1}`, input);
      return this.#attemptById(row.id, row.pipeline_run_id).lease!;
    }).immediate();
  }

  async recoverExpiredAttemptLeases(input: {
    observed_at: string;
    expires_at: string;
    limit: number;
  }): Promise<readonly LeasedAttemptView[]> {
    const observedMs = Date.parse(input.observed_at);
    const expiresMs = Date.parse(input.expires_at);
    if (
      !Number.isFinite(observedMs) || new Date(observedMs).toISOString() !== input.observed_at ||
      !Number.isFinite(expiresMs) || new Date(expiresMs).toISOString() !== input.expires_at ||
      expiresMs <= observedMs
    ) throw new Error("attempt lease recovery timestamps are invalid");
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error("attempt lease recovery limit must be between 1 and 100");
    }
    return this.#db.transaction(() => {
      const duplicateRun = this.#db.prepare(`
        SELECT pipeline_run_id, COUNT(*) AS count FROM attempts
        WHERE lease_id IS NOT NULL
        GROUP BY pipeline_run_id HAVING COUNT(*) > 1
        ORDER BY pipeline_run_id LIMIT 1
      `).get() as { pipeline_run_id: string; count: number } | undefined;
      if (duplicateRun) {
        throw new Error(
          `Attempt lease recovery found ${duplicateRun.count} live leases for run ` +
          duplicateRun.pipeline_run_id,
        );
      }
      const rows = this.#db.prepare(`
        SELECT * FROM attempts
        WHERE lease_id IS NOT NULL AND lease_expires_at <= ?
          AND status IN ('pending', 'running', 'result_pending')
        ORDER BY lease_expires_at, pipeline_run_id, id
        LIMIT ?
      `).all(input.observed_at, input.limit) as AttemptRow[];
      const recovered: LeasedAttemptView[] = [];
      for (const row of rows) {
        const changed = this.#db.prepare(`
          UPDATE attempts SET lease_expires_at = ?, lease_generation = lease_generation + 1,
            version = version + 1, updated_at = ?
          WHERE id = ? AND pipeline_run_id = ? AND version = ?
            AND lease_id = ? AND lease_generation = ?
            AND lease_worker_id = ? AND lease_expires_at = ?
        `).run(
          input.expires_at,
          input.observed_at,
          row.id,
          row.pipeline_run_id,
          row.version,
          row.lease_id,
          row.lease_generation,
          row.lease_worker_id,
          row.lease_expires_at,
        );
        if (changed.changes !== 1) {
          throw new Error(`expired attempt lease ${row.lease_id} compare-and-set failed`);
        }
        const run = this.#advanceRunFence(
          row.pipeline_run_id,
          `attempt-recover:${row.lease_id}:${row.version + 1}`,
          {
            attempt_id: row.id,
            lease_id: row.lease_id,
            prior_generation: row.lease_generation,
            generation: row.lease_generation! + 1,
            worker_id: row.lease_worker_id,
            prior_expires_at: row.lease_expires_at,
            expires_at: input.expires_at,
          },
        );
        const attempt = this.#attemptById(row.id, row.pipeline_run_id);
        recovered.push({
          run_id: run.id,
          run_version: run.version,
          cursor_version: run.cursor.version,
          attempt,
          lease: attempt.lease!,
        });
      }
      return recovered;
    }).immediate();
  }

  async leaseNextEffect(input: {
    worker_id: string;
    lease_id: string;
    expires_at: string;
  }): Promise<LeasedEffectView | null> {
    return this.#db.transaction(() => {
      const now = this.#now();
      this.#recoverExpiredEffectLeases(now);
      const replay = this.#db.prepare("SELECT * FROM effects WHERE lease_id = ?")
        .get(input.lease_id) as EffectRow | undefined;
      if (replay) {
        if (
          replay.lease_worker_id !== input.worker_id || replay.lease_expires_at !== input.expires_at
        ) throw new Error(`effect lease ${input.lease_id} conflicts with its immutable replay`);
        return {
          intent: this.effectIntentFromRow(replay),
          lease_id: input.lease_id,
          expires_at: input.expires_at,
          execution_mode: replay.lease_execution_mode!,
          reconciliation_ordinal: replay.attempt_count,
          dispatch_fence: replay.dispatch_lease_id === null ? null : {
            lease_id: replay.dispatch_lease_id,
            worker_id: replay.dispatch_worker_id!,
          },
        };
      }
      const row = this.#db.prepare(`
        SELECT e.* FROM effects e
        JOIN pipeline_runs r ON r.id = e.pipeline_run_id
        WHERE r.status IN ('pending', 'running')
          AND e.status IN ('pending', 'unknown')
          AND e.lease_id IS NULL AND e.available_at <= ?
        ORDER BY e.available_at, e.id
        LIMIT 1
      `).get(now) as EffectRow | undefined;
      if (!row) return null;
      const executionMode: LeasedEffectView["execution_mode"] = row.dispatch_lease_id !== null
        ? "reconcile_only"
        : "dispatch_or_reconcile";
      const changed = this.#db.prepare(`
        UPDATE effects
        SET status = 'processing', lease_id = ?, lease_worker_id = ?, lease_expires_at = ?,
            lease_execution_mode = ?, unknown_detail = NULL, attempt_count = attempt_count + 1,
            version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND lease_id IS NULL AND status IN ('pending', 'unknown')
      `).run(input.lease_id, input.worker_id, input.expires_at, executionMode, now, row.id, row.version);
      if (changed.changes !== 1) throw new Error(`effect ${row.id} lease compare-and-set failed`);
      this.#advanceRunFence(row.pipeline_run_id, `effect-lease:${input.lease_id}`, {
        effect_id: row.id,
        worker_id: input.worker_id,
        expires_at: input.expires_at,
      });
      return {
        intent: this.effectIntentFromRow(row),
        lease_id: input.lease_id,
        expires_at: input.expires_at,
        execution_mode: executionMode,
        reconciliation_ordinal: row.attempt_count + 1,
        dispatch_fence: row.dispatch_lease_id === null ? null : {
          lease_id: row.dispatch_lease_id,
          worker_id: row.dispatch_worker_id!,
        },
      };
    }).immediate();
  }

  async markLeasedEffectDispatchStarted(input: {
    effect_id: string;
    lease_id: string;
    worker_id: string;
  }): Promise<LeasedEffectView> {
    return this.#db.transaction(() => {
      const row = this.#db.prepare("SELECT * FROM effects WHERE id = ?")
        .get(input.effect_id) as EffectRow | undefined;
      if (
        !row || row.status !== "processing" || row.lease_id !== input.lease_id ||
        row.lease_worker_id !== input.worker_id || row.lease_execution_mode === null ||
        row.lease_expires_at === null
      ) throw new Error("effect lease fence does not match");
      if (row.lease_execution_mode === "dispatch_or_reconcile") {
        const changed = this.#db.prepare(`
          UPDATE effects
          SET lease_execution_mode = 'reconcile_only', dispatch_lease_id = ?,
              dispatch_worker_id = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? AND status = 'processing' AND lease_id = ?
            AND lease_worker_id = ? AND lease_execution_mode = 'dispatch_or_reconcile'
        `).run(input.lease_id, input.worker_id, this.#now(), row.id, row.version, input.lease_id, input.worker_id);
        if (changed.changes !== 1) throw new Error("effect dispatch-start compare-and-set failed");
        this.#advanceRunFence(row.pipeline_run_id, `effect-dispatch-started:${input.lease_id}`, input);
      }
      return {
        intent: this.effectIntentFromRow(row),
        lease_id: input.lease_id,
        expires_at: row.lease_expires_at,
        execution_mode: "reconcile_only" as const,
        reconciliation_ordinal: row.attempt_count,
        dispatch_fence: row.dispatch_lease_id === null ? {
          lease_id: input.lease_id,
          worker_id: input.worker_id,
        } : {
          lease_id: row.dispatch_lease_id,
          worker_id: row.dispatch_worker_id!,
        },
      };
    }).immediate();
  }

  async completeLeasedEffect(input: {
    effect_id: string;
    lease_id: string;
    worker_id: string;
    reconciliation: EffectReconciliation;
  }): Promise<void> {
    this.#db.transaction(() => {
      const row = this.#db.prepare("SELECT * FROM effects WHERE id = ?").get(input.effect_id) as EffectRow | undefined;
      if (
        !row || row.status !== "processing" || row.lease_id !== input.lease_id ||
        row.lease_worker_id !== input.worker_id
      ) {
        throw new Error("effect lease fence does not match");
      }
      if (input.reconciliation.kind === "execute") {
        throw new Error("an execute reconciliation is an instruction, not a completed effect");
      }
      if (input.reconciliation.kind === "hold_unknown") {
        if (
          input.reconciliation.effect_id !== row.id ||
          input.reconciliation.external_identity !== row.target
        ) throw new Error("unknown effect reconciliation identity does not match");
        const retryAt = Date.parse(input.reconciliation.retry_at);
        const now = this.#now();
        if (
          !Number.isFinite(retryAt) ||
          new Date(retryAt).toISOString() !== input.reconciliation.retry_at ||
          retryAt <= Date.parse(now)
        ) throw new Error("unknown effect reconciliation retry_at must be a future canonical timestamp");
        const changed = this.#db.prepare(`
          UPDATE effects
          SET status = 'unknown', lease_id = NULL, lease_worker_id = NULL,
              lease_expires_at = NULL, lease_execution_mode = NULL, unknown_detail = ?,
              available_at = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? AND lease_id = ? AND lease_worker_id = ? AND status = 'processing'
        `).run(
          input.reconciliation.detail,
          input.reconciliation.retry_at,
          now,
          row.id,
          row.version,
          input.lease_id,
          input.worker_id,
        );
        if (changed.changes !== 1) throw new Error("effect unknown-outcome compare-and-set failed");
      } else {
        const delivery = input.reconciliation.delivery;
        if (
          delivery.effect_id !== row.id || delivery.pipeline_run_id !== row.pipeline_run_id ||
          delivery.idempotency_key !== row.idempotency_key || delivery.external_identity !== row.target
        ) throw new Error("DeliveryRecord does not match its leased effect");
        this.#insertRecord(delivery);
        const changed = this.#db.prepare(`
          UPDATE effects
          SET status = ?, lease_id = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
              lease_execution_mode = NULL, delivery_record_id = ?, unknown_detail = NULL,
              version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? AND lease_id = ? AND lease_worker_id = ? AND status = 'processing'
        `).run(
          delivery.status === "confirmed" ? "acknowledged" : "rejected",
          delivery.id,
          this.#now(),
          row.id,
          row.version,
          input.lease_id,
          input.worker_id,
        );
        if (changed.changes !== 1) throw new Error("effect completion compare-and-set failed");
      }
      this.#advanceRunFence(row.pipeline_run_id, `effect-complete:${input.lease_id}`, input.reconciliation);
    }).immediate();
  }

  #recoverExpiredEffectLeases(now: string): void {
    const expired = this.#db.prepare(`
      SELECT * FROM effects
      WHERE status = 'processing' AND lease_id IS NOT NULL AND lease_expires_at <= ?
      ORDER BY pipeline_run_id, id
      LIMIT ?
    `).all(now, EXPIRED_EFFECT_RECOVERY_BATCH_SIZE) as EffectRow[];
    for (const row of expired) {
      const reconcileOnly = row.dispatch_lease_id !== null;
      const changed = this.#db.prepare(`
        UPDATE effects
        SET status = ?, lease_id = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
          lease_execution_mode = NULL, unknown_detail = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'processing' AND lease_id = ?
          AND lease_expires_at <= ?
      `).run(
        reconcileOnly ? "unknown" : "pending",
        reconcileOnly ? "provider dispatch may have started before the effect lease expired" : null,
        now,
        row.id,
        row.version,
        row.lease_id,
        now,
      );
      if (changed.changes !== 1) throw new Error(`effect ${row.id} expiry recovery compare-and-set failed`);
      this.#advanceRunFence(row.pipeline_run_id, `effect-expired:${row.lease_id}`, {
        effect_id: row.id,
        recovered_status: reconcileOnly ? "unknown" : "pending",
      });
    }
  }

  effectIntentFromRow(row: EffectRow): EffectIntent {
    let payload: unknown;
    const pointer = payloadPointer(row);
    if (pointer) {
      const bytes = this.#readEffectBlob(row.pipeline_run_id, row.id, pointer);
      if (pointer.encoding !== "utf-8") throw new Error(`effect ${row.id} payload is not JSON text`);
      payload = parseJson(bytes.toString("utf8"), `effect ${row.id} payload`);
    } else {
      payload = parseJson(row.inline_payload!, `effect ${row.id} payload`);
    }
    return validateEffectIntent({
      schema: "openthrottle.effect-intent/v1",
      id: row.id,
      pipeline_run_id: row.pipeline_run_id,
      decision_record_id: row.decision_record_id,
      kind: row.kind,
      idempotency_key: row.idempotency_key,
      target: row.target,
      subject: row.subject,
      payload,
    }).value;
  }
}
