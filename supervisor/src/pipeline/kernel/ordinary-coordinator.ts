import {
  canonicalJson,
  digestCanonicalJson,
  validateEvalDefinition,
  type AttemptCheckpoint,
  type CompiledPipelineStage,
  type DecisionRecord,
  type ExecutionRecord,
  type ResultRecord,
} from "@openthrottle/contracts";
import type {
  KernelRuntimeOutcome,
  KernelRuntimePort,
  KernelVerifiedActionResult,
} from "../../runtime/kernel-contracts.js";
import {
  buildKernelResultCorrectionRequest,
  buildKernelWorkActionRequest,
  createPendingStageAttempt,
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

export interface OrdinaryKernelStore extends
  KernelReductionPort,
  KernelAttemptLeasePort,
  KernelAttemptRequestPort {}

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
  const transition = input.stage.on[input.outcome];
  if (!transition) throw new Error(`stage ${input.stage.id} has no transition for ${input.outcome}`);
  if (transition.terminal !== undefined) return null;
  if (transition.to === undefined) throw new Error("pipeline transition has no destination");
  if (transition.max_reentries !== undefined) {
    const edge = `${input.stage.id}:${input.outcome}:${transition.to}`;
    if ((input.view.run.cursor.reentries[edge] ?? 0) >= transition.max_reentries) return null;
  }
  return transition.to;
}

function nextAttemptId(input: {
  run: KernelRun;
  from_attempt_id: string;
  decision_id: string;
  stage_id: string;
}): string {
  return `attempt-${digestCanonicalJson({
    schema: "openthrottle.ordinary-next-attempt/v1",
    pipeline_run_id: input.run.id,
    from_attempt_id: input.from_attempt_id,
    decision_id: input.decision_id,
    stage_id: input.stage_id,
    next_cursor_version: input.run.cursor.version + 1,
  }).slice(0, 48)}`;
}

export class OrdinaryKernelCoordinator {
  readonly #store: OrdinaryKernelStore;
  readonly #bundles: KernelDefinitionBundlePort;
  readonly #runtime: KernelRuntimePort;
  readonly #evaluators: KernelEvaluatorRegistry;
  readonly #now: () => string;

  constructor(input: {
    store: OrdinaryKernelStore;
    definition_bundles: KernelDefinitionBundlePort;
    runtime: KernelRuntimePort;
    evaluators?: KernelEvaluatorRegistry;
    now?: () => string;
  }) {
    this.#store = input.store;
    this.#bundles = input.definition_bundles;
    this.#runtime = input.runtime;
    this.#evaluators = input.evaluators ?? new KernelEvaluatorRegistry();
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  async leaseAndExecuteNext(request: AttemptLeaseRequest): Promise<OrdinaryKernelStep> {
    const leased = await this.#store.leaseNextEligibleAttempt(request);
    if (!leased) return { disposition: "idle" };
    return this.executeLeasedAttempt(leased);
  }

  async executeLeasedAttempt(leased: LeasedAttemptView): Promise<OrdinaryKernelStep> {
    let view = await this.#load(leased.run_id, leased.attempt.id);
    const stage = stageFor(view, leased.attempt.scope.stage_id);
    if (stage.kind === "effect" || stage.kind === "wait") {
      // U10 receives the same unstarted lease; U7 never disguises publication
      // or provider waiting as an agent/command action.
      return { disposition: "external_boundary", leased, stage_kind: stage.kind };
    }

    const start: KernelCommand = {
      type: "start",
      command_id: transitionId("start", { attempt: leased.attempt.id, lease: leased.lease.id }),
      attempt_id: leased.attempt.id,
      lease_id: leased.lease.id,
    };
    await this.#apply(view, start);
    view = await this.#load(leased.run_id, leased.attempt.id);
    const attempt = view.current_attempt!;
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
      const outcome = await this.#runtime.correctResult(request);
      return this.#handleCorrectionOutcome({ view, bundle, checkpoint, outcome });
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
    const outcome = await this.#runtime.executeWork(request);
    return this.#handleWorkOutcome({ view, bundle, outcome });
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

    const recorded = await this.#load(input.view.run.id, attempt.id, [record.id]);
    const recordedAttempt = recorded.current_attempt!;
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
    const settleRecords = new Map<string, ExecutionRecord>([
      ...recorded.records,
      [decision.id, decision],
    ]);
    await this.#apply({ ...recorded, records: settleRecords }, {
      type: "settle",
      command_id: transitionId("settle", {
        attempt: recordedAttempt.id,
        decision: decision.id,
      }),
      attempt_id: recordedAttempt.id,
      decision_record_id: decision.id,
      outcome: evaluated.outcome,
      next_attempts: nextAttempts,
    });
    const finalView = await this.#load(recorded.run.id, null);
    return this.#step("settled", finalView, recordedAttempt.id, stage.id);
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
    const id = nextAttemptId({
      run: input.view.run,
      from_attempt_id: input.current.id,
      decision_id: input.decision.id,
      stage_id: target.id,
    });
    const workInputs = await this.#store.loadAttemptRequestInputs({
      pipeline_run_id: input.view.run.id,
      attempt_id: input.current.id,
    });
    const records: ExecutionRecord[] = [input.current_result, input.decision]
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const checkpoints: AttemptCheckpoint[] = [];
    if (
      target.kind === "agent" && target.repository_authority === "inspect" &&
      input.current.repository_authority === "edit" && input.current.checkpoint_id
    ) {
      const exact = await this.#load(
        input.view.run.id,
        input.current.id,
        [],
        [input.current.checkpoint_id],
      );
      checkpoints.push(exact.checkpoints.get(input.current.checkpoint_id)!);
    }
    return createPendingStageAttempt({
      id,
      pipeline_run_id: input.view.run.id,
      stage_id: target.id,
      input_subject: input.current.repository_authority === "edit"
        ? input.current.output_subject!
        : input.view.run.current_subject,
      bundle: input.bundle,
      manifest: input.view.manifest,
      action_inputs: {
        task_prompt: workInputs.task_prompt,
        context: { records, checkpoints },
      },
    });
  }

  async #terminal(
    view: ReductionView,
    outcome: "needs_human" | "failed",
    reason: string,
  ): Promise<OrdinaryKernelStep> {
    const attempt = view.current_attempt;
    if (!attempt) throw new Error("attempt terminal transition requires its exact aggregate");
    const evaluated: EvaluatedKernelResult = {
      evaluator: "core/operational-outcome@1",
      outcome,
      reason,
    };
    const decision = createPipelineDecisionRecord({
      attempt,
      result: null,
      evaluated,
      created_at: this.#now(),
    });
    await this.#apply({
      ...view,
      records: new Map([[decision.id, decision]]),
      checkpoints: new Map(),
    }, {
      type: outcome === "needs_human" ? "needs_human" : "fail",
      command_id: transitionId(outcome, { attempt: attempt.id, decision: decision.id }),
      attempt_id: attempt.id,
      decision_record_id: decision.id,
      reason,
    });
    return this.#step("terminal", await this.#load(view.run.id, null), attempt.id, attempt.scope.stage_id);
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
