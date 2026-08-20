import {
  canonicalJson,
  digestCanonicalJson,
  jsonValueAt,
  type DefinitionCompilation,
  type JsonValue,
  type TrustedCompilerEnvironment,
  type TrustedPlatformDefinitionSource,
} from "@openthrottle/contracts";
import {
  createPendingStageAttempt,
  type KernelActionInputs,
} from "../pipeline/kernel/action-request.js";
import { compileKernelCursor } from "../pipeline/kernel/reducer.js";
import {
  KERNEL_WORK_REQUEST_PAYLOAD_SCHEMA,
} from "../pipeline/kernel/ports.js";
import {
  KERNEL_RUN_SCHEMA,
  type KernelAttempt,
  type KernelRun,
} from "../pipeline/kernel/types.js";
import {
  compileRepositoryDefinitionAtCommit,
  type ExactDefinitionSourceReader,
} from "../pipeline/definition-compilation.js";
import type { KernelRuntimeCompatibilityPort } from "../runtime/kernel-contracts.js";
import type { VolumeBlobStore, VerifiedBlobToken } from "../persistence/blob-store.js";
import type {
  DefinitionSnapshotInput,
  PipelineAdmissionInput,
  SqliteKernelStore,
  WorkItemSeed,
} from "../persistence/kernel-store.js";

const INLINE_PAYLOAD_MAX_BYTES = 64 * 1024;

export interface KernelAdmissionWorkItem {
  id: string;
  repository_registration_id: string;
  source_provider: "linear" | "github" | "operator";
  source_id: string;
  source_reference: string;
  title: string;
  task_prompt: string;
}

export interface KernelAdmissionIdentity {
  pipeline_run_id: string;
  initial_attempt_id: string;
}

export interface KernelAdmissionResult {
  compilation: DefinitionCompilation;
  run: KernelRun;
  initial_attempt: KernelAttempt;
  definition_bundle_token: VerifiedBlobToken;
}

export type KernelDefinitionCompiler = typeof compileRepositoryDefinitionAtCommit;

function definitionSnapshots(compilation: DefinitionCompilation): DefinitionSnapshotInput[] {
  return compilation.bundle.value.entries.map((entry) => ({
    definition_kind: entry.definition_kind,
    definition_id: entry.definition_id,
    source_commit: entry.origin.source_commit,
    content_hash: entry.content_hash,
    normalized_payload: jsonValueAt(
      entry.normalized_payload,
      `definition ${entry.definition_kind}:${entry.definition_id}`,
    ),
  }));
}

function prewriteWorkItem(input: {
  blob_store: Pick<VolumeBlobStore, "put">;
  work_item: KernelAdmissionWorkItem;
}): WorkItemSeed {
  const payload: JsonValue = {
    schema: KERNEL_WORK_REQUEST_PAYLOAD_SCHEMA,
    task_prompt: input.work_item.task_prompt.replace(/\r\n?/g, "\n"),
  };
  const bytes = canonicalJson(payload);
  const persistedPayload = Buffer.byteLength(bytes, "utf8") <= INLINE_PAYLOAD_MAX_BYTES
    ? { inline: payload } as const
    : {
      blob: input.blob_store.put({
        bytes,
        encoding: "utf-8",
        media_type: "application/json",
        payload_schema: KERNEL_WORK_REQUEST_PAYLOAD_SCHEMA,
        expected_digest: digestCanonicalJson(payload),
      }),
    } as const;
  return {
    id: input.work_item.id,
    repository_registration_id: input.work_item.repository_registration_id,
    source_provider: input.work_item.source_provider,
    source_id: input.work_item.source_id,
    source_reference: input.work_item.source_reference,
    state: "active",
    title: input.work_item.title,
    payload_schema: KERNEL_WORK_REQUEST_PAYLOAD_SCHEMA,
    payload: persistedPayload,
  };
}

/**
 * Admits one exact Git subject. All fallible compilation and runtime
 * capability checks happen before durable pointers, then bundle/work bytes are
 * prewritten and the store owns the one atomic relational commit.
 */
export async function admitKernelPipeline(input: {
  repository: string;
  source_commit: string;
  expected_pipeline?: string;
  source_reader: ExactDefinitionSourceReader;
  platform: TrustedPlatformDefinitionSource;
  compiler_environment: TrustedCompilerEnvironment;
  runtime_compatibility: KernelRuntimeCompatibilityPort;
  blob_store: Pick<VolumeBlobStore, "put" | "read" | "assertToken">;
  store: Pick<SqliteKernelStore, "admitPipelineRun">;
  work_item: KernelAdmissionWorkItem;
  identity: KernelAdmissionIdentity;
  work_retry_limit: number;
  result_correction_limit: number;
  compile?: KernelDefinitionCompiler;
}): Promise<KernelAdmissionResult> {
  const compile = input.compile ?? compileRepositoryDefinitionAtCommit;
  const compilation = await compile({
    repository: input.repository,
    commit: input.source_commit,
    ...(input.expected_pipeline === undefined
      ? {}
      : { expectedPipeline: input.expected_pipeline }),
    sourceReader: input.source_reader,
    platform: input.platform,
    compilerEnvironment: input.compiler_environment,
  });
  if (compilation.bundle.value.source_commit !== input.source_commit) {
    throw new Error("compiled DefinitionBundle changed the exact admission subject");
  }
  await input.runtime_compatibility.assertCompatible({
    manifest_runtime_capability_digest: compilation.manifest.value.runtime_capability_digest,
    stages: compilation.manifest.value.stages,
    definition_entries: compilation.bundle.value.entries,
  });

  const definitionBundleToken = input.blob_store.put({
    bytes: compilation.bundle.normalized,
    encoding: "utf-8",
    media_type: "application/json",
    payload_schema: "openthrottle.definition-bundle/v1",
    expected_digest: compilation.bundle.digest,
  });
  const verifiedPointer = input.blob_store.assertToken(definitionBundleToken);
  const reread = input.blob_store.read(verifiedPointer).toString("utf8");
  if (
    reread !== compilation.bundle.normalized ||
    digestCanonicalJson(JSON.parse(reread)) !== compilation.bundle.digest
  ) {
    throw new Error("prewritten DefinitionBundle failed exact re-read verification");
  }

  const actionInputs: KernelActionInputs = {
    task_prompt: input.work_item.task_prompt,
    context: { records: [], checkpoints: [] },
  };
  const initialAttempt = createPendingStageAttempt({
    id: input.identity.initial_attempt_id,
    pipeline_run_id: input.identity.pipeline_run_id,
    stage_id: compilation.manifest.value.entry_stage,
    input_subject: input.source_commit,
    bundle: compilation.bundle.value,
    manifest: compilation.manifest.value,
    action_inputs: actionInputs,
  });
  const run: KernelRun = {
    schema: KERNEL_RUN_SCHEMA,
    id: input.identity.pipeline_run_id,
    pipeline_id: compilation.manifest.value.pipeline_id,
    definition_bundle_hash: compilation.bundle.digest,
    current_subject: input.source_commit,
    status: "pending",
    terminal_outcome: null,
    cursor: compileKernelCursor({
      stage_id: compilation.manifest.value.entry_stage,
      version: 0,
      attempts: [initialAttempt],
    }),
    version: 0,
    work_retry_limit: input.work_retry_limit,
    result_correction_limit: input.result_correction_limit,
    active_attempt_versions: { [initialAttempt.id]: initialAttempt.version },
    active_effect_versions: {},
    checkpoint_ids: {},
  };
  const admission: PipelineAdmissionInput = {
    work_item: prewriteWorkItem({ blob_store: input.blob_store, work_item: input.work_item }),
    definitions: definitionSnapshots(compilation),
    run,
    definition_bundle: definitionBundleToken,
    initial_attempts: [initialAttempt],
  };
  input.store.admitPipelineRun(admission);
  return { compilation, run, initial_attempt: initialAttempt, definition_bundle_token: definitionBundleToken };
}
