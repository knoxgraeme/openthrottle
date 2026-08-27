import {
  compareCodeUnits,
  type AttemptCheckpoint,
  type CompiledPipelineManifest,
  type CompiledPipelineStage,
  type DefinitionBundle,
  type DeliveryRecord,
  type DecisionRecord,
  type EffectIntent,
  type ExecutionRecord,
  type ResultRecord,
} from "@openthrottle/contracts";
import type { EvaluatedKernelResult } from "./evaluator-registry.js";
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

export interface AttemptLeaseClaim {
  run_id: string;
  attempt_id: string;
  lease_id: string;
  lease_generation: number;
  worker_id: string;
  purpose: AttemptLease["purpose"];
}

/** Captures the supervisor-private ownership claim without renewable fields. */
export function captureAttemptLeaseClaim(leased: LeasedAttemptView): AttemptLeaseClaim {
  const persisted = leased.attempt.lease;
  if (
    !persisted || persisted.id !== leased.lease.id ||
    persisted.generation !== leased.lease.generation ||
    persisted.worker_id !== leased.lease.worker_id ||
    persisted.purpose !== leased.lease.purpose
  ) throw new Error("leased Attempt view contains a mismatched lease claim");
  return Object.freeze({
    run_id: leased.run_id,
    attempt_id: leased.attempt.id,
    lease_id: leased.lease.id,
    lease_generation: leased.lease.generation,
    worker_id: leased.lease.worker_id,
    purpose: leased.lease.purpose,
  });
}

export function assertAttemptLeaseClaim(
  view: ReductionView,
  claim: AttemptLeaseClaim,
): KernelAttempt {
  const attempt = view.current_attempt;
  const lease = attempt?.lease;
  if (
    view.run.id !== claim.run_id || attempt?.id !== claim.attempt_id ||
    !lease || lease.id !== claim.lease_id ||
    lease.generation !== claim.lease_generation ||
    lease.worker_id !== claim.worker_id || lease.purpose !== claim.purpose
  ) throw new Error("Attempt lease claim generation is stale or mismatched");
  return attempt;
}

export interface KernelAttemptLeasePort {
  // Implementations materialize dependency eligibility from KernelCursor as
  // indexed attempt state; this operation must not discover work by scanning
  // dependency JSON or return a blocked frontier member.
  leaseNextEligibleAttempt(request: AttemptLeaseRequest): Promise<LeasedAttemptView | null>;
  renewAttemptLease(input: {
    attempt_id: string;
    lease_id: string;
    lease_generation: number;
    worker_id: string;
    expires_at: string;
  }): Promise<AttemptLease>;
  /**
   * Reclaims expired leases without inventing a new attempt, retry ordinal,
   * lease identity, or worker identity. Returning the original fence lets the
   * runtime reconcile an already-written result/session before relaunch.
   */
  recoverExpiredAttemptLeases(input: {
    observed_at: string;
    expires_at: string;
    limit: number;
  }): Promise<readonly LeasedAttemptView[]>;
}

export interface KernelAttemptRecoveryQuarantinePort {
  quarantineExhaustedAttemptRecovery(input: {
    claim: AttemptLeaseClaim;
    diagnostic: DecisionRecord;
    reason: string;
  }): Promise<boolean>;
}

export interface LeasedEffectView {
  intent: EffectIntent;
  lease_id: string;
  expires_at: string;
  execution_mode: "dispatch_or_reconcile" | "reconcile_only";
  reconciliation_ordinal: number;
  /** Prior held reconciliation evidence, retained across lease replay. */
  prior_unknown_detail: string | null;
  /** Immutable identity of the one executor dispatch, retained across reconciliation leases. */
  dispatch_fence: {
    lease_id: string;
    worker_id: string;
  } | null;
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

export interface KernelOperatorEffectRejectionRequest {
  pipeline_run_id: string;
  effect_id: string;
  expected_maintenance_version: number;
  resolution_id: string;
  reason_code: "legacy_integration_idempotency_key_rejected_before_mutation";
  reason: string;
}

export interface KernelOperatorEffectRejectionResult {
  disposition: "rejected" | "unchanged";
  pipeline_run_id: string;
  effect_id: string;
  delivery_record_id: string;
  effect_version: number;
  run_version: number;
}

export interface KernelOperatorEffectRejectionPort {
  rejectDispatchFencedUnknownEffect(
    input: KernelOperatorEffectRejectionRequest,
  ): Promise<KernelOperatorEffectRejectionResult>;
}

export interface ExternalScheduleEffectView {
  intent: EffectIntent;
  delivery: DeliveryRecord | null;
}

export interface ExternalScheduleView {
  semantic_key: string;
  decision: DecisionRecord;
  effects: readonly ExternalScheduleEffectView[];
}

export interface KernelExternalSettlementPlan {
  decision: DecisionRecord;
  outcome: string;
  next_attempts: readonly KernelAttempt[];
  next_dependencies?: Readonly<Record<string, readonly string[]>>;
  sandbox_recovery?: {
    recovery_record_id: string;
    target_stage_id: string;
    input_subjects: Readonly<Record<string, string>>;
  };
}

export interface KernelExternalSettlementPlanner {
  plan(input: {
    view: ReductionView;
    stage: Extract<CompiledPipelineStage, { kind: "effect" | "wait" }>;
    attempt: KernelAttempt;
    result: ResultRecord;
    checkpoint: AttemptCheckpoint;
    bundle: DefinitionBundle;
    schedules: readonly ExternalScheduleView[];
    evaluated: EvaluatedKernelResult;
    default_plan: () => Promise<KernelExternalSettlementPlan>;
  }): Promise<KernelExternalSettlementPlan>;
}

export interface KernelExternalSchedulePort {
  /** Indexed, exact semantic-key lookup; never scans an arbitrary run corpus. */
  findExternalSchedule(input: {
    pipeline_run_id: string;
    attempt_id: string;
    phase: string;
  }): Promise<ExternalScheduleView | null>;
  listReadyExternalAttempts(
    input: KernelContinuationPageRequest,
  ): Promise<readonly KernelContinuationCandidate[]>;
}

export interface KernelOrdinaryContinuationPort {
  listReadyOrdinaryAttempts(
    input: KernelContinuationPageRequest,
  ): Promise<readonly KernelContinuationCandidate[]>;
}

export interface KernelContinuationCandidate {
  updated_at: string;
  pipeline_run_id: string;
  attempt_id: string;
}

export interface KernelContinuationPageRequest {
  limit: number;
  after?: KernelContinuationCandidate;
}

function compareContinuationCandidates(
  left: KernelContinuationCandidate,
  right: KernelContinuationCandidate,
): number {
  return compareCodeUnits(left.updated_at, right.updated_at) ||
    compareCodeUnits(left.pipeline_run_id, right.pipeline_run_id) ||
    compareCodeUnits(left.attempt_id, right.attempt_id);
}

export async function firstSuccessfulKernelContinuation<T>(input: {
  page_size: number;
  list: (
    request: KernelContinuationPageRequest,
  ) => Promise<readonly KernelContinuationCandidate[]>;
  resume: (candidate: KernelContinuationCandidate) => Promise<T>;
}): Promise<T | undefined> {
  let after: KernelContinuationCandidate | undefined;
  let firstError: unknown;
  for (;;) {
    const candidates = await input.list({
      limit: input.page_size,
      ...(after === undefined ? {} : { after }),
    });
    if (candidates.length > input.page_size) {
      throw new Error("kernel continuation selector returned an oversized page");
    }
    for (const candidate of candidates) {
      if (after !== undefined && compareContinuationCandidates(candidate, after) <= 0) {
        throw new Error("kernel continuation selector returned a non-advancing page");
      }
      after = candidate;
      try {
        return await input.resume(candidate);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (candidates.length < input.page_size) break;
  }
  if (firstError !== undefined) throw firstError;
  return undefined;
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

export interface StructuredPlanningReadRequest {
  pipeline_run_id: string;
  definition_bundle_hash: string;
  scope_kind: "loop_item" | "fanout_member";
  parent_attempt_id: string;
  scope_group_id: string;
  stage_ids: readonly string[];
  member_ids: readonly string[];
}

/**
 * One fully settled structured Attempt reconstructed through explicit indexed
 * scope selectors. The Decision relation is persisted on the Attempt; readers
 * never discover it by scanning Decision payload JSON.
 */
export interface SettledStructuredPlanningAttempt {
  attempt: KernelAttempt;
  result: Extract<ExecutionRecord, { kind: "result" }>;
  decision: DecisionRecord;
  /** Exact materialized inputs cited by the settlement DecisionRecord. */
  decision_input_records: readonly ExecutionRecord[];
  checkpoint: AttemptCheckpoint;
  request_inputs: KernelAttemptRequestInputs;
}

export interface KernelStructuredPlanningReadPort {
  listSettledStructuredPlanningAttempts(
    request: StructuredPlanningReadRequest,
  ): Promise<readonly SettledStructuredPlanningAttempt[]>;
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
