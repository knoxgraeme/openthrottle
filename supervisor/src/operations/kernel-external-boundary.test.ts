import { describe, expect, it } from "vitest";
import {
  EXECUTION_RECORD_SCHEMA,
  digestCanonicalJson,
  expandCompiledRuntimeLifecycle,
  type AttemptCheckpoint,
  type CompiledPipelineManifest,
  type DefinitionBundle,
  type DeliveryRecord,
  type ExecutionRecord,
  type JsonValue,
} from "@openthrottle/contracts";
import type {
  ExternalScheduleView,
  KernelAttemptRequestInputs,
  LeasedAttemptView,
  ReductionReadRequest,
  ReductionView,
} from "../pipeline/kernel/ports.js";
import { compileKernelCursor } from "../pipeline/kernel/reducer.js";
import type {
  AtomicTransitionBundle,
  KernelAttempt,
  KernelRun,
} from "../pipeline/kernel/types.js";
import {
  KernelExternalBoundaryCoordinator,
  type KernelExternalBoundaryStore,
} from "./kernel-external-boundary.js";
import {
  CORE_EXTERNAL_PLAN_SHAPES,
  createKernelExternalStagePlanRegistry,
  type KernelExternalStagePlanBinding,
  type KernelPreparedExternalPlan,
} from "./kernel-external-plans.js";
import {
  createKernelEffectAdapterRegistry,
  type KernelEffectAdapterBinding,
} from "./kernel-effects.js";

const NOW = "2026-08-20T12:00:00.000Z";
const SUBJECT = "a".repeat(40);
const OUTPUT = "b".repeat(40);
const INTEGRATION_BLOB = {
  algorithm: "sha256" as const,
  digest: "e".repeat(64),
  bytes: 123,
  encoding: "binary" as const,
  media_type: "application/x-git-bundle",
  payload_schema: "openthrottle.git-checkpoint-bundle/v1",
};

function bundle(pipelineId = "core/test"): DefinitionBundle {
  return {
    schema: "openthrottle.definition-bundle/v1",
    compiler_version: "definition-compiler/v1",
    runtime_capability_digest: "c".repeat(64),
    source_commit: SUBJECT,
    pipeline_id: pipelineId,
    pipeline_selection: "config",
    entries: [],
  };
}

function manifest(input: {
  bundle_hash: string;
  external_kind?: string;
  stage_kind?: "effect" | "wait";
  terminal?: boolean;
}): CompiledPipelineManifest {
  const stageKind = input.stage_kind ?? "effect";
  const authoredStages: CompiledPipelineManifest["stages"] = [
    (stageKind === "effect"
      ? {
        id: "external",
        kind: "effect",
        effect: input.external_kind ?? "core/publish@1",
        on: input.terminal === false
          ? { success: { to: "next" } }
          : { success: { terminal: "completed" }, failure: { terminal: "failed" } },
      }
      : {
        id: "external",
        kind: "wait",
        wait: input.external_kind ?? "core/provider-wait@1",
        on: { success: { terminal: "completed" }, failure: { terminal: "failed" } },
      }),
    ...(input.terminal === false
      ? [{
        id: "next",
        kind: "wait" as const,
        wait: "core/provider-wait@1",
        on: { success: { terminal: "completed" as const } },
      }]
      : []),
  ];
  const runtime = expandCompiledRuntimeLifecycle({ entry_stage: "external", stages: authoredStages });
  return {
    schema: "openthrottle.compiled-pipeline-manifest/v1",
    pipeline_id: "core/test",
    pipeline_version: 1,
    entry_stage: "external",
    definition_bundle_hash: input.bundle_hash,
    compiler_version: "definition-compiler/v1",
    runtime_capability_digest: "c".repeat(64),
    stages: runtime.stages,
  };
}

function initialAttempt(currentManifest: CompiledPipelineManifest): KernelAttempt {
  return {
    schema: "openthrottle.kernel-attempt/v1",
    id: "attempt-1",
    pipeline_run_id: "run-1",
    scope: { kind: "stage", stage_id: "external" },
    repository_authority: "inspect",
    request_hash: "d".repeat(64),
    definition_bundle_hash: currentManifest.definition_bundle_hash,
    input_subject: SUBJECT,
    context_record_ids: [],
    context_checkpoint_ids: [],
    output_subject: null,
    native_session_id: null,
    status: "pending",
    version: 1,
    work_retry_ordinal: 0,
    result_correction_count: 0,
    result_correction_deadline: null,
    lease: {
      id: "attempt-lease-1",
      worker_id: "external-worker",
      purpose: "work",
      expires_at: "2026-08-20T12:05:00.000Z",
      started: false,
    },
    checkpoint_id: null,
    result_record_id: null,
    decision_record_id: null,
    pending_result: null,
  };
}

class MemoryExternalStore implements KernelExternalBoundaryStore {
  run: KernelRun;
  readonly attempts = new Map<string, KernelAttempt>();
  readonly records = new Map<string, ExecutionRecord>();
  readonly checkpoints = new Map<string, AttemptCheckpoint>();
  readonly schedules = new Map<string, ExternalScheduleView>();
  readonly applied: AtomicTransitionBundle[] = [];
  throwAfterApply: ((transition: AtomicTransitionBundle) => boolean) | null = null;

  constructor(
    readonly currentManifest: CompiledPipelineManifest,
    readonly taskPrompt = "Execute the plan.",
  ) {
    const attempt = initialAttempt(currentManifest);
    this.attempts.set(attempt.id, attempt);
    this.run = {
      schema: "openthrottle.kernel-run/v1",
      id: "run-1",
      pipeline_id: currentManifest.pipeline_id,
      definition_bundle_hash: currentManifest.definition_bundle_hash,
      current_subject: SUBJECT,
      status: "running",
      terminal_outcome: null,
      cursor: compileKernelCursor({ stage_id: "external", version: 0, attempts: [attempt] }),
      version: 1,
      work_retry_limit: 2,
      result_correction_limit: 2,
      active_attempt_versions: { [attempt.id]: attempt.version },
      active_effect_versions: {},
      checkpoint_ids: {},
    };
  }

  leased(): LeasedAttemptView {
    const attempt = this.attempts.get("attempt-1")!;
    return {
      run_id: this.run.id,
      run_version: this.run.version,
      cursor_version: this.run.cursor.version,
      attempt,
      lease: attempt.lease!,
    };
  }

  async loadExactReductionView(request: ReductionReadRequest): Promise<ReductionView> {
    const selectedRecords = new Map(request.record_ids.map((id) => {
      const record = this.records.get(id);
      if (!record) throw new Error(`missing record ${id}`);
      return [id, record] as const;
    }));
    const selectedCheckpoints = new Map(request.checkpoint_ids.map((id) => {
      const checkpoint = this.checkpoints.get(id);
      if (!checkpoint) throw new Error(`missing checkpoint ${id}`);
      return [id, checkpoint] as const;
    }));
    return {
      manifest: this.currentManifest,
      run: this.run,
      current_attempt: request.attempt_id === null ? null : this.attempts.get(request.attempt_id)!,
      records: selectedRecords,
      checkpoints: selectedCheckpoints,
    };
  }

  async applyAtomicTransition(transition: AtomicTransitionBundle) {
    this.applied.push(transition);
    for (const record of transition.append_records) this.records.set(record.id, record);
    for (const checkpoint of transition.append_checkpoints) this.checkpoints.set(checkpoint.id, checkpoint);
    for (const write of transition.attempt_writes) {
      if (write.kind === "replace") this.attempts.set(write.attempt.id, write.attempt);
    }
    for (const attempt of transition.create_attempts) this.attempts.set(attempt.id, attempt);
    for (const intent of transition.put_effects) {
      const decision = this.records.get(intent.decision_record_id);
      if (!decision || decision.kind !== "decision" || !("inline" in decision.payload)) {
        throw new Error("effect did not have a schedule decision");
      }
      const payload = decision.payload.inline as Record<string, JsonValue>;
      const key = String(payload.semantic_key);
      const existing = this.schedules.get(key) ?? {
        semantic_key: key,
        decision,
        effects: [],
      };
      this.schedules.set(key, {
        ...existing,
        effects: [...existing.effects, { intent, delivery: null }],
      });
    }
    this.run = transition.run;
    const shouldThrow = this.throwAfterApply?.(transition) ?? false;
    if (shouldThrow) {
      this.throwAfterApply = null;
      throw new Error("worker lost after durable transition");
    }
    return { disposition: "applied" as const, run_version: transition.run.version };
  }

  async loadAttemptRequestInputs(input: {
    pipeline_run_id: string;
    attempt_id: string;
  }): Promise<KernelAttemptRequestInputs> {
    const attempt = this.attempts.get(input.attempt_id)!;
    return {
      task_prompt: this.taskPrompt,
      context: {
        records: new Map(attempt.context_record_ids.map((id) => [id, this.records.get(id)!])),
        checkpoints: new Map(attempt.context_checkpoint_ids.map((id) => [id, this.checkpoints.get(id)!])),
      },
    };
  }

  async findExternalSchedule(input: {
    pipeline_run_id: string;
    attempt_id: string;
    phase: string;
  }): Promise<ExternalScheduleView | null> {
    return this.schedules.get(`external-schedule:${input.attempt_id}:${input.phase}`) ?? null;
  }

  async listReadyExternalAttempts() {
    const attempt = this.attempts.get("attempt-1")!;
    const active = Object.keys(this.run.active_effect_versions).length > 0;
    return !active && (attempt.status === "work_complete" || attempt.status === "recorded")
      ? [{ pipeline_run_id: this.run.id, attempt_id: attempt.id }]
      : [];
  }

  acknowledgePhase(phase: string, status: "confirmed" | "rejected" = "confirmed"): void {
    const key = `external-schedule:attempt-1:${phase}`;
    const schedule = this.schedules.get(key);
    if (!schedule) throw new Error(`missing phase ${phase}`);
    const effects = schedule.effects.map(({ intent }, index) => {
      const integration = intent.kind === "daytona/integrate-checkpoint@1";
      const delivery: DeliveryRecord = {
        schema: EXECUTION_RECORD_SCHEMA,
        id: `delivery-${phase}-${index}`,
        kind: "delivery",
        pipeline_run_id: intent.pipeline_run_id,
        effect_id: intent.id,
        idempotency_key: intent.idempotency_key,
        external_identity: intent.target,
        status,
        payload_schema: integration ? "openthrottle.effect-delivery/v1" : "delivery/v1",
        payload: { inline: integration ? {
          effect_kind: intent.kind,
          provider: "daytona",
          observed_via: "post_dispatch_reconciliation",
          result: {
            schema: "openthrottle.daytona-integration-delivery/v1",
            state: "integrated",
            pipeline_run_id: intent.pipeline_run_id,
            attempt_id: "attempt-1",
            effect_id: intent.id,
            idempotency_key: intent.idempotency_key,
            input_subject: SUBJECT,
            output_subject: OUTPUT,
            checkpoint_id: "checkpoint-integration",
            checkpoint_payload_schema: "openthrottle.git-checkpoint-bundle/v1",
            checkpoint_blob: INTEGRATION_BLOB,
            reason: null,
          },
        } : { result: { sandbox_id: "sandbox-1" } } },
        created_at: NOW,
      };
      this.records.set(delivery.id, delivery);
      return { intent, delivery };
    });
    this.schedules.set(key, { ...schedule, effects });
    const active = { ...this.run.active_effect_versions };
    for (const { intent } of effects) delete active[intent.id];
    this.run = { ...this.run, version: this.run.version + 1, active_effect_versions: active };
  }
}

function primitiveRegistry() {
  const operations = new Map<string, "mutation" | "observation">();
  for (const shape of Object.values(CORE_EXTERNAL_PLAN_SHAPES)) {
    for (const phase of shape.phases) {
      for (const effect of phase.effects) operations.set(effect.effect_kind, effect.operation);
    }
  }
  return createKernelEffectAdapterRegistry([...operations].map(
    ([effect_kind, operation]): KernelEffectAdapterBinding => ({
      effect_kind,
      provider: effect_kind.split("/")[0]!,
      operation,
      idempotency_strategy: "deterministic_target",
      adapter: {
        async reconcile() { return { kind: "not_found" }; },
        async dispatch() {},
      },
    }),
  ));
}

function prepared(
  externalKind: keyof typeof CORE_EXTERNAL_PLAN_SHAPES,
  outputSubject: string | null,
): KernelPreparedExternalPlan {
  const shape = CORE_EXTERNAL_PLAN_SHAPES[externalKind];
  const subject = shape.subject_policy === "advance" && outputSubject === null
    ? null
    : outputSubject ?? SUBJECT;
  return {
    verified_output_subject: outputSubject,
    checkpoint_payload: { external_kind: externalKind },
    phases: shape.phases.map((phase) => ({
      id: phase.id,
      effects: phase.effects.map((effect, index) => ({
        kind: effect.effect_kind,
        idempotency_key: `run-1:${phase.id}:${index}`,
        target: `${effect.effect_kind}:target:${index}`,
        subject,
        payload: { phase: phase.id },
      })),
    })),
  };
}

function binding(
  externalKind: keyof typeof CORE_EXTERNAL_PLAN_SHAPES,
  options: { output_subject?: string | null; outcome?: string } = {},
): KernelExternalStagePlanBinding {
  const shape = CORE_EXTERNAL_PLAN_SHAPES[externalKind];
  return {
    external_kind: externalKind,
    stage_kind: shape.stage_kind,
    subject_policy: shape.subject_policy,
    phases: shape.phases,
    async prepare() {
      return prepared(
        externalKind,
        options.output_subject === undefined
          ? null
          : options.output_subject,
      );
    },
    ...(shape.subject_policy === "advance" ? {
      async promote({ attempt, prepared: current, schedules }) {
        const delivery = schedules[0]!.effects[0]!.delivery!;
        return {
          delivery_record_id: delivery.id,
          checkpoint: {
            schema: "openthrottle.attempt-checkpoint/v1" as const,
            id: "checkpoint-integration",
            pipeline_run_id: attempt.pipeline_run_id,
            attempt_id: attempt.id,
            request_hash: attempt.request_hash,
            definition_bundle_hash: attempt.definition_bundle_hash,
            input_subject: attempt.input_subject,
            output_subject: OUTPUT,
            native_session_id: null,
            payload_schema: "openthrottle.git-checkpoint-bundle/v1",
            payload: { blob: INTEGRATION_BLOB },
            captured_at: NOW,
          },
          prepared: {
            ...current,
            verified_output_subject: OUTPUT,
            phases: [current.phases[0]!, {
              ...current.phases[1]!,
              effects: current.phases[1]!.effects.map((effect) => ({
                ...effect,
                idempotency_key: `${effect.idempotency_key}:promoted`,
                target: `${effect.target}:promoted`,
                subject: OUTPUT,
              })),
            }],
          },
        };
      },
    } : {}),
    evaluate: () => ({
      outcome: options.outcome ?? "success",
      summary: `${externalKind} completed with executor-owned evidence.`,
    }),
  };
}

function coordinator(input: {
  store: MemoryExternalStore;
  definition_bundle: DefinitionBundle;
  plans: readonly KernelExternalStagePlanBinding[];
}) {
  return new KernelExternalBoundaryCoordinator({
    store: input.store,
    definition_bundles: { resolveExactDefinitionBundle: async () => input.definition_bundle },
    plans: createKernelExternalStagePlanRegistry({
      effects: primitiveRegistry(),
      plans: input.plans,
    }),
    now: () => NOW,
  });
}

describe("kernel external boundary bridge", () => {
  it("walks ordered publish phases and settles from executor-authored result bytes", async () => {
    const definitionBundle = bundle();
    const currentManifest = manifest({ bundle_hash: digestCanonicalJson(definitionBundle) });
    const store = new MemoryExternalStore(currentManifest);
    const bridge = coordinator({ store, definition_bundle: definitionBundle, plans: [binding("core/publish@1")] });
    const phaseIds = CORE_EXTERNAL_PLAN_SHAPES["core/publish@1"].phases.map(({ id }) => id);

    let step = await bridge.executeLeasedAttempt(store.leased());
    for (const phase of phaseIds) {
      expect(step).toMatchObject({ disposition: "scheduled", phase });
      store.acknowledgePhase(phase);
      step = await bridge.resumeReadyAttempt();
    }
    expect(step).toMatchObject({
      disposition: "settled",
      outcome: "success",
      next_stage_id: "ot_runtime_stop_completed",
    });
    expect(store.run).toMatchObject({ status: "running", terminal_outcome: null });
    const result = [...store.records.values()].find((record) => record.kind === "result")!;
    expect(result.payload).toMatchObject({
      inline: {
        schema: "openthrottle.external-result-record/v1",
        outcome: "success",
        summary: expect.any(String),
      },
    });
    expect(typeof (result.payload as { inline: { summary: unknown } }).inline.summary).toBe("string");
  });

  it("recovers a committed phase whose acknowledgement was lost without duplicating effects", async () => {
    const definitionBundle = bundle();
    const currentManifest = manifest({ bundle_hash: digestCanonicalJson(definitionBundle) });
    const store = new MemoryExternalStore(currentManifest);
    const bridge = coordinator({ store, definition_bundle: definitionBundle, plans: [binding("core/publish@1")] });
    store.throwAfterApply = (transition) => transition.put_effects.length > 0;

    await expect(bridge.executeLeasedAttempt(store.leased())).rejects.toThrow(/lost after durable transition/);
    const first = CORE_EXTERNAL_PLAN_SHAPES["core/publish@1"].phases[0]!;
    const schedule = store.schedules.get(`external-schedule:attempt-1:${first.id}`)!;
    expect(schedule.effects).toHaveLength(first.effects.length);
    await expect(bridge.resumeAttempt({ pipeline_run_id: "run-1", attempt_id: "attempt-1" }))
      .resolves.toMatchObject({ disposition: "waiting", phase: first.id });
    expect(store.schedules.get(`external-schedule:attempt-1:${first.id}`)?.effects)
      .toHaveLength(first.effects.length);
  });

  it("resumes after the ResultRecord commit and settles without repeating completed work", async () => {
    const definitionBundle = bundle();
    const currentManifest = manifest({
      bundle_hash: digestCanonicalJson(definitionBundle),
      external_kind: "core/provider-wait@1",
      stage_kind: "wait",
    });
    const store = new MemoryExternalStore(currentManifest);
    const bridge = coordinator({
      store,
      definition_bundle: definitionBundle,
      plans: [binding("core/provider-wait@1")],
    });
    await bridge.executeLeasedAttempt(store.leased());
    store.acknowledgePhase("observe");
    store.throwAfterApply = (transition) => transition.append_records.some(({ kind }) => kind === "result");
    await expect(bridge.resumeReadyAttempt()).rejects.toThrow(/lost after durable transition/);
    expect(store.attempts.get("attempt-1")?.status).toBe("recorded");

    await expect(bridge.resumeReadyAttempt()).resolves.toMatchObject({
      disposition: "settled",
      outcome: "success",
    });
    expect([...store.records.values()].filter(({ kind }) => kind === "result")).toHaveLength(1);
  });

  it("advances integration subject while keeping the effect Attempt inspect-only", async () => {
    const definitionBundle = bundle();
    const currentManifest = manifest({
      bundle_hash: digestCanonicalJson(definitionBundle),
      external_kind: "core/integrate-unit@1",
    });
    const store = new MemoryExternalStore(currentManifest);
    const bridge = coordinator({
      store,
      definition_bundle: definitionBundle,
      plans: [binding("core/integrate-unit@1")],
    });
    await bridge.executeLeasedAttempt(store.leased());
    expect(store.attempts.get("attempt-1")).toMatchObject({
      repository_authority: "inspect",
      output_subject: null,
    });
    store.acknowledgePhase("integrate-checkpoint");
    await bridge.resumeReadyAttempt();
    expect(store.attempts.get("attempt-1")).toMatchObject({
      repository_authority: "inspect",
      output_subject: OUTPUT,
    });
    store.acknowledgePhase("push-checkpoint");
    await bridge.resumeReadyAttempt();
    expect(store.run.current_subject).toBe(OUTPUT);
  });

  it("seals a reconciled Daytona sandbox DeliveryRecord into the successor Attempt context", async () => {
    const definitionBundle = bundle();
    const currentManifest = manifest({
      bundle_hash: digestCanonicalJson(definitionBundle),
      external_kind: "core/daytona-provision@1",
      terminal: false,
    });
    const store = new MemoryExternalStore(currentManifest);
    const daytonaPlan: KernelExternalStagePlanBinding = {
      external_kind: "core/daytona-provision@1",
      stage_kind: "effect",
      subject_policy: "preserve",
      phases: [
        { id: "create", effects: [{ effect_kind: "daytona/create-sandbox@1", operation: "mutation" }] },
        { id: "start", effects: [{ effect_kind: "daytona/start-sandbox@1", operation: "mutation" }] },
      ],
      async prepare() {
        return {
          verified_output_subject: null,
          checkpoint_payload: { runtime: "daytona" },
          phases: ["create", "start"].map((phase) => ({
            id: phase,
            effects: [{
              kind: `daytona/${phase === "create" ? "create" : "start"}-sandbox@1`,
              idempotency_key: `run-1:${phase}`,
              target: phase === "create" ? "daytona:run-1" : "daytona:sandbox-1",
              subject: SUBJECT,
              payload: { sandbox_id: phase === "create" ? null : "sandbox-1" },
            }],
          })),
        };
      },
      evaluate: () => ({ outcome: "success", summary: "Sandbox reconciled and ready." }),
    };
    const daytonaEffects = createKernelEffectAdapterRegistry([
      "daytona/create-sandbox@1", "daytona/start-sandbox@1", "github/provider-wait@1",
    ].map((effect_kind): KernelEffectAdapterBinding => ({
      effect_kind,
      provider: effect_kind.split("/")[0]!,
      operation: effect_kind.startsWith("daytona/") ? "mutation" : "observation",
      idempotency_strategy: "deterministic_target",
      adapter: { async reconcile() { return { kind: "not_found" }; }, async dispatch() {} },
    })));
    const bridge = new KernelExternalBoundaryCoordinator({
      store,
      definition_bundles: { resolveExactDefinitionBundle: async () => definitionBundle },
      plans: createKernelExternalStagePlanRegistry({ effects: daytonaEffects, plans: [daytonaPlan, binding("core/provider-wait@1")] }),
      now: () => NOW,
    });
    await bridge.executeLeasedAttempt(store.leased());
    store.acknowledgePhase("create");
    await bridge.resumeReadyAttempt();
    store.acknowledgePhase("start");
    await bridge.resumeReadyAttempt();

    const successor = [...store.attempts.values()].find(({ id }) => id !== "attempt-1")!;
    expect(successor.scope.stage_id).toBe("next");
    const resourceDeliveries = successor.context_record_ids
      .map((id) => store.records.get(id))
      .filter((record): record is DeliveryRecord => record?.kind === "delivery");
    expect(resourceDeliveries).toHaveLength(2);
    expect(resourceDeliveries[0]?.payload).toMatchObject({ inline: { result: { sandbox_id: "sandbox-1" } } });
  });
});
