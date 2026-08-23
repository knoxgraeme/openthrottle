import { createHash } from "node:crypto";
import { Daytona, type Sandbox } from "@daytona/sdk";
import {
  canonicalJson,
  digestCanonicalJson,
  validateBlobPointer,
  type BlobPointer,
  type EffectIntent,
  type JsonValue,
} from "@openthrottle/contracts";
import type { Config } from "../../app/config.js";
import type {
  KernelRuntimeInventoryPort,
  KernelRuntimeInventoryResource,
} from "../../app/kernel-control.js";
import type { KernelRunEnvironmentPort } from "../../persistence/kernel-runtime-context-store.js";
import type { VolumeBlobStore } from "../../persistence/blob-store.js";
import type { KernelAttemptRequestPort } from "../../pipeline/kernel/ports.js";
import { resolveKernelRuntimeResourceIdentity } from "../../pipeline/kernel/runtime-resource.js";
import type {
  KernelEffectAdapterBinding,
  KernelEffectProviderObservation,
} from "../../app/kernel-effect-ports.js";
import {
  KERNEL_ACTION_REQUEST_SCHEMA,
  type KernelResultCorrectionRequest,
  type KernelRuntimeCompatibilityPort,
  type KernelRuntimeLeaseCallbacks,
  type KernelRuntimeOutcome,
  type KernelRuntimePort,
  type KernelRuntimeWorkCallbacks,
  type KernelWorkActionRequest,
} from "../../runtime/kernel-contracts.js";
import type {
  AuthorizedKernelSteering,
  KernelSteeringEnvelope,
} from "../../pipeline/kernel/steering.js";
import {
  KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES,
  parseKernelRuntimeResult,
  parseKernelSessionEvent,
  type KernelCheckpointArtifactDescriptor,
} from "../../runtime/kernel-wire.js";
import {
  KERNEL_INTEGRATION_ANCESTRY_MAX_ENTRIES,
  inspectKernelCheckpointBundle,
  inspectKernelIntegrationBundle,
} from "../../runtime/kernel-checkpoint-bundle.js";
import {
  assertDaytonaRepositorySourceFence,
  DAYTONA_REPOSITORY_ROOT,
  materializeDaytonaRepositorySource,
} from "./kernel-repository-source.js";
import { shellQuote } from "./shell.js";

const ACTION_INPUT_DIR = "/var/lib/openthrottle/action-input";
const ACTION_RESULT_DIR = "/var/lib/openthrottle/action-results";
const ACTION_FENCE_DIR = "/var/lib/openthrottle/action-fences";
const INTEGRATION_INPUT_DIR = "/var/lib/openthrottle/integration-input";
const INTEGRATION_RESULT_DIR = "/var/lib/openthrottle/integration-results";
const OPENTHROTTLE_ROOT = "/var/lib/openthrottle";
const AGENT_STATE_ROOT = "/home/agent/.ot";
const STEERING_INBOX_DIR = `${AGENT_STATE_ROOT}/inbox`;
const KERNEL_STEERING_DELIVERY_SCHEMA = "openthrottle.kernel-steering/v1" as const;
const KERNEL_STEERING_DELIVERY_MAX_BYTES = 64 * 1024;
const KERNEL_INTEGRATION_SEALED_BUNDLES_MAX_BYTES = KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES;
const ACTIVE_AUTOSTOP_MINUTES = 60;
const DISPATCH_LOCK_CONTENTION_EXIT_CODE = 75;
const DAYTONA_EXECUTOR_GIT = [
  "env",
  ...[
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_SYSTEM",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_OBJECT_DIRECTORY",
    "GIT_WORK_TREE",
  ].flatMap((name) => ["-u", name]),
  "GIT_CONFIG_GLOBAL=/dev/null",
  "GIT_CONFIG_NOSYSTEM=1",
  "GIT_CONFIG_COUNT=0",
  "GIT_NO_REPLACE_OBJECTS=1",
  "GIT_TERMINAL_PROMPT=0",
  "git",
].join(" ");
const MODEL_CREDENTIALS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_AUTH_JSON",
  "KIMI_CODE_API_KEY",
] as const;
const SAFE_PATH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

interface DaytonaKernelOptions {
  snapshot: string;
  github_read_token: string;
  task_timeout_seconds: number;
  runtime_capability_digest: string;
  blob_store: VolumeBlobStore;
  environments: KernelRunEnvironmentPort;
  attempt_inputs: KernelAttemptRequestPort;
  materialize_model_credentials(
    engine: "claude" | "codex" | "opencode",
    actionTimeoutMs?: number,
  ): Promise<Record<string, string>>;
  poll_interval_ms?: number;
}

export interface DaytonaKernelFactoryOptions extends DaytonaKernelOptions {
  api_key: string;
}

interface DaytonaIntentPayload {
  schema: string;
  identity: string;
  pipeline_run_id: string;
  repository: string;
  base_branch: string;
  base_commit: string;
  snapshot: string;
}

interface DaytonaIntegrationPayload {
  schema: "openthrottle.daytona-integration/v1";
  identity: string;
  pipeline_run_id: string;
  attempt_id: string;
  definition_bundle_hash: string;
  checkpoint_base_subject: string;
  current_subject: string;
  candidate_checkpoint_id: string;
  candidate_input_subject: string;
  candidate_output_subject: string;
  candidate_blob: BlobPointer;
  candidate_artifact: KernelCheckpointArtifactDescriptor;
  current_ancestry: readonly DaytonaIntegrationAncestryEntry[];
}

interface DaytonaIntegrationAncestryEntry {
  checkpoint_id: string;
  input_subject: string;
  output_subject: string;
  checkpoint_blob: BlobPointer;
  checkpoint_artifact: KernelCheckpointArtifactDescriptor;
}

interface DaytonaIntegrationResult {
  schema: "openthrottle.kernel-integration-result/v1";
  pipeline_run_id: string;
  effect_id: string;
  idempotency_key: string;
  lease_id: string;
  worker_id: string;
  definition_bundle_hash: string;
  state: "integrated" | "needs_human" | "retryable_failure";
  input_subject: string;
  candidate_checkpoint_id: string;
  output_subject: string | null;
  payload_schema: "openthrottle.git-checkpoint-bundle/v1" | null;
  payload_artifact: KernelCheckpointArtifactDescriptor | null;
  reason: string | null;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function safeAttemptId(value: string): string {
  if (!SAFE_PATH_ID.test(value)) throw new Error("kernel Attempt ID is unsafe for runtime transport");
  return value;
}

function safeTransportId(value: string, label: string): string {
  if (!SAFE_PATH_ID.test(value)) throw new Error(`${label} is unsafe for runtime transport`);
  return value;
}

function launchPaths(
  request: KernelWorkActionRequest | KernelResultCorrectionRequest,
  leaseGeneration: number,
) {
  const attempt = safeAttemptId(request.attempt_id);
  const lease = safeTransportId(request.lease_id, "kernel lease ID");
  const phase = request.schema === KERNEL_ACTION_REQUEST_SCHEMA ? "work" : "correction";
  const launch = `${phase}-${lease}`;
  return {
    input_attempt_directory: `${ACTION_INPUT_DIR}/${attempt}`,
    input_directory: `${ACTION_INPUT_DIR}/${attempt}/${launch}`,
    input: `${ACTION_INPUT_DIR}/${attempt}/${launch}/request.json`,
    result_attempt_directory: `${ACTION_RESULT_DIR}/${attempt}`,
    result_directory: `${ACTION_RESULT_DIR}/${attempt}/${launch}`,
    result: `${ACTION_RESULT_DIR}/${attempt}/${launch}/result.json`,
    session: `${ACTION_RESULT_DIR}/${attempt}/${launch}/session.json`,
    lock: `${ACTION_RESULT_DIR}/${attempt}/dispatch.lock`,
    fence_attempt_directory: `${ACTION_FENCE_DIR}/${attempt}`,
    lease_generation_fence: `${ACTION_FENCE_DIR}/${attempt}/lease-generation.json`,
    // A recovered Attempt keeps its lease ID while its lease generation advances.
    // A crash after upload but before the locked mv must therefore leave a staging
    // file that a later generation can never mistake for its own sealed fence.
    lease_generation_stage: `${ACTION_FENCE_DIR}/${attempt}/lease-generation-${lease}-${leaseGeneration}.part`,
    lease_generation_lock: `${ACTION_FENCE_DIR}/${attempt}/lease-generation.lock`,
  };
}

function actionSessionId(
  request: KernelWorkActionRequest | KernelResultCorrectionRequest,
): string {
  return `kernel-action-${digestCanonicalJson({
    schema: "openthrottle.daytona-action-session/v1",
    pipeline_run_id: request.pipeline_run_id,
    attempt_id: request.attempt_id,
    phase: request.phase,
    lease_id: request.lease_id,
  }).slice(0, 48)}`;
}

function sealedActionTimeoutMs(
  request: KernelWorkActionRequest | KernelResultCorrectionRequest,
  platformTimeoutSeconds: number,
): number {
  const repositorySeconds = request.schema === KERNEL_ACTION_REQUEST_SCHEMA
    ? request.action.execution_limits.task_timeout_seconds
    : request.execution_limits.task_timeout_seconds;
  let timeoutMs = platformTimeoutSeconds * 1_000;
  if (repositorySeconds !== null) timeoutMs = Math.min(timeoutMs, repositorySeconds * 1_000);
  if (request.schema !== KERNEL_ACTION_REQUEST_SCHEMA) {
    timeoutMs = Math.min(timeoutMs, Math.max(1, Date.parse(request.correction_deadline) - Date.now()));
  }
  return timeoutMs;
}

function notFound(error: unknown): boolean {
  return /not[ -]?found|404/i.test(error instanceof Error ? error.message : String(error));
}

function inspectCheckpointBundle(
  bytes: Uint8Array,
  descriptor: KernelCheckpointArtifactDescriptor,
  shallowBoundary: string | null,
  expectedParent: string | null,
): { ref: string; commit: string; tree: string } {
  const inspected = inspectKernelCheckpointBundle({
    bytes,
    expected_commit: descriptor.commit,
    expected_tree: descriptor.tree,
    ...(shallowBoundary === null ? {} : { shallow_boundary: shallowBoundary }),
    ...(expectedParent === null || descriptor.commit === expectedParent
      ? {}
      : { expected_parent: expectedParent }),
    allowed_ref: /^refs\/openthrottle\/(?:checkpoints|integrations)\/[a-f0-9]{64}$/,
  });
  if (inspected.ref !== descriptor.ref) {
    throw new Error("checkpoint bundle commit does not contain its sealed ref or accepted tree");
  }
  return inspected;
}

function integrationPayload(intent: Readonly<EffectIntent>): DaytonaIntegrationPayload {
  const value = object(intent.payload, `effect ${intent.id} payload`);
  const artifact = object(value.candidate_artifact, "integration candidate_artifact");
  const pointer = validateBlobPointer(value.candidate_blob, {
    source: "integration.candidate_blob",
  }).value;
  const expectedKeys = [
    "candidate_artifact", "candidate_blob", "candidate_checkpoint_id",
    "candidate_input_subject", "candidate_output_subject", "checkpoint_base_subject", "current_subject",
    "current_ancestry", "definition_bundle_hash", "identity", "pipeline_run_id", "schema", "attempt_id",
  ].sort();
  if (
    Object.keys(value).sort().join("\0") !== expectedKeys.join("\0") ||
    value.schema !== "openthrottle.daytona-integration/v1" ||
    typeof value.identity !== "string" || !/^[a-f0-9]{64}$/.test(value.identity) ||
    value.pipeline_run_id !== intent.pipeline_run_id ||
    typeof value.attempt_id !== "string" || !SAFE_PATH_ID.test(value.attempt_id) ||
    typeof value.definition_bundle_hash !== "string" || !/^[a-f0-9]{64}$/.test(value.definition_bundle_hash) ||
    typeof value.checkpoint_base_subject !== "string" || !/^[a-f0-9]{40,64}$/.test(value.checkpoint_base_subject) ||
    typeof value.current_subject !== "string" || !/^[a-f0-9]{40,64}$/.test(value.current_subject) ||
    typeof value.candidate_checkpoint_id !== "string" || !SAFE_PATH_ID.test(value.candidate_checkpoint_id) ||
    typeof value.candidate_input_subject !== "string" || !/^[a-f0-9]{40,64}$/.test(value.candidate_input_subject) ||
    typeof value.candidate_output_subject !== "string" || !/^[a-f0-9]{40,64}$/.test(value.candidate_output_subject) ||
    artifact.media_type !== "application/x-git-bundle" ||
    artifact.payload_schema !== "openthrottle.git-checkpoint-bundle/v1" ||
    artifact.sha256 !== pointer.digest || artifact.bytes !== pointer.bytes ||
    pointer.bytes > KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES ||
    artifact.commit !== value.candidate_output_subject ||
    typeof artifact.file !== "string" || !SAFE_PATH_ID.test(artifact.file) ||
    typeof artifact.ref !== "string" ||
    !/^refs\/openthrottle\/(?:checkpoints|integrations)\/[a-f0-9]{64}$/.test(artifact.ref) ||
    typeof artifact.tree !== "string" || !/^[a-f0-9]{40,64}$/.test(artifact.tree) ||
    pointer.encoding !== "binary" || pointer.media_type !== "application/x-git-bundle" ||
    pointer.payload_schema !== "openthrottle.git-checkpoint-bundle/v1"
  ) throw new Error(`effect ${intent.id} has invalid Daytona integration authority`);
  if (
    !Array.isArray(value.current_ancestry) ||
    value.current_ancestry.length > KERNEL_INTEGRATION_ANCESTRY_MAX_ENTRIES
  ) throw new Error(`effect ${intent.id} has invalid bounded current ancestry authority`);
  const currentAncestry: DaytonaIntegrationAncestryEntry[] = [];
  const checkpointIds = new Set<string>();
  const refs = new Set<string>();
  const commits = new Set<string>();
  let aggregateBundleBytes = pointer.bytes;
  let ancestrySubject = value.candidate_input_subject as string;
  for (const [index, candidate] of value.current_ancestry.entries()) {
    const edge = object(candidate, `integration current_ancestry[${index}]`);
    const edgeKeys = [
      "checkpoint_artifact", "checkpoint_blob", "checkpoint_id", "input_subject", "output_subject",
    ].sort();
    const edgeArtifact = object(
      edge.checkpoint_artifact,
      `integration current_ancestry[${index}].checkpoint_artifact`,
    );
    const artifactKeys = [
      "bytes", "commit", "file", "media_type", "payload_schema", "ref", "sha256", "tree",
    ].sort();
    const edgePointer = validateBlobPointer(edge.checkpoint_blob, {
      source: `integration.current_ancestry[${index}].checkpoint_blob`,
    }).value;
    if (
      Object.keys(edge).sort().join("\0") !== edgeKeys.join("\0") ||
      Object.keys(edgeArtifact).sort().join("\0") !== artifactKeys.join("\0") ||
      typeof edge.checkpoint_id !== "string" || !SAFE_PATH_ID.test(edge.checkpoint_id) ||
      typeof edge.input_subject !== "string" || !/^[a-f0-9]{40,64}$/.test(edge.input_subject) ||
      typeof edge.output_subject !== "string" || !/^[a-f0-9]{40,64}$/.test(edge.output_subject) ||
      edge.input_subject !== ancestrySubject || edge.output_subject === edge.input_subject ||
      edgeArtifact.media_type !== "application/x-git-bundle" ||
      edgeArtifact.payload_schema !== "openthrottle.git-checkpoint-bundle/v1" ||
      edgeArtifact.sha256 !== edgePointer.digest || edgeArtifact.bytes !== edgePointer.bytes ||
      edgePointer.bytes > KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES ||
      edgeArtifact.commit !== edge.output_subject ||
      typeof edgeArtifact.file !== "string" || !SAFE_PATH_ID.test(edgeArtifact.file) ||
      typeof edgeArtifact.ref !== "string" ||
      !/^refs\/openthrottle\/integrations\/[a-f0-9]{64}$/.test(edgeArtifact.ref) ||
      typeof edgeArtifact.tree !== "string" || !/^[a-f0-9]{40,64}$/.test(edgeArtifact.tree) ||
      edgePointer.encoding !== "binary" ||
      edgePointer.media_type !== "application/x-git-bundle" ||
      edgePointer.payload_schema !== "openthrottle.git-checkpoint-bundle/v1" ||
      checkpointIds.has(edge.checkpoint_id) || refs.has(edgeArtifact.ref) || commits.has(edgeArtifact.commit)
    ) throw new Error(`effect ${intent.id} has invalid exact current ancestry entry`);
    if (aggregateBundleBytes > KERNEL_INTEGRATION_SEALED_BUNDLES_MAX_BYTES - edgePointer.bytes) {
      throw new Error(`effect ${intent.id} exceeds the aggregate sealed bundle byte ceiling`);
    }
    aggregateBundleBytes += edgePointer.bytes;
    checkpointIds.add(edge.checkpoint_id);
    refs.add(edgeArtifact.ref);
    commits.add(edgeArtifact.commit as string);
    ancestrySubject = edge.output_subject;
    currentAncestry.push({
      checkpoint_id: edge.checkpoint_id,
      input_subject: edge.input_subject,
      output_subject: edge.output_subject,
      checkpoint_blob: edgePointer,
      checkpoint_artifact: edgeArtifact as unknown as KernelCheckpointArtifactDescriptor,
    });
  }
  if (currentAncestry.length > 0 && ancestrySubject !== value.current_subject) {
    throw new Error(`effect ${intent.id} current ancestry does not end at its sealed current subject`);
  }
  return {
    ...(value as unknown as DaytonaIntegrationPayload),
    candidate_blob: pointer,
    candidate_artifact: artifact as unknown as KernelCheckpointArtifactDescriptor,
    current_ancestry: currentAncestry,
  };
}

function integrationPaths(effectId: string, dispatchLeaseId: string) {
  const effect = safeTransportId(effectId, "kernel effect ID");
  const lease = safeTransportId(dispatchLeaseId, "kernel dispatch lease ID");
  return {
    input_effect_directory: `${INTEGRATION_INPUT_DIR}/${effect}`,
    input_directory: `${INTEGRATION_INPUT_DIR}/${effect}/${lease}`,
    input: `${INTEGRATION_INPUT_DIR}/${effect}/${lease}/request.json`,
    result_effect_directory: `${INTEGRATION_RESULT_DIR}/${effect}`,
    result_directory: `${INTEGRATION_RESULT_DIR}/${effect}/${lease}`,
    result: `${INTEGRATION_RESULT_DIR}/${effect}/${lease}/result.json`,
    lock: `${INTEGRATION_RESULT_DIR}/${effect}/${lease}/dispatch.lock`,
  };
}

function parseIntegrationResult(input: {
  raw: string;
  intent: Readonly<EffectIntent>;
  authority: DaytonaIntegrationPayload;
  dispatch_fence: { lease_id: string; worker_id: string };
}): DaytonaIntegrationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch {
    throw new Error("Daytona integration result is not valid JSON");
  }
  const value = object(parsed, "Daytona integration result");
  const expectedKeys = [
    "candidate_checkpoint_id", "definition_bundle_hash", "effect_id", "idempotency_key",
    "input_subject", "lease_id", "output_subject", "payload_artifact", "payload_schema",
    "pipeline_run_id", "reason", "schema", "state", "worker_id",
  ].sort();
  if (
    Object.keys(value).sort().join("\0") !== expectedKeys.join("\0") ||
    value.schema !== "openthrottle.kernel-integration-result/v1" ||
    value.pipeline_run_id !== input.intent.pipeline_run_id ||
    value.effect_id !== input.intent.id ||
    value.idempotency_key !== input.intent.idempotency_key ||
    value.lease_id !== input.dispatch_fence.lease_id ||
    value.worker_id !== input.dispatch_fence.worker_id ||
    value.definition_bundle_hash !== input.authority.definition_bundle_hash ||
    value.input_subject !== input.authority.current_subject ||
    value.candidate_checkpoint_id !== input.authority.candidate_checkpoint_id ||
    !["integrated", "needs_human", "retryable_failure"].includes(String(value.state))
  ) throw new Error("Daytona integration result changed its sealed execution identity");
  if (value.state === "integrated") {
    const artifact = object(value.payload_artifact, "Daytona integration result artifact");
    const expectedRef = `refs/openthrottle/integrations/${createHash("sha256")
      .update(input.intent.idempotency_key).digest("hex")}`;
    if (
      typeof value.output_subject !== "string" || !/^[a-f0-9]{40,64}$/.test(value.output_subject) ||
      value.payload_schema !== "openthrottle.git-checkpoint-bundle/v1" || value.reason !== null ||
      typeof artifact.file !== "string" || !SAFE_PATH_ID.test(artifact.file) ||
      typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) || (artifact.bytes as number) < 1 ||
      (artifact.bytes as number) > KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES ||
      artifact.media_type !== "application/x-git-bundle" ||
      artifact.payload_schema !== "openthrottle.git-checkpoint-bundle/v1" ||
      artifact.ref !== expectedRef || artifact.commit !== value.output_subject ||
      typeof artifact.tree !== "string" || !/^[a-f0-9]{40,64}$/.test(artifact.tree)
    ) throw new Error("Daytona integration result has invalid integrated artifact evidence");
  } else if (
    value.output_subject !== null || value.payload_schema !== null || value.payload_artifact !== null ||
    typeof value.reason !== "string" || value.reason.trim().length < 1 || value.reason.length > 8_000
  ) throw new Error("Daytona integration failure result has invalid evidence");
  return value as unknown as DaytonaIntegrationResult;
}

function payload(intent: Readonly<EffectIntent>, expectedSchema: string): DaytonaIntentPayload {
  const value = object(intent.payload, `effect ${intent.id} payload`);
  if (
    value.schema !== expectedSchema || typeof value.identity !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.identity) ||
    value.pipeline_run_id !== intent.pipeline_run_id ||
    typeof value.repository !== "string" ||
    typeof value.base_branch !== "string" ||
    typeof value.base_commit !== "string" || !/^[a-f0-9]{40,64}$/.test(value.base_commit) ||
    typeof value.snapshot !== "string"
  ) throw new Error(`effect ${intent.id} has invalid Daytona runtime authority`);
  return value as unknown as DaytonaIntentPayload;
}

async function ensureActive(sandbox: Sandbox): Promise<void> {
  if (sandbox.state !== "started") await sandbox.start(60);
  if (sandbox.autoStopInterval !== ACTIVE_AUTOSTOP_MINUTES) {
    await sandbox.setAutostopInterval(ACTIVE_AUTOSTOP_MINUTES);
  }
}

async function downloadBytes(sandbox: Sandbox, path: string): Promise<Buffer | null> {
  try {
    return await sandbox.fs.downloadFile(path);
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

async function downloadUtf8(sandbox: Sandbox, path: string): Promise<string | null> {
  return (await downloadBytes(sandbox, path))?.toString("utf8") ?? null;
}

export class DaytonaKernelAdapter implements
  KernelRuntimePort,
  KernelRuntimeCompatibilityPort,
  KernelRuntimeInventoryPort {
  readonly #daytona: Daytona;
  readonly #options: DaytonaKernelOptions;

  constructor(daytona: Daytona, options: DaytonaKernelOptions) {
    this.#daytona = daytona;
    this.#options = options;
  }

  assertCompatible(input: Parameters<KernelRuntimeCompatibilityPort["assertCompatible"]>[0]): void {
    if (input.manifest_runtime_capability_digest !== this.#options.runtime_capability_digest) {
      throw new Error("pipeline requires another sealed sandbox runtime capability");
    }
    for (const stage of input.stages) {
      if (stage.kind === "agent" && !["claude", "codex", "opencode"].includes(stage.engine)) {
        throw new Error(`sandbox runtime does not support engine ${stage.engine}`);
      }
    }
    if (input.definition_entries.length === 0) {
      throw new Error("sandbox runtime cannot execute an empty DefinitionBundle closure");
    }
  }

  effectBindings(): readonly KernelEffectAdapterBinding[] {
    return [
      this.#binding("daytona/create-sandbox@1", "openthrottle.daytona-create/v1"),
      this.#binding("daytona/start-sandbox@1", "openthrottle.daytona-start/v1"),
      this.#binding("daytona/stop-sandbox@1", "openthrottle.daytona-stop/v1"),
      this.#binding("daytona/cleanup-sandbox@1", "openthrottle.daytona-cleanup/v1"),
      {
        effect_kind: "daytona/integrate-checkpoint@1",
        provider: "daytona",
        operation: "mutation",
        idempotency_strategy: "deterministic_target",
        adapter: {
          reconcile: ({ intent, dispatch_fence }) => this.#reconcileIntegration(intent, dispatch_fence),
          dispatch: ({ intent, dispatch_fence }) => this.#dispatchIntegration(intent, dispatch_fence),
        },
      },
    ];
  }

  async executeWork(
    request: KernelWorkActionRequest,
    callbacks: KernelRuntimeWorkCallbacks,
  ): Promise<KernelRuntimeOutcome> {
    if (!request.runtime_resource || request.runtime_resource.provider !== "daytona") {
      throw new Error("kernel action has no exact Daytona runtime resource");
    }
    const sandbox = await this.#daytona.get(request.runtime_resource.provider_resource_id);
    return this.#execute(sandbox, request, callbacks);
  }

  async correctResult(
    request: KernelResultCorrectionRequest,
    callbacks: KernelRuntimeLeaseCallbacks,
  ): Promise<KernelRuntimeOutcome> {
    const inputs = await this.#options.attempt_inputs.loadAttemptRequestInputs({
      pipeline_run_id: request.pipeline_run_id,
      attempt_id: request.attempt_id,
    });
    const resource = resolveKernelRuntimeResourceIdentity([...inputs.context.records.values()]);
    if (!resource) throw new Error("result correction has no exact Daytona runtime resource");
    return this.#execute(await this.#daytona.get(resource.provider_resource_id), request, callbacks);
  }

  async deliverSteering(input: {
    event_id: string;
    delivery_id: string;
    envelope: KernelSteeringEnvelope;
    authorized: AuthorizedKernelSteering;
  }): Promise<void> {
    const { authorized, envelope } = input;
    for (const [name, value] of [
      ["steering event ID", input.event_id],
      ["steering delivery ID", input.delivery_id],
      ["steering message ID", authorized.message_id],
    ] as const) safeTransportId(value, name);
    const exactBinding = {
      pipeline_run_id: authorized.pipeline_run_id,
      attempt_id: authorized.attempt_id,
      request_hash: authorized.request_hash,
      definition_bundle_hash: authorized.definition_bundle_hash,
      input_subject: authorized.input_subject,
      native_session_id: authorized.native_session_id,
      generation: authorized.generation,
      lease_id: authorized.lease_id,
      lease_generation: authorized.lease_generation,
      lease_purpose: authorized.lease_purpose,
    };
    if (
      envelope.message_id !== authorized.message_id || envelope.source !== authorized.source ||
      envelope.body !== authorized.body || canonicalJson(envelope.binding) !== canonicalJson(exactBinding)
    ) throw new Error("steering delivery changed its authorized envelope");
    if (
      !/^[a-f0-9]{64}$/.test(authorized.request_hash) ||
      !/^[a-f0-9]{64}$/.test(authorized.definition_bundle_hash) ||
      !/^[a-f0-9]{40,64}$/.test(authorized.input_subject) ||
      !Number.isSafeInteger(authorized.generation) || authorized.generation < 0 ||
      !Number.isSafeInteger(authorized.lease_generation) || authorized.lease_generation < 0 ||
      !["work", "result_correction"].includes(authorized.lease_purpose)
    ) throw new Error("steering delivery has invalid authorized binding fields");
    const delivery = {
      schema: KERNEL_STEERING_DELIVERY_SCHEMA,
      event_id: input.event_id,
      delivery_id: input.delivery_id,
      message_id: authorized.message_id,
      source: authorized.source,
      body: authorized.body,
      ...exactBinding,
    } as const;
    const bytes = Buffer.from(canonicalJson(delivery));
    if (bytes.byteLength > KERNEL_STEERING_DELIVERY_MAX_BYTES) {
      throw new Error("steering delivery exceeds the runtime inbox byte bound");
    }
    const inputs = await this.#options.attempt_inputs.loadAttemptRequestInputs({
      pipeline_run_id: authorized.pipeline_run_id,
      attempt_id: authorized.attempt_id,
    });
    const resource = resolveKernelRuntimeResourceIdentity([...inputs.context.records.values()]);
    if (!resource || resource.provider !== "daytona") {
      throw new Error("steering delivery has no exact Daytona runtime resource");
    }
    const sandbox = await this.#daytona.get(resource.provider_resource_id);
    await ensureActive(sandbox);
    for (const path of [AGENT_STATE_ROOT, STEERING_INBOX_DIR]) {
      await sandbox.fs.createFolder(path, "700").catch(() => undefined);
      await sandbox.fs.setFilePermissions(path, { owner: "agent", group: "agent", mode: "700" });
    }
    const identity = digestCanonicalJson({
      schema: KERNEL_STEERING_DELIVERY_SCHEMA,
      event_id: input.event_id,
      delivery_id: input.delivery_id,
    });
    const finalPath = `${STEERING_INBOX_DIR}/steering-${identity}.json`;
    const stagedPath = `${finalPath}.part`;
    const published = await downloadBytes(sandbox, finalPath);
    if (published !== null) {
      if (!published.equals(bytes)) throw new Error("steering inbox path contains different durable bytes");
      await sandbox.fs.setFilePermissions(finalPath, { owner: "agent", group: "agent", mode: "600" });
      return;
    }
    const staged = await downloadBytes(sandbox, stagedPath);
    if (staged === null) {
      await sandbox.fs.uploadFile(bytes, stagedPath);
    } else if (!staged.equals(bytes)) {
      throw new Error("steering staging path contains different durable bytes");
    }
    await sandbox.fs.setFilePermissions(stagedPath, { owner: "agent", group: "agent", mode: "600" });
    const moved = await sandbox.process.executeCommand(
      `mv -n -- ${shellQuote(stagedPath)} ${shellQuote(finalPath)}`,
      "/home/agent",
      {},
      30,
    );
    if (moved.exitCode !== undefined && moved.exitCode !== 0) {
      throw new Error("Daytona could not atomically publish steering guidance");
    }
    const verified = await downloadBytes(sandbox, finalPath);
    if (verified === null || !verified.equals(bytes)) {
      throw new Error("Daytona steering delivery failed exact publication verification");
    }
    await sandbox.fs.setFilePermissions(finalPath, { owner: "agent", group: "agent", mode: "600" });
  }

  async listActiveRuntimeResources(limit: number): Promise<readonly KernelRuntimeInventoryResource[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_000) {
      throw new Error("runtime inventory limit must be between 1 and 2000");
    }
    const resources: KernelRuntimeInventoryResource[] = [];
    for await (const sandbox of this.#daytona.list({
      labels: { openthrottle: "true", "kernel-runtime": "true" },
    })) {
      resources.push({
        id: sandbox.id,
        provider: "daytona",
        state: String(sandbox.state),
        pipeline_run_id: sandbox.labels?.["pipeline-run-id"] ?? null,
      });
      if (resources.length >= limit) break;
    }
    return resources;
  }

  async #execute(
    sandbox: Sandbox,
    request: KernelWorkActionRequest | KernelResultCorrectionRequest,
    callbacks: KernelRuntimeWorkCallbacks | KernelRuntimeLeaseCallbacks,
  ): Promise<KernelRuntimeOutcome> {
    if (!Number.isSafeInteger(callbacks.heartbeat_interval_ms) || callbacks.heartbeat_interval_ms < 1) {
      throw new Error("kernel runtime heartbeat interval must be a positive integer");
    }
    if (!Number.isSafeInteger(callbacks.lease_generation) || callbacks.lease_generation < 0) {
      throw new Error("kernel runtime lease generation must be a non-negative integer");
    }
    const actionTimeoutMs = sealedActionTimeoutMs(request, this.#options.task_timeout_seconds);
    const actionDeadline = Date.now() + actionTimeoutMs;
    await ensureActive(sandbox);
    const environment = this.#options.environments.loadExactRunEnvironment(request.pipeline_run_id);
    const paths = launchPaths(request, callbacks.lease_generation);
    const requestPath = paths.input;
    const resultPath = paths.result;
    const sessionPath = paths.session;
    let sessionBound = false;
    let nextHeartbeatAt = 0;
    const heartbeat = async (): Promise<void> => {
      if (Date.now() < nextHeartbeatAt) return;
      await callbacks.on_heartbeat();
      nextHeartbeatAt = Date.now() + callbacks.heartbeat_interval_ms;
    };
    const bindSession = async (): Promise<void> => {
      if (sessionBound || !("on_session" in callbacks)) return;
      const raw = await downloadUtf8(sandbox, sessionPath);
      if (raw === null) return;
      const event = parseKernelSessionEvent(raw, request);
      await callbacks.on_session(event.native_session_id);
      sessionBound = true;
    };
    const collect = async (): Promise<KernelRuntimeOutcome | null> => {
      const [, raw] = await Promise.all([
        bindSession(),
        downloadUtf8(sandbox, resultPath),
      ]);
      if (raw === null) return null;
      if (
        callbacks !== null && request.schema === KERNEL_ACTION_REQUEST_SCHEMA &&
        request.action.kind === "agent" && !sessionBound
      ) throw new Error("agent runtime completed before its native session was durably bound");
      return parseKernelRuntimeResult({
        raw,
        request,
        artifacts: {
          materialize: (descriptor) => this.#materializeArtifact(
            sandbox,
            request,
            paths.result_directory,
            descriptor,
          ),
        },
      });
    };
    await this.#refreshLeaseGenerationFence(sandbox, request, paths, callbacks.lease_generation);
    await heartbeat();
    const replay = await collect();
    if (replay !== null) return replay;

    await this.#prepareDirectories(sandbox, paths);
    if (request.schema === KERNEL_ACTION_REQUEST_SCHEMA) {
      await this.#materializeInputSubject(
        sandbox,
        request,
        paths.input_directory,
        environment.repository,
        environment.base_branch,
      );
    }
    await this.#putImmutableRequest(sandbox, requestPath, canonicalJson(request));
    const remainingBeforeCredentials = actionDeadline - Date.now();
    if (remainingBeforeCredentials <= 0) {
      return {
        state: "work_failed",
        retryable: request.schema === KERNEL_ACTION_REQUEST_SCHEMA,
        reason: "Daytona action deadline expired before provider dispatch",
      };
    }
    const engine = request.schema === KERNEL_ACTION_REQUEST_SCHEMA
      ? request.action.kind === "agent" ? request.action.engine : null
      : request.engine;
    const modelCredentials = engine === null
      ? {}
      : await this.#options.materialize_model_credentials(
        engine,
        remainingBeforeCredentials,
      );
    const unset = MODEL_CREDENTIALS.filter((name) => !(name in modelCredentials));
    await sandbox.updateEnv({
      ...modelCredentials,
      GITHUB_TOKEN: this.#options.github_read_token,
      GITHUB_REPO: environment.repository,
      BASE_BRANCH: environment.base_branch,
      BASE_COMMIT: request.input_subject,
      RUN_ID: request.pipeline_run_id,
      OT_ACTION_REQUEST_FILE: requestPath,
      OT_ACTION_RESULT_FILE: resultPath,
      OT_ACTION_SESSION_FILE: sessionPath,
      OT_LEASE_GENERATION_FENCE_FILE: paths.lease_generation_fence,
      OT_LEASE_GENERATION_LOCK_FILE: paths.lease_generation_lock,
    }, { unset });
    const remainingBeforeLaunch = actionDeadline - Date.now();
    if (remainingBeforeLaunch <= 0) {
      return {
        state: "work_failed",
        retryable: request.schema === KERNEL_ACTION_REQUEST_SCHEMA,
        reason: "Daytona action deadline expired before provider dispatch",
      };
    }
    const actionTimeoutSeconds = Math.max(1, Math.ceil(remainingBeforeLaunch / 1_000));
    // Daytona sessions snapshot sandbox environment at creation. A recovered
    // lease must adopt its original command, while a new work/correction lease
    // must inherit its newly sealed request and result paths.
    const sessionId = actionSessionId(request);
    await sandbox.process.createSession(sessionId).catch(() => undefined);
    const launch = await sandbox.process.executeSessionCommand(sessionId, {
      command: `flock --nonblock --conflict-exit-code ${DISPATCH_LOCK_CONTENTION_EXIT_CODE} ` +
        `${shellQuote(paths.lock)} sh -c ` +
        shellQuote(`test -f ${shellQuote(resultPath)} || exec /opt/openthrottle/entrypoint.sh`),
      runAsync: true,
      suppressInputEcho: true,
    }, actionTimeoutSeconds);
    const launchCommandId = launch?.cmdId;
    if (typeof launchCommandId !== "string" || launchCommandId.length < 1) {
      const completedOutcome = await collect();
      if (completedOutcome !== null) return completedOutcome;
      const termination = await this.#terminateSessionAndCollect(sandbox, sessionId, collect);
      if (termination.outcome !== null) return termination.outcome;
      return {
        state: "work_failed",
        retryable: termination.verified,
        reason: termination.verified
          ? "Daytona action launch omitted its command identity; session termination was verified"
          : "Daytona action launch omitted its command identity and session termination could not be verified",
      };
    }

    let adoptedExistingCommand = false;
    while (Date.now() < actionDeadline) {
      await heartbeat();
      const outcome = await collect();
      if (outcome !== null) return outcome;
      if (adoptedExistingCommand) {
        await new Promise((resolve) => setTimeout(resolve, this.#options.poll_interval_ms ?? 500));
        continue;
      }
      let command;
      try {
        command = await sandbox.process.getSessionCommand(sessionId, launchCommandId);
      } catch (error) {
        if (!notFound(error)) throw error;
      }
      if (typeof command?.exitCode === "number") {
        if (command.exitCode === DISPATCH_LOCK_CONTENTION_EXIT_CODE) {
          adoptedExistingCommand = true;
          await new Promise((resolve) => setTimeout(resolve, this.#options.poll_interval_ms ?? 500));
          continue;
        }
        const completedOutcome = await collect();
        if (completedOutcome !== null) return completedOutcome;
        const termination = await this.#terminateSessionAndCollect(sandbox, sessionId, collect);
        if (!termination.verified) {
          return {
            state: "work_failed",
            retryable: false,
            reason: `Daytona action command exited with code ${command.exitCode} and session termination could not be verified`,
          };
        }
        if (termination.outcome !== null) return termination.outcome;
        return {
          state: "work_failed",
          retryable: true,
          reason: `Daytona action command exited with code ${command.exitCode} without producing a sealed result; session termination was verified`,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, this.#options.poll_interval_ms ?? 500));
    }
    await heartbeat();
    const finalOutcome = await collect();
    if (finalOutcome !== null) return finalOutcome;
    const termination = await this.#terminateSessionAndCollect(sandbox, sessionId, collect);
    if (!termination.verified) {
      return {
        state: "work_failed",
        retryable: false,
        reason: "Daytona action deadline expired and session termination could not be verified",
      };
    }
    if (termination.outcome !== null) return termination.outcome;
    return {
      state: "work_failed",
      retryable: true,
      reason: `Daytona action did not produce a sealed result within ${actionTimeoutSeconds}s; session termination was verified`,
    };
  }

  async #refreshLeaseGenerationFence(
    sandbox: Sandbox,
    request: KernelWorkActionRequest | KernelResultCorrectionRequest,
    paths: ReturnType<typeof launchPaths>,
    leaseGeneration: number,
  ): Promise<void> {
    await sandbox.fs.createFolder(OPENTHROTTLE_ROOT, "711").catch(() => undefined);
    await sandbox.fs.setFilePermissions(OPENTHROTTLE_ROOT, { owner: "root", group: "root", mode: "711" });
    for (const path of [ACTION_FENCE_DIR, paths.fence_attempt_directory]) {
      await sandbox.fs.createFolder(path, "711").catch(() => undefined);
      await sandbox.fs.setFilePermissions(path, { owner: "root", group: "root", mode: "711" });
    }
    const initializedLock = await sandbox.process.executeCommand(
      `umask 022; touch -- ${shellQuote(paths.lease_generation_lock)} && ` +
        `chown root:root ${shellQuote(paths.lease_generation_lock)} && ` +
        `chmod 0444 ${shellQuote(paths.lease_generation_lock)}`,
      OPENTHROTTLE_ROOT,
      {},
      30,
    );
    if (initializedLock.exitCode !== undefined && initializedLock.exitCode !== 0) {
      throw new Error("Daytona could not initialize the lease-generation lock");
    }
    const verifiedLock = await downloadBytes(sandbox, paths.lease_generation_lock);
    if (verifiedLock === null || verifiedLock.byteLength !== 0) {
      throw new Error("Daytona lease-generation lock failed exact verification");
    }
    const content = canonicalJson({
      schema: "openthrottle.kernel-lease-generation-fence/v1",
      attempt_id: request.attempt_id,
      lease_generation: leaseGeneration,
    });
    const staged = await downloadUtf8(sandbox, paths.lease_generation_stage);
    if (staged === null) {
      await sandbox.fs.uploadFile(Buffer.from(content), paths.lease_generation_stage);
    } else if (staged !== content) {
      throw new Error("Daytona lease-generation staging path contains different sealed bytes");
    }
    await sandbox.fs.setFilePermissions(paths.lease_generation_stage, {
      owner: "root", group: "root", mode: "400",
    });
    const command = [
      `current=-1`,
      `if test -f ${shellQuote(paths.lease_generation_fence)}`,
      `then`,
      `  current=$(jq -er '.lease_generation | select(type == \"number\" and floor == . and . >= 0)' ${shellQuote(paths.lease_generation_fence)}) || exit 41`,
      `fi`,
      `test "$current" -le ${leaseGeneration} || exit 42`,
      `if test "$current" -lt ${leaseGeneration}; then mv -f -- ${shellQuote(paths.lease_generation_stage)} ${shellQuote(paths.lease_generation_fence)}; fi`,
      `if test "$current" -eq ${leaseGeneration} && test ! -f ${shellQuote(paths.lease_generation_fence)}; then exit 43; fi`,
    ].join("\n");
    const refreshed = await sandbox.process.executeCommand(
      `flock --exclusive ${shellQuote(paths.lease_generation_lock)} sh -c ${shellQuote(command)}`,
      "/var/lib/openthrottle",
      {},
      30,
    );
    if (refreshed.exitCode !== undefined && refreshed.exitCode !== 0) {
      throw new Error(refreshed.exitCode === 42
        ? "Daytona refused to replace a newer lease-generation fence"
        : "Daytona could not atomically refresh the lease-generation fence");
    }
    const verified = await downloadUtf8(sandbox, paths.lease_generation_fence);
    if (verified !== content) throw new Error("Daytona lease-generation fence failed exact verification");
    await sandbox.fs.setFilePermissions(paths.lease_generation_fence, {
      owner: "root", group: "root", mode: "444",
    });
  }

  async #terminateAndVerifySession(sandbox: Sandbox, sessionId: string): Promise<boolean> {
    try {
      await sandbox.process.deleteSession(sessionId);
    } catch (error) {
      if (!notFound(error)) return false;
    }
    try {
      await sandbox.process.getSession(sessionId);
      return false;
    } catch (error) {
      return notFound(error);
    }
  }

  async #terminateSessionAndCollect(
    sandbox: Sandbox,
    sessionId: string,
    collect: () => Promise<KernelRuntimeOutcome | null>,
  ): Promise<{ verified: boolean; outcome: KernelRuntimeOutcome | null }> {
    const verified = await this.#terminateAndVerifySession(sandbox, sessionId);
    return {
      verified,
      outcome: verified ? await collect() : null,
    };
  }

  async #prepareDirectories(
    sandbox: Sandbox,
    paths: ReturnType<typeof launchPaths>,
  ): Promise<void> {
    await sandbox.fs.createFolder(OPENTHROTTLE_ROOT, "711").catch(() => undefined);
    await sandbox.fs.setFilePermissions(OPENTHROTTLE_ROOT, { owner: "root", group: "root", mode: "711" });
    for (const path of [
      ACTION_INPUT_DIR,
      ACTION_RESULT_DIR,
      paths.input_attempt_directory,
      paths.input_directory,
      paths.result_attempt_directory,
      paths.result_directory,
    ]) {
      await sandbox.fs.createFolder(path, "700").catch(() => undefined);
      await sandbox.fs.setFilePermissions(path, { owner: "root", group: "root", mode: "700" });
    }
  }

  async #putImmutableRequest(sandbox: Sandbox, path: string, content: string): Promise<void> {
    const existing = await downloadUtf8(sandbox, path);
    if (existing !== null) {
      if (existing !== content) throw new Error("Daytona action request path contains different sealed bytes");
      return;
    }
    await sandbox.fs.uploadFile(Buffer.from(content), path);
    await sandbox.fs.setFilePermissions(path, { owner: "root", group: "root", mode: "400" });
    const reread = await downloadUtf8(sandbox, path);
    if (reread !== content) throw new Error("Daytona action request failed exact upload verification");
  }

  async #materializeInputSubject(
    sandbox: Sandbox,
    request: KernelWorkActionRequest,
    inputDirectory: string,
    repository: string,
    baseBranch: string,
  ): Promise<void> {
    const boundaries = request.context.checkpoints.filter(
      (checkpoint) => checkpoint.output_subject === request.input_subject,
    );
    if (boundaries.length > 1) {
      throw new Error("kernel action has ambiguous checkpoint materialization for its input subject");
    }
    const boundary = boundaries[0];
    if (!boundary) {
      await materializeDaytonaRepositorySource({
        sandbox,
        repository,
        base_branch: baseBranch,
        subject: request.input_subject,
        github_read_token: this.#options.github_read_token,
      });
      return;
    }
    if (!("blob" in boundary.payload) || boundary.payload.blob.encoding !== "binary" ||
        boundary.payload.blob.media_type !== "application/x-git-bundle") {
      throw new Error("kernel action input checkpoint is not a materializable Git bundle");
    }
    await assertDaytonaRepositorySourceFence(sandbox);
    const pointer = boundary.payload.blob;
    const bytes = this.#options.blob_store.read(pointer);
    const bundlePath = `${inputDirectory}/context-${pointer.digest}.bundle`;
    if (typeof boundary.input_subject !== "string" || !/^[a-f0-9]{40,64}$/.test(boundary.input_subject)) {
      throw new Error("Daytona input checkpoint has no exact shallow boundary");
    }
    const shallowPath = `${inputDirectory}/context-${pointer.digest}.shallow`;
    const shallowBytes = Buffer.from(`${boundary.input_subject}\n`);
    const existing = await downloadBytes(sandbox, bundlePath);
    if (existing === null) {
      await sandbox.fs.uploadFile(bytes, bundlePath);
      await sandbox.fs.setFilePermissions(bundlePath, { owner: "root", group: "root", mode: "400" });
    } else if (
      existing.byteLength !== bytes.byteLength ||
      createHash("sha256").update(existing).digest("hex") !== pointer.digest
    ) {
      throw new Error("Daytona input checkpoint path contains different immutable bytes");
    }
    const existingShallow = await downloadBytes(sandbox, shallowPath);
    if (existingShallow === null) {
      await sandbox.fs.uploadFile(shallowBytes, shallowPath);
      await sandbox.fs.setFilePermissions(shallowPath, { owner: "root", group: "root", mode: "400" });
    } else if (!existingShallow.equals(shallowBytes)) {
      throw new Error("Daytona input checkpoint shallow path contains different immutable bytes");
    }
    const gitEnvironment = {
      GIT_TERMINAL_PROMPT: "0",
      GIT_SHALLOW_FILE: shallowPath,
    };
    const listed = await sandbox.process.executeCommand(
      `${DAYTONA_EXECUTOR_GIT} bundle list-heads ${shellQuote(bundlePath)}`,
      DAYTONA_REPOSITORY_ROOT,
      gitEnvironment,
      120,
    );
    if (listed.exitCode !== 0) {
      throw new Error("Daytona could not inspect the input checkpoint bundle");
    }
    const heads = listed.result.trim().split("\n").filter(Boolean);
    if (heads.length !== 1) throw new Error("input checkpoint bundle must advertise exactly one head");
    const [commit, ref, ...extra] = heads[0]!.trim().split(/\s+/);
    if (
      extra.length !== 0 || commit !== request.input_subject || !ref ||
      !/^refs\/openthrottle\/(?:checkpoints|integrations)\/[a-f0-9]{64}$/.test(ref)
    ) throw new Error("input checkpoint bundle does not bind the exact successor subject");
    const bundleVerified = await sandbox.process.executeCommand(
      `${DAYTONA_EXECUTOR_GIT} bundle verify ${shellQuote(bundlePath)}`,
      DAYTONA_REPOSITORY_ROOT,
      gitEnvironment,
      120,
    );
    if (bundleVerified.exitCode !== 0) {
      throw new Error("Daytona could not verify the bounded input checkpoint bundle");
    }
    const imported = await sandbox.process.executeCommand(
      `${DAYTONA_EXECUTOR_GIT} fetch --quiet --no-tags ${shellQuote(bundlePath)} ${shellQuote(ref)}`,
      DAYTONA_REPOSITORY_ROOT,
      gitEnvironment,
      120,
    );
    if (imported.exitCode !== 0) {
      throw new Error("Daytona could not import the exact successor checkpoint");
    }
    const verified = await sandbox.process.executeCommand(
      `${DAYTONA_EXECUTOR_GIT} cat-file -e ${shellQuote(`${request.input_subject}^{commit}`)}`,
      DAYTONA_REPOSITORY_ROOT,
      gitEnvironment,
      120,
    );
    if (verified.exitCode !== 0) {
      throw new Error("Daytona input checkpoint did not materialize its exact commit");
    }
  }

  async #materializeArtifact(
    sandbox: Sandbox,
    request: KernelWorkActionRequest | KernelResultCorrectionRequest,
    resultDirectory: string,
    descriptor: KernelCheckpointArtifactDescriptor,
  ) {
    const bytes = await sandbox.fs.downloadFile(`${resultDirectory}/${descriptor.file}`);
    if (
      bytes.byteLength !== descriptor.bytes ||
      bytes.byteLength > KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES ||
      createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256
    ) throw new Error(`checkpoint artifact for ${request.attempt_id} failed its sealed descriptor`);
    const completedWorkAuthority = request.schema === KERNEL_ACTION_REQUEST_SCHEMA
      ? request.repository_authority
      : request.completed_work_authority;
    inspectCheckpointBundle(
      bytes,
      descriptor,
      completedWorkAuthority === "edit" ? request.checkpoint_base_subject : null,
      completedWorkAuthority === "edit" ? request.input_subject : null,
    );
    if (
      descriptor.ref.startsWith("refs/openthrottle/checkpoints/") &&
      descriptor.ref !== `refs/openthrottle/checkpoints/${request.request_hash}`
    ) throw new Error(`checkpoint artifact for ${request.attempt_id} changed its exact request ref`);
    return this.#options.blob_store.put({
      bytes,
      encoding: "binary",
      media_type: descriptor.media_type,
      payload_schema: descriptor.payload_schema,
      expected_digest: descriptor.sha256,
    }).pointer;
  }

  #binding(effectKind: string, schema: string): KernelEffectAdapterBinding {
    return {
      effect_kind: effectKind,
      provider: "daytona",
      operation: "mutation",
      idempotency_strategy: "deterministic_target",
      adapter: {
        reconcile: ({ intent }) => this.#reconcileEffect(intent, effectKind, schema),
        dispatch: ({ intent }) => this.#dispatchEffect(intent, effectKind, schema),
      },
    };
  }

  async #integrationSandbox(authority: DaytonaIntegrationPayload): Promise<Sandbox | null> {
    const matches = await this.#matchingSandboxes(authority.identity);
    if (matches.length > 1) throw new Error("multiple sandboxes match one integration runtime identity");
    return matches[0] ?? null;
  }

  async #reconcileIntegration(
    intent: Readonly<EffectIntent>,
    dispatchFence: { lease_id: string; worker_id: string } | null,
  ): Promise<KernelEffectProviderObservation> {
    const authority = integrationPayload(intent);
    if (dispatchFence === null) return { kind: "not_found" };
    const sandbox = await this.#integrationSandbox(authority);
    if (!sandbox) return { kind: "unknown", detail: "integration runtime sandbox is absent" };
    const paths = integrationPaths(intent.id, dispatchFence.lease_id);
    const raw = await downloadUtf8(sandbox, paths.result);
    if (raw === null) return { kind: "not_found" };
    const result = parseIntegrationResult({ raw, intent, authority, dispatch_fence: dispatchFence });
    if (result.state !== "integrated") {
      return {
        kind: "found",
        status: "rejected",
        payload: {
          schema: "openthrottle.daytona-integration-delivery/v1",
          state: result.state,
          pipeline_run_id: intent.pipeline_run_id,
          attempt_id: authority.attempt_id,
          effect_id: intent.id,
          idempotency_key: intent.idempotency_key,
          input_subject: authority.current_subject,
          output_subject: null,
          checkpoint_id: null,
          checkpoint_payload_schema: null,
          checkpoint_blob: null,
          reason: result.reason,
        },
      };
    }
    const descriptor = result.payload_artifact!;
    const bytes = await sandbox.fs.downloadFile(`${paths.result_directory}/${descriptor.file}`);
    if (
      bytes.byteLength !== descriptor.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256
    ) throw new Error("integrated checkpoint artifact failed its exact sealed descriptor");
    const candidateBytes = this.#options.blob_store.read(authority.candidate_blob);
    const currentAncestry = authority.current_ancestry.map((edge) => ({
      checkpoint_id: edge.checkpoint_id,
      bytes: this.#options.blob_store.read(edge.checkpoint_blob),
      descriptor: edge.checkpoint_artifact,
      input_subject: edge.input_subject,
      output_subject: edge.output_subject,
    }));
    inspectKernelIntegrationBundle({
      bytes,
      descriptor,
      checkpoint_base_subject: authority.checkpoint_base_subject,
      current_subject: authority.current_subject,
      candidate_bytes: candidateBytes,
      candidate_descriptor: authority.candidate_artifact,
      candidate_input_subject: authority.candidate_input_subject,
      candidate_output_subject: authority.candidate_output_subject,
      current_ancestry: currentAncestry,
    });
    const checkpointBlob = this.#options.blob_store.put({
      bytes,
      encoding: "binary",
      media_type: descriptor.media_type,
      payload_schema: descriptor.payload_schema,
      expected_digest: descriptor.sha256,
    }).pointer;
    const checkpointId = `checkpoint-${digestCanonicalJson({
      schema: "openthrottle.integration-checkpoint-identity/v1",
      attempt_id: authority.attempt_id,
      effect_id: intent.id,
      output_subject: result.output_subject,
      checkpoint_blob: checkpointBlob,
    }).slice(0, 48)}`;
    return {
      kind: "found",
      status: "confirmed",
      payload: {
        schema: "openthrottle.daytona-integration-delivery/v1",
        state: "integrated",
        pipeline_run_id: intent.pipeline_run_id,
        attempt_id: authority.attempt_id,
        effect_id: intent.id,
        idempotency_key: intent.idempotency_key,
        input_subject: authority.current_subject,
        output_subject: result.output_subject,
        checkpoint_id: checkpointId,
        checkpoint_payload_schema: "openthrottle.git-checkpoint-bundle/v1",
        checkpoint_blob: checkpointBlob as unknown as JsonValue,
        reason: null,
      },
    };
  }

  async #dispatchIntegration(
    intent: Readonly<EffectIntent>,
    dispatchFence: { lease_id: string; worker_id: string } | null,
  ): Promise<void> {
    if (dispatchFence === null) throw new Error("integration dispatch has no durable executor fence");
    const authority = integrationPayload(intent);
    const sandbox = await this.#integrationSandbox(authority);
    if (!sandbox) throw new Error("integration runtime sandbox is absent");
    await ensureActive(sandbox);
    const paths = integrationPaths(intent.id, dispatchFence.lease_id);
    for (const path of [
      OPENTHROTTLE_ROOT,
      INTEGRATION_INPUT_DIR,
      INTEGRATION_RESULT_DIR,
      paths.input_effect_directory,
      paths.input_directory,
      paths.result_effect_directory,
      paths.result_directory,
    ]) {
      await sandbox.fs.createFolder(path, path === OPENTHROTTLE_ROOT ? "711" : "700").catch(() => undefined);
      await sandbox.fs.setFilePermissions(path, {
        owner: "root", group: "root", mode: path === OPENTHROTTLE_ROOT ? "711" : "700",
      });
    }
    const candidateBytes = this.#options.blob_store.read(authority.candidate_blob);
    inspectCheckpointBundle(
      candidateBytes,
      authority.candidate_artifact,
      authority.checkpoint_base_subject,
      authority.candidate_input_subject,
    );
    const artifactPath = `${paths.input_directory}/${authority.candidate_artifact.file}`;
    const existingArtifact = await downloadBytes(sandbox, artifactPath);
    if (existingArtifact === null) {
      await sandbox.fs.uploadFile(candidateBytes, artifactPath);
      await sandbox.fs.setFilePermissions(artifactPath, { owner: "root", group: "root", mode: "400" });
    } else if (
      createHash("sha256").update(existingArtifact).digest("hex") !== authority.candidate_blob.digest
    ) {
      throw new Error("integration candidate path contains different immutable bytes");
    }
    const request = {
      schema: "openthrottle.kernel-integration-request/v1",
      pipeline_run_id: intent.pipeline_run_id,
      effect_id: intent.id,
      idempotency_key: intent.idempotency_key,
      lease_id: dispatchFence.lease_id,
      worker_id: dispatchFence.worker_id,
      definition_bundle_hash: authority.definition_bundle_hash,
      checkpoint_base_subject: authority.checkpoint_base_subject,
      current_subject: authority.current_subject,
      candidate_checkpoint_id: authority.candidate_checkpoint_id,
      candidate_input_subject: authority.candidate_input_subject,
      candidate_output_subject: authority.candidate_output_subject,
      candidate_artifact: authority.candidate_artifact,
    } as const;
    await this.#putImmutableRequest(sandbox, paths.input, `${JSON.stringify(request)}\n`);
    await sandbox.updateEnv({
      OT_INTEGRATION_REQUEST_FILE: paths.input,
      OT_INTEGRATION_RESULT_FILE: paths.result,
    });
    const sessionId = `kernel-effect-${safeTransportId(intent.id, "kernel effect ID")}`;
    await sandbox.process.createSession(sessionId).catch(() => undefined);
    await sandbox.process.executeSessionCommand(sessionId, {
      command: `flock --nonblock ${shellQuote(paths.lock)} sh -c ` +
        shellQuote(`test -f ${shellQuote(paths.result)} || exec /opt/openthrottle/entrypoint.sh`),
      runAsync: true,
      suppressInputEcho: true,
    }, this.#options.task_timeout_seconds);
  }

  async #matchingSandboxes(identity: string): Promise<Sandbox[]> {
    const matches: Sandbox[] = [];
    for await (const sandbox of this.#daytona.list({
      labels: { openthrottle: "true", "kernel-runtime": "true", identity },
    })) matches.push(sandbox);
    return matches;
  }

  async #reconcileEffect(
    intent: Readonly<EffectIntent>,
    effectKind: string,
    schema: string,
  ): Promise<KernelEffectProviderObservation> {
    const authority = payload(intent, schema);
    const matches = await this.#matchingSandboxes(authority.identity);
    if (matches.length > 1) return { kind: "unknown", detail: "multiple sandboxes match one runtime identity" };
    const sandbox = matches[0];
    if (effectKind === "daytona/cleanup-sandbox@1") {
      return sandbox
        ? { kind: "not_found" }
        : { kind: "found", status: "confirmed", payload: {
          sandbox_id: null, resource_state: "absent", identity: authority.identity,
        } };
    }
    if (!sandbox) {
      return effectKind === "daytona/stop-sandbox@1"
        ? { kind: "found", status: "rejected", payload: {
          sandbox_id: null, resource_state: "absent", identity: authority.identity,
        } }
        : { kind: "not_found" };
    }
    const state = String(sandbox.state);
    if (effectKind === "daytona/start-sandbox@1" && state !== "started") return { kind: "not_found" };
    if (effectKind === "daytona/stop-sandbox@1" && state !== "stopped") return { kind: "not_found" };
    return {
      kind: "found",
      status: "confirmed",
      payload: { sandbox_id: sandbox.id, resource_state: state, identity: authority.identity },
    };
  }

  async #dispatchEffect(intent: Readonly<EffectIntent>, effectKind: string, schema: string): Promise<void> {
    const authority = payload(intent, schema);
    const matches = await this.#matchingSandboxes(authority.identity);
    if (matches.length > 1) throw new Error("multiple sandboxes match one runtime identity");
    let sandbox = matches[0];
    if (effectKind === "daytona/create-sandbox@1") {
      if (sandbox) return;
      sandbox = await this.#daytona.create({
        snapshot: authority.snapshot,
        envVars: {
          GITHUB_TOKEN: this.#options.github_read_token,
          GITHUB_REPO: authority.repository,
          BASE_BRANCH: authority.base_branch,
          BASE_COMMIT: authority.base_commit,
          RUN_ID: authority.pipeline_run_id,
        },
        labels: {
          openthrottle: "true",
          "kernel-runtime": "true",
          identity: authority.identity,
          "pipeline-run-id": authority.pipeline_run_id,
        },
        public: false,
        autoStopInterval: ACTIVE_AUTOSTOP_MINUTES,
        autoDeleteInterval: -1,
      });
      return;
    }
    if (!sandbox) {
      if (effectKind === "daytona/cleanup-sandbox@1" || effectKind === "daytona/stop-sandbox@1") return;
      throw new Error("runtime lifecycle effect has no deterministically identified sandbox");
    }
    if (effectKind === "daytona/start-sandbox@1") {
      await ensureActive(sandbox);
    } else if (effectKind === "daytona/stop-sandbox@1") {
      if (sandbox.state !== "stopped") await sandbox.stop(60, true);
    } else if (effectKind === "daytona/cleanup-sandbox@1") {
      await sandbox.delete(60, false);
    }
  }
}

export function createDaytonaKernelAdapter(
  options: DaytonaKernelFactoryOptions,
): DaytonaKernelAdapter {
  return new DaytonaKernelAdapter(new Daytona({ apiKey: options.api_key }), options);
}

export type DaytonaKernelConfig = Pick<Config,
  "daytonaApiKey" | "daytonaSnapshot" | "githubReadToken" | "taskTimeout"
>;
