import {
  EXECUTION_RECORD_SCHEMA,
  canonicalJson,
  compareCodeUnits,
  digestCanonicalJson,
  validateBlobPointer,
  type BlobPointer,
  type DecisionRecord,
  type ExecutionRecord,
  type ExecutionRecordPayloadContract,
  type JsonValue,
} from "@openthrottle/contracts";
import type { KernelSessionEvidence } from "../../runtime/kernel-contracts.js";
import type { KernelAttempt } from "./types.js";

export const SESSION_EVIDENCE_RECORD_PAYLOAD_SCHEMA =
  "openthrottle.session-evidence/v1" as const;
export const SESSION_EVIDENCE_REDUCER = "core/session-evidence@1" as const;
export const OTEL_SESSION_TRANSCRIPT_PAYLOAD_SCHEMA =
  "openthrottle.otel-session-transcript/v1" as const;
export const COMPOSED_PROMPT_PAYLOAD_SCHEMA =
  "openthrottle.composed-prompt/v1" as const;

export interface SessionEvidenceRecordPayload {
  schema: typeof SESSION_EVIDENCE_RECORD_PAYLOAD_SCHEMA;
  attempt_id: string;
  stage_id: string;
  native_session_id: string;
  transcript: BlobPointer;
  prompt_context: BlobPointer;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parseSessionEvidenceRecordPayload(
  value: unknown,
  path = "session_evidence",
): SessionEvidenceRecordPayload {
  const input = object(value, path);
  const expected = [
    "schema", "attempt_id", "stage_id", "native_session_id", "transcript", "prompt_context",
  ].sort(compareCodeUnits);
  const actual = Object.keys(input).sort(compareCodeUnits);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${path} has unknown or missing fields`);
  }
  if (
    input.schema !== SESSION_EVIDENCE_RECORD_PAYLOAD_SCHEMA ||
    typeof input.attempt_id !== "string" || typeof input.stage_id !== "string" ||
    typeof input.native_session_id !== "string"
  ) throw new Error(`${path} identity is invalid`);
  const transcript = validateBlobPointer(input.transcript, {
    source: `${path}.transcript`,
  }).value;
  const promptContext = validateBlobPointer(input.prompt_context, {
    source: `${path}.prompt_context`,
  }).value;
  if (
    transcript.encoding !== "utf-8" || transcript.media_type !== "application/json" ||
    transcript.payload_schema !== OTEL_SESSION_TRANSCRIPT_PAYLOAD_SCHEMA
  ) throw new Error(`${path}.transcript is not OTel session evidence`);
  if (
    promptContext.encoding !== "utf-8" || promptContext.media_type !== "text/plain" ||
    promptContext.payload_schema !== COMPOSED_PROMPT_PAYLOAD_SCHEMA
  ) throw new Error(`${path}.prompt_context is not composed-prompt evidence`);
  return {
    schema: SESSION_EVIDENCE_RECORD_PAYLOAD_SCHEMA,
    attempt_id: input.attempt_id,
    stage_id: input.stage_id,
    native_session_id: input.native_session_id,
    transcript,
    prompt_context: promptContext,
  };
}

export const SESSION_EVIDENCE_RECORD_PAYLOAD_CONTRACT: ExecutionRecordPayloadContract =
  Object.freeze({
    kind: "decision" as const,
    parseInline: parseSessionEvidenceRecordPayload,
  });

export function sessionEvidenceRecordId(
  attempt: Pick<KernelAttempt, "pipeline_run_id" | "id" | "request_hash" | "definition_bundle_hash">,
): string {
  return `decision-${digestCanonicalJson({
    reducer: SESSION_EVIDENCE_REDUCER,
    pipeline_run_id: attempt.pipeline_run_id,
    attempt_id: attempt.id,
    request_hash: attempt.request_hash,
    definition_bundle_hash: attempt.definition_bundle_hash,
  }).slice(0, 48)}`;
}

export function createSessionEvidenceRecord(input: {
  attempt: KernelAttempt;
  evidence: KernelSessionEvidence;
  created_at: string;
}): DecisionRecord {
  if (input.attempt.native_session_id === null) {
    throw new Error("session evidence requires the Attempt's native session binding");
  }
  const payload = parseSessionEvidenceRecordPayload({
    schema: SESSION_EVIDENCE_RECORD_PAYLOAD_SCHEMA,
    attempt_id: input.attempt.id,
    stage_id: input.attempt.scope.stage_id,
    native_session_id: input.attempt.native_session_id,
    transcript: input.evidence.transcript,
    prompt_context: input.evidence.prompt_context,
  });
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: sessionEvidenceRecordId(input.attempt),
    kind: "decision",
    pipeline_run_id: input.attempt.pipeline_run_id,
    reducer: SESSION_EVIDENCE_REDUCER,
    input_record_ids: [],
    payload_schema: SESSION_EVIDENCE_RECORD_PAYLOAD_SCHEMA,
    payload: { inline: payload as unknown as JsonValue },
    created_at: input.created_at,
  };
}

export function assertExactSessionEvidenceRecord(input: {
  attempt: KernelAttempt;
  record: ExecutionRecord;
}): void {
  const record = input.record;
  if (
    record.kind !== "decision" || record.id !== sessionEvidenceRecordId(input.attempt) ||
    record.pipeline_run_id !== input.attempt.pipeline_run_id ||
    record.reducer !== SESSION_EVIDENCE_REDUCER || record.input_record_ids.length !== 0 ||
    record.payload_schema !== SESSION_EVIDENCE_RECORD_PAYLOAD_SCHEMA || !("inline" in record.payload)
  ) throw new Error("session evidence record does not match its Attempt");
  const payload = parseSessionEvidenceRecordPayload(record.payload.inline);
  if (
    payload.attempt_id !== input.attempt.id || payload.stage_id !== input.attempt.scope.stage_id ||
    payload.native_session_id !== input.attempt.native_session_id
  ) throw new Error("session evidence record changed its Attempt session identity");
}

export function sessionEvidenceRecords(records: Iterable<ExecutionRecord>): DecisionRecord[] {
  return [...records].filter((record): record is DecisionRecord =>
    record.kind === "decision" && record.reducer === SESSION_EVIDENCE_REDUCER &&
    record.payload_schema === SESSION_EVIDENCE_RECORD_PAYLOAD_SCHEMA)
    .sort((left, right) => compareCodeUnits(left.id, right.id));
}
