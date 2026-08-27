import { describe, expect, it } from "vitest";
import {
  EXECUTION_RECORD_SCHEMA,
  RUNTIME_PROVISION_STAGE_ID,
  definitionEntryContentHash,
  digestCanonicalJson,
  expandCompiledRuntimeLifecycle,
  runtimeCleanupStageId,
  runtimeStopStageId,
  type AttemptCheckpoint,
  type CompiledPipelineManifest,
  type DefinitionBundle,
  type DeliveryRecord,
  type EffectIntent,
  type ExecutionRecord,
  type JsonValue,
} from "@openthrottle/contracts";
import { createPipelineDecisionRecord } from "../pipeline/kernel/evaluator-registry.js";
import { createPendingKernelAttempt } from "../pipeline/kernel/action-request.js";
import {
  exactSandboxRecoveryRecord,
  sandboxRecoveryAttemptId,
  sandboxRecoveryEvaluator,
  sandboxRecoveryFrontierEvaluator,
  sandboxRecoveryFrontierReason,
} from "../pipeline/kernel/sandbox-recovery.js";
import type {
  ExternalScheduleView,
  KernelAttemptRequestInputs,
  LeasedAttemptView,
  ReductionReadRequest,
  ReductionView,
} from "../pipeline/kernel/ports.js";
import { compileKernelCursor, frontierMemberKey } from "../pipeline/kernel/reducer.js";
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
  createKernelExternalPlanBindings,
} from "./kernel-plan-bindings.js";
import {
  createKernelEffectAdapterRegistry,
  type KernelEffectAdapterBinding,
} from "./kernel-effects.js";
import { effectIntentContentHash } from "../pipeline/kernel/effect-intent.js";
import {
  OPERATOR_EFFECT_REJECTION_RUNTIME_SNAPSHOT,
  createOperatorEffectRejectionDelivery,
} from "../pipeline/kernel/operator-effect-rejection.js";

const NOW = "2026-08-20T12:00:00.000Z";
const SUBJECT = "a".repeat(40);
const PRIVATE_CANDIDATE = "f".repeat(40);
const OUTPUT = "b".repeat(40);
const RUNTIME_IDENTITY = "f".repeat(64);
const INTEGRATION_BLOB = {
  algorithm: "sha256" as const,
  digest: "e".repeat(64),
  bytes: 123,
  encoding: "binary" as const,
  media_type: "application/x-git-bundle",
  payload_schema: "openthrottle.git-checkpoint-bundle/v1",
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function runtimeCreateIntent(pipelineRunId: string): EffectIntent {
  return {
    schema: "openthrottle.effect-intent/v1",
    id: "effect-runtime-create",
    pipeline_run_id: pipelineRunId,
    decision_record_id: "decision-runtime-create",
    kind: "daytona/create-sandbox@1",
    idempotency_key: `${pipelineRunId}:runtime:create:${RUNTIME_IDENTITY}`,
    target: `daytona:${RUNTIME_IDENTITY}`,
    subject: null,
    payload: {
      schema: "openthrottle.daytona-create/v1",
      identity: RUNTIME_IDENTITY,
      pipeline_run_id: pipelineRunId,
      repository: "owner/repo",
      base_branch: "main",
      base_commit: SUBJECT,
      snapshot: OPERATOR_EFFECT_REJECTION_RUNTIME_SNAPSHOT,
    },
  };
}

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

function providerBundle(includePolicy = true): DefinitionBundle {
  const normalized_payload = {
    schema: "openthrottle.config/v2",
    pipeline: "core/test",
    engine: "codex",
    ...(includePolicy ? { provider_evidence: {
      github: {
        required_observations: [
          { kind: "check_run", name: "quality", app_slug: "github-actions" },
          { kind: "check_run", name: "docker-smoke", app_slug: "github-actions" },
        ],
      },
    } } : {}),
  };
  return {
    ...bundle(),
    entries: [{
      definition_kind: "config",
      definition_id: "repository",
      origin: { kind: "repository", source_commit: SUBJECT },
      path: ".openthrottle/config.yml",
      content_hash: definitionEntryContentHash(normalized_payload),
      normalized_payload,
    }],
  };
}

function realWaitBinding(): KernelExternalStagePlanBinding {
  const bindings = createKernelExternalPlanBindings({
    environments: {
      loadExactRunEnvironment: () => ({
        pipeline_run_id: "run-1",
        work_item_id: "work-1",
        repository_registration_id: "repo-1",
        repository: "owner/repo",
        base_branch: "main",
        runtime_snapshot: "snapshot-1",
        control_provider: "github",
        source_provider: "github",
        source_id: "issue-1",
        source_reference: "owner/repo#1",
        title: "Provider wait proof",
        current_subject: SUBJECT,
      }),
    },
    blob_store: {} as never,
  });
  return bindings.find(({ external_kind }) => external_kind === "core/provider-wait@1")!;
}

function realLifecycleBindings(): readonly KernelExternalStagePlanBinding[] {
  const bindings = createKernelExternalPlanBindings({
    environments: {
      loadExactRunEnvironment: () => ({
        pipeline_run_id: "run-1",
        work_item_id: "work-1",
        repository_registration_id: "repo-1",
        repository: "owner/repo",
        base_branch: "main",
        runtime_snapshot: "snapshot-1",
        control_provider: "github",
        source_provider: "github",
        source_id: "issue-1",
        source_reference: "owner/repo#1",
        title: "Runtime pool proof",
        current_subject: SUBJECT,
      }),
    },
    blob_store: {} as never,
  });
  return bindings.filter(({ external_kind }) => [
    "core/daytona-provision@1",
    "core/daytona-stop@1",
    "core/daytona-cleanup@1",
  ].includes(external_kind));
}

function manifest(input: {
  bundle_hash: string;
  external_kind?: string;
  stage_kind?: "effect" | "wait";
  terminal?: boolean;
  pool_size?: number;
}): CompiledPipelineManifest {
  const stageKind = input.stage_kind ?? "effect";
  const authoredStages: CompiledPipelineManifest["stages"] = [
    (stageKind === "effect"
      ? {
        id: "external",
        kind: "effect",
        effect: input.external_kind ?? "core/publish@1",
        ...(input.pool_size === undefined ? {} : {
          loop: {
            over: "execution_plan.units",
            max_parallel: input.pool_size,
            max_rounds: 1,
            body: ["external"],
          },
        }),
        on: input.terminal === false
          ? { success: { to: "next" } }
          : {
            success: { terminal: "completed" },
            retryable_infrastructure_failure: {
              to: "external",
              max_reentries: 2,
              on_exhausted: "failed",
            },
            failure: { terminal: "failed" },
          },
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

function initialAttempt(
  currentManifest: CompiledPipelineManifest,
  inputSubject = SUBJECT,
  stageId = "external",
): KernelAttempt {
  return {
    schema: "openthrottle.kernel-attempt/v1",
    id: "attempt-1",
    pipeline_run_id: "run-1",
    scope: { kind: "stage", stage_id: stageId },
    repository_authority: "inspect",
    request_hash: "d".repeat(64),
    definition_bundle_hash: currentManifest.definition_bundle_hash,
    input_subject: inputSubject,
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
      generation: 0,
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
    inputSubject = SUBJECT,
    readonly taskPrompt = "Execute the plan.",
    initialStageId = "external",
  ) {
    const attempt = initialAttempt(currentManifest, inputSubject, initialStageId);
    this.attempts.set(attempt.id, attempt);
    this.run = {
      schema: "openthrottle.kernel-run/v1",
      id: "run-1",
      pipeline_id: currentManifest.pipeline_id,
      definition_bundle_hash: currentManifest.definition_bundle_hash,
      current_subject: inputSubject,
      status: "running",
      terminal_outcome: null,
      cursor: compileKernelCursor({ stage_id: initialStageId, version: 0, attempts: [attempt] }),
      version: 1,
      work_retry_limit: 2,
      result_correction_limit: 2,
      active_attempt_versions: { [attempt.id]: attempt.version },
      active_effect_versions: {},
      checkpoint_ids: {},
    };
  }

  leased(attemptId = "attempt-1"): LeasedAttemptView {
    const attempt = this.attempts.get(attemptId)!;
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
      else {
        const prior = this.attempts.get(write.attempt_id)!;
        this.attempts.set(write.attempt_id, {
          ...prior,
          status: write.status,
          version: write.next_version,
          lease: null,
        });
      }
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
      ? [{ updated_at: NOW, pipeline_run_id: this.run.id, attempt_id: attempt.id }]
      : [];
  }

  acknowledgePhase(
    phase: string,
    status: "confirmed" | "rejected" | readonly ("confirmed" | "rejected" | null)[] = "confirmed",
    observedVia: "provider" | "operator_resolution" = "provider",
    attemptId = "attempt-1",
  ): void {
    const key = `external-schedule:${attemptId}:${phase}`;
    const schedule = this.schedules.get(key);
    if (!schedule) throw new Error(`missing phase ${phase}`);
    if (Array.isArray(status) && status.length !== schedule.effects.length) {
      throw new Error(`phase ${phase} status roster has another cardinality`);
    }
    const effects = schedule.effects.map(({ intent }, index) => {
      const effectStatus = typeof status === "string" ? status : status[index]!;
      if (effectStatus === null) return { intent, delivery: null };
      const integration = intent.kind === "daytona/integrate-checkpoint@1";
      const lifecycle = [
        "daytona/create-sandbox@1",
        "daytona/start-sandbox@1",
        "daytona/stop-sandbox@1",
        "daytona/cleanup-sandbox@1",
      ].includes(intent.kind);
      const lifecycleIdentity = lifecycle
        ? (intent.payload as { identity: string }).identity
        : null;
      const lifecycleSandboxId = lifecycleIdentity === null
        ? null
        : `sandbox-${schedule.effects.map(({ intent: candidate }) =>
          (candidate.payload as { identity: string }).identity).sort().indexOf(lifecycleIdentity) + 1}`;
      if (integration && observedVia === "operator_resolution") {
        const delivery = createOperatorEffectRejectionDelivery({
          request: {
            pipeline_run_id: intent.pipeline_run_id,
            effect_id: intent.id,
            expected_maintenance_version: 2,
            resolution_id: "resolution-sandbox-rejection",
            reason_code: "legacy_integration_idempotency_key_rejected_before_mutation",
            reason: "The sandbox request was rejected before repository mutation.",
          },
          intent,
          captured_run_version: 17,
          captured_effect_version: 31,
          intent_hash: effectIntentContentHash(intent),
          dispatch_fence: { lease_id: "dispatch-lease", worker_id: "worker-1" },
          reconciliation_ordinal: 32,
          prior_unknown_detail: "reconcile-only target remained absent",
          runtime_create_intent: runtimeCreateIntent(intent.pipeline_run_id),
          created_at: NOW,
        });
        this.records.set(delivery.id, delivery);
        return { intent, delivery };
      }
      const delivery: DeliveryRecord = {
        schema: EXECUTION_RECORD_SCHEMA,
        id: `delivery-${phase}-${index}`,
        kind: "delivery",
        pipeline_run_id: intent.pipeline_run_id,
        effect_id: intent.id,
        idempotency_key: intent.idempotency_key,
        external_identity: intent.target,
        status: effectStatus,
        payload_schema: integration || lifecycle ? "openthrottle.effect-delivery/v1" : "delivery/v1",
        payload: { inline: integration ? {
          effect_kind: intent.kind,
          provider: "daytona",
          observed_via: "post_dispatch_reconciliation",
          result: {
            schema: "openthrottle.daytona-integration-delivery/v1",
            state: "integrated",
            pipeline_run_id: intent.pipeline_run_id,
            attempt_id: attemptId,
            effect_id: intent.id,
            idempotency_key: intent.idempotency_key,
            input_subject: SUBJECT,
            output_subject: OUTPUT,
            checkpoint_id: "checkpoint-integration",
            checkpoint_payload_schema: "openthrottle.git-checkpoint-bundle/v1",
            checkpoint_blob: INTEGRATION_BLOB,
            reason: null,
          },
        } : lifecycle ? {
          effect_kind: intent.kind,
          provider: "daytona",
          observed_via: "post_dispatch_reconciliation",
          result: {
            identity: lifecycleIdentity!,
            sandbox_id: effectStatus === "rejected" && intent.kind === "daytona/create-sandbox@1"
              ? null
              : lifecycleSandboxId,
            resource_state: effectStatus === "rejected" && intent.kind === "daytona/create-sandbox@1"
              ? "absent"
              : phase === "start"
                ? "started"
                : phase === "create"
                  ? "created"
                  : phase === "stop"
                    ? "stopped"
                    : "absent",
          },
        } : { result: { sandbox_id: "sandbox-1" } } },
        created_at: NOW,
      };
      this.records.set(delivery.id, delivery);
      return { intent, delivery };
    });
    this.schedules.set(key, { ...schedule, effects });
    const active = { ...this.run.active_effect_versions };
    for (const { intent, delivery } of effects) {
      if (delivery !== null) delete active[intent.id];
    }
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
    checkpoint_payload: {
      external_kind: externalKind,
      ...(externalKind === "core/publish@1"
        ? { publication_parent_subject: SUBJECT }
        : {}),
    },
    phases: shape.phases.map((phase) => ({
      id: phase.id,
      effects: phase.effects.map((effect, index) => ({
        kind: effect.effect_kind,
        idempotency_key: effect.effect_kind === "daytona/integrate-checkpoint@1"
          ? `run-1:${phase.id}:${index}:${"a".repeat(201)}`
          : `run-1:${phase.id}:${index}`,
        target: `${effect.effect_kind}:target:${index}`,
        subject,
        payload: (effect.effect_kind === "daytona/integrate-checkpoint@1"
          ? {
            schema: "openthrottle.daytona-integration/v1",
            identity: RUNTIME_IDENTITY,
            pipeline_run_id: "run-1",
            attempt_id: "attempt-1",
            definition_bundle_hash: "c".repeat(64),
            checkpoint_base_subject: SUBJECT,
            current_subject: SUBJECT,
            candidate_checkpoint_id: "checkpoint-private-candidate",
            candidate_input_subject: SUBJECT,
            candidate_output_subject: PRIVATE_CANDIDATE,
            candidate_blob: INTEGRATION_BLOB,
            candidate_artifact: { commit: PRIVATE_CANDIDATE },
            current_ancestry: [],
          }
          : { phase: phase.id }) as JsonValue,
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
        if (delivery.status !== "confirmed") {
          throw new Error(`${externalKind} promotion requires a confirmed delivery`);
        }
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
            phases: current.phases.map((phase, phaseIndex) => phaseIndex === 0
              ? phase
              : {
                ...phase,
                effects: phase.effects.map((effect) => ({
                  ...effect,
                  idempotency_key: `${effect.idempotency_key}:promoted`,
                  target: `${effect.target}:promoted`,
                  subject: OUTPUT,
                })),
              }),
          },
        };
      },
    } : {}),
    evaluate: ({ schedules }) => schedules.every((schedule) =>
      schedule.effects.every(({ delivery }) => delivery?.status === "confirmed"))
      ? {
        outcome: options.outcome ?? "success",
        summary: `${externalKind} completed with executor-owned evidence.`,
      }
      : {
        outcome: "failure",
        summary: `${externalKind} was rejected with executor-owned evidence.`,
      },
  };
}

function coordinator(input: {
  store: KernelExternalBoundaryStore;
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
  it("passes the exact resolved bundle into preparation and seals its provider policy in the Effect", async () => {
    const definitionBundle = providerBundle();
    const currentManifest = manifest({
      bundle_hash: digestCanonicalJson(definitionBundle),
      external_kind: "core/provider-wait@1",
      stage_kind: "wait",
    });
    const store = new MemoryExternalStore(currentManifest);
    const wait = realWaitBinding();
    let preparedBundle: DefinitionBundle | undefined;
    const tracked: KernelExternalStagePlanBinding = {
      ...wait,
      async prepare(request) {
        preparedBundle = request.bundle;
        return wait.prepare(request);
      },
    };
    const bridge = coordinator({ store, definition_bundle: definitionBundle, plans: [tracked] });

    await expect(bridge.executeLeasedAttempt(store.leased())).resolves.toMatchObject({
      disposition: "scheduled",
      phase: "observe",
    });
    expect(preparedBundle).toBe(definitionBundle);
    const scheduled = store.schedules.get("external-schedule:attempt-1:observe")!;
    expect(scheduled.effects[0]!.intent).toMatchObject({
      subject: SUBJECT,
      payload: {
        schema: "openthrottle.github-provider-wait/v1",
        repository: "owner/repo",
        subject: SUBJECT,
        policy: {
          required_observations: [
            { kind: "check_run", name: "docker-smoke", app_slug: "github-actions" },
            { kind: "check_run", name: "quality", app_slug: "github-actions" },
          ],
        },
      },
    });
    await expect(bridge.resumeAttempt({ pipeline_run_id: "run-1", attempt_id: "attempt-1" }))
      .resolves.toMatchObject({ disposition: "waiting", phase: "observe" });
    expect(store.schedules.get("external-schedule:attempt-1:observe")!.effects[0]!.intent)
      .toEqual(scheduled.effects[0]!.intent);
  });

  it("atomically schedules a fixed pool, waits for every create, then replays the exact N starts", async () => {
    const definitionBundle = bundle();
    const currentManifest = manifest({
      bundle_hash: digestCanonicalJson(definitionBundle),
      pool_size: 3,
    });
    const store = new MemoryExternalStore(
      currentManifest,
      SUBJECT,
      "Execute the plan.",
      RUNTIME_PROVISION_STAGE_ID,
    );
    const bridge = coordinator({
      store,
      definition_bundle: definitionBundle,
      plans: realLifecycleBindings(),
    });

    const createStep = await bridge.executeLeasedAttempt(store.leased());
    expect(createStep).toMatchObject({ disposition: "scheduled", phase: "create" });
    if (createStep.disposition !== "scheduled") throw new Error("create phase was not scheduled");
    expect(createStep.effect_ids).toHaveLength(3);
    const createSchedule = store.schedules.get("external-schedule:attempt-1:create")!;
    expect(createSchedule.effects.map(({ intent }) => intent.id).sort())
      .toEqual([...createStep.effect_ids].sort());
    expect(store.applied.filter(({ put_effects }) => put_effects.length > 0)).toHaveLength(1);
    expect(store.applied.find(({ put_effects }) => put_effects.length > 0)?.put_effects)
      .toEqual(createSchedule.effects.map(({ intent }) => intent));
    expect([...store.checkpoints.values()][0]).toMatchObject({
      payload: { inline: { evidence: {
        schema: "openthrottle.daytona-runtime-pool/v1",
        pool_size: 3,
        target_count: 3,
      } } },
    });

    const replayStore = new MemoryExternalStore(
      currentManifest,
      SUBJECT,
      "Execute the plan.",
      RUNTIME_PROVISION_STAGE_ID,
    );
    const replayBridge = coordinator({
      store: replayStore,
      definition_bundle: definitionBundle,
      plans: realLifecycleBindings(),
    });
    const replayStep = await replayBridge.executeLeasedAttempt(replayStore.leased());
    expect(replayStep).toEqual(createStep);
    expect(replayStore.schedules.get("external-schedule:attempt-1:create"))
      .toEqual(createSchedule);
    expect([...replayStore.checkpoints.values()]).toEqual([...store.checkpoints.values()]);

    store.acknowledgePhase("create", ["confirmed", null, null]);
    await expect(bridge.resumeAttempt({ pipeline_run_id: "run-1", attempt_id: "attempt-1" }))
      .resolves.toMatchObject({ disposition: "waiting", phase: "create" });
    expect(store.schedules.has("external-schedule:attempt-1:start")).toBe(false);
    expect(store.schedules.get("external-schedule:attempt-1:create")?.effects
      .map(({ intent }) => intent.id).sort()).toEqual([...createStep.effect_ids].sort());

    store.acknowledgePhase("create");
    const startStep = await bridge.resumeReadyAttempt();
    expect(startStep).toMatchObject({ disposition: "scheduled", phase: "start" });
    if (startStep.disposition !== "scheduled") throw new Error("start phase was not scheduled");
    expect(startStep.effect_ids).toHaveLength(3);
    const startSchedule = store.schedules.get("external-schedule:attempt-1:start")!;
    expect(startSchedule.effects.map(({ intent }) => intent.id).sort())
      .toEqual([...startStep.effect_ids].sort());
    expect(store.applied.filter(({ put_effects }) => put_effects.length > 0)
      .map(({ put_effects }) => put_effects.length)).toEqual([3, 3]);
    await expect(bridge.resumeAttempt({ pipeline_run_id: "run-1", attempt_id: "attempt-1" }))
      .resolves.toMatchObject({ disposition: "waiting", phase: "start" });
    expect(store.schedules.get("external-schedule:attempt-1:start")).toEqual(startSchedule);
  });

  it("routes every confirmed-created target through stop after partial create or start rejection", async () => {
    for (const rejectedPhase of ["create", "start"] as const) {
      const definitionBundle = bundle();
      const currentManifest = manifest({
        bundle_hash: digestCanonicalJson(definitionBundle),
        pool_size: 3,
      });
      const store = new MemoryExternalStore(
        currentManifest,
        SUBJECT,
        "Execute the plan.",
        RUNTIME_PROVISION_STAGE_ID,
      );
      const bridge = coordinator({
        store,
        definition_bundle: definitionBundle,
        plans: realLifecycleBindings(),
      });

      await bridge.executeLeasedAttempt(store.leased());
      if (rejectedPhase === "start") {
        store.acknowledgePhase("create");
        await expect(bridge.resumeReadyAttempt()).resolves.toMatchObject({
          disposition: "scheduled",
          phase: "start",
        });
        store.acknowledgePhase("start", ["confirmed", "rejected", "rejected"]);
      } else {
        store.acknowledgePhase("create", ["confirmed", "rejected", "rejected"]);
      }

      await expect(bridge.resumeReadyAttempt()).resolves.toMatchObject({
        disposition: "settled",
        outcome: "failure",
        next_stage_id: runtimeStopStageId("failed"),
      });
      const deliveredCreateSchedule = store.schedules.get("external-schedule:attempt-1:create")!;
      const confirmedCreatedIdentities = deliveredCreateSchedule.effects.flatMap(({ intent, delivery }) =>
        delivery?.status === "confirmed"
          ? [(intent.payload as { identity: string }).identity]
          : []);
      const stopAttempt = [...store.attempts.values()].find(({ scope }) =>
        scope.stage_id === runtimeStopStageId("failed"))!;
      expect(stopAttempt.context_record_ids).toEqual(expect.arrayContaining(
        deliveredCreateSchedule.effects.map(({ delivery }) => delivery!.id),
      ));
      const leasedStop: KernelAttempt = {
        ...stopAttempt,
        lease: {
          id: `stop-lease-${rejectedPhase}`,
          generation: 0,
          worker_id: "external-worker",
          purpose: "work",
          expires_at: "2026-08-20T12:05:00.000Z",
          started: false,
        },
      };
      store.attempts.set(leasedStop.id, leasedStop);

      const stopStep = await bridge.executeLeasedAttempt(store.leased(leasedStop.id));
      expect(stopStep).toMatchObject({ disposition: "scheduled", phase: "stop" });
      const stopSchedule = store.schedules.get(
        `external-schedule:${leasedStop.id}:stop`,
      )!;
      expect(stopSchedule.effects.map(({ intent }) =>
        (intent.payload as { identity: string }).identity).sort())
        .toEqual([...confirmedCreatedIdentities].sort());
      expect(stopSchedule.effects).toHaveLength(rejectedPhase === "create" ? 1 : 3);

      store.acknowledgePhase("stop", "confirmed", "provider", leasedStop.id);
      await expect(bridge.resumeAttempt({
        pipeline_run_id: store.run.id,
        attempt_id: leasedStop.id,
      })).resolves.toMatchObject({
        disposition: "settled",
        outcome: "success",
        next_stage_id: runtimeCleanupStageId("failed"),
      });
      const cleanupAttempt = [...store.attempts.values()].find(({ scope }) =>
        scope.stage_id === runtimeCleanupStageId("failed"))!;
      expect(cleanupAttempt).toBeDefined();
      const leasedCleanup: KernelAttempt = {
        ...cleanupAttempt,
        lease: {
          id: `cleanup-lease-${rejectedPhase}`,
          generation: 0,
          worker_id: "external-worker",
          purpose: "work",
          expires_at: "2026-08-20T12:05:00.000Z",
          started: false,
        },
      };
      store.attempts.set(leasedCleanup.id, leasedCleanup);

      const cleanupStep = await bridge.executeLeasedAttempt(store.leased(leasedCleanup.id));
      expect(cleanupStep).toMatchObject({ disposition: "scheduled", phase: "cleanup" });
      const cleanupSchedule = store.schedules.get(
        `external-schedule:${leasedCleanup.id}:cleanup`,
      )!;
      expect(cleanupSchedule.effects.map(({ intent }) =>
        (intent.payload as { identity: string }).identity).sort())
        .toEqual([...confirmedCreatedIdentities].sort());
      expect(cleanupSchedule.effects).toHaveLength(rejectedPhase === "create" ? 1 : 3);
    }
  });

  it("fails closed before scheduling when a provider-wait bundle lacks sealed policy", async () => {
    const definitionBundle = providerBundle(false);
    const currentManifest = manifest({
      bundle_hash: digestCanonicalJson(definitionBundle),
      external_kind: "core/provider-wait@1",
      stage_kind: "wait",
    });
    const store = new MemoryExternalStore(currentManifest);
    const bridge = coordinator({
      store,
      definition_bundle: definitionBundle,
      plans: [realWaitBinding()],
    });

    await expect(bridge.executeLeasedAttempt(store.leased()))
      .rejects.toThrow(/sealed GitHub provider-evidence policy/);
    expect(store.schedules.size).toBe(0);
  });

  it("rejects a stale external claim after recovery before scheduling any effect", async () => {
    const definitionBundle = bundle();
    const currentManifest = manifest({ bundle_hash: digestCanonicalJson(definitionBundle) });
    const store = new MemoryExternalStore(currentManifest);
    const stale = store.leased();
    const publish = binding("core/publish@1");
    const recovering: KernelExternalStagePlanBinding = {
      ...publish,
      async prepare(request) {
        const current = store.attempts.get(request.attempt.id)!;
        const recovered = {
          ...current,
          version: current.version + 1,
          lease: {
            ...current.lease!,
            generation: current.lease!.generation + 1,
            expires_at: "2026-08-20T12:10:00.000Z",
          },
        };
        store.attempts.set(recovered.id, recovered);
        store.run = {
          ...store.run,
          version: store.run.version + 1,
          active_attempt_versions: {
            ...store.run.active_attempt_versions,
            [recovered.id]: recovered.version,
          },
        };
        return publish.prepare(request);
      },
    };
    const bridge = coordinator({
      store,
      definition_bundle: definitionBundle,
      plans: [recovering],
    });

    await expect(bridge.executeLeasedAttempt(stale)).rejects.toThrow(/claim generation/);
    expect(store.schedules.size).toBe(0);
    expect(store.attempts.get("attempt-1")?.lease).toMatchObject({
      id: stale.lease.id,
      worker_id: stale.lease.worker_id,
      generation: 1,
      started: true,
    });
  });

  it("rejects a paused stale generation after the recovered generation schedules and delivers", async () => {
    const definitionBundle = bundle();
    const currentManifest = manifest({
      bundle_hash: digestCanonicalJson(definitionBundle),
      external_kind: "core/provider-wait@1",
      stage_kind: "wait",
    });
    const store = new MemoryExternalStore(currentManifest);
    const wait = binding("core/provider-wait@1");
    const stalePrepareEntered = deferred();
    const resumeStalePrepare = deferred();
    let evaluationCount = 0;
    const racing: KernelExternalStagePlanBinding = {
      ...wait,
      async prepare(request) {
        if (request.attempt.lease?.generation === 0) {
          stalePrepareEntered.resolve();
          await resumeStalePrepare.promise;
        }
        return wait.prepare(request);
      },
      async evaluate(request) {
        evaluationCount += 1;
        return wait.evaluate(request);
      },
    };
    const bridge = coordinator({
      store,
      definition_bundle: definitionBundle,
      plans: [racing],
    });

    const staleExecution = bridge.executeLeasedAttempt(store.leased());
    await stalePrepareEntered.promise;

    const current = store.attempts.get("attempt-1")!;
    const recovered = {
      ...current,
      version: current.version + 1,
      lease: {
        ...current.lease!,
        generation: current.lease!.generation + 1,
        expires_at: "2026-08-20T12:10:00.000Z",
      },
    };
    store.attempts.set(recovered.id, recovered);
    store.run = {
      ...store.run,
      version: store.run.version + 1,
      active_attempt_versions: {
        ...store.run.active_attempt_versions,
        [recovered.id]: recovered.version,
      },
    };

    await expect(bridge.executeLeasedAttempt(store.leased())).resolves.toMatchObject({
      disposition: "scheduled",
      phase: "observe",
    });
    store.acknowledgePhase("observe");
    resumeStalePrepare.resolve();

    await expect(staleExecution).rejects.toThrow(/claim generation/);
    expect(evaluationCount).toBe(0);
    expect(store.attempts.get("attempt-1")).toMatchObject({
      status: "work_complete",
      lease: null,
    });
    expect(store.schedules.get("external-schedule:attempt-1:observe")?.effects[0]?.delivery)
      .toMatchObject({ status: "confirmed" });
  });

  it("does not let an unleased continuation adopt a live external lease", async () => {
    const definitionBundle = bundle();
    const currentManifest = manifest({ bundle_hash: digestCanonicalJson(definitionBundle) });
    const store = new MemoryExternalStore(currentManifest);
    const bridge = coordinator({
      store,
      definition_bundle: definitionBundle,
      plans: [binding("core/publish@1")],
    });

    await expect(bridge.resumeAttempt({ pipeline_run_id: "run-1", attempt_id: "attempt-1" }))
      .rejects.toThrow(/cannot adopt a live Attempt lease/);
    expect(store.applied).toHaveLength(0);
  });

  it("walks a private candidate through compacted publish and settlement", async () => {
    const definitionBundle = bundle();
    const currentManifest = manifest({ bundle_hash: digestCanonicalJson(definitionBundle) });
    const store = new MemoryExternalStore(currentManifest, PRIVATE_CANDIDATE);
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
    expect(store.attempts.get("attempt-1")).toMatchObject({
      input_subject: PRIVATE_CANDIDATE,
      output_subject: OUTPUT,
      status: "settled",
    });
    expect(store.checkpoints.get("checkpoint-integration")).toMatchObject({
      input_subject: PRIVATE_CANDIDATE,
      output_subject: OUTPUT,
    });
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

  it("carries the compacted publication subject into its provider wait successor", async () => {
    const definitionBundle = providerBundle();
    const currentManifest = manifest({
      bundle_hash: digestCanonicalJson(definitionBundle),
      external_kind: "core/publish@1",
      terminal: false,
    });
    const store = new MemoryExternalStore(currentManifest);
    const bridge = coordinator({
      store,
      definition_bundle: definitionBundle,
      plans: [binding("core/publish@1")],
    });
    let step = await bridge.executeLeasedAttempt(store.leased());
    for (const phase of CORE_EXTERNAL_PLAN_SHAPES["core/publish@1"].phases) {
      expect(step).toMatchObject({ disposition: "scheduled", phase: phase.id });
      store.acknowledgePhase(phase.id);
      step = await bridge.resumeReadyAttempt();
    }
    expect(step).toMatchObject({ disposition: "settled", next_stage_id: "next" });
    expect(store.run.current_subject).toBe(OUTPUT);
    const successor = [...store.attempts.values()].find(({ id }) => id !== "attempt-1")!;
    expect(successor).toMatchObject({ input_subject: OUTPUT, scope: { stage_id: "next" } });

    const waitPrepared = await realWaitBinding().prepare({
      run: store.run,
      attempt: successor,
      stage: currentManifest.stages.find(({ id }) => id === "next")! as never,
      context: { records: new Map(), checkpoints: new Map() },
      bundle: definitionBundle,
      manifest: currentManifest,
    });
    expect(waitPrepared.phases[0]!.effects[0]).toMatchObject({
      subject: OUTPUT,
      payload: { subject: OUTPUT },
    });
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

  it("recovers a rejected publication integration into failure cleanup without promotion or replay", async () => {
    const definitionBundle = bundle();
    const currentManifest = manifest({
      bundle_hash: digestCanonicalJson(definitionBundle),
      external_kind: "core/publish@1",
    });
    const store = new MemoryExternalStore(currentManifest, PRIVATE_CANDIDATE);
    const bridge = coordinator({
      store,
      definition_bundle: definitionBundle,
      plans: [binding("core/publish@1")],
    });

    await expect(bridge.executeLeasedAttempt(store.leased())).resolves.toMatchObject({
      disposition: "scheduled",
      phase: "integrate-checkpoint",
    });
    store.acknowledgePhase("integrate-checkpoint", "rejected", "operator_resolution");
    const rejected = store.schedules
      .get("external-schedule:attempt-1:integrate-checkpoint")!.effects[0]!.delivery!;
    store.throwAfterApply = (transition) =>
      transition.transition_id.startsWith("external-record-");

    await expect(bridge.resumeReadyAttempt()).rejects.toThrow(/lost after durable transition/);
    expect(store.attempts.get("attempt-1")).toMatchObject({
      status: "recorded",
      input_subject: PRIVATE_CANDIDATE,
      output_subject: null,
    });
    expect([...store.schedules.keys()]).toEqual([
      "external-schedule:attempt-1:integrate-checkpoint",
    ]);
    expect(rejected.payload).toMatchObject({
      inline: {
        provider: "operator",
        observed_via: "operator_resolution",
        result: { schema: "openthrottle.operator-effect-rejection/v1" },
      },
    });
    const result = [...store.records.values()].find((record) => record.kind === "result")!;
    expect(result.payload).toMatchObject({
      inline: {
        outcome: "failure",
        delivery_record_ids: [rejected.id],
      },
    });

    await expect(bridge.resumeReadyAttempt()).resolves.toMatchObject({
      disposition: "settled",
      outcome: "failure",
      next_stage_id: "ot_runtime_stop_failed",
    });
    expect([...store.records.values()].filter(({ kind }) => kind === "result")).toHaveLength(1);
    expect([...store.schedules.keys()]).toEqual([
      "external-schedule:attempt-1:integrate-checkpoint",
    ]);
    const successor = [...store.attempts.values()].find(({ id }) => id !== "attempt-1")!;
    expect(successor).toMatchObject({
      input_subject: PRIVATE_CANDIDATE,
      scope: { stage_id: "ot_runtime_stop_failed" },
    });
    const decision = store.records.get(store.attempts.get("attempt-1")!.decision_record_id!)!;
    expect(decision.kind).toBe("decision");
    if (decision.kind !== "decision") throw new Error("missing external settlement decision");
    expect(decision.input_record_ids).toEqual([result.id, rejected.id].sort());
  });

  it("recovers a rejected update push into failure cleanup without scheduling a pull request", async () => {
    const definitionBundle = bundle();
    const currentManifest = manifest({
      bundle_hash: digestCanonicalJson(definitionBundle),
      external_kind: "core/publish@1",
    });
    const store = new MemoryExternalStore(currentManifest);
    const bridge = coordinator({
      store,
      definition_bundle: definitionBundle,
      plans: [binding("core/publish@1")],
    });

    await bridge.executeLeasedAttempt(store.leased());
    store.acknowledgePhase("integrate-checkpoint");
    await expect(bridge.resumeReadyAttempt()).resolves.toMatchObject({
      disposition: "scheduled",
      phase: "push-checkpoint",
    });
    store.acknowledgePhase("push-checkpoint", "rejected");
    const rejected = store.schedules
      .get("external-schedule:attempt-1:push-checkpoint")!.effects[0]!.delivery!;
    store.throwAfterApply = (transition) =>
      transition.transition_id.startsWith("external-record-");

    await expect(bridge.resumeReadyAttempt()).rejects.toThrow(/lost after durable transition/);
    expect(store.attempts.get("attempt-1")).toMatchObject({
      status: "recorded",
      output_subject: OUTPUT,
    });
    expect(store.schedules.has("external-schedule:attempt-1:pull-request")).toBe(false);
    const result = [...store.records.values()].find((record) => record.kind === "result")!;
    expect(result.payload).toMatchObject({
      inline: {
        outcome: "failure",
        delivery_record_ids: expect.arrayContaining([rejected.id]),
      },
    });

    await expect(bridge.resumeReadyAttempt()).resolves.toMatchObject({
      disposition: "settled",
      outcome: "failure",
      next_stage_id: "ot_runtime_stop_failed",
    });
    expect([...store.records.values()].filter(({ kind }) => kind === "result")).toHaveLength(1);
    expect(store.schedules.has("external-schedule:attempt-1:pull-request")).toBe(false);
    const successor = [...store.attempts.values()].find(({ id }) => id !== "attempt-1")!;
    expect(successor).toMatchObject({
      input_subject: OUTPUT,
      scope: { stage_id: "ot_runtime_stop_failed" },
    });
    const decision = store.records.get(store.attempts.get("attempt-1")!.decision_record_id!)!;
    expect(decision.kind).toBe("decision");
    if (decision.kind !== "decision") throw new Error("missing external settlement decision");
    const deliveryIds = [...store.schedules.values()]
      .flatMap((schedule) => schedule.effects.map(({ delivery }) => delivery!.id));
    expect(decision.input_record_ids).toEqual([
      result.id,
      ...deliveryIds,
    ].sort());
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

  it("paginates past 100 malformed continuations without starving the next ready external Attempt", async () => {
    const definitionBundle = bundle();
    const currentManifest = manifest({
      bundle_hash: digestCanonicalJson(definitionBundle),
      external_kind: "core/provider-wait@1",
      stage_kind: "wait",
    });
    const store = new MemoryExternalStore(currentManifest);
    const initial = coordinator({
      store,
      definition_bundle: definitionBundle,
      plans: [binding("core/provider-wait@1")],
    });
    await initial.executeLeasedAttempt(store.leased());
    store.acknowledgePhase("observe");
    const malformed = Array.from({ length: 125 }, (_, index) => ({
      updated_at: "2026-08-20T11:59:00.000Z",
      pipeline_run_id: `run-corrupt-${String(index).padStart(3, "0")}`,
      attempt_id: `attempt-corrupt-${String(index).padStart(3, "0")}`,
    }));
    const ordered = [
      ...malformed,
      { updated_at: NOW, pipeline_run_id: "run-1", attempt_id: "attempt-1" },
    ];
    const fairStore: KernelExternalBoundaryStore = {
      loadExactReductionView: (request) => {
        if (request.pipeline_run_id.startsWith("run-corrupt-")) {
          throw new Error("corrupt external continuation");
        }
        return store.loadExactReductionView(request);
      },
      applyAtomicTransition: (transition) => store.applyAtomicTransition(transition),
      loadAttemptRequestInputs: (request) => store.loadAttemptRequestInputs(request),
      findExternalSchedule: (request) => store.findExternalSchedule(request),
      listReadyExternalAttempts: async (input: {
        limit: number;
        after?: { updated_at: string; pipeline_run_id: string; attempt_id: string };
      }) => {
        const start = input.after === undefined
          ? 0
          : ordered.findIndex((candidate) =>
            candidate.updated_at === input.after!.updated_at &&
            candidate.pipeline_run_id === input.after!.pipeline_run_id &&
            candidate.attempt_id === input.after!.attempt_id) + 1;
        if (input.after !== undefined && start === 0) throw new Error("unknown continuation cursor");
        return ordered.slice(start, start + input.limit);
      },
    };
    const resumed = coordinator({
      store: fairStore,
      definition_bundle: definitionBundle,
      plans: [binding("core/provider-wait@1")],
    });

    await expect(resumed.resumeReadyAttempt()).resolves.toMatchObject({
      disposition: "settled",
      outcome: "success",
    });
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

  it("resumes integration after crashes immediately after promotion and external recording", async () => {
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
    store.acknowledgePhase("integrate-checkpoint");
    store.throwAfterApply = (transition) =>
      transition.transition_id.startsWith("external-integration-advance-");

    await expect(bridge.resumeReadyAttempt()).rejects.toThrow(/lost after durable transition/);
    expect(store.attempts.get("attempt-1")).toMatchObject({
      status: "work_complete",
      checkpoint_id: "checkpoint-integration",
      output_subject: OUTPUT,
      result_record_id: null,
    });
    await expect(bridge.resumeReadyAttempt()).resolves.toMatchObject({
      disposition: "scheduled",
      phase: "push-checkpoint",
    });

    store.acknowledgePhase("push-checkpoint");
    store.throwAfterApply = (transition) =>
      transition.transition_id.startsWith("external-record-");
    await expect(bridge.resumeReadyAttempt()).rejects.toThrow(/lost after durable transition/);
    expect(store.attempts.get("attempt-1")).toMatchObject({
      status: "recorded",
      checkpoint_id: "checkpoint-integration",
      output_subject: OUTPUT,
      result_record_id: expect.stringMatching(/^result-/),
    });
    await expect(bridge.resumeReadyAttempt()).resolves.toMatchObject({
      disposition: "settled",
      outcome: "success",
    });
  });

  it("recovers publish after durable compaction promotion before phase one scheduling", async () => {
    const definitionBundle = bundle();
    const currentManifest = manifest({
      bundle_hash: digestCanonicalJson(definitionBundle),
      external_kind: "core/publish@1",
    });
    const store = new MemoryExternalStore(currentManifest, PRIVATE_CANDIDATE);
    const bridge = coordinator({
      store,
      definition_bundle: definitionBundle,
      plans: [binding("core/publish@1")],
    });
    await bridge.executeLeasedAttempt(store.leased());
    store.acknowledgePhase("integrate-checkpoint");
    store.throwAfterApply = (transition) =>
      transition.transition_id.startsWith("external-integration-advance-");

    await expect(bridge.resumeReadyAttempt()).rejects.toThrow(/lost after durable transition/);
    expect(store.run.current_subject).toBe(OUTPUT);
    expect(store.attempts.get("attempt-1")).toMatchObject({
      input_subject: PRIVATE_CANDIDATE,
      output_subject: OUTPUT,
      checkpoint_id: "checkpoint-integration",
      status: "work_complete",
    });
    expect(store.checkpoints.get("checkpoint-integration")).toMatchObject({
      input_subject: PRIVATE_CANDIDATE,
      output_subject: OUTPUT,
    });
    expect(store.schedules.get("external-schedule:attempt-1:integrate-checkpoint")
      ?.effects[0]?.delivery?.payload).toMatchObject({
        inline: { result: { input_subject: SUBJECT, output_subject: OUTPUT } },
      });

    await expect(bridge.resumeReadyAttempt()).resolves.toMatchObject({
      disposition: "scheduled",
      phase: "push-checkpoint",
    });
    expect(store.run.current_subject).toBe(OUTPUT);
    expect(store.schedules.get("external-schedule:attempt-1:push-checkpoint")?.effects[0]?.intent)
      .toMatchObject({ subject: OUTPUT });
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

  it("cleans a poisoned sandbox, provisions a distinct runtime, and retries the exact input subject", async () => {
    const definitionBundle = bundle();
    const currentManifest = manifest({
      bundle_hash: digestCanonicalJson(definitionBundle),
      external_kind: "core/publish@1",
    });
    const store = new MemoryExternalStore(currentManifest, PRIVATE_CANDIDATE);
    const runtimeDelivery = (
      id: string,
      effectKind: "daytona/create-sandbox@1" | "daytona/start-sandbox@1",
      sandboxId: string,
    ): DeliveryRecord => ({
      schema: EXECUTION_RECORD_SCHEMA,
      id,
      kind: "delivery",
      pipeline_run_id: store.run.id,
      effect_id: `effect-${id}`,
      idempotency_key: `key-${id}`,
      external_identity: `daytona:${RUNTIME_IDENTITY}`,
      status: "confirmed",
      payload_schema: "openthrottle.effect-delivery/v1",
      payload: { inline: {
        effect_kind: effectKind,
        provider: "daytona",
        result: { identity: RUNTIME_IDENTITY, sandbox_id: sandboxId, resource_state: "started" },
      } },
      created_at: NOW,
    });
    const oldCreate = runtimeDelivery("delivery-old-create", "daytona/create-sandbox@1", "sandbox-poisoned");
    const oldStart = runtimeDelivery("delivery-old-start", "daytona/start-sandbox@1", "sandbox-poisoned");
    const failedAttempt: KernelAttempt = {
      ...initialAttempt(currentManifest, PRIVATE_CANDIDATE),
      id: "attempt-failed",
      scope: {
        kind: "loop_item",
        stage_id: "external",
        parent_attempt_id: "attempt-wave",
        loop_id: "units",
        item_id: "unit-a",
        item_index: 0,
      },
      context_record_ids: [oldCreate.id, oldStart.id].sort(),
      status: "failed",
      version: 2,
      lease: null,
    };
    const siblingAttempt: KernelAttempt = {
      ...initialAttempt(currentManifest, SUBJECT),
      id: "attempt-sibling",
      scope: {
        kind: "loop_item",
        stage_id: "external",
        parent_attempt_id: "attempt-wave",
        loop_id: "units",
        item_id: "unit-b",
        item_index: 1,
      },
      context_record_ids: [oldCreate.id, oldStart.id].sort(),
      status: "failed",
      version: 1,
      lease: null,
    };
    const failedFrontier = createPipelineDecisionRecord({
      attempt: failedAttempt,
      result: null,
      evaluated: {
        evaluator: sandboxRecoveryFrontierEvaluator(failedAttempt.id),
        outcome: "retryable_infrastructure_failure",
        reason: sandboxRecoveryFrontierReason([]),
      },
      created_at: NOW,
    });
    const siblingFrontier = createPipelineDecisionRecord({
      attempt: siblingAttempt,
      result: null,
      evaluated: {
        evaluator: sandboxRecoveryFrontierEvaluator(siblingAttempt.id),
        outcome: "retryable_infrastructure_failure",
        reason: sandboxRecoveryFrontierReason([frontierMemberKey(failedAttempt)]),
      },
      created_at: NOW,
    });
    const recovery = createPipelineDecisionRecord({
      attempt: failedAttempt,
      result: null,
      additional_input_records: [oldCreate, oldStart, failedFrontier, siblingFrontier],
      evaluated: {
        evaluator: sandboxRecoveryEvaluator(failedAttempt.id),
        outcome: "retryable_infrastructure_failure",
        reason: "sandbox_fatal_enospc: no space left on device",
      },
      created_at: NOW,
    });
    const cleanupAttempt: KernelAttempt = {
      ...initialAttempt(currentManifest, PRIVATE_CANDIDATE),
      scope: { kind: "stage", stage_id: runtimeCleanupStageId("failed") },
      context_record_ids: [
        oldCreate.id,
        oldStart.id,
        recovery.id,
        failedFrontier.id,
        siblingFrontier.id,
      ].sort(),
    };
    store.attempts.clear();
    store.attempts.set(failedAttempt.id, failedAttempt);
    store.attempts.set(siblingAttempt.id, siblingAttempt);
    store.attempts.set(cleanupAttempt.id, cleanupAttempt);
    for (const record of [
      oldCreate,
      oldStart,
      recovery,
      failedFrontier,
      siblingFrontier,
    ]) store.records.set(record.id, record);
    store.run = {
      ...store.run,
      cursor: compileKernelCursor({
        stage_id: runtimeCleanupStageId("failed"),
        version: 3,
        attempts: [cleanupAttempt],
      }),
      version: 4,
      active_attempt_versions: { [cleanupAttempt.id]: cleanupAttempt.version },
    };
    const lifecyclePlans = createKernelExternalPlanBindings({
      environments: {
        loadExactRunEnvironment: () => ({
          pipeline_run_id: store.run.id,
          work_item_id: "work-1",
          repository_registration_id: "repo-1",
          repository: "owner/repo",
          base_branch: "main",
          runtime_snapshot: "snapshot-1",
          control_provider: "github",
          source_provider: "github",
          source_id: "issue-1",
          source_reference: "owner/repo#1",
          title: "Sandbox recovery proof",
          current_subject: PRIVATE_CANDIDATE,
        }),
      },
      blob_store: {} as never,
    }).filter(({ external_kind }) => [
      "core/daytona-cleanup@1", "core/daytona-provision@1",
    ].includes(external_kind));
    const bridge = new KernelExternalBoundaryCoordinator({
      store,
      definition_bundles: { resolveExactDefinitionBundle: async () => definitionBundle },
      plans: createKernelExternalStagePlanRegistry({
        effects: primitiveRegistry(),
        plans: lifecyclePlans,
      }),
      now: () => NOW,
    });
    const confirmLifecyclePhase = (
      attemptId: string,
      phase: string,
      sandboxId: string | null,
    ) => {
      store.acknowledgePhase(phase, "confirmed", "provider", attemptId);
      const key = `external-schedule:${attemptId}:${phase}`;
      const schedule = store.schedules.get(key)!;
      const effects = schedule.effects.map(({ intent, delivery }) => {
        const authority = intent.payload as Record<string, JsonValue>;
        const exact: DeliveryRecord = {
          ...delivery!,
          payload_schema: "openthrottle.effect-delivery/v1",
          payload: { inline: {
            effect_kind: intent.kind,
            provider: "daytona",
            result: {
              identity: authority.identity,
              sandbox_id: sandboxId,
              resource_state: sandboxId === null ? "absent" : "started",
            },
          } },
        };
        store.records.set(exact.id, exact);
        return { intent, delivery: exact };
      });
      store.schedules.set(key, { ...schedule, effects });
    };

    await bridge.executeLeasedAttempt(store.leased());
    confirmLifecyclePhase(cleanupAttempt.id, "cleanup", null);
    await bridge.resumeAttempt({ pipeline_run_id: store.run.id, attempt_id: cleanupAttempt.id });

    const provision = [...store.attempts.values()].find(
      ({ scope, status }) => scope.stage_id === RUNTIME_PROVISION_STAGE_ID && status === "pending",
    )!;
    expect(provision).toBeDefined();
    store.attempts.set(provision.id, {
      ...provision,
      lease: {
        id: "lease-reprovision",
        generation: 0,
        worker_id: "external-worker",
        purpose: "work",
        expires_at: "2026-08-20T12:10:00.000Z",
        started: false,
      },
    });
    await bridge.executeLeasedAttempt(store.leased(provision.id));
    const createSchedule = store.schedules.get(`external-schedule:${provision.id}:create`)!;
    expect(createSchedule.effects[0]!.intent.target).not.toBe(`daytona:${RUNTIME_IDENTITY}`);
    confirmLifecyclePhase(provision.id, "create", "sandbox-fresh");
    await bridge.resumeAttempt({ pipeline_run_id: store.run.id, attempt_id: provision.id });
    confirmLifecyclePhase(provision.id, "start", "sandbox-fresh");
    await bridge.resumeAttempt({ pipeline_run_id: store.run.id, attempt_id: provision.id });

    const retries = [...store.attempts.values()].filter(
      ({ id, scope, status }) =>
        id !== failedAttempt.id && id !== siblingAttempt.id &&
        scope.stage_id === "external" && status === "pending",
    );
    expect(retries).toHaveLength(2);
    const retry = retries.find(({ scope }) =>
      scope.kind === "loop_item" && scope.item_id === "unit-a")!;
    const siblingRetry = retries.find(({ scope }) =>
      scope.kind === "loop_item" && scope.item_id === "unit-b")!;
    expect(retry).toMatchObject({
      input_subject: PRIVATE_CANDIDATE,
      work_retry_ordinal: 1,
      native_session_id: null,
    });
    expect(siblingRetry).toMatchObject({
      input_subject: SUBJECT,
      work_retry_ordinal: 0,
      native_session_id: null,
    });
    expect(store.run.cursor.frontier.find(({ attempt_id }) => attempt_id === siblingRetry.id))
      .toMatchObject({ depends_on: [frontierMemberKey(retry)] });
    const retryRecords = retry.context_record_ids.map((id) => store.records.get(id)!);
    expect(retryRecords.filter((record) => record.id === oldCreate.id || record.id === oldStart.id)).toEqual([]);
    expect(retryRecords.filter((record) => record.kind === "delivery" &&
      "inline" in record.payload && (record.payload.inline as Record<string, unknown>).provider === "daytona"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ payload: { inline: expect.objectContaining({
          result: expect.objectContaining({ sandbox_id: "sandbox-fresh" }),
        }) } }),
      ]));

    const failedRetry: KernelAttempt = {
      ...retry,
      status: "failed",
      version: retry.version + 1,
      lease: null,
    };
    const secondRecovery = createPipelineDecisionRecord({
      attempt: failedRetry,
      result: null,
      evaluated: {
        evaluator: sandboxRecoveryEvaluator(failedRetry.id),
        outcome: "retryable_infrastructure_failure",
        reason: "sandbox_fatal_enospc: fresh sandbox also exhausted its storage",
      },
      created_at: NOW,
    });
    store.attempts.set(failedRetry.id, failedRetry);
    store.records.set(secondRecovery.id, secondRecovery);
    let secondProvision = createPendingKernelAttempt({
      id: "attempt-second-reprovision",
      pipeline_run_id: store.run.id,
      scope: { kind: "stage", stage_id: RUNTIME_PROVISION_STAGE_ID },
      input_subject: store.run.current_subject,
      bundle: definitionBundle,
      manifest: currentManifest,
      action_inputs: {
        task_prompt: "Provision another exact fresh sandbox.",
        context: { records: [secondRecovery], checkpoints: [] },
      },
    });
    secondProvision = {
      ...secondProvision,
      lease: {
        id: "lease-second-reprovision",
        generation: 0,
        worker_id: "external-worker",
        purpose: "work",
        expires_at: "2026-08-20T12:15:00.000Z",
        started: false,
      },
    };
    store.attempts.set(secondProvision.id, secondProvision);
    store.run = {
      ...store.run,
      cursor: compileKernelCursor({
        stage_id: RUNTIME_PROVISION_STAGE_ID,
        version: store.run.cursor.version + 1,
        attempts: [secondProvision],
      }),
      version: store.run.version + 1,
      active_attempt_versions: { [secondProvision.id]: secondProvision.version },
      active_effect_versions: {},
    };

    await bridge.executeLeasedAttempt(store.leased(secondProvision.id));
    confirmLifecyclePhase(secondProvision.id, "create", "sandbox-fresh-2");
    await bridge.resumeAttempt({ pipeline_run_id: store.run.id, attempt_id: secondProvision.id });
    confirmLifecyclePhase(secondProvision.id, "start", "sandbox-fresh-2");
    await bridge.resumeAttempt({ pipeline_run_id: store.run.id, attempt_id: secondProvision.id });

    const secondRetry = [...store.attempts.values()].find(({ id, scope, status }) =>
      id !== retry.id && scope.kind === "loop_item" && scope.item_id === "unit-a" &&
      status === "pending" && scope.stage_id === "external" &&
      store.run.active_attempt_versions[id] !== undefined)!;
    expect(secondRetry.work_retry_ordinal).toBe(2);
    const secondRetryRecords = secondRetry.context_record_ids.map((id) => store.records.get(id)!);
    const immediateRecovery = exactSandboxRecoveryRecord(secondRetryRecords);
    expect(immediateRecovery).not.toBeNull();
    expect(sandboxRecoveryAttemptId(immediateRecovery!)).toBe(retry.id);
  });

  it("enters fresh-sandbox recovery when integration settles a sandbox-fatal absence", async () => {
    const definitionBundle = bundle();
    const currentManifest = manifest({
      bundle_hash: digestCanonicalJson(definitionBundle),
      external_kind: "core/publish@1",
    });
    const store = new MemoryExternalStore(currentManifest, PRIVATE_CANDIDATE);
    const runtimeDelivery = (
      id: string,
      effectKind: "daytona/create-sandbox@1" | "daytona/start-sandbox@1",
    ): DeliveryRecord => ({
      schema: EXECUTION_RECORD_SCHEMA,
      id,
      kind: "delivery",
      pipeline_run_id: store.run.id,
      effect_id: `effect-${id}`,
      idempotency_key: `key-${id}`,
      external_identity: `daytona:${RUNTIME_IDENTITY}`,
      status: "confirmed",
      payload_schema: "openthrottle.effect-delivery/v1",
      payload: { inline: {
        effect_kind: effectKind,
        provider: "daytona",
        observed_via: "reconciliation",
        result: {
          identity: RUNTIME_IDENTITY,
          sandbox_id: "sandbox-deleted",
          resource_state: "started",
        },
      } },
      created_at: NOW,
    });
    const create = runtimeDelivery("delivery-runtime-create", "daytona/create-sandbox@1");
    const start = runtimeDelivery("delivery-runtime-start", "daytona/start-sandbox@1");
    store.records.set(create.id, create);
    store.records.set(start.id, start);
    store.attempts.set("attempt-1", {
      ...store.attempts.get("attempt-1")!,
      context_record_ids: [create.id, start.id].sort(),
    });
    const plan: KernelExternalStagePlanBinding = {
      ...binding("core/publish@1"),
      evaluate: ({ schedules }) => schedules.some((schedule) =>
        schedule.effects.some(({ delivery }) => delivery?.status === "rejected"))
        ? {
          outcome: "retryable_infrastructure_failure",
          summary: "publication integration lost its sandbox",
        }
        : { outcome: "success", summary: "published" },
    };
    const bridge = coordinator({ store, definition_bundle: definitionBundle, plans: [plan] });

    await bridge.executeLeasedAttempt(store.leased());
    store.acknowledgePhase("integrate-checkpoint", "rejected");
    const schedule = store.schedules.get("external-schedule:attempt-1:integrate-checkpoint")!;
    const { intent, delivery } = schedule.effects[0]!;
    const fatalDelivery: DeliveryRecord = {
      ...delivery!,
      payload: { inline: {
        effect_kind: intent.kind,
        provider: "daytona",
        observed_via: "reconciliation",
        result: {
          schema: "openthrottle.daytona-integration-delivery/v1",
          state: "retryable_failure",
          pipeline_run_id: intent.pipeline_run_id,
          attempt_id: "attempt-1",
          effect_id: intent.id,
          idempotency_key: intent.idempotency_key,
          input_subject: PRIVATE_CANDIDATE,
          output_subject: null,
          checkpoint_id: null,
          checkpoint_payload_schema: null,
          checkpoint_blob: null,
          reason: "sandbox_fatal_absent: integration runtime sandbox was absent twice",
        },
      } },
    };
    store.records.set(fatalDelivery.id, fatalDelivery);
    store.schedules.set(schedule.semantic_key, {
      ...schedule,
      effects: [{ intent, delivery: fatalDelivery }],
    });

    await expect(bridge.resumeAttempt({
      pipeline_run_id: store.run.id,
      attempt_id: "attempt-1",
    })).resolves.toMatchObject({
      disposition: "settled",
      outcome: "retryable_infrastructure_failure",
      next_stage_id: runtimeStopStageId("failed"),
    });
    expect(store.attempts.get("attempt-1")).toMatchObject({ status: "failed" });
    const stop = [...store.attempts.values()].find(
      ({ scope, status }) => scope.stage_id === runtimeStopStageId("failed") && status === "pending",
    );
    expect(stop).toBeDefined();
    const recovery = [...store.records.values()].find((record) =>
      record.kind === "decision" && record.reducer === sandboxRecoveryEvaluator("attempt-1"));
    expect(recovery).toMatchObject({
      input_record_ids: expect.arrayContaining([fatalDelivery.id, create.id, start.id]),
    });
  });
});
