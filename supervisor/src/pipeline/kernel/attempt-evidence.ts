import {
  EXECUTION_RECORD_SCHEMA,
  digestCanonicalJson,
  jsonValueAt,
  type BlobPointer,
  type DecisionRecord,
  type ExecutionRecordPayloadContract,
  type JsonValue,
} from "@openthrottle/contracts";
import {
  ATTEMPT_FORENSICS_PAYLOAD_SCHEMA,
  INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA,
  type KernelAttemptForensicsEvidence,
} from "../../runtime/kernel-contracts.js";
import type { KernelAttempt, ResultDiagnostic } from "./types.js";

export const ATTEMPT_FORENSICS_REDUCER = "core/attempt-forensics@1" as const;
export const INVALID_RESULT_EVIDENCE_REDUCER = "core/invalid-result-evidence@1" as const;

export interface AttemptForensicsPayload {
  schema: typeof ATTEMPT_FORENSICS_PAYLOAD_SCHEMA;
  pipeline_run_id: string;
  attempt_id: string;
  request_hash: string;
  definition_bundle_hash: string;
  lease_id: string;
  operational_signature: string;
  exit_code: number;
  runner_stdout_tail: string;
  runner_stderr_tail: string;
  result_path_state: JsonValue;
  session_event_state: JsonValue;
  workspace_git_status: JsonValue;
}

export interface InvalidResultEvidencePayload {
  schema: typeof INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA;
  pipeline_run_id: string;
  attempt_id: string;
  request_hash: string;
  definition_bundle_hash: string;
  phase: "work" | "result_correction";
  candidate_hash: string | null;
  rejected_candidate: JsonValue | null;
  diagnostics: readonly ResultDiagnostic[];
  runner_stdout_tail: string;
  runner_stderr_tail: string;
  observed_at: string;
}

function exactObject(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join("\0") !== [...keys].sort().join("\0")
  ) throw new Error(`${label} has unknown or missing fields`);
  return input;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  const candidate = boundedString(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(candidate)) throw new Error(`${label} is invalid`);
  return candidate;
}

function diagnostics(value: unknown): ResultDiagnostic[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("evidence diagnostics are invalid");
  return value.map((entry, index) => {
    const item = exactObject(entry, `evidence diagnostics[${index}]`, ["path", "detail"]);
    return {
      path: boundedString(item.path, `evidence diagnostics[${index}].path`, 500),
      detail: boundedString(item.detail, `evidence diagnostics[${index}].detail`, 1_500),
    };
  });
}

export function parseAttemptForensicsPayload(value: unknown): AttemptForensicsPayload {
  const input = exactObject(value, "attempt forensics", [
    "schema", "pipeline_run_id", "attempt_id", "request_hash", "definition_bundle_hash",
    "lease_id", "operational_signature", "exit_code",
    "runner_stdout_tail", "runner_stderr_tail", "result_path_state", "session_event_state",
    "workspace_git_status",
  ]);
  if (
    input.schema !== ATTEMPT_FORENSICS_PAYLOAD_SCHEMA ||
    !Number.isSafeInteger(input.exit_code) || (input.exit_code as number) < 0 ||
    (input.exit_code as number) > 255
  ) throw new Error("attempt forensics identity is invalid");
  return {
    schema: ATTEMPT_FORENSICS_PAYLOAD_SCHEMA,
    pipeline_run_id: boundedString(input.pipeline_run_id, "attempt forensics pipeline_run_id", 200),
    attempt_id: boundedString(input.attempt_id, "attempt forensics attempt_id", 200),
    request_hash: digest(input.request_hash, "attempt forensics request_hash"),
    definition_bundle_hash: digest(input.definition_bundle_hash, "attempt forensics definition_bundle_hash"),
    lease_id: boundedString(input.lease_id, "attempt forensics lease_id", 200),
    operational_signature: digest(input.operational_signature, "attempt forensics operational_signature"),
    exit_code: input.exit_code as number,
    runner_stdout_tail: boundedString(input.runner_stdout_tail, "attempt forensics stdout", 16_384),
    runner_stderr_tail: boundedString(input.runner_stderr_tail, "attempt forensics stderr", 16_384),
    result_path_state: jsonValueAt(input.result_path_state, "attempt_forensics.result_path_state"),
    session_event_state: jsonValueAt(input.session_event_state, "attempt_forensics.session_event_state"),
    workspace_git_status: jsonValueAt(input.workspace_git_status, "attempt_forensics.workspace_git_status"),
  };
}

export function parseInvalidResultEvidencePayload(value: unknown): InvalidResultEvidencePayload {
  const input = exactObject(value, "invalid result evidence", [
    "schema", "pipeline_run_id", "attempt_id", "request_hash", "definition_bundle_hash",
    "phase", "candidate_hash", "rejected_candidate", "diagnostics", "runner_stdout_tail",
    "runner_stderr_tail", "observed_at",
  ]);
  if (
    input.schema !== INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA ||
    (input.phase !== "work" && input.phase !== "result_correction") ||
    (input.candidate_hash !== null && !/^[a-f0-9]{64}$/.test(String(input.candidate_hash))) ||
    typeof input.observed_at !== "string" || !Number.isFinite(Date.parse(input.observed_at))
  ) throw new Error("invalid result evidence identity is invalid");
  return {
    schema: INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA,
    pipeline_run_id: boundedString(input.pipeline_run_id, "invalid evidence pipeline_run_id", 200),
    attempt_id: boundedString(input.attempt_id, "invalid evidence attempt_id", 200),
    request_hash: digest(input.request_hash, "invalid evidence request_hash"),
    definition_bundle_hash: digest(input.definition_bundle_hash, "invalid evidence definition_bundle_hash"),
    phase: input.phase,
    candidate_hash: input.candidate_hash as string | null,
    rejected_candidate: input.rejected_candidate === null
      ? null
      : jsonValueAt(input.rejected_candidate, "invalid_evidence.rejected_candidate"),
    diagnostics: diagnostics(input.diagnostics),
    runner_stdout_tail: boundedString(input.runner_stdout_tail, "invalid evidence stdout", 16_384),
    runner_stderr_tail: boundedString(input.runner_stderr_tail, "invalid evidence stderr", 16_384),
    observed_at: input.observed_at,
  };
}

export const ATTEMPT_FORENSICS_PAYLOAD_CONTRACT: ExecutionRecordPayloadContract = Object.freeze({
  kind: "decision" as const,
  parseInline: parseAttemptForensicsPayload,
});

export const INVALID_RESULT_EVIDENCE_PAYLOAD_CONTRACT: ExecutionRecordPayloadContract = Object.freeze({
  kind: "decision" as const,
  parseInline: parseInvalidResultEvidencePayload,
});

export function attemptForensicsRecordId(attemptId: string, workRetryOrdinal: number): string {
  return `decision-${digestCanonicalJson({
    reducer: ATTEMPT_FORENSICS_REDUCER,
    attempt_id: attemptId,
    work_retry_ordinal: workRetryOrdinal,
  }).slice(0, 48)}`;
}

function evidenceRecord(input: {
  id: string;
  attempt: KernelAttempt;
  reducer: string;
  pointer: BlobPointer;
  created_at: string;
}): DecisionRecord {
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: input.id,
    kind: "decision",
    pipeline_run_id: input.attempt.pipeline_run_id,
    reducer: input.reducer,
    input_record_ids: [],
    payload_schema: input.pointer.payload_schema,
    payload: { blob: input.pointer },
    created_at: input.created_at,
  };
}

export function createAttemptForensicsRecord(input: {
  attempt: KernelAttempt;
  evidence: KernelAttemptForensicsEvidence;
  created_at: string;
}): DecisionRecord {
  if (input.evidence.blob.payload_schema !== ATTEMPT_FORENSICS_PAYLOAD_SCHEMA) {
    throw new Error("attempt forensics pointer uses another payload schema");
  }
  return evidenceRecord({
    id: attemptForensicsRecordId(input.attempt.id, input.attempt.work_retry_ordinal),
    attempt: input.attempt,
    reducer: ATTEMPT_FORENSICS_REDUCER,
    pointer: input.evidence.blob,
    created_at: input.created_at,
  });
}

export function createInvalidResultEvidenceRecord(input: {
  attempt: KernelAttempt;
  pointer: BlobPointer;
  created_at: string;
}): DecisionRecord {
  if (input.pointer.payload_schema !== INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA) {
    throw new Error("invalid result evidence pointer uses another payload schema");
  }
  return evidenceRecord({
    id: `decision-${digestCanonicalJson({
      reducer: INVALID_RESULT_EVIDENCE_REDUCER,
      attempt_id: input.attempt.id,
      blob_digest: input.pointer.digest,
    }).slice(0, 48)}`,
    attempt: input.attempt,
    reducer: INVALID_RESULT_EVIDENCE_REDUCER,
    pointer: input.pointer,
    created_at: input.created_at,
  });
}
