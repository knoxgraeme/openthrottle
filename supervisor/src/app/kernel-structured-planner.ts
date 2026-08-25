import {
  RUNTIME_PROVISION_STAGE_ID,
  canonicalJson,
  compareCodeUnits,
  type AttemptCheckpoint,
  type ExecutionRecord,
} from "@openthrottle/contracts";
import type {
  OrdinaryKernelSettlementPlan,
  OrdinaryKernelSettlementPlanner,
} from "../pipeline/kernel/ordinary-coordinator.js";
import { createPipelineDecisionRecord } from "../pipeline/kernel/evaluator-registry.js";
import type {
  KernelAttemptRequestInputs,
  KernelAttemptRequestPort,
  KernelExternalSettlementPlan,
  KernelExternalSettlementPlanner,
  KernelStructuredPlanningReadPort,
} from "../pipeline/kernel/ports.js";
import {
  buildStructuredProvisionSettlement,
  compileReviewFanoutFrontier,
  compileStructuredLoopFrontier,
  createBlockingReviewRemediationAttempt,
  createStructuredIntegrationAttempt,
  selectedStructuredReviewPersonas,
  structuredDecisionOutcome,
  structuredIntegrationCheckpointChain,
  type StructuredAcceptedUnitEvidence,
  type StructuredIntegrationEvidence,
} from "../pipeline/kernel/structured-coordinator.js";
import {
  deriveKernelSuccessorAttempt,
  mergeCausalGithubPushContext,
} from "../pipeline/kernel/successor-attempt.js";
import type { KernelAttempt } from "../pipeline/kernel/types.js";
import {
  assertStructuredRequestContextExact,
  assertStructuredSettledEvidence,
  exactStructuredBoundaryCheckpoint,
  exactStructuredDeliveries,
  exactStructuredPromotionDecision,
  exactStructuredRuntimeRecords,
  projectCurrentStructuredEvidence,
  resolveStructuredExecutionPlan,
  settledStructuredActionEvidence,
  structuredPromotionFromActionEvidence,
} from "./kernel-structured-evidence.js";
import {
  boundedStructuredDependencies,
  loadCompletedStructuredWave,
  settleStructuredWaveDecision,
  sortedUniqueStructuredIds,
  structuredBarrierCompletesWithCurrent,
  structuredLoopRoot,
  structuredNextStageId,
  structuredStageFor,
  structuredSuccessorCheckpoints,
  type StructuredLoopStage,
  type StructuredWaveEvidence,
} from "./kernel-structured-wave.js";

const STRUCTURED_PIPELINE_ID = "core/structured";
const UNIT_ENTRY_STAGE_ID = "implement_unit";
const UNIT_ACCEPTANCE_STAGE_ID = "accept_unit";
const UNIT_INTEGRATION_STAGE_ID = "integrate_unit";
const REVIEW_SELECTOR_STAGE_ID = "select_review_personas";
const REVIEW_FANOUT_STAGE_ID = "persona_review";
const REVIEW_VALIDATION_STAGE_ID = "validate_review_findings";
const FINAL_REPAIR_STAGE_ID = "final_repair";

type OrdinaryInput = Parameters<OrdinaryKernelSettlementPlanner["plan"]>[0];
type ExternalInput = Parameters<KernelExternalSettlementPlanner["plan"]>[0];
type StructuredInput = OrdinaryInput | ExternalInput;

export interface KernelStructuredSettlementStore extends
  KernelAttemptRequestPort,
  KernelStructuredPlanningReadPort {}

function isExternalInput(input: StructuredInput): input is ExternalInput {
  return "schedules" in input;
}

function settledStructuredSiblingRecords(
  evidence: readonly StructuredWaveEvidence[],
  currentAttemptId: string,
): ExecutionRecord[] {
  // A divergent wave replaces the current member's transient decision with
  // one aggregate decision. Only sibling decisions already exist durably.
  return evidence.flatMap((source) =>
    source.attempt.id === currentAttemptId ? [] : [source.result, source.decision]
  );
}

function structuredWaveTerminalSettlement(input: {
  ordinary: OrdinaryInput;
  current_attempt: KernelAttempt;
  settlement: ReturnType<typeof settleStructuredWaveDecision>;
  target_stage_id: string;
  request_inputs: KernelAttemptRequestInputs;
  evidence: readonly StructuredWaveEvidence[];
}): OrdinaryKernelSettlementPlan {
  return {
    decision: input.settlement.decision,
    outcome: input.settlement.outcome,
    input_records: input.settlement.input_records,
    checkpoints: [],
    next_attempts: [deriveKernelSuccessorAttempt({
      view: input.ordinary.view,
      current: input.current_attempt,
      result: input.ordinary.result,
      decision: input.settlement.decision,
      bundle: input.ordinary.bundle,
      target_scope: { kind: "stage", stage_id: input.target_stage_id },
      request_inputs: input.request_inputs,
      checkpoint_override: [],
      additional_context_records: settledStructuredSiblingRecords(
        input.evidence,
        input.ordinary.attempt.id,
      ),
    })],
  };
}

/**
 * Production settlement planner for the sealed `core/structured` pipeline.
 * All other pipelines and ordinary stage-scoped transitions retain the stock
 * coordinator plan byte-for-byte.
 */
export class KernelStructuredSettlementPlanner implements
  OrdinaryKernelSettlementPlanner,
  KernelExternalSettlementPlanner {
  readonly #store: KernelStructuredSettlementStore;
  readonly #now: () => string;

  constructor(input: {
    store: KernelStructuredSettlementStore;
    now?: () => string;
  }) {
    this.#store = input.store;
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  plan(input: OrdinaryInput): Promise<OrdinaryKernelSettlementPlan>;
  plan(input: ExternalInput): Promise<KernelExternalSettlementPlan>;
  async plan(
    input: StructuredInput,
  ): Promise<OrdinaryKernelSettlementPlan | KernelExternalSettlementPlan> {
    if (
      input.view.manifest.pipeline_id !== STRUCTURED_PIPELINE_ID ||
      input.view.run.pipeline_id !== STRUCTURED_PIPELINE_ID
    ) {
      return input.default_plan();
    }
    if (input.attempt.scope.stage_id !== input.stage.id) {
      throw new Error("structured settlement stage does not match its Attempt scope");
    }
    return isExternalInput(input)
      ? this.#planExternal(input)
      : this.#planOrdinary(input);
  }

  async #planOrdinary(input: OrdinaryInput): Promise<OrdinaryKernelSettlementPlan> {
    if (input.attempt.scope.kind === "loop_item") return this.#planUnitWave(input);
    if (input.attempt.scope.kind === "fanout_member") return this.#planReviewWave(input);
    if (input.stage.id === REVIEW_SELECTOR_STAGE_ID) return this.#planReviewSelector(input);
    if (input.stage.id === REVIEW_VALIDATION_STAGE_ID) return this.#planReviewValidation(input);
    return input.default_plan();
  }

  async #planExternal(input: ExternalInput): Promise<KernelExternalSettlementPlan> {
    if (
      input.attempt.scope.kind === "stage" &&
      input.stage.kind === "effect" &&
      input.stage.id === RUNTIME_PROVISION_STAGE_ID &&
      input.stage.effect === "core/daytona-provision@1" &&
      (input.evaluated.outcome === "success" || input.evaluated.outcome === "no_change")
    ) {
      const request = await this.#loadRequest(input.attempt);
      const resolvedPlan = resolveStructuredExecutionPlan(request, input.view.manifest.pipeline_id);
      const settlement = buildStructuredProvisionSettlement({
        view: input.view,
        stage: input.stage,
        attempt: input.attempt,
        result: input.result,
        bundle: input.bundle,
        schedules: input.schedules,
        evaluated: input.evaluated,
        task_prompt: request.task_prompt,
        execution_plan: resolvedPlan.plan,
        planning_context_records: resolvedPlan.promotion === null ? [] : [resolvedPlan.promotion],
        created_at: this.#now(),
      });
      return {
        decision: settlement.decision,
        outcome: settlement.outcome,
        next_attempts: settlement.next_attempts,
        next_dependencies: settlement.next_dependencies,
      };
    }
    if (
      input.attempt.scope.kind === "loop_item" && input.stage.kind === "effect" &&
      input.stage.id === UNIT_INTEGRATION_STAGE_ID &&
      input.stage.effect === "core/integrate-unit@1"
    ) {
      if (input.evaluated.outcome === "retryable_infrastructure_failure") {
        const targetId = structuredNextStageId({
          view: input.view,
          stage: input.stage,
          outcome: input.evaluated.outcome,
        });
        if (targetId !== input.stage.id) return input.default_plan();
        const request = await this.#loadRequest(input.attempt);
        const deliveries = exactStructuredDeliveries(input);
        const decision = createPipelineDecisionRecord({
          attempt: input.attempt,
          result: input.result,
          additional_input_records: deliveries,
          evaluated: input.evaluated,
          created_at: this.#now(),
        });
        const promotion = exactStructuredPromotionDecision(request, input.view.manifest.pipeline_id);
        return {
          decision,
          outcome: input.evaluated.outcome,
          next_attempts: [deriveKernelSuccessorAttempt({
            view: input.view,
            current: input.attempt,
            result: input.result,
            decision,
            bundle: input.bundle,
            target_scope: { ...input.attempt.scope, stage_id: input.stage.id },
            request_inputs: request,
            additional_context_records: [
              ...deliveries,
              ...(promotion === null ? [] : [promotion]),
            ],
          })],
        };
      }
      if (input.evaluated.outcome !== "failure") {
        if (input.attempt.output_subject === null) {
          throw new Error("accepted structured integration has no promoted output subject");
        }
        return this.#planIntegration(input);
      }
    }
    return input.default_plan();
  }

  async #loadRequest(attempt: KernelAttempt): Promise<KernelAttemptRequestInputs> {
    const inputs = await this.#store.loadAttemptRequestInputs({
      pipeline_run_id: attempt.pipeline_run_id,
      attempt_id: attempt.id,
    });
    assertStructuredRequestContextExact(attempt, inputs);
    return inputs;
  }

  async #planUnitWave(input: OrdinaryInput): Promise<OrdinaryKernelSettlementPlan> {
    const root = structuredLoopRoot(input);
    const currentDecision = createPipelineDecisionRecord({
      attempt: input.attempt,
      result: input.result,
      evaluated: input.evaluated,
      created_at: this.#now(),
    });
    if (!structuredBarrierCompletesWithCurrent(input)) {
      return {
        decision: currentDecision,
        outcome: input.evaluated.outcome,
        input_records: [input.result],
        checkpoints: [],
        next_attempts: [],
      };
    }
    const currentRequest = await this.#loadRequest(input.attempt);
    const evidence = await loadCompletedStructuredWave({
      store: this.#store,
      ordinary: input,
      current_decision: currentDecision,
      current_request: currentRequest,
    });
    const settlement = settleStructuredWaveDecision({
      view: input.view,
      stage: input.stage,
      current_attempt: input.attempt,
      current_result: input.result,
      current_decision: currentDecision,
      evidence,
      created_at: this.#now(),
    });
    if (settlement.target_stage_id === null) {
      throw new Error(`structured loop stage ${input.stage.id} resolved directly to a terminal state`);
    }
    const target = structuredStageFor(input, settlement.target_stage_id);
    if (target.id === UNIT_INTEGRATION_STAGE_ID && target.kind === "effect") {
      if (input.stage.id !== UNIT_ACCEPTANCE_STAGE_ID || settlement.aggregate) {
        throw new Error("structured integration requires one uniformly accepted unit wave");
      }
      const source = evidence[0]!;
      if (source.attempt.scope.kind !== "loop_item") {
        throw new Error("structured acceptance source lost its unit scope");
      }
      const accepted: StructuredAcceptedUnitEvidence = {
        member_id: source.member_id,
        acceptance: settledStructuredActionEvidence(source),
        candidate_checkpoint: exactStructuredBoundaryCheckpoint(
          source.request_inputs,
          source.attempt.input_subject,
          `accepted unit ${source.member_id}`,
        ),
      };
      return {
        decision: settlement.decision,
        outcome: settlement.outcome,
        input_records: settlement.input_records,
        checkpoints: [],
        next_attempts: [createStructuredIntegrationAttempt({
          pipeline_run_id: input.view.run.id,
          parent_attempt_id: source.attempt.scope.parent_attempt_id,
          member_id: source.member_id,
          round: 0,
          stage_id: target.id,
          input_subject: input.view.run.current_subject,
          task_prompt: source.request_inputs.task_prompt,
          source: accepted,
          current_ancestry_checkpoints: [],
          planning_context_records: (() => {
            const promotion = exactStructuredPromotionDecision(
              source.request_inputs,
              input.view.manifest.pipeline_id,
            );
            return promotion === null ? [] : [promotion];
          })(),
          bundle: input.bundle,
          manifest: input.view.manifest,
        })],
      };
    }
    if (root.loop.body.includes(target.id) && target.kind !== "effect" && target.kind !== "wait") {
      const nextAttempts = evidence.map((source) => deriveKernelSuccessorAttempt({
        view: input.view,
        current: source.attempt,
        result: source.result,
        decision: settlement.aggregate ? settlement.decision : source.decision,
        bundle: input.bundle,
        target_scope: { ...source.attempt.scope, stage_id: target.id },
        request_inputs: source.request_inputs,
        checkpoint_override: structuredSuccessorCheckpoints(source),
        additional_context_records: (() => {
          const promotion = exactStructuredPromotionDecision(
            source.request_inputs,
            input.view.manifest.pipeline_id,
          );
          return [
            ...(settlement.aggregate ? settlement.input_records : []),
            ...(promotion === null ? [] : [promotion]),
          ];
        })(),
      }));
      return {
        decision: settlement.decision,
        outcome: settlement.outcome,
        input_records: settlement.input_records,
        checkpoints: evidence.map(({ checkpoint }) => checkpoint)
          .sort((left, right) => compareCodeUnits(left.id, right.id)),
        next_attempts: nextAttempts,
        next_dependencies: boundedStructuredDependencies(nextAttempts, root.loop.max_parallel),
      };
    }
    if (!target.id.startsWith("ot_runtime_stop_")) {
      throw new Error(`structured loop cannot fan in directly to unsupported stage ${target.id}`);
    }
    return structuredWaveTerminalSettlement({
      ordinary: input,
      current_attempt: {
        ...input.attempt,
        input_subject: input.view.run.current_subject,
        output_subject: null,
      },
      settlement,
      target_stage_id: target.id,
      request_inputs: currentRequest,
      evidence,
    });
  }

  async #planIntegration(input: ExternalInput): Promise<KernelExternalSettlementPlan> {
    if (input.attempt.scope.kind !== "loop_item") {
      throw new Error("structured integration requires loop-item scope");
    }
    const request = await this.#loadRequest(input.attempt);
    const integrationScope = input.attempt.scope;
    const resolvedPlan = resolveStructuredExecutionPlan(request, input.view.manifest.pipeline_id);
    const plan = resolvedPlan.plan;
    const unitIds = plan.units.map(({ id }) => id);
    if (!unitIds.includes(input.attempt.scope.item_id)) {
      throw new Error("structured integration Attempt names a unit outside its sealed plan");
    }
    const integrationStage = input.stage;
    const rootCandidates = input.view.manifest.stages.filter((candidate) =>
      candidate.kind === "agent" && candidate.id === UNIT_ENTRY_STAGE_ID &&
      candidate.loop?.over === integrationScope.loop_id && candidate.loop.body !== undefined &&
      candidate.loop.body.includes(integrationStage.id));
    if (rootCandidates.length !== 1 || rootCandidates[0]!.kind !== "agent" || !rootCandidates[0]!.loop) {
      throw new Error("structured integration has no exact unit-loop root");
    }
    const root = rootCandidates[0] as StructuredLoopStage;
    const acceptance = structuredStageFor(input, UNIT_ACCEPTANCE_STAGE_ID);
    if (
      acceptance.kind !== "agent" || acceptance.repository_authority !== "inspect" ||
      acceptance.on.success?.to !== integrationStage.id || acceptance.on.no_change?.to !== integrationStage.id
    ) throw new Error("structured integration has no exact inspect acceptance stage");
    const settled = await this.#store.listSettledStructuredPlanningAttempts({
      pipeline_run_id: input.view.run.id,
      definition_bundle_hash: input.view.run.definition_bundle_hash,
      scope_kind: "loop_item",
      parent_attempt_id: integrationScope.parent_attempt_id,
      scope_group_id: integrationScope.loop_id,
      stage_ids: [acceptance.id, integrationStage.id],
      member_ids: sortedUniqueStructuredIds(unitIds),
    });
    settled.forEach(assertStructuredSettledEvidence);
    const acceptedByMember = new Map<string, StructuredAcceptedUnitEvidence>();
    const integrations = new Map<string, StructuredIntegrationEvidence>();
    for (const candidate of settled) {
      if (candidate.attempt.scope.kind !== "loop_item") {
        throw new Error("structured integration planning returned a non-loop Attempt");
      }
      const memberId = candidate.attempt.scope.item_id;
      if (candidate.attempt.scope.parent_attempt_id !== integrationScope.parent_attempt_id ||
          candidate.attempt.scope.loop_id !== integrationScope.loop_id ||
          !unitIds.includes(memberId)) {
        throw new Error(`structured integration planning returned foreign member ${memberId}`);
      }
      const outcome = structuredDecisionOutcome(candidate.decision);
      if (candidate.attempt.scope.stage_id === acceptance.id &&
          (outcome === "success" || outcome === "no_change")) {
        if (acceptedByMember.has(memberId)) {
          throw new Error(`structured unit ${memberId} has multiple accepted candidates`);
        }
        acceptedByMember.set(memberId, {
          member_id: memberId,
          acceptance: settledStructuredActionEvidence(candidate),
          candidate_checkpoint: exactStructuredBoundaryCheckpoint(
            candidate.request_inputs,
            candidate.attempt.input_subject,
            `accepted unit ${memberId}`,
          ),
        });
      }
      if (candidate.attempt.scope.stage_id === integrationStage.id &&
          ["next_integration", "next_unit", "all_integrated"].includes(outcome)) {
        if (integrations.has(memberId)) {
          throw new Error(`structured unit ${memberId} has multiple accepted integrations`);
        }
        integrations.set(memberId, {
          member_id: memberId,
          attempt: candidate.attempt,
          result: candidate.result,
          decision: candidate.decision,
          checkpoint: candidate.checkpoint,
        });
      }
    }
    const deliveries = exactStructuredDeliveries(input);
    const currentOutcome = input.evaluated.outcome;
    if (currentOutcome !== "all_integrated" && currentOutcome !== "success") {
      throw new Error(`structured integration cannot interpret external outcome ${currentOutcome}`);
    }
    if (integrations.has(integrationScope.item_id)) {
      throw new Error(`structured unit ${integrationScope.item_id} was already integrated`);
    }
    const planOrder = new Map(plan.units.map((unit, index) => [unit.id, index]));
    const completedMembers = new Set([...integrations.keys(), integrationScope.item_id]);
    const waitingAccepted = [...acceptedByMember.values()]
      .filter(({ member_id: memberId }) => !completedMembers.has(memberId))
      .sort((left, right) => planOrder.get(left.member_id)! - planOrder.get(right.member_id)!);
    const outcome: "next_integration" | "next_unit" | "all_integrated" = waitingAccepted.length > 0
      ? "next_integration"
      : completedMembers.size < plan.units.length
        ? "next_unit"
        : "all_integrated";
    const decision = createPipelineDecisionRecord({
      attempt: input.attempt,
      result: input.result,
      additional_input_records: deliveries,
      evaluated: {
        ...input.evaluated,
        outcome,
        reason: outcome === "next_integration"
          ? "another accepted unit is ready for serial integration"
          : outcome === "next_unit"
            ? "integrated dependencies unlocked the next unit frontier"
            : "all structured units are integrated",
      },
      created_at: this.#now(),
    });
    const current = projectCurrentStructuredEvidence({
      attempt: input.attempt,
      result: input.result,
      decision,
      checkpoint: input.checkpoint,
      request_inputs: request,
    });
    integrations.set(integrationScope.item_id, {
      member_id: integrationScope.item_id,
      attempt: current.attempt,
      result: current.result,
      decision: current.decision,
      checkpoint: current.checkpoint,
    });
    const integratedSubject = input.attempt.output_subject!;
    const completedIntegrationChain = structuredIntegrationCheckpointChain({
      completed_integrations: integrations,
      checkpoint_base_subject: input.bundle.source_commit,
      current_subject: integratedSubject,
    });

    let nextAttempts: readonly KernelAttempt[];
    let nextDependencies: Readonly<Record<string, readonly string[]>> | undefined;
    if (outcome === "next_integration") {
      const source = waitingAccepted[0]!;
      const ancestryStart = source.candidate_checkpoint.input_subject === integratedSubject
        ? completedIntegrationChain.length
        : completedIntegrationChain.findIndex(
          ({ input_subject: subject }) => subject === source.candidate_checkpoint.input_subject,
        );
      if (ancestryStart < 0) {
        throw new Error("structured integration ancestry has no gap-free path from the candidate input");
      }
      nextAttempts = [createStructuredIntegrationAttempt({
        pipeline_run_id: input.view.run.id,
        parent_attempt_id: integrationScope.parent_attempt_id,
        member_id: source.member_id,
        round: integrations.size,
        stage_id: integrationStage.id,
        input_subject: integratedSubject,
        task_prompt: request.task_prompt,
        source,
        current_ancestry_checkpoints: completedIntegrationChain.slice(ancestryStart),
        planning_context_records: (() => {
          const promotion = structuredPromotionFromActionEvidence(
            source,
            input.view.manifest.pipeline_id,
          );
          return [...deliveries, ...(promotion === null ? [] : [promotion])];
        })(),
        bundle: input.bundle,
        manifest: input.view.manifest,
      })];
    } else if (outcome === "next_unit") {
      const frontier = compileStructuredLoopFrontier({
        pipeline_run_id: input.view.run.id,
        parent_attempt_id: integrationScope.parent_attempt_id,
        stage_id: root.id,
        loop_id: integrationScope.loop_id,
        integration_stage_id: integrationStage.id,
        round: integrations.size,
        input_subject: integratedSubject,
        cursor_version: input.view.run.cursor.version + 1,
        completed_scope_keys: input.view.run.cursor.completed_scope_keys,
        max_parallel: root.loop.max_parallel,
        members: plan.units.map((unit) => ({
          id: unit.id,
          depends_on: unit.depends_on,
          action_inputs: {
            task_prompt: request.task_prompt,
            context: {
              records: mergeCausalGithubPushContext({
                pipeline_run_id: input.view.run.id,
                base_records: [
                  ...exactStructuredRuntimeRecords(request),
                  ...(resolvedPlan.promotion === null ? [] : [resolvedPlan.promotion]),
                ],
                inherited_records: [...request.context.records.values()],
                additional_records: deliveries,
              }),
              checkpoints: [input.checkpoint],
            },
          },
        })),
        completed_integrations: integrations,
        bundle: input.bundle,
        manifest: input.view.manifest,
      });
      if (frontier === null) throw new Error("structured integration lost its unfinished frontier");
      nextAttempts = frontier.attempts;
      nextDependencies = frontier.dependencies;
    } else {
      const targetId = structuredNextStageId({
        view: input.view,
        stage: integrationStage,
        outcome,
      });
      if (targetId === null) throw new Error("structured integration cannot terminate before whole-change checks");
      nextAttempts = [deriveKernelSuccessorAttempt({
        view: input.view,
        current: input.attempt,
        result: input.result,
        decision,
        bundle: input.bundle,
        target_scope: { kind: "stage", stage_id: targetId },
        request_inputs: request,
        checkpoint_override: [input.checkpoint],
        additional_context_records: deliveries,
      })];
    }
    return {
      decision,
      outcome,
      next_attempts: nextAttempts,
      ...(nextDependencies === undefined ? {} : { next_dependencies: nextDependencies }),
    };
  }

  async #planReviewSelector(input: OrdinaryInput): Promise<OrdinaryKernelSettlementPlan> {
    const targetId = structuredNextStageId({
      view: input.view,
      stage: input.stage,
      outcome: input.evaluated.outcome,
    });
    if (targetId !== REVIEW_FANOUT_STAGE_ID) return input.default_plan();
    const target = structuredStageFor(input, targetId);
    if (target.kind !== "agent" || !target.loop || target.repository_authority !== "inspect") {
      throw new Error("structured review selector does not target its bounded inspect fanout");
    }
    const request = await this.#loadRequest(input.attempt);
    const decision = createPipelineDecisionRecord({
      attempt: input.attempt,
      result: input.result,
      evaluated: input.evaluated,
      created_at: this.#now(),
    });
    const personas = selectedStructuredReviewPersonas({
      result: input.result,
      bundle: input.bundle,
      manifest: input.view.manifest,
      selector_stage_id: input.stage.id,
      fanout_stage_id: target.id,
    });
    const boundary = exactStructuredBoundaryCheckpoint(
      request,
      input.attempt.input_subject,
      "structured review selector",
    );
    const records = mergeCausalGithubPushContext({
      pipeline_run_id: input.view.run.id,
      base_records: [input.result, decision, ...exactStructuredRuntimeRecords(request)],
      inherited_records: [...request.context.records.values()],
    });
    const frontier = compileReviewFanoutFrontier({
      pipeline_run_id: input.view.run.id,
      parent_attempt_id: input.attempt.id,
      stage_id: target.id,
      fanout_id: target.loop.over,
      round: 0,
      input_subject: input.attempt.input_subject,
      cursor_version: input.view.run.cursor.version + 1,
      completed_scope_keys: input.view.run.cursor.completed_scope_keys,
      max_parallel: target.loop.max_parallel,
      members: personas.map((id) => ({
        id,
        action_inputs: {
          task_prompt: request.task_prompt,
          context: { records, checkpoints: [boundary] },
        },
      })),
      bundle: input.bundle,
      manifest: input.view.manifest,
    });
    return {
      decision,
      outcome: input.evaluated.outcome,
      input_records: [input.result],
      checkpoints: [],
      next_attempts: frontier.attempts,
      next_dependencies: frontier.dependencies,
    };
  }

  async #planReviewWave(input: OrdinaryInput): Promise<OrdinaryKernelSettlementPlan> {
    if (input.stage.id !== REVIEW_FANOUT_STAGE_ID || input.attempt.scope.kind !== "fanout_member") {
      throw new Error(`unsupported structured fanout stage ${input.stage.id}`);
    }
    const currentDecision = createPipelineDecisionRecord({
      attempt: input.attempt,
      result: input.result,
      evaluated: input.evaluated,
      created_at: this.#now(),
    });
    if (!structuredBarrierCompletesWithCurrent(input)) {
      return {
        decision: currentDecision,
        outcome: input.evaluated.outcome,
        input_records: [input.result],
        checkpoints: [],
        next_attempts: [],
      };
    }
    const currentRequest = await this.#loadRequest(input.attempt);
    const evidence = await loadCompletedStructuredWave({
      store: this.#store,
      ordinary: input,
      current_decision: currentDecision,
      current_request: currentRequest,
    });
    const settlement = settleStructuredWaveDecision({
      view: input.view,
      stage: input.stage,
      current_attempt: input.attempt,
      current_result: input.result,
      current_decision: currentDecision,
      evidence,
      created_at: this.#now(),
    });
    if (settlement.target_stage_id === null) {
      throw new Error("structured review fanout resolved directly to a terminal state");
    }
    const target = structuredStageFor(input, settlement.target_stage_id);
    if (target.id.startsWith("ot_runtime_stop_")) {
      return structuredWaveTerminalSettlement({
        ordinary: input,
        current_attempt: input.attempt,
        settlement,
        target_stage_id: target.id,
        request_inputs: currentRequest,
        evidence,
      });
    }
    if (target.id !== REVIEW_VALIDATION_STAGE_ID || target.kind !== "agent" ||
        target.repository_authority !== "inspect") {
      throw new Error(`structured review fanout cannot target unsupported stage ${target.id}`);
    }
    const boundaries = new Map<string, AttemptCheckpoint>();
    for (const source of evidence) {
      const boundary = exactStructuredBoundaryCheckpoint(
        source.request_inputs,
        source.attempt.input_subject,
        `structured review ${source.member_id}`,
      );
      const prior = boundaries.get(boundary.id);
      if (prior && canonicalJson(prior) !== canonicalJson(boundary)) {
        throw new Error(`structured review boundary ${boundary.id} changed across the fanout`);
      }
      boundaries.set(boundary.id, boundary);
    }
    if (boundaries.size !== 1) {
      throw new Error("structured review fanout does not share one exact accepted boundary");
    }
    const additional = evidence.flatMap((source) => [source.result, source.decision])
      .filter(({ id }) => id !== input.result.id && id !== settlement.decision.id);
    return {
      decision: settlement.decision,
      outcome: settlement.outcome,
      input_records: settlement.input_records,
      checkpoints: [],
      next_attempts: [deriveKernelSuccessorAttempt({
        view: input.view,
        current: input.attempt,
        result: input.result,
        decision: settlement.decision,
        bundle: input.bundle,
        target_scope: { kind: "stage", stage_id: target.id },
        request_inputs: currentRequest,
        checkpoint_override: [...boundaries.values()],
        additional_context_records: additional,
      })],
    };
  }

  async #planReviewValidation(input: OrdinaryInput): Promise<OrdinaryKernelSettlementPlan> {
    if (input.evaluated.outcome !== "semantic_repair_required") return input.default_plan();
    const targetId = structuredNextStageId({
      view: input.view,
      stage: input.stage,
      outcome: input.evaluated.outcome,
    });
    if (targetId !== FINAL_REPAIR_STAGE_ID) return input.default_plan();
    const request = await this.#loadRequest(input.attempt);
    const decision = createPipelineDecisionRecord({
      attempt: input.attempt,
      result: input.result,
      evaluated: input.evaluated,
      created_at: this.#now(),
    });
    const settledAttempt = {
      ...input.attempt,
      status: "settled" as const,
      version: input.attempt.version + 1,
      lease: null,
      decision_record_id: decision.id,
    };
    const edge = `${input.stage.id}:${input.evaluated.outcome}:${targetId}`;
    return {
      decision,
      outcome: input.evaluated.outcome,
      input_records: [input.result],
      checkpoints: [],
      next_attempts: [createBlockingReviewRemediationAttempt({
        pipeline_run_id: input.view.run.id,
        stage_id: targetId,
        round: input.view.run.cursor.reentries[edge] ?? 0,
        input_subject: input.attempt.input_subject,
        task_prompt: request.task_prompt,
        attempt: settledAttempt,
        result: input.result,
        decision,
        checkpoints: [...request.context.checkpoints.values()],
        runtime_delivery_records: [...request.context.records.values()],
        bundle: input.bundle,
        manifest: input.view.manifest,
      })],
    };
  }
}
