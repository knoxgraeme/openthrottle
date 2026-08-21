import {
  digestCanonicalJson,
  jsonValueAt,
  type AttemptCheckpoint,
  type CompiledPipelineStage,
  type EffectIntent,
  type JsonValue,
} from "@openthrottle/contracts";
import type { ResolvedKernelContext } from "../pipeline/kernel/ports.js";
import type { ExternalScheduleView } from "../pipeline/kernel/ports.js";
import type { KernelAttempt, KernelRun } from "../pipeline/kernel/types.js";
import type {
  KernelEffectAdapterRegistry,
  KernelEffectAdapterBinding,
} from "./kernel-effects.js";

const EXTERNAL_KIND = /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*@\d+$/;
const PHASE_ID = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
const GIT_SUBJECT = /^[a-f0-9]{40,64}$/;
const MAX_EXTERNAL_PHASES = 8;

export type KernelExternalSubjectPolicy = "preserve" | "advance";

export interface KernelExternalPrimitiveShape {
  effect_kind: string;
  operation: KernelEffectAdapterBinding["operation"];
}

export interface KernelExternalPhaseShape {
  id: string;
  effects: readonly KernelExternalPrimitiveShape[];
}

export interface KernelExternalEffectCandidate {
  kind: string;
  idempotency_key: string;
  target: string;
  subject: string | null;
  payload: JsonValue;
}

export interface KernelPreparedExternalPlan {
  verified_output_subject: string | null;
  checkpoint_payload: JsonValue;
  phases: readonly {
    id: string;
    effects: readonly KernelExternalEffectCandidate[];
  }[];
}

export interface KernelExternalSubjectPromotion {
  prepared: KernelPreparedExternalPlan;
  checkpoint: AttemptCheckpoint;
  delivery_record_id: string;
}

export interface KernelExternalStagePlanBinding {
  external_kind: string;
  stage_kind: "effect" | "wait";
  subject_policy: KernelExternalSubjectPolicy;
  phases: readonly KernelExternalPhaseShape[];
  /**
   * Preparation is executor-owned. Advancing plans reconcile/apply local Git
   * work here and return the verified resulting subject; preserving plans
   * return null. It must be idempotent because a worker may die before the
   * atomic schedule transition is acknowledged.
   */
  prepare(input: {
    run: Readonly<KernelRun>;
    attempt: Readonly<KernelAttempt>;
    stage: Extract<CompiledPipelineStage, { kind: "effect" | "wait" }>;
    context: ResolvedKernelContext;
  }): Promise<KernelPreparedExternalPlan>;
  /**
   * Only subject-advancing executor effects implement this hook. It derives
   * the exact promoted checkpoint from a confirmed earlier phase delivery;
   * no provider mutation may happen here.
   */
  promote?(input: {
    run: Readonly<KernelRun>;
    attempt: Readonly<KernelAttempt>;
    stage: Extract<CompiledPipelineStage, { kind: "effect" | "wait" }>;
    context: ResolvedKernelContext;
    prepared: KernelPreparedExternalPlan;
    schedules: readonly ExternalScheduleView[];
  }): Promise<KernelExternalSubjectPromotion>;
  evaluate(input: {
    run: Readonly<KernelRun>;
    attempt: Readonly<KernelAttempt>;
    stage: Extract<CompiledPipelineStage, { kind: "effect" | "wait" }>;
    prepared: KernelPreparedExternalPlan;
    schedules: readonly ExternalScheduleView[];
  }): Promise<{ outcome: string; summary: string }> | { outcome: string; summary: string };
}

export interface KernelExternalStagePlanRegistry {
  bindingFor(stage: CompiledPipelineStage): KernelExternalStagePlanBinding;
  assertCompatible(stages: readonly CompiledPipelineStage[]): void;
  externalKinds(): readonly string[];
}

export const CORE_EXTERNAL_PLAN_SHAPES = Object.freeze({
  "core/publish@1": {
    stage_kind: "effect",
    subject_policy: "preserve",
    phases: [
      { id: "push-checkpoint", effects: [
        { effect_kind: "github/push-checkpoint@1", operation: "mutation" },
      ] },
      { id: "pull-request", effects: [
        { effect_kind: "github/upsert-pull-request@1", operation: "mutation" },
      ] },
    ],
  },
  "core/integrate-unit@1": {
    stage_kind: "effect",
    subject_policy: "advance",
    phases: [
      { id: "integrate-checkpoint", effects: [
        { effect_kind: "daytona/integrate-checkpoint@1", operation: "mutation" },
      ] },
      { id: "push-checkpoint", effects: [
        { effect_kind: "github/push-checkpoint@1", operation: "mutation" },
      ] },
    ],
  },
  "core/provider-wait@1": {
    stage_kind: "wait",
    subject_policy: "preserve",
    phases: [
      { id: "observe", effects: [
        { effect_kind: "github/provider-wait@1", operation: "observation" },
      ] },
    ],
  },
  "core/daytona-provision@1": {
    stage_kind: "effect",
    subject_policy: "preserve",
    phases: [
      { id: "create", effects: [
        { effect_kind: "daytona/create-sandbox@1", operation: "mutation" },
      ] },
      { id: "start", effects: [
        { effect_kind: "daytona/start-sandbox@1", operation: "mutation" },
      ] },
    ],
  },
  "core/daytona-stop@1": {
    stage_kind: "effect",
    subject_policy: "preserve",
    phases: [
      { id: "stop", effects: [
        { effect_kind: "daytona/stop-sandbox@1", operation: "mutation" },
      ] },
    ],
  },
  "core/daytona-cleanup@1": {
    stage_kind: "effect",
    subject_policy: "preserve",
    phases: [
      { id: "cleanup", effects: [
        { effect_kind: "daytona/cleanup-sandbox@1", operation: "mutation" },
      ] },
    ],
  },
  "kernel/promote-admission@1": {
    stage_kind: "effect",
    subject_policy: "preserve",
    phases: [
      { id: "promote", effects: [
        { effect_kind: "kernel/promote-admission@1", operation: "mutation" },
      ] },
    ],
  },
} as const);

function externalKindFor(stage: CompiledPipelineStage): string | null {
  if (stage.kind === "effect") return stage.effect;
  if (stage.kind === "wait") return stage.wait;
  return null;
}

function assertShape(
  binding: KernelExternalStagePlanBinding,
  effects: KernelEffectAdapterRegistry,
): void {
  if (!EXTERNAL_KIND.test(binding.external_kind)) {
    throw new Error(`invalid external stage plan kind ${JSON.stringify(binding.external_kind)}`);
  }
  if (binding.stage_kind !== "effect" && binding.stage_kind !== "wait") {
    throw new Error(`external stage plan ${binding.external_kind} has an invalid stage kind`);
  }
  if (binding.subject_policy !== "preserve" && binding.subject_policy !== "advance") {
    throw new Error(`external stage plan ${binding.external_kind} has an invalid subject policy`);
  }
  if (binding.stage_kind === "wait" && binding.subject_policy !== "preserve") {
    throw new Error(`wait plan ${binding.external_kind} cannot advance the repository subject`);
  }
  if (binding.subject_policy === "advance" && typeof binding.promote !== "function") {
    throw new Error(`advancing plan ${binding.external_kind} requires a delivery-backed promotion hook`);
  }
  if (
    binding.phases.length === 0 || binding.phases.length > MAX_EXTERNAL_PHASES ||
    typeof binding.prepare !== "function" || typeof binding.evaluate !== "function"
  ) {
    throw new Error(`external stage plan ${binding.external_kind} is incomplete or unbounded`);
  }
  const phaseIds = new Set<string>();
  for (const phase of binding.phases) {
    if (!PHASE_ID.test(phase.id) || phase.id.length > 100 || phaseIds.has(phase.id)) {
      throw new Error(`external stage plan ${binding.external_kind} has an invalid phase identity`);
    }
    phaseIds.add(phase.id);
    if (phase.effects.length === 0 || phase.effects.length > 16) {
      throw new Error(`external phase ${phase.id} must contain between 1 and 16 primitive effects`);
    }
    const kinds = new Set<string>();
    for (const shape of phase.effects) {
      if (kinds.has(shape.effect_kind)) {
        throw new Error(`external phase ${phase.id} repeats primitive ${shape.effect_kind}`);
      }
      kinds.add(shape.effect_kind);
      const primitive = effects.bindingFor(shape.effect_kind);
      if (primitive.operation !== shape.operation) {
        throw new Error(`external phase ${phase.id} operation conflicts with ${shape.effect_kind}`);
      }
      if (binding.stage_kind === "wait" && primitive.operation !== "observation") {
        throw new Error(`wait plan ${binding.external_kind} cannot dispatch ${shape.effect_kind}`);
      }
    }
  }
  if (binding.stage_kind === "wait" && binding.phases.length !== 1) {
    throw new Error(`wait plan ${binding.external_kind} must use one observation-only phase`);
  }
}

function validatePrepared(
  binding: KernelExternalStagePlanBinding,
  prepared: KernelPreparedExternalPlan,
  inputSubject: string,
): KernelPreparedExternalPlan {
  if (
    (binding.subject_policy === "preserve" && prepared.verified_output_subject !== null) ||
    (binding.subject_policy === "advance" && prepared.verified_output_subject !== null && (
      !GIT_SUBJECT.test(prepared.verified_output_subject) ||
      prepared.verified_output_subject === inputSubject
    ))
  ) {
    throw new Error(`external plan ${binding.external_kind} violated its subject policy`);
  }
  if (prepared.phases.length !== binding.phases.length) {
    throw new Error(`prepared external plan ${binding.external_kind} changed its phase shape`);
  }
  const acceptedSubject = prepared.verified_output_subject ?? inputSubject;
  const phases = prepared.phases.map((phase, phaseIndex) => {
    const expected = binding.phases[phaseIndex]!;
    if (phase.id !== expected.id || phase.effects.length !== expected.effects.length) {
      throw new Error(`prepared external plan ${binding.external_kind} changed phase ${expected.id}`);
    }
    const candidates = phase.effects.map((candidate, effectIndex) => {
      const expectedEffect = expected.effects[effectIndex]!;
      if (candidate.kind !== expectedEffect.effect_kind) {
        throw new Error(`prepared phase ${phase.id} changed primitive ${expectedEffect.effect_kind}`);
      }
      if (
        typeof candidate.idempotency_key !== "string" || candidate.idempotency_key.length === 0 ||
        typeof candidate.target !== "string" || candidate.target.length === 0 ||
        (candidate.subject !== null && candidate.subject !== acceptedSubject)
      ) {
        throw new Error(`prepared primitive ${candidate.kind} has an invalid deterministic identity`);
      }
      return Object.freeze({
        ...candidate,
        payload: jsonValueAt(candidate.payload, `prepared.${phase.id}.${candidate.kind}.payload`),
      });
    });
    return Object.freeze({ id: phase.id, effects: Object.freeze(candidates) });
  });
  return Object.freeze({
    verified_output_subject: prepared.verified_output_subject,
    checkpoint_payload: jsonValueAt(prepared.checkpoint_payload, "prepared.checkpoint_payload"),
    phases: Object.freeze(phases),
  });
}

export function createKernelExternalStagePlanRegistry(input: {
  plans: readonly KernelExternalStagePlanBinding[];
  effects: KernelEffectAdapterRegistry;
}): KernelExternalStagePlanRegistry {
  const byKind = new Map<string, KernelExternalStagePlanBinding>();
  for (const plan of input.plans) {
    assertShape(plan, input.effects);
    if (byKind.has(plan.external_kind)) {
      throw new Error(`duplicate external stage plan binding for ${plan.external_kind}`);
    }
    const originalPrepare = plan.prepare;
    const binding: KernelExternalStagePlanBinding = Object.freeze({
      ...plan,
      phases: Object.freeze(plan.phases.map((phase) => Object.freeze({
        id: phase.id,
        effects: Object.freeze(phase.effects.map((effect) => Object.freeze({ ...effect }))),
      }))),
      async prepare(request: Parameters<KernelExternalStagePlanBinding["prepare"]>[0]) {
        const prepared = await originalPrepare(request);
        return validatePrepared(binding, prepared, request.run.current_subject);
      },
      ...(plan.promote === undefined ? {} : {
        async promote(request: Parameters<NonNullable<KernelExternalStagePlanBinding["promote"]>>[0]) {
          const promoted = await plan.promote!(request);
          return {
            ...promoted,
            prepared: validatePrepared(binding, promoted.prepared, request.attempt.input_subject),
          };
        },
      }),
    });
    byKind.set(binding.external_kind, binding);
  }
  const kinds = Object.freeze([...byKind.keys()].sort());
  return Object.freeze({
    bindingFor(stage: CompiledPipelineStage): KernelExternalStagePlanBinding {
      const kind = externalKindFor(stage);
      if (kind === null) throw new Error(`stage ${stage.id} is not an external boundary`);
      const binding = byKind.get(kind);
      if (!binding || binding.stage_kind !== stage.kind) {
        throw new Error(`no exact ${stage.kind} stage plan is registered for ${kind}`);
      }
      return binding;
    },
    assertCompatible(stages: readonly CompiledPipelineStage[]): void {
      for (const stage of stages) {
        if (stage.kind === "effect" || stage.kind === "wait") this.bindingFor(stage);
      }
    },
    externalKinds(): readonly string[] {
      return kinds;
    },
  });
}

export function materializeExternalEffectIntents(input: {
  run_id: string;
  attempt_id: string;
  decision_record_id: string;
  phase_id: string;
  candidates: readonly KernelExternalEffectCandidate[];
}): EffectIntent[] {
  return input.candidates.map((candidate, index) => ({
    schema: "openthrottle.effect-intent/v1",
    id: `effect-${digestCanonicalJson({
      run: input.run_id,
      attempt: input.attempt_id,
      phase: input.phase_id,
      index,
      kind: candidate.kind,
      target: candidate.target,
    }).slice(0, 48)}`,
    pipeline_run_id: input.run_id,
    decision_record_id: input.decision_record_id,
    kind: candidate.kind,
    idempotency_key: candidate.idempotency_key,
    target: candidate.target,
    subject: candidate.subject,
    payload: candidate.payload,
  }));
}
