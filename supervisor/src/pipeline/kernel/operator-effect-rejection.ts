import { Buffer } from "node:buffer";
import {
  EXECUTION_RECORD_SCHEMA,
  INLINE_RECORD_PAYLOAD_MAX_BYTES,
  canonicalJson,
  digestCanonicalJson,
  validateEffectIntent,
  type DeliveryRecord,
  type EffectIntent,
} from "@openthrottle/contracts";
import type { KernelOperatorEffectRejectionRequest } from "./ports.js";
import { effectIntentContentHash } from "./effect-intent.js";

export const OPERATOR_EFFECT_REJECTION_RESULT_SCHEMA =
  "openthrottle.operator-effect-rejection/v1" as const;
const OPERATOR_EFFECT_REJECTION_RESOLUTION_SCHEMA =
  "openthrottle.operator-effect-rejection-resolution/v1" as const;
const OPERATOR_EFFECT_REJECTION_DELIVERY_IDENTITY_SCHEMA =
  "openthrottle.operator-effect-rejection-delivery-identity/v1" as const;
export const OPERATOR_EFFECT_REJECTION_REASON_CODE =
  "legacy_integration_idempotency_key_rejected_before_mutation" as const;
export const OPERATOR_EFFECT_REJECTION_EFFECT_KIND = "daytona/integrate-checkpoint@1" as const;
export const OPERATOR_EFFECT_REJECTION_RUNTIME_SNAPSHOT =
  "openthrottle-2eb524571c32" as const;
const LEGACY_INTEGRATION_IDEMPOTENCY_KEY_MAX_LENGTH = 200;
const INTEGRATION_IDEMPOTENCY_KEY_MAX_LENGTH = 500;
const LEGACY_INTEGRATION_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]+$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EVIDENCE_TEXT_MAX_LENGTH = 1_500;

export class KernelOperatorEffectRejectionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KernelOperatorEffectRejectionConflictError";
  }
}

export class KernelOperatorEffectRejectionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KernelOperatorEffectRejectionNotFoundError";
  }
}

export type OperatorEffectRejectionEvidence = {
  schema: typeof OPERATOR_EFFECT_REJECTION_RESULT_SCHEMA;
  resolution_id: string;
  reason_code: typeof OPERATOR_EFFECT_REJECTION_REASON_CODE;
  reason: string;
  authorized_via: "deploy_token";
  maintenance_version: number;
  captured_run_version: number;
  captured_effect_version: number;
  intent_hash: string;
  dispatch_fence: { lease_id: string; worker_id: string };
  reconciliation_ordinal: number;
  prior_unknown_detail: string;
  prior_unknown_detail_hash: string;
  runtime_snapshot: typeof OPERATOR_EFFECT_REJECTION_RUNTIME_SNAPSHOT;
  runtime_identity: string;
  runtime_create_effect_id: string;
  idempotency_key_length: number;
  resolution_digest: string;
};

function conflict(message: string): never {
  throw new KernelOperatorEffectRejectionConflictError(message);
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !ID.test(value)) conflict(`${path} is invalid`);
  return value;
}

function boundedEvidenceText(value: unknown, path: string): string {
  if (
    typeof value !== "string" || value.trim().length === 0 ||
    value.length > EVIDENCE_TEXT_MAX_LENGTH || value.includes("\0")
  ) conflict(`${path} must contain between 1 and ${EVIDENCE_TEXT_MAX_LENGTH} safe characters`);
  return value;
}

function nonnegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    conflict(`${path} must be a nonnegative integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, path: string): number {
  const parsed = nonnegativeInteger(value, path);
  if (parsed < 1) conflict(`${path} must be positive`);
  return parsed;
}

function digest(value: unknown, path: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) conflict(`${path} is invalid`);
  return value;
}

function canonicalTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string") conflict(`${path} is invalid`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    conflict(`${path} is invalid`);
  }
  return value;
}

function exactObject(
  value: unknown,
  path: string,
  fields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    conflict(`${path} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const unexpected = Object.keys(input).find((key) => !fields.includes(key));
  if (unexpected) conflict(`${path}.${unexpected} is not allowed`);
  const missing = fields.find((key) => !(key in input));
  if (missing) conflict(`${path}.${missing} is required`);
  return input;
}

function validatedOperatorRequest(
  request: KernelOperatorEffectRejectionRequest,
): KernelOperatorEffectRejectionRequest {
  const pipelineRunId = identifier(request.pipeline_run_id, "operator_rejection.pipeline_run_id");
  const effectId = identifier(request.effect_id, "operator_rejection.effect_id");
  const resolutionId = identifier(request.resolution_id, "operator_rejection.resolution_id");
  const maintenanceVersion = nonnegativeInteger(
    request.expected_maintenance_version,
    "operator_rejection.expected_maintenance_version",
  );
  if (request.reason_code !== OPERATOR_EFFECT_REJECTION_REASON_CODE) {
    conflict("operator_rejection.reason_code is unsupported");
  }
  return {
    pipeline_run_id: pipelineRunId,
    effect_id: effectId,
    expected_maintenance_version: maintenanceVersion,
    resolution_id: resolutionId,
    reason_code: OPERATOR_EFFECT_REJECTION_REASON_CODE,
    reason: boundedEvidenceText(request.reason, "operator_rejection.reason"),
  };
}

export function operatorEffectRejectionResolutionDigest(
  requestInput: KernelOperatorEffectRejectionRequest,
): string {
  const request = validatedOperatorRequest(requestInput);
  return digestCanonicalJson({
    schema: OPERATOR_EFFECT_REJECTION_RESOLUTION_SCHEMA,
    pipeline_run_id: request.pipeline_run_id,
    effect_id: request.effect_id,
    resolution_id: request.resolution_id,
    reason_code: request.reason_code,
    reason: request.reason,
    expected_maintenance_version: request.expected_maintenance_version,
  });
}

function deliveryId(input: { resolution_digest: string; intent_hash: string }): string {
  return `delivery-${digestCanonicalJson({
    schema: OPERATOR_EFFECT_REJECTION_DELIVERY_IDENTITY_SCHEMA,
    resolution_digest: input.resolution_digest,
    intent_hash: input.intent_hash,
  })}`;
}

function legacyIntegrationRejectionProof(
  intent: EffectIntent,
  runtimeCreateIntentInput: EffectIntent,
): {
  idempotency_key_length: number;
  runtime_identity: string;
  runtime_create_effect_id: string;
} {
  const runtimeCreateIntent = validateEffectIntent(runtimeCreateIntentInput, {
    source: "operator_rejection.runtime_create_effect_intent",
  }).value;
  if (
    runtimeCreateIntent.pipeline_run_id !== intent.pipeline_run_id ||
    runtimeCreateIntent.kind !== "daytona/create-sandbox@1"
  ) {
    conflict("operator rejection has no exact runtime creation authority");
  }
  const runtimePayload = exactObject(
    runtimeCreateIntent.payload,
    "operator_rejection.runtime_create_payload",
    [
      "schema", "identity", "pipeline_run_id", "repository", "base_branch",
      "base_commit", "snapshot",
    ],
  );
  const integrationPayload = exactObject(
    intent.payload,
    "operator_rejection.integration_payload",
    [
      "schema", "identity", "pipeline_run_id", "attempt_id", "definition_bundle_hash",
      "checkpoint_base_subject", "current_subject", "candidate_checkpoint_id",
      "candidate_input_subject", "candidate_output_subject", "candidate_blob",
      "candidate_artifact", "current_ancestry",
    ],
  );
  if (
    runtimePayload.schema !== "openthrottle.daytona-create/v1" ||
    runtimePayload.pipeline_run_id !== intent.pipeline_run_id ||
    runtimePayload.snapshot !== OPERATOR_EFFECT_REJECTION_RUNTIME_SNAPSHOT
  ) {
    conflict("operator rejection is not supported for this runtime snapshot");
  }
  if (
    integrationPayload.schema !== "openthrottle.daytona-integration/v1" ||
    integrationPayload.pipeline_run_id !== intent.pipeline_run_id ||
    typeof runtimePayload.identity !== "string" ||
    integrationPayload.identity !== runtimePayload.identity
  ) {
    conflict("operator rejection integration does not use the exact created runtime");
  }
  const length = intent.idempotency_key.length;
  if (
    length <= LEGACY_INTEGRATION_IDEMPOTENCY_KEY_MAX_LENGTH ||
    length > INTEGRATION_IDEMPOTENCY_KEY_MAX_LENGTH ||
    !LEGACY_INTEGRATION_IDEMPOTENCY_KEY.test(intent.idempotency_key)
  ) {
    conflict("operator rejection does not match the legacy integration idempotency-key failure");
  }
  return {
    idempotency_key_length: length,
    runtime_identity: identifier(runtimePayload.identity, "operator_rejection.runtime_identity"),
    runtime_create_effect_id: runtimeCreateIntent.id,
  };
}

export function createOperatorEffectRejectionDelivery(input: {
  request: KernelOperatorEffectRejectionRequest;
  intent: EffectIntent;
  captured_run_version: number;
  captured_effect_version: number;
  intent_hash: string;
  dispatch_fence: { lease_id: string; worker_id: string };
  reconciliation_ordinal: number;
  prior_unknown_detail: string;
  runtime_create_intent: EffectIntent;
  created_at: string;
}): DeliveryRecord {
  const request = validatedOperatorRequest(input.request);
  const intent = validateEffectIntent(input.intent, { source: "operator_rejection.effect_intent" }).value;
  if (intent.pipeline_run_id !== request.pipeline_run_id) {
    conflict("operator rejection belongs to another pipeline run");
  }
  if (intent.id !== request.effect_id) conflict("operator rejection belongs to another Effect");
  if (intent.kind !== OPERATOR_EFFECT_REJECTION_EFFECT_KIND) {
    conflict(`operator rejection is not supported for Effect kind ${intent.kind}`);
  }
  const rejectionProof = legacyIntegrationRejectionProof(intent, input.runtime_create_intent);
  const intentHash = digest(input.intent_hash, "operator_rejection.intent_hash");
  if (intentHash !== effectIntentContentHash(intent)) {
    conflict("operator rejection intent hash does not match the exact Effect");
  }
  const dispatchFence = {
    lease_id: identifier(input.dispatch_fence.lease_id, "operator_rejection.dispatch_fence.lease_id"),
    worker_id: identifier(input.dispatch_fence.worker_id, "operator_rejection.dispatch_fence.worker_id"),
  };
  const priorUnknownDetail = boundedEvidenceText(
    input.prior_unknown_detail,
    "operator_rejection.prior_unknown_detail",
  );
  const resolutionDigest = operatorEffectRejectionResolutionDigest(request);
  const evidence: OperatorEffectRejectionEvidence = {
    schema: OPERATOR_EFFECT_REJECTION_RESULT_SCHEMA,
    resolution_id: request.resolution_id,
    reason_code: request.reason_code,
    reason: request.reason,
    authorized_via: "deploy_token",
    maintenance_version: request.expected_maintenance_version,
    captured_run_version: nonnegativeInteger(
      input.captured_run_version,
      "operator_rejection.captured_run_version",
    ),
    captured_effect_version: nonnegativeInteger(
      input.captured_effect_version,
      "operator_rejection.captured_effect_version",
    ),
    intent_hash: intentHash,
    dispatch_fence: dispatchFence,
    reconciliation_ordinal: positiveInteger(
      input.reconciliation_ordinal,
      "operator_rejection.reconciliation_ordinal",
    ),
    prior_unknown_detail: priorUnknownDetail,
    prior_unknown_detail_hash: digestCanonicalJson(priorUnknownDetail),
    runtime_snapshot: OPERATOR_EFFECT_REJECTION_RUNTIME_SNAPSHOT,
    runtime_identity: rejectionProof.runtime_identity,
    runtime_create_effect_id: rejectionProof.runtime_create_effect_id,
    idempotency_key_length: rejectionProof.idempotency_key_length,
    resolution_digest: resolutionDigest,
  };
  const payload = {
    effect_kind: intent.kind,
    provider: "operator",
    observed_via: "operator_resolution",
    result: evidence,
  } as const;
  if (Buffer.byteLength(canonicalJson(payload), "utf8") > INLINE_RECORD_PAYLOAD_MAX_BYTES) {
    conflict("operator rejection evidence exceeds the inline DeliveryRecord bound");
  }
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: deliveryId({ resolution_digest: resolutionDigest, intent_hash: intentHash }),
    kind: "delivery",
    pipeline_run_id: intent.pipeline_run_id,
    effect_id: intent.id,
    idempotency_key: intent.idempotency_key,
    external_identity: intent.target,
    status: "rejected",
    payload_schema: "openthrottle.effect-delivery/v1",
    payload: { inline: payload },
    created_at: canonicalTimestamp(input.created_at, "operator_rejection.created_at"),
  };
}

export function parseOperatorEffectRejectionEvidence(
  value: unknown,
  path: string,
): OperatorEffectRejectionEvidence {
  const result = exactObject(value, path, [
    "schema", "resolution_id", "reason_code", "reason", "authorized_via",
    "maintenance_version", "captured_run_version", "captured_effect_version",
    "intent_hash", "dispatch_fence", "reconciliation_ordinal", "prior_unknown_detail",
    "prior_unknown_detail_hash", "runtime_snapshot", "runtime_identity",
    "runtime_create_effect_id", "idempotency_key_length", "resolution_digest",
  ]);
  if (result.schema !== OPERATOR_EFFECT_REJECTION_RESULT_SCHEMA) {
    conflict(`${path}.schema is unsupported`);
  }
  if (result.reason_code !== OPERATOR_EFFECT_REJECTION_REASON_CODE) {
    conflict(`${path}.reason_code is unsupported`);
  }
  if (result.authorized_via !== "deploy_token") {
    conflict(`${path}.authorized_via has another authorization provenance`);
  }
  const dispatchFenceInput = exactObject(
    result.dispatch_fence,
    `${path}.dispatch_fence`,
    ["lease_id", "worker_id"],
  );
  const evidence: OperatorEffectRejectionEvidence = {
    schema: OPERATOR_EFFECT_REJECTION_RESULT_SCHEMA,
    resolution_id: identifier(result.resolution_id, `${path}.resolution_id`),
    reason_code: OPERATOR_EFFECT_REJECTION_REASON_CODE,
    reason: boundedEvidenceText(result.reason, `${path}.reason`),
    authorized_via: "deploy_token",
    maintenance_version: nonnegativeInteger(
      result.maintenance_version,
      `${path}.maintenance_version`,
    ),
    captured_run_version: nonnegativeInteger(
      result.captured_run_version,
      `${path}.captured_run_version`,
    ),
    captured_effect_version: nonnegativeInteger(
      result.captured_effect_version,
      `${path}.captured_effect_version`,
    ),
    intent_hash: digest(result.intent_hash, `${path}.intent_hash`),
    dispatch_fence: {
      lease_id: identifier(
        dispatchFenceInput.lease_id,
        `${path}.dispatch_fence.lease_id`,
      ),
      worker_id: identifier(
        dispatchFenceInput.worker_id,
        `${path}.dispatch_fence.worker_id`,
      ),
    },
    reconciliation_ordinal: positiveInteger(
      result.reconciliation_ordinal,
      `${path}.reconciliation_ordinal`,
    ),
    prior_unknown_detail: boundedEvidenceText(
      result.prior_unknown_detail,
      `${path}.prior_unknown_detail`,
    ),
    prior_unknown_detail_hash: digest(
      result.prior_unknown_detail_hash,
      `${path}.prior_unknown_detail_hash`,
    ),
    runtime_snapshot: result.runtime_snapshot === OPERATOR_EFFECT_REJECTION_RUNTIME_SNAPSHOT
      ? OPERATOR_EFFECT_REJECTION_RUNTIME_SNAPSHOT
      : conflict(`${path}.runtime_snapshot is unsupported`),
    runtime_identity: identifier(result.runtime_identity, `${path}.runtime_identity`),
    runtime_create_effect_id: identifier(
      result.runtime_create_effect_id,
      `${path}.runtime_create_effect_id`,
    ),
    idempotency_key_length: positiveInteger(
      result.idempotency_key_length,
      `${path}.idempotency_key_length`,
    ),
    resolution_digest: digest(
      result.resolution_digest,
      `${path}.resolution_digest`,
    ),
  };
  if (evidence.prior_unknown_detail_hash !== digestCanonicalJson(evidence.prior_unknown_detail)) {
    conflict(`${path}.prior_unknown_detail_hash does not match prior_unknown_detail`);
  }
  return evidence;
}

export function operatorEffectRejectionEvidence(
  delivery: DeliveryRecord,
): OperatorEffectRejectionEvidence {
  if (
    delivery.kind !== "delivery" || delivery.status !== "rejected" ||
    delivery.payload_schema !== "openthrottle.effect-delivery/v1" || !("inline" in delivery.payload)
  ) conflict("existing operator rejection is not an inline rejected effect DeliveryRecord");
  const payload = exactObject(delivery.payload.inline, "operator_rejection.payload", [
    "effect_kind", "provider", "observed_via", "result",
  ]);
  if (payload.effect_kind !== OPERATOR_EFFECT_REJECTION_EFFECT_KIND) {
    conflict("existing operator rejection has another Effect kind");
  }
  if (payload.provider !== "operator" || payload.observed_via !== "operator_resolution") {
    conflict("existing operator rejection has another provenance");
  }
  return parseOperatorEffectRejectionEvidence(
    payload.result,
    "operator_rejection.payload.result",
  );
}

export function assertExactOperatorEffectRejectionReplay(input: {
  request: KernelOperatorEffectRejectionRequest;
  intent: EffectIntent;
  delivery: DeliveryRecord;
  current_run_version: number;
  current_effect_version: number;
  current_intent_hash: string;
  current_dispatch_fence: { lease_id: string; worker_id: string };
  reconciliation_ordinal: number;
  runtime_create_intent: EffectIntent;
}): OperatorEffectRejectionEvidence {
  const request = validatedOperatorRequest(input.request);
  const intent = validateEffectIntent(input.intent, { source: "operator_rejection.effect_intent" }).value;
  const evidence = operatorEffectRejectionEvidence(input.delivery);
  const rejectionProof = legacyIntegrationRejectionProof(intent, input.runtime_create_intent);
  const expectedResolutionDigest = operatorEffectRejectionResolutionDigest(request);
  const currentIntentHash = digest(input.current_intent_hash, "operator_rejection.intent_hash");
  const currentRunVersion = nonnegativeInteger(
    input.current_run_version,
    "operator_rejection.current_run_version",
  );
  const currentEffectVersion = nonnegativeInteger(
    input.current_effect_version,
    "operator_rejection.current_effect_version",
  );
  const currentDispatchFence = {
    lease_id: identifier(
      input.current_dispatch_fence.lease_id,
      "operator_rejection.dispatch_fence.lease_id",
    ),
    worker_id: identifier(
      input.current_dispatch_fence.worker_id,
      "operator_rejection.dispatch_fence.worker_id",
    ),
  };
  if (
    input.delivery.id !== deliveryId({
      resolution_digest: expectedResolutionDigest,
      intent_hash: currentIntentHash,
    }) ||
    input.delivery.pipeline_run_id !== intent.pipeline_run_id ||
    input.delivery.effect_id !== intent.id ||
    input.delivery.idempotency_key !== intent.idempotency_key ||
    input.delivery.external_identity !== intent.target ||
    evidence.resolution_id !== request.resolution_id ||
    evidence.reason_code !== request.reason_code || evidence.reason !== request.reason ||
    evidence.maintenance_version !== request.expected_maintenance_version ||
    evidence.resolution_digest !== expectedResolutionDigest ||
    currentIntentHash !== effectIntentContentHash(intent) ||
    evidence.intent_hash !== currentIntentHash ||
    evidence.captured_run_version >= currentRunVersion ||
    evidence.captured_effect_version + 1 !== currentEffectVersion ||
    evidence.dispatch_fence.lease_id !== currentDispatchFence.lease_id ||
    evidence.dispatch_fence.worker_id !== currentDispatchFence.worker_id ||
    evidence.reconciliation_ordinal !== input.reconciliation_ordinal
    || evidence.runtime_snapshot !== OPERATOR_EFFECT_REJECTION_RUNTIME_SNAPSHOT
    || evidence.runtime_identity !== rejectionProof.runtime_identity
    || evidence.runtime_create_effect_id !== rejectionProof.runtime_create_effect_id
    || evidence.idempotency_key_length !== rejectionProof.idempotency_key_length
  ) conflict("operator Effect rejection replay conflicts with its immutable evidence");
  return evidence;
}
