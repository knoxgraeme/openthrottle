import {
  ATTEMPT_FORENSICS_PAYLOAD_SCHEMA,
  EXECUTION_RECORD_SCHEMA,
  INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA,
  canonicalJson,
  digestCanonicalJson,
  type BlobPointer,
  type DecisionRecord,
} from "@openthrottle/contracts";
import type { KernelAttemptForensicsEvidence } from "../../runtime/kernel-contracts.js";
import type { KernelAttempt } from "./types.js";

export const ATTEMPT_FORENSICS_REDUCER = "core/attempt-forensics@1" as const;
export const INVALID_RESULT_EVIDENCE_REDUCER = "core/invalid-result-evidence@1" as const;

export function attemptForensicsRecordId(
  attempt: Pick<
    KernelAttempt,
    "pipeline_run_id" | "id" | "request_hash" | "definition_bundle_hash"
  >,
  workRetryOrdinal: number,
): string {
  return `decision-${digestCanonicalJson({
    reducer: ATTEMPT_FORENSICS_REDUCER,
    pipeline_run_id: attempt.pipeline_run_id,
    attempt_id: attempt.id,
    request_hash: attempt.request_hash,
    definition_bundle_hash: attempt.definition_bundle_hash,
    work_retry_ordinal: workRetryOrdinal,
  }).slice(0, 48)}`;
}

export function invalidResultEvidenceRecordId(
  attempt: Pick<KernelAttempt, "id">,
  pointer: BlobPointer,
): string {
  return `decision-${digestCanonicalJson({
    reducer: INVALID_RESULT_EVIDENCE_REDUCER,
    attempt_id: attempt.id,
    blob_digest: pointer.digest,
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
}): DecisionRecord {
  if (input.evidence.blob.payload_schema !== ATTEMPT_FORENSICS_PAYLOAD_SCHEMA) {
    throw new Error("attempt forensics pointer uses another payload schema");
  }
  return evidenceRecord({
    id: attemptForensicsRecordId(input.attempt, input.attempt.work_retry_ordinal),
    attempt: input.attempt,
    reducer: ATTEMPT_FORENSICS_REDUCER,
    pointer: input.evidence.blob,
    created_at: input.evidence.observed_at,
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
    id: invalidResultEvidenceRecordId(input.attempt, input.pointer),
    attempt: input.attempt,
    reducer: INVALID_RESULT_EVIDENCE_REDUCER,
    pointer: input.pointer,
    created_at: input.created_at,
  });
}

export function assertExactInvalidResultEvidenceRecord(input: {
  attempt: KernelAttempt;
  pointer: BlobPointer;
  record: DecisionRecord;
}): void {
  const expected = createInvalidResultEvidenceRecord({
    attempt: input.attempt,
    pointer: input.pointer,
    created_at: input.record.created_at,
  });
  if (canonicalJson(input.record) !== canonicalJson(expected)) {
    throw new Error("invalid-result evidence record does not match its Attempt and blob pointer");
  }
}
