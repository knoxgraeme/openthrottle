import type {
  AttemptCheckpoint,
  CompiledPipelineStage,
  DefinitionBundleEntry,
  ExecutionRecord,
  FilesystemConfigContract,
  ResultCandidate,
  ResultNormalizationDiagnostic,
  SemanticResultSchemaContract,
} from "@openthrottle/contracts";
import type { KernelAttempt } from "../pipeline/kernel/types.js";
import type { KernelRuntimeResourceIdentity } from "../pipeline/kernel/runtime-resource.js";

export const KERNEL_ACTION_REQUEST_SCHEMA = "openthrottle.kernel-action-request/v2" as const;
export const KERNEL_RESULT_CORRECTION_REQUEST_SCHEMA =
  "openthrottle.kernel-result-correction-request/v2" as const;
export const STAGED_SEMANTIC_CANDIDATE_SCHEMA =
  "openthrottle.staged-result-candidate/v1" as const;

export interface KernelActionContext {
  records: readonly ExecutionRecord[];
  checkpoints: readonly AttemptCheckpoint[];
}

export interface KernelChangeBoundary {
  checkpoint_id: string;
  input_subject: string;
  output_subject: string;
}

export interface KernelExecutionLimits {
  /** Repository-authored wall-clock limit. The provider may enforce a tighter platform cap. */
  task_timeout_seconds: number | null;
  /** Native agent-turn cap; null means the selected engine has no repository-authored cap. */
  max_turns: number | null;
}

export interface KernelAgentAction {
  kind: "agent";
  engine: Extract<CompiledPipelineStage, { kind: "agent" }>["engine"];
  model: string | null;
  reasoning_effort: Exclude<FilesystemConfigContract["reasoning_effort"], undefined> | null;
  agent_id: string;
  skill_ids: readonly string[];
  entry_skill: string | null;
  eval_id: string;
  semantic_result_schema: SemanticResultSchemaContract;
  execution_limits: KernelExecutionLimits;
  /**
   * Exact entries from the pinned DefinitionBundle. The sandbox passes these
   * to compileActionProfile/materializeActionProfile; it must never reread the
   * image or the repository filesystem for an admitted action.
   */
  definition_entries: readonly DefinitionBundleEntry[];
}

export interface KernelCommandAction {
  kind: "command";
  command_id: string;
  command_line: string;
  /** Exact normalized repository bootstrap commands, executed serially before the command. */
  post_bootstrap: readonly string[];
  execution_limits: KernelExecutionLimits;
}

export type KernelExecutableAction = KernelAgentAction | KernelCommandAction;

export interface KernelWorkActionRequest {
  schema: typeof KERNEL_ACTION_REQUEST_SCHEMA;
  phase: "work";
  pipeline_run_id: string;
  attempt_id: string;
  stage_id: string;
  scope: KernelAttempt["scope"];
  request_hash: string;
  definition_bundle_hash: string;
  /** Stable remotely-known run base; checkpoint bundles exclude only history before this subject. */
  checkpoint_base_subject: string;
  input_subject: string;
  repository_authority: KernelAttempt["repository_authority"];
  lease_id: string;
  worker_id: string;
  task_prompt: string;
  context: KernelActionContext;
  runtime_resource: KernelRuntimeResourceIdentity | null;
  change_boundary: KernelChangeBoundary | null;
  action: KernelExecutableAction;
  executor_policy: {
    git_administration: "executor_only";
    commit: false;
    push: false;
    publish: false;
  };
}

export interface KernelResultCorrectionRequest {
  schema: typeof KERNEL_RESULT_CORRECTION_REQUEST_SCHEMA;
  phase: "result_correction";
  engine: Extract<CompiledPipelineStage, { kind: "agent" }>["engine"];
  model: string | null;
  reasoning_effort: Exclude<FilesystemConfigContract["reasoning_effort"], undefined> | null;
  pipeline_run_id: string;
  attempt_id: string;
  stage_id: string;
  scope: KernelAttempt["scope"];
  request_hash: string;
  definition_bundle_hash: string;
  checkpoint_base_subject: string;
  input_subject: string;
  /** The immutable subject produced by work, or the inspected input subject. */
  locked_subject: string;
  /** Original work authority; correction itself remains inspect-only. */
  completed_work_authority: KernelAttempt["repository_authority"];
  checkpoint_id: string;
  native_session_id: string;
  lease_id: string;
  worker_id: string;
  correction_deadline: string;
  diagnostics: readonly { path: string; detail: string }[];
  semantic_result_schema: SemanticResultSchemaContract;
  execution_limits: KernelExecutionLimits;
  /** Correction is result-only even when the completed work attempt was edit. */
  repository_authority: "inspect";
  tools: readonly ["ot-result"];
  mcp: false;
  provider_access: false;
}

export interface StagedSemanticCandidate {
  schema: typeof STAGED_SEMANTIC_CANDIDATE_SCHEMA;
  semantic_schema_id: string;
  original: ResultCandidate;
  original_hash: string;
  candidate: ResultCandidate;
  normalized_hash: string;
  transformations: readonly ResultNormalizationDiagnostic[];
}

export interface KernelCommandResult {
  kind: "command";
  outcome: "success" | "no_change" | "retryable_infrastructure_failure" | "failure";
  command_id: string;
  exit_code: number;
  summary: string;
}

export type KernelVerifiedActionResult =
  | { kind: "semantic"; candidate: StagedSemanticCandidate }
  | KernelCommandResult;

export type KernelRuntimeOutcome =
  | {
    state: "work_complete";
    checkpoint: AttemptCheckpoint;
    result: KernelVerifiedActionResult;
  }
  | {
    state: "result_pending";
    checkpoint: AttemptCheckpoint;
    candidate_hash: string | null;
    diagnostics: readonly { path: string; detail: string }[];
    correction_deadline: string;
  }
  | {
    state: "work_failed";
    retryable: boolean;
    /** The owning sandbox is poisoned and must not execute this Attempt again. */
    sandbox_fatal?: boolean;
    reason: string;
  }
  | {
    state: "needs_human";
    reason: string;
    checkpoint: AttemptCheckpoint | null;
    candidate_hash: string | null;
    diagnostics: readonly { path: string; detail: string }[];
  };

export interface KernelRuntimeLeaseCallbacks {
  /** Private live lease fence; this is deliberately absent from the public action request wire. */
  lease_generation: number;
  /**
   * The adapter throttles renewal to this interval while provider work is
   * outstanding. A rejected renewal is an exact-fence loss and must abort
   * result acceptance.
   */
  heartbeat_interval_ms: number;
  on_heartbeat(): Promise<void>;
}

export interface KernelRuntimeWorkCallbacks extends KernelRuntimeLeaseCallbacks {
  /**
   * Agent executors must await this exactly once as soon as the provider-native
   * conversation exists, before work can finish or emit a checkpoint. Command
   * executors never call it. The callback durably binds the session while the
   * attempt's started work lease is still live.
   */
  on_session(nativeSessionId: string): Promise<void>;
}

export interface KernelRuntimePort {
  executeWork(
    request: KernelWorkActionRequest,
    callbacks: KernelRuntimeWorkCallbacks,
  ): Promise<KernelRuntimeOutcome>;
  correctResult(
    request: KernelResultCorrectionRequest,
    callbacks: KernelRuntimeLeaseCallbacks,
  ): Promise<KernelRuntimeOutcome>;
}

export interface KernelRuntimeCompatibilityPort {
  assertCompatible(input: {
    manifest_runtime_capability_digest: string;
    stages: readonly CompiledPipelineStage[];
    definition_entries: readonly DefinitionBundleEntry[];
  }): void | Promise<void>;
}
