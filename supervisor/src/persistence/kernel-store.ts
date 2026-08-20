import type Database from "better-sqlite3";
import {
  canonicalJson,
  digestCanonicalJson,
  validateAttemptCheckpoint,
  validateEffectIntent,
  validateExecutionRecord,
  type AttemptCheckpoint,
  type BlobPointer,
  type CompiledPipelineManifest,
  type EffectIntent,
  type ExecutionRecord,
  type ExecutionRecordPayloadRegistry,
  type JsonValue,
  type RecordPayload,
} from "@openthrottle/contracts";
import type {
  AttemptLeaseRequest,
  KernelAttemptLeasePort,
  KernelContextPort,
  KernelEffectPort,
  KernelProjectionPort,
  KernelReductionPort,
  KernelRunProjection,
  LeasedAttemptView,
  LeasedEffectView,
  ReductionReadRequest,
  ReductionView,
  ResolvedKernelContext,
} from "../pipeline/kernel/ports.js";
import type { EffectReconciliation } from "../pipeline/kernel/effect-intent.js";
import { effectIntentContentHash } from "../pipeline/kernel/effect-intent.js";
import {
  KERNEL_ATTEMPT_SCHEMA,
  KERNEL_RUN_SCHEMA,
  type AtomicTransitionBundle,
  type AttemptScope,
  type KernelAttempt,
  type KernelCursor,
  type KernelRun,
} from "../pipeline/kernel/types.js";
import {
  transitionApplicationDisposition,
  type AtomicTransitionApplyResult,
} from "../pipeline/kernel/store.js";
import {
  BlobIntegrityError,
  VolumeBlobStore,
  type VerifiedBlobToken,
} from "./blob-store.js";

const ACTIVE_RUN_STATUSES = new Set(["pending", "running"]);
const ACTIVE_ATTEMPT_STATUSES = ["pending", "running", "work_complete", "result_pending", "recorded"];
const ACTIVE_EFFECT_STATUSES = ["pending", "processing", "unknown"];
const BUNDLE_PAYLOAD_SCHEMA = "openthrottle.definition-bundle/v1";

export interface KernelManifestResolver {
  resolve(input: {
    pipeline_id: string;
    definition_bundle_hash: string;
  }): CompiledPipelineManifest | Promise<CompiledPipelineManifest>;
}

export interface PersistedPayloadInput {
  payload_schema: string;
  payload: { inline: JsonValue } | { blob: VerifiedBlobToken };
}

export interface DefinitionSnapshotInput {
  definition_kind: "agent" | "pipeline" | "skill" | "eval" | "config" | "loop";
  definition_id: string;
  source_commit: string | null;
  content_hash: string;
  normalized_payload: JsonValue;
}

export interface WorkItemSeed extends PersistedPayloadInput {
  id: string;
  repository_registration_id: string;
  source_provider: "linear" | "github" | "operator";
  source_id: string;
  source_reference: string;
  state: "admitted" | "active";
  title: string;
}

export interface PipelineAdmissionInput {
  work_item: WorkItemSeed;
  definitions: readonly DefinitionSnapshotInput[];
  run: KernelRun;
  definition_bundle: VerifiedBlobToken;
  initial_attempts: readonly KernelAttempt[];
}

export type KernelStoreFaultPoint =
  | "admission_definitions_written"
  | "admission_work_item_written"
  | "admission_run_written"
  | "admission_attempts_written";

interface PayloadColumns {
  inline_payload: string | null;
  blob_algorithm: "sha256" | null;
  blob_digest: string | null;
  blob_bytes: number | null;
  blob_encoding: "utf-8" | "binary" | null;
  blob_media_type: string | null;
  blob_payload_schema: string | null;
}

interface PayloadRow extends PayloadColumns {
  payload_schema: string;
}

interface RunRow {
  id: string;
  pipeline_id: string;
  definition_bundle_hash: string;
  current_subject: string;
  status: KernelRun["status"];
  terminal_outcome: KernelRun["terminal_outcome"];
  cursor_stage_id: string | null;
  cursor_version: number;
  cursor_reentries_json: string;
  cursor_frontier_json: string;
  cursor_completed_scope_keys_json: string;
  cursor_barrier_json: string | null;
  version: number;
  work_retry_limit: number;
  result_correction_limit: number;
  last_transition_id: string | null;
  last_transition_hash: string | null;
}

interface AttemptRow {
  id: string;
  pipeline_run_id: string;
  scope_kind: AttemptScope["kind"];
  stage_id: string;
  parent_attempt_id: string | null;
  scope_group_id: string | null;
  scope_item_id: string | null;
  scope_item_index: number | null;
  repository_authority: KernelAttempt["repository_authority"];
  request_hash: string;
  definition_bundle_hash: string;
  input_subject: string;
  output_subject: string | null;
  native_session_id: string | null;
  status: KernelAttempt["status"];
  version: number;
  work_retry_ordinal: number;
  result_correction_count: number;
  result_correction_deadline: string | null;
  unmet_dependency_count: number;
  lease_id: string | null;
  lease_worker_id: string | null;
  lease_purpose: "work" | "result_correction" | null;
  lease_expires_at: string | null;
  lease_started: number | null;
  checkpoint_id: string | null;
  result_record_id: string | null;
  pending_candidate_hash: string | null;
  pending_diagnostics_json: string | null;
}

interface RecordRow extends PayloadRow {
  id: string;
  pipeline_run_id: string;
  sequence: number;
  kind: ExecutionRecord["kind"];
  attempt_id: string | null;
  request_hash: string | null;
  definition_bundle_hash: string | null;
  input_subject: string | null;
  output_subject: string | null;
  original_candidate_hash: string | null;
  normalized_candidate_hash: string | null;
  reducer: string | null;
  input_record_ids_json: string | null;
  effect_id: string | null;
  idempotency_key: string | null;
  external_identity: string | null;
  delivery_status: "confirmed" | "rejected" | null;
  created_at: string;
}

interface CheckpointRow extends PayloadRow {
  id: string;
  pipeline_run_id: string;
  attempt_id: string;
  request_hash: string;
  definition_bundle_hash: string;
  input_subject: string;
  output_subject: string | null;
  native_session_id: string | null;
  captured_at: string;
}

interface EffectRow extends PayloadRow {
  id: string;
  pipeline_run_id: string;
  decision_record_id: string;
  kind: string;
  idempotency_key: string;
  target: string;
  subject: string | null;
  status: string;
  version: number;
  lease_id: string | null;
  lease_worker_id: string | null;
  lease_expires_at: string | null;
  lease_execution_mode: "dispatch_or_reconcile" | "reconcile_only" | null;
}

export interface KernelIntegrityEvidence {
  pipeline_run_id: string;
  owner_kind: "record" | "checkpoint" | "effect" | "definition_bundle";
  owner_id: string;
  digest: string;
  classification: "active_blocking" | "settled_history_incident";
  operator_action: "restore_verified_blob_or_abandon_active_run" | "raise_global_integrity_incident";
  detail: string;
}

export class KernelIntegrityError extends Error {
  readonly code = "KERNEL_BLOB_INTEGRITY";

  constructor(readonly evidence: KernelIntegrityEvidence) {
    super(`kernel blob integrity failure for ${evidence.owner_kind} ${evidence.owner_id}: ${evidence.detail}`);
    this.name = "KernelIntegrityError";
  }
}

function placeholders(length: number): string {
  return Array.from({ length }, () => "?").join(", ");
}

function parseJson<T>(value: string, name: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`persisted ${name} is not valid JSON`);
  }
}

function sortedRecord(entries: ReadonlyArray<readonly [string, number]>): Record<string, number> {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function payloadPointer(row: PayloadRow): BlobPointer | null {
  if (row.blob_digest === null) return null;
  if (
    row.blob_algorithm !== "sha256" || row.blob_bytes === null || row.blob_encoding === null ||
    row.blob_media_type === null || row.blob_payload_schema === null
  ) {
    throw new Error("persisted blob pointer is incomplete");
  }
  return {
    algorithm: "sha256",
    digest: row.blob_digest,
    bytes: row.blob_bytes,
    encoding: row.blob_encoding,
    media_type: row.blob_media_type,
    payload_schema: row.blob_payload_schema,
  };
}

function recordPayload(row: PayloadRow): RecordPayload {
  const pointer = payloadPointer(row);
  if (pointer) return { blob: pointer };
  if (row.inline_payload === null) throw new Error("persisted inline payload is missing");
  return { inline: parseJson<JsonValue>(row.inline_payload, "inline payload") };
}

function semanticKey(record: ExecutionRecord): string | null {
  if (record.kind !== "decision" || !("inline" in record.payload)) return null;
  const payload = record.payload.inline;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const candidate = (payload as Record<string, JsonValue>).semantic_key;
  return typeof candidate === "string" && candidate.length > 0 && candidate.length <= 500
    ? candidate
    : null;
}

function scopeFromRow(row: AttemptRow): AttemptScope {
  if (row.scope_kind === "stage") return { kind: "stage", stage_id: row.stage_id };
  if (
    row.parent_attempt_id === null || row.scope_group_id === null ||
    row.scope_item_id === null || row.scope_item_index === null
  ) throw new Error(`persisted ${row.scope_kind} scope is incomplete`);
  return row.scope_kind === "loop_item"
    ? {
      kind: "loop_item",
      stage_id: row.stage_id,
      parent_attempt_id: row.parent_attempt_id,
      loop_id: row.scope_group_id,
      item_id: row.scope_item_id,
      item_index: row.scope_item_index,
    }
    : {
      kind: "fanout_member",
      stage_id: row.stage_id,
      parent_attempt_id: row.parent_attempt_id,
      fanout_id: row.scope_group_id,
      member_id: row.scope_item_id,
      member_index: row.scope_item_index,
    };
}

function attemptFromRow(row: AttemptRow): KernelAttempt {
  const lease = row.lease_id === null
    ? null
    : {
      id: row.lease_id,
      worker_id: row.lease_worker_id!,
      purpose: row.lease_purpose!,
      expires_at: row.lease_expires_at!,
      started: row.lease_started === 1,
    };
  return {
    schema: KERNEL_ATTEMPT_SCHEMA,
    id: row.id,
    pipeline_run_id: row.pipeline_run_id,
    scope: scopeFromRow(row),
    repository_authority: row.repository_authority,
    request_hash: row.request_hash,
    definition_bundle_hash: row.definition_bundle_hash,
    input_subject: row.input_subject,
    output_subject: row.output_subject,
    native_session_id: row.native_session_id,
    status: row.status,
    version: row.version,
    work_retry_ordinal: row.work_retry_ordinal,
    result_correction_count: row.result_correction_count,
    result_correction_deadline: row.result_correction_deadline,
    lease,
    checkpoint_id: row.checkpoint_id,
    result_record_id: row.result_record_id,
    pending_result: row.status === "result_pending"
      ? {
        candidate_hash: row.pending_candidate_hash,
        diagnostics: parseJson(row.pending_diagnostics_json!, "result diagnostics"),
      }
      : null,
  };
}

export class SqliteKernelStore implements
  KernelReductionPort,
  KernelAttemptLeasePort,
  KernelEffectPort,
  KernelContextPort,
  KernelProjectionPort {
  readonly #db: Database.Database;
  readonly #blobs: VolumeBlobStore;
  readonly #manifests: KernelManifestResolver;
  readonly #payloadSchemas: ExecutionRecordPayloadRegistry;
  readonly #now: () => string;
  readonly #faultInjector: ((point: KernelStoreFaultPoint) => void) | undefined;

  constructor(input: {
    db: Database.Database;
    blob_store: VolumeBlobStore;
    manifest_resolver: KernelManifestResolver;
    payload_schemas: ExecutionRecordPayloadRegistry;
    now?: () => string;
    fault_injector?: (point: KernelStoreFaultPoint) => void;
  }) {
    this.#db = input.db;
    this.#blobs = input.blob_store;
    this.#manifests = input.manifest_resolver;
    this.#payloadSchemas = input.payload_schemas;
    this.#now = input.now ?? (() => new Date().toISOString());
    this.#faultInjector = input.fault_injector;
  }

  admitPipelineRun(input: PipelineAdmissionInput): void {
    const pointer = this.#blobs.assertToken(input.definition_bundle);
    if (
      pointer.digest !== input.run.definition_bundle_hash ||
      pointer.payload_schema !== BUNDLE_PAYLOAD_SCHEMA ||
      pointer.encoding !== "utf-8" || pointer.media_type !== "application/json"
    ) throw new Error("pipeline run definition bundle token does not match its pinned bundle hash");
    const expectedAttempts = sortedRecord(input.initial_attempts.map((attempt) => [attempt.id, attempt.version]));
    if (canonicalJson(expectedAttempts) !== canonicalJson(input.run.active_attempt_versions)) {
      throw new Error("initial attempts do not match the run's active attempt projection");
    }
    if (
      Object.keys(input.run.active_effect_versions).length > 0 ||
      Object.keys(input.run.checkpoint_ids).length > 0
    ) throw new Error("a fresh pipeline run cannot contain effects or checkpoints");
    const workPayload = this.#payloadInput(input.work_item);
    const now = this.#now();
    this.#db.transaction(() => {
      this.#insertDefinitions(input.definitions);
      this.#fault("admission_definitions_written");
      this.#insertWorkItem(input.work_item, workPayload, now);
      this.#fault("admission_work_item_written");
      this.#insertRun(input.work_item.id, input.run, pointer, now);
      this.#fault("admission_run_written");
      for (const attempt of input.initial_attempts) this.#insertAttempt(attempt, now, null);
      this.#fault("admission_attempts_written");
      this.#materializeDependencyReadiness(input.run.cursor);
      this.#assertRunProjections(input.run);
    }).immediate();
  }

  async loadExactReductionView(request: ReductionReadRequest): Promise<ReductionView> {
    const row = this.#runRow(request.pipeline_run_id);
    const run = this.#runFromRow(row);
    const currentAttempt = request.attempt_id === null
      ? null
      : this.#attemptById(request.attempt_id, request.pipeline_run_id);
    const records = this.#loadExactRecords(request.pipeline_run_id, request.record_ids, run.status);
    const checkpoints = this.#loadExactCheckpoints(request.pipeline_run_id, request.checkpoint_ids, run.status);
    const manifest = await this.#manifests.resolve({
      pipeline_id: run.pipeline_id,
      definition_bundle_hash: run.definition_bundle_hash,
    });
    if (
      manifest.pipeline_id !== run.pipeline_id ||
      manifest.definition_bundle_hash !== run.definition_bundle_hash
    ) throw new Error("manifest resolver returned another pinned pipeline");
    return { manifest, run, current_attempt: currentAttempt, records, checkpoints };
  }

  async applyAtomicTransition(bundle: AtomicTransitionBundle): Promise<AtomicTransitionApplyResult> {
    this.#preverifyTransitionBlobs(bundle);
    return this.#db.transaction(() => {
      const row = this.#runRow(bundle.expected.run_id);
      const existing = row.last_transition_id === bundle.transition_id
        ? { transition_id: row.last_transition_id, content_hash: row.last_transition_hash! }
        : undefined;
      const attemptVersions = sortedRecord(Object.keys(bundle.expected.attempt_versions).map((attemptId) => {
        const attempt = this.#db.prepare("SELECT version FROM attempts WHERE id = ? AND pipeline_run_id = ?")
          .get(attemptId, row.id) as { version: number } | undefined;
        return [attemptId, attempt?.version ?? -1] as const;
      }));
      const disposition = transitionApplicationDisposition({
        bundle,
        observed: {
          run_id: row.id,
          run_version: row.version,
          cursor_version: row.cursor_version,
          attempt_versions: attemptVersions,
        },
        existing,
      });
      if (disposition === "replay") {
        return { disposition: "replayed", run_version: row.version } as const;
      }
      if (
        bundle.run.pipeline_id !== row.pipeline_id ||
        bundle.run.definition_bundle_hash !== row.definition_bundle_hash
      ) throw new Error("atomic transition cannot change the pinned pipeline or definition bundle");

      for (const record of bundle.append_records) this.#insertRecord(record);
      for (const checkpoint of bundle.append_checkpoints) this.#insertCheckpoint(checkpoint);
      for (const write of bundle.attempt_writes) {
        if (write.kind === "terminal") this.#terminalAttempt(write, row.id);
        else this.#replaceAttempt(write.attempt, bundle.expected.attempt_versions[write.attempt.id]!, row.id);
      }
      for (const attempt of bundle.create_attempts) this.#insertAttempt(attempt, this.#now(), null);
      for (const effect of bundle.put_effects) this.#insertEffect(effect);
      for (const effectId of bundle.cancel_effect_ids) this.#cancelEffect(effectId, row.id);
      this.#materializeDependencyReadiness(bundle.run.cursor);
      this.#assertRunProjections(bundle.run);
      const updated = this.#updateRun(bundle, row);
      if (updated !== 1) throw new Error(`atomic transition ${bundle.transition_id} compare-and-set failed`);
      return { disposition: "applied", run_version: bundle.run.version } as const;
    }).immediate();
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
        SELECT a.* FROM attempts a
        JOIN pipeline_runs r ON r.id = a.pipeline_run_id
        WHERE r.status IN ('pending', 'running')
          AND a.status IN ('pending', 'result_pending')
          AND a.unmet_dependency_count = 0
          AND a.lease_id IS NULL
          AND (a.status <> 'result_pending' OR (
            a.native_session_id IS NOT NULL
            AND a.result_correction_count < r.result_correction_limit
            AND a.result_correction_deadline IS NOT NULL
            AND a.result_correction_deadline > ?
          ))
        ORDER BY a.created_at, a.id
        LIMIT 1
      `).get(now) as AttemptRow | undefined;
      if (!row) return null;
      const purpose = row.status === "result_pending" ? "result_correction" : "work";
      const changed = this.#db.prepare(`
        UPDATE attempts
        SET lease_id = ?, lease_worker_id = ?, lease_purpose = ?, lease_expires_at = ?,
            lease_started = 0, version = version + 1,
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
    worker_id: string;
    expires_at: string;
  }): Promise<NonNullable<KernelAttempt["lease"]>> {
    return this.#db.transaction(() => {
      const row = this.#db.prepare("SELECT * FROM attempts WHERE id = ?")
        .get(input.attempt_id) as AttemptRow | undefined;
      if (
        !row || row.lease_id !== input.lease_id || row.lease_worker_id !== input.worker_id
      ) throw new Error("attempt lease fence does not match");
      const changed = this.#db.prepare(`
        UPDATE attempts SET lease_expires_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND lease_id = ? AND lease_worker_id = ? AND version = ?
      `).run(input.expires_at, this.#now(), row.id, input.lease_id, input.worker_id, row.version);
      if (changed.changes !== 1) throw new Error("attempt lease renewal compare-and-set failed");
      this.#advanceRunFence(row.pipeline_run_id, `attempt-renew:${input.lease_id}:${row.version + 1}`, input);
      return this.#attemptById(row.id, row.pipeline_run_id).lease!;
    }).immediate();
  }

  async leaseNextEffect(input: {
    worker_id: string;
    lease_id: string;
    expires_at: string;
  }): Promise<LeasedEffectView | null> {
    return this.#db.transaction(() => {
      const replay = this.#db.prepare("SELECT * FROM effects WHERE lease_id = ?")
        .get(input.lease_id) as EffectRow | undefined;
      if (replay) {
        if (
          replay.lease_worker_id !== input.worker_id || replay.lease_expires_at !== input.expires_at
        ) throw new Error(`effect lease ${input.lease_id} conflicts with its immutable replay`);
        return {
          intent: this.#effectIntentById(replay.id),
          lease_id: input.lease_id,
          expires_at: input.expires_at,
          execution_mode: replay.lease_execution_mode!,
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
      `).get(this.#now()) as EffectRow | undefined;
      if (!row) return null;
      const executionMode: LeasedEffectView["execution_mode"] = row.status === "unknown"
        ? "reconcile_only"
        : "dispatch_or_reconcile";
      const changed = this.#db.prepare(`
        UPDATE effects
        SET status = 'processing', lease_id = ?, lease_worker_id = ?, lease_expires_at = ?,
            lease_execution_mode = ?, unknown_detail = NULL, attempt_count = attempt_count + 1,
            version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND lease_id IS NULL AND status IN ('pending', 'unknown')
      `).run(input.lease_id, input.worker_id, input.expires_at, executionMode, this.#now(), row.id, row.version);
      if (changed.changes !== 1) throw new Error(`effect ${row.id} lease compare-and-set failed`);
      this.#advanceRunFence(row.pipeline_run_id, `effect-lease:${input.lease_id}`, {
        effect_id: row.id,
        worker_id: input.worker_id,
        expires_at: input.expires_at,
      });
      return {
        intent: this.#effectIntentById(row.id),
        lease_id: input.lease_id,
        expires_at: input.expires_at,
        execution_mode: executionMode,
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
        const changed = this.#db.prepare(`
          UPDATE effects
          SET status = 'unknown', lease_id = NULL, lease_worker_id = NULL,
              lease_expires_at = NULL, lease_execution_mode = NULL, unknown_detail = ?,
              version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? AND lease_id = ? AND lease_worker_id = ? AND status = 'processing'
        `).run(
          input.reconciliation.detail,
          this.#now(),
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

  async resolveExactContext(input: {
    pipeline_run_id: string;
    attempt_id: string;
    allowed_record_ids: readonly string[];
    allowed_checkpoint_ids: readonly string[];
  }): Promise<ResolvedKernelContext> {
    this.#attemptById(input.attempt_id, input.pipeline_run_id);
    const run = this.#runFromRow(this.#runRow(input.pipeline_run_id));
    return {
      records: this.#loadExactRecords(input.pipeline_run_id, input.allowed_record_ids, run.status),
      checkpoints: this.#loadExactCheckpoints(
        input.pipeline_run_id,
        input.allowed_checkpoint_ids,
        run.status,
      ),
    };
  }

  async getRunProjection(pipelineRunId: string): Promise<KernelRunProjection | undefined> {
    const row = this.#db.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(pipelineRunId) as RunRow | undefined;
    if (!row) return undefined;
    const activeAttempts = this.#db.prepare(`
      SELECT COUNT(*) AS count FROM attempts WHERE pipeline_run_id = ?
        AND status IN (${placeholders(ACTIVE_ATTEMPT_STATUSES.length)})
    `).get(pipelineRunId, ...ACTIVE_ATTEMPT_STATUSES) as { count: number };
    const activeEffects = this.#db.prepare(`
      SELECT COUNT(*) AS count FROM effects WHERE pipeline_run_id = ?
        AND status IN (${placeholders(ACTIVE_EFFECT_STATUSES.length)})
    `).get(pipelineRunId, ...ACTIVE_EFFECT_STATUSES) as { count: number };
    return {
      pipeline_run_id: row.id,
      pipeline_id: row.pipeline_id,
      status: row.status,
      stage_id: row.cursor_stage_id,
      current_subject: row.current_subject,
      active_attempt_count: activeAttempts.count,
      active_effect_count: activeEffects.count,
      version: row.version,
    };
  }

  async listRunLog(input: {
    pipeline_run_id: string;
    after_sequence?: number;
    limit: number;
  }): Promise<readonly {
    sequence: number;
    kind: "attempt" | "record" | "effect" | "checkpoint" | "transition";
    identity: string;
    summary: string;
  }[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new Error("kernel log limit must be between 1 and 1000");
    }
    const events: Array<{
      at: string;
      kind: "attempt" | "record" | "effect" | "checkpoint" | "transition";
      identity: string;
      summary: string;
    }> = [];
    for (const row of this.#db.prepare(`
      SELECT id, status, created_at AS at FROM attempts WHERE pipeline_run_id = ?
    `).all(input.pipeline_run_id) as Array<{ id: string; status: string; at: string }>) {
      events.push({ at: row.at, kind: "attempt", identity: row.id, summary: row.status });
    }
    for (const row of this.#db.prepare(`
      SELECT id, kind, created_at AS at FROM records WHERE pipeline_run_id = ?
    `).all(input.pipeline_run_id) as Array<{ id: string; kind: string; at: string }>) {
      events.push({ at: row.at, kind: "record", identity: row.id, summary: row.kind });
    }
    for (const row of this.#db.prepare(`
      SELECT id, status, created_at AS at FROM effects WHERE pipeline_run_id = ?
    `).all(input.pipeline_run_id) as Array<{ id: string; status: string; at: string }>) {
      events.push({ at: row.at, kind: "effect", identity: row.id, summary: row.status });
    }
    for (const row of this.#db.prepare(`
      SELECT id, payload_schema, captured_at AS at FROM checkpoints WHERE pipeline_run_id = ?
    `).all(input.pipeline_run_id) as Array<{ id: string; payload_schema: string; at: string }>) {
      events.push({ at: row.at, kind: "checkpoint", identity: row.id, summary: row.payload_schema });
    }
    const run = this.#db.prepare(`
      SELECT updated_at AS at, last_transition_id AS id FROM pipeline_runs WHERE id = ?
    `).get(input.pipeline_run_id) as { at: string; id: string | null } | undefined;
    if (run?.id) events.push({ at: run.at, kind: "transition", identity: run.id, summary: "applied" });
    return events
      .sort((left, right) => left.at.localeCompare(right.at) || left.kind.localeCompare(right.kind) || left.identity.localeCompare(right.identity))
      .map((event, index) => ({ ...event, sequence: index + 1 }))
      .filter((event) => event.sequence > (input.after_sequence ?? 0))
      .slice(0, input.limit)
      .map(({ at: _at, ...event }) => event);
  }

  #insertDefinitions(definitions: readonly DefinitionSnapshotInput[]): void {
    const insert = this.#db.prepare(`
      INSERT INTO definitions (
        definition_kind, definition_id, source_commit, content_hash, normalized_payload
      ) VALUES (?, ?, ?, ?, ?)
    `);
    for (const definition of definitions) {
      const normalized = canonicalJson(definition.normalized_payload);
      const existing = this.#db.prepare(`
        SELECT normalized_payload FROM definitions
        WHERE definition_kind = ? AND definition_id = ? AND source_commit IS ? AND content_hash = ?
      `).all(
        definition.definition_kind,
        definition.definition_id,
        definition.source_commit,
        definition.content_hash,
      ) as Array<{ normalized_payload: string }>;
      if (existing.some((row) => row.normalized_payload === normalized)) continue;
      if (existing.some((row) => row.normalized_payload !== normalized)) {
        throw new Error(`definition ${definition.definition_kind}:${definition.definition_id} conflicts at its immutable source`);
      }
      insert.run(
        definition.definition_kind,
        definition.definition_id,
        definition.source_commit,
        definition.content_hash,
        normalized,
      );
    }
  }

  #insertWorkItem(input: WorkItemSeed, payload: PayloadColumns, now: string): void {
    this.#db.prepare(`
      INSERT INTO work_items (
        id, repository_registration_id, source_provider, source_id, source_reference,
        state, title, request_payload_schema, request_inline_json,
        request_blob_algorithm, request_blob_digest, request_blob_bytes,
        request_blob_encoding, request_blob_media_type, request_blob_payload_schema,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      input.id,
      input.repository_registration_id,
      input.source_provider,
      input.source_id,
      input.source_reference,
      input.state,
      input.title,
      input.payload_schema,
      payload.inline_payload,
      payload.blob_algorithm,
      payload.blob_digest,
      payload.blob_bytes,
      payload.blob_encoding,
      payload.blob_media_type,
      payload.blob_payload_schema,
      now,
      now,
    );
  }

  #fault(point: KernelStoreFaultPoint): void {
    this.#faultInjector?.(point);
  }

  #payloadInput(input: PersistedPayloadInput): PayloadColumns {
    if ("inline" in input.payload) {
      return {
        inline_payload: canonicalJson(input.payload.inline),
        blob_algorithm: null,
        blob_digest: null,
        blob_bytes: null,
        blob_encoding: null,
        blob_media_type: null,
        blob_payload_schema: null,
      };
    }
    const pointer = this.#blobs.assertToken(input.payload.blob);
    if (pointer.payload_schema !== input.payload_schema) {
      throw new Error("verified blob payload schema does not match its owner");
    }
    return {
      inline_payload: null,
      blob_algorithm: pointer.algorithm,
      blob_digest: pointer.digest,
      blob_bytes: pointer.bytes,
      blob_encoding: pointer.encoding,
      blob_media_type: pointer.media_type,
      blob_payload_schema: pointer.payload_schema,
    };
  }

  #insertRun(workItemId: string, run: KernelRun, pointer: BlobPointer, now: string): void {
    this.#db.prepare(`
      INSERT INTO pipeline_runs (
        id, work_item_id, pipeline_id,
        definition_bundle_algorithm, definition_bundle_hash, definition_bundle_bytes,
        definition_bundle_encoding, definition_bundle_media_type, definition_bundle_payload_schema,
        current_subject, status, terminal_outcome, cursor_stage_id, cursor_version,
        cursor_reentries_json, cursor_frontier_json, cursor_completed_scope_keys_json,
        cursor_barrier_json, version, work_retry_limit, result_correction_limit,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      workItemId,
      run.pipeline_id,
      pointer.algorithm,
      pointer.digest,
      pointer.bytes,
      pointer.encoding,
      pointer.media_type,
      pointer.payload_schema,
      run.current_subject,
      run.status,
      run.terminal_outcome,
      run.cursor.stage_id,
      run.cursor.version,
      canonicalJson(run.cursor.reentries),
      canonicalJson(run.cursor.frontier),
      canonicalJson(run.cursor.completed_scope_keys),
      run.cursor.barrier === null ? null : canonicalJson(run.cursor.barrier),
      run.version,
      run.work_retry_limit,
      run.result_correction_limit,
      now,
      now,
    );
  }

  #runRow(id: string): RunRow {
    const row = this.#db.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(id) as RunRow | undefined;
    if (!row) throw new Error(`unknown pipeline run ${id}`);
    return row;
  }

  #runFromRow(row: RunRow): KernelRun {
    const attemptRows = this.#db.prepare(`
      SELECT id, version FROM attempts WHERE pipeline_run_id = ?
        AND status IN (${placeholders(ACTIVE_ATTEMPT_STATUSES.length)})
      ORDER BY id
    `).all(row.id, ...ACTIVE_ATTEMPT_STATUSES) as Array<{ id: string; version: number }>;
    const effectRows = this.#db.prepare(`
      SELECT id, version FROM effects WHERE pipeline_run_id = ?
        AND status IN (${placeholders(ACTIVE_EFFECT_STATUSES.length)})
      ORDER BY id
    `).all(row.id, ...ACTIVE_EFFECT_STATUSES) as Array<{ id: string; version: number }>;
    const checkpointRows = this.#db.prepare(`
      SELECT id, checkpoint_id FROM attempts
      WHERE pipeline_run_id = ? AND checkpoint_id IS NOT NULL ORDER BY id
    `).all(row.id) as Array<{ id: string; checkpoint_id: string }>;
    return {
      schema: KERNEL_RUN_SCHEMA,
      id: row.id,
      pipeline_id: row.pipeline_id,
      definition_bundle_hash: row.definition_bundle_hash,
      current_subject: row.current_subject,
      status: row.status,
      terminal_outcome: row.terminal_outcome,
      cursor: {
        stage_id: row.cursor_stage_id,
        version: row.cursor_version,
        reentries: parseJson(row.cursor_reentries_json, "cursor reentries"),
        frontier: parseJson(row.cursor_frontier_json, "cursor frontier"),
        completed_scope_keys: parseJson(row.cursor_completed_scope_keys_json, "completed scope keys"),
        barrier: row.cursor_barrier_json === null ? null : parseJson(row.cursor_barrier_json, "cursor barrier"),
      },
      version: row.version,
      work_retry_limit: row.work_retry_limit,
      result_correction_limit: row.result_correction_limit,
      active_attempt_versions: sortedRecord(attemptRows.map((attempt) => [attempt.id, attempt.version])),
      active_effect_versions: sortedRecord(effectRows.map((effect) => [effect.id, effect.version])),
      checkpoint_ids: Object.fromEntries(checkpointRows.map((checkpoint) => [checkpoint.id, checkpoint.checkpoint_id])),
    };
  }

  #attemptById(id: string, runId: string): KernelAttempt {
    const row = this.#db.prepare("SELECT * FROM attempts WHERE id = ? AND pipeline_run_id = ?")
      .get(id, runId) as AttemptRow | undefined;
    if (!row) throw new Error(`unknown attempt ${id} for pipeline run ${runId}`);
    return attemptFromRow(row);
  }

  #scopeColumns(scope: AttemptScope): [string | null, string | null, string | null, number | null] {
    if (scope.kind === "stage") return [null, null, null, null];
    return scope.kind === "loop_item"
      ? [scope.parent_attempt_id, scope.loop_id, scope.item_id, scope.item_index]
      : [scope.parent_attempt_id, scope.fanout_id, scope.member_id, scope.member_index];
  }

  #insertAttempt(attempt: KernelAttempt, now: string, workerId: string | null): void {
    const [parent, group, item, index] = this.#scopeColumns(attempt.scope);
    this.#db.prepare(`
      INSERT INTO attempts (
        id, pipeline_run_id, scope_kind, stage_id, parent_attempt_id, scope_group_id,
        scope_item_id, scope_item_index, repository_authority, request_hash,
        definition_bundle_hash, input_subject, output_subject, native_session_id,
        status, version, work_retry_ordinal, result_correction_count,
        result_correction_deadline, unmet_dependency_count,
        lease_id, lease_worker_id, lease_purpose, lease_expires_at, lease_started,
        checkpoint_id, result_record_id, pending_candidate_hash, pending_diagnostics_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attempt.id,
      attempt.pipeline_run_id,
      attempt.scope.kind,
      attempt.scope.stage_id,
      parent,
      group,
      item,
      index,
      attempt.repository_authority,
      attempt.request_hash,
      attempt.definition_bundle_hash,
      attempt.input_subject,
      attempt.output_subject,
      attempt.native_session_id,
      attempt.status,
      attempt.version,
      attempt.work_retry_ordinal,
      attempt.result_correction_count,
      attempt.result_correction_deadline,
      attempt.lease?.id ?? null,
      attempt.lease ? (workerId ?? attempt.lease.worker_id) : null,
      attempt.lease?.purpose ?? null,
      attempt.lease?.expires_at ?? null,
      attempt.lease ? (attempt.lease.started ? 1 : 0) : null,
      attempt.checkpoint_id,
      attempt.result_record_id,
      attempt.pending_result?.candidate_hash ?? null,
      attempt.pending_result === null ? null : canonicalJson(attempt.pending_result.diagnostics),
      now,
      now,
    );
  }

  #replaceAttempt(attempt: KernelAttempt, expectedVersion: number, runId: string): void {
    if (attempt.pipeline_run_id !== runId) throw new Error(`attempt ${attempt.id} belongs to another run`);
    const existing = this.#db.prepare("SELECT * FROM attempts WHERE id = ? AND pipeline_run_id = ?")
      .get(attempt.id, runId) as AttemptRow | undefined;
    if (!existing) throw new Error(`unknown attempt ${attempt.id}`);
    const [parent, group, item, index] = this.#scopeColumns(attempt.scope);
    if (
      attempt.lease && existing.lease_id === attempt.lease.id &&
      existing.lease_worker_id !== attempt.lease.worker_id
    ) throw new Error(`attempt ${attempt.id} lease worker cannot change inside its fence`);
    const worker = attempt.lease?.worker_id ?? null;
    const changed = this.#db.prepare(`
      UPDATE attempts SET
        scope_kind = ?, stage_id = ?, parent_attempt_id = ?, scope_group_id = ?,
        scope_item_id = ?, scope_item_index = ?, repository_authority = ?, request_hash = ?,
        definition_bundle_hash = ?, input_subject = ?, output_subject = ?, native_session_id = ?,
        status = ?, version = ?, work_retry_ordinal = ?, result_correction_count = ?,
        result_correction_deadline = ?, lease_id = ?, lease_worker_id = ?, lease_purpose = ?,
        lease_expires_at = ?, lease_started = ?, checkpoint_id = ?, result_record_id = ?,
        pending_candidate_hash = ?, pending_diagnostics_json = ?, updated_at = ?
      WHERE id = ? AND pipeline_run_id = ? AND version = ?
    `).run(
      attempt.scope.kind,
      attempt.scope.stage_id,
      parent,
      group,
      item,
      index,
      attempt.repository_authority,
      attempt.request_hash,
      attempt.definition_bundle_hash,
      attempt.input_subject,
      attempt.output_subject,
      attempt.native_session_id,
      attempt.status,
      attempt.version,
      attempt.work_retry_ordinal,
      attempt.result_correction_count,
      attempt.result_correction_deadline,
      attempt.lease?.id ?? null,
      worker,
      attempt.lease?.purpose ?? null,
      attempt.lease?.expires_at ?? null,
      attempt.lease ? (attempt.lease.started ? 1 : 0) : null,
      attempt.checkpoint_id,
      attempt.result_record_id,
      attempt.pending_result?.candidate_hash ?? null,
      attempt.pending_result === null ? null : canonicalJson(attempt.pending_result.diagnostics),
      this.#now(),
      attempt.id,
      runId,
      expectedVersion,
    );
    if (changed.changes !== 1) throw new Error(`attempt ${attempt.id} compare-and-set failed`);
  }

  #terminalAttempt(
    write: Extract<AtomicTransitionBundle["attempt_writes"][number], { kind: "terminal" }>,
    runId: string,
  ): void {
    const changed = this.#db.prepare(`
      UPDATE attempts SET status = ?, version = ?, lease_id = NULL, lease_worker_id = NULL,
        lease_purpose = NULL, lease_expires_at = NULL, lease_started = NULL, updated_at = ?
      WHERE id = ? AND pipeline_run_id = ? AND version = ?
    `).run(write.status, write.next_version, this.#now(), write.attempt_id, runId, write.expected_version);
    if (changed.changes !== 1) throw new Error(`attempt ${write.attempt_id} terminal compare-and-set failed`);
  }

  #recordFromRow(row: RecordRow): ExecutionRecord {
    const base = {
      schema: "openthrottle.record/v1" as const,
      id: row.id,
      pipeline_run_id: row.pipeline_run_id,
      payload_schema: row.payload_schema,
      payload: recordPayload(row),
      created_at: row.created_at,
    };
    const candidate: ExecutionRecord = row.kind === "result"
      ? {
        ...base,
        kind: "result",
        attempt_id: row.attempt_id!,
        request_hash: row.request_hash!,
        definition_bundle_hash: row.definition_bundle_hash!,
        input_subject: row.input_subject!,
        output_subject: row.output_subject,
        original_candidate_hash: row.original_candidate_hash!,
        normalized_candidate_hash: row.normalized_candidate_hash!,
      }
      : row.kind === "decision"
        ? {
          ...base,
          kind: "decision",
          reducer: row.reducer!,
          input_record_ids: parseJson(row.input_record_ids_json!, "DecisionRecord inputs"),
        }
        : {
          ...base,
          kind: "delivery",
          effect_id: row.effect_id!,
          idempotency_key: row.idempotency_key!,
          external_identity: row.external_identity!,
          status: row.delivery_status!,
        };
    return validateExecutionRecord(candidate, { payloadSchemas: this.#payloadSchemas }).value;
  }

  #checkpointFromRow(row: CheckpointRow): AttemptCheckpoint {
    return validateAttemptCheckpoint({
      schema: "openthrottle.attempt-checkpoint/v1",
      id: row.id,
      pipeline_run_id: row.pipeline_run_id,
      attempt_id: row.attempt_id,
      request_hash: row.request_hash,
      definition_bundle_hash: row.definition_bundle_hash,
      input_subject: row.input_subject,
      output_subject: row.output_subject,
      native_session_id: row.native_session_id,
      payload_schema: row.payload_schema,
      payload: recordPayload(row),
      captured_at: row.captured_at,
    }).value;
  }

  #insertRecord(recordInput: ExecutionRecord): void {
    const record = validateExecutionRecord(recordInput, { payloadSchemas: this.#payloadSchemas }).value;
    const payload = this.#recordPayloadColumns(record.payload, record.payload_schema);
    if (record.kind === "result") {
      const owner = this.#attemptById(record.attempt_id, record.pipeline_run_id);
      if (
        owner.request_hash !== record.request_hash || owner.definition_bundle_hash !== record.definition_bundle_hash ||
        owner.input_subject !== record.input_subject || owner.output_subject !== record.output_subject
      ) throw new Error(`ResultRecord ${record.id} does not match its attempt identity`);
    }
    if (record.kind === "decision") {
      for (const inputId of record.input_record_ids) {
        const input = this.#db.prepare("SELECT pipeline_run_id FROM records WHERE id = ?").get(inputId) as
          | { pipeline_run_id: string }
          | undefined;
        if (!input || input.pipeline_run_id !== record.pipeline_run_id) {
          throw new Error(`DecisionRecord ${record.id} references unavailable input ${inputId}`);
        }
      }
    }
    if (record.kind === "delivery") {
      const effect = this.#db.prepare(`
        SELECT pipeline_run_id, idempotency_key, target FROM effects WHERE id = ?
      `).get(record.effect_id) as { pipeline_run_id: string; idempotency_key: string; target: string } | undefined;
      if (
        !effect || effect.pipeline_run_id !== record.pipeline_run_id ||
        effect.idempotency_key !== record.idempotency_key || effect.target !== record.external_identity
      ) throw new Error(`DeliveryRecord ${record.id} does not match its effect identity`);
    }
    const next = this.#db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM records WHERE pipeline_run_id = ?")
      .get(record.pipeline_run_id) as { sequence: number };
    this.#db.prepare(`
      INSERT INTO records (
        id, pipeline_run_id, sequence, record_hash, kind, semantic_key, payload_schema,
        inline_payload, blob_algorithm, blob_digest, blob_bytes, blob_encoding,
        blob_media_type, blob_payload_schema, attempt_id, request_hash,
        definition_bundle_hash, input_subject, output_subject, original_candidate_hash,
        normalized_candidate_hash, reducer, input_record_ids_json, input_record_count,
        effect_id, idempotency_key, external_identity, delivery_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.pipeline_run_id,
      next.sequence,
      digestCanonicalJson(record),
      record.kind,
      semanticKey(record),
      record.payload_schema,
      payload.inline_payload,
      payload.blob_algorithm,
      payload.blob_digest,
      payload.blob_bytes,
      payload.blob_encoding,
      payload.blob_media_type,
      payload.blob_payload_schema,
      record.kind === "result" ? record.attempt_id : null,
      record.kind === "result" ? record.request_hash : null,
      record.kind === "result" ? record.definition_bundle_hash : null,
      record.kind === "result" ? record.input_subject : null,
      record.kind === "result" ? record.output_subject : null,
      record.kind === "result" ? record.original_candidate_hash : null,
      record.kind === "result" ? record.normalized_candidate_hash : null,
      record.kind === "decision" ? record.reducer : null,
      record.kind === "decision" ? canonicalJson(record.input_record_ids) : null,
      record.kind === "decision" ? record.input_record_ids.length : null,
      record.kind === "delivery" ? record.effect_id : null,
      record.kind === "delivery" ? record.idempotency_key : null,
      record.kind === "delivery" ? record.external_identity : null,
      record.kind === "delivery" ? record.status : null,
      record.created_at,
    );
  }

  #insertCheckpoint(checkpointInput: AttemptCheckpoint): void {
    const checkpoint = validateAttemptCheckpoint(checkpointInput).value;
    const payload = this.#recordPayloadColumns(checkpoint.payload, checkpoint.payload_schema);
    const attempt = this.#attemptById(checkpoint.attempt_id, checkpoint.pipeline_run_id);
    if (
      attempt.request_hash !== checkpoint.request_hash ||
      attempt.definition_bundle_hash !== checkpoint.definition_bundle_hash ||
      attempt.input_subject !== checkpoint.input_subject
    ) throw new Error(`checkpoint ${checkpoint.id} does not match its attempt identity`);
    const ordinal = this.#db.prepare(`
      SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM checkpoints WHERE attempt_id = ?
    `).get(checkpoint.attempt_id) as { ordinal: number };
    this.#db.prepare(`
      INSERT INTO checkpoints (
        id, pipeline_run_id, attempt_id, ordinal, checkpoint_hash, semantic_key,
        request_hash, definition_bundle_hash, input_subject, output_subject,
        native_session_id, payload_schema, inline_payload, blob_algorithm, blob_digest,
        blob_bytes, blob_encoding, blob_media_type, blob_payload_schema, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkpoint.id,
      checkpoint.pipeline_run_id,
      checkpoint.attempt_id,
      ordinal.ordinal,
      digestCanonicalJson(checkpoint),
      checkpoint.payload_schema,
      checkpoint.request_hash,
      checkpoint.definition_bundle_hash,
      checkpoint.input_subject,
      checkpoint.output_subject,
      checkpoint.native_session_id,
      checkpoint.payload_schema,
      payload.inline_payload,
      payload.blob_algorithm,
      payload.blob_digest,
      payload.blob_bytes,
      payload.blob_encoding,
      payload.blob_media_type,
      payload.blob_payload_schema,
      checkpoint.captured_at,
    );
  }

  #recordPayloadColumns(payload: RecordPayload, schema: string): PayloadColumns {
    if ("inline" in payload) return this.#payloadInput({ payload_schema: schema, payload });
    const token = this.#blobs.verify(payload.blob);
    return this.#payloadInput({ payload_schema: schema, payload: { blob: token } });
  }

  #insertEffect(effectInput: EffectIntent): void {
    const effect = validateEffectIntent(effectInput).value;
    const decision = this.#db.prepare("SELECT kind, pipeline_run_id FROM records WHERE id = ?")
      .get(effect.decision_record_id) as { kind: string; pipeline_run_id: string } | undefined;
    if (!decision || decision.kind !== "decision" || decision.pipeline_run_id !== effect.pipeline_run_id) {
      throw new Error(`effect ${effect.id} is not owned by a DecisionRecord in its run`);
    }
    const payload = this.#payloadInput({
      payload_schema: effect.kind,
      payload: { inline: effect.payload as JsonValue },
    });
    const now = this.#now();
    this.#db.prepare(`
      INSERT INTO effects (
        id, pipeline_run_id, decision_record_id, decision_record_kind, kind,
        idempotency_key, target, subject, payload_schema,
        inline_payload, blob_algorithm, blob_digest, blob_bytes, blob_encoding,
        blob_media_type, blob_payload_schema, intent_hash, status, version,
        attempt_count, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'decision', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, ?)
    `).run(
      effect.id,
      effect.pipeline_run_id,
      effect.decision_record_id,
      effect.kind,
      effect.idempotency_key,
      effect.target,
      effect.subject,
      effect.kind,
      payload.inline_payload,
      payload.blob_algorithm,
      payload.blob_digest,
      payload.blob_bytes,
      payload.blob_encoding,
      payload.blob_media_type,
      payload.blob_payload_schema,
      effectIntentContentHash(effect),
      now,
      now,
      now,
    );
  }

  #cancelEffect(effectId: string, runId: string): void {
    const changed = this.#db.prepare(`
      UPDATE effects SET status = 'canceled', version = version + 1,
        lease_id = NULL, lease_worker_id = NULL, lease_expires_at = NULL,
        lease_execution_mode = NULL, unknown_detail = NULL, updated_at = ?
      WHERE id = ? AND pipeline_run_id = ? AND status IN ('pending', 'processing', 'unknown')
    `).run(this.#now(), effectId, runId);
    if (changed.changes !== 1) throw new Error(`effect ${effectId} cannot be canceled from its current fence`);
  }

  #effectIntentById(id: string): EffectIntent {
    const row = this.#db.prepare("SELECT * FROM effects WHERE id = ?").get(id) as EffectRow | undefined;
    if (!row) throw new Error(`unknown effect ${id}`);
    let payload: unknown;
    const pointer = payloadPointer(row);
    if (pointer) {
      const bytes = this.#readBlob(row.pipeline_run_id, "effect", row.id, pointer);
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

  #preverifyTransitionBlobs(bundle: AtomicTransitionBundle): void {
    for (const record of bundle.append_records) {
      if ("blob" in record.payload) this.#blobs.assertToken(this.#blobs.verify(record.payload.blob), record.payload.blob);
    }
    for (const checkpoint of bundle.append_checkpoints) {
      if ("blob" in checkpoint.payload) {
        this.#blobs.assertToken(this.#blobs.verify(checkpoint.payload.blob), checkpoint.payload.blob);
      }
    }
  }

  #loadExactRecords(
    runId: string,
    ids: readonly string[],
    runStatus: KernelRun["status"],
  ): ReadonlyMap<string, ExecutionRecord> {
    if (new Set(ids).size !== ids.length) throw new Error("record allowlist contains duplicate IDs");
    if (ids.length === 0) return new Map();
    const rows = this.#db.prepare(`
      SELECT * FROM records WHERE pipeline_run_id = ? AND id IN (${placeholders(ids.length)}) ORDER BY id
    `).all(runId, ...ids) as RecordRow[];
    if (rows.length !== ids.length) throw new Error("exact record context is missing an authorized record");
    const records = new Map<string, ExecutionRecord>();
    for (const row of rows) {
      const pointer = payloadPointer(row);
      if (pointer) {
        const bytes = this.#readBlob(runId, "record", row.id, pointer, runStatus);
        if (pointer.encoding === "utf-8" && pointer.media_type === "application/json") {
          const contract = this.#payloadSchemas.get(row.payload_schema);
          if (!contract) throw new Error(`record payload schema ${row.payload_schema} is not registered`);
          contract.parseInline(parseJson(bytes.toString("utf8"), `record ${row.id} blob`), `record.${row.id}.payload`);
        }
      }
      records.set(row.id, this.#recordFromRow(row));
    }
    return records;
  }

  #loadExactCheckpoints(
    runId: string,
    ids: readonly string[],
    runStatus: KernelRun["status"],
  ): ReadonlyMap<string, AttemptCheckpoint> {
    if (new Set(ids).size !== ids.length) throw new Error("checkpoint allowlist contains duplicate IDs");
    if (ids.length === 0) return new Map();
    const rows = this.#db.prepare(`
      SELECT * FROM checkpoints WHERE pipeline_run_id = ? AND id IN (${placeholders(ids.length)}) ORDER BY id
    `).all(runId, ...ids) as CheckpointRow[];
    if (rows.length !== ids.length) throw new Error("exact checkpoint context is missing an authorized checkpoint");
    const checkpoints = new Map<string, AttemptCheckpoint>();
    for (const row of rows) {
      const pointer = payloadPointer(row);
      if (pointer) this.#readBlob(runId, "checkpoint", row.id, pointer, runStatus);
      checkpoints.set(row.id, this.#checkpointFromRow(row));
    }
    return checkpoints;
  }

  #readBlob(
    runId: string,
    ownerKind: KernelIntegrityEvidence["owner_kind"],
    ownerId: string,
    pointer: BlobPointer,
    knownStatus?: KernelRun["status"],
  ): Buffer {
    try {
      return this.#blobs.read(pointer);
    } catch (error) {
      if (!(error instanceof BlobIntegrityError)) throw error;
      const status = knownStatus ?? this.#runRow(runId).status;
      const active = ACTIVE_RUN_STATUSES.has(status);
      throw new KernelIntegrityError({
        pipeline_run_id: runId,
        owner_kind: ownerKind,
        owner_id: ownerId,
        digest: pointer.digest,
        classification: active ? "active_blocking" : "settled_history_incident",
        operator_action: active
          ? "restore_verified_blob_or_abandon_active_run"
          : "raise_global_integrity_incident",
        detail: error.detail,
      });
    }
  }

  #materializeDependencyReadiness(cursor: KernelCursor): void {
    const completed = new Set(cursor.completed_scope_keys);
    const frontierIds = new Set<string>();
    for (const member of cursor.frontier) {
      if (frontierIds.has(member.attempt_id)) throw new Error("cursor frontier repeats an attempt identity");
      frontierIds.add(member.attempt_id);
      const unmet = member.depends_on.filter((dependency) => !completed.has(dependency)).length;
      const changed = this.#db.prepare(`
        UPDATE attempts SET unmet_dependency_count = ? WHERE id = ?
      `).run(unmet, member.attempt_id);
      if (changed.changes !== 1) throw new Error(`cursor frontier references unknown attempt ${member.attempt_id}`);
    }
  }

  #assertRunProjections(expected: KernelRun): void {
    const attempts = this.#db.prepare(`
      SELECT id, version FROM attempts WHERE pipeline_run_id = ?
        AND status IN (${placeholders(ACTIVE_ATTEMPT_STATUSES.length)}) ORDER BY id
    `).all(expected.id, ...ACTIVE_ATTEMPT_STATUSES) as Array<{ id: string; version: number }>;
    const effects = this.#db.prepare(`
      SELECT id, version FROM effects WHERE pipeline_run_id = ?
        AND status IN (${placeholders(ACTIVE_EFFECT_STATUSES.length)}) ORDER BY id
    `).all(expected.id, ...ACTIVE_EFFECT_STATUSES) as Array<{ id: string; version: number }>;
    const checkpoints = this.#db.prepare(`
      SELECT id, checkpoint_id FROM attempts WHERE pipeline_run_id = ? AND checkpoint_id IS NOT NULL ORDER BY id
    `).all(expected.id) as Array<{ id: string; checkpoint_id: string }>;
    if (
      canonicalJson(sortedRecord(attempts.map((row) => [row.id, row.version]))) !==
        canonicalJson(expected.active_attempt_versions) ||
      canonicalJson(sortedRecord(effects.map((row) => [row.id, row.version]))) !==
        canonicalJson(expected.active_effect_versions) ||
      canonicalJson(Object.fromEntries(checkpoints.map((row) => [row.id, row.checkpoint_id]))) !==
        canonicalJson(expected.checkpoint_ids)
    ) throw new Error("kernel run projections do not match their typed owner rows");
  }

  #updateRun(bundle: AtomicTransitionBundle, previous: RunRow): number {
    const run = bundle.run;
    return this.#db.prepare(`
      UPDATE pipeline_runs SET
        current_subject = ?, status = ?, terminal_outcome = ?, cursor_stage_id = ?,
        cursor_version = ?, cursor_reentries_json = ?, cursor_frontier_json = ?,
        cursor_completed_scope_keys_json = ?, cursor_barrier_json = ?, version = ?,
        work_retry_limit = ?, result_correction_limit = ?, last_transition_id = ?,
        last_transition_hash = ?, updated_at = ?
      WHERE id = ? AND version = ? AND cursor_version = ?
    `).run(
      run.current_subject,
      run.status,
      run.terminal_outcome,
      run.cursor.stage_id,
      run.cursor.version,
      canonicalJson(run.cursor.reentries),
      canonicalJson(run.cursor.frontier),
      canonicalJson(run.cursor.completed_scope_keys),
      run.cursor.barrier === null ? null : canonicalJson(run.cursor.barrier),
      run.version,
      run.work_retry_limit,
      run.result_correction_limit,
      bundle.transition_id,
      bundle.content_hash,
      this.#now(),
      previous.id,
      bundle.expected.run_version,
      bundle.expected.cursor_version,
    ).changes;
  }

  #advanceRunFence(runId: string, transitionId: string, content: unknown): KernelRun {
    const row = this.#runRow(runId);
    const hash = digestCanonicalJson(content);
    const changed = this.#db.prepare(`
      UPDATE pipeline_runs SET version = version + 1, last_transition_id = ?,
        last_transition_hash = ?, updated_at = ? WHERE id = ? AND version = ?
    `).run(transitionId, hash, this.#now(), runId, row.version);
    if (changed.changes !== 1) throw new Error(`pipeline run ${runId} lease fence compare-and-set failed`);
    return this.#runFromRow(this.#runRow(runId));
  }
}
