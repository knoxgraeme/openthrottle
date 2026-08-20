import type {
  AttemptCheckpoint,
  CompiledPipelineStage,
  DefinitionBundleEntry,
  ExecutionRecord,
  ResultCandidate,
  ResultNormalizationDiagnostic,
  SemanticResultSchemaContract,
} from "@openthrottle/contracts";
import type { KernelAttempt } from "../pipeline/kernel/types.js";

export const KERNEL_ACTION_REQUEST_SCHEMA = "openthrottle.kernel-action-request/v1" as const;
export const KERNEL_RESULT_CORRECTION_REQUEST_SCHEMA =
  "openthrottle.kernel-result-correction-request/v1" as const;
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

export interface KernelAgentAction {
  kind: "agent";
  engine: Extract<CompiledPipelineStage, { kind: "agent" }>["engine"];
  agent_id: string;
  skill_ids: readonly string[];
  entry_skill: string | null;
  eval_id: string;
  semantic_result_schema: SemanticResultSchemaContract;
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
  input_subject: string;
  repository_authority: KernelAttempt["repository_authority"];
  lease_id: string;
  worker_id: string;
  task_prompt: string;
  context: KernelActionContext;
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
  pipeline_run_id: string;
  attempt_id: string;
  stage_id: string;
  scope: KernelAttempt["scope"];
  request_hash: string;
  definition_bundle_hash: string;
  input_subject: string;
  /** The immutable subject produced by work, or the inspected input subject. */
  locked_subject: string;
  checkpoint_id: string;
  native_session_id: string;
  lease_id: string;
  worker_id: string;
  correction_deadline: string;
  diagnostics: readonly { path: string; detail: string }[];
  semantic_result_schema: SemanticResultSchemaContract;
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
    reason: string;
  }
  | {
    state: "needs_human";
    reason: string;
    checkpoint: AttemptCheckpoint | null;
    candidate_hash: string | null;
    diagnostics: readonly { path: string; detail: string }[];
  };

export interface KernelRuntimePort {
  executeWork(request: KernelWorkActionRequest): Promise<KernelRuntimeOutcome>;
  correctResult(request: KernelResultCorrectionRequest): Promise<KernelRuntimeOutcome>;
}

export interface KernelRuntimeCompatibilityPort {
  assertCompatible(input: {
    manifest_runtime_capability_digest: string;
    stages: readonly CompiledPipelineStage[];
    definition_entries: readonly DefinitionBundleEntry[];
  }): void | Promise<void>;
}
