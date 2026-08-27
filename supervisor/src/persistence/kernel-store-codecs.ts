import {
  canonicalJson,
  compareCodeUnits,
  validateAttemptCheckpoint,
  validateBlobPointer,
  validateExecutionRecord,
  type AttemptCheckpoint,
  type BlobPointer,
  type ExecutionRecord,
  type ExecutionRecordPayloadRegistry,
  type JsonValue,
  type RecordPayload,
} from "@openthrottle/contracts";
import {
  KERNEL_ATTEMPT_SCHEMA,
  canonicalAttemptContextIds,
  type AttemptScope,
  type KernelAttempt,
  type KernelRun,
} from "../pipeline/kernel/types.js";

export interface PayloadColumns {
  inline_payload: string | null;
  blob_algorithm: "sha256" | null;
  blob_digest: string | null;
  blob_bytes: number | null;
  blob_encoding: "utf-8" | "binary" | null;
  blob_media_type: string | null;
  blob_payload_schema: string | null;
}

export interface PayloadRow extends PayloadColumns {
  payload_schema: string;
}

export interface RunRow {
  id: string;
  pipeline_id: string;
  definition_bundle_algorithm: "sha256";
  definition_bundle_hash: string;
  definition_bundle_bytes: number;
  definition_bundle_encoding: "utf-8";
  definition_bundle_media_type: string;
  definition_bundle_payload_schema: string;
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

export interface AttemptRow {
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
  context_record_ids_json: string;
  context_checkpoint_ids_json: string;
  output_subject: string | null;
  native_session_id: string | null;
  status: KernelAttempt["status"];
  version: number;
  work_retry_ordinal: number;
  result_correction_count: number;
  result_correction_deadline: string | null;
  unmet_dependency_count: number;
  lease_id: string | null;
  lease_generation: number | null;
  lease_worker_id: string | null;
  lease_purpose: "work" | "result_correction" | null;
  lease_expires_at: string | null;
  lease_started: number | null;
  checkpoint_id: string | null;
  result_record_id: string | null;
  decision_record_id: string | null;
  pending_candidate_hash: string | null;
  pending_diagnostics_json: string | null;
}

export interface RecordRow extends PayloadRow {
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

export const PENDING_RESULT_DIAGNOSTICS_SCHEMA =
  "openthrottle.pending-result-diagnostics/v1" as const;

export function parsePendingResultDiagnostics(value: unknown): {
  diagnostics: Array<{ path: string; detail: string }>;
  invalid_result_evidence: BlobPointer | null;
} {
  let envelope: Record<string, unknown> | null = null;
  if (!Array.isArray(value)) {
    if (!value || typeof value !== "object") throw new Error("pending result diagnostics are invalid");
    envelope = value as Record<string, unknown>;
    if (
      Object.keys(envelope).sort().join("\0") !==
        "diagnostics\0invalid_result_evidence\0schema" ||
      envelope.schema !== PENDING_RESULT_DIAGNOSTICS_SCHEMA
    ) throw new Error("pending result diagnostics envelope is invalid");
  }
  const diagnosticsValue = envelope === null ? value : envelope.diagnostics;
  if (!Array.isArray(diagnosticsValue)) throw new Error("pending result diagnostics are not an array");
  const diagnostics = diagnosticsValue.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`pending result diagnostic ${index} is invalid`);
    }
    const item = entry as Record<string, unknown>;
    if (
      Object.keys(item).sort().join("\0") !== "detail\0path" ||
      typeof item.path !== "string" || typeof item.detail !== "string"
    ) throw new Error(`pending result diagnostic ${index} is invalid`);
    return { path: item.path, detail: item.detail };
  });
  const invalidResultEvidence = envelope === null
    ? null
    : validateBlobPointer(envelope.invalid_result_evidence, {
      source: "pending_result.invalid_result_evidence",
    }).value;
  return { diagnostics, invalid_result_evidence: invalidResultEvidence };
}

export function serializePendingResultDiagnostics(
  pending: NonNullable<KernelAttempt["pending_result"]>,
): string {
  if (pending.invalid_result_evidence === null) return canonicalJson(pending.diagnostics);
  return canonicalJson({
    schema: PENDING_RESULT_DIAGNOSTICS_SCHEMA,
    diagnostics: pending.diagnostics,
    invalid_result_evidence: pending.invalid_result_evidence,
  });
}

export interface CheckpointRow extends PayloadRow {
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

export interface EffectRow extends PayloadRow {
  id: string;
  pipeline_run_id: string;
  decision_record_id: string;
  kind: string;
  idempotency_key: string;
  target: string;
  subject: string | null;
  intent_hash: string;
  status: string;
  version: number;
  attempt_count: number;
  lease_id: string | null;
  lease_worker_id: string | null;
  lease_expires_at: string | null;
  lease_execution_mode: "dispatch_or_reconcile" | "reconcile_only" | null;
  dispatch_lease_id: string | null;
  dispatch_worker_id: string | null;
  delivery_record_id: string | null;
  unknown_detail: string | null;
  last_error: string | null;
}

export function placeholders(length: number): string {
  return Array.from({ length }, () => "?").join(", ");
}

export function parseJson<T>(value: string, name: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`persisted ${name} is not valid JSON`);
  }
}

export function sortedRecord(entries: ReadonlyArray<readonly [string, number]>): Record<string, number> {
  return Object.fromEntries([...entries].sort(([left], [right]) => compareCodeUnits(left, right)));
}

export function payloadPointer(row: PayloadRow): BlobPointer | null {
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

export function semanticKey(record: ExecutionRecord): string | null {
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

export function attemptFromRow(row: AttemptRow): KernelAttempt {
  if (row.lease_id !== null && (
    !Number.isSafeInteger(row.lease_generation) || row.lease_generation! < 0
  )) {
    throw new Error("persisted attempt lease generation is invalid");
  }
  const lease = row.lease_id === null
    ? null
    : {
      id: row.lease_id,
      generation: row.lease_generation!,
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
    context_record_ids: canonicalAttemptContextIds(
      parseJson(row.context_record_ids_json, "attempt context record IDs"),
      "persisted attempt context_record_ids",
    ),
    context_checkpoint_ids: canonicalAttemptContextIds(
      parseJson(row.context_checkpoint_ids_json, "attempt context checkpoint IDs"),
      "persisted attempt context_checkpoint_ids",
    ),
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
    decision_record_id: row.decision_record_id,
    pending_result: row.status === "result_pending"
      ? {
        candidate_hash: row.pending_candidate_hash,
        ...parsePendingResultDiagnostics(parseJson(
          row.pending_diagnostics_json!,
          "result diagnostics",
        )),
      }
      : null,
  };
}

export function scopeColumns(
  scope: AttemptScope,
): [string | null, string | null, string | null, number | null] {
  if (scope.kind === "stage") return [null, null, null, null];
  return scope.kind === "loop_item"
    ? [scope.parent_attempt_id, scope.loop_id, scope.item_id, scope.item_index]
    : [scope.parent_attempt_id, scope.fanout_id, scope.member_id, scope.member_index];
}

export function recordFromRow(
  row: RecordRow,
  payloadSchemas: ExecutionRecordPayloadRegistry,
): ExecutionRecord {
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
  return validateExecutionRecord(candidate, { payloadSchemas }).value;
}

export function checkpointFromRow(row: CheckpointRow): AttemptCheckpoint {
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
