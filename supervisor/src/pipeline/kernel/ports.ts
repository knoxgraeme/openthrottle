import type {
  AttemptCheckpoint,
  CompiledPipelineManifest,
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
    expires_at: string;
  }): Promise<AttemptLease>;
}

export interface LeasedEffectView {
  intent: EffectIntent;
  lease_id: string;
  expires_at: string;
}

export interface KernelEffectPort {
  // The returned view is the only effect the worker may inspect or mutate.
  leaseNextEffect(input: {
    worker_id: string;
    lease_id: string;
    expires_at: string;
  }): Promise<LeasedEffectView | null>;
  completeLeasedEffect(input: {
    effect_id: string;
    lease_id: string;
    reconciliation: EffectReconciliation;
  }): Promise<void>;
}

export interface ResolvedKernelContext {
  records: ReadonlyMap<string, ExecutionRecord>;
  checkpoints: ReadonlyMap<string, AttemptCheckpoint>;
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
