import { describe, expect, it } from "vitest";
import type {
  CompiledPipelineStage,
  JsonValue,
} from "@openthrottle/contracts";
import {
  CORE_EXTERNAL_PLAN_SHAPES,
  createKernelExternalStagePlanRegistry,
  materializeExternalEffectIntents,
  type KernelExternalPhaseShape,
  type KernelExternalStagePlanBinding,
  type KernelPreparedExternalPlan,
} from "./kernel-external-plans.js";
import {
  createKernelEffectAdapterRegistry,
  type KernelEffectAdapterBinding,
} from "./kernel-effects.js";

const SUBJECT = "a".repeat(40);
const OUTPUT = "b".repeat(40);

const externalStages: CompiledPipelineStage[] = [
  { id: "publish", kind: "effect", effect: "core/publish@1", on: { success: { to: "wait" } } },
  { id: "integrate", kind: "effect", effect: "core/integrate-unit@1", on: { success: { to: "publish" } } },
  { id: "wait", kind: "wait", wait: "core/provider-wait@1", on: { success: { terminal: "completed" } } },
];

function primitiveRegistry() {
  const operations = new Map<string, "mutation" | "observation">();
  for (const shape of Object.values(CORE_EXTERNAL_PLAN_SHAPES)) {
    for (const phase of shape.phases) {
      for (const effect of phase.effects) operations.set(effect.effect_kind, effect.operation);
    }
  }
  const adapter = {
    async reconcile() { return { kind: "not_found" as const }; },
    async dispatch() {},
  };
  return createKernelEffectAdapterRegistry(
    [...operations].map(([effect_kind, operation]): KernelEffectAdapterBinding => ({
      effect_kind,
      provider: effect_kind.split("/")[0]!,
      operation,
      idempotency_strategy: "deterministic_target",
      adapter,
    })),
  );
}

function preparedFor(input: {
  external_kind: keyof typeof CORE_EXTERNAL_PLAN_SHAPES;
  output_subject: string | null;
}): KernelPreparedExternalPlan {
  const shape = CORE_EXTERNAL_PLAN_SHAPES[input.external_kind];
  const accepted = input.output_subject ?? SUBJECT;
  return {
    verified_output_subject: input.output_subject,
    checkpoint_payload: { external_kind: input.external_kind },
    phases: shape.phases.map((phase) => ({
      id: phase.id,
      effects: phase.effects.map((effect, index) => ({
        kind: effect.effect_kind,
        idempotency_key: `run-1:${phase.id}:${index}`,
        target: `${effect.effect_kind}:target:${index}`,
        subject: accepted,
        payload: { phase: phase.id } as JsonValue,
      })),
    })),
  };
}

function plan(
  external_kind: keyof typeof CORE_EXTERNAL_PLAN_SHAPES,
  prepare?: KernelExternalStagePlanBinding["prepare"],
): KernelExternalStagePlanBinding {
  const shape = CORE_EXTERNAL_PLAN_SHAPES[external_kind];
  return {
    external_kind,
    stage_kind: shape.stage_kind,
    subject_policy: shape.subject_policy,
    phases: shape.phases as readonly KernelExternalPhaseShape[],
    prepare: prepare ?? (async () => preparedFor({
      external_kind,
      output_subject: null,
    })),
    ...(shape.subject_policy === "advance" ? {
      async promote() { throw new Error("promotion is not exercised by this registry test"); },
    } : {}),
    evaluate: () => ({ outcome: "success", summary: "External boundary completed." }),
  };
}

function preparationRequest(stage: CompiledPipelineStage) {
  return {
    run: {
      schema: "openthrottle.kernel-run/v1" as const,
      id: "run-1",
      pipeline_id: "core/test",
      definition_bundle_hash: "c".repeat(64),
      current_subject: SUBJECT,
      status: "running" as const,
      terminal_outcome: null,
      cursor: { stage_id: stage.id, version: 1, reentries: {}, frontier: [], completed_scope_keys: [], barrier: null },
      version: 1,
      work_retry_limit: 2,
      result_correction_limit: 2,
      active_attempt_versions: { "attempt-1": 1 },
      active_effect_versions: {},
      checkpoint_ids: {},
    },
    attempt: {
      schema: "openthrottle.kernel-attempt/v1" as const,
      id: "attempt-1",
      pipeline_run_id: "run-1",
      scope: { kind: "stage" as const, stage_id: stage.id },
      repository_authority: "inspect" as const,
      request_hash: "d".repeat(64),
      definition_bundle_hash: "c".repeat(64),
      input_subject: SUBJECT,
      context_record_ids: [],
      context_checkpoint_ids: [],
      output_subject: null,
      native_session_id: null,
      status: "running" as const,
      version: 1,
      work_retry_ordinal: 0,
      result_correction_count: 0,
      result_correction_deadline: null,
      lease: null,
      checkpoint_id: null,
      result_record_id: null,
      decision_record_id: null,
      pending_result: null,
    },
    stage: stage as Extract<CompiledPipelineStage, { kind: "effect" | "wait" }>,
    context: { records: new Map(), checkpoints: new Map() },
  };
}

describe("kernel external stage plan registry", () => {
  it("registers concrete publish, integrate, and provider-wait phase shapes", async () => {
    const registry = createKernelExternalStagePlanRegistry({
      effects: primitiveRegistry(),
      plans: [plan("core/publish@1"), plan("core/integrate-unit@1"), plan("core/provider-wait@1")],
    });
    registry.assertCompatible(externalStages);

    expect(registry.externalKinds()).toEqual([
      "core/integrate-unit@1", "core/provider-wait@1", "core/publish@1",
    ]);
    expect(registry.bindingFor(externalStages[0]!).phases.map(({ id }) => id)).toEqual([
      "push-checkpoint", "pull-request",
    ]);
    expect(registry.bindingFor(externalStages[1]!).subject_policy).toBe("advance");
    expect(registry.bindingFor(externalStages[2]!).phases).toEqual([
      { id: "observe", effects: [{ effect_kind: "github/provider-wait@1", operation: "observation" }] },
    ]);

    await expect(registry.bindingFor(externalStages[0]!).prepare(
      preparationRequest(externalStages[0]!),
    )).resolves.toMatchObject({ verified_output_subject: null });
    await expect(registry.bindingFor(externalStages[1]!).prepare(
      preparationRequest(externalStages[1]!),
    )).resolves.toMatchObject({ verified_output_subject: null });
  });

  it("fails admission for an unregistered stage or an unsafe wait/mutation binding", () => {
    const effects = primitiveRegistry();
    const registry = createKernelExternalStagePlanRegistry({
      effects,
      plans: [plan("core/publish@1")],
    });
    expect(() => registry.assertCompatible(externalStages)).toThrow(/no exact effect stage plan.*integrate/i);

    expect(() => createKernelExternalStagePlanRegistry({
      effects,
      plans: [{
        ...plan("core/provider-wait@1"),
        phases: [{ id: "unsafe", effects: [{ effect_kind: "github/push-checkpoint@1", operation: "mutation" }] }],
      }],
    })).toThrow(/wait plan.*cannot dispatch/i);
  });

  it("rejects prepared subject-policy and phase-shape drift", async () => {
    const publish = plan("core/publish@1", async () => preparedFor({
      external_kind: "core/publish@1",
      output_subject: OUTPUT,
    }));
    const registry = createKernelExternalStagePlanRegistry({
      effects: primitiveRegistry(),
      plans: [publish],
    });
    await expect(registry.bindingFor(externalStages[0]!).prepare(
      preparationRequest(externalStages[0]!),
    )).rejects.toThrow(/subject policy/i);
  });

  it("materializes deterministic Decision-owned EffectIntents", () => {
    const candidates = preparedFor({ external_kind: "core/integrate-unit@1", output_subject: OUTPUT })
      .phases[0]!.effects;
    const first = materializeExternalEffectIntents({
      run_id: "run-1",
      attempt_id: "attempt-1",
      decision_record_id: "decision-1",
      phase_id: "push-checkpoint",
      candidates,
    });
    expect(materializeExternalEffectIntents({
      run_id: "run-1",
      attempt_id: "attempt-1",
      decision_record_id: "decision-1",
      phase_id: "push-checkpoint",
      candidates,
    })).toEqual(first);
    expect(first[0]).toMatchObject({
      decision_record_id: "decision-1",
      subject: OUTPUT,
      kind: "daytona/integrate-checkpoint@1",
    });
  });
});
