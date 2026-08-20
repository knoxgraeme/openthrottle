import { describe, expect, it } from "vitest";
import {
  ATTEMPT_CHECKPOINT_SCHEMA,
  COMPILED_PIPELINE_MANIFEST_SCHEMA,
  EFFECT_INTENT_SCHEMA,
  EXECUTION_RECORD_SCHEMA,
  canonicalJson,
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

function stageScope(stageId = "work"): AttemptScope {
  return { kind: "stage", stage_id: stageId };
}

function loopScope(itemId = "unit-a", itemIndex = 0): AttemptScope {
  return {
    kind: "loop_item",
    stage_id: "work",
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
    transition = reduce({
      current,
      currentRun,
      currentManifest: manifest({ firstTerminal: true }),
      command: {
        type: "settle",
        command_id: "settle",
        attempt_id: current.id,
        decision_record_id: decision.id,
        outcome: "success",
        next_attempts: [],
      },
      records: [decision, result],
    });
    expect(transition.run).toMatchObject({
      status: "completed",
      terminal_outcome: "completed",
      current_subject: subject("2"),
      active_attempt_versions: {},
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
          currentManifest: manifest({ firstTerminal: true }),
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
      apply({
        type: "settle", command_id: "settle", attempt_id: current.id,
        decision_record_id: decision.id, outcome: "success", next_attempts: [],
      }, { records: [decision, result] });
      return states;
    };

    expect(lifecycle(stageScope())).toEqual(lifecycle(loopScope()));
    expect(lifecycle(stageScope())).toEqual([
      "pending", "pending", "running", "work_complete", "recorded", "settled",
    ]);
  });

  it("rejects each lifecycle command from an invalid edge", () => {
    const running = attempt({
      status: "running",
      lease: { id: "lease", worker_id: "worker-1", purpose: "work", expires_at: "later", started: true },
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

  it("requires verified edit subjects and prevents inspect actions from advancing them", () => {
    const edit = attempt({
      status: "running",
      lease: { id: "lease", worker_id: "worker-1", purpose: "work", expires_at: "later", started: true },
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
      lease: { id: "lease", worker_id: "worker-1", purpose: "work", expires_at: "later", started: true },
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
      lease: { id: "lease", worker_id: "worker-1", purpose: "work", expires_at: "later", started: true },
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

  it("enforces reentry exhaustion from manifest state", () => {
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
        decision_record_id: retryDecision.id, outcome: "repair", next_attempts: [],
      },
      records: [retryDecision, retryResult],
    });
    expect(exhausted.run.status).toBe("needs_human");
  });

  it.each([
    ["stop", "canceled"],
    ["supersede", "superseded"],
  ] as const)("%s cascades attempts and effects while preserving checkpoints", (type, status) => {
    const current = attempt({
      id: "attempt-a", status: "running", version: 3,
      lease: { id: "lease", worker_id: "worker-1", purpose: "work", expires_at: "later", started: true },
      checkpoint_id: "checkpoint-a",
    });
    const sibling = attempt({ id: "attempt-b", version: 2, scope: loopScope("unit-b", 1) });
    const currentRun = run(current, {
      status: "running",
      version: 8,
      active_attempt_versions: { "attempt-b": 2, "attempt-a": 3 },
      active_effect_versions: { "effect-b": 1, "effect-a": 0 },
      checkpoint_ids: { "attempt-a": "checkpoint-a", "attempt-old": "checkpoint-old" },
    }, [current, sibling]);
    const decision = decisionRecord([]);
    const command: KernelCommand = type === "stop"
      ? { type, command_id: type, decision_record_id: decision.id, reason: "operator stop" }
      : { type, command_id: type, decision_record_id: decision.id, reason: "new generation" };
    const transition = reduce({ current, currentRun, command, records: [decision] });
    expect(transition.run).toMatchObject({
      status,
      terminal_outcome: status,
      active_attempt_versions: {},
      active_effect_versions: {},
      checkpoint_ids: currentRun.checkpoint_ids,
    });
    expect(transition.expected.attempt_versions).toEqual({ "attempt-a": 3, "attempt-b": 2 });
    expect(transition.cancel_effect_ids).toEqual(["effect-a", "effect-b"]);
    expect(transition.attempt_writes).toHaveLength(2);
  });
});

describe("atomic transition replay", () => {
  it("accepts exact apply/replay and rejects stale or conflicting transitions", () => {
    const current = attempt({
      version: 1,
      lease: {
        id: "lease-1",
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
    })).toEqual({
      kind: "hold_unknown",
      effect_id: intent.id,
      external_identity: intent.target,
      detail: "provider timeout",
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
