import { Buffer } from "node:buffer";
import { canonicalJson } from "./canonical.js";
import {
  GIT_SUBJECT,
  NATIVE_SESSION_ID,
  SHA256,
  arrayAt,
  enumAt,
  fail,
  integerAt,
  jsonValueAt,
  normalizedContract,
  nullable,
  objectAt,
  stringAt,
  timestampAt,
  unique,
  type JsonValue,
  type ValidatedContract,
} from "./validation.js";

export const ATTEMPT_IDENTITY_SCHEMA = "openthrottle.attempt-identity/v1" as const;
export const ATTEMPT_STATES = [
  "pending", "running", "work_complete", "result_pending", "recorded", "settled",
  "needs_human", "failed", "canceled", "superseded",
] as const;
export const EXECUTION_RECORD_SCHEMA = "openthrottle.record/v1" as const;
export const EXECUTION_RECORD_KINDS = ["result", "decision", "delivery"] as const;
export const BLOB_POINTER_ALGORITHMS = ["sha256"] as const;
export const INLINE_RECORD_PAYLOAD_MAX_BYTES = 64 * 1024;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const PAYLOAD_SCHEMA = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

export interface AttemptIdentity {
  schema: typeof ATTEMPT_IDENTITY_SCHEMA;
  pipeline_run_id: string;
  attempt_id: string;
  request_hash: string;
  definition_bundle_hash: string;
  input_subject: string;
  native_session_id: string | null;
}

export interface BlobPointer {
  algorithm: "sha256";
  digest: string;
  bytes: number;
  encoding: "utf-8" | "binary";
  media_type: string;
  payload_schema: string;
}

export type ExecutionRecordKind = (typeof EXECUTION_RECORD_KINDS)[number];
export type AttemptState = (typeof ATTEMPT_STATES)[number];
export type RecordPayload = { inline: JsonValue } | { blob: BlobPointer };

export interface ExecutionRecordPayloadContract {
  kind: ExecutionRecordKind;
  parseInline(value: unknown, path: string): unknown;
}

export type ExecutionRecordPayloadRegistry = ReadonlyMap<string, ExecutionRecordPayloadContract>;

interface ExecutionRecordBase {
  schema: typeof EXECUTION_RECORD_SCHEMA;
  id: string;
  pipeline_run_id: string;
  payload_schema: string;
  payload: RecordPayload;
  created_at: string;
}

export interface ResultRecord extends ExecutionRecordBase {
  kind: "result";
  attempt_id: string;
  request_hash: string;
  definition_bundle_hash: string;
  input_subject: string;
  output_subject: string | null;
  original_candidate_hash: string;
  normalized_candidate_hash: string;
}

export interface DecisionRecord extends ExecutionRecordBase {
  kind: "decision";
  reducer: string;
  input_record_ids: string[];
}

export interface DeliveryRecord extends ExecutionRecordBase {
  kind: "delivery";
  effect_id: string;
  idempotency_key: string;
  external_identity: string;
  status: "confirmed" | "rejected";
}

export type ExecutionRecord = ResultRecord | DecisionRecord | DeliveryRecord;

function id(value: unknown, path: string): string {
  return stringAt(value, path, { max: 200, pattern: ID });
}

function digest(value: unknown, path: string): string {
  return stringAt(value, path, { pattern: SHA256 });
}

function parseBlobPointer(value: unknown, path: string): BlobPointer {
  const input = objectAt(value, path, [
    "algorithm", "digest", "bytes", "encoding", "media_type", "payload_schema",
  ]);
  return {
    algorithm: enumAt(input.algorithm, `${path}.algorithm`, BLOB_POINTER_ALGORITHMS),
    digest: digest(input.digest, `${path}.digest`),
    bytes: integerAt(input.bytes, `${path}.bytes`, 1, Number.MAX_SAFE_INTEGER),
    encoding: enumAt(input.encoding, `${path}.encoding`, ["utf-8", "binary"] as const),
    media_type: stringAt(input.media_type, `${path}.media_type`, { max: 160, pattern: MEDIA_TYPE }),
    payload_schema: stringAt(input.payload_schema, `${path}.payload_schema`, {
      max: 200,
      pattern: PAYLOAD_SCHEMA,
    }),
  };
}

export function validateBlobPointer(
  value: unknown,
  options: { source?: string } = {},
): ValidatedContract<BlobPointer> {
  return normalizedContract(parseBlobPointer(value, options.source ?? "blob_pointer"));
}

function parseRecordPayload(
  value: unknown,
  path: string,
  payloadSchema: string,
  payloadContract: ExecutionRecordPayloadContract,
): RecordPayload {
  const input = objectAt(value, path, ["inline", "blob"]);
  if ((input.inline === undefined) === (input.blob === undefined)) {
    fail(path, "must define exactly one of inline or blob");
  }
  if (input.blob !== undefined) {
    const blob = parseBlobPointer(input.blob, `${path}.blob`);
    if (blob.payload_schema !== payloadSchema) {
      fail(`${path}.blob.payload_schema`, "must match the record payload_schema");
    }
    return { blob };
  }
  const inlinePath = `${path}.inline`;
  const inline = jsonValueAt(payloadContract.parseInline(input.inline, inlinePath), inlinePath);
  if (Buffer.byteLength(canonicalJson(inline), "utf8") > INLINE_RECORD_PAYLOAD_MAX_BYTES) {
    fail(`${path}.inline`, `must be at most ${INLINE_RECORD_PAYLOAD_MAX_BYTES} canonical JSON bytes`);
  }
  return { inline };
}

export function validateAttemptIdentity(
  value: unknown,
  options: { source?: string } = {},
): ValidatedContract<AttemptIdentity> {
  const source = options.source ?? "attempt_identity";
  const input = objectAt(value, source, [
    "schema", "pipeline_run_id", "attempt_id", "request_hash", "definition_bundle_hash",
    "input_subject", "native_session_id",
  ]);
  if (input.schema !== ATTEMPT_IDENTITY_SCHEMA) {
    fail(`${source}.schema`, `must be ${ATTEMPT_IDENTITY_SCHEMA}`);
  }
  return normalizedContract({
    schema: ATTEMPT_IDENTITY_SCHEMA,
    pipeline_run_id: id(input.pipeline_run_id, `${source}.pipeline_run_id`),
    attempt_id: id(input.attempt_id, `${source}.attempt_id`),
    request_hash: digest(input.request_hash, `${source}.request_hash`),
    definition_bundle_hash: digest(input.definition_bundle_hash, `${source}.definition_bundle_hash`),
    input_subject: stringAt(input.input_subject, `${source}.input_subject`, { pattern: GIT_SUBJECT }),
    native_session_id: nullable(input.native_session_id, (entry) =>
      stringAt(entry, `${source}.native_session_id`, { pattern: NATIVE_SESSION_ID })),
  });
}

function recordInput(value: unknown, source: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(source, "must be an object");
  return value as Record<string, unknown>;
}

const BASE_FIELDS = ["schema", "id", "kind", "pipeline_run_id", "payload_schema", "payload", "created_at"];
const RESULT_FIELDS = [
  ...BASE_FIELDS, "attempt_id", "request_hash", "definition_bundle_hash", "input_subject", "output_subject",
  "original_candidate_hash", "normalized_candidate_hash",
];
const DECISION_FIELDS = [...BASE_FIELDS, "reducer", "input_record_ids"];
const DELIVERY_FIELDS = [...BASE_FIELDS, "effect_id", "idempotency_key", "external_identity", "status"];

export function validateExecutionRecord(
  value: unknown,
  options: { source?: string; payloadSchemas: ExecutionRecordPayloadRegistry },
): ValidatedContract<ExecutionRecord> {
  const source = options.source ?? "record";
  const probe = recordInput(value, source);
  const kind = enumAt(probe.kind, `${source}.kind`, EXECUTION_RECORD_KINDS);
  const input = objectAt(
    value,
    source,
    kind === "result" ? RESULT_FIELDS : kind === "decision" ? DECISION_FIELDS : DELIVERY_FIELDS,
  );
  if (input.schema !== EXECUTION_RECORD_SCHEMA) {
    fail(`${source}.schema`, `must be ${EXECUTION_RECORD_SCHEMA}`);
  }
  const payloadSchema = stringAt(input.payload_schema, `${source}.payload_schema`, {
    max: 200,
    pattern: PAYLOAD_SCHEMA,
  });
  const payloadContract = options.payloadSchemas.get(payloadSchema);
  if (!payloadContract) fail(`${source}.payload_schema`, "is not registered");
  if (payloadContract.kind !== kind) {
    fail(`${source}.payload_schema`, `is registered for ${payloadContract.kind} records, not ${kind}`);
  }
  const base = {
    schema: EXECUTION_RECORD_SCHEMA,
    id: id(input.id, `${source}.id`),
    pipeline_run_id: id(input.pipeline_run_id, `${source}.pipeline_run_id`),
    payload_schema: payloadSchema,
    payload: parseRecordPayload(input.payload, `${source}.payload`, payloadSchema, payloadContract),
    created_at: timestampAt(input.created_at, `${source}.created_at`, { normalize: false }),
  };
  if (kind === "result") {
    return normalizedContract<ResultRecord>({
      ...base,
      kind,
      attempt_id: id(input.attempt_id, `${source}.attempt_id`),
      request_hash: digest(input.request_hash, `${source}.request_hash`),
      definition_bundle_hash: digest(input.definition_bundle_hash, `${source}.definition_bundle_hash`),
      input_subject: stringAt(input.input_subject, `${source}.input_subject`, { pattern: GIT_SUBJECT }),
      output_subject: nullable(input.output_subject, (entry) =>
        stringAt(entry, `${source}.output_subject`, { pattern: GIT_SUBJECT })),
      original_candidate_hash: digest(input.original_candidate_hash, `${source}.original_candidate_hash`),
      normalized_candidate_hash: digest(input.normalized_candidate_hash, `${source}.normalized_candidate_hash`),
    });
  }
  if (kind === "decision") {
    return normalizedContract<DecisionRecord>({
      ...base,
      kind,
      reducer: stringAt(input.reducer, `${source}.reducer`, { max: 200, pattern: PAYLOAD_SCHEMA }),
      input_record_ids: unique(arrayAt(
        input.input_record_ids,
        `${source}.input_record_ids`,
        (entry, path) => id(entry, path),
        { min: 1, max: 256 },
      ), `${source}.input_record_ids`),
    });
  }
  return normalizedContract<DeliveryRecord>({
    ...base,
    kind,
    effect_id: id(input.effect_id, `${source}.effect_id`),
    idempotency_key: stringAt(input.idempotency_key, `${source}.idempotency_key`, { max: 500 }),
    external_identity: stringAt(input.external_identity, `${source}.external_identity`, { max: 1_000 }),
    status: enumAt(input.status, `${source}.status`, ["confirmed", "rejected"] as const),
  });
}
