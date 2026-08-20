import type {
  AttemptCheckpoint,
  CompiledPipelineManifest,
  DefinitionBundle,
  EffectIntent,
  ExecutionRecord,
} from "@openthrottle/contracts";
import type { EffectReconciliation } from "./effect-intent.js";
import type {
  AtomicTransitionBundle,
  AttemptLease,
  KernelAttempt,
  KernelRun,
} from "./types.js";
import type { AtomicTransitionApplyResult } from "./store.js";

export interface ReductionReadRequest {
  pipeline_run_id: string;
  attempt_id: string | null;
  record_ids: readonly string[];
  checkpoint_ids: readonly string[];
}

export interface ReductionView {
  manifest: CompiledPipelineManifest;
  run: KernelRun;
  current_attempt: KernelAttempt | null;
  records: ReadonlyMap<string, ExecutionRecord>;
  checkpoints: ReadonlyMap<string, AttemptCheckpoint>;
}

export interface KernelReductionPort {
  loadExactReductionView(request: ReductionReadRequest): Promise<ReductionView>;
  applyAtomicTransition(bundle: AtomicTransitionBundle): Promise<AtomicTransitionApplyResult>;
}

export interface AttemptLeaseRequest {
  worker_id: string;
  lease_id: string;
  expires_at: string;
}

export interface LeasedAttemptView {
  run_id: string;
  run_version: number;
  cursor_version: number;
  attempt: KernelAttempt;
  lease: AttemptLease;
}

export interface KernelAttemptLeasePort {
  // Implementations materialize dependency eligibility from KernelCursor as
  // indexed attempt state; this operation must not discover work by scanning
  // dependency JSON or return a blocked frontier member.
  leaseNextEligibleAttempt(request: AttemptLeaseRequest): Promise<LeasedAttemptView | null>;
  renewAttemptLease(input: {
    attempt_id: string;
    lease_id: string;
    worker_id: string;
    expires_at: string;
  }): Promise<AttemptLease>;
}

export interface LeasedEffectView {
  intent: EffectIntent;
  lease_id: string;
  expires_at: string;
  execution_mode: "dispatch_or_reconcile" | "reconcile_only";
}

export interface KernelEffectPort {
  // The returned view is the only effect the worker may inspect or mutate.
  leaseNextEffect(input: {
    worker_id: string;
    lease_id: string;
    expires_at: string;
  }): Promise<LeasedEffectView | null>;
  // This write-ahead fence is required immediately before provider mutation.
  // Once persisted, lease replay and expiry recovery are reconciliation-only.
  markLeasedEffectDispatchStarted(input: {
    effect_id: string;
    lease_id: string;
    worker_id: string;
  }): Promise<LeasedEffectView>;
  completeLeasedEffect(input: {
    effect_id: string;
    lease_id: string;
    worker_id: string;
    reconciliation: EffectReconciliation;
  }): Promise<void>;
}

export interface ResolvedKernelContext {
  records: ReadonlyMap<string, ExecutionRecord>;
  checkpoints: ReadonlyMap<string, AttemptCheckpoint>;
}

export const KERNEL_WORK_REQUEST_PAYLOAD_SCHEMA =
  "openthrottle.kernel-work-request/v1" as const;

export interface KernelAttemptRequestInputs {
  task_prompt: string;
  context: ResolvedKernelContext;
}

/**
 * Reconstructs one sealed request exclusively from immutable work-item bytes
 * and the exact context IDs persisted on its Attempt. Callers cannot widen
 * this view by supplying IDs at dispatch time.
 */
export interface KernelAttemptRequestPort {
  loadAttemptRequestInputs(input: {
    pipeline_run_id: string;
    attempt_id: string;
  }): Promise<KernelAttemptRequestInputs>;
}

export interface KernelDefinitionBundleBytesPort {
  loadExactDefinitionBundleBytes(input: {
    pipeline_run_id: string;
    definition_bundle_hash: string;
  }): Promise<Uint8Array>;
}

export interface KernelDefinitionBundlePort {
  resolveExactDefinitionBundle(input: {
    pipeline_run_id: string;
    definition_bundle_hash: string;
  }): Promise<DefinitionBundle>;
}

export interface KernelContextPort {
  resolveExactContext(input: {
    pipeline_run_id: string;
    attempt_id: string;
    allowed_record_ids: readonly string[];
    allowed_checkpoint_ids: readonly string[];
  }): Promise<ResolvedKernelContext>;
}

export interface KernelRunProjection {
  pipeline_run_id: string;
  pipeline_id: string;
  status: KernelRun["status"];
  stage_id: string | null;
  current_subject: string;
  active_attempt_count: number;
  active_effect_count: number;
  version: number;
}

export interface KernelLogProjection {
  sequence: number;
  kind: "attempt" | "record" | "effect" | "checkpoint" | "transition";
  identity: string;
  summary: string;
}

export interface KernelProjectionPort {
  getRunProjection(pipelineRunId: string): Promise<KernelRunProjection | undefined>;
  listRunLog(input: {
    pipeline_run_id: string;
    after_sequence?: number;
    limit: number;
  }): Promise<readonly KernelLogProjection[]>;
}
