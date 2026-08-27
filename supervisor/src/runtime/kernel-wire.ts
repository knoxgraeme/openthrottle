import { Buffer } from "node:buffer";
import {
  ATTEMPT_CHECKPOINT_SCHEMA,
  INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA,
  NATIVE_SESSION_ID,
  canonicalJson,
  compareCodeUnits,
  validateAndNormalizeResultCandidate,
  validateAttemptCheckpoint,
  validateEvidenceArtifactDescriptor,
  validateInvalidResultEvidencePayload,
  type AttemptCheckpoint,
  type AttemptEvidencePayloadSchema,
  type BlobPointer,
  type EvidenceArtifactDescriptor,
  type InvalidResultEvidencePayload,
  type SemanticResultSchemaContract,
} from "@openthrottle/contracts";
import {
  isCompatibleOrdinaryCheckpointRef,
} from "./kernel-checkpoint-bundle.js";
import {
  KERNEL_ACTION_REQUEST_SCHEMA,
  KERNEL_RESULT_CORRECTION_REQUEST_SCHEMA,
  STAGED_SEMANTIC_CANDIDATE_SCHEMA,
  type KernelResultCorrectionRequest,
  type KernelMaterializedArtifact,
  type KernelRuntimeOutcome,
  type KernelWorkActionRequest,
} from "./kernel-contracts.js";

export const KERNEL_RUNTIME_RESULT_SCHEMA = "openthrottle.kernel-runtime-result/v1" as const;
export const KERNEL_SESSION_EVENT_SCHEMA = "openthrottle.kernel-session-event/v1" as const;
export const ATTEMPT_CHECKPOINT_WIRE_SCHEMA = "openthrottle.attempt-checkpoint-wire/v1" as const;
export const KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

type KernelRequest = KernelWorkActionRequest | KernelResultCorrectionRequest;

export interface KernelSessionEvent {
  schema: typeof KERNEL_SESSION_EVENT_SCHEMA;
  pipeline_run_id: string;
  attempt_id: string;
  request_hash: string;
  definition_bundle_hash: string;
  lease_id: string;
  worker_id: string;
  native_session_id: string;
  observed_at: string;
}

export interface KernelCheckpointArtifactDescriptor {
  file: string;
  sha256: string;
  bytes: number;
  media_type: "application/x-git-bundle";
  payload_schema: string;
  ref: string;
  commit: string;
  tree: string;
}

export interface KernelCheckpointArtifactPort {
  materialize(
    input: KernelCheckpointArtifactDescriptor | EvidenceArtifactDescriptor,
  ): Promise<KernelMaterializedArtifact>;
}

const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const ARTIFACT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a canonical timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a canonical timestamp`);
  }
  return value;
}

function string(value: unknown, label: string, maximum = 1_500): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function assertEnvelopeIdentity(value: Record<string, unknown>, request: KernelRequest): void {
  for (const field of [
    "pipeline_run_id", "attempt_id", "request_hash", "definition_bundle_hash",
    "lease_id", "worker_id",
  ] as const) {
    if (value[field] !== request[field]) {
      throw new Error(`kernel runtime envelope changed ${field}`);
    }
  }
}

export function parseKernelSessionEvent(raw: string, request: KernelRequest): KernelSessionEvent {
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) {
    throw new Error("kernel session event exceeds 64 KiB");
  }
  const input = object(JSON.parse(raw), "kernel session event");
  exactKeys(input, [
    "schema", "pipeline_run_id", "attempt_id", "request_hash", "definition_bundle_hash",
    "lease_id", "worker_id", "native_session_id", "observed_at",
  ], "kernel session event");
  if (input.schema !== KERNEL_SESSION_EVENT_SCHEMA) {
    throw new Error("kernel session event schema is unsupported");
  }
  assertEnvelopeIdentity(input, request);
  return {
    schema: KERNEL_SESSION_EVENT_SCHEMA,
    pipeline_run_id: request.pipeline_run_id,
    attempt_id: request.attempt_id,
    request_hash: request.request_hash,
    definition_bundle_hash: request.definition_bundle_hash,
    lease_id: request.lease_id,
    worker_id: request.worker_id,
    native_session_id: (() => {
      const value = string(input.native_session_id, "native_session_id", 200);
      if (!NATIVE_SESSION_ID.test(value)) throw new Error("native_session_id has an invalid format");
      return value;
    })(),
    observed_at: timestamp(input.observed_at, "observed_at"),
  };
}

function semanticResult(value: unknown, schema: SemanticResultSchemaContract) {
  const input = object(value, "semantic result");
  exactKeys(input, ["kind", "candidate"], "semantic result");
  if (input.kind !== "semantic") throw new Error("semantic result kind is invalid");
  const staged = object(input.candidate, "staged result candidate");
  exactKeys(staged, [
    "schema", "semantic_schema_id", "original", "original_hash", "candidate",
    "normalized_hash", "transformations",
  ], "staged result candidate");
  if (
    staged.schema !== STAGED_SEMANTIC_CANDIDATE_SCHEMA ||
    staged.semantic_schema_id !== schema.id
  ) throw new Error("staged result candidate changed its sealed semantic schema");
  const normalized = validateAndNormalizeResultCandidate(staged.original, schema, {
    source: "runtime_result.outcome.result.candidate.original",
  });
  if (
    staged.original_hash !== normalized.original_hash ||
    staged.normalized_hash !== normalized.normalized_hash ||
    canonicalJson(staged.candidate) !== canonicalJson(normalized.value) ||
    canonicalJson(staged.transformations) !== canonicalJson(normalized.transformations)
  ) throw new Error("staged result candidate does not match deterministic normalization");
  return {
    kind: "semantic" as const,
    candidate: {
      schema: STAGED_SEMANTIC_CANDIDATE_SCHEMA,
      semantic_schema_id: schema.id,
      original: staged.original as never,
      original_hash: normalized.original_hash,
      candidate: normalized.value,
      normalized_hash: normalized.normalized_hash,
      transformations: normalized.transformations,
    },
  };
}

function commandResult(value: unknown) {
  const input = object(value, "command result");
  exactKeys(input, ["kind", "outcome", "command_id", "exit_code", "summary"], "command result");
  if (
    input.kind !== "command" ||
    !["success", "no_change", "retryable_infrastructure_failure", "failure"].includes(String(input.outcome)) ||
    typeof input.exit_code !== "number" || !Number.isSafeInteger(input.exit_code) ||
    input.exit_code < 0 || input.exit_code > 255
  ) throw new Error("command result is invalid");
  return {
    kind: "command" as const,
    outcome: input.outcome as "success" | "no_change" | "retryable_infrastructure_failure" | "failure",
    command_id: string(input.command_id, "command_id", 200),
    exit_code: input.exit_code,
    summary: string(input.summary, "command summary", 4_000),
  };
}

function artifactDescriptor(value: unknown, payloadSchema: string): KernelCheckpointArtifactDescriptor {
  const input = object(value, "checkpoint artifact");
  exactKeys(input, [
    "file", "sha256", "bytes", "media_type", "payload_schema", "ref", "commit", "tree",
  ], "checkpoint artifact");
  if (
    typeof input.file !== "string" || !ARTIFACT_FILE.test(input.file) ||
    input.file.includes("..") || input.file.includes("/") ||
    typeof input.sha256 !== "string" || !DIGEST.test(input.sha256) ||
    typeof input.bytes !== "number" || !Number.isSafeInteger(input.bytes) ||
    input.bytes < 1 || input.bytes > KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES ||
    input.media_type !== "application/x-git-bundle" ||
    input.payload_schema !== payloadSchema ||
    typeof input.ref !== "string" ||
    !/^refs\/openthrottle\/checkpoints\/[a-f0-9]{64}$/.test(input.ref) ||
    typeof input.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(input.commit) ||
    typeof input.tree !== "string" || !/^[a-f0-9]{40,64}$/.test(input.tree)
  ) throw new Error("checkpoint artifact descriptor is invalid");
  return {
    file: input.file,
    sha256: input.sha256,
    bytes: input.bytes,
    media_type: "application/x-git-bundle",
    payload_schema: input.payload_schema as string,
    ref: input.ref,
    commit: input.commit,
    tree: input.tree,
  };
}

async function evidencePointer(
  value: unknown,
  payloadSchema: AttemptEvidencePayloadSchema,
  artifacts: KernelCheckpointArtifactPort,
): Promise<{ blob: BlobPointer; payload: InvalidResultEvidencePayload }> {
  const descriptor = validateEvidenceArtifactDescriptor(value, {
    source: "runtime_result.outcome.invalid_result_evidence",
    payloadSchema,
  }).value;
  const materialized = await artifacts.materialize(descriptor);
  if (!("blob" in materialized) || !("evidence_payload" in materialized)) {
    throw new Error("materialized evidence artifact omitted its verified payload");
  }
  const pointer = materialized.blob;
  if (
    pointer.digest !== descriptor.sha256 || pointer.bytes !== descriptor.bytes ||
    pointer.encoding !== "utf-8" || pointer.media_type !== descriptor.media_type ||
    pointer.payload_schema !== descriptor.payload_schema
  ) throw new Error("materialized evidence artifact changed its sealed descriptor");
  return {
    blob: pointer,
    payload: validateInvalidResultEvidencePayload(materialized.evidence_payload, {
      source: "runtime_result.outcome.invalid_result_evidence.payload",
    }).value,
  };
}

async function checkpoint(
  value: unknown,
  request: KernelRequest,
  artifacts: KernelCheckpointArtifactPort,
): Promise<AttemptCheckpoint> {
  const input = object(value, "wire checkpoint");
  exactKeys(input, [
    "schema", "id", "pipeline_run_id", "attempt_id", "request_hash",
    "definition_bundle_hash", "input_subject", "output_subject", "native_session_id",
    "payload_schema", "payload_artifact", "captured_at",
  ], "wire checkpoint");
  if (input.schema !== ATTEMPT_CHECKPOINT_WIRE_SCHEMA) {
    throw new Error("wire checkpoint schema is unsupported");
  }
  for (const field of [
    "pipeline_run_id", "attempt_id", "request_hash", "definition_bundle_hash", "input_subject",
  ] as const) {
    if (input[field] !== request[field]) throw new Error(`wire checkpoint changed ${field}`);
  }
  if (typeof input.id !== "string" || !ID.test(input.id)) throw new Error("wire checkpoint ID is invalid");
  if (
    input.output_subject !== null &&
    (typeof input.output_subject !== "string" || !/^[a-f0-9]{40,64}$/.test(input.output_subject))
  ) throw new Error("wire checkpoint output subject is invalid");
  if (
    input.native_session_id !== null &&
    (typeof input.native_session_id !== "string" || !NATIVE_SESSION_ID.test(input.native_session_id))
  ) {
    throw new Error("wire checkpoint native session ID is invalid");
  }
  const payloadSchema = string(input.payload_schema, "checkpoint payload schema", 200);
  const descriptor = artifactDescriptor(input.payload_artifact, payloadSchema);
  if (!isCompatibleOrdinaryCheckpointRef({
    ref: descriptor.ref,
    commit: descriptor.commit,
    request_hash: request.request_hash,
  })) {
    throw new Error("checkpoint artifact ref does not match its commit or sealed request");
  }
  const mutatingWork = request.schema === KERNEL_ACTION_REQUEST_SCHEMA &&
    request.repository_authority === "edit" && request.action.kind === "agent";
  const lockedCorrection = request.schema === KERNEL_RESULT_CORRECTION_REQUEST_SCHEMA;
  const correctionOutput = lockedCorrection && request.completed_work_authority === "edit"
    ? request.locked_subject
    : null;
  if (
    (lockedCorrection && request.completed_work_authority === "edit" &&
      descriptor.commit !== request.locked_subject) ||
    (lockedCorrection && input.output_subject !== correctionOutput) ||
    (mutatingWork && input.output_subject !== descriptor.commit) ||
    (!mutatingWork && !lockedCorrection && input.output_subject !== null)
  ) {
    throw new Error("checkpoint output subject does not match its repository authority");
  }
  const pointer = await artifacts.materialize(descriptor);
  if ("blob" in pointer) {
    throw new Error("materialized checkpoint artifact returned evidence payload metadata");
  }
  if (
    pointer.digest !== descriptor.sha256 || pointer.bytes !== descriptor.bytes ||
    pointer.encoding !== "binary" || pointer.media_type !== descriptor.media_type ||
    pointer.payload_schema !== descriptor.payload_schema
  ) throw new Error("materialized checkpoint artifact changed its sealed descriptor");
  return validateAttemptCheckpoint({
    schema: ATTEMPT_CHECKPOINT_SCHEMA,
    id: input.id,
    pipeline_run_id: request.pipeline_run_id,
    attempt_id: request.attempt_id,
    request_hash: request.request_hash,
    definition_bundle_hash: request.definition_bundle_hash,
    input_subject: request.input_subject,
    output_subject: input.output_subject,
    native_session_id: input.native_session_id,
    payload_schema: payloadSchema,
    payload: { blob: pointer },
    captured_at: timestamp(input.captured_at, "checkpoint captured_at"),
  }).value;
}

function diagnostics(value: unknown): { path: string; detail: string }[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("runtime diagnostics are invalid");
  return value.map((candidate, index) => {
    const item = object(candidate, `runtime diagnostics[${index}]`);
    exactKeys(item, ["path", "detail"], `runtime diagnostics[${index}]`);
    return {
      path: string(item.path, `runtime diagnostics[${index}].path`, 500),
      detail: string(item.detail, `runtime diagnostics[${index}].detail`, 1_500),
    };
  }).sort((left, right) =>
    compareCodeUnits(left.path, right.path) || compareCodeUnits(left.detail, right.detail));
}

function semanticSchema(request: KernelRequest): SemanticResultSchemaContract {
  if (request.schema === KERNEL_RESULT_CORRECTION_REQUEST_SCHEMA) {
    return request.semantic_result_schema;
  }
  if (request.schema !== KERNEL_ACTION_REQUEST_SCHEMA || request.action.kind !== "agent") {
    throw new Error("command request has no semantic result schema");
  }
  return request.action.semantic_result_schema;
}

export async function parseKernelRuntimeResult(input: {
  raw: string;
  request: KernelRequest;
  artifacts: KernelCheckpointArtifactPort;
}): Promise<KernelRuntimeOutcome> {
  if (Buffer.byteLength(input.raw, "utf8") > 2 * 1024 * 1024) {
    throw new Error("kernel runtime result exceeds 2 MiB");
  }
  const envelope = object(JSON.parse(input.raw), "kernel runtime result");
  exactKeys(envelope, [
    "schema", "pipeline_run_id", "attempt_id", "request_hash", "definition_bundle_hash",
    "lease_id", "worker_id", "outcome",
  ], "kernel runtime result");
  if (envelope.schema !== KERNEL_RUNTIME_RESULT_SCHEMA) {
    throw new Error("kernel runtime result schema is unsupported");
  }
  assertEnvelopeIdentity(envelope, input.request);
  const outcome = object(envelope.outcome, "kernel runtime outcome");
  if (outcome.state === "work_complete") {
    exactKeys(outcome, ["state", "checkpoint", "result"], "kernel runtime outcome");
    const result = object(outcome.result, "kernel verified result");
    return {
      state: "work_complete",
      checkpoint: await checkpoint(outcome.checkpoint, input.request, input.artifacts),
      result: result.kind === "semantic"
        ? semanticResult(result, semanticSchema(input.request))
        : commandResult(result),
    };
  }
  if (outcome.state === "result_pending") {
    exactKeys(outcome, [
      "state", "checkpoint", "candidate_hash", "diagnostics", "correction_deadline",
      "invalid_result_evidence",
    ], "kernel runtime outcome");
    if (outcome.candidate_hash !== null && (
      typeof outcome.candidate_hash !== "string" || !DIGEST.test(outcome.candidate_hash)
    )) throw new Error("pending candidate hash is invalid");
    const candidateHash = outcome.candidate_hash as string | null;
    const pendingDiagnostics = diagnostics(outcome.diagnostics);
    const evidence = await evidencePointer(
      outcome.invalid_result_evidence,
      INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA,
      input.artifacts,
    );
    if (
      evidence.payload.phase !== input.request.phase ||
      evidence.payload.candidate_hash !== candidateHash ||
      canonicalJson(evidence.payload.diagnostics) !== canonicalJson(pendingDiagnostics)
    ) {
      throw new Error("invalid result evidence changed its runtime result semantics");
    }
    return {
      state: "result_pending",
      checkpoint: await checkpoint(outcome.checkpoint, input.request, input.artifacts),
      candidate_hash: candidateHash,
      diagnostics: pendingDiagnostics,
      correction_deadline: timestamp(outcome.correction_deadline, "correction deadline"),
      invalid_result_evidence: {
        blob: evidence.blob,
        observed_at: evidence.payload.observed_at,
      },
    };
  }
  if (outcome.state === "work_failed") {
    exactKeys(outcome, ["state", "retryable", "reason"], "kernel runtime outcome");
    if (typeof outcome.retryable !== "boolean") throw new Error("work failure retryable flag is invalid");
    return {
      state: "work_failed",
      retryable: outcome.retryable,
      reason: string(outcome.reason, "work failure reason"),
    };
  }
  if (outcome.state === "needs_human") {
    exactKeys(outcome, [
      "state", "reason", "checkpoint", "candidate_hash", "diagnostics",
    ], "kernel runtime outcome");
    if (outcome.candidate_hash !== null && (
      typeof outcome.candidate_hash !== "string" || !DIGEST.test(outcome.candidate_hash)
    )) throw new Error("needs-human candidate hash is invalid");
    return {
      state: "needs_human",
      reason: string(outcome.reason, "needs-human reason"),
      checkpoint: outcome.checkpoint === null
        ? null
        : await checkpoint(outcome.checkpoint, input.request, input.artifacts),
      candidate_hash: outcome.candidate_hash as string | null,
      diagnostics: diagnostics(outcome.diagnostics),
    };
  }
  throw new Error("kernel runtime outcome state is unsupported");
}
