import { Buffer } from "node:buffer";
import type { JsonValue } from "@openthrottle/contracts";
import type {
  AttemptScope,
  AttemptLeasePurpose,
  KernelAttempt,
} from "./types.js";

export const KERNEL_STEERING_ENVELOPE_SCHEMA =
  "openthrottle.kernel-steering-envelope/v1" as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const GIT_SUBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_STEERING_BODY_BYTES = 32 * 1024;

export interface KernelRuntimeSessionBinding {
  pipeline_run_id: string;
  attempt_id: string;
  request_hash: string;
  definition_bundle_hash: string;
  input_subject: string;
  native_session_id: string;
  /** Supervisor-private slot affinity; never serialized into the public envelope. */
  scope: AttemptScope;
  /**
   * Stable session-phase ordinal: work_retry_ordinal for work, or
   * result_correction_count for result correction. Attempt.version is not a
   * generation because lease renewal increments it without changing session.
   */
  generation: number;
  attempt_status: KernelAttempt["status"];
  repository_authority: KernelAttempt["repository_authority"];
  lease_id: string;
  /** Recovery epoch for the otherwise stable lease identity. */
  lease_generation: number;
  lease_worker_id: string;
  lease_purpose: AttemptLeasePurpose;
  lease_expires_at: string;
  lease_started: true;
}

export interface KernelRuntimeSessionBindRequest {
  pipeline_run_id: string;
  attempt_id: string;
  request_hash: string;
  definition_bundle_hash: string;
  input_subject: string;
  lease_id: string;
  lease_generation: number;
  worker_id: string;
  lease_purpose: AttemptLeasePurpose;
  work_retry_ordinal: number;
  result_correction_count: number;
  native_session_id: string;
}

export interface KernelSteeringGenerationSource {
  /** Used by the atomic binder's CAS, but deliberately excluded from generation. */
  attempt_version: number;
  work_retry_ordinal: number;
  result_correction_count: number;
  lease_purpose: AttemptLeasePurpose;
}

export function deriveKernelSteeringGeneration(
  input: KernelSteeringGenerationSource,
): number {
  for (const [name, value] of [
    ["attempt_version", input.attempt_version],
    ["work_retry_ordinal", input.work_retry_ordinal],
    ["result_correction_count", input.result_correction_count],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`steering ${name} is invalid`);
    }
  }
  if (input.lease_purpose === "result_correction") {
    if (input.result_correction_count < 1) {
      throw new Error("a result-correction session requires a consumed correction ordinal");
    }
    return input.result_correction_count;
  }
  return input.work_retry_ordinal;
}

/**
 * Implementations persist the native session through the attempt CAS before
 * returning. The atomic loader/binder must read status, version,
 * work_retry_ordinal, result_correction_count, native_session_id, and the full
 * lease tuple and phase ordinals from the same Attempt row; it derives generation with
 * deriveKernelSteeringGeneration. A process-local provider conversation
 * identifier is never a steering authority. A genuine work retry must clear
 * the prior native_session_id before binding its new work lease; result
 * correction intentionally retains the completed work session.
 */
export interface KernelRuntimeSessionBindingPort {
  bindRuntimeSession(
    request: KernelRuntimeSessionBindRequest,
  ): Promise<KernelRuntimeSessionBinding>;
  loadCurrentRuntimeSession(input: {
    pipeline_run_id: string;
    attempt_id: string;
  }): Promise<KernelRuntimeSessionBinding | null>;
}

export interface KernelSteeringEnvelope {
  schema: typeof KERNEL_STEERING_ENVELOPE_SCHEMA;
  message_id: string;
  source: "human" | "operator";
  body: string;
  binding: {
    pipeline_run_id: string;
    attempt_id: string;
    request_hash: string;
    definition_bundle_hash: string;
    input_subject: string;
    native_session_id: string;
    generation: number;
    lease_id: string;
    lease_generation: number;
    lease_purpose: AttemptLeasePurpose;
  };
}

export interface AuthorizedKernelSteering {
  message_id: string;
  source: KernelSteeringEnvelope["source"];
  body: string;
  pipeline_run_id: string;
  attempt_id: string;
  request_hash: string;
  definition_bundle_hash: string;
  input_subject: string;
  native_session_id: string;
  /** Durable Attempt scope used only for supervisor-to-provider slot selection. */
  scope: AttemptScope;
  generation: number;
  lease_id: string;
  lease_generation: number;
  lease_purpose: AttemptLeasePurpose;
  policy: {
    phase: "work" | "result_correction";
    repository_authority: KernelAttempt["repository_authority"];
    result_only: boolean;
    allowed_tools: "attempt_profile" | readonly ["ot-result"];
    mcp: "attempt_profile" | false;
    provider_access: "attempt_profile" | false;
  };
}

function nonEmptyId(value: string, name: string): string {
  if (!ID.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function assertScope(scope: AttemptScope): void {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new Error("steering Attempt scope is invalid");
  }
  nonEmptyId(scope.stage_id, "steering scope stage_id");
  if (scope.kind === "stage") return;
  nonEmptyId(scope.parent_attempt_id, "steering scope parent_attempt_id");
  if (scope.kind === "loop_item") {
    nonEmptyId(scope.loop_id, "steering scope loop_id");
    nonEmptyId(scope.item_id, "steering scope item_id");
    if (!Number.isSafeInteger(scope.item_index) || scope.item_index < 0) {
      throw new Error("steering scope item_index is invalid");
    }
    return;
  }
  if (scope.kind === "fanout_member") {
    nonEmptyId(scope.fanout_id, "steering scope fanout_id");
    nonEmptyId(scope.member_id, "steering scope member_id");
    if (!Number.isSafeInteger(scope.member_index) || scope.member_index < 0) {
      throw new Error("steering scope member_index is invalid");
    }
    return;
  }
  throw new Error("steering Attempt scope kind is invalid");
}

function assertBinding(binding: KernelRuntimeSessionBinding): void {
  nonEmptyId(binding.pipeline_run_id, "steering pipeline_run_id");
  nonEmptyId(binding.attempt_id, "steering attempt_id");
  nonEmptyId(binding.native_session_id, "steering native_session_id");
  nonEmptyId(binding.lease_id, "steering lease_id");
  nonEmptyId(binding.lease_worker_id, "steering lease_worker_id");
  assertScope(binding.scope);
  if (!DIGEST.test(binding.request_hash) || !DIGEST.test(binding.definition_bundle_hash)) {
    throw new Error("steering request or bundle hash is invalid");
  }
  if (!GIT_SUBJECT.test(binding.input_subject)) {
    throw new Error("steering input subject is invalid");
  }
  if (!Number.isSafeInteger(binding.generation) || binding.generation < 0) {
    throw new Error("steering generation is invalid");
  }
  if (!Number.isSafeInteger(binding.lease_generation) || binding.lease_generation < 0) {
    throw new Error("steering lease_generation is invalid");
  }
  if (
    !Number.isFinite(Date.parse(binding.lease_expires_at)) ||
    new Date(binding.lease_expires_at).toISOString() !== binding.lease_expires_at
  ) throw new Error("steering lease expiry is invalid");
  if (!binding.lease_started) throw new Error("steering requires a started attempt lease");
  if (
    (binding.lease_purpose === "work" && binding.attempt_status !== "running") ||
    (binding.lease_purpose === "result_correction" && binding.attempt_status !== "result_pending")
  ) {
    throw new Error("steering target is not in its bound live phase");
  }
}

export function createKernelSteeringEnvelope(input: {
  message_id: string;
  source: KernelSteeringEnvelope["source"];
  body: string;
  binding: KernelRuntimeSessionBinding;
}): KernelSteeringEnvelope {
  assertBinding(input.binding);
  nonEmptyId(input.message_id, "steering message_id");
  if (
    typeof input.body !== "string" || input.body.trim().length === 0 || input.body.includes("\0") ||
    Buffer.byteLength(input.body, "utf8") > MAX_STEERING_BODY_BYTES
  ) {
    throw new Error(`steering body must contain at most ${MAX_STEERING_BODY_BYTES} UTF-8 bytes`);
  }
  if (input.source !== "human" && input.source !== "operator") {
    throw new Error("steering source is invalid");
  }
  return {
    schema: KERNEL_STEERING_ENVELOPE_SCHEMA,
    message_id: input.message_id,
    source: input.source,
    body: input.body.replace(/\r\n?/g, "\n"),
    binding: {
      pipeline_run_id: input.binding.pipeline_run_id,
      attempt_id: input.binding.attempt_id,
      request_hash: input.binding.request_hash,
      definition_bundle_hash: input.binding.definition_bundle_hash,
      input_subject: input.binding.input_subject,
      native_session_id: input.binding.native_session_id,
      generation: input.binding.generation,
      lease_id: input.binding.lease_id,
      lease_generation: input.binding.lease_generation,
      lease_purpose: input.binding.lease_purpose,
    },
  };
}

function exactEnvelope(value: KernelSteeringEnvelope): KernelSteeringEnvelope {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    value.schema !== KERNEL_STEERING_ENVELOPE_SCHEMA ||
    !value.binding || typeof value.binding !== "object"
  ) {
    throw new Error("steering envelope is malformed");
  }
  return value;
}

export function authorizeKernelSteeringDelivery(input: {
  envelope: KernelSteeringEnvelope;
  current_binding: KernelRuntimeSessionBinding | null;
}): AuthorizedKernelSteering {
  const envelope = exactEnvelope(input.envelope);
  const current = input.current_binding;
  if (!current) throw new Error("steering target has no durable runtime session binding");
  assertBinding(current);
  const expected = createKernelSteeringEnvelope({
    message_id: envelope.message_id,
    source: envelope.source,
    body: envelope.body,
    binding: current,
  });
  const fields = [
    "pipeline_run_id", "attempt_id", "request_hash", "definition_bundle_hash",
    "input_subject", "native_session_id", "generation", "lease_id", "lease_generation",
    "lease_purpose",
  ] as const;
  const mismatch = fields.find((field) => envelope.binding[field] !== expected.binding[field]);
  if (mismatch) throw new Error(`steering ${mismatch} binding is stale or mismatched`);

  const correction = current.lease_purpose === "result_correction";
  return {
    message_id: envelope.message_id,
    source: envelope.source,
    body: envelope.body,
    pipeline_run_id: current.pipeline_run_id,
    attempt_id: current.attempt_id,
    request_hash: current.request_hash,
    definition_bundle_hash: current.definition_bundle_hash,
    input_subject: current.input_subject,
    native_session_id: current.native_session_id,
    scope: current.scope,
    generation: current.generation,
    lease_id: current.lease_id,
    lease_generation: current.lease_generation,
    lease_purpose: current.lease_purpose,
    policy: correction
      ? {
        phase: "result_correction",
        repository_authority: "inspect",
        result_only: true,
        allowed_tools: ["ot-result"],
        mcp: false,
        provider_access: false,
      }
      : {
        phase: "work",
        repository_authority: current.repository_authority,
        result_only: false,
        allowed_tools: "attempt_profile",
        mcp: "attempt_profile",
        provider_access: "attempt_profile",
      },
  };
}

export function kernelSteeringEnvelopePayload(
  envelope: KernelSteeringEnvelope,
): JsonValue {
  return envelope as unknown as JsonValue;
}
