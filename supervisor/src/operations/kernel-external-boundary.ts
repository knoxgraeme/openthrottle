import {
  ATTEMPT_CHECKPOINT_SCHEMA,
  EXECUTION_RECORD_SCHEMA,
  canonicalJson,
  compareCodeUnits,
  digestCanonicalJson,
  jsonValueAt,
  type AttemptCheckpoint,
  type CompiledPipelineStage,
  type DecisionRecord,
  type DeliveryRecord,
  type ExecutionRecord,
  type ExecutionRecordPayloadContract,
  type ExecutionRecordPayloadRegistry,
  type JsonValue,
  type ResultRecord,
} from "@openthrottle/contracts";
import {
  createPipelineDecisionRecord,
  type EvaluatedKernelResult,
} from "../pipeline/kernel/evaluator-registry.js";
import type {
  ExternalScheduleView,
  KernelAttemptRequestPort,
  KernelDefinitionBundlePort,
  KernelExternalSchedulePort,
  KernelExternalSettlementPlan,
  KernelExternalSettlementPlanner,
  KernelReductionPort,
  LeasedAttemptView,
  ReductionView,
} from "../pipeline/kernel/ports.js";
import { reduceKernelCommand } from "../pipeline/kernel/reducer.js";
import {
  deriveKernelSuccessorAttempt,
  kernelSuccessorStageId,
} from "../pipeline/kernel/successor-attempt.js";
import {
  EXTERNAL_SCHEDULE_PAYLOAD_SCHEMA,
  EXTERNAL_SCHEDULE_REDUCER,
  type KernelAttempt,
} from "../pipeline/kernel/types.js";
import {
  materializeExternalEffectIntents,
  type KernelExternalStagePlanBinding,
  type KernelExternalStagePlanRegistry,
  type KernelPreparedExternalPlan,
} from "./kernel-external-plans.js";

export const EXTERNAL_BOUNDARY_CHECKPOINT_PAYLOAD_SCHEMA =
  "openthrottle.external-boundary-checkpoint/v1" as const;
export const EXTERNAL_RESULT_RECORD_PAYLOAD_SCHEMA =
  "openthrottle.external-result-record/v1" as const;

const OUTCOME = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
const MAX_SUMMARY_LENGTH = 4_000;

export interface KernelExternalBoundaryStore extends
  KernelReductionPort,
  KernelAttemptRequestPort,
  KernelExternalSchedulePort {}

export type KernelExternalBoundaryStep =
  | { disposition: "idle" }
  | {
    disposition: "scheduled";
    pipeline_run_id: string;
    attempt_id: string;
    phase: string;
    effect_ids: readonly string[];
  }
  | {
    disposition: "waiting";
    pipeline_run_id: string;
    attempt_id: string;
    phase: string;
  }
  | {
    disposition: "settled";
    pipeline_run_id: string;
    attempt_id: string;
    outcome: string;
    next_stage_id: string | null;
  };

function exactObject(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: must be an object`);
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).find((key) => !keys.includes(key));
  if (unknown) throw new Error(`${path}.${unknown}: unknown field`);
  return input;
}

function schedulePayload(value: unknown, path: string): JsonValue {
  const input = exactObject(value, path, [
    "schema", "semantic_key", "attempt_id", "external_kind", "phase",
    "subject_policy", "effect_kinds", "plan_digest",
  ]);
  if (
    input.schema !== EXTERNAL_SCHEDULE_PAYLOAD_SCHEMA ||
    typeof input.semantic_key !== "string" || typeof input.attempt_id !== "string" ||
    typeof input.external_kind !== "string" || typeof input.phase !== "string" ||
    (input.subject_policy !== "preserve" && input.subject_policy !== "advance") ||
    typeof input.plan_digest !== "string"
  ) throw new Error(`${path}: invalid external scheduling payload`);
  const effectKinds = jsonValueAt(input.effect_kinds, `${path}.effect_kinds`);
  if (!Array.isArray(effectKinds) || effectKinds.some((kind) => typeof kind !== "string")) {
    throw new Error(`${path}.effect_kinds: must be an array of exact primitive kinds`);
  }
  return {
    schema: EXTERNAL_SCHEDULE_PAYLOAD_SCHEMA,
    semantic_key: input.semantic_key,
    attempt_id: input.attempt_id,
    external_kind: input.external_kind,
    phase: input.phase,
    subject_policy: input.subject_policy,
    effect_kinds: effectKinds,
    plan_digest: input.plan_digest,
  } as JsonValue;
}

function resultPayload(value: unknown, path: string): JsonValue {
  const input = exactObject(value, path, [
    "schema", "external_kind", "outcome", "summary", "delivery_record_ids",
  ]);
  if (
    input.schema !== EXTERNAL_RESULT_RECORD_PAYLOAD_SCHEMA ||
    typeof input.external_kind !== "string" || typeof input.outcome !== "string" ||
    !OUTCOME.test(input.outcome) || typeof input.summary !== "string" ||
    input.summary.length > MAX_SUMMARY_LENGTH
  ) throw new Error(`${path}: invalid executor external result payload`);
  const deliveryIds = jsonValueAt(input.delivery_record_ids, `${path}.delivery_record_ids`);
  if (
    !Array.isArray(deliveryIds) ||
    deliveryIds.some((id) => typeof id !== "string") ||
    new Set(deliveryIds).size !== deliveryIds.length
  ) throw new Error(`${path}.delivery_record_ids: must contain unique IDs`);
  return {
    schema: EXTERNAL_RESULT_RECORD_PAYLOAD_SCHEMA,
    external_kind: input.external_kind,
    outcome: input.outcome,
    summary: input.summary,
    delivery_record_ids: deliveryIds,
  } as JsonValue;
}

export const EXTERNAL_SCHEDULE_PAYLOAD_CONTRACT: ExecutionRecordPayloadContract = Object.freeze({
  kind: "decision" as const,
  parseInline: schedulePayload,
});

export const EXTERNAL_RESULT_PAYLOAD_CONTRACT: ExecutionRecordPayloadContract = Object.freeze({
  kind: "result" as const,
  parseInline: resultPayload,
});

export function externalKernelPayloadSchemas(): ExecutionRecordPayloadRegistry {
  return new Map([
    [EXTERNAL_SCHEDULE_PAYLOAD_SCHEMA, EXTERNAL_SCHEDULE_PAYLOAD_CONTRACT],
    [EXTERNAL_RESULT_RECORD_PAYLOAD_SCHEMA, EXTERNAL_RESULT_PAYLOAD_CONTRACT],
  ]);
}

function transitionId(kind: string, identity: unknown): string {
  return `${kind}-${digestCanonicalJson(identity).slice(0, 48)}`;
}

function stageFor(view: ReductionView): Extract<CompiledPipelineStage, { kind: "effect" | "wait" }> {
  const stageId = view.current_attempt?.scope.stage_id;
  const stage = view.manifest.stages.find((candidate) => candidate.id === stageId);
  if (!stage || (stage.kind !== "effect" && stage.kind !== "wait")) {
    throw new Error(`attempt ${view.current_attempt?.id ?? "(missing)"} is not an external stage`);
  }
  return stage;
}

function mapWith<T extends { id: string }>(
  existing: ReadonlyMap<string, T>,
  additions: readonly T[],
): ReadonlyMap<string, T> {
  const next = new Map(existing);
  for (const addition of additions) {
    const prior = next.get(addition.id);
    if (prior && canonicalJson(prior) !== canonicalJson(addition)) {
      throw new Error(`aggregate contains conflicting identity ${addition.id}`);
    }
    next.set(addition.id, addition);
  }
  return next;
}

function scheduleDecision(input: {
  attempt: KernelAttempt;
  binding: KernelExternalStagePlanBinding;
  prepared: KernelPreparedExternalPlan;
  phase_index: number;
  input_deliveries: readonly DeliveryRecord[];
  created_at: string;
}): DecisionRecord {
  const phase = input.prepared.phases[input.phase_index]!;
  const semanticKey = `external-schedule:${input.attempt.id}:${phase.id}`;
  const payload = schedulePayload({
    schema: EXTERNAL_SCHEDULE_PAYLOAD_SCHEMA,
    semantic_key: semanticKey,
    attempt_id: input.attempt.id,
    external_kind: input.binding.external_kind,
    phase: phase.id,
    subject_policy: input.binding.subject_policy,
    effect_kinds: phase.effects.map(({ kind }) => kind),
    plan_digest: digestCanonicalJson(input.prepared),
  }, "external_schedule.payload");
  const inputRecordIds = input.input_deliveries.map(({ id }) => id).sort();
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: `decision-${digestCanonicalJson({
      semantic_key: semanticKey,
      input_record_ids: inputRecordIds,
      payload,
    }).slice(0, 48)}`,
    kind: "decision",
    pipeline_run_id: input.attempt.pipeline_run_id,
    reducer: EXTERNAL_SCHEDULE_REDUCER,
    input_record_ids: inputRecordIds,
    payload_schema: EXTERNAL_SCHEDULE_PAYLOAD_SCHEMA,
    payload: { inline: payload },
    created_at: input.created_at,
  };
}

function externalCheckpoint(input: {
  attempt: KernelAttempt;
  binding: KernelExternalStagePlanBinding;
  prepared: KernelPreparedExternalPlan;
  captured_at: string;
}): AttemptCheckpoint {
  const payload: JsonValue = {
    schema: EXTERNAL_BOUNDARY_CHECKPOINT_PAYLOAD_SCHEMA,
    external_kind: input.binding.external_kind,
    subject_policy: input.binding.subject_policy,
    plan_digest: digestCanonicalJson(input.prepared),
    evidence: input.prepared.checkpoint_payload,
  };
  return {
    schema: ATTEMPT_CHECKPOINT_SCHEMA,
    id: `checkpoint-${digestCanonicalJson({
      attempt_id: input.attempt.id,
      request_hash: input.attempt.request_hash,
      plan_digest: digestCanonicalJson(input.prepared),
    }).slice(0, 48)}`,
    pipeline_run_id: input.attempt.pipeline_run_id,
    attempt_id: input.attempt.id,
    request_hash: input.attempt.request_hash,
    definition_bundle_hash: input.attempt.definition_bundle_hash,
    input_subject: input.attempt.input_subject,
    output_subject: input.prepared.verified_output_subject,
    native_session_id: null,
    payload_schema: EXTERNAL_BOUNDARY_CHECKPOINT_PAYLOAD_SCHEMA,
    payload: { inline: payload },
    captured_at: input.captured_at,
  };
}

function exactDeliveries(schedules: readonly ExternalScheduleView[]): DeliveryRecord[] {
  return schedules.flatMap((schedule) => schedule.effects.map(({ delivery }) => {
    if (delivery === null) throw new Error(`external phase ${schedule.semantic_key} is incomplete`);
    return delivery;
  })).sort((left, right) => compareCodeUnits(left.id, right.id));
}

function externalResult(input: {
  attempt: KernelAttempt;
  external_kind: string;
  evaluated: EvaluatedKernelResult;
  deliveries: readonly DeliveryRecord[];
  created_at: string;
}): ResultRecord {
  if (
    !OUTCOME.test(input.evaluated.outcome) || typeof input.evaluated.reason !== "string" ||
    input.evaluated.reason.length > MAX_SUMMARY_LENGTH
  ) throw new Error("external settlement evaluator returned an invalid outcome or summary");
  const payload = resultPayload({
    schema: EXTERNAL_RESULT_RECORD_PAYLOAD_SCHEMA,
    external_kind: input.external_kind,
    outcome: input.evaluated.outcome,
    summary: input.evaluated.reason,
    delivery_record_ids: input.deliveries.map(({ id }) => id),
  }, "external_result.payload");
  const digest = digestCanonicalJson(payload);
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: `result-${digestCanonicalJson({ attempt_id: input.attempt.id, payload }).slice(0, 48)}`,
    kind: "result",
    pipeline_run_id: input.attempt.pipeline_run_id,
    attempt_id: input.attempt.id,
    request_hash: input.attempt.request_hash,
    definition_bundle_hash: input.attempt.definition_bundle_hash,
    input_subject: input.attempt.input_subject,
    output_subject: input.attempt.output_subject,
    original_candidate_hash: digest,
    normalized_candidate_hash: digest,
    payload_schema: EXTERNAL_RESULT_RECORD_PAYLOAD_SCHEMA,
    payload: { inline: payload },
    created_at: input.created_at,
  };
}

export class KernelExternalBoundaryCoordinator {
  readonly #store: KernelExternalBoundaryStore;
  readonly #bundles: KernelDefinitionBundlePort;
  readonly #plans: KernelExternalStagePlanRegistry;
  readonly #settlementPlanner: KernelExternalSettlementPlanner | null;
  readonly #now: () => string;

  constructor(input: {
    store: KernelExternalBoundaryStore;
    definition_bundles: KernelDefinitionBundlePort;
    plans: KernelExternalStagePlanRegistry;
    settlement_planner?: KernelExternalSettlementPlanner;
    now?: () => string;
  }) {
    this.#store = input.store;
    this.#bundles = input.definition_bundles;
    this.#plans = input.plans;
    this.#settlementPlanner = input.settlement_planner ?? null;
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  async executeLeasedAttempt(leased: LeasedAttemptView): Promise<KernelExternalBoundaryStep> {
    let view = await this.#load(leased.run_id, leased.attempt.id);
    const attempt = view.current_attempt;
    if (
      !attempt || !attempt.lease || attempt.lease.id !== leased.lease.id ||
      attempt.lease.worker_id !== leased.lease.worker_id
    ) throw new Error("external Attempt lease fence does not match");
    this.#plans.bindingFor(stageFor(view));
    if (!attempt.lease.started) {
      await this.#apply(view, {
        type: "start",
        command_id: transitionId("external-start", {
          attempt_id: attempt.id,
          lease_id: attempt.lease.id,
        }),
        attempt_id: attempt.id,
        lease_id: attempt.lease.id,
      });
      view = await this.#load(view.run.id, attempt.id);
    }
    return this.#advance(view);
  }

  async resumeReadyAttempt(): Promise<KernelExternalBoundaryStep> {
    const [ready] = await this.#store.listReadyExternalAttempts({ limit: 1 });
    if (!ready) return { disposition: "idle" };
    return this.#advance(await this.#load(ready.pipeline_run_id, ready.attempt_id));
  }

  async resumeAttempt(input: {
    pipeline_run_id: string;
    attempt_id: string;
  }): Promise<KernelExternalBoundaryStep> {
    return this.#advance(await this.#load(input.pipeline_run_id, input.attempt_id));
  }

  async #advance(initialView: ReductionView): Promise<KernelExternalBoundaryStep> {
    let view = initialView;
    let attempt = view.current_attempt;
    if (!attempt) throw new Error("external continuation requires its exact Attempt");
    const stage = stageFor(view);
    const binding = this.#plans.bindingFor(stage);
    const context = await this.#store.loadAttemptRequestInputs({
      pipeline_run_id: view.run.id,
      attempt_id: attempt.id,
    });
    const bundle = await this.#bundles.resolveExactDefinitionBundle({
      pipeline_run_id: view.run.id,
      definition_bundle_hash: view.run.definition_bundle_hash,
    });
    let prepared = await binding.prepare({
      run: view.run,
      attempt,
      stage,
      context: context.context,
      bundle,
    });
    if (
      binding.subject_policy === "preserve" && attempt.status !== "running" &&
      attempt.output_subject !== prepared.verified_output_subject
    ) throw new Error("prepared external plan changed its durable subject boundary");

    const schedules: ExternalScheduleView[] = [];
    for (let phaseIndex = 0; phaseIndex < prepared.phases.length; phaseIndex += 1) {
      const phase = prepared.phases[phaseIndex]!;
      const existing = await this.#store.findExternalSchedule({
        pipeline_run_id: view.run.id,
        attempt_id: attempt.id,
        phase: phase.id,
      });
      if (existing === null) {
        const priorDeliveries = phaseIndex === 0 ? [] : exactDeliveries([schedules[phaseIndex - 1]!]);
        const decision = scheduleDecision({
          attempt,
          binding,
          prepared,
          phase_index: phaseIndex,
          input_deliveries: priorDeliveries,
          created_at: this.#now(),
        });
        const effects = materializeExternalEffectIntents({
          run_id: view.run.id,
          attempt_id: attempt.id,
          decision_record_id: decision.id,
          phase_id: phase.id,
          candidates: phase.effects,
        });
        const checkpoint = attempt.checkpoint_id === null
          ? externalCheckpoint({ attempt, binding, prepared, captured_at: this.#now() })
          : (await this.#load(view.run.id, attempt.id, [], [attempt.checkpoint_id]))
            .checkpoints.get(attempt.checkpoint_id)!;
        const exact = await this.#load(
          view.run.id,
          attempt.id,
          priorDeliveries.map(({ id }) => id),
          attempt.checkpoint_id === null ? [] : [checkpoint.id],
        );
        await this.#apply({
          ...exact,
          records: mapWith(exact.records, [decision]),
          checkpoints: mapWith(exact.checkpoints, [checkpoint]),
        }, {
          type: "schedule_external",
          command_id: transitionId("external-schedule", {
            attempt_id: attempt.id,
            phase: phase.id,
            decision_id: decision.id,
          }),
          attempt_id: attempt.id,
          checkpoint_id: checkpoint.id,
          decision_record_id: decision.id,
          phase: phase.id,
          verified_output_subject: prepared.verified_output_subject,
          effect_intents: effects,
        });
        return {
          disposition: "scheduled",
          pipeline_run_id: view.run.id,
          attempt_id: attempt.id,
          phase: phase.id,
          effect_ids: effects.map(({ id }) => id),
        };
      }
      const expected = materializeExternalEffectIntents({
        run_id: view.run.id,
        attempt_id: attempt.id,
        decision_record_id: existing.decision.id,
        phase_id: phase.id,
        candidates: phase.effects,
      }).sort((left, right) => compareCodeUnits(left.id, right.id));
      if (
        canonicalJson(expected) !==
        canonicalJson(existing.effects.map(({ intent }) => intent)
          .sort((left, right) => compareCodeUnits(left.id, right.id)))
      ) throw new Error(`external phase ${phase.id} conflicts with its immutable prepared plan`);
      schedules.push(existing);
      if (existing.effects.some(({ delivery }) => delivery === null)) {
        return {
          disposition: "waiting",
          pipeline_run_id: view.run.id,
          attempt_id: attempt.id,
          phase: phase.id,
        };
      }
      if (binding.subject_policy === "advance" && prepared.verified_output_subject === null) {
        if (!binding.promote) {
          throw new Error(`advancing external plan ${binding.external_kind} has no promotion hook`);
        }
        const promotion = await binding.promote({
          run: view.run,
          attempt,
          stage,
          context: context.context,
          prepared,
          schedules,
        });
        if (
          promotion.prepared.verified_output_subject === null ||
          canonicalJson(promotion.prepared.phases.slice(0, phaseIndex + 1)) !==
            canonicalJson(prepared.phases.slice(0, phaseIndex + 1))
        ) throw new Error("external subject promotion changed an already scheduled phase");
        const delivery = existing.effects
          .map(({ delivery: candidate }) => candidate)
          .find((candidate) => candidate?.id === promotion.delivery_record_id);
        if (!delivery) throw new Error("external subject promotion did not cite its exact phase delivery");
        if (attempt.output_subject === null) {
          if (!attempt.checkpoint_id) throw new Error("external subject promotion lost its planning checkpoint");
          const exact = await this.#load(
            view.run.id,
            attempt.id,
            [delivery.id],
            [attempt.checkpoint_id],
          );
          await this.#apply({
            ...exact,
            checkpoints: mapWith(exact.checkpoints, [promotion.checkpoint]),
          }, {
            type: "advance_external_integration",
            command_id: transitionId("external-integration-advance", {
              attempt_id: attempt.id,
              delivery_record_id: delivery.id,
              checkpoint_id: promotion.checkpoint.id,
            }),
            attempt_id: attempt.id,
            prior_checkpoint_id: attempt.checkpoint_id,
            checkpoint_id: promotion.checkpoint.id,
            delivery_record_id: delivery.id,
            verified_output_subject: promotion.prepared.verified_output_subject,
          });
          view = await this.#load(view.run.id, attempt.id);
          attempt = view.current_attempt!;
        } else if (
          attempt.output_subject !== promotion.prepared.verified_output_subject ||
          attempt.checkpoint_id !== promotion.checkpoint.id
        ) {
          throw new Error("replayed external subject promotion conflicts with durable identity");
        } else {
          const exact = await this.#load(view.run.id, attempt.id, [], [attempt.checkpoint_id]);
          if (canonicalJson(exact.checkpoints.get(attempt.checkpoint_id)) !== canonicalJson(promotion.checkpoint)) {
            throw new Error("replayed external subject promotion changed its checkpoint bytes");
          }
        }
        prepared = promotion.prepared;
      }
    }

    if (binding.subject_policy === "advance" && prepared.verified_output_subject === null) {
      throw new Error(`advancing external plan ${binding.external_kind} produced no verified subject`);
    }

    const deliveries = exactDeliveries(schedules);
    const evaluatedValue = await binding.evaluate({ run: view.run, attempt, stage, prepared, schedules });
    if (
      !evaluatedValue || typeof evaluatedValue.outcome !== "string" ||
      typeof evaluatedValue.summary !== "string" ||
      (this.#settlementPlanner === null && !stage.on[evaluatedValue.outcome])
    ) throw new Error(`external plan ${binding.external_kind} returned an unsupported stage outcome`);
    const evaluated: EvaluatedKernelResult = {
      evaluator: `external/${binding.external_kind}`,
      outcome: evaluatedValue.outcome,
      reason: evaluatedValue.summary,
    };

    if (attempt.status === "work_complete") {
      const result = externalResult({
        attempt,
        external_kind: binding.external_kind,
        evaluated,
        deliveries,
        created_at: this.#now(),
      });
      const recordView = await this.#load(view.run.id, attempt.id, [], [attempt.checkpoint_id!]);
      await this.#apply({ ...recordView, records: mapWith(recordView.records, [result]) }, {
        type: "record",
        command_id: transitionId("external-record", { attempt_id: attempt.id, result_id: result.id }),
        attempt_id: attempt.id,
        record_id: result.id,
      });
      view = await this.#load(view.run.id, attempt.id, [result.id]);
      attempt = view.current_attempt!;
    }
    if (attempt.status !== "recorded" || !attempt.result_record_id) {
      throw new Error(`external attempt ${attempt.id} is not ready for settlement`);
    }
    const recorded = await this.#load(
      view.run.id,
      attempt.id,
      [attempt.result_record_id],
      [attempt.checkpoint_id!],
    );
    const result = recorded.records.get(attempt.result_record_id);
    if (!result || result.kind !== "result") throw new Error("external Attempt lost its ResultRecord");
    const checkpoint = recorded.checkpoints.get(attempt.checkpoint_id!);
    if (!checkpoint) throw new Error("external Attempt lost its executor checkpoint");
    const defaultPlan = async (): Promise<KernelExternalSettlementPlan> => {
      const decision = createPipelineDecisionRecord({
        attempt,
        result,
        additional_input_records: deliveries,
        evaluated,
        created_at: this.#now(),
      });
      const targetStageId = kernelSuccessorStageId({
        manifest: recorded.manifest,
        run: recorded.run,
        stage,
        outcome: evaluated.outcome,
      });
      const nextAttempts: KernelAttempt[] = [];
      if (targetStageId !== null) {
        const successorSubject = attempt.output_subject ?? attempt.input_subject;
        const candidates = [...context.context.checkpoints.values()]
          .filter((candidate) => candidate.output_subject === successorSubject);
        if (attempt.output_subject !== null && attempt.checkpoint_id !== null) {
          candidates.unshift((await this.#load(recorded.run.id, attempt.id, [], [attempt.checkpoint_id]))
            .checkpoints.get(attempt.checkpoint_id)!);
        }
        const checkpointContext = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
        if (checkpointContext.length > 1) {
          throw new Error(`external successor has ambiguous checkpoint materialization for ${successorSubject}`);
        }
        nextAttempts.push(deriveKernelSuccessorAttempt({
          view: recorded,
          current: attempt,
          result,
          decision,
          bundle,
          target_scope: { kind: "stage", stage_id: targetStageId },
          request_inputs: context,
          checkpoint_override: checkpointContext,
          additional_context_records: deliveries,
        }));
      }
      return { decision, outcome: evaluated.outcome, next_attempts: nextAttempts };
    };
    const settlement = this.#settlementPlanner === null
      ? await defaultPlan()
      : await this.#settlementPlanner.plan({
        view: recorded,
        stage,
        attempt,
        result,
        checkpoint,
        bundle,
        schedules,
        evaluated,
        default_plan: defaultPlan,
      });
    if (
      settlement.decision.pipeline_run_id !== recorded.run.id ||
      !settlement.decision.input_record_ids.includes(result.id) ||
      !stage.on[settlement.outcome]
    ) throw new Error("external settlement planner returned an unauthorized transition");
    const expectedDecisionInputs = [result.id, ...deliveries.map(({ id }) => id)]
      .sort(compareCodeUnits);
    if (
      canonicalJson([...settlement.decision.input_record_ids].sort(compareCodeUnits)) !==
      canonicalJson(expectedDecisionInputs)
    ) throw new Error("external settlement decision must cite its ResultRecord and exact DeliveryRecords");
    const settleRecords = mapWith<ExecutionRecord>(
      recorded.records,
      [...deliveries, settlement.decision],
    );
    await this.#apply({ ...recorded, records: settleRecords, checkpoints: new Map() }, {
      type: "settle",
      command_id: transitionId("external-settle", {
        attempt_id: attempt.id,
        decision_id: settlement.decision.id,
      }),
      attempt_id: attempt.id,
      decision_record_id: settlement.decision.id,
      outcome: settlement.outcome,
      next_attempts: settlement.next_attempts,
      next_dependencies: settlement.next_dependencies,
    });
    const final = await this.#load(recorded.run.id, null);
    return {
      disposition: "settled",
      pipeline_run_id: final.run.id,
      attempt_id: attempt.id,
      outcome: settlement.outcome,
      next_stage_id: final.run.cursor.stage_id,
    };
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

  async #apply(view: ReductionView, command: Parameters<typeof reduceKernelCommand>[0]["command"]): Promise<void> {
    const transition = reduceKernelCommand({
      manifest: view.manifest,
      run: view.run,
      current_attempt: view.current_attempt,
      records: view.records,
      checkpoints: view.checkpoints,
      command,
    });
    await this.#store.applyAtomicTransition(transition);
  }
}
