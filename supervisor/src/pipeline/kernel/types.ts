import {
  compareCodeUnits,
  type BlobPointer,
  type AttemptCheckpoint,
  type AttemptState,
  type CompiledPipelineManifest,
  type DecisionRecord,
  type EffectIntent,
  type ExecutionRecord,
  type PipelineTerminalOutcome,
  type RepositoryAuthority,
} from "@openthrottle/contracts";

export const KERNEL_RUN_SCHEMA = "openthrottle.kernel-run/v1" as const;
export const KERNEL_ATTEMPT_SCHEMA = "openthrottle.kernel-attempt/v1" as const;
export const ATOMIC_TRANSITION_SCHEMA = "openthrottle.atomic-transition/v1" as const;
export const EXTERNAL_SCHEDULE_REDUCER = "core/external-schedule@1" as const;
export const EXTERNAL_SCHEDULE_PAYLOAD_SCHEMA =
  "openthrottle.external-schedule/v1" as const;
export const MAX_EXTERNAL_EFFECTS_PER_PHASE = 16;

export type KernelRunStatus =
  | "pending"
  | "running"
  | PipelineTerminalOutcome;

export interface KernelCursor {
  stage_id: string | null;
  version: number;
  reentries: Readonly<Record<string, number>>;
  frontier: readonly KernelFrontierMember[];
  completed_scope_keys: readonly string[];
  barrier: KernelBarrier | null;
}

export interface KernelRun {
  schema: typeof KERNEL_RUN_SCHEMA;
  id: string;
  pipeline_id: string;
  definition_bundle_hash: string;
  current_subject: string;
  status: KernelRunStatus;
  terminal_outcome: PipelineTerminalOutcome | null;
  cursor: KernelCursor;
  version: number;
  work_retry_limit: number;
  result_correction_limit: number;
  active_attempt_versions: Readonly<Record<string, number>>;
  active_effect_versions: Readonly<Record<string, number>>;
  checkpoint_ids: Readonly<Record<string, string>>;
}

interface AttemptScopeBase {
  stage_id: string;
}

export interface StageAttemptScope extends AttemptScopeBase {
  kind: "stage";
}

export interface LoopItemAttemptScope extends AttemptScopeBase {
  kind: "loop_item";
  parent_attempt_id: string;
  loop_id: string;
  item_id: string;
  item_index: number;
}

export interface FanoutMemberAttemptScope extends AttemptScopeBase {
  kind: "fanout_member";
  parent_attempt_id: string;
  fanout_id: string;
  member_id: string;
  member_index: number;
}

export type AttemptScope =
  | StageAttemptScope
  | LoopItemAttemptScope
  | FanoutMemberAttemptScope;

export interface KernelFrontierMember {
  scope_key: string;
  attempt_id: string;
  scope: AttemptScope;
  depends_on: readonly string[];
}

export interface KernelBarrier {
  kind: "all";
  member_scope_keys: readonly string[];
}

export type AttemptLeasePurpose = "work" | "result_correction";

export interface AttemptLease {
  id: string;
  generation: number;
  worker_id: string;
  purpose: AttemptLeasePurpose;
  expires_at: string;
  started: boolean;
}

export interface ResultPendingState {
  candidate_hash: string | null;
  diagnostics: readonly ResultDiagnostic[];
  /** Null only when reading the legacy bare-array persisted form. */
  invalid_result_evidence: BlobPointer | null;
}

export interface ResultDiagnostic {
  path: string;
  detail: string;
}

export interface KernelAttempt {
  schema: typeof KERNEL_ATTEMPT_SCHEMA;
  id: string;
  pipeline_run_id: string;
  scope: AttemptScope;
  repository_authority: RepositoryAuthority;
  request_hash: string;
  definition_bundle_hash: string;
  input_subject: string;
  context_record_ids: readonly string[];
  context_checkpoint_ids: readonly string[];
  output_subject: string | null;
  native_session_id: string | null;
  status: AttemptState;
  version: number;
  work_retry_ordinal: number;
  result_correction_count: number;
  result_correction_deadline: string | null;
  lease: AttemptLease | null;
  checkpoint_id: string | null;
  result_record_id: string | null;
  decision_record_id: string | null;
  pending_result: ResultPendingState | null;
}

const CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const MAX_CONTEXT_IDS = 256;

export function canonicalAttemptContextIds(
  values: readonly string[],
  label: string,
): string[] {
  if (!Array.isArray(values) || values.length > MAX_CONTEXT_IDS) {
    throw new Error(`${label} must contain at most ${MAX_CONTEXT_IDS} IDs`);
  }
  const normalized = values.map((value) => {
    if (typeof value !== "string" || !CONTEXT_ID.test(value)) {
      throw new Error(`${label} contains an invalid ID`);
    }
    return value;
  });
  const sorted = [...normalized].sort(compareCodeUnits);
  if (
    new Set(sorted).size !== sorted.length ||
    sorted.some((value, index) => value !== normalized[index])
  ) {
    throw new Error(`${label} must be strictly sorted without duplicates`);
  }
  return sorted;
}

interface KernelCommandBase {
  command_id: string;
}

export interface StartAttemptCommand extends KernelCommandBase {
  type: "start";
  attempt_id: string;
  lease_id: string;
}

export interface BindRuntimeSessionCommand extends KernelCommandBase {
  type: "bind_runtime_session";
  attempt_id: string;
  expected_run_version: number;
  expected_cursor_version: number;
  expected_attempt_version: number;
  request_hash: string;
  definition_bundle_hash: string;
  input_subject: string;
  lease_id: string;
  worker_id: string;
  lease_purpose: AttemptLeasePurpose;
  expected_lease_expires_at: string;
  expected_work_retry_ordinal: number;
  expected_result_correction_count: number;
  native_session_id: string;
}

export interface WorkCompleteCommand extends KernelCommandBase {
  type: "work_complete";
  attempt_id: string;
  checkpoint_id: string;
  verified_output_subject: string | null;
  /** Verified runtime evidence persisted in the same transition as successful work. */
  result_record_id: string | null;
}

export interface ResultPendingCommand extends KernelCommandBase {
  type: "result_pending";
  attempt_id: string;
  candidate_hash: string | null;
  diagnostics: readonly ResultDiagnostic[];
  correction_deadline: string;
  invalid_result_evidence: BlobPointer;
  invalid_result_evidence_record_id: string;
}

export interface RecordResultCommand extends KernelCommandBase {
  type: "record";
  attempt_id: string;
  record_id: string;
}

export interface ScheduleExternalCommand extends KernelCommandBase {
  type: "schedule_external";
  attempt_id: string;
  checkpoint_id: string;
  decision_record_id: string;
  phase: string;
  verified_output_subject: string | null;
  effect_intents: readonly EffectIntent[];
}

/**
 * The sole post-effect repository advance. A confirmed Daytona integration
 * DeliveryRecord promotes ordinal-0 planning evidence to one verified
 * ordinal-1 Git bundle. Only core/integrate-unit@1 and core/publish@1 use it.
 */
export interface AdvanceExternalSubjectCommand extends KernelCommandBase {
  type: "advance_external_subject";
  attempt_id: string;
  prior_checkpoint_id: string;
  checkpoint_id: string;
  delivery_record_id: string;
  verified_output_subject: string;
}

interface SettlementCommandFields {
  attempt_id: string;
  decision_record_id: string;
  outcome: string;
  next_attempts: readonly KernelAttempt[];
  next_dependencies?: Readonly<Record<string, readonly string[]>>;
  effect_intents?: readonly EffectIntent[];
  sandbox_recovery?: {
    recovery_record_id: string;
    target_stage_id: string;
    input_subjects: Readonly<Record<string, string>>;
  };
}

export interface SettleAttemptCommand extends KernelCommandBase, SettlementCommandFields {
  type: "settle";
}

/**
 * Successful result correction records the corrected result, rejected-candidate
 * evidence, and evidence-citing settlement in one durable transition.
 */
export interface CorrectAndSettleAttemptCommand extends KernelCommandBase, SettlementCommandFields {
  type: "correct_and_settle";
  result_record_id: string;
  invalid_result_evidence_record_id: string;
}

export interface RetryAttemptCommand extends KernelCommandBase {
  type: "retry";
  attempt_id: string;
  forensics_record_id?: string | null;
}

/**
 * Executor-owned last resort for a repeatedly unrecoverable leased Attempt.
 * Unlike an authored terminal transition, this command deliberately does not
 * claim that runtime cleanup completed: unresolved Effect and DeliveryRecord
 * evidence remains durable for operator recovery.
 */
export interface QuarantineAttemptRecoveryCommand extends KernelCommandBase {
  type: "quarantine_attempt_recovery";
  attempt_id: string;
  decision_record_id: string;
  reason: string;
  lease_id: string;
  lease_generation: number;
  worker_id: string;
  lease_purpose: AttemptLeasePurpose;
}

interface TerminalCommandBase extends KernelCommandBase {
  decision_record_id: string;
  reason: string;
  resource_disposition: KernelTerminalResourceDisposition;
}

export type KernelTerminalResourceDisposition =
  | {
    /** Reducer independently proves the provision schedule never committed. */
    kind: "pre_provision";
  }
  | {
    /** Exact confirmed Daytona create evidence authorizes stop + cleanup. */
    kind: "cleanup";
    runtime_delivery_record_ids: readonly string[];
    diagnostic_record_ids?: readonly string[];
    new_diagnostic_record_ids?: readonly string[];
    cleanup_attempt: KernelAttempt;
  };

export interface NeedsHumanCommand extends TerminalCommandBase {
  type: "needs_human";
  attempt_id: string | null;
}

export interface FailCommand extends TerminalCommandBase {
  type: "fail";
  attempt_id: string | null;
}

export interface StopCommand extends TerminalCommandBase {
  type: "stop";
}

export interface SupersedeCommand extends TerminalCommandBase {
  type: "supersede";
}

export type KernelCommand =
  | StartAttemptCommand
  | BindRuntimeSessionCommand
  | WorkCompleteCommand
  | ResultPendingCommand
  | ScheduleExternalCommand
  | AdvanceExternalSubjectCommand
  | RecordResultCommand
  | SettleAttemptCommand
  | CorrectAndSettleAttemptCommand
  | RetryAttemptCommand
  | QuarantineAttemptRecoveryCommand
  | NeedsHumanCommand
  | FailCommand
  | StopCommand
  | SupersedeCommand;

export interface ReducerInput {
  manifest: CompiledPipelineManifest;
  run: KernelRun;
  current_attempt: KernelAttempt | null;
  records: ReadonlyMap<string, ExecutionRecord>;
  checkpoints: ReadonlyMap<string, AttemptCheckpoint>;
  command: KernelCommand;
}

export interface AttemptTerminalWrite {
  kind: "terminal";
  attempt_id: string;
  expected_version: number;
  next_version: number;
  status: Extract<AttemptState, "needs_human" | "failed" | "canceled" | "superseded">;
}

export interface AttemptReplaceWrite {
  kind: "replace";
  attempt: KernelAttempt;
}

export type AttemptWrite = AttemptTerminalWrite | AttemptReplaceWrite;

export interface AtomicTransitionExpectedState {
  run_id: string;
  run_version: number;
  cursor_version: number;
  attempt_versions: Readonly<Record<string, number>>;
}

export interface AtomicTransitionBundleContent {
  schema: typeof ATOMIC_TRANSITION_SCHEMA;
  transition_id: string;
  expected: AtomicTransitionExpectedState;
  run: KernelRun;
  attempt_writes: readonly AttemptWrite[];
  create_attempts: readonly KernelAttempt[];
  append_records: readonly ExecutionRecord[];
  append_checkpoints: readonly AttemptCheckpoint[];
  put_effects: readonly EffectIntent[];
  cancel_effect_ids: readonly string[];
}

export interface AtomicTransitionBundle extends AtomicTransitionBundleContent {
  content_hash: string;
}

export interface DecisionAuthorization {
  decision: DecisionRecord;
  exact_records: readonly ExecutionRecord[];
}
