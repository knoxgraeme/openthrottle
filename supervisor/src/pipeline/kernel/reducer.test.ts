import { describe, expect, it } from "vitest";
import {
  ATTEMPT_CHECKPOINT_SCHEMA,
  COMPILED_PIPELINE_MANIFEST_SCHEMA,
  EFFECT_INTENT_SCHEMA,
  EXECUTION_RECORD_SCHEMA,
  RUNTIME_PROVISION_STAGE_ID,
  canonicalJson,
  expandCompiledRuntimeLifecycle,
  runtimeStopStageId,
  type AttemptCheckpoint,
  type CompiledPipelineManifest,
  type DecisionRecord,
  type DeliveryRecord,
  type EffectIntent,
  type ExecutionRecord,
  type ResultRecord,
} from "@openthrottle/contracts";
import {
  assertImmutableEffectReplay,
  authorizeEffectIntent,
  reconcileEffectIntent,
} from "./effect-intent.js";
import {
  compileKernelCursor,
  frontierMemberKey,
  reduceKernelCommand,
} from "./reducer.js";
import {
  transitionApplicationDisposition,
  type AtomicTransitionObservedState,
} from "./store.js";
import {
  KERNEL_ATTEMPT_SCHEMA,
  KERNEL_RUN_SCHEMA,
  type AtomicTransitionBundle,
  type AttemptScope,
  type KernelAttempt,
  type KernelCommand,
  type KernelRun,
} from "./types.js";

const sha = (character: string): string => character.repeat(64);
const subject = (character: string): string => character.repeat(40);

function manifest(options: {
  authority?: "inspect" | "edit";
  firstTerminal?: boolean;
} = {}): CompiledPipelineManifest {
  const firstTerminal = options.firstTerminal ?? false;
  return {
    schema: COMPILED_PIPELINE_MANIFEST_SCHEMA,
    pipeline_id: "core/test",
    pipeline_version: 1,
    entry_stage: "work",
    definition_bundle_hash: sha("b"),
    compiler_version: "definition-compiler/v1",
    runtime_capability_digest: sha("c"),
    stages: [
      {
        id: "work",
        kind: "agent",
        engine: "codex",
        agent_id: "worker",
        repository_authority: options.authority ?? "edit",
        skills: ["work"],
        entry_skill: "work",
        eval: "result",
        on: {
          success: firstTerminal ? { terminal: "completed" } : { to: "verify" },
          no_change: { terminal: "no_change" },
          repair: { to: "work", max_reentries: 1, on_exhausted: "needs_human" },
          failure: { terminal: "failed" },
        },
      },
      {
        id: "verify",
        kind: "agent",
        engine: "codex",
        agent_id: "reviewer",
        repository_authority: "inspect",
        skills: ["review"],
        entry_skill: "review",
        eval: "result",
        on: { success: { terminal: "completed" }, failure: { terminal: "failed" } },
      },
    ],
  };
}

function externalManifest(kind: "effect" | "wait" = "effect"): CompiledPipelineManifest {
  return {
    ...manifest(),
    entry_stage: "external",
    stages: [
      (kind === "effect"
        ? {
          id: "external",
          kind: "effect",
          effect: "core/publish@1",
          on: { success: { to: "verify" }, failure: { terminal: "failed" } },
        }
        : {
          id: "external",
          kind: "wait",
          wait: "core/provider-wait@1",
          on: { success: { to: "verify" }, failure: { terminal: "failed" } },
        }),
      manifest().stages[1]!,
    ],
  };
}

function commandManifest(): CompiledPipelineManifest {
  return {
    ...manifest(),
    entry_stage: "command",
    stages: [{
      id: "command",
      kind: "command",
      command: "test",
      on: { success: { terminal: "completed" }, failure: { terminal: "failed" } },
    }],
  };
}

function stageScope(stageId = "work"): AttemptScope {
  return { kind: "stage", stage_id: stageId };
}

function loopScope(itemId = "unit-a", itemIndex = 0, stageId = "work"): AttemptScope {
  return {
    kind: "loop_item",
    stage_id: stageId,
    parent_attempt_id: "parent",
    loop_id: "units",
    item_id: itemId,
    item_index: itemIndex,
  };
}

function fanoutScope(memberId: string, memberIndex: number, stageId = "verify"): AttemptScope {
  return {
    kind: "fanout_member",
    stage_id: stageId,
    parent_attempt_id: "attempt-1",
    fanout_id: "reviewers",
    member_id: memberId,
    member_index: memberIndex,
  };
}

function attempt(options: Partial<KernelAttempt> & {
  id?: string;
  scope?: AttemptScope;
} = {}): KernelAttempt {
  return {
    schema: KERNEL_ATTEMPT_SCHEMA,
    id: options.id ?? "attempt-1",
    pipeline_run_id: "run-1",
    scope: options.scope ?? stageScope(),
    repository_authority: options.repository_authority ?? "edit",
    request_hash: options.request_hash ?? sha("a"),
    definition_bundle_hash: sha("b"),
    input_subject: options.input_subject ?? subject("1"),
    context_record_ids: options.context_record_ids ?? [],
    context_checkpoint_ids: options.context_checkpoint_ids ?? [],
    output_subject: options.output_subject ?? null,
    native_session_id: options.native_session_id ?? null,
    status: options.status ?? "pending",
    version: options.version ?? 0,
    work_retry_ordinal: options.work_retry_ordinal ?? 0,
    result_correction_count: options.result_correction_count ?? 0,
    result_correction_deadline: options.result_correction_deadline ?? null,
    lease: options.lease ?? null,
    checkpoint_id: options.checkpoint_id ?? null,
    result_record_id: options.result_record_id ?? null,
    decision_record_id: options.decision_record_id ?? null,
    pending_result: options.pending_result ?? null,
  };
}

function claimAttempt(
  current: KernelAttempt,
  currentRun: KernelRun,
  input: {
    purpose: "work" | "result_correction";
    leaseId: string;
    workerId?: string;
    expiresAt?: string;
  },
): { current: KernelAttempt; currentRun: KernelRun } {
  const next: KernelAttempt = {
    ...current,
    version: current.version + 1,
    result_correction_count: current.result_correction_count +
      (input.purpose === "result_correction" ? 1 : 0),
    lease: {
      id: input.leaseId,
      generation: 0,
      worker_id: input.workerId ?? "worker-1",
      purpose: input.purpose,
      expires_at: input.expiresAt ?? "2026-08-20T00:05:00.000Z",
      started: false,
    },
  };
  return {
    current: next,
    currentRun: {
      ...currentRun,
      version: currentRun.version + 1,
      active_attempt_versions: {
        ...currentRun.active_attempt_versions,
        [next.id]: next.version,
      },
    },
  };
}

function run(
  current: KernelAttempt | null,
  options: Partial<KernelRun> = {},
  frontierAttempts: readonly KernelAttempt[] = current ? [current] : [],
): KernelRun {
  if (!options.cursor && frontierAttempts.length === 0) {
    throw new Error("test run requires an explicit cursor or frontier attempt");
  }
  return {
    schema: KERNEL_RUN_SCHEMA,
    id: "run-1",
    pipeline_id: "core/test",
    definition_bundle_hash: sha("b"),
    current_subject: options.current_subject ?? subject("1"),
    status: options.status ?? "pending",
    terminal_outcome: options.terminal_outcome ?? null,
    cursor: options.cursor ?? compileKernelCursor({
      stage_id: current?.scope.stage_id ?? frontierAttempts[0]!.scope.stage_id,
      version: 0,
      attempts: frontierAttempts,
    }),
    version: options.version ?? 0,
    work_retry_limit: options.work_retry_limit ?? 2,
    result_correction_limit: options.result_correction_limit ?? 2,
    active_attempt_versions: options.active_attempt_versions ??
      (current ? { [current.id]: current.version } : {}),
    active_effect_versions: options.active_effect_versions ?? {},
    checkpoint_ids: options.checkpoint_ids ?? {},
  };
}

function checkpoint(
  current: KernelAttempt,
  outputSubject: string | null,
  id = "checkpoint-1",
): AttemptCheckpoint {
  return {
    schema: ATTEMPT_CHECKPOINT_SCHEMA,
    id,
    pipeline_run_id: current.pipeline_run_id,
    attempt_id: current.id,
    request_hash: current.request_hash,
    definition_bundle_hash: current.definition_bundle_hash,
    input_subject: current.input_subject,
    output_subject: outputSubject,
    native_session_id: "session-1",
    payload_schema: "checkpoint/v1",
    payload: { inline: { complete: true } },
    captured_at: "2026-08-20T00:00:00.000Z",
  };
}

function resultRecord(current: KernelAttempt, id = "result-1"): ResultRecord {
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id,
    kind: "result",
    pipeline_run_id: current.pipeline_run_id,
    attempt_id: current.id,
    request_hash: current.request_hash,
    definition_bundle_hash: current.definition_bundle_hash,
    input_subject: current.input_subject,
    output_subject: current.output_subject,
    original_candidate_hash: sha("d"),
    normalized_candidate_hash: sha("e"),
    payload_schema: "result/v1",
    payload: { inline: { outcome: "success", summary: "done" } },
    created_at: "2026-08-20T00:00:01.000Z",
  };
}

function decisionRecord(
  inputRecordIds: readonly string[],
  id = "decision-1",
): DecisionRecord {
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id,
    kind: "decision",
    pipeline_run_id: "run-1",
    reducer: "core/advance@1",
    input_record_ids: [...inputRecordIds],
    payload_schema: "decision/v1",
    payload: { inline: { accepted: true } },
    created_at: "2026-08-20T00:00:02.000Z",
  };
}

function externalScheduleDecision(input: {
  attempt_id: string;
  phase: string;
  input_record_ids?: readonly string[];
  id?: string;
}): DecisionRecord {
  const semanticKey = `external-schedule:${input.attempt_id}:${input.phase}`;
  return {
    ...decisionRecord(input.input_record_ids ?? [], input.id ?? `decision-${input.phase}`),
    reducer: "core/external-schedule@1",
    payload_schema: "openthrottle.external-schedule/v1",
    payload: {
      inline: {
        schema: "openthrottle.external-schedule/v1",
        semantic_key: semanticKey,
        attempt_id: input.attempt_id,
        phase: input.phase,
      },
    },
  };
}

function deliveryRecord(effect: EffectIntent): DeliveryRecord {
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: "delivery-1",
    kind: "delivery",
    pipeline_run_id: effect.pipeline_run_id,
    effect_id: effect.id,
    idempotency_key: effect.idempotency_key,
    external_identity: effect.target,
    status: "confirmed",
    payload_schema: "delivery/v1",
    payload: { inline: { accepted: true } },
    created_at: "2026-08-20T00:00:03.000Z",
  };
}

function runtimeDelivery(kind: "create" | "start" | "cleanup"): DeliveryRecord {
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: `delivery-runtime-${kind}`,
    kind: "delivery",
    pipeline_run_id: "run-1",
    effect_id: `effect-runtime-${kind}`,
    idempotency_key: `run-1:runtime:${kind}`,
    external_identity: "daytona:sandbox-1",
    status: "confirmed",
    payload_schema: "openthrottle.effect-delivery/v1",
    payload: { inline: {
      effect_kind: `daytona/${kind === "cleanup" ? "cleanup" : kind}-sandbox@1`,
      provider: "daytona",
      observed_via: "reconciliation",
      result: { sandbox_id: "sandbox-1" },
    } },
    created_at: "2026-08-20T00:00:03.000Z",
  };
}

function manifestWithRuntimeStages(options: { firstTerminal?: boolean } = {}): CompiledPipelineManifest {
  const authored = manifest(options);
  const runtime = expandCompiledRuntimeLifecycle({
    entry_stage: authored.entry_stage,
    stages: authored.stages,
  });
  return {
    ...authored,
    entry_stage: authored.entry_stage,
    stages: runtime.stages,
  };
}

function effectIntent(decisionId = "decision-1"): EffectIntent {
  return {
    schema: EFFECT_INTENT_SCHEMA,
    id: "effect-1",
    pipeline_run_id: "run-1",
    decision_record_id: decisionId,
    kind: "github/publish-branch@1",
    idempotency_key: "run-1:publish",
    target: "github:owner/repo:refs/heads/ot/work",
    subject: subject("2"),
    payload: { branch: "ot/work" },
  };
}

function exactMap<T extends { id: string }>(...values: T[]): ReadonlyMap<string, T> {
  return new Map(values.map((value) => [value.id, value]));
}

function reduce(input: {
  current: KernelAttempt | null;
  currentRun?: KernelRun;
  currentManifest?: CompiledPipelineManifest;
  command: KernelCommand;
  records?: readonly ExecutionRecord[];
  checkpoints?: readonly AttemptCheckpoint[];
}): AtomicTransitionBundle {
  return reduceKernelCommand({
    manifest: input.currentManifest ?? manifest(),
    run: input.currentRun ?? run(input.current),
    current_attempt: input.current,
    records: exactMap(...(input.records ?? [])),
    checkpoints: exactMap(...(input.checkpoints ?? [])),
    command: input.command,
  });
}

function replacedAttempt(bundle: AtomicTransitionBundle, attemptId: string): KernelAttempt {
  const write = bundle.attempt_writes.find(
    (candidate) => candidate.kind === "replace" && candidate.attempt.id === attemptId,
  );
  if (!write || write.kind !== "replace") throw new Error(`missing attempt write for ${attemptId}`);
  return write.attempt;
}

function bindSessionCommand(
  current: KernelAttempt,
  currentRun: KernelRun,
  nativeSessionId = "session-1",
): Extract<KernelCommand, { type: "bind_runtime_session" }> {
  if (!current.lease) throw new Error("test attempt has no lease to bind");
  return {
    type: "bind_runtime_session",
    command_id: `bind-${current.id}-${current.work_retry_ordinal}`,
    attempt_id: current.id,
    expected_run_version: currentRun.version,
    expected_cursor_version: currentRun.cursor.version,
    expected_attempt_version: current.version,
    request_hash: current.request_hash,
    definition_bundle_hash: current.definition_bundle_hash,
    input_subject: current.input_subject,
    lease_id: current.lease.id,
    worker_id: current.lease.worker_id,
    lease_purpose: current.lease.purpose,
    expected_lease_expires_at: current.lease.expires_at,
    expected_work_retry_ordinal: current.work_retry_ordinal,
    expected_result_correction_count: current.result_correction_count,
    native_session_id: nativeSessionId,
  };
}

function recordedAttempt(scope: AttemptScope = stageScope()): {
  current: KernelAttempt;
  currentRun: KernelRun;
  result: ResultRecord;
} {
  const current = attempt({
    scope,
    status: "recorded",
    version: 5,
    output_subject: subject("2"),
    native_session_id: "session-1",
    checkpoint_id: "checkpoint-1",
    result_record_id: "result-1",
  });
  return {
    current,
    currentRun: run(current, {
      current_subject: subject("1"),
      status: "running",
      version: 5,
      checkpoint_ids: { [current.id]: "checkpoint-1" },
    }),
    result: resultRecord(current),
  };
}

describe("shared execution kernel lifecycle", () => {
  it("preserves completed work through result_pending and same-session correction", () => {
    let current = attempt();
    let currentRun = run(current);

    ({ current, currentRun } = claimAttempt(current, currentRun, {
      purpose: "work",
      leaseId: "lease-1",
    }));
    expect(current).toMatchObject({ status: "pending", lease: { purpose: "work", started: false } });

    let transition = reduce({
      current,
      currentRun,
      currentManifest: manifest({ firstTerminal: true }),
      command: { type: "start", command_id: "start-work", attempt_id: current.id, lease_id: "lease-1" },
    });
    current = replacedAttempt(transition, current.id);
    currentRun = transition.run;
    expect(current.status).toBe("running");

    transition = reduce({
      current,
      currentRun,
      currentManifest: manifest({ firstTerminal: true }),
      command: bindSessionCommand(current, currentRun),
    });
    current = replacedAttempt(transition, current.id);
    currentRun = transition.run;
    expect(current.native_session_id).toBe("session-1");

    const completedCheckpoint = checkpoint(current, subject("2"));
    transition = reduce({
      current,
      currentRun,
      currentManifest: manifest({ firstTerminal: true }),
      command: {
        type: "work_complete",
        command_id: "work-complete",
        attempt_id: current.id,
        checkpoint_id: completedCheckpoint.id,
        verified_output_subject: subject("2"),
      },
      checkpoints: [completedCheckpoint],
    });
    current = replacedAttempt(transition, current.id);
    currentRun = transition.run;
    const cursorAtCompletion = currentRun.cursor;
    expect(currentRun.current_subject).toBe(subject("1"));
    expect(transition.append_checkpoints).toEqual([completedCheckpoint]);

    transition = reduce({
      current,
      currentRun,
      currentManifest: manifest({ firstTerminal: true }),
      command: {
        type: "result_pending",
        command_id: "result-pending",
        attempt_id: current.id,
        candidate_hash: sha("f"),
        diagnostics: [{ path: "/payload/summary", detail: "must be a string" }],
        correction_deadline: "2026-08-20T00:15:00.000Z",
      },
      checkpoints: [completedCheckpoint],
    });
    current = replacedAttempt(transition, current.id);
    currentRun = transition.run;
    expect(current).toMatchObject({
      status: "result_pending",
      output_subject: subject("2"),
      checkpoint_id: completedCheckpoint.id,
      work_retry_ordinal: 0,
    });
    expect(currentRun.cursor).toEqual(cursorAtCompletion);

    ({ current, currentRun } = claimAttempt(current, currentRun, {
      purpose: "result_correction",
      leaseId: "lease-2",
      expiresAt: "2026-08-20T00:10:00.000Z",
    }));
    expect(current).toMatchObject({
      status: "result_pending",
      result_correction_count: 1,
      lease: { purpose: "result_correction", started: false },
    });

    transition = reduce({
      current,
      currentRun,
      currentManifest: manifest({ firstTerminal: true }),
      command: { type: "start", command_id: "start-correction", attempt_id: current.id, lease_id: "lease-2" },
    });
    current = replacedAttempt(transition, current.id);
    currentRun = transition.run;
    expect(current.status).toBe("result_pending");

    const result = resultRecord(current);
    transition = reduce({
      current,
      currentRun,
      currentManifest: manifest({ firstTerminal: true }),
      command: { type: "record", command_id: "record", attempt_id: current.id, record_id: result.id },
      records: [result],
      checkpoints: [completedCheckpoint],
    });
    current = replacedAttempt(transition, current.id);
    currentRun = transition.run;
    expect(current).toMatchObject({ status: "recorded", pending_result: null, result_record_id: result.id });

    const decision = decisionRecord([result.id]);
    const cleanupAttempt = attempt({
      id: "attempt-cleanup-completed",
      scope: stageScope(runtimeStopStageId("completed")),
      repository_authority: "inspect",
      input_subject: subject("2"),
    });
    transition = reduce({
      current,
      currentRun,
      currentManifest: manifestWithRuntimeStages({ firstTerminal: true }),
      command: {
        type: "settle",
        command_id: "settle",
        attempt_id: current.id,
        decision_record_id: decision.id,
        outcome: "success",
        next_attempts: [cleanupAttempt],
      },
      records: [decision, result],
    });
    expect(transition.run).toMatchObject({
      status: "running",
      terminal_outcome: null,
      current_subject: subject("2"),
      active_attempt_versions: { [cleanupAttempt.id]: 0 },
      cursor: { stage_id: runtimeStopStageId("completed") },
    });
    expect(replacedAttempt(transition, current.id).status).toBe("settled");
  });

  it("uses the identical attempt lifecycle for an ordinary stage and one loop item", () => {
    const lifecycle = (scope: AttemptScope): string[] => {
      let current = attempt({ scope });
      let currentRun = run(current);
      const states = [current.status];
      const apply = (command: KernelCommand, options: {
        checkpoints?: AttemptCheckpoint[];
        records?: ExecutionRecord[];
      } = {}): void => {
        const transition = reduce({
          current,
          currentRun,
          currentManifest: manifestWithRuntimeStages({ firstTerminal: true }),
          command,
          checkpoints: options.checkpoints,
          records: options.records,
        });
        current = replacedAttempt(transition, current.id);
        currentRun = transition.run;
        states.push(current.status);
      };
      ({ current, currentRun } = claimAttempt(current, currentRun, {
        purpose: "work",
        leaseId: "lease-1",
      }));
      states.push(current.status);
      apply({ type: "start", command_id: "start", attempt_id: current.id, lease_id: "lease-1" });
      apply(bindSessionCommand(current, currentRun));
      const completedCheckpoint = checkpoint(current, subject("2"));
      apply({
        type: "work_complete", command_id: "complete", attempt_id: current.id,
        checkpoint_id: completedCheckpoint.id, verified_output_subject: subject("2"),
      }, { checkpoints: [completedCheckpoint] });
      const result = resultRecord(current);
      apply(
        { type: "record", command_id: "record", attempt_id: current.id, record_id: result.id },
        { checkpoints: [completedCheckpoint], records: [result] },
      );
      const decision = decisionRecord([result.id]);
      const cleanupAttempt = attempt({
        id: "attempt-cleanup-completed",
        scope: stageScope(runtimeStopStageId("completed")),
        repository_authority: "inspect",
        input_subject: scope.kind === "stage" ? subject("2") : subject("1"),
      });
      apply({
        type: "settle", command_id: "settle", attempt_id: current.id,
        decision_record_id: decision.id, outcome: "success", next_attempts: [cleanupAttempt],
      }, { records: [decision, result] });
      return states;
    };

    expect(lifecycle(stageScope())).toEqual(lifecycle(loopScope()));
    expect(lifecycle(stageScope())).toEqual([
      "pending", "pending", "running", "running", "work_complete", "recorded", "settled",
    ]);
  });

  it("rejects each lifecycle command from an invalid edge", () => {
    const running = attempt({
      status: "running",
      lease: { id: "lease", generation: 0, worker_id: "worker-1", purpose: "work", expires_at: "later", started: true },
    });
    const completed = attempt({
      status: "work_complete",
      output_subject: subject("2"),
      checkpoint_id: "checkpoint-1",
      native_session_id: "session-1",
    });
    const cases: Array<{ name: string; invoke: () => unknown; message: RegExp }> = [
      {
        name: "start without lease",
        invoke: () => reduce({
          current: attempt(),
          command: { type: "start", command_id: "bad-start", attempt_id: "attempt-1", lease_id: "missing" },
        }),
        message: /lease fence/,
      },
      {
        name: "complete before start",
        invoke: () => reduce({
          current: attempt(),
          command: {
            type: "work_complete", command_id: "bad-complete", attempt_id: "attempt-1",
            checkpoint_id: "checkpoint-1", verified_output_subject: subject("2"),
          },
          checkpoints: [checkpoint(attempt(), subject("2"))],
        }),
        message: /started work lease/,
      },
      {
        name: "result pending before work complete",
        invoke: () => reduce({
          current: running,
          command: {
            type: "result_pending", command_id: "bad-pending", attempt_id: running.id,
            candidate_hash: null, diagnostics: [{ path: "/", detail: "missing" }],
            correction_deadline: "2026-08-20T00:15:00.000Z",
          },
        }),
        message: /before work completion/,
      },
      {
        name: "record before work complete",
        invoke: () => reduce({
          current: running,
          command: { type: "record", command_id: "bad-record", attempt_id: running.id, record_id: "result-1" },
        }),
        message: /cannot record/,
      },
      {
        name: "settle before record",
        invoke: () => reduce({
          current: completed,
          currentRun: run(completed, { current_subject: subject("1") }),
          command: {
            type: "settle", command_id: "bad-settle", attempt_id: completed.id,
            decision_record_id: "decision-1", outcome: "success", next_attempts: [],
          },
          records: [decisionRecord([])],
        }),
        message: /before its ResultRecord/,
      },
      {
        name: "retry completed work",
        invoke: () => reduce({
          current: completed,
          currentRun: run(completed, { current_subject: subject("1") }),
          command: {
            type: "retry", command_id: "bad-retry", attempt_id: completed.id,
          },
        }),
        message: /cannot consume a work retry/,
      },
      {
        name: "fail completed work",
        invoke: () => reduce({
          current: completed,
          currentRun: run(completed, { current_subject: subject("1") }),
          command: {
            type: "fail", command_id: "bad-fail", attempt_id: completed.id,
            decision_record_id: "decision-1", reason: "generic failure",
            resource_disposition: { kind: "pre_provision" },
          },
          records: [decisionRecord([])],
        }),
        message: /cannot be discarded/,
      },
    ];
    for (const testCase of cases) {
      expect(testCase.invoke, testCase.name).toThrow(testCase.message);
    }
  });

  it("binds an agent session only through the exact live attempt CAS", () => {
    const current = attempt({
      status: "running",
      version: 4,
      lease: {
        id: "lease-1",
        generation: 0,
        worker_id: "worker-1",
        purpose: "work",
        expires_at: "2026-08-20T00:05:00.000Z",
        started: true,
      },
    });
    const currentRun = run(current, { version: 7 });
    const command = bindSessionCommand(current, currentRun);
    const transition = reduce({ current, currentRun, command });
    expect(replacedAttempt(transition, current.id)).toMatchObject({
      native_session_id: "session-1",
      version: 5,
      status: "running",
      lease: current.lease,
    });
    expect(transition.run).toMatchObject({ version: 8 });
    expect(transition.run.cursor).toEqual(currentRun.cursor);
    expect(transition.append_records).toEqual([]);
    expect(transition.append_checkpoints).toEqual([]);

    const staleCases: Array<[
      string,
      Partial<Extract<KernelCommand, { type: "bind_runtime_session" }>>,
      RegExp,
    ]> = [
      ["run version", { expected_run_version: 6 }, /run version fence/],
      ["attempt version", { expected_attempt_version: 3 }, /attempt version fence/],
      ["lease", { lease_id: "lease-stale" }, /lease fence/],
      ["worker", { worker_id: "worker-stale" }, /lease fence/],
      ["lease expiry", { expected_lease_expires_at: "2026-08-20T00:06:00.000Z" }, /lease fence/],
      ["retry ordinal", { expected_work_retry_ordinal: 1 }, /retry ordinal fence/],
      ["request", { request_hash: sha("d") }, /action identity fence/],
      ["session", { native_session_id: "contains whitespace" }, /session identity/],
    ];
    for (const [name, overrides, message] of staleCases) {
      expect(() => reduce({
        current,
        currentRun,
        command: { ...command, ...overrides },
      }), name).toThrow(message);
    }
  });

  it("requires a pre-bound agent session and keeps non-agent checkpoints sessionless", () => {
    const unbound = attempt({
      status: "running",
      lease: {
        id: "lease-1",
        generation: 0,
        worker_id: "worker-1",
        purpose: "work",
        expires_at: "later",
        started: true,
      },
    });
    const firstBindingCheckpoint = checkpoint(unbound, subject("2"));
    expect(() => reduce({
      current: unbound,
      command: {
        type: "work_complete",
        command_id: "checkpoint-first-bind",
        attempt_id: unbound.id,
        checkpoint_id: firstBindingCheckpoint.id,
        verified_output_subject: subject("2"),
      },
      checkpoints: [firstBindingCheckpoint],
    })).toThrow(/bind its native session before checkpointing/);

    const bound = { ...unbound, native_session_id: "session-1" };
    expect(() => reduce({
      current: bound,
      command: {
        type: "work_complete",
        command_id: "checkpoint-session-change",
        attempt_id: bound.id,
        checkpoint_id: "checkpoint-1",
        verified_output_subject: subject("2"),
      },
      checkpoints: [{
        ...checkpoint(bound, subject("2")),
        native_session_id: "session-2",
      }],
    })).toThrow(/changes the pinned native session/);

    const commandAttempt = attempt({
      scope: stageScope("command"),
      repository_authority: "inspect",
      status: "running",
      lease: {
        id: "command-lease",
        generation: 0,
        worker_id: "command-worker",
        purpose: "work",
        expires_at: "later",
        started: true,
      },
    });
    const commandRun = run(commandAttempt);
    const invalidCommandCheckpoint = checkpoint(commandAttempt, null);
    expect(() => reduce({
      current: commandAttempt,
      currentRun: commandRun,
      currentManifest: commandManifest(),
      command: {
        type: "work_complete",
        command_id: "command-session",
        attempt_id: commandAttempt.id,
        checkpoint_id: invalidCommandCheckpoint.id,
        verified_output_subject: null,
      },
      checkpoints: [invalidCommandCheckpoint],
    })).toThrow(/command checkpoints cannot bind/);

    const validCommandCheckpoint = {
      ...invalidCommandCheckpoint,
      native_session_id: null,
    };
    expect(replacedAttempt(reduce({
      current: commandAttempt,
      currentRun: commandRun,
      currentManifest: commandManifest(),
      command: {
        type: "work_complete",
        command_id: "command-sessionless",
        attempt_id: commandAttempt.id,
        checkpoint_id: validCommandCheckpoint.id,
        verified_output_subject: null,
      },
      checkpoints: [validCommandCheckpoint],
    }), commandAttempt.id).native_session_id).toBeNull();
  });

  it("requires verified edit subjects and prevents inspect actions from advancing them", () => {
    const edit = attempt({
      status: "running",
      native_session_id: "session-1",
      lease: { id: "lease", generation: 0, worker_id: "worker-1", purpose: "work", expires_at: "later", started: true },
    });
    expect(() => reduce({
      current: edit,
      command: {
        type: "work_complete", command_id: "edit-null", attempt_id: edit.id,
        checkpoint_id: "checkpoint-1", verified_output_subject: null,
      },
      checkpoints: [checkpoint(edit, null)],
    })).toThrow(/matching verified output subject/);

    const inspect = attempt({
      repository_authority: "inspect",
      status: "running",
      native_session_id: "session-1",
      lease: { id: "lease", generation: 0, worker_id: "worker-1", purpose: "work", expires_at: "later", started: true },
    });
    expect(() => reduce({
      current: inspect,
      currentManifest: manifest({ authority: "inspect" }),
      command: {
        type: "work_complete", command_id: "inspect-edit", attempt_id: inspect.id,
        checkpoint_id: "checkpoint-1", verified_output_subject: subject("2"),
      },
      checkpoints: [checkpoint(inspect, subject("2"))],
    })).toThrow(/inspect completion cannot advance/);

    const accepted = reduce({
      current: inspect,
      currentManifest: manifest({ authority: "inspect" }),
      command: {
        type: "work_complete", command_id: "inspect-complete", attempt_id: inspect.id,
        checkpoint_id: "checkpoint-1", verified_output_subject: null,
      },
      checkpoints: [checkpoint(inspect, null)],
    });
    expect(accepted.run.current_subject).toBe(subject("1"));
  });

  it("retries work with the same scope while preserving the cursor", () => {
    const current = attempt({
      scope: loopScope(),
      status: "running",
      native_session_id: "session-1",
      lease: { id: "lease", generation: 0, worker_id: "worker-1", purpose: "work", expires_at: "later", started: true },
    });
    const transition = reduce({
      current,
      command: { type: "retry", command_id: "retry", attempt_id: current.id },
    });
    expect(replacedAttempt(transition, current.id)).toMatchObject({
      id: current.id,
      request_hash: current.request_hash,
      status: "pending",
      work_retry_ordinal: 1,
      native_session_id: null,
    });
    expect(transition.create_attempts).toEqual([]);
    expect(transition.run.cursor).toEqual(run(current).cursor);
    expect(transition.run.active_attempt_versions).toEqual({ "attempt-1": 1 });

    expect(() => reduce({
      current: attempt({ work_retry_ordinal: 2 }),
      command: {
        type: "retry", command_id: "exhausted", attempt_id: "attempt-1",
      },
    })).toThrow(/exhausted work retries/);
  });

  it("allows repeated result correction without consuming a work retry", () => {
    const current = attempt({
      status: "result_pending",
      version: 4,
      output_subject: subject("2"),
      native_session_id: "session-1",
      checkpoint_id: "checkpoint-1",
      result_correction_count: 1,
      result_correction_deadline: "2026-08-20T00:15:00.000Z",
      lease: {
        id: "correction-1",
        generation: 0,
        worker_id: "worker-1",
        purpose: "result_correction",
        expires_at: "later",
        started: true,
      },
      pending_result: {
        candidate_hash: sha("f"),
        diagnostics: [{ path: "/outcome", detail: "unknown" }],
      },
    });
    const completedCheckpoint = checkpoint(current, subject("2"));
    const currentRun = run(current, {
      current_subject: subject("1"),
      checkpoint_ids: { [current.id]: completedCheckpoint.id },
    });
    const pendingAgain = reduce({
      current,
      currentRun,
      command: {
        type: "result_pending",
        command_id: "pending-again",
        attempt_id: current.id,
        candidate_hash: sha("9"),
        diagnostics: [{ path: "/payload", detail: "still invalid" }],
        correction_deadline: "2026-08-20T00:15:00.000Z",
      },
      checkpoints: [completedCheckpoint],
    });
    const next = replacedAttempt(pendingAgain, current.id);
    expect(next).toMatchObject({
      status: "result_pending",
      work_retry_ordinal: 0,
      result_correction_count: 1,
      lease: null,
      checkpoint_id: completedCheckpoint.id,
    });
    expect(pendingAgain.run.cursor).toEqual(currentRun.cursor);
  });
});

describe("pipeline topology on the shared kernel", () => {
  it("sorts loop and fanout siblings independently of insertion order", () => {
    const state = recordedAttempt();
    const decision = decisionRecord([state.result.id]);
    const nextAttempts = [
      attempt({
        id: "review-b",
        scope: fanoutScope("security", 1),
        repository_authority: "inspect",
        input_subject: subject("2"),
      }),
      attempt({
        id: "review-a",
        scope: fanoutScope("correctness", 0),
        repository_authority: "inspect",
        input_subject: subject("2"),
      }),
    ];
    const forward = reduce({
      current: state.current,
      currentRun: state.currentRun,
      command: {
        type: "settle", command_id: "schedule", attempt_id: state.current.id,
        decision_record_id: decision.id, outcome: "success", next_attempts: nextAttempts,
      },
      records: [state.result, decision],
    });
    const reverseRecords = new Map<string, ExecutionRecord>([
      [decision.id, decision],
      [state.result.id, state.result],
    ]);
    const reverse = reduceKernelCommand({
      manifest: manifest(),
      run: {
        ...state.currentRun,
        active_attempt_versions: Object.fromEntries(
          Object.entries(state.currentRun.active_attempt_versions).reverse(),
        ),
      },
      current_attempt: state.current,
      records: reverseRecords,
      checkpoints: new Map(),
      command: {
        type: "settle", command_id: "schedule", attempt_id: state.current.id,
        decision_record_id: decision.id, outcome: "success", next_attempts: [...nextAttempts].reverse(),
      },
    });

    expect(forward.create_attempts.map((candidate) => candidate.id)).toEqual(["review-a", "review-b"]);
    expect(forward.run.active_attempt_versions).toEqual({ "review-a": 0, "review-b": 0 });
    expect(canonicalJson(forward)).toBe(canonicalJson(reverse));
  });

  it("holds the cursor until every sibling has settled", () => {
    const current = attempt({
      id: "review-a",
      scope: fanoutScope("correctness", 0),
      repository_authority: "inspect",
      status: "recorded",
      version: 3,
      checkpoint_id: "checkpoint-a",
      result_record_id: "result-a",
    });
    const sibling = attempt({
      id: "review-b",
      scope: fanoutScope("security", 1),
      repository_authority: "inspect",
      version: 2,
    });
    const currentRun = run(current, {
      status: "running",
      version: 9,
      cursor: compileKernelCursor({
        stage_id: "verify",
        version: 1,
        attempts: [current, sibling],
      }),
      active_attempt_versions: { "review-b": sibling.version, "review-a": current.version },
    }, [current, sibling]);
    const result = resultRecord(current, "result-a");
    const decision = decisionRecord([result.id], "decision-a");
    const transition = reduce({
      current,
      currentRun,
      command: {
        type: "settle", command_id: "settle-a", attempt_id: current.id,
        decision_record_id: decision.id, outcome: "success", next_attempts: [],
      },
      records: [decision, result],
    });
    expect(transition.run.cursor).toMatchObject({
      stage_id: currentRun.cursor.stage_id,
      version: currentRun.cursor.version + 1,
      completed_scope_keys: [frontierMemberKey(current)],
    });
    expect(transition.run.active_attempt_versions).toEqual({ "review-b": sibling.version });
    expect(transition.run.status).toBe("running");

    expect(() => reduce({
      current,
      currentRun,
      command: {
        type: "settle",
        command_id: "settle-a-with-effect",
        attempt_id: current.id,
        decision_record_id: decision.id,
        outcome: "success",
        next_attempts: [],
        effect_intents: [effectIntent(decision.id)],
      },
      records: [decision, result],
    })).toThrow(/before the fan-in is complete/);
  });

  it("chains divergent loop siblings through their exact predecessor checkpoints", () => {
    const globalSubject = subject("1");
    const unitASubject = subject("2");
    const unitBSubject = subject("3");
    const settledA = attempt({
      id: "unit-a-work",
      scope: loopScope("unit-a", 0),
      status: "settled",
      version: 6,
      output_subject: unitASubject,
      checkpoint_id: "checkpoint-unit-a",
      result_record_id: "result-unit-a",
    });
    const currentB = attempt({
      id: "unit-b-work",
      scope: loopScope("unit-b", 1),
      status: "recorded",
      version: 5,
      output_subject: unitBSubject,
      checkpoint_id: "checkpoint-unit-b",
      result_record_id: "result-unit-b",
    });
    const checkpointA = checkpoint(settledA, unitASubject, "checkpoint-unit-a");
    const checkpointB = checkpoint(currentB, unitBSubject, "checkpoint-unit-b");
    const resultB = resultRecord(currentB, "result-unit-b");
    const decisionB = decisionRecord([resultB.id], "decision-unit-b");
    const currentRun = run(currentB, {
      current_subject: globalSubject,
      status: "running",
      version: 11,
      cursor: compileKernelCursor({
        stage_id: "work",
        version: 4,
        attempts: [settledA, currentB],
        completed_scope_keys: [frontierMemberKey(settledA)],
      }),
      active_attempt_versions: { [currentB.id]: currentB.version },
      checkpoint_ids: {
        [settledA.id]: checkpointA.id,
        [currentB.id]: checkpointB.id,
      },
    }, [settledA, currentB]);
    const nextA = attempt({
      id: "unit-a-verify",
      scope: loopScope("unit-a", 0, "verify"),
      repository_authority: "inspect",
      input_subject: unitASubject,
    });
    const nextB = attempt({
      id: "unit-b-verify",
      scope: loopScope("unit-b", 1, "verify"),
      repository_authority: "inspect",
      input_subject: unitBSubject,
    });
    const command: KernelCommand = {
      type: "settle",
      command_id: "advance-loop-body",
      attempt_id: currentB.id,
      decision_record_id: decisionB.id,
      outcome: "success",
      next_attempts: [nextB, nextA],
    };

    const transition = reduce({
      current: currentB,
      currentRun,
      command,
      records: [resultB, decisionB],
      checkpoints: [checkpointB, checkpointA],
    });
    expect(transition.run.current_subject).toBe(globalSubject);
    expect(transition.create_attempts.map((candidate) => ({
      item: candidate.scope.kind === "loop_item" ? candidate.scope.item_id : "unexpected",
      subject: candidate.input_subject,
    }))).toEqual([
      { item: "unit-a", subject: unitASubject },
      { item: "unit-b", subject: unitBSubject },
    ]);

    const claimedA = claimAttempt(nextA, transition.run, {
      purpose: "work",
      leaseId: "lease-unit-a-verify",
    });
    const startedA = reduce({
      current: claimedA.current,
      currentRun: claimedA.currentRun,
      command: {
        type: "start",
        command_id: "start-unit-a-verify",
        attempt_id: nextA.id,
        lease_id: "lease-unit-a-verify",
      },
    });
    expect(replacedAttempt(startedA, nextA.id).status).toBe("running");

    expect(() => reduce({
      current: currentB,
      currentRun,
      command,
      records: [resultB, decisionB],
      checkpoints: [checkpointB],
    })).toThrow(/missing exact structured predecessor checkpoint/);

    const swappedRun: KernelRun = {
      ...currentRun,
      checkpoint_ids: {
        [settledA.id]: checkpointB.id,
        [currentB.id]: checkpointA.id,
      },
    };
    expect(() => reduce({
      current: currentB,
      currentRun: swappedRun,
      command,
      records: [resultB, decisionB],
      checkpoints: [checkpointA, checkpointB],
    })).toThrow(/does not match item/);

    expect(() => reduce({
      current: currentB,
      currentRun,
      command: {
        ...command,
        next_attempts: [{ ...nextA, input_subject: unitBSubject }, nextB],
      },
      records: [resultB, decisionB],
      checkpoints: [checkpointA, checkpointB],
    })).toThrow(/does not use the run's verified subject/);
  });

  it("derives one dependency frontier and refuses to start blocked siblings", () => {
    const state = recordedAttempt();
    const decision = decisionRecord([state.result.id]);
    const first = attempt({
      id: "review-a",
      scope: fanoutScope("correctness", 0),
      repository_authority: "inspect",
      input_subject: subject("2"),
    });
    const dependent = attempt({
      id: "review-b",
      scope: fanoutScope("security", 1),
      repository_authority: "inspect",
      input_subject: subject("2"),
    });
    const scheduled = reduce({
      current: state.current,
      currentRun: state.currentRun,
      command: {
        type: "settle",
        command_id: "schedule-dependent",
        attempt_id: state.current.id,
        decision_record_id: decision.id,
        outcome: "success",
        next_attempts: [dependent, first],
        next_dependencies: { [frontierMemberKey(dependent)]: [frontierMemberKey(first)] },
      },
      records: [decision, state.result],
    });

    const blocked = claimAttempt(dependent, scheduled.run, {
      purpose: "work",
      leaseId: "lease-b",
    });
    expect(() => reduce({
      current: blocked.current,
      currentRun: blocked.currentRun,
      command: {
        type: "start",
        command_id: "start-too-soon",
        attempt_id: dependent.id,
        lease_id: "lease-b",
      },
    })).toThrow(/before its dependencies completed/);

    const completedFirst = attempt({
      ...first,
      status: "recorded",
      version: 3,
      checkpoint_id: "checkpoint-a",
      result_record_id: "result-a",
    });
    const firstResult = resultRecord(completedFirst, "result-a");
    const firstDecision = decisionRecord([firstResult.id], "decision-a");
    const afterFirst = reduce({
      current: completedFirst,
      currentRun: {
        ...scheduled.run,
        version: scheduled.run.version + 3,
        active_attempt_versions: { "review-a": 3, "review-b": 0 },
      },
      command: {
        type: "settle",
        command_id: "settle-first",
        attempt_id: completedFirst.id,
        decision_record_id: firstDecision.id,
        outcome: "success",
        next_attempts: [],
      },
      records: [firstDecision, firstResult],
    });
    const eligible = claimAttempt(dependent, afterFirst.run, {
      purpose: "work",
      leaseId: "lease-b",
    });
    const started = reduce({
      current: eligible.current,
      currentRun: eligible.currentRun,
      command: {
        type: "start",
        command_id: "start-after-dependency",
        attempt_id: dependent.id,
        lease_id: "lease-b",
      },
    });
    expect(replacedAttempt(started, dependent.id).lease).toMatchObject({ id: "lease-b", started: true });
  });

  it("routes authored reentry exhaustion through runtime cleanup", () => {
    const state = recordedAttempt();
    const decision = decisionRecord([state.result.id]);
    const firstRetry = attempt({ id: "attempt-2", input_subject: subject("2") });
    const first = reduce({
      current: state.current,
      currentRun: state.currentRun,
      command: {
        type: "settle", command_id: "repair-1", attempt_id: state.current.id,
        decision_record_id: decision.id, outcome: "repair", next_attempts: [firstRetry],
      },
      records: [decision, state.result],
    });
    expect(first.run.cursor.reentries).toEqual({ "work:repair:work": 1 });

    const retried = attempt({
      ...firstRetry,
      status: "recorded",
      version: 4,
      output_subject: subject("3"),
      checkpoint_id: "checkpoint-2",
      result_record_id: "result-2",
    });
    const retryResult = resultRecord(retried, "result-2");
    const retryDecision = decisionRecord([retryResult.id], "decision-2");
    const cleanupAttempt = attempt({
      id: "attempt-cleanup-needs-human",
      scope: stageScope(runtimeStopStageId("needs_human")),
      repository_authority: "inspect",
      input_subject: subject("3"),
    });
    const exhausted = reduce({
      current: retried,
      currentRun: {
        ...first.run,
        current_subject: subject("2"),
        active_attempt_versions: { [retried.id]: retried.version },
        version: first.run.version + 4,
      },
      command: {
        type: "settle", command_id: "repair-2", attempt_id: retried.id,
        decision_record_id: retryDecision.id, outcome: "repair", next_attempts: [cleanupAttempt],
      },
      records: [retryDecision, retryResult],
      currentManifest: manifestWithRuntimeStages(),
    });
    expect(exhausted.run).toMatchObject({
      status: "running",
      terminal_outcome: null,
      cursor: { stage_id: runtimeStopStageId("needs_human") },
    });
  });

  it.each([
    ["stop", "canceled"],
    ["supersede", "superseded"],
  ] as const)("%s preserves its outcome while routing through runtime cleanup", (type, status) => {
    const current = attempt({
      id: "attempt-a", status: "running", version: 3,
      lease: { id: "lease", generation: 0, worker_id: "worker-1", purpose: "work", expires_at: "later", started: true },
      checkpoint_id: "checkpoint-a",
    });
    const sibling = attempt({ id: "attempt-b", version: 2, scope: loopScope("unit-b", 1) });
    const currentRun = run(current, {
      status: "running",
      version: 8,
      active_attempt_versions: { "attempt-b": 2, "attempt-a": 3 },
      active_effect_versions: {},
      checkpoint_ids: { "attempt-a": "checkpoint-a", "attempt-old": "checkpoint-old" },
    }, [current, sibling]);
    const runtime = [runtimeDelivery("create"), runtimeDelivery("start")];
    const decision = decisionRecord(runtime.map(({ id }) => id));
    const cleanupAttempt = attempt({
      id: `attempt-cleanup-${type}`,
      scope: stageScope(runtimeStopStageId(status)),
      repository_authority: "inspect",
      input_subject: currentRun.current_subject,
      context_record_ids: [decision.id, ...runtime.map(({ id }) => id)].sort(),
    });
    const resource_disposition = {
      kind: "cleanup" as const,
      runtime_delivery_record_ids: runtime.map(({ id }) => id).sort(),
      cleanup_attempt: cleanupAttempt,
    };
    const command: KernelCommand = type === "stop"
      ? { type, command_id: type, decision_record_id: decision.id, reason: "operator stop", resource_disposition }
      : { type, command_id: type, decision_record_id: decision.id, reason: "new generation", resource_disposition };
    const transition = reduce({
      current,
      currentRun,
      currentManifest: manifestWithRuntimeStages(),
      command,
      records: [decision, ...runtime],
    });
    expect(transition.run).toMatchObject({
      status: "running",
      terminal_outcome: null,
      active_attempt_versions: { [cleanupAttempt.id]: 0 },
      active_effect_versions: {},
      checkpoint_ids: currentRun.checkpoint_ids,
      cursor: { stage_id: runtimeStopStageId(status) },
    });
    expect(transition.expected.attempt_versions).toEqual({ "attempt-a": 3, "attempt-b": 2 });
    expect(transition.cancel_effect_ids).toEqual([]);
    expect(transition.attempt_writes).toHaveLength(2);
    expect(transition.create_attempts).toEqual([cleanupAttempt]);
  });

  it("never terminalizes or starts cleanup while a create outcome is unknown", () => {
    const current = attempt({ status: "running" });
    const runtime = [runtimeDelivery("create"), runtimeDelivery("start")];
    const decision = decisionRecord(runtime.map(({ id }) => id));
    const cleanupAttempt = attempt({
      id: "attempt-cleanup",
      scope: stageScope(runtimeStopStageId("canceled")),
      repository_authority: "inspect",
      context_record_ids: [decision.id, ...runtime.map(({ id }) => id)].sort(),
    });
    expect(() => reduce({
      current,
      currentRun: run(current, { active_effect_versions: { "effect-create-unknown": 2 } }),
      currentManifest: manifestWithRuntimeStages(),
      command: {
        type: "stop", command_id: "stop-unknown", decision_record_id: decision.id,
        reason: "operator stop", resource_disposition: {
          kind: "cleanup",
          runtime_delivery_record_ids: runtime.map(({ id }) => id).sort(),
          cleanup_attempt: cleanupAttempt,
        },
      },
      records: [decision, ...runtime],
    })).toThrow(/outcome is unresolved/);
  });

  it("allows direct terminalization only before the provision schedule commits", () => {
    const current = attempt({
      scope: stageScope(RUNTIME_PROVISION_STAGE_ID),
      repository_authority: "inspect",
      status: "running",
    });
    const decision = decisionRecord([]);
    const transition = reduce({
      current,
      currentRun: run(current),
      currentManifest: manifestWithRuntimeStages(),
      command: {
        type: "stop", command_id: "stop-before-create", decision_record_id: decision.id,
        reason: "operator stop", resource_disposition: { kind: "pre_provision" },
      },
      records: [decision],
    });
    expect(transition.run).toMatchObject({ status: "canceled", terminal_outcome: "canceled" });
  });
});

describe("atomic transition replay", () => {
  it("accepts exact apply/replay and rejects stale or conflicting transitions", () => {
    const current = attempt({
      version: 1,
      lease: {
        id: "lease-1",
        generation: 0,
        worker_id: "worker-1",
        purpose: "work",
        expires_at: "later",
        started: false,
      },
    });
    const transition = reduce({
      current,
      currentRun: run(current, { version: 1 }),
      command: {
        type: "start", command_id: "transition-1", attempt_id: current.id,
        lease_id: "lease-1",
      },
    });
    const observed: AtomicTransitionObservedState = {
      run_id: "run-1",
      run_version: 1,
      cursor_version: 0,
      attempt_versions: { "attempt-1": 1 },
    };
    expect(transitionApplicationDisposition({ bundle: transition, observed })).toBe("apply");
    expect(transitionApplicationDisposition({
      bundle: transition,
      observed: { ...observed, run_version: 99 },
      existing: { transition_id: transition.transition_id, content_hash: transition.content_hash },
    })).toBe("replay");

    expect(() => transitionApplicationDisposition({
      bundle: transition,
      observed: { ...observed, cursor_version: 1 },
    })).toThrow(/stale run or cursor/);
    expect(() => transitionApplicationDisposition({
      bundle: transition,
      observed,
      existing: { transition_id: transition.transition_id, content_hash: sha("0") },
    })).toThrow(/conflicts with its immutable replay/);
    expect(() => transitionApplicationDisposition({
      bundle: { ...transition, run: { ...transition.run, current_subject: subject("9") } },
      observed,
    })).toThrow(/content hash mismatch/);
  });
});

describe("effect ownership and reconciliation", () => {
  it("atomically completes a started external Attempt and schedules its first bounded phase", () => {
    const initial = attempt({
      scope: stageScope("external"),
      repository_authority: "inspect",
      status: "running",
      version: 2,
      lease: {
        id: "lease-external",
        generation: 0,
        worker_id: "external-worker",
        purpose: "work",
        expires_at: "2026-08-20T00:05:00.000Z",
        started: true,
      },
    });
    const currentRun = run(initial, { status: "running", version: 2 });
    const boundary = {
      ...checkpoint(initial, null, "checkpoint-external"),
      native_session_id: null,
    };
    const decision = externalScheduleDecision({ attempt_id: initial.id, phase: "checkpoint" });
    const intent = {
      ...effectIntent(decision.id),
      subject: initial.input_subject,
    };

    const transition = reduce({
      current: initial,
      currentRun,
      currentManifest: externalManifest(),
      command: {
        type: "schedule_external",
        command_id: "schedule-external-checkpoint",
        attempt_id: initial.id,
        checkpoint_id: boundary.id,
        decision_record_id: decision.id,
        phase: "checkpoint",
        verified_output_subject: null,
        effect_intents: [intent],
      },
      records: [decision],
      checkpoints: [boundary],
    });

    expect(replacedAttempt(transition, initial.id)).toMatchObject({
      status: "work_complete",
      lease: null,
      checkpoint_id: boundary.id,
      output_subject: null,
    });
    expect(transition.append_checkpoints).toEqual([boundary]);
    expect(transition.append_records).toEqual([decision]);
    expect(transition.put_effects).toEqual([intent]);
    expect(transition.run.active_effect_versions).toEqual({ [intent.id]: 0 });
    expect(transition.run.cursor).toEqual(currentRun.cursor);
  });

  it("schedules a later external phase only from confirmed cited deliveries", () => {
    const current = attempt({
      scope: stageScope("external"),
      repository_authority: "inspect",
      status: "work_complete",
      version: 3,
      checkpoint_id: "checkpoint-external",
    });
    const currentRun = run(current, {
      status: "running",
      version: 3,
      checkpoint_ids: { [current.id]: "checkpoint-external" },
    });
    const boundary = {
      ...checkpoint(current, null, "checkpoint-external"),
      native_session_id: null,
    };
    const priorIntent = effectIntent("prior-decision");
    const priorDelivery = deliveryRecord(priorIntent);
    const decision = externalScheduleDecision({
      attempt_id: current.id,
      phase: "publication",
      input_record_ids: [priorDelivery.id],
    });
    const intent = {
      ...effectIntent(decision.id),
      id: "effect-2",
      idempotency_key: "run-1:publication",
      subject: current.input_subject,
    };
    const command: KernelCommand = {
      type: "schedule_external",
      command_id: "schedule-external-publication",
      attempt_id: current.id,
      checkpoint_id: boundary.id,
      decision_record_id: decision.id,
      phase: "publication",
      verified_output_subject: null,
      effect_intents: [intent],
    };

    const transition = reduce({
      current,
      currentRun,
      currentManifest: externalManifest(),
      command,
      records: [decision, priorDelivery],
      checkpoints: [boundary],
    });
    expect(transition.append_checkpoints).toEqual([]);
    expect(replacedAttempt(transition, current.id)).toMatchObject({
      status: "work_complete",
      version: current.version + 1,
      checkpoint_id: boundary.id,
    });

    expect(() => reduce({
      current,
      currentRun,
      currentManifest: externalManifest(),
      command,
      records: [decision, { ...priorDelivery, status: "rejected" }],
      checkpoints: [boundary],
    })).toThrow(/confirmed DeliveryRecords/);
  });

  it("rejects external scheduling on agent stages, malformed phase identity, or oversized batches", () => {
    const current = attempt({
      status: "running",
      version: 2,
      lease: {
        id: "lease-1",
        generation: 0,
        worker_id: "worker-1",
        purpose: "work",
        expires_at: "2026-08-20T00:05:00.000Z",
        started: true,
      },
    });
    const currentRun = run(current, { status: "running", version: 2 });
    const boundary = checkpoint(current, subject("2"));
    const decision = externalScheduleDecision({ attempt_id: current.id, phase: "checkpoint" });
    const intent = effectIntent(decision.id);
    const command: KernelCommand = {
      type: "schedule_external",
      command_id: "schedule-on-agent",
      attempt_id: current.id,
      checkpoint_id: boundary.id,
      decision_record_id: decision.id,
      phase: "checkpoint",
      verified_output_subject: null,
      effect_intents: [intent],
    };
    expect(() => reduce({
      current,
      currentRun,
      command,
      records: [decision],
      checkpoints: [boundary],
    })).toThrow(/effect or wait stage/);

    const external = {
      ...current,
      scope: stageScope("external"),
      repository_authority: "inspect" as const,
    };
    const externalRun = run(external, { status: "running", version: 2 });
    const externalCheckpoint = { ...checkpoint(external, null), native_session_id: null };
    expect(() => reduce({
      current: external,
      currentRun: externalRun,
      currentManifest: externalManifest(),
      command: { ...command, attempt_id: external.id, checkpoint_id: externalCheckpoint.id, phase: "other" },
      records: [decision],
      checkpoints: [externalCheckpoint],
    })).toThrow(/semantic key/);

    const tooMany = Array.from({ length: 17 }, (_, index) => ({
      ...intent,
      id: `effect-${index + 1}`,
      idempotency_key: `run-1:effect:${index + 1}`,
    }));
    expect(() => reduce({
      current: external,
      currentRun: externalRun,
      currentManifest: externalManifest(),
      command: { ...command, attempt_id: external.id, checkpoint_id: externalCheckpoint.id, effect_intents: tooMany },
      records: [decision],
      checkpoints: [externalCheckpoint],
    })).toThrow(/between 1 and 16/);
  });

  it("allows deterministically ordered DecisionRecord-owned effects in a nonterminal transition", () => {
    const state = recordedAttempt();
    const decision = decisionRecord([state.result.id]);
    const intent = effectIntent(decision.id);
    const secondIntent: EffectIntent = {
      ...intent,
      id: "effect-2",
      kind: "linear/publish-activity@1",
      idempotency_key: "run-1:activity",
      target: "linear:issue:OPE-1:activity:complete",
    };
    const next = attempt({
      id: "verify-1",
      scope: stageScope("verify"),
      repository_authority: "inspect",
      input_subject: subject("2"),
    });
    const transition = reduce({
      current: state.current,
      currentRun: state.currentRun,
      command: {
        type: "settle", command_id: "effect-transition", attempt_id: state.current.id,
        decision_record_id: decision.id, outcome: "success", next_attempts: [next],
        effect_intents: [secondIntent, intent],
      },
      records: [decision, state.result],
    });
    expect(transition.put_effects).toEqual([intent, secondIntent]);
    expect(transition.run.active_effect_versions).toEqual({ "effect-1": 0, "effect-2": 0 });

    expect(() => authorizeEffectIntent(effectIntent("other-decision"), decision, "run-1"))
      .toThrow(/not owned/);
  });

  it("does not mark a run terminal while new effects remain unobserved", () => {
    const state = recordedAttempt();
    const decision = decisionRecord([state.result.id]);
    expect(() => reduce({
      current: state.current,
      currentRun: state.currentRun,
      currentManifest: manifest({ firstTerminal: true }),
      command: {
        type: "settle",
        command_id: "terminal-with-effect",
        attempt_id: state.current.id,
        decision_record_id: decision.id,
        outcome: "success",
        next_attempts: [],
        effect_intents: [effectIntent(decision.id)],
      },
      records: [decision, state.result],
    })).toThrow(/terminal transition cannot leave unobserved effects/);
  });

  it("returns append_delivery, execute, or hold_unknown without blind replay", () => {
    const decision = decisionRecord([]);
    const intent = effectIntent(decision.id);
    const delivery = deliveryRecord(intent);
    expect(reconcileEffectIntent({
      intent,
      decision,
      observation: { kind: "found", external_identity: intent.target, delivery },
    })).toEqual({ kind: "append_delivery", delivery });
    expect(reconcileEffectIntent({
      intent,
      decision,
      observation: { kind: "not_found", external_identity: intent.target },
    })).toEqual({ kind: "execute", intent });
    expect(reconcileEffectIntent({
      intent,
      decision,
      observation: { kind: "unknown", external_identity: intent.target, detail: "provider timeout" },
      retry_at: "2026-08-20T00:00:05.000Z",
    })).toEqual({
      kind: "hold_unknown",
      effect_id: intent.id,
      external_identity: intent.target,
      detail: "provider timeout",
      retry_at: "2026-08-20T00:00:05.000Z",
    });
  });

  it("rejects conflicting effect replay and mismatched external identity", () => {
    const decision = decisionRecord([]);
    const intent = effectIntent(decision.id);
    expect(() => assertImmutableEffectReplay(intent, {
      ...intent,
      payload: { branch: "other" },
    })).toThrow(/conflicts with an existing immutable effect intent/);
    expect(() => reconcileEffectIntent({
      intent,
      decision,
      observation: { kind: "not_found", external_identity: "github:other" },
    })).toThrow(/deterministic external identity/);
  });
});
