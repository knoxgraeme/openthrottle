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
  MAX_KERNEL_RUNTIME_POOL_SIZE,
  kernelRuntimeResourceSlotIndex,
} from "../pipeline/kernel/runtime-resource.js";
import {
  parseJson,
  payloadPointer,
  type AttemptRow,
  type EffectRow,
} from "./kernel-store-codecs.js";

const EXPIRED_EFFECT_RECOVERY_BATCH_SIZE = 100;
const ATTEMPT_SCHEDULING_BATCH_SIZE = 100;

export interface ValidKernelLeaseManifestScheduling {
  readonly valid: true;
  readonly pipeline_id: string;
  readonly pool_size: number;
  readonly parallel_inspect_stage_widths: ReadonlyMap<string, number>;
  readonly parallel_unit_stage_scheduling: ReadonlyMap<
    string,
    KernelLeaseUnitStageScheduling
  >;
}

export interface KernelLeaseUnitStageScheduling {
  readonly root_stage_id: string;
  readonly loop_id: string;
  readonly max_parallel: number;
  readonly repository_authority: "inspect" | "edit";
}

export interface InvalidKernelLeaseManifestScheduling {
  readonly valid: false;
  readonly pipeline_id: string | null;
  readonly reason: string;
  readonly retryable: boolean;
}

export type KernelLeaseManifestScheduling =
  | ValidKernelLeaseManifestScheduling
  | InvalidKernelLeaseManifestScheduling;

export type KernelLeaseSchedulingSnapshot = ReadonlyMap<
  string,
  KernelLeaseManifestScheduling
>;

export class KernelLeaseSchedulingSnapshotStaleError extends Error {
  constructor(detail: string) {
    super(`Attempt scheduling manifest snapshot is stale: ${detail}`);
    this.name = "KernelLeaseSchedulingSnapshotStaleError";
  }
}

interface SchedulingAttemptRow extends AttemptRow {
  created_at: string;
  run_pipeline_id: string;
  run_definition_bundle_hash: string;
}

interface ParallelAttemptClaim {
  readonly kind: "inspect" | "unit_cycle";
  readonly cohort_id: string;
  readonly width: number;
}

export class KernelLeaseOperations {
  readonly #db: Database.Database;
  readonly #now: () => string;
  readonly #attemptById: (id: string, runId: string) => KernelAttempt;
  readonly #advanceRunFence: (runId: string, transitionId: string, content: unknown) => KernelRun;
  readonly #insertRecord: (record: ExecutionRecord) => void;
  readonly #readEffectBlob: (runId: string, ownerId: string, pointer: BlobPointer) => Buffer;
  readonly #schedulingSnapshot: () => Promise<KernelLeaseSchedulingSnapshot>;
  readonly #executionWidth: number;
  readonly #maxConcurrentAttempts: number;
  readonly #resourceCapacity: number;

  constructor(input: {
    db: Database.Database;
    now: () => string;
    attempt_by_id: (id: string, runId: string) => KernelAttempt;
    advance_run_fence: (runId: string, transitionId: string, content: unknown) => KernelRun;
    insert_record: (record: ExecutionRecord) => void;
    read_effect_blob: (runId: string, ownerId: string, pointer: BlobPointer) => Buffer;
    execution_policy: { readonly max_concurrent_attempts: number };
    execution_width: number;
    scheduling_snapshot: () => Promise<KernelLeaseSchedulingSnapshot>;
  }) {
    this.#db = input.db;
    this.#now = input.now;
    this.#attemptById = input.attempt_by_id;
    this.#advanceRunFence = input.advance_run_fence;
    this.#insertRecord = input.insert_record;
    this.#readEffectBlob = input.read_effect_blob;
    this.#schedulingSnapshot = input.scheduling_snapshot;
    const maxConcurrentAttempts = input.execution_policy.max_concurrent_attempts;
    if (
      !Object.isFrozen(input.execution_policy) ||
      !Number.isSafeInteger(maxConcurrentAttempts) ||
      maxConcurrentAttempts < 1 || maxConcurrentAttempts > MAX_KERNEL_RUNTIME_POOL_SIZE
    ) {
      throw new Error(
        `Attempt lease policy must be frozen between 1 and ${MAX_KERNEL_RUNTIME_POOL_SIZE}`,
      );
    }
    if (!Number.isSafeInteger(input.execution_width) || input.execution_width < 1) {
      throw new Error("Attempt execution width must be a positive integer");
    }
    this.#executionWidth = input.execution_width;
    this.#maxConcurrentAttempts = maxConcurrentAttempts;
    this.#resourceCapacity = Math.max(input.execution_width, maxConcurrentAttempts);
  }

  get maxConcurrentAttempts(): number {
    return this.#maxConcurrentAttempts;
  }

  async leaseNextEligibleAttempt(request: AttemptLeaseRequest): Promise<LeasedAttemptView | null> {
    for (let snapshotAttempt = 0; snapshotAttempt < 3; snapshotAttempt += 1) {
      const snapshot = await this.#schedulingSnapshot();
      try {
        return this.#leaseNextEligibleAttemptWithSnapshot(request, snapshot);
      } catch (error) {
        if (!(error instanceof KernelLeaseSchedulingSnapshotStaleError) || snapshotAttempt === 2) {
          throw error;
        }
      }
    }
    throw new Error("Attempt scheduling manifest snapshot retry bound was exhausted");
  }

  #leaseNextEligibleAttemptWithSnapshot(
    request: AttemptLeaseRequest,
    snapshot: KernelLeaseSchedulingSnapshot,
  ): LeasedAttemptView | null {
    return this.#db.transaction(() => {
      const now = this.#now();
      const replay = this.#replayAttemptLease(request);
      if (replay !== null) return replay;
      this.#assertSchedulingSnapshotCoverage(snapshot);
      const liveAttemptCount = (this.#db.prepare(`
        SELECT COUNT(*) AS count FROM attempts WHERE lease_id IS NOT NULL
      `).get() as { count: number }).count;
      if (liveAttemptCount >= this.#executionWidth) return null;
      const reservations = this.#resourceReservations(snapshot);
      const reservedSlots = [...reservations.values()].reduce((sum, count) => sum + count, 0);
      let afterCreatedAt: string | null = null;
      let afterId: string | null = null;
      let row: SchedulingAttemptRow | undefined;
      for (;;) {
        const candidates = this.#db.prepare(`
          SELECT a.*, r.pipeline_id AS run_pipeline_id,
            r.definition_bundle_hash AS run_definition_bundle_hash
          FROM attempts a
          JOIN pipeline_runs r ON r.id = a.pipeline_run_id
          WHERE r.status IN ('pending', 'running')
            AND a.status IN ('pending', 'result_pending')
            AND a.unmet_dependency_count = 0
            AND a.lease_id IS NULL
            AND (
              ? IS NULL OR a.created_at > ? OR
              (a.created_at = ? AND a.id > ?)
            )
          ORDER BY a.created_at, a.id
          LIMIT ?
        `).all(
          afterCreatedAt,
          afterCreatedAt,
          afterCreatedAt,
          afterId,
          ATTEMPT_SCHEDULING_BATCH_SIZE,
        ) as SchedulingAttemptRow[];
        for (const candidate of candidates) {
          const scheduling = this.#attemptScheduling(candidate, snapshot);
          if (scheduling === null || !this.#candidateCanShareItsRun(candidate, snapshot)) continue;
          const existingReservation = reservations.get(candidate.pipeline_run_id) ?? 0;
          const additionalSlots = Math.max(0, scheduling.pool_size - existingReservation);
          if (reservedSlots + additionalSlots > this.#resourceCapacity) continue;
          row = candidate;
          break;
        }
        if (row !== undefined || candidates.length < ATTEMPT_SCHEDULING_BATCH_SIZE) break;
        const last = candidates.at(-1)!;
        afterCreatedAt = last.created_at;
        afterId = last.id;
      }
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

  #replayAttemptLease(request: AttemptLeaseRequest): LeasedAttemptView | null {
    const replay = this.#db.prepare(`
      SELECT a.*, r.version AS run_version, r.cursor_version
      FROM attempts a JOIN pipeline_runs r ON r.id = a.pipeline_run_id
      WHERE a.lease_id = ?
    `).get(request.lease_id) as (AttemptRow & {
      run_version: number;
      cursor_version: number;
    }) | undefined;
    if (!replay) return null;
    if (
      replay.lease_worker_id !== request.worker_id ||
      replay.lease_expires_at !== request.expires_at
    ) throw new Error(`attempt lease ${request.lease_id} conflicts with its immutable replay`);
    const attempt = this.#attemptById(replay.id, replay.pipeline_run_id);
    return {
      run_id: replay.pipeline_run_id,
      run_version: replay.run_version,
      cursor_version: replay.cursor_version,
      attempt,
      lease: attempt.lease!,
    };
  }

  #assertSchedulingSnapshotCoverage(snapshot: KernelLeaseSchedulingSnapshot): void {
    const runs = this.#db.prepare(`
      SELECT id, pipeline_id, definition_bundle_hash FROM pipeline_runs
      WHERE status IN ('pending', 'running') ORDER BY id
    `).all() as Array<{ id: string; pipeline_id: string; definition_bundle_hash: string }>;
    for (const run of runs) {
      const scheduling = snapshot.get(run.definition_bundle_hash);
      if (scheduling === undefined) {
        throw new KernelLeaseSchedulingSnapshotStaleError(`missing exact manifest for run ${run.id}`);
      }
    }
  }

  #attemptScheduling(
    row: SchedulingAttemptRow | AttemptRow,
    snapshot: KernelLeaseSchedulingSnapshot,
  ): ValidKernelLeaseManifestScheduling | null {
    const scheduling = snapshot.get(row.definition_bundle_hash);
    if (
      scheduling === undefined || !scheduling.valid ||
      !Number.isSafeInteger(scheduling.pool_size) || scheduling.pool_size < 1 ||
      scheduling.pool_size > this.#maxConcurrentAttempts ||
      scheduling.pool_size > MAX_KERNEL_RUNTIME_POOL_SIZE
    ) return null;
    if ("run_definition_bundle_hash" in row && (
      row.definition_bundle_hash !== row.run_definition_bundle_hash ||
      scheduling.pipeline_id !== row.run_pipeline_id
    )) return null;
    return scheduling;
  }

  #parallelClaim(
    row: AttemptRow,
    scheduling: ValidKernelLeaseManifestScheduling,
  ): ParallelAttemptClaim | null {
    const inspectWidth = scheduling.parallel_inspect_stage_widths.get(row.stage_id);
    if (
      row.repository_authority === "inspect" &&
      (row.scope_kind === "loop_item" || row.scope_kind === "fanout_member") &&
      inspectWidth !== undefined && inspectWidth > 1 &&
      row.scope_item_index !== null
    ) {
      return {
        kind: "inspect",
        cohort_id: row.stage_id,
        width: inspectWidth,
      };
    }
    const unit = scheduling.parallel_unit_stage_scheduling.get(row.stage_id);
    if (
      unit !== undefined && unit.max_parallel > 1 &&
      row.repository_authority === unit.repository_authority &&
      row.scope_kind === "loop_item" &&
      row.scope_group_id === unit.loop_id &&
      row.scope_item_id !== null && row.scope_item_index !== null
    ) {
      return {
        kind: "unit_cycle",
        cohort_id: unit.root_stage_id,
        width: unit.max_parallel,
      };
    }
    return null;
  }

  #slotIndex(row: AttemptRow, scheduling: ValidKernelLeaseManifestScheduling): number {
    return kernelRuntimeResourceSlotIndex(
      row.scope_kind === "stage"
        ? { kind: "stage", stage_id: row.stage_id }
        : row.scope_kind === "loop_item"
          ? {
            kind: "loop_item",
            stage_id: row.stage_id,
            parent_attempt_id: row.parent_attempt_id!,
            loop_id: row.scope_group_id!,
            item_id: row.scope_item_id!,
            item_index: row.scope_item_index!,
          }
          : {
            kind: "fanout_member",
            stage_id: row.stage_id,
            parent_attempt_id: row.parent_attempt_id!,
            fanout_id: row.scope_group_id!,
            member_id: row.scope_item_id!,
            member_index: row.scope_item_index!,
          },
      scheduling.pool_size,
    );
  }

  #sameParallelCohort(
    left: AttemptRow,
    leftClaim: ParallelAttemptClaim,
    right: AttemptRow,
    rightClaim: ParallelAttemptClaim,
  ): boolean {
    if (
      leftClaim.kind !== rightClaim.kind ||
      leftClaim.cohort_id !== rightClaim.cohort_id ||
      leftClaim.width !== rightClaim.width ||
      left.scope_kind !== right.scope_kind ||
      left.parent_attempt_id !== right.parent_attempt_id ||
      left.scope_group_id !== right.scope_group_id ||
      left.definition_bundle_hash !== right.definition_bundle_hash
    ) return false;
    return leftClaim.kind === "unit_cycle" || (
      left.stage_id === right.stage_id && left.input_subject === right.input_subject
    );
  }

  #sameParallelMember(left: AttemptRow, right: AttemptRow): boolean {
    return left.scope_item_id === right.scope_item_id ||
      left.scope_item_index === right.scope_item_index;
  }

  #claimRows(runId: string): AttemptRow[] {
    return this.#db.prepare(`
      SELECT * FROM attempts
      WHERE pipeline_run_id = ? AND (
        lease_id IS NOT NULL OR status IN ('result_pending', 'work_complete')
      )
      ORDER BY id
    `).all(runId) as AttemptRow[];
  }

  #claimSetIsValid(
    claims: readonly AttemptRow[],
    snapshot: KernelLeaseSchedulingSnapshot,
  ): boolean {
    if (claims.length === 0) return true;
    const first = claims[0]!;
    const scheduling = this.#attemptScheduling(first, snapshot);
    if (claims.length === 1) return true;
    if (scheduling === null) return false;
    const firstClaim = this.#parallelClaim(first, scheduling);
    if (firstClaim === null || claims.length > firstClaim.width) return false;
    const slots = new Set<number>();
    const members: AttemptRow[] = [];
    for (const claim of claims) {
      const claimScheduling = this.#attemptScheduling(claim, snapshot);
      const parallelClaim = claimScheduling === null
        ? null
        : this.#parallelClaim(claim, claimScheduling);
      if (
        claimScheduling === null || claimScheduling !== scheduling ||
        parallelClaim === null ||
        !this.#sameParallelCohort(first, firstClaim, claim, parallelClaim) ||
        members.some((member) => this.#sameParallelMember(member, claim))
      ) return false;
      const slot = this.#slotIndex(claim, claimScheduling);
      if (slots.has(slot)) return false;
      slots.add(slot);
      members.push(claim);
    }
    return true;
  }

  #candidateCanShareItsRun(
    candidate: SchedulingAttemptRow,
    snapshot: KernelLeaseSchedulingSnapshot,
  ): boolean {
    const claims = this.#claimRows(candidate.pipeline_run_id);
    if (!this.#claimSetIsValid(claims, snapshot)) return false;
    const otherClaims = claims.filter((claim) => claim.id !== candidate.id);
    if (otherClaims.length === 0) return true;
    const scheduling = this.#attemptScheduling(candidate, snapshot);
    if (scheduling === null) return false;
    const candidateClaim = this.#parallelClaim(candidate, scheduling);
    if (candidateClaim === null || otherClaims.length + 1 > candidateClaim.width) return false;
    const candidateSlot = this.#slotIndex(candidate, scheduling);
    return otherClaims.every((claim) => {
      const claimScheduling = this.#attemptScheduling(claim, snapshot);
      const parallelClaim = claimScheduling === null
        ? null
        : this.#parallelClaim(claim, claimScheduling);
      return claimScheduling === scheduling && parallelClaim !== null &&
        this.#sameParallelCohort(candidate, candidateClaim, claim, parallelClaim) &&
        !this.#sameParallelMember(candidate, claim) &&
        this.#slotIndex(claim, claimScheduling) !== candidateSlot;
    });
  }

  #resourceReservations(
    snapshot: KernelLeaseSchedulingSnapshot,
  ): Map<string, number> {
    const reservations = new Map<string, number>();
    const creates = this.#db.prepare(`
      SELECT runtime_create.pipeline_run_id, COUNT(*) AS count
      FROM effects runtime_create
      JOIN pipeline_runs r ON r.id = runtime_create.pipeline_run_id
      WHERE r.status IN ('pending', 'running')
        AND runtime_create.kind = 'daytona/create-sandbox@1'
        AND runtime_create.status IN ('pending', 'processing', 'unknown', 'acknowledged')
        AND NOT EXISTS (
          SELECT 1 FROM effects runtime_cleanup
          WHERE runtime_cleanup.pipeline_run_id = runtime_create.pipeline_run_id
            AND runtime_cleanup.kind = 'daytona/cleanup-sandbox@1'
            AND runtime_cleanup.target = runtime_create.target
            AND runtime_cleanup.status = 'acknowledged'
        )
      GROUP BY runtime_create.pipeline_run_id
    `).all() as Array<{ pipeline_run_id: string; count: number }>;
    for (const row of creates) reservations.set(row.pipeline_run_id, row.count);

    const claimedRuns = this.#db.prepare(`
      SELECT DISTINCT a.pipeline_run_id, r.definition_bundle_hash
      FROM attempts a JOIN pipeline_runs r ON r.id = a.pipeline_run_id
      WHERE r.status IN ('pending', 'running') AND (
        a.lease_id IS NOT NULL OR a.status IN ('result_pending', 'work_complete')
      )
      ORDER BY a.pipeline_run_id
    `).all() as Array<{
      pipeline_run_id: string;
      definition_bundle_hash: string;
    }>;
    for (const row of claimedRuns) {
      const scheduling = snapshot.get(row.definition_bundle_hash);
      if (
        scheduling === undefined || !scheduling.valid ||
        scheduling.pool_size > this.#maxConcurrentAttempts
      ) continue;
      reservations.set(
        row.pipeline_run_id,
        Math.max(reservations.get(row.pipeline_run_id) ?? 0, scheduling.pool_size),
      );
    }
    return reservations;
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
    for (let snapshotAttempt = 0; snapshotAttempt < 3; snapshotAttempt += 1) {
      const snapshot = await this.#schedulingSnapshot();
      try {
        return this.#recoverExpiredAttemptLeasesWithSnapshot(input, snapshot);
      } catch (error) {
        if (!(error instanceof KernelLeaseSchedulingSnapshotStaleError) || snapshotAttempt === 2) {
          throw error;
        }
      }
    }
    throw new Error("Attempt recovery manifest snapshot retry bound was exhausted");
  }

  #recoverExpiredAttemptLeasesWithSnapshot(
    input: { observed_at: string; expires_at: string; limit: number },
    snapshot: KernelLeaseSchedulingSnapshot,
  ): readonly LeasedAttemptView[] {
    return this.#db.transaction(() => {
      this.#assertSchedulingSnapshotCoverage(snapshot);
      const corruptRuns = this.#corruptClaimRuns(snapshot);
      const rows: AttemptRow[] = [];
      let afterExpiresAt: string | null = null;
      let afterRunId: string | null = null;
      let afterId: string | null = null;
      while (rows.length < input.limit) {
        const page = this.#db.prepare(`
          SELECT * FROM attempts
          WHERE lease_id IS NOT NULL AND lease_expires_at <= ?
            AND status IN ('pending', 'running', 'result_pending')
            AND (
              ? IS NULL OR lease_expires_at > ? OR
              (lease_expires_at = ? AND pipeline_run_id > ?) OR
              (lease_expires_at = ? AND pipeline_run_id = ? AND id > ?)
            )
          ORDER BY lease_expires_at, pipeline_run_id, id
          LIMIT ?
        `).all(
          input.observed_at,
          afterExpiresAt,
          afterExpiresAt,
          afterExpiresAt,
          afterRunId,
          afterExpiresAt,
          afterRunId,
          afterId,
          ATTEMPT_SCHEDULING_BATCH_SIZE,
        ) as AttemptRow[];
        for (const row of page) {
          if (!corruptRuns.has(row.pipeline_run_id)) rows.push(row);
          if (rows.length === input.limit) break;
        }
        if (page.length < ATTEMPT_SCHEDULING_BATCH_SIZE || rows.length === input.limit) break;
        const last = page.at(-1)!;
        afterExpiresAt = last.lease_expires_at;
        afterRunId = last.pipeline_run_id;
        afterId = last.id;
      }
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

  #corruptClaimRuns(snapshot: KernelLeaseSchedulingSnapshot): ReadonlySet<string> {
    const rows = this.#db.prepare(`
      SELECT a.* FROM attempts a
      JOIN pipeline_runs r ON r.id = a.pipeline_run_id
      WHERE r.status IN ('pending', 'running') AND (
        a.lease_id IS NOT NULL OR a.status IN ('result_pending', 'work_complete')
      )
      ORDER BY a.pipeline_run_id, a.id
    `).all() as AttemptRow[];
    const byRun = new Map<string, AttemptRow[]>();
    for (const row of rows) {
      const claims = byRun.get(row.pipeline_run_id) ?? [];
      claims.push(row);
      byRun.set(row.pipeline_run_id, claims);
    }
    return new Set([...byRun].flatMap(([runId, claims]) =>
      this.#claimSetIsValid(claims, snapshot) ? [] : [runId]));
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
          prior_unknown_detail: replay.last_error,
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
            lease_execution_mode = ?, last_error = unknown_detail, unknown_detail = NULL,
            attempt_count = attempt_count + 1,
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
        prior_unknown_detail: row.unknown_detail,
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
        prior_unknown_detail: row.last_error,
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
              last_error = NULL, available_at = ?, version = version + 1, updated_at = ?
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
              last_error = NULL, version = version + 1, updated_at = ?
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
      const retainedPrior = row.kind === "github/provider-wait@1" || reconcileOnly
        ? row.last_error
        : null;
      const recoveredUnknown = retainedPrior !== null || reconcileOnly;
      const changed = this.#db.prepare(`
        UPDATE effects
        SET status = ?, lease_id = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
          lease_execution_mode = NULL, unknown_detail = ?, last_error = NULL,
          version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = 'processing' AND lease_id = ?
          AND lease_expires_at <= ?
      `).run(
        recoveredUnknown ? "unknown" : "pending",
        retainedPrior ?? (reconcileOnly
          ? "provider dispatch may have started before the effect lease expired"
          : null),
        now,
        row.id,
        row.version,
        row.lease_id,
        now,
      );
      if (changed.changes !== 1) throw new Error(`effect ${row.id} expiry recovery compare-and-set failed`);
      this.#advanceRunFence(row.pipeline_run_id, `effect-expired:${row.lease_id}`, {
        effect_id: row.id,
        recovered_status: recoveredUnknown ? "unknown" : "pending",
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
