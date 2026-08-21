import {
  PIPELINE_TERMINAL_OUTCOMES,
  RUNTIME_PROVISION_STAGE_ID,
  canonicalJson,
  compareCodeUnits,
  digestCanonicalJson,
  runtimeCleanupStageId,
  runtimeStopStageId,
  validateEvalDefinition,
  type AttemptCheckpoint,
  type CompiledPipelineStage,
  type DecisionRecord,
  type DefinitionBundle,
  type ExecutionRecord,
  type ResultRecord,
  type PipelineTerminalOutcome,
} from "@openthrottle/contracts";
import type {
  KernelRuntimeOutcome,
  KernelRuntimeLeaseCallbacks,
  KernelRuntimePort,
  KernelVerifiedActionResult,
} from "../../runtime/kernel-contracts.js";
import {
  buildKernelResultCorrectionRequest,
  buildKernelWorkActionRequest,
  exactKernelContext,
  selectKernelAction,
} from "./action-request.js";
import {
  KernelEvaluatorRegistry,
  createCommandResultRecord,
  createPipelineDecisionRecord,
  createSemanticResultRecord,
  type EvaluatedKernelResult,
} from "./evaluator-registry.js";
import type {
  AttemptLeaseRequest,
  KernelAttemptLeasePort,
  KernelAttemptRequestPort,
  KernelDefinitionBundlePort,
  KernelReductionPort,
  LeasedAttemptView,
  ReductionView,
} from "./ports.js";
import { reduceKernelCommand } from "./reducer.js";
import type {
  AtomicTransitionBundle,
  KernelAttempt,
  KernelCommand,
  KernelRun,
} from "./types.js";
import type { KernelRuntimeSessionBindingPort } from "./steering.js";
import {
  deriveKernelSuccessorAttempt,
  deriveKernelTerminalCleanupAttempt,
  kernelSuccessorStageId,
} from "./successor-attempt.js";
import { exactKernelRuntimeCleanupDeliveries } from "./runtime-resource.js";

export interface OrdinaryKernelStore extends
  KernelReductionPort,
  KernelAttemptLeasePort,
  KernelAttemptRequestPort {}

export interface OrdinaryKernelSettlementPlan {
  decision: DecisionRecord;
  outcome: string;
  input_records: readonly ExecutionRecord[];
  checkpoints: readonly AttemptCheckpoint[];
  next_attempts: readonly KernelAttempt[];
  next_dependencies?: Readonly<Record<string, readonly string[]>>;
}

export interface OrdinaryKernelSettlementPlanner {
  plan(input: {
    view: ReductionView;
    stage: Exclude<CompiledPipelineStage, { kind: "effect" | "wait" }>;
    attempt: KernelAttempt;
    result: ResultRecord;
    checkpoint: AttemptCheckpoint;
    bundle: DefinitionBundle;
    evaluated: EvaluatedKernelResult;
    default_plan: () => Promise<OrdinaryKernelSettlementPlan>;
  }): Promise<OrdinaryKernelSettlementPlan>;
}

export type OrdinaryKernelStep =
  | { disposition: "idle" }
  | {
    disposition: "external_boundary";
    leased: LeasedAttemptView;
    stage_kind: "effect" | "wait";
  }
  | {
    disposition: "settled" | "result_pending" | "retried" | "terminal";
    pipeline_run_id: string;
    attempt_id: string;
    stage_id: string;
    run_status: KernelRun["status"];
    next_stage_id: string | null;
  };

export interface OrdinaryKernelRunControlResult {
  disposition: "consumed" | "stale";
  run: KernelRun;
}

function transitionId(kind: string, identity: unknown): string {
  return `${kind}-${digestCanonicalJson(identity).slice(0, 48)}`;
}

function stageFor(view: ReductionView, stageId: string): CompiledPipelineStage {
  const stage = view.manifest.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new Error(`compiled manifest does not contain stage ${stageId}`);
  return stage;
}

function mapWith<T extends { id: string }>(
  existing: ReadonlyMap<string, T>,
  addition: T,
): ReadonlyMap<string, T> {
  if (existing.has(addition.id)) throw new Error(`aggregate already contains ${addition.id}`);
  return new Map([...existing, [addition.id, addition]]);
}

function sameCheckpoint(left: AttemptCheckpoint, right: AttemptCheckpoint): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function nextStageId(input: {
  view: ReductionView;
  stage: CompiledPipelineStage;
  outcome: string;
}): string | null {
  return kernelSuccessorStageId({
    manifest: input.view.manifest,
    run: input.view.run,
    stage: input.stage,
    outcome: input.outcome,
  });
}

function controlLifecycleDisposition(
  run: KernelRun,
  desiredOutcome: "canceled" | "superseded",
): OrdinaryKernelRunControlResult["disposition"] | null {
  const stageId = run.cursor.stage_id;
  if (stageId === null) return null;
  for (const outcome of PIPELINE_TERMINAL_OUTCOMES) {
    if (stageId === runtimeStopStageId(outcome) || stageId === runtimeCleanupStageId(outcome)) {
      return outcome === desiredOutcome ? "consumed" : "stale";
    }
  }
  return null;
}

function staleControlTransition(error: unknown): boolean {
  return error instanceof Error &&
    /stale run or cursor version|stale attempt version|compare-and-set failed/.test(error.message);
}

function deterministicControlAttemptId(run: KernelRun): string | null {
  const completed = new Set(run.cursor.completed_scope_keys);
  return run.cursor.frontier
    .filter((member) =>
      run.active_attempt_versions[member.attempt_id] !== undefined &&
      member.depends_on.every((dependency) => completed.has(dependency)))
    .map(({ attempt_id }) => attempt_id)
    .sort(compareCodeUnits)[0] ?? null;
}

export class OrdinaryKernelCoordinator {
  readonly #store: OrdinaryKernelStore;
  readonly #bundles: KernelDefinitionBundlePort;
  readonly #runtime: KernelRuntimePort;
  readonly #runtimeSessions: KernelRuntimeSessionBindingPort;
  readonly #evaluators: KernelEvaluatorRegistry;
  readonly #settlementPlanner: OrdinaryKernelSettlementPlanner | null;
  readonly #attemptLeaseDurationMs: number;
  readonly #now: () => string;

  constructor(input: {
    store: OrdinaryKernelStore;
    definition_bundles: KernelDefinitionBundlePort;
    runtime: KernelRuntimePort;
    runtime_sessions: KernelRuntimeSessionBindingPort;
    evaluators?: KernelEvaluatorRegistry;
    settlement_planner?: OrdinaryKernelSettlementPlanner;
    attempt_lease_duration_ms: number;
    now?: () => string;
  }) {
    if (!Number.isSafeInteger(input.attempt_lease_duration_ms) || input.attempt_lease_duration_ms < 1) {
      throw new Error("attempt lease duration must be a positive integer number of milliseconds");
    }
    this.#store = input.store;
    this.#bundles = input.definition_bundles;
    this.#runtime = input.runtime;
    this.#runtimeSessions = input.runtime_sessions;
    this.#evaluators = input.evaluators ?? new KernelEvaluatorRegistry();
    this.#settlementPlanner = input.settlement_planner ?? null;
    this.#attemptLeaseDurationMs = input.attempt_lease_duration_ms;
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  async leaseAndExecuteNext(request: AttemptLeaseRequest): Promise<OrdinaryKernelStep> {
    const leased = await this.#store.leaseNextEligibleAttempt(request);
    if (!leased) return { disposition: "idle" };
    return this.executeLeasedAttempt(leased);
  }

  async requestRunControl(input: {
    pipeline_run_id: string;
    action: "stop" | "supersede";
    reason: string;
  }): Promise<OrdinaryKernelRunControlResult> {
    if (input.action !== "stop" && input.action !== "supersede") {
      throw new Error("run control action must be stop or supersede");
    }
    const reason = input.reason.trim();
    if (reason.length < 1 || reason.length > 1_500 || reason.includes("\0")) {
      throw new Error("run control reason must contain between 1 and 1500 safe characters");
    }
    const desiredOutcome = input.action === "stop" ? "canceled" : "superseded";
    let aggregate = await this.#load(input.pipeline_run_id, null);
    if (aggregate.run.status !== "pending" && aggregate.run.status !== "running") {
      return { disposition: "stale", run: aggregate.run };
    }
    const lifecycleDisposition = controlLifecycleDisposition(aggregate.run, desiredOutcome);
    if (lifecycleDisposition !== null) {
      return { disposition: lifecycleDisposition, run: aggregate.run };
    }
    const attemptId = deterministicControlAttemptId(aggregate.run);
    if (!attemptId) throw new Error("active pipeline run has no deterministic control Attempt");
    const view = await this.#load(input.pipeline_run_id, attemptId);
    if (view.run.status !== "pending" && view.run.status !== "running") {
      return { disposition: "stale", run: view.run };
    }
    const attempt = view.current_attempt;
    if (!attempt || view.run.active_attempt_versions[attempt.id] === undefined) {
      throw new Error("run control could not load its deterministic active Attempt");
    }
    const prepared = await this.#prepareTerminalTransition({
      view,
      outcome: desiredOutcome,
      reason,
    });
    const command: KernelCommand = input.action === "stop"
      ? {
        type: "stop",
        command_id: transitionId("run-control", {
          pipeline_run_id: view.run.id,
          action: input.action,
          attempt_id: attempt.id,
          decision_id: prepared.decision.id,
        }),
        decision_record_id: prepared.decision.id,
        reason,
        resource_disposition: prepared.resource_disposition,
      }
      : {
        type: "supersede",
        command_id: transitionId("run-control", {
          pipeline_run_id: view.run.id,
          action: input.action,
          attempt_id: attempt.id,
          decision_id: prepared.decision.id,
        }),
        decision_record_id: prepared.decision.id,
        reason,
        resource_disposition: prepared.resource_disposition,
      };
    try {
      await this.#apply({
        ...prepared.exact,
        records: mapWith(prepared.exact.records, prepared.decision),
        checkpoints: new Map(),
      }, command);
    } catch (error) {
      if (!staleControlTransition(error)) throw error;
      aggregate = await this.#load(input.pipeline_run_id, null);
      if (aggregate.run.status !== "pending" && aggregate.run.status !== "running") {
        return { disposition: "stale", run: aggregate.run };
      }
      const racedDisposition = controlLifecycleDisposition(aggregate.run, desiredOutcome);
      if (racedDisposition !== null) {
        return { disposition: racedDisposition, run: aggregate.run };
      }
      throw error;
    }
    aggregate = await this.#load(input.pipeline_run_id, null);
    return { disposition: "consumed", run: aggregate.run };
  }

  async executeLeasedAttempt(leased: LeasedAttemptView): Promise<OrdinaryKernelStep> {
    let view = await this.#load(leased.run_id, leased.attempt.id);
    const stage = stageFor(view, leased.attempt.scope.stage_id);
    if (stage.kind === "effect" || stage.kind === "wait") {
      // External stages return the untouched lease to the boundary worker;
      // publication and provider waits never masquerade as executable work.
      return { disposition: "external_boundary", leased, stage_kind: stage.kind };
    }

    if (!leased.lease.started) {
      const start: KernelCommand = {
        type: "start",
        command_id: transitionId("start", { attempt: leased.attempt.id, lease: leased.lease.id }),
        attempt_id: leased.attempt.id,
        lease_id: leased.lease.id,
      };
      await this.#apply(view, start);
      view = await this.#load(leased.run_id, leased.attempt.id);
    }
    const attempt = view.current_attempt!;
    if (attempt.lease?.purpose === "result_correction" && (
      attempt.result_correction_count > view.run.result_correction_limit ||
      attempt.native_session_id === null ||
      attempt.result_correction_deadline === null ||
      attempt.result_correction_deadline <= this.#now()
    )) {
      return this.#terminal(view, "needs_human", "result_correction_unavailable_or_exhausted");
    }
    const bundle = await this.#bundles.resolveExactDefinitionBundle({
      pipeline_run_id: view.run.id,
      definition_bundle_hash: view.run.definition_bundle_hash,
    });

    if (attempt.lease?.purpose === "result_correction") {
      if (!attempt.checkpoint_id) throw new Error("result correction has no persisted checkpoint");
      const correctionView = await this.#load(
        view.run.id,
        attempt.id,
        [],
        [attempt.checkpoint_id],
      );
      const checkpoint = correctionView.checkpoints.get(attempt.checkpoint_id)!;
      const request = buildKernelResultCorrectionRequest({
        attempt,
        checkpoint,
        bundle,
        manifest: view.manifest,
      });
      const outcome = await this.#runtime.correctResult(
        request,
        this.#leaseCallbacks(attempt),
      );
      return this.#handleCorrectionOutcome({
        view: await this.#load(view.run.id, attempt.id),
        bundle,
        checkpoint,
        outcome,
      });
    }

    const persistedInputs = await this.#store.loadAttemptRequestInputs({
      pipeline_run_id: view.run.id,
      attempt_id: attempt.id,
    });
    const actionInputs = {
      task_prompt: persistedInputs.task_prompt,
      context: exactKernelContext(persistedInputs.context),
    };
    const request = buildKernelWorkActionRequest({
      attempt,
      bundle,
      manifest: view.manifest,
      action_inputs: actionInputs,
    });
    const lease = attempt.lease;
    if (!lease?.started) throw new Error("ordinary execution lost its started lease");
    const outcome = await this.#runtime.executeWork(request, {
      ...this.#leaseCallbacks(attempt),
      on_session: stage.kind === "agent"
        ? async (nativeSessionId) => {
          await this.#runtimeSessions.bindRuntimeSession({
            pipeline_run_id: attempt.pipeline_run_id,
            attempt_id: attempt.id,
            request_hash: attempt.request_hash,
            definition_bundle_hash: attempt.definition_bundle_hash,
            input_subject: attempt.input_subject,
            lease_id: lease.id,
            worker_id: lease.worker_id,
            lease_purpose: lease.purpose,
            work_retry_ordinal: attempt.work_retry_ordinal,
            result_correction_count: attempt.result_correction_count,
            native_session_id: nativeSessionId,
          });
        }
        : async () => {
          throw new Error(`command stage ${stage.id} cannot bind an agent runtime session`);
        },
    });
    return this.#handleWorkOutcome({
      view: await this.#load(view.run.id, attempt.id),
      bundle,
      outcome,
    });
  }

  #leaseCallbacks(attempt: KernelAttempt): KernelRuntimeLeaseCallbacks {
    const lease = attempt.lease;
    if (!lease?.started) throw new Error("ordinary execution lost its started lease");
    return {
      heartbeat_interval_ms: Math.max(1, Math.floor(this.#attemptLeaseDurationMs / 3)),
      on_heartbeat: async () => {
        const now = Date.parse(this.#now());
        if (!Number.isFinite(now)) throw new Error("attempt lease heartbeat clock is invalid");
        const expiresAt = new Date(now + this.#attemptLeaseDurationMs).toISOString();
        const renewed = await this.#store.renewAttemptLease({
          attempt_id: attempt.id,
          lease_id: lease.id,
          worker_id: lease.worker_id,
          expires_at: expiresAt,
        });
        if (
          renewed.id !== lease.id || renewed.worker_id !== lease.worker_id ||
          renewed.purpose !== lease.purpose || renewed.started !== true ||
          renewed.expires_at !== expiresAt
        ) throw new Error("attempt lease heartbeat returned a mismatched fence");
      },
    };
  }

  async #handleWorkOutcome(input: {
    view: ReductionView;
    bundle: Awaited<ReturnType<KernelDefinitionBundlePort["resolveExactDefinitionBundle"]>>;
    outcome: KernelRuntimeOutcome;
  }): Promise<OrdinaryKernelStep> {
    const attempt = input.view.current_attempt!;
    if (input.outcome.state === "work_failed") {
      if (
        input.outcome.retryable &&
        attempt.work_retry_ordinal < input.view.run.work_retry_limit
      ) {
        await this.#apply(input.view, {
          type: "retry",
          command_id: transitionId("retry", {
            attempt: attempt.id,
            ordinal: attempt.work_retry_ordinal + 1,
          }),
          attempt_id: attempt.id,
        });
        return this.#step("retried", await this.#load(input.view.run.id, attempt.id));
      }
      return this.#terminal(input.view, "failed", input.outcome.reason);
    }

    if (input.outcome.checkpoint !== null) {
      await this.#completeWork(input.view, input.outcome.checkpoint);
    }
    let completed = await this.#load(input.view.run.id, attempt.id);
    if (input.outcome.state === "needs_human") {
      return this.#terminal(completed, "needs_human", input.outcome.reason);
    }
    if (input.outcome.state === "result_pending") {
      if (completed.current_attempt?.status !== "work_complete") {
        throw new Error("result_pending did not preserve completed work");
      }
      await this.#apply(
        await this.#load(
          completed.run.id,
          attempt.id,
          [],
          [input.outcome.checkpoint.id],
        ),
        {
          type: "result_pending",
          command_id: transitionId("result-pending", {
            attempt: attempt.id,
            candidate: input.outcome.candidate_hash,
          }),
          attempt_id: attempt.id,
          candidate_hash: input.outcome.candidate_hash,
          diagnostics: input.outcome.diagnostics,
          correction_deadline: input.outcome.correction_deadline,
        },
      );
      completed = await this.#load(completed.run.id, attempt.id);
      return this.#step("result_pending", completed);
    }
    return this.#recordEvaluateAndSettle({
      view: completed,
      bundle: input.bundle,
      result: input.outcome.result,
    });
  }

  async #handleCorrectionOutcome(input: {
    view: ReductionView;
    bundle: Awaited<ReturnType<KernelDefinitionBundlePort["resolveExactDefinitionBundle"]>>;
    checkpoint: AttemptCheckpoint;
    outcome: KernelRuntimeOutcome;
  }): Promise<OrdinaryKernelStep> {
    const attempt = input.view.current_attempt!;
    if (input.outcome.state === "work_complete") {
      if (!sameCheckpoint(input.checkpoint, input.outcome.checkpoint)) {
        throw new Error("result correction changed the locked work checkpoint");
      }
      return this.#recordEvaluateAndSettle({
        view: input.view,
        bundle: input.bundle,
        result: input.outcome.result,
      });
    }
    if (input.outcome.state === "result_pending") {
      if (!sameCheckpoint(input.checkpoint, input.outcome.checkpoint)) {
        throw new Error("result correction changed the locked work checkpoint");
      }
      if (attempt.result_correction_count >= input.view.run.result_correction_limit) {
        return this.#terminal(
          input.view,
          "needs_human",
          "result_correction_budget_exhausted",
        );
      }
      await this.#apply(
        await this.#load(input.view.run.id, attempt.id, [], [input.checkpoint.id]),
        {
          type: "result_pending",
          command_id: transitionId("result-pending", {
            attempt: attempt.id,
            candidate: input.outcome.candidate_hash,
            correction: attempt.result_correction_count,
          }),
          attempt_id: attempt.id,
          candidate_hash: input.outcome.candidate_hash,
          diagnostics: input.outcome.diagnostics,
          correction_deadline: input.outcome.correction_deadline,
        },
      );
      return this.#step("result_pending", await this.#load(input.view.run.id, attempt.id));
    }
    const reason = input.outcome.state === "needs_human"
      ? input.outcome.reason
      : input.outcome.state === "work_failed"
        ? input.outcome.reason
        : "result_correction_did_not_produce_a_semantic_candidate";
    return this.#terminal(input.view, "needs_human", reason);
  }

  async #completeWork(view: ReductionView, checkpoint: AttemptCheckpoint): Promise<void> {
    const attempt = view.current_attempt!;
    const checkpointView: ReductionView = {
      ...view,
      checkpoints: mapWith(view.checkpoints, checkpoint),
    };
    await this.#apply(checkpointView, {
      type: "work_complete",
      command_id: transitionId("work-complete", {
        attempt: attempt.id,
        checkpoint: checkpoint.id,
      }),
      attempt_id: attempt.id,
      checkpoint_id: checkpoint.id,
      verified_output_subject: checkpoint.output_subject,
    });
  }

  async #recordEvaluateAndSettle(input: {
    view: ReductionView;
    bundle: Awaited<ReturnType<KernelDefinitionBundlePort["resolveExactDefinitionBundle"]>>;
    result: KernelVerifiedActionResult;
  }): Promise<OrdinaryKernelStep> {
    const attempt = input.view.current_attempt!;
    if (!attempt.checkpoint_id) throw new Error("authoritative result requires a verified checkpoint");
    const stage = stageFor(input.view, attempt.scope.stage_id);
    const selected = selectKernelAction({
      bundle: input.bundle,
      manifest: input.view.manifest,
      attempt,
    });
    let record: ResultRecord;
    let evaluated: EvaluatedKernelResult;
    if (stage.kind === "agent") {
      if (input.result.kind !== "semantic" || selected.action.kind !== "agent") {
        throw new Error(`agent stage ${stage.id} did not return a semantic candidate`);
      }
      const evalEntry = selected.action.definition_entries.find(
        (entry) => entry.definition_kind === "eval" && entry.definition_id === stage.eval,
      );
      if (!evalEntry) throw new Error(`sealed action omitted eval ${stage.eval}`);
      const evaluation = validateEvalDefinition(evalEntry.normalized_payload, {
        source: `definition_bundle.eval:${stage.eval}`,
      }).value;
      record = createSemanticResultRecord({
        attempt,
        staged: input.result.candidate,
        evaluation,
        created_at: this.#now(),
      });
      evaluated = this.#evaluators.evaluateSemantic({ stage, evaluation, result: record });
    } else if (stage.kind === "command") {
      if (input.result.kind !== "command") {
        throw new Error(`command stage ${stage.id} did not return executor command evidence`);
      }
      record = createCommandResultRecord({
        attempt,
        result: input.result,
        expected_command_id: stage.command,
        created_at: this.#now(),
      });
      evaluated = this.#evaluators.evaluateCommand({ stage, result: record });
    } else {
      throw new Error(`stage ${stage.id} is not an ordinary executable action`);
    }

    const recordView = await this.#load(
      input.view.run.id,
      attempt.id,
      [],
      [attempt.checkpoint_id],
    );
    await this.#apply({ ...recordView, records: mapWith(recordView.records, record) }, {
      type: "record",
      command_id: transitionId("record", { attempt: attempt.id, record: record.id }),
      attempt_id: attempt.id,
      record_id: record.id,
    });

    const checkpoint = recordView.checkpoints.get(attempt.checkpoint_id)!;
    const recorded = await this.#load(input.view.run.id, attempt.id, [record.id]);
    const recordedAttempt = recorded.current_attempt!;
    let defaultPlan: Promise<OrdinaryKernelSettlementPlan> | null = null;
    const deriveDefaultPlan = (): Promise<OrdinaryKernelSettlementPlan> => {
      defaultPlan ??= (async () => {
        const decision = createPipelineDecisionRecord({
          attempt: recordedAttempt,
          result: record,
          evaluated,
          created_at: this.#now(),
        });
        const targetStageId = nextStageId({ view: recorded, stage, outcome: evaluated.outcome });
        const nextAttempts = targetStageId === null
          ? []
          : [await this.#nextAttempt({
            view: recorded,
            current: recordedAttempt,
            current_result: record,
            decision,
            bundle: input.bundle,
            target_stage_id: targetStageId,
          })];
        return {
          decision,
          outcome: evaluated.outcome,
          input_records: [record],
          checkpoints: [],
          next_attempts: nextAttempts,
        };
      })();
      return defaultPlan;
    };
    const settlement = this.#settlementPlanner === null
      ? await deriveDefaultPlan()
      : await this.#settlementPlanner.plan({
        view: recorded,
        stage,
        attempt: recordedAttempt,
        result: record,
        checkpoint,
        bundle: input.bundle,
        evaluated,
        default_plan: deriveDefaultPlan,
      });
    this.#assertSettlementPlan(recorded, stage, recordedAttempt, record, settlement);
    const settleRecords = new Map<string, ExecutionRecord>(settlement.input_records
      .map((candidate) => [candidate.id, candidate]));
    settleRecords.set(settlement.decision.id, settlement.decision);
    const settleCheckpoints = new Map(settlement.checkpoints
      .map((candidate) => [candidate.id, candidate]));
    await this.#apply({
      ...recorded,
      records: settleRecords,
      checkpoints: settleCheckpoints,
    }, {
      type: "settle",
      command_id: transitionId("settle", {
        attempt: recordedAttempt.id,
        decision: settlement.decision.id,
      }),
      attempt_id: recordedAttempt.id,
      decision_record_id: settlement.decision.id,
      outcome: settlement.outcome,
      next_attempts: settlement.next_attempts,
      ...(settlement.next_dependencies === undefined
        ? {}
        : { next_dependencies: settlement.next_dependencies }),
    });
    const finalView = await this.#load(recorded.run.id, null);
    return this.#step("settled", finalView, recordedAttempt.id, stage.id);
  }

  #assertSettlementPlan(
    view: ReductionView,
    stage: CompiledPipelineStage,
    attempt: KernelAttempt,
    currentResult: ResultRecord,
    plan: OrdinaryKernelSettlementPlan,
  ): void {
    if (
      plan.decision.pipeline_run_id !== view.run.id ||
      !stage.on[plan.outcome] ||
      !plan.decision.input_record_ids.includes(currentResult.id)
    ) throw new Error("ordinary settlement planner returned an unauthorized transition");
    const records = [...plan.input_records]
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const recordIds = records.map(({ id }) => id);
    const decisionInputs = [...plan.decision.input_record_ids]
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    if (
      new Set(recordIds).size !== recordIds.length ||
      canonicalJson(recordIds) !== canonicalJson(decisionInputs) ||
      records.some((record) => record.pipeline_run_id !== view.run.id)
    ) throw new Error("ordinary settlement planner did not provide its exact decision inputs");
    const checkpointIds = plan.checkpoints.map(({ id }) => id);
    if (
      new Set(checkpointIds).size !== checkpointIds.length ||
      plan.checkpoints.some((candidate) =>
        candidate.pipeline_run_id !== view.run.id ||
        candidate.definition_bundle_hash !== attempt.definition_bundle_hash)
    ) throw new Error("ordinary settlement planner returned widened checkpoint evidence");
  }

  async #nextAttempt(input: {
    view: ReductionView;
    current: KernelAttempt;
    current_result: ResultRecord;
    decision: DecisionRecord;
    bundle: Awaited<ReturnType<KernelDefinitionBundlePort["resolveExactDefinitionBundle"]>>;
    target_stage_id: string;
  }): Promise<KernelAttempt> {
    const target = stageFor(input.view, input.target_stage_id);
    const workInputs = await this.#store.loadAttemptRequestInputs({
      pipeline_run_id: input.view.run.id,
      attempt_id: input.current.id,
    });
    const successorSubject = input.current.output_subject ?? input.current.input_subject;
    const candidates = [...workInputs.context.checkpoints.values()]
      .filter((checkpoint) => checkpoint.output_subject === successorSubject);
    if (input.current.checkpoint_id && input.current.output_subject === successorSubject) {
      const exact = await this.#load(
        input.view.run.id,
        input.current.id,
        [],
        [input.current.checkpoint_id],
      );
      candidates.unshift(exact.checkpoints.get(input.current.checkpoint_id)!);
    }
    const byId = new Map(candidates.map((checkpoint) => [checkpoint.id, checkpoint]));
    const checkpoints = [...byId.values()];
    if (checkpoints.length > 1) {
      throw new Error(`successor ${target.id} has ambiguous checkpoint materialization for ${successorSubject}`);
    }
    return deriveKernelSuccessorAttempt({
      view: input.view,
      current: input.current,
      result: input.current_result,
      decision: input.decision,
      bundle: input.bundle,
      target_scope: { kind: "stage", stage_id: target.id },
      request_inputs: workInputs,
      checkpoint_override: checkpoints,
    });
  }

  async #terminal(
    view: ReductionView,
    outcome: "needs_human" | "failed",
    reason: string,
  ): Promise<OrdinaryKernelStep> {
    const attempt = view.current_attempt;
    if (!attempt) throw new Error("attempt terminal transition requires its exact aggregate");
    const prepared = await this.#prepareTerminalTransition({ view, outcome, reason });
    await this.#apply({
      ...prepared.exact,
      records: mapWith(prepared.exact.records, prepared.decision),
      checkpoints: new Map(),
    }, {
      type: outcome === "needs_human" ? "needs_human" : "fail",
      command_id: transitionId(outcome, { attempt: attempt.id, decision: prepared.decision.id }),
      attempt_id: attempt.id,
      decision_record_id: prepared.decision.id,
      reason,
      resource_disposition: prepared.resource_disposition,
    });
    return this.#step("terminal", await this.#load(view.run.id, null), attempt.id, attempt.scope.stage_id);
  }

  async #prepareTerminalTransition(input: {
    view: ReductionView;
    outcome: PipelineTerminalOutcome;
    reason: string;
  }): Promise<{
    exact: ReductionView;
    decision: DecisionRecord;
    resource_disposition: Extract<KernelCommand, {
      type: "needs_human" | "fail" | "stop" | "supersede";
    }>["resource_disposition"];
  }> {
    const { view } = input;
    const attempt = view.current_attempt;
    if (!attempt) throw new Error("terminal transition requires its exact active Attempt");
    const workInputs = await this.#store.loadAttemptRequestInputs({
      pipeline_run_id: view.run.id,
      attempt_id: attempt.id,
    });
    const resourceDeliveries = exactKernelRuntimeCleanupDeliveries(
      [...workInputs.context.records.values()],
    );
    const decision = createPipelineDecisionRecord({
      attempt,
      result: null,
      additional_input_records: resourceDeliveries ?? [],
      evaluated: {
        evaluator: "core/operational-outcome@1",
        outcome: input.outcome,
        reason: input.reason,
      },
      created_at: this.#now(),
    });
    let exact: ReductionView;
    let resourceDisposition: Extract<KernelCommand, {
      type: "needs_human" | "fail" | "stop" | "supersede";
    }>["resource_disposition"];
    if (resourceDeliveries === null) {
      if (
        attempt.scope.stage_id !== RUNTIME_PROVISION_STAGE_ID ||
        attempt.checkpoint_id !== null || Object.keys(view.run.active_effect_versions).length !== 0
      ) throw new Error("terminal transition has no exact runtime resource or pre-provision proof");
      exact = await this.#load(view.run.id, attempt.id);
      resourceDisposition = { kind: "pre_provision" };
    } else {
      const bundle = await this.#bundles.resolveExactDefinitionBundle({
        pipeline_run_id: view.run.id,
        definition_bundle_hash: view.run.definition_bundle_hash,
      });
      const cleanupAttempt = deriveKernelTerminalCleanupAttempt({
        view,
        current: attempt,
        decision,
        bundle,
        outcome: input.outcome,
        task_prompt: workInputs.task_prompt,
        runtime_delivery_records: resourceDeliveries,
      });
      exact = await this.#load(
        view.run.id,
        attempt.id,
        resourceDeliveries.map(({ id }) => id),
      );
      resourceDisposition = {
        kind: "cleanup",
        runtime_delivery_record_ids: resourceDeliveries.map(({ id }) => id).sort(),
        cleanup_attempt: cleanupAttempt,
      };
    }
    return { exact, decision, resource_disposition: resourceDisposition };
  }

  async #load(
    runId: string,
    attemptId: string | null,
    recordIds: readonly string[] = [],
    checkpointIds: readonly string[] = [],
  ): Promise<ReductionView> {
    return this.#store.loadExactReductionView({
      pipeline_run_id: runId,
      attempt_id: attemptId,
      record_ids: recordIds,
      checkpoint_ids: checkpointIds,
    });
  }

  async #apply(view: ReductionView, command: KernelCommand): Promise<AtomicTransitionBundle> {
    const transition = reduceKernelCommand({
      manifest: view.manifest,
      run: view.run,
      current_attempt: view.current_attempt,
      records: view.records,
      checkpoints: view.checkpoints,
      command,
    });
    await this.#store.applyAtomicTransition(transition);
    return transition;
  }

  #step(
    disposition: Extract<OrdinaryKernelStep, { run_status: KernelRun["status"] }>["disposition"],
    view: ReductionView,
    attemptId = view.current_attempt?.id ?? "settled",
    stageId = view.current_attempt?.scope.stage_id ?? view.run.cursor.stage_id ?? "terminal",
  ): OrdinaryKernelStep {
    return {
      disposition,
      pipeline_run_id: view.run.id,
      attempt_id: attemptId,
      stage_id: stageId,
      run_status: view.run.status,
      next_stage_id: view.run.cursor.stage_id,
    };
  }
}
