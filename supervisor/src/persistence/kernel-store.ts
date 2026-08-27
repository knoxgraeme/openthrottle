import type Database from "better-sqlite3";
import {
  canonicalJson,
  compareCodeUnits,
  DEFINITION_BUNDLE_SCHEMA,
  digestCanonicalJson,
  INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA,
  validateAttemptCheckpoint,
  validateAttemptForensicsPayload,
  validateEffectIntent,
  validateExecutionRecord,
  validateInvalidResultEvidencePayload,
  type AttemptForensicsPayload,
  type AttemptCheckpoint,
  type BlobPointer,
  type CompiledPipelineManifest,
  type DecisionRecord,
  type DeliveryRecord,
  type EffectIntent,
  type ExecutionRecord,
  type ExecutionRecordPayloadRegistry,
  type JsonValue,
  type InvalidResultEvidencePayload,
  type RecordPayload,
} from "@openthrottle/contracts";
import type {
  AttemptLeaseRequest,
  AttemptLeaseClaim,
  KernelAttemptLeasePort,
  KernelAttemptRecoveryQuarantinePort,
  KernelAttemptRequestPort,
  KernelAttemptRequestInputs,
  KernelContinuationCandidate,
  KernelContinuationPageRequest,
  KernelDefinitionBundleBytesPort,
  KernelEffectPort,
  KernelExternalSchedulePort,
  KernelOperatorEffectRejectionPort,
  KernelOperatorEffectRejectionRequest,
  KernelOperatorEffectRejectionResult,
  KernelReductionPort,
  KernelStructuredPlanningReadPort,
  LeasedAttemptView,
  LeasedEffectView,
  ReductionReadRequest,
  ReductionView,
  SettledStructuredPlanningAttempt,
  StructuredPlanningReadRequest,
  ExternalScheduleView,
} from "../pipeline/kernel/ports.js";
import { KERNEL_WORK_REQUEST_PAYLOAD_SCHEMA } from "../pipeline/kernel/ports.js";
import {
  effectIntentContentHash,
  type EffectReconciliation,
} from "../pipeline/kernel/effect-intent.js";
import {
  KernelOperatorEffectRejectionConflictError,
  KernelOperatorEffectRejectionNotFoundError,
  assertExactOperatorEffectRejectionReplay,
  createOperatorEffectRejectionDelivery,
  operatorEffectRejectionResolutionDigest,
} from "../pipeline/kernel/operator-effect-rejection.js";
import {
  KERNEL_RUN_SCHEMA,
  canonicalAttemptContextIds,
  type AtomicTransitionBundle,
  type KernelAttempt,
  type KernelCursor,
  type KernelRun,
  type QuarantineAttemptRecoveryCommand,
} from "../pipeline/kernel/types.js";
import { reduceKernelRecoveryQuarantine } from "../pipeline/kernel/reducer.js";
import {
  ATTEMPT_FORENSICS_REDUCER,
  INVALID_RESULT_EVIDENCE_REDUCER,
  assertExactInvalidResultEvidenceRecord,
  attemptForensicsRecordId,
} from "../pipeline/kernel/attempt-evidence.js";
import {
  transitionApplicationDisposition,
  type AtomicTransitionApplyResult,
} from "../pipeline/kernel/store.js";
import {
  BlobIntegrityError,
  VolumeBlobStore,
  type VerifiedBlobToken,
} from "./blob-store.js";
import {
  attemptFromRow,
  checkpointFromRow,
  parseJson,
  payloadPointer,
  placeholders,
  recordFromRow,
  serializePendingResultDiagnostics,
  scopeColumns,
  semanticKey,
  sortedRecord,
  type AttemptRow,
  type CheckpointRow,
  type EffectRow,
  type PayloadColumns,
  type PayloadRow,
  type RecordRow,
  type RunRow,
} from "./kernel-store-codecs.js";
import {
  ACTIVE_ATTEMPT_STATUSES,
  ACTIVE_EFFECT_STATUSES,
  ACTIVE_RUN_STATUS_SET,
} from "./kernel-active-statuses.js";
import { KernelLeaseOperations } from "./kernel-store-leases.js";
import { KERNEL_INGRESS_MAINTENANCE_SETTING } from "./epoch-schema.js";

const STRUCTURED_PLANNING_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export interface KernelManifestResolver {
  resolve(input: {
    pipeline_id: string;
    definition_bundle_hash: string;
    definition_bundle_bytes: Uint8Array;
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
  originating_inbox?: PipelineAdmissionInboxFence;
}

export interface PipelineAdmissionInboxFence {
  event_id: string;
  source_provider: string;
  delivery_id: string;
  kind: string;
  payload_hash: string;
  lease_id: string;
  lease_owner_id: string;
  version: number;
}

export interface PipelineRunAttachmentInput {
  work_item_id: string;
  source_pipeline_run_id: string;
  definitions: readonly DefinitionSnapshotInput[];
  run: KernelRun;
  definition_bundle: VerifiedBlobToken;
  initial_records: readonly ExecutionRecord[];
  initial_attempts: readonly KernelAttempt[];
}

export interface AttachedPipelineRunIdentity {
  id: string;
  work_item_id: string;
  pipeline_id: string;
  definition_bundle_hash: string;
  current_subject: string;
}

export type KernelStoreFaultPoint =
  | "admission_definitions_written"
  | "admission_work_item_written"
  | "admission_run_written"
  | "admission_attempts_written"
  | "admission_inbox_consumed";

export interface KernelIntegrityEvidence {
  pipeline_run_id: string;
  owner_kind: "attempt" | "record" | "checkpoint" | "effect" | "definition_bundle" | "work_item";
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

export class SqliteKernelStore implements
  KernelReductionPort,
  KernelAttemptLeasePort,
  KernelAttemptRecoveryQuarantinePort,
  KernelAttemptRequestPort,
  KernelDefinitionBundleBytesPort,
  KernelEffectPort,
  KernelOperatorEffectRejectionPort,
  KernelExternalSchedulePort,
  KernelStructuredPlanningReadPort {
  readonly #db: Database.Database;
  readonly #blobs: VolumeBlobStore;
  readonly #manifests: KernelManifestResolver;
  readonly #payloadSchemas: ExecutionRecordPayloadRegistry;
  readonly #now: () => string;
  readonly #faultInjector: ((point: KernelStoreFaultPoint) => void) | undefined;
  readonly #leases: KernelLeaseOperations;

  constructor(input: {
    db: Database.Database;
    blob_store: VolumeBlobStore;
    manifest_resolver: KernelManifestResolver;
    payload_schemas: ExecutionRecordPayloadRegistry;
    execution_policy: { readonly max_concurrent_attempts: 1 };
    execution_width?: number;
    now?: () => string;
    fault_injector?: (point: KernelStoreFaultPoint) => void;
  }) {
    this.#db = input.db;
    this.#blobs = input.blob_store;
    this.#manifests = input.manifest_resolver;
    this.#payloadSchemas = input.payload_schemas;
    this.#now = input.now ?? (() => new Date().toISOString());
    this.#faultInjector = input.fault_injector;
    this.#leases = new KernelLeaseOperations({
      db: this.#db,
      now: this.#now,
      attempt_by_id: (id, runId) => this.#attemptById(id, runId),
      advance_run_fence: (runId, transitionId, content) => this.#advanceRunFence(runId, transitionId, content),
      insert_record: (record) => this.#insertRecord(record),
      read_effect_blob: (runId, ownerId, pointer) => this.#readBlob(runId, "effect", ownerId, pointer),
      execution_policy: input.execution_policy,
      execution_width: input.execution_width ?? 1,
    });
  }

  admitPipelineRun(input: PipelineAdmissionInput): void {
    const pointer = this.#blobs.assertToken(input.definition_bundle);
    if (
      pointer.digest !== input.run.definition_bundle_hash ||
      pointer.payload_schema !== DEFINITION_BUNDLE_SCHEMA ||
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
    this.#preverifyAttemptBlobs(input.initial_attempts);
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
      if (input.originating_inbox) {
        const inbox = input.originating_inbox;
        if (!Number.isSafeInteger(inbox.version) || inbox.version < 1) {
          throw new Error("originating inbox admission fence has an invalid version");
        }
        const consumed = this.#db.prepare(`
          UPDATE inbox_events
          SET status = 'consumed', lease_id = NULL, lease_owner_id = NULL,
              lease_expires_at = NULL, version = version + 1, consumed_at = ?
          WHERE id = ? AND source_provider = ? AND delivery_id = ? AND kind = ? AND payload_hash = ?
            AND status = 'processing' AND lease_id = ? AND lease_owner_id = ? AND version = ?
            AND work_item_id IS NULL AND pipeline_run_id IS NULL AND attempt_id IS NULL
        `).run(
          now,
          inbox.event_id,
          inbox.source_provider,
          inbox.delivery_id,
          inbox.kind,
          inbox.payload_hash,
          inbox.lease_id,
          inbox.lease_owner_id,
          inbox.version,
        );
        if (consumed.changes !== 1) {
          throw new Error("originating inbox admission fence does not match its processing lease");
        }
        this.#fault("admission_inbox_consumed");
      }
    }).immediate();
  }

  attachPipelineRun(input: PipelineRunAttachmentInput): void {
    const pointer = this.#blobs.assertToken(input.definition_bundle);
    if (
      pointer.digest !== input.run.definition_bundle_hash ||
      pointer.payload_schema !== DEFINITION_BUNDLE_SCHEMA ||
      pointer.encoding !== "utf-8" || pointer.media_type !== "application/json"
    ) throw new Error("attached pipeline run definition bundle does not match its pinned identity");
    const expectedAttempts = sortedRecord(input.initial_attempts.map((attempt) => [attempt.id, attempt.version]));
    if (canonicalJson(expectedAttempts) !== canonicalJson(input.run.active_attempt_versions)) {
      throw new Error("attached initial attempts do not match the run projection");
    }
    if (
      Object.keys(input.run.active_effect_versions).length > 0 ||
      Object.keys(input.run.checkpoint_ids).length > 0
    ) throw new Error("an attached fresh run cannot contain effects or checkpoints");
    if (
      input.initial_records.some((record) =>
        record.pipeline_run_id !== input.run.id ||
        record.kind !== "decision" || record.input_record_ids.length !== 0)
    ) throw new Error("attached run seed records must be input-free executor decisions in the target run");
    this.#preverifyAttemptBlobs(input.initial_attempts);
    const now = this.#now();
    this.#db.transaction(() => {
      const source = this.#db.prepare("SELECT work_item_id FROM pipeline_runs WHERE id = ?")
        .get(input.source_pipeline_run_id) as { work_item_id: string } | undefined;
      if (!source || source.work_item_id !== input.work_item_id) {
        throw new Error("attached pipeline run does not share its source work item");
      }
      this.#insertDefinitions(input.definitions);
      this.#insertRun(input.work_item_id, input.run, pointer, now);
      for (const record of input.initial_records) this.#insertRecord(record);
      for (const attempt of input.initial_attempts) this.#insertAttempt(attempt, now, null);
      this.#materializeDependencyReadiness(input.run.cursor);
      this.#assertRunProjections(input.run);
    }).immediate();
  }

  findAttachedPipelineRun(id: string): AttachedPipelineRunIdentity | undefined {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(id)) {
      throw new Error("attached pipeline run ID is invalid");
    }
    return this.#db.prepare(`
      SELECT id, work_item_id, pipeline_id, definition_bundle_hash, current_subject
      FROM pipeline_runs WHERE id = ?
    `).get(id) as AttachedPipelineRunIdentity | undefined;
  }

  async loadExactReductionView(request: ReductionReadRequest): Promise<ReductionView> {
    const row = this.#runRow(request.pipeline_run_id);
    const run = this.#runFromRow(row);
    const currentAttempt = request.attempt_id === null
      ? null
      : this.#attemptById(request.attempt_id, request.pipeline_run_id);
    const records = this.#loadExactRecords(request.pipeline_run_id, request.record_ids, run.status);
    const checkpoints = this.#loadExactCheckpoints(request.pipeline_run_id, request.checkpoint_ids, run.status);
    const definitionBundleBytes = await this.loadExactDefinitionBundleBytes({
      pipeline_run_id: run.id,
      definition_bundle_hash: run.definition_bundle_hash,
    });
    const manifest = await this.#manifests.resolve({
      pipeline_id: run.pipeline_id,
      definition_bundle_hash: run.definition_bundle_hash,
      definition_bundle_bytes: definitionBundleBytes,
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

      const replacementAttempts = new Map(bundle.attempt_writes.flatMap((write) =>
        write.kind === "replace" ? [[write.attempt.id, write.attempt] as const] : []));
      for (const record of bundle.append_records) {
        this.#insertRecord(record, replacementAttempts);
      }
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
    return this.#leases.leaseNextEligibleAttempt(request);
  }

  async renewAttemptLease(input: {
    attempt_id: string;
    lease_id: string;
    lease_generation: number;
    worker_id: string;
    expires_at: string;
  }): Promise<NonNullable<KernelAttempt["lease"]>> {
    return this.#leases.renewAttemptLease(input);
  }

  async recoverExpiredAttemptLeases(input: {
    observed_at: string;
    expires_at: string;
    limit: number;
  }): Promise<readonly LeasedAttemptView[]> {
    return this.#leases.recoverExpiredAttemptLeases(input);
  }

  async quarantineExhaustedAttemptRecovery(input: {
    claim: AttemptLeaseClaim;
    diagnostic: DecisionRecord;
    reason: string;
  }): Promise<boolean> {
    const run = this.#runFromRow(this.#runRow(input.claim.run_id));
    const attempt = this.#attemptById(input.claim.attempt_id, input.claim.run_id);
    const lease = attempt.lease;
    if (
      !lease || lease.id !== input.claim.lease_id ||
      lease.generation !== input.claim.lease_generation ||
      lease.worker_id !== input.claim.worker_id || lease.purpose !== input.claim.purpose
    ) throw new Error("Attempt recovery quarantine lease claim is stale or mismatched");
    if (lease.generation < run.work_retry_limit) return false;
    const command: QuarantineAttemptRecoveryCommand = {
      type: "quarantine_attempt_recovery",
      command_id: `recovery-quarantine-${digestCanonicalJson({
        attempt_id: attempt.id,
        lease_id: lease.id,
        lease_generation: lease.generation,
        diagnostic_id: input.diagnostic.id,
      }).slice(0, 48)}`,
      attempt_id: attempt.id,
      decision_record_id: input.diagnostic.id,
      reason: input.reason,
      lease_id: lease.id,
      lease_generation: lease.generation,
      worker_id: lease.worker_id,
      lease_purpose: lease.purpose,
    };
    const transition = reduceKernelRecoveryQuarantine({
      run,
      current_attempt: attempt,
      diagnostic: input.diagnostic,
      command,
    });
    await this.applyAtomicTransition(transition);
    return true;
  }

  async leaseNextEffect(input: {
    worker_id: string;
    lease_id: string;
    expires_at: string;
  }): Promise<LeasedEffectView | null> {
    return this.#leases.leaseNextEffect(input);
  }

  async markLeasedEffectDispatchStarted(input: {
    effect_id: string;
    lease_id: string;
    worker_id: string;
  }): Promise<LeasedEffectView> {
    return this.#leases.markLeasedEffectDispatchStarted(input);
  }

  async completeLeasedEffect(input: {
    effect_id: string;
    lease_id: string;
    worker_id: string;
    reconciliation: EffectReconciliation;
  }): Promise<void> {
    return this.#leases.completeLeasedEffect(input);
  }

  async rejectDispatchFencedUnknownEffect(
    input: KernelOperatorEffectRejectionRequest,
  ): Promise<KernelOperatorEffectRejectionResult> {
    return this.#db.transaction((): KernelOperatorEffectRejectionResult => {
      const maintenance = this.#db.prepare(`
        SELECT value_json, value_type, mutable, version
        FROM settings WHERE key = ?
      `).get(KERNEL_INGRESS_MAINTENANCE_SETTING) as {
        value_json: string;
        value_type: string;
        mutable: number;
        version: number;
      } | undefined;
      if (
        !maintenance || maintenance.value_json !== "true" ||
        maintenance.value_type !== "boolean" || maintenance.mutable !== 1 ||
        maintenance.version !== input.expected_maintenance_version
      ) {
        throw new KernelOperatorEffectRejectionConflictError(
          "operator Effect rejection requires the exact closed maintenance fence",
        );
      }

      const row = this.#db.prepare(`
        SELECT e.*, r.status AS run_status, r.version AS run_version
        FROM effects e
        JOIN pipeline_runs r ON r.id = e.pipeline_run_id
        WHERE e.id = ? AND e.pipeline_run_id = ?
      `).get(input.effect_id, input.pipeline_run_id) as (EffectRow & {
        run_status: KernelRun["status"];
        run_version: number;
      }) | undefined;
      if (!row) {
        throw new KernelOperatorEffectRejectionNotFoundError(
          "operator Effect rejection does not match an exact pipeline run and Effect",
        );
      }
      const intent = this.#leases.effectIntentFromRow(row);
      const deliveryRow = this.#db.prepare(`
        SELECT * FROM records
        WHERE pipeline_run_id = ? AND effect_id = ? AND kind = 'delivery'
      `).get(row.pipeline_run_id, row.id) as RecordRow | undefined;
      const runtimeCreateRows = this.#db.prepare(`
        SELECT runtime_effect.*
        FROM effects runtime_effect
        JOIN records delivery
          ON delivery.id = runtime_effect.delivery_record_id
          AND delivery.pipeline_run_id = runtime_effect.pipeline_run_id
          AND delivery.effect_id = runtime_effect.id
        WHERE runtime_effect.pipeline_run_id = ?
          AND runtime_effect.kind = 'daytona/create-sandbox@1'
          AND runtime_effect.status = 'acknowledged'
          AND delivery.kind = 'delivery'
          AND delivery.delivery_status = 'confirmed'
        ORDER BY runtime_effect.id
        LIMIT 2
      `).all(row.pipeline_run_id) as EffectRow[];
      if (runtimeCreateRows.length !== 1) {
        throw new KernelOperatorEffectRejectionConflictError(
          "operator Effect rejection requires one exact confirmed runtime creation",
        );
      }
      const runtimeCreateIntent = this.#leases.effectIntentFromRow(runtimeCreateRows[0]!);
      if (effectIntentContentHash(runtimeCreateIntent) !== runtimeCreateRows[0]!.intent_hash) {
        throw new KernelOperatorEffectRejectionConflictError(
          "operator Effect rejection runtime creation failed its exact intent hash",
        );
      }

      if (row.status === "rejected") {
        if (
          row.delivery_record_id === null || deliveryRow === undefined ||
          deliveryRow.id !== row.delivery_record_id ||
          row.lease_id !== null || row.lease_worker_id !== null ||
          row.lease_expires_at !== null || row.lease_execution_mode !== null ||
          row.dispatch_lease_id === null || row.dispatch_worker_id === null
        ) {
          throw new KernelOperatorEffectRejectionConflictError(
            "settled Effect does not contain an exact operator rejection fence",
          );
        }
        const existing = recordFromRow(deliveryRow, this.#payloadSchemas);
        if (existing.kind !== "delivery") {
          throw new KernelOperatorEffectRejectionConflictError(
            "settled Effect does not reference a DeliveryRecord",
          );
        }
        assertExactOperatorEffectRejectionReplay({
          request: input,
          intent,
          delivery: existing,
          current_run_version: row.run_version,
          current_effect_version: row.version,
          current_intent_hash: row.intent_hash,
          current_dispatch_fence: {
            lease_id: row.dispatch_lease_id,
            worker_id: row.dispatch_worker_id,
          },
          reconciliation_ordinal: row.attempt_count,
          runtime_create_intent: runtimeCreateIntent,
        });
        return {
          disposition: "unchanged",
          pipeline_run_id: row.pipeline_run_id,
          effect_id: row.id,
          delivery_record_id: existing.id,
          effect_version: row.version,
          run_version: row.run_version,
        };
      }

      if (
        !ACTIVE_RUN_STATUS_SET.has(row.run_status) || row.status !== "unknown" ||
        row.kind !== "daytona/integrate-checkpoint@1" ||
        row.lease_id !== null || row.lease_worker_id !== null ||
        row.lease_expires_at !== null || row.lease_execution_mode !== null ||
        row.dispatch_lease_id === null || row.dispatch_worker_id === null ||
        row.delivery_record_id !== null || deliveryRow !== undefined ||
        row.unknown_detail === null || row.attempt_count < 1
      ) {
        throw new KernelOperatorEffectRejectionConflictError(
          "Effect is not an active, unleased, dispatch-fenced unknown Daytona integration",
        );
      }
      const activeScheduleOwners = this.#db.prepare(`
        SELECT a.id AS attempt_id
        FROM records d
        JOIN pipeline_runs r ON r.id = d.pipeline_run_id
        JOIN attempts a ON a.pipeline_run_id = d.pipeline_run_id
        WHERE d.id = ? AND d.pipeline_run_id = ? AND d.kind = 'decision'
          AND d.reducer = 'core/external-schedule@1'
          AND d.semantic_key IS NOT NULL
          AND substr(
            d.semantic_key,
            1,
            length('external-schedule:' || a.id || ':')
          ) = 'external-schedule:' || a.id || ':'
          AND a.status IN ('work_complete', 'recorded')
          AND a.lease_id IS NULL
          AND a.checkpoint_id IS NOT NULL
          AND a.stage_id = r.cursor_stage_id
        ORDER BY a.id
        LIMIT 2
      `).all(row.decision_record_id, row.pipeline_run_id) as Array<{ attempt_id: string }>;
      if (activeScheduleOwners.length !== 1) {
        throw new KernelOperatorEffectRejectionConflictError(
          "Effect is not owned by exactly one current ready external schedule",
        );
      }

      const capturedEffectVersion = row.version;
      const capturedRunVersion = row.run_version;
      const dispatchFence = {
        lease_id: row.dispatch_lease_id,
        worker_id: row.dispatch_worker_id,
      };
      const delivery: DeliveryRecord = createOperatorEffectRejectionDelivery({
        request: input,
        intent,
        captured_run_version: capturedRunVersion,
        captured_effect_version: capturedEffectVersion,
        intent_hash: row.intent_hash,
        dispatch_fence: dispatchFence,
        reconciliation_ordinal: row.attempt_count,
        prior_unknown_detail: row.unknown_detail,
        runtime_create_intent: runtimeCreateIntent,
        created_at: this.#now(),
      });
      this.#insertRecord(delivery);
      const changed = this.#db.prepare(`
        UPDATE effects
        SET status = 'rejected', delivery_record_id = ?, unknown_detail = NULL,
          version = version + 1, updated_at = ?
        WHERE id = ? AND pipeline_run_id = ? AND version = ? AND status = 'unknown'
          AND lease_id IS NULL AND lease_worker_id IS NULL
          AND lease_expires_at IS NULL AND lease_execution_mode IS NULL
          AND dispatch_lease_id = ? AND dispatch_worker_id = ?
          AND delivery_record_id IS NULL AND intent_hash = ?
          AND attempt_count = ? AND unknown_detail = ?
      `).run(
        delivery.id,
        this.#now(),
        row.id,
        row.pipeline_run_id,
        capturedEffectVersion,
        dispatchFence.lease_id,
        dispatchFence.worker_id,
        row.intent_hash,
        row.attempt_count,
        row.unknown_detail,
      );
      if (changed.changes !== 1) {
        throw new KernelOperatorEffectRejectionConflictError(
          "operator Effect rejection compare-and-set failed",
        );
      }
      const resolutionDigest = operatorEffectRejectionResolutionDigest(input);
      const run = this.#advanceRunFence(
        row.pipeline_run_id,
        `effect-operator-reject:${delivery.id}`,
        {
          schema: "openthrottle.operator-effect-rejection-transition/v1",
          effect_id: row.id,
          delivery_record_id: delivery.id,
          resolution_digest: resolutionDigest,
          captured_run_version: capturedRunVersion,
          captured_effect_version: capturedEffectVersion,
          dispatch_fence: dispatchFence,
        },
      );
      if (run.version !== capturedRunVersion + 1) {
        throw new KernelOperatorEffectRejectionConflictError(
          "operator Effect rejection did not advance the exact pipeline run fence",
        );
      }
      return {
        disposition: "rejected",
        pipeline_run_id: row.pipeline_run_id,
        effect_id: row.id,
        delivery_record_id: delivery.id,
        effect_version: capturedEffectVersion + 1,
        run_version: run.version,
      };
    }).immediate();
  }

  async loadAttemptForensics(input: {
    pipeline_run_id: string;
    attempt_id: string;
    work_retry_ordinal: number;
  }): Promise<{ record: DecisionRecord; payload: AttemptForensicsPayload } | null> {
    if (!Number.isSafeInteger(input.work_retry_ordinal) || input.work_retry_ordinal < 0) {
      throw new Error("attempt forensics ordinal is invalid");
    }
    const attempt = this.#attemptById(input.attempt_id, input.pipeline_run_id);
    const id = attemptForensicsRecordId(attempt, input.work_retry_ordinal);
    const row = this.#db.prepare(`
      SELECT * FROM records
      WHERE id = ? AND pipeline_run_id = ? AND kind = 'decision'
    `).get(id, input.pipeline_run_id) as RecordRow | undefined;
    if (!row) return null;
    const record = recordFromRow(row, this.#payloadSchemas);
    if (
      record.kind !== "decision" || record.reducer !== ATTEMPT_FORENSICS_REDUCER ||
      !("blob" in record.payload)
    ) throw new Error(`record ${id} is not exact Attempt forensics`);
    const bytes = this.#readBlob(
      input.pipeline_run_id,
      "record",
      record.id,
      record.payload.blob,
    );
    const payload = validateAttemptForensicsPayload(
      parseJson(bytes.toString("utf8"), `record ${id} blob`),
      { source: "attempt_forensics" },
    ).value;
    if (
      payload.pipeline_run_id !== input.pipeline_run_id || payload.attempt_id !== input.attempt_id ||
      payload.request_hash !== attempt.request_hash ||
      payload.definition_bundle_hash !== attempt.definition_bundle_hash ||
      payload.work_retry_ordinal !== input.work_retry_ordinal ||
      record.created_at !== payload.observed_at
    ) throw new Error(`record ${id} changed its Attempt forensics identity`);
    return { record, payload };
  }

  async findExternalSchedule(input: {
    pipeline_run_id: string;
    attempt_id: string;
    phase: string;
  }): Promise<ExternalScheduleView | null> {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(input.attempt_id) ||
      !/^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/.test(input.phase) ||
      input.phase.length > 100
    ) throw new Error("external schedule lookup identity is invalid");
    this.#attemptById(input.attempt_id, input.pipeline_run_id);
    const semanticKey = `external-schedule:${input.attempt_id}:${input.phase}`;
    const row = this.#db.prepare(`
      SELECT * FROM records
      WHERE pipeline_run_id = ? AND kind = 'decision' AND semantic_key = ?
    `).get(input.pipeline_run_id, semanticKey) as RecordRow | undefined;
    if (!row) return null;
    const decision = recordFromRow(row, this.#payloadSchemas);
    if (decision.kind !== "decision" || !("inline" in decision.payload)) {
      throw new Error(`external schedule ${semanticKey} is not a materialized DecisionRecord`);
    }
    const payload = decision.payload.inline;
    if (
      !payload || typeof payload !== "object" || Array.isArray(payload) ||
      payload.semantic_key !== semanticKey || payload.attempt_id !== input.attempt_id ||
      payload.phase !== input.phase
    ) throw new Error(`external schedule ${semanticKey} failed its indexed identity`);
    const effectRows = this.#db.prepare(`
      SELECT * FROM effects
      WHERE pipeline_run_id = ? AND decision_record_id = ?
      ORDER BY id
    `).all(input.pipeline_run_id, decision.id) as EffectRow[];
    if (effectRows.length === 0) {
      throw new Error(`external schedule ${semanticKey} has no bounded effect batch`);
    }
    const deliveryRecordIds = [...new Set(effectRows.flatMap((effect) =>
      effect.delivery_record_id === null ? [] : [effect.delivery_record_id]
    ))];
    const deliveryRows = deliveryRecordIds.length === 0
      ? []
      : this.#db.prepare(`
        SELECT * FROM records
        WHERE pipeline_run_id = ? AND id IN (${placeholders(deliveryRecordIds.length)})
        ORDER BY id
      `).all(input.pipeline_run_id, ...deliveryRecordIds) as RecordRow[];
    const deliveriesById = new Map(deliveryRows.map((delivery) => [delivery.id, delivery]));
    return {
      semantic_key: semanticKey,
      decision,
      effects: effectRows.map((effect) => {
        const deliveryRow = effect.delivery_record_id === null
          ? undefined
          : deliveriesById.get(effect.delivery_record_id);
        if (effect.delivery_record_id !== null && deliveryRow === undefined) {
          throw new Error(`effect ${effect.id} references a missing delivery record`);
        }
        const delivery = deliveryRow === undefined ? null : recordFromRow(deliveryRow, this.#payloadSchemas);
        if (delivery !== null && (
          delivery.kind !== "delivery" ||
          delivery.effect_id !== effect.id ||
          delivery.idempotency_key !== effect.idempotency_key ||
          delivery.external_identity !== effect.target
        )) {
          throw new Error(`effect ${effect.id} references an invalid delivery record`);
        }
        return {
          intent: this.#leases.effectIntentFromRow(effect),
          delivery,
        };
      }),
    };
  }

  async listReadyExternalAttempts(
    input: KernelContinuationPageRequest,
  ): Promise<readonly KernelContinuationCandidate[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error("external continuation limit must be between 1 and 100");
    }
    const after = input.after;
    const rows = this.#db.prepare(`
      SELECT a.updated_at, a.pipeline_run_id, a.id AS attempt_id
      FROM attempts a
      JOIN pipeline_runs r ON r.id = a.pipeline_run_id
      WHERE r.status IN ('pending', 'running')
        AND a.status IN ('work_complete', 'recorded')
        AND a.lease_id IS NULL
        AND a.checkpoint_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM records marker
          WHERE marker.pipeline_run_id = a.pipeline_run_id
            AND marker.kind = 'decision'
            AND marker.reducer = 'core/external-schedule@1'
            AND substr(
              marker.semantic_key,
              1,
              length('external-schedule:' || a.id || ':')
            ) = 'external-schedule:' || a.id || ':'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM records d
          JOIN effects e ON e.decision_record_id = d.id AND e.pipeline_run_id = d.pipeline_run_id
          WHERE d.pipeline_run_id = a.pipeline_run_id AND d.kind = 'decision'
            AND substr(
              d.semantic_key,
              1,
              length('external-schedule:' || a.id || ':')
            ) = 'external-schedule:' || a.id || ':'
            AND e.status IN ('pending', 'processing', 'unknown')
        )
        ${after === undefined ? "" : `AND (
          a.updated_at > ?
          OR (a.updated_at = ? AND a.pipeline_run_id > ?)
          OR (a.updated_at = ? AND a.pipeline_run_id = ? AND a.id > ?)
        )`}
      ORDER BY a.updated_at, a.pipeline_run_id, a.id
      LIMIT ?
    `).all(
      ...(after === undefined
        ? [input.limit]
        : [
          after.updated_at,
          after.updated_at,
          after.pipeline_run_id,
          after.updated_at,
          after.pipeline_run_id,
          after.attempt_id,
          input.limit,
        ]),
    ) as KernelContinuationCandidate[];
    return rows;
  }

  async listReadyOrdinaryAttempts(
    input: KernelContinuationPageRequest,
  ): Promise<readonly KernelContinuationCandidate[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error("ordinary continuation limit must be between 1 and 100");
    }
    const after = input.after;
    const rows = this.#db.prepare(`
      SELECT a.updated_at, a.pipeline_run_id, a.id AS attempt_id
      FROM attempts a
      JOIN pipeline_runs r ON r.id = a.pipeline_run_id
      WHERE r.status IN ('pending', 'running')
        AND a.status IN ('work_complete', 'recorded')
        AND a.lease_id IS NULL
        AND a.checkpoint_id IS NOT NULL
        AND a.result_record_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM records marker
          WHERE marker.pipeline_run_id = a.pipeline_run_id
            AND marker.kind = 'decision'
            AND marker.reducer = 'core/external-schedule@1'
            AND substr(
              marker.semantic_key,
              1,
              length('external-schedule:' || a.id || ':')
            ) = 'external-schedule:' || a.id || ':'
        )
        ${after === undefined ? "" : `AND (
          a.updated_at > ?
          OR (a.updated_at = ? AND a.pipeline_run_id > ?)
          OR (a.updated_at = ? AND a.pipeline_run_id = ? AND a.id > ?)
        )`}
      ORDER BY a.updated_at, a.pipeline_run_id, a.id
      LIMIT ?
    `).all(
      ...(after === undefined
        ? [input.limit]
        : [
          after.updated_at,
          after.updated_at,
          after.pipeline_run_id,
          after.updated_at,
          after.pipeline_run_id,
          after.attempt_id,
          input.limit,
        ]),
    ) as KernelContinuationCandidate[];
    return rows;
  }

  async loadAttemptRequestInputs(input: {
    pipeline_run_id: string;
    attempt_id: string;
  }): Promise<KernelAttemptRequestInputs> {
    const attempt = this.#attemptById(input.attempt_id, input.pipeline_run_id);
    const taskPrompt = this.#loadTaskPrompt(input);
    const runStatus = this.#runFromRow(this.#runRow(input.pipeline_run_id)).status;
    return {
      task_prompt: taskPrompt,
      context: {
        records: this.#loadExactRecords(
          input.pipeline_run_id,
          attempt.context_record_ids,
          runStatus,
        ),
        checkpoints: this.#loadExactCheckpoints(
          input.pipeline_run_id,
          attempt.context_checkpoint_ids,
          runStatus,
        ),
      },
    };
  }

  #loadTaskPrompt(input: {
    pipeline_run_id: string;
    attempt_id: string;
  }): string {
    const row = this.#db.prepare(`
      SELECT
        w.id AS work_item_id,
        w.request_payload_schema AS payload_schema,
        w.request_inline_json AS inline_payload,
        w.request_blob_algorithm AS blob_algorithm,
        w.request_blob_digest AS blob_digest,
        w.request_blob_bytes AS blob_bytes,
        w.request_blob_encoding AS blob_encoding,
        w.request_blob_media_type AS blob_media_type,
        w.request_blob_payload_schema AS blob_payload_schema
      FROM attempts a
      JOIN pipeline_runs r ON r.id = a.pipeline_run_id
      JOIN work_items w ON w.id = r.work_item_id
      WHERE a.id = ? AND a.pipeline_run_id = ?
    `).get(input.attempt_id, input.pipeline_run_id) as (PayloadRow & {
      work_item_id: string;
    }) | undefined;
    if (!row) throw new Error(`attempt ${input.attempt_id} has no immutable work request`);
    if (row.payload_schema !== KERNEL_WORK_REQUEST_PAYLOAD_SCHEMA) {
      throw new Error(`work item ${row.work_item_id} does not use the kernel work request schema`);
    }
    const pointer = payloadPointer(row);
    const value = pointer === null
      ? parseJson<JsonValue>(row.inline_payload!, `work item ${row.work_item_id} payload`)
      : parseJson<JsonValue>(
        this.#readBlob(input.pipeline_run_id, "work_item", row.work_item_id, pointer).toString("utf8"),
        `work item ${row.work_item_id} payload`,
      );
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`work item ${row.work_item_id} payload must be an object`);
    }
    const payload = value as Record<string, JsonValue>;
    if (
      Object.keys(payload).sort().join(",") !== "schema,task_prompt" ||
      payload.schema !== KERNEL_WORK_REQUEST_PAYLOAD_SCHEMA ||
      typeof payload.task_prompt !== "string" || payload.task_prompt.length === 0
    ) {
      throw new Error(`work item ${row.work_item_id} payload is not a sealed kernel request`);
    }
    return payload.task_prompt;
  }

  async listSettledStructuredPlanningAttempts(
    request: StructuredPlanningReadRequest,
  ): Promise<readonly SettledStructuredPlanningAttempt[]> {
    const runRow = this.#runRow(request.pipeline_run_id);
    if (runRow.definition_bundle_hash !== request.definition_bundle_hash) {
      throw new Error("structured planning read does not match the pinned definition bundle");
    }
    for (const [name, value] of [
      ["parent_attempt_id", request.parent_attempt_id],
      ["scope_group_id", request.scope_group_id],
    ] as const) {
      if (!STRUCTURED_PLANNING_ID.test(value)) {
        throw new Error(`structured planning ${name} is invalid`);
      }
    }
    const exactIds = (
      values: readonly string[],
      name: string,
      maximum: number,
    ): string[] => {
      if (values.length < 1 || values.length > maximum) {
        throw new Error(`structured planning ${name} must contain between 1 and ${maximum} IDs`);
      }
      if (values.some((value) => !STRUCTURED_PLANNING_ID.test(value))) {
        throw new Error(`structured planning ${name} contains an invalid ID`);
      }
      const canonical = [...new Set(values)].sort(compareCodeUnits);
      if (canonical.length !== values.length) {
        throw new Error(`structured planning ${name} must not contain duplicate IDs`);
      }
      return canonical;
    };
    const stageIds = exactIds(request.stage_ids, "stage_ids", 32);
    const memberIds = exactIds(request.member_ids, "member_ids", 64);
    const selectionSql = `
      SELECT * FROM attempts INDEXED BY attempts_structured_planning_idx
      WHERE pipeline_run_id = ? AND definition_bundle_hash = ?
        AND scope_kind = ? AND parent_attempt_id = ? AND scope_group_id = ?
        AND stage_id IN (${placeholders(stageIds.length)})
        AND scope_item_id IN (${placeholders(memberIds.length)})
        AND status = 'settled'
    `;
    const selectionArguments = [
      request.pipeline_run_id,
      request.definition_bundle_hash,
      request.scope_kind,
      request.parent_attempt_id,
      request.scope_group_id,
      ...stageIds,
      ...memberIds,
    ];
    const rows = this.#db.prepare(`
      ${selectionSql}
      ORDER BY scope_item_index, stage_id, id
    `).all(...selectionArguments) as AttemptRow[];
    const recordRows = rows.length === 0
      ? []
      : this.#db.prepare(`
        WITH selected_attempts AS (${selectionSql}),
        referenced_ids(id) AS (
          SELECT result_record_id FROM selected_attempts WHERE result_record_id IS NOT NULL
          UNION
          SELECT decision_record_id FROM selected_attempts WHERE decision_record_id IS NOT NULL
          UNION
          SELECT context.value
          FROM selected_attempts, json_each(selected_attempts.context_record_ids_json) AS context
          WHERE context.type = 'text'
          UNION
          SELECT decision_input.value
          FROM selected_attempts
          JOIN records AS settlement_decision
            ON settlement_decision.id = selected_attempts.decision_record_id
            AND settlement_decision.pipeline_run_id = selected_attempts.pipeline_run_id
            AND settlement_decision.kind = 'decision'
          JOIN json_each(settlement_decision.input_record_ids_json) AS decision_input
          WHERE decision_input.type = 'text'
        )
        SELECT records.* FROM records
        JOIN referenced_ids ON referenced_ids.id = records.id
        WHERE records.pipeline_run_id = ?
        ORDER BY records.id
      `).all(...selectionArguments, request.pipeline_run_id) as RecordRow[];
    const checkpointRows = rows.length === 0
      ? []
      : this.#db.prepare(`
        WITH selected_attempts AS (${selectionSql}),
        referenced_ids(id) AS (
          SELECT checkpoint_id FROM selected_attempts WHERE checkpoint_id IS NOT NULL
          UNION
          SELECT context.value
          FROM selected_attempts, json_each(selected_attempts.context_checkpoint_ids_json) AS context
          WHERE context.type = 'text'
        )
        SELECT checkpoints.* FROM checkpoints
        JOIN referenced_ids ON referenced_ids.id = checkpoints.id
        WHERE checkpoints.pipeline_run_id = ?
        ORDER BY checkpoints.id
      `).all(...selectionArguments, request.pipeline_run_id) as CheckpointRow[];
    const recordsById = new Map(recordRows.map((row) => [row.id, row]));
    const checkpointsById = new Map(checkpointRows.map((row) => [row.id, row]));
    const run = this.#runFromRow(runRow);
    const settled: SettledStructuredPlanningAttempt[] = [];
    let taskPrompt: string | undefined;
    for (const row of rows) {
      const attempt = attemptFromRow(row);
      if (
        attempt.result_record_id === null || attempt.decision_record_id === null ||
        attempt.checkpoint_id === null
      ) throw new Error(`settled structured attempt ${attempt.id} has incomplete evidence relations`);
      const records = this.#materializeExactRecords(
        request.pipeline_run_id,
        [attempt.result_record_id, attempt.decision_record_id],
        run.status,
        recordsById,
      );
      const result = records.get(attempt.result_record_id);
      const decision = records.get(attempt.decision_record_id);
      if (!result || result.kind !== "result" || !decision || decision.kind !== "decision") {
        throw new Error(`settled structured attempt ${attempt.id} has invalid evidence kinds`);
      }
      if (
        result.attempt_id !== attempt.id || result.request_hash !== attempt.request_hash ||
        result.definition_bundle_hash !== attempt.definition_bundle_hash ||
        result.input_subject !== attempt.input_subject || result.output_subject !== attempt.output_subject ||
        !decision.input_record_ids.includes(result.id)
      ) throw new Error(`settled structured attempt ${attempt.id} has a cross-attempt decision relation`);
      const decisionInputRecords = this.#materializeExactRecords(
        request.pipeline_run_id,
        decision.input_record_ids,
        run.status,
        recordsById,
      );
      const checkpoint = this.#materializeExactCheckpoints(
        request.pipeline_run_id,
        [attempt.checkpoint_id],
        run.status,
        checkpointsById,
      ).get(attempt.checkpoint_id)!;
      if (
        checkpoint.attempt_id !== attempt.id || checkpoint.request_hash !== attempt.request_hash ||
        checkpoint.definition_bundle_hash !== attempt.definition_bundle_hash ||
        checkpoint.input_subject !== attempt.input_subject ||
        checkpoint.output_subject !== attempt.output_subject
      ) throw new Error(`settled structured attempt ${attempt.id} has a cross-attempt checkpoint relation`);
      if (taskPrompt === undefined) {
        taskPrompt = this.#loadTaskPrompt({
          pipeline_run_id: request.pipeline_run_id,
          attempt_id: attempt.id,
        });
      }
      settled.push({
        attempt,
        result,
        decision,
        decision_input_records: [...decisionInputRecords.values()]
          .sort((left, right) => compareCodeUnits(left.id, right.id)),
        checkpoint,
        request_inputs: {
          task_prompt: taskPrompt,
          context: {
            records: this.#materializeExactRecords(
              request.pipeline_run_id,
              attempt.context_record_ids,
              run.status,
              recordsById,
            ),
            checkpoints: this.#materializeExactCheckpoints(
              request.pipeline_run_id,
              attempt.context_checkpoint_ids,
              run.status,
              checkpointsById,
            ),
          },
        },
      });
    }
    return settled;
  }

  async loadExactDefinitionBundleBytes(input: {
    pipeline_run_id: string;
    definition_bundle_hash: string;
  }): Promise<Uint8Array> {
    const row = this.#runRow(input.pipeline_run_id);
    if (row.definition_bundle_hash !== input.definition_bundle_hash) {
      throw new Error("definition bundle read does not match the pipeline run fence");
    }
    const pointer: BlobPointer = {
      algorithm: "sha256",
      digest: row.definition_bundle_hash,
      bytes: row.definition_bundle_bytes,
      encoding: row.definition_bundle_encoding,
      media_type: row.definition_bundle_media_type,
      payload_schema: row.definition_bundle_payload_schema,
    };
    return new Uint8Array(this.#readBlob(
      row.id,
      "definition_bundle",
      row.definition_bundle_hash,
      pointer,
      row.status,
    ));
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
    const attempt = attemptFromRow(row);
    const evidence = attempt.pending_result?.invalid_result_evidence;
    if (evidence) {
      const bytes = this.#readBlob(runId, "attempt", attempt.id, evidence);
      this.#assertInvalidResultEvidenceIdentity(attempt, evidence, bytes);
    }
    return attempt;
  }

  #insertAttempt(attempt: KernelAttempt, now: string, workerId: string | null): void {
    this.#preverifyAttemptBlobs([attempt]);
    const [parent, group, item, index] = scopeColumns(attempt.scope);
    const contextRecordIds = canonicalAttemptContextIds(
      attempt.context_record_ids,
      `attempt ${attempt.id} context_record_ids`,
    );
    const contextCheckpointIds = canonicalAttemptContextIds(
      attempt.context_checkpoint_ids,
      `attempt ${attempt.id} context_checkpoint_ids`,
    );
    this.#db.prepare(`
      INSERT INTO attempts (
        id, pipeline_run_id, scope_kind, stage_id, parent_attempt_id, scope_group_id,
        scope_item_id, scope_item_index, repository_authority, request_hash,
        definition_bundle_hash, input_subject, context_record_ids_json,
        context_checkpoint_ids_json, output_subject, native_session_id,
        status, version, work_retry_ordinal, result_correction_count,
        result_correction_deadline, unmet_dependency_count,
        lease_id, lease_generation, lease_worker_id, lease_purpose, lease_expires_at, lease_started,
        checkpoint_id, result_record_id, decision_record_id,
        pending_candidate_hash, pending_diagnostics_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      canonicalJson(contextRecordIds),
      canonicalJson(contextCheckpointIds),
      attempt.output_subject,
      attempt.native_session_id,
      attempt.status,
      attempt.version,
      attempt.work_retry_ordinal,
      attempt.result_correction_count,
      attempt.result_correction_deadline,
      attempt.lease?.id ?? null,
      attempt.lease?.generation ?? null,
      attempt.lease ? (workerId ?? attempt.lease.worker_id) : null,
      attempt.lease?.purpose ?? null,
      attempt.lease?.expires_at ?? null,
      attempt.lease ? (attempt.lease.started ? 1 : 0) : null,
      attempt.checkpoint_id,
      attempt.result_record_id,
      attempt.decision_record_id,
      attempt.pending_result?.candidate_hash ?? null,
      attempt.pending_result === null ? null : serializePendingResultDiagnostics(attempt.pending_result),
      now,
      now,
    );
  }

  #replaceAttempt(attempt: KernelAttempt, expectedVersion: number, runId: string): void {
    if (attempt.pipeline_run_id !== runId) throw new Error(`attempt ${attempt.id} belongs to another run`);
    const existing = this.#db.prepare("SELECT * FROM attempts WHERE id = ? AND pipeline_run_id = ?")
      .get(attempt.id, runId) as AttemptRow | undefined;
    if (!existing) throw new Error(`unknown attempt ${attempt.id}`);
    const [parent, group, item, index] = scopeColumns(attempt.scope);
    const contextRecordIds = canonicalAttemptContextIds(
      attempt.context_record_ids,
      `attempt ${attempt.id} context_record_ids`,
    );
    const contextCheckpointIds = canonicalAttemptContextIds(
      attempt.context_checkpoint_ids,
      `attempt ${attempt.id} context_checkpoint_ids`,
    );
    if (
      existing.context_record_ids_json !== canonicalJson(contextRecordIds) ||
      existing.context_checkpoint_ids_json !== canonicalJson(contextCheckpointIds)
    ) throw new Error(`attempt ${attempt.id} cannot change its context bindings`);
    if (
      attempt.lease && existing.lease_id === attempt.lease.id &&
      (
        existing.lease_generation !== attempt.lease.generation ||
        existing.lease_worker_id !== attempt.lease.worker_id ||
        existing.lease_purpose !== attempt.lease.purpose
      )
    ) throw new Error(`attempt ${attempt.id} lease claim cannot change inside its fence`);
    this.#preverifyAttemptBlobs([attempt]);
    const worker = attempt.lease?.worker_id ?? null;
    const changed = this.#db.prepare(`
      UPDATE attempts SET
        scope_kind = ?, stage_id = ?, parent_attempt_id = ?, scope_group_id = ?,
        scope_item_id = ?, scope_item_index = ?, repository_authority = ?, request_hash = ?,
        definition_bundle_hash = ?, input_subject = ?, output_subject = ?, native_session_id = ?,
        status = ?, version = ?, work_retry_ordinal = ?, result_correction_count = ?,
        result_correction_deadline = ?, lease_id = ?, lease_generation = ?,
        lease_worker_id = ?, lease_purpose = ?,
        lease_expires_at = ?, lease_started = ?, checkpoint_id = ?, result_record_id = ?,
        decision_record_id = ?,
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
      attempt.lease?.generation ?? null,
      worker,
      attempt.lease?.purpose ?? null,
      attempt.lease?.expires_at ?? null,
      attempt.lease ? (attempt.lease.started ? 1 : 0) : null,
      attempt.checkpoint_id,
      attempt.result_record_id,
      attempt.decision_record_id,
      attempt.pending_result?.candidate_hash ?? null,
      attempt.pending_result === null ? null : serializePendingResultDiagnostics(attempt.pending_result),
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
      UPDATE attempts SET status = ?, version = ?, lease_id = NULL, lease_generation = NULL,
        lease_worker_id = NULL,
        lease_purpose = NULL, lease_expires_at = NULL, lease_started = NULL,
        result_record_id = NULL, decision_record_id = NULL, result_correction_deadline = NULL,
        pending_candidate_hash = NULL, pending_diagnostics_json = NULL, updated_at = ?
      WHERE id = ? AND pipeline_run_id = ? AND version = ?
    `).run(write.status, write.next_version, this.#now(), write.attempt_id, runId, write.expected_version);
    if (changed.changes !== 1) throw new Error(`attempt ${write.attempt_id} terminal compare-and-set failed`);
  }

  #insertRecord(
    recordInput: ExecutionRecord,
    replacementOwners: ReadonlyMap<string, KernelAttempt> = new Map(),
  ): void {
    const record = validateExecutionRecord(recordInput, { payloadSchemas: this.#payloadSchemas }).value;
    const payload = this.#recordPayloadColumns(record.payload, record.payload_schema);
    if (record.kind === "result") {
      const owner = replacementOwners.get(record.attempt_id) ??
        this.#attemptById(record.attempt_id, record.pipeline_run_id);
      if (
        owner.id !== record.attempt_id || owner.pipeline_run_id !== record.pipeline_run_id ||
        owner.request_hash !== record.request_hash || owner.definition_bundle_hash !== record.definition_bundle_hash ||
        owner.input_subject !== record.input_subject || owner.output_subject !== record.output_subject
      ) throw new Error(`ResultRecord ${record.id} does not match its attempt identity`);
    }
    if (record.kind === "decision") {
      this.#assertAttemptEvidenceRecord(record, replacementOwners);
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
    if (ordinal.ordinal > 1) {
      throw new Error(`attempt ${checkpoint.attempt_id} cannot append more than one promoted checkpoint`);
    }
    if (ordinal.ordinal === 1) {
      const prior = this.#db.prepare(`
        SELECT id, output_subject FROM checkpoints WHERE attempt_id = ? AND ordinal = 0
      `).get(checkpoint.attempt_id) as { id: string; output_subject: string | null } | undefined;
      if (
        !prior || attempt.checkpoint_id !== prior.id || attempt.output_subject !== null ||
        prior.output_subject !== null || checkpoint.output_subject === null ||
        checkpoint.payload_schema !== "openthrottle.git-checkpoint-bundle/v1"
      ) {
        throw new Error(`attempt ${checkpoint.attempt_id} has an invalid external integration promotion`);
      }
    }
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
        lease_execution_mode = NULL, unknown_detail = NULL, last_error = NULL, updated_at = ?
      WHERE id = ? AND pipeline_run_id = ? AND status IN ('pending', 'processing', 'unknown')
    `).run(this.#now(), effectId, runId);
    if (changed.changes !== 1) throw new Error(`effect ${effectId} cannot be canceled from its current fence`);
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
    this.#preverifyAttemptBlobs([
      ...bundle.attempt_writes.flatMap((write) => write.kind === "replace" ? [write.attempt] : []),
      ...bundle.create_attempts,
    ]);
  }

  #assertAttemptEvidenceRecord(
    record: DecisionRecord,
    replacementOwners: ReadonlyMap<string, KernelAttempt>,
  ): void {
    if (
      record.reducer !== ATTEMPT_FORENSICS_REDUCER &&
      record.reducer !== INVALID_RESULT_EVIDENCE_REDUCER
    ) return;
    if (record.input_record_ids.length !== 0 || !("blob" in record.payload)) {
      throw new Error(`attempt evidence Record ${record.id} is not an immutable blob leaf`);
    }
    const pointer = record.payload.blob;
    const token = this.#blobs.verify(pointer);
    const bytes = this.#blobs.read(pointer);
    this.#blobs.assertToken(token, pointer);
    if (record.reducer === INVALID_RESULT_EVIDENCE_REDUCER) {
      const parsed = validateInvalidResultEvidencePayload(
        parseJson(Buffer.from(bytes).toString("utf8"), `record ${record.id} blob`),
        { source: `record ${record.id} invalid_result_evidence` },
      ).value;
      const replacement = replacementOwners.get(parsed.attempt_id);
      const replacementOwnsPointer = replacement?.pending_result?.invalid_result_evidence !== null &&
        replacement?.pending_result?.invalid_result_evidence !== undefined &&
        canonicalJson(replacement.pending_result.invalid_result_evidence) === canonicalJson(pointer);
      // A result_pending replacement is the authoritative source for the new
      // candidate/diagnostic binding. Terminal replacements deliberately clear
      // pending_result, so evidence observed by the finishing lease must be
      // validated against the still-current persisted Attempt instead.
      const owner = replacementOwnsPointer
        ? replacement
        : this.#attemptById(parsed.attempt_id, parsed.pipeline_run_id);
      const payload = this.#assertInvalidResultEvidenceIdentity(owner, pointer, bytes);
      assertExactInvalidResultEvidenceRecord({ attempt: owner, pointer, record });
      if (record.created_at !== payload.observed_at) {
        throw new Error(`record ${record.id} changed its invalid-result observation time`);
      }
      return;
    }
    if (
      pointer.encoding !== "utf-8" || pointer.media_type !== "application/json" ||
      pointer.payload_schema !== record.payload_schema
    ) throw new Error(`record ${record.id} Attempt forensics pointer is not canonical JSON`);
    const payload = validateAttemptForensicsPayload(
      parseJson(Buffer.from(bytes).toString("utf8"), `record ${record.id} blob`),
      { source: `record ${record.id} attempt_forensics` },
    ).value;
    const owner = this.#attemptById(payload.attempt_id, payload.pipeline_run_id);
    const lease = owner.lease;
    if (
      record.id !== attemptForensicsRecordId(owner, payload.work_retry_ordinal) ||
      record.payload_schema !== payload.schema || record.pipeline_run_id !== owner.pipeline_run_id ||
      payload.request_hash !== owner.request_hash ||
      payload.definition_bundle_hash !== owner.definition_bundle_hash ||
      payload.work_retry_ordinal !== owner.work_retry_ordinal ||
      !lease || payload.lease_id !== lease.id || !lease.started ||
      record.created_at !== payload.observed_at
    ) throw new Error(`record ${record.id} changed its live Attempt forensics identity`);
  }

  #preverifyAttemptBlobs(attempts: readonly KernelAttempt[]): void {
    for (const attempt of attempts) {
      const evidence = attempt.pending_result?.invalid_result_evidence;
      if (!evidence) continue;
      const token = this.#blobs.verify(evidence);
      const bytes = this.#blobs.read(evidence);
      this.#assertInvalidResultEvidenceIdentity(attempt, evidence, bytes);
      this.#blobs.assertToken(token, evidence);
    }
  }

  #assertInvalidResultEvidenceIdentity(
    attempt: KernelAttempt,
    pointer: BlobPointer,
    bytes: Uint8Array,
  ): InvalidResultEvidencePayload {
    if (
      pointer.encoding !== "utf-8" || pointer.media_type !== "application/json" ||
      pointer.payload_schema !== INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA
    ) throw new Error(`attempt ${attempt.id} invalid-result evidence pointer is not canonical JSON`);
    const payload = validateInvalidResultEvidencePayload(
      parseJson(Buffer.from(bytes).toString("utf8"), `attempt ${attempt.id} invalid-result evidence`),
      { source: `attempt ${attempt.id} invalid_result_evidence` },
    ).value;
    const ownsPendingPointer = attempt.pending_result?.invalid_result_evidence !== null &&
      attempt.pending_result?.invalid_result_evidence !== undefined &&
      canonicalJson(attempt.pending_result.invalid_result_evidence) === canonicalJson(pointer);
    // Leasing result correction increments result_correction_count before it
    // executes, while the pending pointer still describes the preceding
    // invalid outcome. The first correction lease therefore legitimately
    // carries phase=work evidence at count=1. Once a correction has produced
    // another pending result, phase=result_correction is also valid.
    const phaseMatches = ownsPendingPointer
      ? payload.phase === "work" ||
        (attempt.result_correction_count > 0 && payload.phase === "result_correction")
      : attempt.lease?.started
        ? payload.phase === attempt.lease.purpose
        : false;
    const identities = [
      ["pipeline_run_id", payload.pipeline_run_id, attempt.pipeline_run_id],
      ["attempt_id", payload.attempt_id, attempt.id],
      ["request_hash", payload.request_hash, attempt.request_hash],
      ["definition_bundle_hash", payload.definition_bundle_hash, attempt.definition_bundle_hash],
      ...(ownsPendingPointer
        ? [["candidate_hash", payload.candidate_hash, attempt.pending_result!.candidate_hash] as const]
        : []),
    ] as const;
    const mismatch = identities.find(([, observed, expected]) => observed !== expected);
    if (mismatch) {
      throw new Error(
        `attempt ${attempt.id} invalid-result evidence changed its sealed identity (${mismatch[0]})`,
      );
    }
    if (!phaseMatches) {
      throw new Error(
        `attempt ${attempt.id} invalid-result evidence changed its sealed identity (phase)`,
      );
    }
    if (
      ownsPendingPointer &&
      canonicalJson(payload.diagnostics) !== canonicalJson(attempt.pending_result!.diagnostics)
    ) {
      throw new Error(
        `attempt ${attempt.id} invalid-result evidence changed its sealed identity (diagnostics)`,
      );
    }
    return payload;
  }

  #loadExactRecords(
    runId: string,
    ids: readonly string[],
    runStatus: KernelRun["status"],
  ): ReadonlyMap<string, ExecutionRecord> {
    if (new Set(ids).size !== ids.length) throw new Error("record allowlist contains duplicate IDs");
    const rows = ids.length === 0
      ? []
      : this.#db.prepare(`
        SELECT * FROM records WHERE pipeline_run_id = ? AND id IN (${placeholders(ids.length)}) ORDER BY id
      `).all(runId, ...ids) as RecordRow[];
    return this.#materializeExactRecords(
      runId,
      ids,
      runStatus,
      new Map(rows.map((row) => [row.id, row])),
    );
  }

  #materializeExactRecords(
    runId: string,
    ids: readonly string[],
    runStatus: KernelRun["status"],
    availableRows: ReadonlyMap<string, RecordRow>,
  ): ReadonlyMap<string, ExecutionRecord> {
    if (new Set(ids).size !== ids.length) throw new Error("record allowlist contains duplicate IDs");
    if (ids.length === 0) return new Map();
    const rows = [...ids]
      .sort(compareCodeUnits)
      .flatMap((id) => {
        const row = availableRows.get(id);
        return row === undefined ? [] : [row];
      });
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
      records.set(row.id, recordFromRow(row, this.#payloadSchemas));
    }
    return records;
  }

  #loadExactCheckpoints(
    runId: string,
    ids: readonly string[],
    runStatus: KernelRun["status"],
  ): ReadonlyMap<string, AttemptCheckpoint> {
    if (new Set(ids).size !== ids.length) throw new Error("checkpoint allowlist contains duplicate IDs");
    const rows = ids.length === 0
      ? []
      : this.#db.prepare(`
        SELECT * FROM checkpoints WHERE pipeline_run_id = ? AND id IN (${placeholders(ids.length)}) ORDER BY id
      `).all(runId, ...ids) as CheckpointRow[];
    return this.#materializeExactCheckpoints(
      runId,
      ids,
      runStatus,
      new Map(rows.map((row) => [row.id, row])),
    );
  }

  #materializeExactCheckpoints(
    runId: string,
    ids: readonly string[],
    runStatus: KernelRun["status"],
    availableRows: ReadonlyMap<string, CheckpointRow>,
  ): ReadonlyMap<string, AttemptCheckpoint> {
    if (new Set(ids).size !== ids.length) throw new Error("checkpoint allowlist contains duplicate IDs");
    if (ids.length === 0) return new Map();
    const rows = [...ids]
      .sort(compareCodeUnits)
      .flatMap((id) => {
        const row = availableRows.get(id);
        return row === undefined ? [] : [row];
      });
    if (rows.length !== ids.length) throw new Error("exact checkpoint context is missing an authorized checkpoint");
    const checkpoints = new Map<string, AttemptCheckpoint>();
    for (const row of rows) {
      const pointer = payloadPointer(row);
      if (pointer) this.#readBlob(runId, "checkpoint", row.id, pointer, runStatus);
      checkpoints.set(row.id, checkpointFromRow(row));
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
      const active = ACTIVE_RUN_STATUS_SET.has(status);
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
