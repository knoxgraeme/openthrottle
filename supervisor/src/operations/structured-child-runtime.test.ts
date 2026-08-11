import { describe, expect, it, vi } from "vitest";
import { canonicalJson, digestNormalized } from "../pipeline/manifest.js";
import type { ExecutionGateReceipt, ExecutionWorkAttempt } from "../persistence/pipeline/unit-store.js";
import type { ExecutionUnitState } from "../pipeline/unit-coordinator.js";
import type { LoopActionRequest, SandboxRuntime } from "../runtime/contracts.js";
import { MAX_VALID_DOWNSTREAM_CONTEXT } from "../pipeline/structured-loop-envelope.js";
import { MAX_LOOP_REQUEST_ENVELOPE_BYTES } from "../pipeline/structured-loop-limits.js";
import {
  aggregateOutcomeFor,
  createStructuredChildRuntime as createProductionStructuredChildRuntime,
} from "./structured-child-runtime.js";

function createStructuredChildRuntime(
  deps: Parameters<typeof createProductionStructuredChildRuntime>[0]
): ReturnType<typeof createProductionStructuredChildRuntime> {
  return createProductionStructuredChildRuntime({
    ...deps,
    store: Object.assign({}, deps.store, {
      clearActionObservationFailure: vi.fn(() => "cleared" as const),
    }),
  });
}

function unit(overrides: Partial<ExecutionUnitState> & { unitId: string; ordinal: number }): ExecutionUnitState {
  return {
    id: `unit-${overrides.unitId}`,
    dependencies: [],
    status: "completed",
    activeActionId: null,
    phase: "integrate",
    currentCycle: 1,
    repairRounds: 0,
    commandIndex: 0,
    acceptedCandidateSubject: null,
    integrationSubject: overrides.integrationSubject ?? "1".repeat(40),
    terminalLevel: "completed",
    alarm: false,
    ...overrides,
  };
}

function integrationGate(unitId: string, subject: string, overrides: Partial<ExecutionGateReceipt> = {}): ExecutionGateReceipt {
  return {
    id: `gate-${unitId}`,
    execution_graph_id: "graph-1",
    execution_unit_id: `unit-${unitId}`,
    execution_work_attempt_id: `attempt-${unitId}`,
    parent_attempt_id: "parent-attempt",
    unit_id: unitId,
    gate_kind: "integration",
    evaluator_kind: "publish_subject",
    subject,
    result: "passed",
    outcome: "success",
    reason: "executor_integrated_candidate",
    artifact_hashes: "[]",
    payload: "{}",
    receipt_hash: "a".repeat(64),
    created_at: "2099-07-22T12:00:00.000Z",
    ...overrides,
  };
}

function action(overrides: Partial<ExecutionWorkAttempt> & {
  id: string;
  action_kind: ExecutionWorkAttempt["action_kind"];
  cycle: number;
  status: ExecutionWorkAttempt["status"];
}): ExecutionWorkAttempt {
  return {
    execution_graph_id: "graph-1",
    execution_unit_id: "unit-row-a",
    pipeline_instance_id: "instance-1",
    parent_attempt_id: "parent-attempt",
    parent_run_id: "run-1",
    unit_id: "unit_a",
    attempt_ordinal: overrides.cycle,
    command_name: null,
    idempotency_key: `idem-${overrides.id}`,
    request_hash: null,
    result_hash: null,
    terminal_result_outcome: null,
    receipt: null,
    receipt_hash: null,
    native_session_id: null,
    lease_owner: null,
    lease_until: null,
    observation_failure_count: 0,
    observation_retry_at: null,
    observation_epoch: 0,
    output_subject: null,
    payload: "",
    created_at: `2099-07-22T12:00:0${overrides.cycle}.000Z`,
    updated_at: "2099-07-22T12:00:00.000Z",
    completed_at: null,
    last_error: null,
    ...overrides,
  };
}

function reviewSubactionDispatchStore() {
  return {
    getReviewSubactionDispatch: vi.fn(() => undefined),
    prepareReviewSubactionDispatch: vi.fn(() => "recorded" as const),
    markReviewSubactionDispatched: vi.fn(),
  };
}

function candidateReceipt(subject: string, attempt: ExecutionWorkAttempt): string {
  return canonicalJson({
    schema: "openthrottle.receipt/v1",
    type: "candidate_evidence",
    assurance: "executor_verified",
    result: "success",
    producer: {
      worker_id: "executor",
      skill: "builtin://candidate_evidence@1",
      capability_digest: "d".repeat(64),
      skill_package_digest: null,
    },
    subject: {
      base: "a".repeat(40),
      pre: "a".repeat(40),
      post: subject,
    },
    fence: {
      pipeline_instance_id: "instance-1",
      graph_digest: "c".repeat(64),
      unit_id: "unit_a",
      attempt_id: "parent-attempt",
      parent_run_id: "run-1",
      action_attempt_id: attempt.id,
      generation: 1,
      native_session_id: null,
      request_hash: "b".repeat(64),
    },
    evidence: [digestNormalized(`${attempt.id}:${subject}`)],
    payload: {
      tree: "e".repeat(40),
      diff_digest: digestNormalized(subject),
      changed_paths: [],
      clean: true,
    },
    issued_at: "2099-07-22T12:00:00.000Z",
  });
}

function completionReceipt(subject: string, attempt: ExecutionWorkAttempt): string {
  return canonicalJson({
    schema: "openthrottle.receipt/v1",
    type: "unit_completion",
    assurance: "semantic_attested",
    result: "success",
    producer: {
      worker_id: "worker-1",
      skill: "builtin://implement-unit@1",
      capability_digest: "d".repeat(64),
      skill_package_digest: null,
    },
    subject: {
      base: "a".repeat(40),
      pre: "a".repeat(40),
      post: subject,
    },
    fence: {
      pipeline_instance_id: "instance-1",
      graph_digest: "c".repeat(64),
      unit_id: "unit_a",
      attempt_id: "parent-attempt",
      parent_run_id: "run-1",
      action_attempt_id: attempt.id,
      generation: 1,
      native_session_id: null,
      request_hash: attempt.request_hash,
    },
    evidence: [digestNormalized(`${attempt.id}:${subject}`)],
    payload: {
      summary: "Implemented.",
      assumptions: [],
      decisions: [],
      issues: [],
      verification: [],
      downstream_context: [],
      requested_human_input: [],
    },
    issued_at: "2099-07-22T12:00:00.000Z",
  });
}

function semanticReviewReceipt(
  subject: string,
  attempt: ExecutionWorkAttempt,
  message: string,
  base = "a".repeat(40)
): string {
  return canonicalJson({
    schema: "openthrottle.receipt/v1",
    type: "semantic_review",
    assurance: "semantic_attested",
    result: "semantic_repair_required",
    producer: {
      worker_id: "reviewer",
      skill: "builtin://final-review@1",
      capability_digest: "d".repeat(64),
      skill_package_digest: null,
    },
    subject: {
      base,
      pre: subject,
      post: subject,
    },
    fence: {
      pipeline_instance_id: "instance-1",
      graph_digest: "c".repeat(64),
      unit_id: "__final__",
      attempt_id: "parent-attempt",
      parent_run_id: "run-1",
      action_attempt_id: attempt.id,
      generation: 7,
      native_session_id: null,
      request_hash: attempt.request_hash,
    },
    evidence: ["reviewed final subject"],
    payload: {
      summary: "Repair required.",
      findings: [{ severity: "P1", message }],
    },
    issued_at: "2099-07-22T12:00:00.000Z",
  });
}

function unitDecisionReceipt(unitId: string, attempt: ExecutionWorkAttempt, revisionRequest: string): string {
  return canonicalJson({
    schema: "openthrottle.receipt/v1",
    type: "unit_decision",
    assurance: "semantic_attested",
    result: "revise",
    producer: {
      worker_id: "lead-worker",
      skill: "builtin://accept-unit@1",
      capability_digest: "d".repeat(64),
      skill_package_digest: null,
    },
    subject: {
      base: "a".repeat(40),
      pre: "a".repeat(40),
      post: "a".repeat(40),
    },
    fence: {
      pipeline_instance_id: "instance-1",
      graph_digest: "c".repeat(64),
      unit_id: unitId,
      attempt_id: "parent-attempt",
      parent_run_id: "run-1",
      action_attempt_id: attempt.id,
      generation: 1,
      native_session_id: null,
      request_hash: attempt.request_hash,
    },
    evidence: ["scope mismatch"],
    payload: {
      rationale: "Scope mismatch.",
      revision_request: revisionRequest,
      context_updates: [],
    },
    issued_at: "2099-07-22T12:00:00.000Z",
  });
}

function commandReceipt(subject: string, attempt: ExecutionWorkAttempt, summary = "passed"): string {
  return canonicalJson({
    schema: "openthrottle.receipt/v1",
    type: "command_result",
    assurance: "executor_verified",
    result: "success",
    producer: {
      worker_id: "executor",
      skill: "builtin://command_result@1",
      capability_digest: "d".repeat(64),
      skill_package_digest: null,
    },
    subject: {
      base: "a".repeat(40),
      pre: subject,
      post: subject,
    },
    fence: {
      pipeline_instance_id: "instance-1",
      graph_digest: "c".repeat(64),
      unit_id: "unit_a",
      attempt_id: "parent-attempt",
      parent_run_id: "run-1",
      action_attempt_id: attempt.id,
      generation: 1,
      native_session_id: null,
      request_hash: attempt.request_hash,
    },
    evidence: [digestNormalized(`${attempt.id}:${subject}`)],
    payload: {
      command: attempt.command_name ?? "test",
      exit_code: 0,
      summary,
    },
    issued_at: "2099-07-22T12:00:00.000Z",
  });
}

function finalRepairCompletionReceipt(subject: string, attempt: ExecutionWorkAttempt, evidence: string[]): string {
  return canonicalJson({
    schema: "openthrottle.receipt/v1",
    type: "unit_completion",
    assurance: "semantic_attested",
    result: "success",
    producer: {
      worker_id: "final-repair",
      skill: "builtin://final-repair@1",
      capability_digest: "d".repeat(64),
      skill_package_digest: null,
    },
    subject: {
      base: "a".repeat(40),
      pre: subject,
      post: subject,
    },
    fence: {
      pipeline_instance_id: "instance-1",
      graph_digest: "c".repeat(64),
      unit_id: "__final__",
      attempt_id: "parent-attempt",
      parent_run_id: "run-1",
      action_attempt_id: attempt.id,
      generation: 7,
      native_session_id: attempt.native_session_id,
      request_hash: attempt.request_hash,
    },
    evidence,
    payload: {
      summary: "Repaired final review findings.",
      assumptions: [],
      decisions: [],
      issues: [],
      verification: [],
      downstream_context: [],
      requested_human_input: [],
    },
    issued_at: "2099-07-22T12:00:00.000Z",
  });
}

function parentAttemptRequestPayload(plan: object = {
  schema: "openthrottle.execution-plan/v1",
  graph_id: "structured",
  plan_id: "test-plan",
  instructions: { one: "Implement the unit." },
  acceptance: { done: "Unit is done." },
  units: [{ id: "unit_a", title: "Unit A", depends_on: [], instructions: ["one"], acceptance: ["done"] }],
  commands: [],
}): string {
  return canonicalJson({
    taskContext: [
      "Approved structured plan.",
      "",
      "```json openthrottle.execution-plan/v1",
      JSON.stringify(plan, null, 2),
      "```",
    ].join("\n"),
  });
}

describe("structured child runtime aggregate outcome", () => {
  it("counts only units with accepted exact-subject integration evidence toward success", () => {
    const firstSubject = "1".repeat(40);
    const secondSubject = "2".repeat(40);
    const units = [
      unit({ unitId: "unit_a", ordinal: 0, integrationSubject: firstSubject }),
      unit({ unitId: "unit_b", ordinal: 1, integrationSubject: secondSubject }),
    ];

    expect(aggregateOutcomeFor(units, [
      integrationGate("unit_a", firstSubject),
      integrationGate("unit_b", secondSubject),
    ])).toBe("success");

    expect(aggregateOutcomeFor(units, [
      integrationGate("unit_a", firstSubject),
    ])).toBe("needs_human");

    expect(aggregateOutcomeFor(units, [
      integrationGate("unit_a", firstSubject),
      integrationGate("unit_b", firstSubject),
    ])).toBe("needs_human");

    expect(aggregateOutcomeFor(units, [
      integrationGate("unit_a", firstSubject),
      integrationGate("unit_b", secondSubject, { outcome: "failure", result: "failed" }),
    ])).toBe("needs_human");
  });

  it("routes failed settled units to failure instead of success", () => {
    const subject = "1".repeat(40);

    expect(aggregateOutcomeFor([
      unit({ unitId: "unit_a", ordinal: 0, integrationSubject: subject }),
      unit({
        unitId: "unit_b",
        ordinal: 1,
        status: "failed",
        terminalLevel: "failed",
        alarm: true,
        integrationSubject: null,
      }),
    ], [integrationGate("unit_a", subject)])).toBe("failure");
  });
});

describe("structured child runtime command seeding", () => {
  const request = (executionPlan: object) => ({
    attemptId: "parent-attempt",
    stageId: "structured",
    runId: "run-1",
    taskContext: [
      "Approved structured plan.",
      "",
      "```json openthrottle.execution-plan/v1",
      JSON.stringify(executionPlan, null, 2),
      "```",
    ].join("\n"),
  });

  const instance = {
    id: "instance-1",
    active_stage_id: "structured",
    generation: 1,
    repository_config_snapshot_id: "config-1",
    repository_config_digest: "config-digest",
    normalized_manifest: canonicalJson({
      stages: [{
        id: "structured",
        executor: { capability: "graph/for-each-unit@1" },
        unitCommandNames: ["test", "lint", "build"],
        unitPhases: ["implement", "simplify", "command", "candidate", "lead", "integrate"],
        unitPhaseBindings: [],
      }],
    }),
    manifest_digest: "c".repeat(64),
  };

  const executionPlan = {
    schema: "openthrottle.execution-plan/v1",
    graph_id: "structured",
    plan_id: "structured-command-scope",
    instructions: { one: "Implement one.", two: "Implement two." },
    acceptance: { done: "Done." },
    units: [
      { id: "unit_a", title: "Unit A", depends_on: [], instructions: ["one"], acceptance: ["done"] },
      { id: "unit_b", title: "Unit B", depends_on: [], instructions: ["two"], acceptance: ["done"] },
    ],
    commands: [
      { name: "docs-check", unit: "unit_a" },
      { name: "test" },
    ],
  };

  it("seeds each unit with its canonical execution-plan command assignment", () => {
    const createGraph = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {} as any,
      store: {
        getRepositoryConfigSnapshot: () => ({
          digest: "config-digest",
          normalized_config: canonicalJson({ commands: { "docs-check": "npm run docs:check", test: "npm test" } }),
        }),
        createGraph,
      } as any,
    });

    childRuntime.seedCompositeGraph(instance as any, request(executionPlan) as any);

    expect(createGraph).toHaveBeenCalledWith(expect.objectContaining({
      commandNames: ["docs-check", "test"],
      units: [
        { id: "unit_a", dependencies: [], commandNames: ["docs-check", "test"] },
        { id: "unit_b", dependencies: [], commandNames: ["test"] },
      ],
    }));
  });

  it("seeds the strictest repeated loop-backed phase rounds as the durable unit repair budget", () => {
    const createGraph = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {} as any,
      store: {
        getRepositoryConfigSnapshot: () => ({
          digest: "config-digest",
          normalized_config: canonicalJson({ commands: { "docs-check": "npm run docs:check", test: "npm test" } }),
        }),
        createGraph,
      } as any,
    });
    const manifestInstance = {
      ...instance,
      normalized_manifest: canonicalJson({
        stages: [{
          id: "structured",
          executor: { capability: "graph/for-each-unit@1" },
          unitCommandNames: ["test"],
          unitPhases: ["implement", "simplify", "candidate", "lead", "integrate"],
          unitPhaseBindings: [
            {
              id: "implement",
              kind: "agent",
              loop: {
                id: "unit-loop",
                skill: "builtin://implement-unit@1",
                input_scope: "unit",
                receipt: "unit_completion",
                max_parallel: 1,
                max_rounds: 6,
                timeout_seconds: 77,
              },
              worker: { id: "worker-1", agent: "inherit", allowed_mcp_servers: [] },
              executor: { kind: "agent", capability: "implement-unit@1" },
              credentials: ["model.invoke", "repo.read"],
              context: "fresh",
            },
            {
              id: "simplify",
              kind: "agent",
              loop: {
                id: "simplify-loop",
                skill: "builtin://simplify-unit@1",
                input_scope: "unit",
                receipt: "unit_completion",
                max_parallel: 1,
                max_rounds: 2,
                timeout_seconds: 77,
              },
              worker: { id: "worker-2", agent: "inherit", allowed_mcp_servers: [] },
              executor: { kind: "agent", capability: "simplify-unit@1" },
              credentials: ["model.invoke", "repo.read"],
              context: "fresh",
            },
            {
              id: "lead",
              kind: "gate",
              loop: {
                id: "lead-loop",
                skill: "builtin://accept-unit@1",
                input_scope: "unit",
                receipt: "unit_decision",
                max_parallel: 1,
                max_rounds: 1,
                timeout_seconds: 77,
              },
              worker: { id: "worker-3", agent: "inherit", allowed_mcp_servers: [] },
              executor: { kind: "agent", capability: "accept-unit@1" },
              credentials: ["model.invoke", "repo.read"],
              context: "fresh",
            },
          ],
        }],
      }),
    };

    childRuntime.seedCompositeGraph(manifestInstance as any, request(executionPlan) as any);

    expect(createGraph).toHaveBeenCalledWith(expect.objectContaining({
      maxRepairRounds: 1,
    }));
  });

  it("fails closed when a required execution-plan command is not configured", () => {
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {} as any,
      store: {
        getRepositoryConfigSnapshot: () => ({
          digest: "config-digest",
          normalized_config: canonicalJson({ commands: { test: "npm test" } }),
        }),
      } as any,
    });

    expect(() => childRuntime.seedCompositeGraph(instance as any, request(executionPlan) as any))
      .toThrow(/execution plan command docs-check is not configured/);
  });
});

describe("structured child runtime review fanout", () => {
  it("keeps the unit lead independent from whole-change persona fanout", async () => {
    const subject = "4".repeat(40);
    const lead = action({
      id: "lead-fanout",
      action_kind: "lead",
      cycle: 1,
      status: "leased",
      attempt_ordinal: 1,
      request_hash: null,
    });
    const implement = action({
      id: "implement-fanout",
      action_kind: "implement",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 1,
      request_hash: "1".repeat(64),
      receipt: completionReceipt(subject, { ...lead, id: "implement-fanout", request_hash: "1".repeat(64) }),
      output_subject: subject,
    });
    const candidate = action({
      id: "candidate-fanout",
      action_kind: "candidate",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 1,
      request_hash: "2".repeat(64),
      receipt: candidateReceipt(subject, { ...lead, id: "candidate-fanout", request_hash: "2".repeat(64) }),
      output_subject: subject,
    });
    const command = action({
      id: "command-fanout",
      action_kind: "command",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 1,
      command_name: "test",
      request_hash: "3".repeat(64),
      receipt: commandReceipt(subject, { ...lead, id: "command-fanout", action_kind: "command", command_name: "test", request_hash: "3".repeat(64) }),
      output_subject: subject,
    });
    const plan = {
      schema: "openthrottle.execution-plan/v1",
      graph_id: "structured",
      plan_id: "fanout-runtime",
      instructions: {
        runtime: "Implement bounded fanout dispatch, receipt fences, exact roster rereview, and repair settlement.",
      },
      acceptance: { done: "Validation controls the gate." },
      units: [{ id: "unit_a", title: "Fanout runtime", depends_on: [], instructions: ["runtime"], acceptance: ["done"] }],
      commands: [{ name: "test" }],
    };
    const dispatchLoopAction = vi.fn<SandboxRuntime["dispatchLoopAction"]>(async () => ({ providerDispatchId: "dispatch" }));
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: { dispatchLoopAction } as any,
      store: {
        leaseNextUnitAction: () => lead,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        prepareActionDispatch: vi.fn((input) => {
          lead.request_hash = input.requestHash;
          lead.request_payload = input.requestPayload;
        }),
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload(plan) }),
        listWorkAttempts: () => [implement, candidate, command],
        listUnits: () => [unit({
          unitId: "unit_a",
          ordinal: 0,
          status: "running",
          activeActionId: lead.id,
          phase: "lead",
          currentCycle: 1,
          commandNames: ["test"],
          acceptedCandidateSubject: subject,
          integrationSubject: null,
          terminalLevel: null,
        })],
        listDownstreamContext: () => [],
        getGraphForAttempt: () => ({ command_names: JSON.stringify(["test"]), integration_subject: null }),
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 1,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({
        stages: [{
          id: "structured",
          unitPhases: ["implement", "command", "candidate", "lead", "integrate"],
          unitPhaseBindings: [{
            id: "lead",
            kind: "gate",
            loop: {
              id: "lead-loop",
              skill: "builtin://accept-unit@1",
              input_scope: "unit",
              receipt: "unit_decision",
              max_parallel: 1,
              max_rounds: 1,
              timeout_seconds: 77,
            },
            worker: { id: "lead-worker", agent: "inherit", allowed_mcp_servers: [] },
            executor: { kind: "agent", capability: "accept-unit@1" },
            credentials: ["model.invoke", "repo.read"],
            context: "fresh",
          }],
          executor: { capability: "graph/for-each-unit@1" },
        }],
      }),
    } as any, "parent-attempt");

    expect(dispatchLoopAction).toHaveBeenCalledTimes(1);
    expect(dispatchLoopAction.mock.calls[0]![1]).toMatchObject({
      actionId: lead.id,
      role: "lead",
      skill: "accept-unit",
      candidateSubject: subject,
    });
  });

  it("does not promote unvalidated persona blockers through the unit acceptance gate", async () => {
    const subject = "a".repeat(40);
    const lead = action({
      id: "lead-fanout-collect",
      action_kind: "lead",
      cycle: 1,
      status: "dispatched",
      attempt_ordinal: 1,
      request_hash: "9".repeat(64),
      request_launch_state: "launched",
      request_payload: canonicalJson({
        protocol: "loop-action@2",
        actionId: "lead-fanout-collect",
        attemptId: "parent-attempt",
        graphId: "graph-1",
        unitId: "unit_a",
        role: "lead",
        loop: "lead",
        agent: "codex",
        skill: "accept-unit",
        worktree: null,
        baseSubject: subject,
        inputSubject: subject,
        candidateSubject: subject,
        nativeSessionId: null,
        contextPolicy: "fresh",
        timeoutMs: 300_000,
        transitionContext: "",
        allowedMcpServers: [],
        credentialScopes: ["model.invoke", "repo.read"],
        receiptSchema: "openthrottle.receipt/v1",
        requestHash: "9".repeat(64),
        idempotencyKey: "lead",
      } satisfies LoopActionRequest),
    });
    const implement = action({
      id: "implement-fanout-collect",
      action_kind: "implement",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 1,
      request_hash: "1".repeat(64),
      receipt: completionReceipt(subject, { ...lead, id: "implement-fanout-collect", action_kind: "implement", request_hash: "1".repeat(64) }),
      output_subject: subject,
    });
    const candidate = action({
      id: "candidate-fanout-collect",
      action_kind: "candidate",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 1,
      request_hash: "b".repeat(64),
      receipt: candidateReceipt(subject, { ...lead, id: "candidate-fanout-collect", action_kind: "candidate", request_hash: "b".repeat(64) }),
      output_subject: subject,
    });
    const priorEvidenceHashes = [implement, candidate].map((attempt) => digestNormalized(attempt.receipt!));
    const plan = {
      schema: "openthrottle.execution-plan/v1",
      graph_id: "structured",
      plan_id: "fanout-runtime",
      instructions: {
        runtime: "Implement bounded fanout dispatch, receipt fences, exact roster rereview, and repair settlement.",
      },
      acceptance: { done: "Validation controls the gate." },
      units: [{ id: "unit_a", title: "Fanout runtime", depends_on: [], instructions: ["runtime"], acceptance: ["done"] }],
      commands: [],
    };
    const leadReceipt = canonicalJson({
      schema: "openthrottle.receipt/v1",
      type: "unit_decision",
      assurance: "semantic_attested",
      result: "accept",
      producer: {
        worker_id: "lead-worker",
        skill: "builtin://accept-unit@1",
        capability_digest: "d".repeat(64),
        skill_package_digest: null,
      },
      subject: { base: subject, pre: subject, post: subject },
      fence: {
        pipeline_instance_id: "instance-1",
        graph_digest: "c".repeat(64),
        unit_id: "unit_a",
        attempt_id: "parent-attempt",
        parent_run_id: "run-1",
        action_attempt_id: lead.id,
        generation: 1,
        native_session_id: null,
        request_hash: lead.request_hash,
      },
      evidence: priorEvidenceHashes,
      payload: { rationale: "Scope matches.", context_updates: [], accepted_subject: subject },
      issued_at: "2099-07-22T12:00:00.000Z",
    });
    const semanticReviewReceipt = (input: { personaId: string; actionId: string; requestHash: string }) => canonicalJson({
      schema: "openthrottle.receipt/v1",
      type: "semantic_review",
      assurance: "semantic_attested",
      result: input.personaId === "tests-contracts" ? "semantic_repair_required" : "success",
      producer: {
        worker_id: input.personaId,
        skill: `builtin://${input.personaId}@1`,
        capability_digest: "d".repeat(64),
        skill_package_digest: null,
      },
      subject: { base: subject, pre: subject, post: subject },
      fence: {
        pipeline_instance_id: "instance-1",
        graph_digest: "c".repeat(64),
        unit_id: "unit_a",
        attempt_id: "parent-attempt",
        parent_run_id: "run-1",
        action_attempt_id: input.actionId,
        generation: 1,
        native_session_id: null,
        request_hash: input.requestHash,
      },
      evidence: ["reviewed exact subject"],
      payload: {
        summary: "Persona reviewed.",
        findings: input.personaId === "tests-contracts"
          ? [{ severity: "P1", message: "Missing production synthesis.", path: "supervisor/src/operations/structured-child-runtime.ts" }]
          : [],
      },
      issued_at: "2099-07-22T12:00:00.000Z",
    });
    const completeGatedAction = vi.fn();
    const failUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        collectLoopActionResult: vi.fn(async (_resource, request) => {
          if (request.actionId === lead.id) {
            return {
              actionId: lead.id,
              attemptId: lead.parent_attempt_id,
              requestHash: lead.request_hash!,
              outcome: "success",
              nativeSessionId: null,
              subject,
              receipt: leadReceipt,
              completedAt: "2099-07-22T12:00:00.000Z",
            };
          }
          const personaId = request.actionId.split(".review.")[1]!;
          return {
            actionId: request.actionId,
            attemptId: request.attemptId,
            requestHash: request.requestHash,
            outcome: "success",
            nativeSessionId: null,
            subject,
            receipt: semanticReviewReceipt({ personaId, actionId: request.actionId, requestHash: request.requestHash }),
            completedAt: "2099-07-22T12:00:00.000Z",
          };
        }),
      } as any,
      store: {
        leaseNextUnitAction: () => lead,
        completeGatedAction,
        failUnitAction,
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload(plan) }),
        listGateReceipts: () => [],
        listWorkAttempts: () => [implement, candidate, lead],
        listUnits: () => [unit({
          unitId: "unit_a",
          ordinal: 0,
          status: "running",
          activeActionId: lead.id,
          phase: "lead",
          currentCycle: 1,
          commandNames: [],
          acceptedCandidateSubject: subject,
          integrationSubject: null,
          terminalLevel: null,
        })],
        getGraphForAttempt: () => ({ command_names: JSON.stringify([]), integration_subject: null }),
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 1,
      base_commit: subject,
      immutable_subject: subject,
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({
        stages: [{
          id: "structured",
          unitPhases: ["implement", "candidate", "lead", "integrate"],
          unitPhaseBindings: [{
            id: "implement",
            kind: "agent",
            loop: {
              id: "implement-loop",
              skill: "builtin://implement-unit@1",
              input_scope: "unit",
              receipt: "unit_completion",
              max_parallel: 1,
              max_rounds: 1,
              timeout_seconds: 77,
            },
            worker: { id: "worker-1", agent: "inherit", allowed_mcp_servers: [] },
            executor: { kind: "agent", capability: "implement-unit@1" },
            credentials: ["model.invoke", "repo.read"],
            context: "fresh",
          }, {
            id: "lead",
            kind: "gate",
            loop: {
              id: "lead-loop",
              skill: "builtin://accept-unit@1",
              input_scope: "unit",
              receipt: "unit_decision",
              max_parallel: 1,
              max_rounds: 1,
              timeout_seconds: 77,
            },
            worker: { id: "lead-worker", agent: "inherit", allowed_mcp_servers: [] },
            executor: { kind: "agent", capability: "accept-unit@1" },
            credentials: ["model.invoke", "repo.read"],
            context: "fresh",
          }],
          executor: { capability: "graph/for-each-unit@1" },
        }],
      }),
    } as any, "parent-attempt");

    expect(failUnitAction).not.toHaveBeenCalled();
    expect(completeGatedAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: lead.id,
      outputSubject: subject,
      decision: expect.objectContaining({
        gateKind: "unit_acceptance",
        outcome: "success",
        reason: "lead_scope_match_accept",
      }),
    }));
    const receipt = JSON.parse(completeGatedAction.mock.calls[0]![0].receipt) as { payload: { revision_request?: string } };
    expect(receipt.payload.revision_request).toBeUndefined();
    const decisionPayload = JSON.parse(completeGatedAction.mock.calls[0]![0].decision.payload) as { review_fanout_synthesis?: unknown };
    expect(decisionPayload.review_fanout_synthesis).toBeUndefined();
  });
});

describe("structured child runtime repair fences", () => {
  it("durably fails parsed but invalid successful loop receipts instead of throwing on every drain", async () => {
    const implement = action({
      id: "implement-invalid-receipt",
      action_kind: "implement",
      cycle: 1,
      status: "dispatched",
      attempt_ordinal: 1,
      request_hash: "b".repeat(64),
    });
    const invalidReceipt = canonicalJson({
      schema: "openthrottle.receipt/v1",
      type: "semantic_review",
      assurance: "semantic_attested",
      result: "success",
      producer: {
        worker_id: "reviewer",
        skill: "builtin://final-review@1",
        capability_digest: "d".repeat(64),
        skill_package_digest: null,
      },
      subject: {
        base: "a".repeat(40),
        pre: "a".repeat(40),
        post: "a".repeat(40),
      },
      fence: {
        pipeline_instance_id: "instance-1",
        graph_digest: "c".repeat(64),
        unit_id: "unit_a",
        attempt_id: "parent-attempt",
        parent_run_id: "run-1",
        action_attempt_id: implement.id,
        generation: 1,
        native_session_id: null,
        request_hash: "b".repeat(64),
      },
      evidence: ["reviewed"],
      payload: { summary: "reviewed", findings: [] },
      issued_at: "2099-07-22T12:00:00.000Z",
    });
    const failUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        collectLoopActionResult: async () => ({
          actionId: implement.id,
          attemptId: "parent-attempt",
          requestHash: "b".repeat(64),
          outcome: "success",
          nativeSessionId: null,
          subject: "a".repeat(40),
          receipt: invalidReceipt,
          completedAt: "2099-07-22T12:00:00.000Z",
        }),
      } as any,
      store: {
        leaseNextUnitAction: () => implement,
        failUnitAction,
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 1,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({ stages: [{ id: "structured", unitPhaseBindings: [] }] }),
    } as any, "parent-attempt");

    expect(failUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: implement.id,
      outcome: "failure",
      lastError: expect.stringContaining("expected unit_completion"),
    }));
  });

  it("routes a non-success loop result straight to the graded handling without attempting to parse it as a receipt", async () => {
    const implement = action({
      id: "implement-retryable-infrastructure",
      action_kind: "implement",
      cycle: 1,
      status: "dispatched",
      attempt_ordinal: 1,
      request_hash: "b".repeat(64),
    });
    const diagnostic = "loop action failed (reason=credential_missing) The claude engine credential " +
      "CLAUDE_CODE_OAUTH_TOKEN was empty or absent when the engine launched; configure it on the supervisor.";
    const stopRetryableUnitAction = vi.fn();
    const failUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        collectLoopActionResult: async () => ({
          actionId: implement.id,
          attemptId: "parent-attempt",
          requestHash: "b".repeat(64),
          outcome: "retryable_infrastructure_failure",
          nativeSessionId: null,
          subject: null,
          receipt: diagnostic,
          completedAt: "2099-07-22T12:00:00.000Z",
        }),
      } as any,
      store: {
        leaseNextUnitAction: () => implement,
        stopRetryableUnitAction,
        failUnitAction,
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 1,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({ stages: [{ id: "structured", unitPhaseBindings: [] }] }),
    } as any, "parent-attempt");

    // A non-success outcome's `receipt` field is a diagnostic string by
    // contract, never receipt JSON -- it must never reach parseStandardReceipt
    // (which would reliably fail and report a tautological "malformed
    // receipt" that carries no information about what actually went wrong).
    expect(failUnitAction).not.toHaveBeenCalled();
    expect(stopRetryableUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: implement.id,
      lastError: `retryable_infrastructure_failure: ${diagnostic}`,
    }));
    const [[call]] = stopRetryableUnitAction.mock.calls;
    expect(call.lastError).not.toContain("malformed");
  });

  it("preserves the reason= classification head across two different failure reasons even when the diagnostic is long", async () => {
    const buildDiagnostic = (reason: string) => `loop action failed (reason=${reason}) ${"x".repeat(2_000)}`;
    const runFor = async (reason: string) => {
      const implement = action({
        id: `implement-reason-${reason}`,
        action_kind: "implement",
        cycle: 1,
        status: "dispatched",
        attempt_ordinal: 1,
        request_hash: "b".repeat(64),
      });
      const stopRetryableUnitAction = vi.fn();
      const childRuntime = createStructuredChildRuntime({
        now: () => new Date("2099-07-22T12:00:00.000Z"),
        taskTimeoutSeconds: 300,
        runtime: {
          collectLoopActionResult: async () => ({
            actionId: implement.id,
            attemptId: "parent-attempt",
            requestHash: "b".repeat(64),
            outcome: "retryable_infrastructure_failure",
            nativeSessionId: null,
            subject: null,
            receipt: buildDiagnostic(reason),
            completedAt: "2099-07-22T12:00:00.000Z",
          }),
        } as any,
        store: {
          leaseNextUnitAction: () => implement,
          stopRetryableUnitAction,
        } as any,
      });

      await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
        id: "instance-1",
        active_stage_id: "structured",
        agent: "codex",
        generation: 1,
        base_commit: "a".repeat(40),
        immutable_subject: "a".repeat(40),
        manifest_digest: "c".repeat(64),
        capability_digest: "d".repeat(64),
        normalized_manifest: canonicalJson({ stages: [{ id: "structured", unitPhaseBindings: [] }] }),
      } as any, "parent-attempt");

      return stopRetryableUnitAction.mock.calls[0][0].lastError as string;
    };

    const rejected = await runFor("credential_rejected");
    const missing = await runFor("credential_missing");

    // Under the old tail-only slice, both diagnostics were padded to the same
    // length and so ended in byte-identical text regardless of reason -- the
    // classification signal at the head was lost. Storing the head instead
    // keeps the two reasons distinguishable.
    expect(rejected).toContain("reason=credential_rejected");
    expect(missing).toContain("reason=credential_missing");
    expect(rejected).not.toBe(missing);
  });

  it("routes a retryable-infrastructure child-executor result the same way, without attempting to parse it as a receipt", async () => {
    const command = action({
      id: "command-retryable-infrastructure",
      action_kind: "command",
      command_name: "test",
      cycle: 1,
      status: "dispatched",
      attempt_ordinal: 1,
      request_hash: "b".repeat(64),
    });
    const diagnostic = "sandbox unreachable while running the test command";
    const stopRetryableUnitAction = vi.fn();
    const failUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        collectChildExecutorActionResult: async () => ({
          actionId: command.id,
          attemptId: "parent-attempt",
          requestHash: "b".repeat(64),
          outcome: "retryable_infrastructure_failure",
          subject: null,
          receipt: diagnostic,
          completedAt: "2099-07-22T12:00:00.000Z",
        }),
      } as any,
      store: {
        leaseNextUnitAction: () => command,
        stopRetryableUnitAction,
        failUnitAction,
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 1,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({ stages: [{ id: "structured", unitPhaseBindings: [] }] }),
    } as any, "parent-attempt");

    // A child-executor action's infrastructure fault carries a diagnostic
    // string, exactly like a loop action's -- it must route the same way,
    // never through parseStandardReceipt, and never report "malformed".
    expect(failUnitAction).not.toHaveBeenCalled();
    expect(stopRetryableUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: command.id,
      lastError: `retryable_infrastructure_failure: ${diagnostic}`,
    }));
    const [[call]] = stopRetryableUnitAction.mock.calls;
    expect(call.lastError).not.toContain("malformed");
  });

  it("durably fails loop results whose envelope subject disagrees with the receipt subject", async () => {
    const implement = action({
      id: "implement-subject-mismatch",
      action_kind: "implement",
      cycle: 1,
      status: "dispatched",
      attempt_ordinal: 1,
      request_hash: "b".repeat(64),
    });
    const receiptSubject = "a".repeat(40);
    const envelopeSubject = "2".repeat(40);
    const validReceipt = canonicalJson({
      schema: "openthrottle.receipt/v1",
      type: "unit_completion",
      assurance: "semantic_attested",
      result: "success",
      producer: {
        worker_id: "unit-worker",
        skill: "builtin://implement-unit@1",
        capability_digest: "d".repeat(64),
        skill_package_digest: null,
      },
      subject: {
        base: receiptSubject,
        pre: receiptSubject,
        post: receiptSubject,
      },
      fence: {
        pipeline_instance_id: "instance-1",
        graph_digest: "c".repeat(64),
        unit_id: "unit_a",
        attempt_id: "parent-attempt",
        parent_run_id: "run-1",
        action_attempt_id: implement.id,
        generation: 1,
        native_session_id: null,
        request_hash: "b".repeat(64),
      },
      evidence: ["completed"],
      payload: {
        summary: "completed",
        assumptions: [],
        decisions: [],
        issues: [],
        verification: [],
        downstream_context: [],
        requested_human_input: [],
      },
      issued_at: "2099-07-22T12:00:00.000Z",
    });
    const failUnitAction = vi.fn();
    const completeUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        collectLoopActionResult: async () => ({
          actionId: implement.id,
          attemptId: "parent-attempt",
          requestHash: "b".repeat(64),
          outcome: "success",
          nativeSessionId: null,
          subject: envelopeSubject,
          receipt: validReceipt,
          completedAt: "2099-07-22T12:00:00.000Z",
        }),
      } as any,
      store: {
        leaseNextUnitAction: () => implement,
        failUnitAction,
        completeUnitAction,
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 1,
      base_commit: receiptSubject,
      immutable_subject: receiptSubject,
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({ stages: [{ id: "structured", unitPhaseBindings: [] }] }),
    } as any, "parent-attempt");

    expect(completeUnitAction).not.toHaveBeenCalled();
    expect(failUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: implement.id,
      outcome: "failure",
      lastError: expect.stringContaining("result subject does not match receipt subject"),
    }));
  });

  it("persists a loop receipt recovery artifact on terminal action failure", async () => {
    const recoveryArtifact = canonicalJson({
      schema: "openthrottle.loop-receipt-recovery/v1",
      action_id: "implement-recovery",
      attempt_id: "parent-attempt",
      request_hash: "b".repeat(64),
      subject: "a".repeat(40),
      candidate_tree: "c".repeat(40),
      diff_base64: "",
      diff_truncated: false,
    });
    const implement = action({
      id: "implement-recovery",
      action_kind: "implement",
      cycle: 1,
      status: "dispatched",
      attempt_ordinal: 1,
      request_hash: "b".repeat(64),
      request_launch_state: "launched",
    });
    const failUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        collectLoopActionResult: async () => ({
          actionId: implement.id,
          attemptId: "parent-attempt",
          requestHash: "b".repeat(64),
          outcome: "failure",
          nativeSessionId: "native-1",
          subject: "a".repeat(40),
          receipt: "agent_output_contract_failure: receipt correction exhausted",
          recoveryArtifact,
          completedAt: "2099-07-22T12:00:00.000Z",
        }),
      } as any,
      store: {
        leaseNextUnitAction: () => implement,
        failUnitAction,
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 1,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({ stages: [{ id: "structured", unitPhaseBindings: [] }] }),
    } as any, "parent-attempt");

    expect(failUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: implement.id,
      outcome: "failure",
      nativeSessionId: "native-1",
      terminalPayload: canonicalJson({
        schema: "openthrottle.execution-work-terminal-payload/v1",
        receipt_recovery_artifact: JSON.parse(recoveryArtifact),
      }),
    }));
  });

  it("reseals deterministic worker worktrees and carries full plan context on requestless dispatch replay", async () => {
    const implement = action({
      id: "implement-replay",
      action_kind: "implement",
      cycle: 1,
      status: "dispatched",
      attempt_ordinal: 1,
      request_hash: null,
    });
    const createWorktree = vi.fn(async () => ({ id: "worktree-handle" }));
    let dispatched: LoopActionRequest | undefined;
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        createWorktree,
        dispatchLoopAction: async (_resource: { providerResourceId: string }, request: LoopActionRequest) => {
          dispatched = request;
          return { providerDispatchId: "dispatch-1" };
        },
      } as any,
      store: {
        leaseNextUnitAction: () => implement,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        listWorkAttempts: () => [implement],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload() }),
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 7,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({
        stages: [{
          id: "structured",
          unitPhaseBindings: [{
            id: "implement",
            kind: "agent",
            loop: {
              skill: "builtin://implement-unit@1",
              timeout_seconds: 17,
            },
            worker: {
              id: "worker-1",
              agent: "inherit",
              model: "gpt-5.1-code",
              allowed_mcp_servers: [],
            },
            credentials: ["model.invoke", "repo.read", "repo.write"],
            context: "fresh",
          }],
        }],
      }),
    } as any, "parent-attempt");

    expect(createWorktree).toHaveBeenCalledWith({ providerResourceId: "sandbox-1" }, expect.objectContaining({
      attemptId: "parent-attempt",
      baseCommit: "a".repeat(40),
    }));
    expect(dispatched).toMatchObject({
      pipelineInstanceId: "instance-1",
      graphDigest: "c".repeat(64),
      parentRunId: "run-1",
      model: "gpt-5.1-code",
      generation: 7,
      baseSubject: "a".repeat(40),
      inputSubject: "a".repeat(40),
      timeoutMs: 17_000,
      expectedProducer: {
        workerId: "worker-1",
        skill: "builtin://implement-unit@1",
        capabilityDigest: "d".repeat(64),
        skillPackageDigest: null,
        assurance: "semantic_attested",
      },
    });
    expect(dispatched?.transitionContext).toContain("Execution Plan Context");
    expect(dispatched?.transitionContext).toContain("Implement the unit.");
    expect(dispatched?.transitionContext).toContain("Unit is done.");
  });

  it("re-dispatches (and so re-stages a fresh credential envelope for) a prepared/worktree_ready replay instead of assuming the prior invocation is still credentialed", async () => {
    const requestPayload: LoopActionRequest = {
      protocol: "loop-action@2",
      actionId: "implement-worktree-ready-replay",
      attemptId: "parent-attempt",
      graphId: "graph-1",
      unitId: "unit_a",
      role: "worker",
      loop: "implement",
      agent: "codex",
      skill: "builtin://implement-unit@1",
      worktree: { id: "worktree-handle" },
      nativeSessionId: null,
      contextPolicy: "fresh",
      timeoutMs: 60_000,
      transitionContext: "Implement the unit.",
      allowedMcpServers: [],
      credentialScopes: ["model.invoke", "repo.read", "repo.write"],
      receiptSchema: "openthrottle.receipt/v1",
      requestHash: "b".repeat(64),
      idempotencyKey: "idem-implement-worktree-ready-replay",
    };
    const implement = action({
      id: "implement-worktree-ready-replay",
      action_kind: "implement",
      cycle: 1,
      status: "dispatched",
      attempt_ordinal: 1,
      request_hash: requestPayload.requestHash,
      request_payload: canonicalJson(requestPayload),
      request_launch_state: "worktree_ready",
    });
    const dispatchLoopAction = vi.fn(async () => ({ providerDispatchId: "dispatch-1" }));
    const createWorktree = vi.fn(async () => ({ id: "worktree-handle" }));
    const markActionDispatched = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: { dispatchLoopAction, createWorktree } as any,
      store: {
        leaseNextUnitAction: () => implement,
        markActionDispatching: vi.fn(),
        markActionDispatched,
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 1,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({ stages: [{ id: "structured", unitPhaseBindings: [] }] }),
    } as any, "parent-attempt");

    // The replay must re-enter the provider's dispatch path -- the only place
    // a fresh credential envelope gets materialized and staged -- rather than
    // silently reusing whatever (possibly already-consumed) envelope a prior,
    // interrupted dispatch attempt may have left behind.
    expect(dispatchLoopAction).toHaveBeenCalledTimes(1);
    expect(dispatchLoopAction).toHaveBeenCalledWith(
      { providerResourceId: "sandbox-1" },
      expect.objectContaining({ actionId: implement.id, requestHash: requestPayload.requestHash })
    );
    // The worktree is already ready, so it must not be recreated.
    expect(createWorktree).not.toHaveBeenCalled();
    expect(markActionDispatched).toHaveBeenCalledWith(implement.id, requestPayload.requestHash, null);
  });

  it("dispatches with the true maximum valid downstream-context aggregate without exceeding the sealed envelope", async () => {
    const implement = action({
      id: "implement-max-downstream-context",
      action_kind: "implement",
      cycle: 1,
      status: "dispatched",
      attempt_ordinal: 1,
      request_hash: null,
    });
    let dispatched: LoopActionRequest | undefined;
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        createWorktree: vi.fn(async () => ({ id: "worktree-handle" })),
        dispatchLoopAction: async (_resource: { providerResourceId: string }, request: LoopActionRequest) => {
          dispatched = request;
          return { providerDispatchId: "dispatch-1" };
        },
      } as any,
      store: {
        leaseNextUnitAction: () => implement,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        listWorkAttempts: () => [implement],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload() }),
        listDownstreamContext: () => MAX_VALID_DOWNSTREAM_CONTEXT.map((record) => ({
          from_unit_id: record.fromUnitId,
          payload_hash: record.payloadHash,
          payload: canonicalJson(record.payload),
        })),
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 7,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({
        stages: [{
          id: "structured",
          unitPhaseBindings: [{
            id: "implement",
            kind: "agent",
            loop: { skill: "builtin://implement-unit@1", timeout_seconds: 60 },
            worker: { id: "worker-1", agent: "inherit", allowed_mcp_servers: [] },
            credentials: ["model.invoke", "repo.read", "repo.write"],
            context: "fresh",
          }],
        }],
      }),
    } as any, "parent-attempt");

    expect(dispatched?.downstreamContext).toHaveLength(MAX_VALID_DOWNSTREAM_CONTEXT.length);
    expect(Buffer.byteLength(canonicalJson(dispatched), "utf8")).toBeLessThanOrEqual(MAX_LOOP_REQUEST_ENVELOPE_BYTES);
  });

  it("dispatches later final-repair rounds with a sealed resume session", async () => {
    const finalReview = action({
      id: "final-review-cycle-2",
      action_kind: "final_review",
      cycle: 2,
      status: "completed",
      attempt_ordinal: 3,
      unit_id: null,
      execution_unit_id: null,
      request_hash: "e".repeat(64),
      output_subject: "a".repeat(40),
    });
    finalReview.receipt = semanticReviewReceipt("a".repeat(40), finalReview, "current cycle finding");
    finalReview.receipt_hash = digestNormalized(finalReview.receipt);
    const finalRepair = action({
      id: "final-repair-cycle-2",
      action_kind: "final_repair",
      cycle: 2,
      status: "leased",
      attempt_ordinal: 4,
      unit_id: null,
      execution_unit_id: null,
      native_session_id: "native-session-final-repair-1",
    });
    let dispatched: LoopActionRequest | undefined;
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        createWorktree: vi.fn(async () => ({ id: "worktree-handle" })),
        dispatchLoopAction: async (_resource: { providerResourceId: string }, request: LoopActionRequest) => {
          dispatched = request;
          return { providerDispatchId: "dispatch-1" };
        },
      } as any,
      store: {
        leaseNextUnitAction: () => finalRepair,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        markActionWorktreeReady: vi.fn(),
        listWorkAttempts: () => [finalReview, finalRepair],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload() }),
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 7,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({ stages: [{ id: "structured", unitPhaseBindings: [] }] }),
    } as any, "parent-attempt");

    expect(dispatched).toMatchObject({
      actionId: "final-repair-cycle-2",
      loop: "repair",
      contextPolicy: "resume_required",
      nativeSessionId: "native-session-final-repair-1",
      timeoutMs: 300_000,
      priorEvidence: {
        schema: "openthrottle.loop-prior-evidence/v1",
        role: "final_repair",
      },
    });
    expect(dispatched?.priorEvidence?.receipts[0]).toMatchObject({
      role: "final_review",
      actionAttemptId: "final-review-cycle-2",
      receiptHash: finalReview.receipt_hash,
    });
    expect(dispatched?.priorEvidence?.receipts[0]?.receipt).toContain("current cycle finding");
  });

  it.each([
    {
      name: "missing final-review receipt",
      attempts: (_finalReview: ExecutionWorkAttempt, finalRepair: ExecutionWorkAttempt) => [finalRepair],
      error: /no triggering final-review receipt/,
    },
    {
      name: "invalid final-review request fence",
      attempts: (finalReview: ExecutionWorkAttempt, finalRepair: ExecutionWorkAttempt) => {
        const receipt = JSON.parse(finalReview.receipt ?? "{}");
        finalReview.receipt = canonicalJson({
          ...receipt,
          fence: {
            ...receipt.fence,
            request_hash: "f".repeat(64),
          },
        });
        finalReview.receipt_hash = digestNormalized(finalReview.receipt);
        return [finalReview, finalRepair];
      },
      error: /triggering final-review fence is invalid/,
    },
    {
      name: "stale final-review subject",
      attempts: (finalReview: ExecutionWorkAttempt, finalRepair: ExecutionWorkAttempt) => {
        finalReview.receipt = semanticReviewReceipt("b".repeat(40), finalReview, "stale finding");
        finalReview.receipt_hash = digestNormalized(finalReview.receipt);
        return [finalReview, finalRepair];
      },
      error: /triggering final-review subject is stale/,
    },
  ])("fails closed before final-repair dispatch for $name", async ({ attempts, error }) => {
    const finalReview = action({
      id: "final-review-invalid-trigger",
      action_kind: "final_review",
      cycle: 2,
      status: "completed",
      attempt_ordinal: 3,
      unit_id: null,
      execution_unit_id: null,
      request_hash: "e".repeat(64),
      output_subject: "a".repeat(40),
    });
    finalReview.receipt = semanticReviewReceipt("a".repeat(40), finalReview, "current cycle finding");
    finalReview.receipt_hash = digestNormalized(finalReview.receipt);
    const finalRepair = action({
      id: "final-repair-invalid-trigger",
      action_kind: "final_repair",
      cycle: 2,
      status: "leased",
      attempt_ordinal: 4,
      unit_id: null,
      execution_unit_id: null,
      native_session_id: "native-session-final-repair-1",
    });
    const dispatchLoopAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        createWorktree: vi.fn(async () => ({ id: "worktree-handle" })),
        dispatchLoopAction,
      } as any,
      store: {
        leaseNextUnitAction: () => finalRepair,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        markActionWorktreeReady: vi.fn(),
        listWorkAttempts: () => attempts(finalReview, finalRepair),
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload() }),
      } as any,
    });

    await expect(childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 7,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({ stages: [{ id: "structured", unitPhaseBindings: [] }] }),
    } as any, "parent-attempt")).rejects.toThrow(error);
    expect(dispatchLoopAction).not.toHaveBeenCalled();
  });

  it("accepts final-repair results that do not echo the triggering review hash in evidence", async () => {
    // The sandbox prompt tells agents not to reuse prior-action evidence, so
    // the triggering final-review receipt must be bound deterministically
    // through the completion receipt's request_hash fence rather than
    // requiring the agent to copy the hash into `evidence[]`.
    const finalReview = action({
      id: "final-review-trigger",
      action_kind: "final_review",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 3,
      unit_id: null,
      execution_unit_id: null,
      request_hash: "e".repeat(64),
      output_subject: "a".repeat(40),
    });
    finalReview.receipt = semanticReviewReceipt("a".repeat(40), finalReview, "trigger finding");
    finalReview.receipt_hash = digestNormalized(finalReview.receipt);
    const finalRepair = action({
      id: "final-repair-result",
      action_kind: "final_repair",
      cycle: 1,
      status: "dispatched",
      attempt_ordinal: 4,
      unit_id: null,
      execution_unit_id: null,
      request_hash: "b".repeat(64),
      native_session_id: "native-session-final-repair-1",
    });
    const receipt = finalRepairCompletionReceipt("a".repeat(40), finalRepair, ["repaired without trigger hash"]);
    const failUnitAction = vi.fn();
    const completeUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        collectLoopActionResult: async () => ({
          actionId: finalRepair.id,
          attemptId: "parent-attempt",
          requestHash: "b".repeat(64),
          outcome: "success",
          nativeSessionId: "native-session-final-repair-1",
          subject: "a".repeat(40),
          receipt,
          completedAt: "2099-07-22T12:00:00.000Z",
        }),
      } as any,
      store: {
        leaseNextUnitAction: () => finalRepair,
        listWorkAttempts: () => [finalReview, finalRepair],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
        failUnitAction,
        completeUnitAction,
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 7,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({
        stages: [{
          id: "structured",
          unitPhaseBindings: [{
            id: "lead",
            kind: "gate",
            loop: { skill: "builtin://accept-unit@1", timeout_seconds: 60 },
            worker: { id: "lead-worker", agent: "inherit", allowed_mcp_servers: [] },
            credentials: ["model.invoke", "repo.read"],
            context: "fresh",
          }],
        }],
      }),
    } as any, "parent-attempt");

    expect(failUnitAction).not.toHaveBeenCalled();
    expect(completeUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "final-repair-result",
      outputSubject: "a".repeat(40),
    }));
  });

  it("fails closed when a final-repair completion receipt's request-hash fence does not match the dispatched trigger", async () => {
    // A receipt whose fence points at a different (stale or foreign) request
    // hash cannot have been produced in response to the sealed request that
    // bound this action's own triggering final-review receipt, even though
    // its evidence[] array is unconstrained.
    const finalReview = action({
      id: "final-review-trigger",
      action_kind: "final_review",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 3,
      unit_id: null,
      execution_unit_id: null,
      request_hash: "e".repeat(64),
      output_subject: "a".repeat(40),
    });
    finalReview.receipt = semanticReviewReceipt("a".repeat(40), finalReview, "trigger finding");
    finalReview.receipt_hash = digestNormalized(finalReview.receipt);
    const finalRepair = action({
      id: "final-repair-result",
      action_kind: "final_repair",
      cycle: 1,
      status: "dispatched",
      attempt_ordinal: 4,
      unit_id: null,
      execution_unit_id: null,
      request_hash: "b".repeat(64),
      native_session_id: "native-session-final-repair-1",
    });
    const receipt = finalRepairCompletionReceipt("a".repeat(40), finalRepair, ["repaired the review findings"]);
    const staleFenceReceipt = canonicalJson({
      ...JSON.parse(receipt),
      fence: { ...JSON.parse(receipt).fence, request_hash: "f".repeat(64) },
    });
    const failUnitAction = vi.fn();
    const completeUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        collectLoopActionResult: async () => ({
          actionId: finalRepair.id,
          attemptId: "parent-attempt",
          requestHash: "b".repeat(64),
          outcome: "success",
          nativeSessionId: "native-session-final-repair-1",
          subject: "a".repeat(40),
          receipt: staleFenceReceipt,
          completedAt: "2099-07-22T12:00:00.000Z",
        }),
      } as any,
      store: {
        leaseNextUnitAction: () => finalRepair,
        listWorkAttempts: () => [finalReview, finalRepair],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
        failUnitAction,
        completeUnitAction,
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 7,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({
        stages: [{
          id: "structured",
          unitPhaseBindings: [{
            id: "lead",
            kind: "gate",
            loop: { skill: "builtin://accept-unit@1", timeout_seconds: 60 },
            worker: { id: "lead-worker", agent: "inherit", allowed_mcp_servers: [] },
            credentials: ["model.invoke", "repo.read"],
            context: "fresh",
          }],
        }],
      }),
    } as any, "parent-attempt");

    expect(completeUnitAction).not.toHaveBeenCalled();
    expect(failUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "final-repair-result",
      outcome: "failure",
      lastError: expect.stringContaining("completion receipt fence mismatch"),
    }));
  });

  it("accepts a second-cycle final-repair completion bound to its fresh cycle-2 trigger hash", async () => {
    // Mirrors the cycle-1 acceptance test above, but for a second repair
    // round: the completion receipt's fence.request_hash must match the
    // cycle-2 finalRepair action's own request_hash, not the round-1 one.
    const finalReviewRoundTwo = action({
      id: "final-review-trigger-cycle-2",
      action_kind: "final_review",
      cycle: 2,
      status: "completed",
      attempt_ordinal: 5,
      unit_id: null,
      execution_unit_id: null,
      request_hash: "1".repeat(64),
      output_subject: "a".repeat(40),
    });
    finalReviewRoundTwo.receipt = semanticReviewReceipt("a".repeat(40), finalReviewRoundTwo, "second cycle finding");
    finalReviewRoundTwo.receipt_hash = digestNormalized(finalReviewRoundTwo.receipt);
    const finalRepairRoundTwo = action({
      id: "final-repair-result-cycle-2",
      action_kind: "final_repair",
      cycle: 2,
      status: "dispatched",
      attempt_ordinal: 6,
      unit_id: null,
      execution_unit_id: null,
      request_hash: "2".repeat(64),
      native_session_id: "native-session-final-repair-1",
    });
    const receipt = finalRepairCompletionReceipt("a".repeat(40), finalRepairRoundTwo, ["repaired the second cycle findings"]);
    const failUnitAction = vi.fn();
    const completeUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        collectLoopActionResult: async () => ({
          actionId: finalRepairRoundTwo.id,
          attemptId: "parent-attempt",
          requestHash: "2".repeat(64),
          outcome: "success",
          nativeSessionId: "native-session-final-repair-1",
          subject: "a".repeat(40),
          receipt,
          completedAt: "2099-07-22T12:00:00.000Z",
        }),
      } as any,
      store: {
        leaseNextUnitAction: () => finalRepairRoundTwo,
        listWorkAttempts: () => [finalReviewRoundTwo, finalRepairRoundTwo],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
        failUnitAction,
        completeUnitAction,
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 7,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({
        stages: [{
          id: "structured",
          unitPhaseBindings: [{
            id: "lead",
            kind: "gate",
            loop: { skill: "builtin://accept-unit@1", timeout_seconds: 60 },
            worker: { id: "lead-worker", agent: "inherit", allowed_mcp_servers: [] },
            credentials: ["model.invoke", "repo.read"],
            context: "fresh",
          }],
        }],
      }),
    } as any, "parent-attempt");

    expect(failUnitAction).not.toHaveBeenCalled();
    expect(completeUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "final-repair-result-cycle-2",
      outputSubject: "a".repeat(40),
    }));
  });

  it("fails closed when a second-cycle final-repair completion is bound to the stale cycle-1 trigger hash", async () => {
    // A second-round completion whose fence still points at the round-1
    // finalRepair request hash was produced against a stale trigger and must
    // not be accepted merely because it shares the resumed native session.
    const finalReviewRoundTwo = action({
      id: "final-review-trigger-cycle-2",
      action_kind: "final_review",
      cycle: 2,
      status: "completed",
      attempt_ordinal: 5,
      unit_id: null,
      execution_unit_id: null,
      request_hash: "1".repeat(64),
      output_subject: "a".repeat(40),
    });
    finalReviewRoundTwo.receipt = semanticReviewReceipt("a".repeat(40), finalReviewRoundTwo, "second cycle finding");
    finalReviewRoundTwo.receipt_hash = digestNormalized(finalReviewRoundTwo.receipt);
    const finalRepairRoundTwo = action({
      id: "final-repair-result-cycle-2",
      action_kind: "final_repair",
      cycle: 2,
      status: "dispatched",
      attempt_ordinal: 6,
      unit_id: null,
      execution_unit_id: null,
      request_hash: "2".repeat(64),
      native_session_id: "native-session-final-repair-1",
    });
    const receipt = finalRepairCompletionReceipt("a".repeat(40), finalRepairRoundTwo, ["repaired using a stale round-1 request"]);
    const staleFenceReceipt = canonicalJson({
      ...JSON.parse(receipt),
      // Stale: points at round 1's finalRepair request_hash ("b".repeat(64)
      // in the cycle-1 tests above) instead of this round's "2".repeat(64).
      fence: { ...JSON.parse(receipt).fence, request_hash: "b".repeat(64) },
    });
    const failUnitAction = vi.fn();
    const completeUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        collectLoopActionResult: async () => ({
          actionId: finalRepairRoundTwo.id,
          attemptId: "parent-attempt",
          requestHash: "2".repeat(64),
          outcome: "success",
          nativeSessionId: "native-session-final-repair-1",
          subject: "a".repeat(40),
          receipt: staleFenceReceipt,
          completedAt: "2099-07-22T12:00:00.000Z",
        }),
      } as any,
      store: {
        leaseNextUnitAction: () => finalRepairRoundTwo,
        listWorkAttempts: () => [finalReviewRoundTwo, finalRepairRoundTwo],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
        failUnitAction,
        completeUnitAction,
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 7,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({
        stages: [{
          id: "structured",
          unitPhaseBindings: [{
            id: "lead",
            kind: "gate",
            loop: { skill: "builtin://accept-unit@1", timeout_seconds: 60 },
            worker: { id: "lead-worker", agent: "inherit", allowed_mcp_servers: [] },
            credentials: ["model.invoke", "repo.read"],
            context: "fresh",
          }],
        }],
      }),
    } as any, "parent-attempt");

    expect(completeUnitAction).not.toHaveBeenCalled();
    expect(failUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "final-repair-result-cycle-2",
      outcome: "failure",
      lastError: expect.stringContaining("completion receipt fence mismatch"),
    }));
  });

  it("captures a rotated Codex auth blob from a completed action-scoped Codex worker under a Claude-selected ticket", async () => {
    const implement = action({
      id: "implement-codex-worker",
      action_kind: "implement",
      cycle: 1,
      status: "dispatched",
      attempt_ordinal: 1,
      request_hash: "b".repeat(64),
    });
    const rotatedBlob = JSON.stringify({ tokens: { refresh_token: "rotated-refresh-token" } });
    const captureCodexAuth = vi.fn();
    const completeUnitAction = vi.fn();
    const failUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      captureCodexAuth,
      runtime: {
        // The action's own engine (a Codex worker override) rotated its
        // scoped CODEX_HOME auth even though the ticket itself is Claude.
        collectLoopActionResult: async () => ({
          actionId: implement.id,
          attemptId: "parent-attempt",
          requestHash: "b".repeat(64),
          outcome: "success",
          nativeSessionId: null,
          subject: "a".repeat(40),
          receipt: completionReceipt("a".repeat(40), implement),
          completedAt: "2099-07-22T12:00:00.000Z",
          codexAuthJson: rotatedBlob,
        }),
      } as any,
      store: {
        leaseNextUnitAction: () => implement,
        completeUnitAction,
        failUnitAction,
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      // The parent ticket's own engine is Claude; the completed action ran
      // as an explicit Codex worker override, so capture must key off the
      // action's own engine, not this field.
      agent: "claude",
      active_stage_id: "structured",
      generation: 1,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({
        stages: [{
          id: "structured",
          unitPhaseBindings: [{
            id: "implement",
            kind: "agent",
            loop: { skill: "builtin://implement-unit@1", timeout_seconds: 60 },
            worker: { id: "worker-1", agent: "inherit", allowed_mcp_servers: [] },
            credentials: ["model.invoke", "repo.read", "repo.write"],
            context: "fresh",
          }, {
            id: "lead",
            kind: "gate",
            loop: { skill: "builtin://accept-unit@1", timeout_seconds: 60 },
            worker: { id: "lead-worker", agent: "inherit", allowed_mcp_servers: [] },
            credentials: ["model.invoke", "repo.read"],
            context: "fresh",
          }],
        }],
      }),
    } as any, "parent-attempt");

    expect(failUnitAction).not.toHaveBeenCalled();
    expect(captureCodexAuth).toHaveBeenCalledTimes(1);
    expect(captureCodexAuth).toHaveBeenCalledWith(rotatedBlob);
    expect(completeUnitAction).toHaveBeenCalled();
  });

  it("never captures Codex auth from a non-Codex action's result", async () => {
    const implement = action({
      id: "implement-claude-worker",
      action_kind: "implement",
      cycle: 1,
      status: "dispatched",
      attempt_ordinal: 1,
      request_hash: "b".repeat(64),
    });
    const captureCodexAuth = vi.fn();
    const completeUnitAction = vi.fn();
    const failUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      captureCodexAuth,
      runtime: {
        collectLoopActionResult: async () => ({
          actionId: implement.id,
          attemptId: "parent-attempt",
          requestHash: "b".repeat(64),
          outcome: "success",
          nativeSessionId: null,
          subject: "a".repeat(40),
          receipt: completionReceipt("a".repeat(40), implement),
          completedAt: "2099-07-22T12:00:00.000Z",
          // A Claude (or OpenCode) action never carries this field.
        }),
      } as any,
      store: {
        leaseNextUnitAction: () => implement,
        completeUnitAction,
        failUnitAction,
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      agent: "claude",
      active_stage_id: "structured",
      generation: 1,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({
        stages: [{
          id: "structured",
          unitPhaseBindings: [{
            id: "implement",
            kind: "agent",
            loop: { skill: "builtin://implement-unit@1", timeout_seconds: 60 },
            worker: { id: "worker-1", agent: "inherit", allowed_mcp_servers: [] },
            credentials: ["model.invoke", "repo.read", "repo.write"],
            context: "fresh",
          }, {
            id: "lead",
            kind: "gate",
            loop: { skill: "builtin://accept-unit@1", timeout_seconds: 60 },
            worker: { id: "lead-worker", agent: "inherit", allowed_mcp_servers: [] },
            credentials: ["model.invoke", "repo.read"],
            context: "fresh",
          }],
        }],
      }),
    } as any, "parent-attempt");

    expect(failUnitAction).not.toHaveBeenCalled();
    expect(captureCodexAuth).not.toHaveBeenCalled();
    expect(completeUnitAction).toHaveBeenCalled();
  });

  it("gives a repair action the triggering lead decision and failing command evidence", async () => {
    const lead = action({
      id: "lead-cycle-1",
      action_kind: "lead",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 3,
      request_hash: "f".repeat(64),
      output_subject: "a".repeat(40),
    });
    lead.receipt = unitDecisionReceipt("unit_a", lead, "Fix the off-by-one in the paginator.");
    lead.receipt_hash = digestNormalized(lead.receipt);
    const command = action({
      id: "command-cycle-1",
      action_kind: "command",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 1,
      command_name: "test",
      request_hash: "e".repeat(64),
      output_subject: "a".repeat(40),
    });
    command.receipt = commandReceipt("a".repeat(40), command, "unit tests failed: off-by-one");
    command.receipt_hash = digestNormalized(command.receipt);
    const repair = action({
      id: "repair-cycle-2",
      action_kind: "repair",
      cycle: 2,
      status: "leased",
      attempt_ordinal: 4,
    });
    let dispatched: LoopActionRequest | undefined;
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        createWorktree: vi.fn(async () => ({ id: "worktree-handle" })),
        dispatchLoopAction: async (_resource: { providerResourceId: string }, request: LoopActionRequest) => {
          dispatched = request;
          return { providerDispatchId: "dispatch-1" };
        },
      } as any,
      store: {
        leaseNextUnitAction: () => repair,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        markActionWorktreeReady: vi.fn(),
        listWorkAttempts: () => [lead, command, repair],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload() }),
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 1,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({
        stages: [{
          id: "structured",
          unitPhaseBindings: [{
            id: "implement",
            kind: "agent",
            loop: { skill: "builtin://ce/implement@1", timeout_seconds: 60 },
            worker: { id: "unit-worker", agent: "inherit", allowed_mcp_servers: [] },
            credentials: ["model.invoke", "provider.read", "repo.read"],
            context: "resume_required",
          }],
        }],
      }),
    } as any, "parent-attempt");

    expect(dispatched).toMatchObject({
      actionId: "repair-cycle-2",
      skill: "repair-unit",
      loop: "repair",
      priorEvidence: {
        schema: "openthrottle.loop-prior-evidence/v1",
        role: "repair",
      },
    });
    expect(dispatched?.priorEvidence?.receipts.map((receipt) => receipt.role)).toEqual(["lead", "command"]);
    expect(dispatched?.priorEvidence?.receipts[0]?.receipt).toContain("Fix the off-by-one in the paginator.");
    expect(dispatched?.priorEvidence?.receipts[1]?.receipt).toContain("unit tests failed: off-by-one");
  });

  it("fails closed before repair dispatch when the triggering lead receipt's request-hash fence does not match", async () => {
    const lead = action({
      id: "lead-cycle-1-invalid",
      action_kind: "lead",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 3,
      request_hash: "f".repeat(64),
      output_subject: "a".repeat(40),
    });
    lead.receipt = unitDecisionReceipt("unit_a", lead, "Fix the off-by-one in the paginator.");
    const receipt = JSON.parse(lead.receipt);
    lead.receipt = canonicalJson({ ...receipt, fence: { ...receipt.fence, request_hash: "1".repeat(64) } });
    lead.receipt_hash = digestNormalized(lead.receipt);
    const repair = action({
      id: "repair-cycle-2-invalid",
      action_kind: "repair",
      cycle: 2,
      status: "leased",
      attempt_ordinal: 4,
    });
    const dispatchLoopAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        createWorktree: vi.fn(async () => ({ id: "worktree-handle" })),
        dispatchLoopAction,
      } as any,
      store: {
        leaseNextUnitAction: () => repair,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        markActionWorktreeReady: vi.fn(),
        listWorkAttempts: () => [lead, repair],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload() }),
      } as any,
    });

    await expect(childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 1,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({
        stages: [{
          id: "structured",
          unitPhaseBindings: [{
            id: "implement",
            kind: "agent",
            loop: { skill: "builtin://ce/implement@1", timeout_seconds: 60 },
            worker: { id: "unit-worker", agent: "inherit", allowed_mcp_servers: [] },
            credentials: ["model.invoke", "provider.read", "repo.read"],
            context: "resume_required",
          }],
        }],
      }),
    } as any, "parent-attempt")).rejects.toThrow(/triggering lead fence is invalid/);
    expect(dispatchLoopAction).not.toHaveBeenCalled();
  });

  it("keeps an empty typed prior-evidence envelope on final review dispatch", async () => {
    const finalReview = action({
      id: "final-review-no-commands",
      action_kind: "final_review",
      cycle: 1,
      status: "leased",
      attempt_ordinal: 5,
      unit_id: null,
      execution_unit_id: null,
    });
    let dispatched: LoopActionRequest | undefined;
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        dispatchLoopAction: async (_resource: { providerResourceId: string }, request: LoopActionRequest) => {
          dispatched = request;
          return { providerDispatchId: "dispatch-review" };
        },
      } as any,
      store: {
        ...reviewSubactionDispatchStore(),
        leaseNextUnitAction: () => finalReview,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        listWorkAttempts: () => [finalReview],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload() }),
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 7,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({ stages: [{ id: "structured", unitPhaseBindings: [] }] }),
    } as any, "parent-attempt");

    expect(dispatched).toMatchObject({
      actionId: "final-review-no-commands.review.selector",
      role: "reviewer",
      loop: "review",
      timeoutMs: 300_000,
      priorEvidence: {
        schema: "openthrottle.loop-prior-evidence/v1",
        role: "final_review",
        receipts: [],
      },
    });
  });

  it("rejects a legacy in-flight final review that bypasses the selector boundary", async () => {
    const integratedSubject = "b".repeat(40);
    const requestHash = "e".repeat(64);
    const finalReview = action({
      id: "legacy-final-review",
      action_kind: "final_review",
      cycle: 1,
      status: "dispatched",
      attempt_ordinal: 5,
      unit_id: null,
      execution_unit_id: null,
      request_hash: requestHash,
      request_payload: canonicalJson({
        protocol: "loop-action@2",
        baseSubject: integratedSubject,
      }),
      request_launch_state: "launched",
    });
    const receipt = semanticReviewReceipt(
      integratedSubject,
      finalReview,
      "legacy final-review base",
      integratedSubject
    );
    const completeGatedAction = vi.fn();
    const failUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        collectLoopActionResult: async () => ({
          actionId: finalReview.id,
          attemptId: "parent-attempt",
          requestHash,
          outcome: "success",
          nativeSessionId: null,
          subject: integratedSubject,
          receipt,
          completedAt: "2099-07-22T12:00:00.000Z",
        }),
      } as any,
      store: {
        leaseNextUnitAction: () => finalReview,
        completeGatedAction,
        failUnitAction,
        listWorkAttempts: () => [finalReview],
        getGraphForAttempt: () => ({
          integration_subject: integratedSubject,
          command_names: "[]",
        }),
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 7,
      base_commit: "a".repeat(40),
      immutable_subject: integratedSubject,
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({
        stages: [{
          id: "structured",
          unitPhaseBindings: [
            {
              id: "implement",
              kind: "agent",
              loop: { skill: "builtin://ce/implement@1", timeout_seconds: 60 },
              worker: { id: "worker-1", agent: "inherit", allowed_mcp_servers: [] },
              credentials: ["model.invoke", "provider.read", "repo.read"],
              context: "resume_required",
            },
            {
              id: "lead",
              kind: "gate",
              loop: { skill: "builtin://accept-unit@1", timeout_seconds: 60 },
              worker: { id: "lead-worker", agent: "inherit", allowed_mcp_servers: [] },
              credentials: ["model.invoke", "repo.read"],
              context: "fresh",
            },
          ],
        }],
      }),
    } as any, "parent-attempt");

    expect(completeGatedAction).not.toHaveBeenCalled();
    expect(failUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: finalReview.id,
      lastError: expect.stringMatching(/final review request is not the sealed selector action/),
    }));
  });

  it("dispatches lead review against the current cycle candidate evidence", async () => {
    const staleCandidateSubject = "1".repeat(40);
    const currentCandidateSubject = "2".repeat(40);
    const staleCandidate = action({
      id: "candidate-cycle-1",
      action_kind: "candidate",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 1,
      output_subject: staleCandidateSubject,
      receipt: null,
      created_at: "2100-01-01T00:00:00.000Z",
      completed_at: "2100-01-01T00:00:00.000Z",
    });
    staleCandidate.receipt = candidateReceipt(staleCandidateSubject, staleCandidate);
    staleCandidate.receipt_hash = digestNormalized(staleCandidate.receipt);
    const currentCandidate = action({
      id: "candidate-cycle-2",
      action_kind: "candidate",
      cycle: 2,
      status: "completed",
      attempt_ordinal: 2,
      output_subject: currentCandidateSubject,
      receipt: null,
      created_at: "2099-01-01T00:00:00.000Z",
      completed_at: "2099-01-01T00:00:00.000Z",
    });
    currentCandidate.receipt = candidateReceipt(currentCandidateSubject, currentCandidate);
    currentCandidate.receipt_hash = digestNormalized(currentCandidate.receipt);
    const completion = action({
      id: "implement-cycle-2",
      action_kind: "implement",
      cycle: 2,
      status: "completed",
      attempt_ordinal: 1,
      request_hash: "f".repeat(64),
      output_subject: currentCandidateSubject,
      receipt: null,
      created_at: "2099-01-01T00:00:00.000Z",
      completed_at: "2099-01-01T00:00:00.000Z",
    });
    completion.receipt = completionReceipt(currentCandidateSubject, completion);
    completion.receipt_hash = digestNormalized(completion.receipt);
    const lead = action({
      id: "lead-cycle-2",
      action_kind: "lead",
      cycle: 2,
      status: "leased",
      attempt_ordinal: 3,
    });
    let dispatched: LoopActionRequest | undefined;
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        dispatchLoopAction: async (_resource: { providerResourceId: string }, request: LoopActionRequest) => {
          dispatched = request;
          return { providerDispatchId: "dispatch-1" };
        },
      } as any,
      store: {
        leaseNextUnitAction: () => lead,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        listUnits: () => [unit({
          unitId: "unit_a",
          ordinal: 0,
          status: "running",
          phase: "lead",
          currentCycle: 2,
          integrationSubject: null,
          terminalLevel: null,
        })],
        listWorkAttempts: () => [staleCandidate, completion, currentCandidate, lead],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload() }),
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 1,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({
        stages: [{
          id: "structured",
          unitPhaseBindings: [{
            id: "lead",
            kind: "gate",
            loop: {
              skill: "builtin://accept-unit@1",
              timeout_seconds: 60,
            },
            worker: {
              id: "lead-worker",
              agent: "inherit",
              allowed_mcp_servers: [],
            },
            credentials: ["model.invoke", "repo.read"],
            context: "fresh",
          }],
        }],
      }),
    } as any, "parent-attempt");

    expect(dispatched).toMatchObject({
      actionId: "lead-cycle-2",
      candidateSubject: currentCandidateSubject,
      priorEvidence: {
        schema: "openthrottle.loop-prior-evidence/v1",
        role: "lead",
      },
    });
    expect(dispatched?.priorEvidence?.receipts.map((receipt) => receipt.role)).toEqual(["completion", "candidate"]);
    expect(dispatched?.priorEvidence?.receipts[1]?.actionAttemptId).toBe("candidate-cycle-2");
  });

  it("gives a second-cycle final review the first round's findings and its intervening repair completion", async () => {
    const priorFinalReview = action({
      id: "final-review-cycle-1",
      action_kind: "final_review",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 3,
      unit_id: null,
      execution_unit_id: null,
      request_hash: "e".repeat(64),
      output_subject: "a".repeat(40),
    });
    priorFinalReview.receipt = semanticReviewReceipt("a".repeat(40), priorFinalReview, "first round finding");
    priorFinalReview.receipt_hash = digestNormalized(priorFinalReview.receipt);
    const priorFinalRepair = action({
      id: "final-repair-cycle-1",
      action_kind: "final_repair",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 4,
      unit_id: null,
      execution_unit_id: null,
      request_hash: "9".repeat(64),
      native_session_id: "native-session-final-repair-1",
    });
    priorFinalRepair.receipt = finalRepairCompletionReceipt("a".repeat(40), priorFinalRepair, ["repaired the first round finding"]);
    priorFinalRepair.receipt_hash = digestNormalized(priorFinalRepair.receipt);
    const finalReviewRoundTwo = action({
      id: "final-review-cycle-2",
      action_kind: "final_review",
      cycle: 2,
      status: "leased",
      attempt_ordinal: 5,
      unit_id: null,
      execution_unit_id: null,
    });
    let dispatched: LoopActionRequest | undefined;
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        dispatchLoopAction: async (_resource: { providerResourceId: string }, request: LoopActionRequest) => {
          dispatched = request;
          return { providerDispatchId: "dispatch-review-2" };
        },
      } as any,
      store: {
        ...reviewSubactionDispatchStore(),
        leaseNextUnitAction: () => finalReviewRoundTwo,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        listGateReceipts: () => [],
        listWorkAttempts: () => [priorFinalReview, priorFinalRepair, finalReviewRoundTwo],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload() }),
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 7,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({ stages: [{ id: "structured", unitPhaseBindings: [] }] }),
    } as any, "parent-attempt");

    expect(dispatched).toMatchObject({
      actionId: "final-review-cycle-2.review.selector",
      role: "reviewer",
      loop: "review",
      priorEvidence: {
        schema: "openthrottle.loop-prior-evidence/v1",
        role: "final_review",
      },
    });
    expect(dispatched?.priorEvidence?.receipts.map((receipt) => receipt.role)).toEqual(["final_review", "final_repair"]);
    expect(dispatched?.priorEvidence?.receipts[0]?.receipt).toContain("first round finding");
    expect(dispatched?.priorEvidence?.receipts[1]?.receipt).toContain("repaired the first round finding");
  });

  it("gives a second-cycle final review only the prior round's findings when no intervening repair completion is on record", async () => {
    const priorFinalReview = action({
      id: "final-review-cycle-1-no-repair",
      action_kind: "final_review",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 3,
      unit_id: null,
      execution_unit_id: null,
      request_hash: "e".repeat(64),
      output_subject: "a".repeat(40),
    });
    priorFinalReview.receipt = semanticReviewReceipt("a".repeat(40), priorFinalReview, "first round finding");
    priorFinalReview.receipt_hash = digestNormalized(priorFinalReview.receipt);
    const finalReviewRoundTwo = action({
      id: "final-review-cycle-2-no-repair",
      action_kind: "final_review",
      cycle: 2,
      status: "leased",
      attempt_ordinal: 5,
      unit_id: null,
      execution_unit_id: null,
    });
    let dispatched: LoopActionRequest | undefined;
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        dispatchLoopAction: async (_resource: { providerResourceId: string }, request: LoopActionRequest) => {
          dispatched = request;
          return { providerDispatchId: "dispatch-review-2" };
        },
      } as any,
      store: {
        ...reviewSubactionDispatchStore(),
        leaseNextUnitAction: () => finalReviewRoundTwo,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        listGateReceipts: () => [],
        listWorkAttempts: () => [priorFinalReview, finalReviewRoundTwo],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload() }),
      } as any,
    });

    await childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 7,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({ stages: [{ id: "structured", unitPhaseBindings: [] }] }),
    } as any, "parent-attempt");

    expect(dispatched?.priorEvidence?.receipts.map((receipt) => receipt.role)).toEqual(["final_review"]);
    expect(dispatched?.priorEvidence?.receipts[0]?.receipt).toContain("first round finding");
  });

  it("fails closed before dispatch when lead prior evidence exceeds the aggregate budget", async () => {
    const subject = "2".repeat(40);
    const completion = action({
      id: "implement-large-evidence",
      action_kind: "implement",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 1,
      request_hash: "f".repeat(64),
      output_subject: subject,
    });
    completion.receipt = completionReceipt(subject, completion);
    completion.receipt_hash = digestNormalized(completion.receipt);
    const candidate = action({
      id: "candidate-large-evidence",
      action_kind: "candidate",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 2,
      request_hash: "e".repeat(64),
      output_subject: subject,
    });
    candidate.receipt = candidateReceipt(subject, candidate);
    candidate.receipt_hash = digestNormalized(candidate.receipt);
    const commands = Array.from({ length: 16 }, (_, index) => {
      const command = action({
        id: `command-large-evidence-${index}`,
        action_kind: "command",
        cycle: 1,
        status: "completed",
        attempt_ordinal: 3 + index,
        command_name: `test${index}`,
        request_hash: digestNormalized(`command-many-receipts-${index}`),
        output_subject: subject,
      });
      command.receipt = commandReceipt(subject, command, "x".repeat(4_000));
      command.receipt_hash = digestNormalized(command.receipt);
      return command;
    });
    const lead = action({
      id: "lead-large-evidence",
      action_kind: "lead",
      cycle: 1,
      status: "leased",
      attempt_ordinal: 20,
    });
    const dispatchLoopAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: { dispatchLoopAction } as any,
      store: {
        leaseNextUnitAction: () => lead,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        listUnits: () => [unit({
          unitId: "unit_a",
          ordinal: 0,
          status: "running",
          phase: "lead",
          currentCycle: 1,
          integrationSubject: null,
          terminalLevel: null,
        })],
        listWorkAttempts: () => [completion, candidate, ...commands, lead],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: JSON.stringify(commands.map((command) => command.command_name)),
        }),
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload() }),
      } as any,
    });

    await expect(childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 1,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({
        stages: [{
          id: "structured",
          unitPhaseBindings: [{
            id: "lead",
            kind: "gate",
            loop: { skill: "builtin://accept-unit@1", timeout_seconds: 60 },
            worker: { id: "lead-worker", agent: "inherit", allowed_mcp_servers: [] },
            credentials: ["model.invoke", "repo.read"],
            context: "fresh",
          }],
        }],
      }),
    } as any, "parent-attempt")).rejects.toThrow(/prior evidence exceeds aggregate bound/);
    expect(dispatchLoopAction).not.toHaveBeenCalled();
  });

  it("fails closed before dispatch when lead prior evidence exceeds the receipt-count budget", async () => {
    const subject = "2".repeat(40);
    const completion = action({
      id: "implement-many-receipts",
      action_kind: "implement",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 1,
      request_hash: "f".repeat(64),
      output_subject: subject,
    });
    completion.receipt = completionReceipt(subject, completion);
    completion.receipt_hash = digestNormalized(completion.receipt);
    const candidate = action({
      id: "candidate-many-receipts",
      action_kind: "candidate",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 2,
      request_hash: "e".repeat(64),
      output_subject: subject,
    });
    candidate.receipt = candidateReceipt(subject, candidate);
    candidate.receipt_hash = digestNormalized(candidate.receipt);
    const commands = Array.from({ length: 17 }, (_, index) => {
      const command = action({
        id: `command-many-receipts-${index}`,
        action_kind: "command",
        cycle: 1,
        status: "completed",
        attempt_ordinal: 3 + index,
        command_name: `test${index}`,
        request_hash: digestNormalized(`command-count-receipts-${index}`),
        output_subject: subject,
      });
      command.receipt = commandReceipt(subject, command);
      command.receipt_hash = digestNormalized(command.receipt);
      return command;
    });
    const lead = action({
      id: "lead-many-receipts",
      action_kind: "lead",
      cycle: 1,
      status: "leased",
      attempt_ordinal: 21,
    });
    const dispatchLoopAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: { dispatchLoopAction } as any,
      store: {
        leaseNextUnitAction: () => lead,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        listUnits: () => [unit({
          unitId: "unit_a",
          ordinal: 0,
          status: "running",
          phase: "lead",
          currentCycle: 1,
          integrationSubject: null,
          terminalLevel: null,
        })],
        listWorkAttempts: () => [completion, candidate, ...commands, lead],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: JSON.stringify(commands.map((command) => command.command_name)),
        }),
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload() }),
      } as any,
    });

    await expect(childRuntime.drainCompositeChildren({ providerResourceId: "sandbox-1" }, {
      id: "instance-1",
      active_stage_id: "structured",
      agent: "codex",
      generation: 1,
      base_commit: "a".repeat(40),
      immutable_subject: "a".repeat(40),
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({
        stages: [{
          id: "structured",
          unitPhaseBindings: [{
            id: "lead",
            kind: "gate",
            loop: { skill: "builtin://accept-unit@1", timeout_seconds: 60 },
            worker: { id: "lead-worker", agent: "inherit", allowed_mcp_servers: [] },
            credentials: ["model.invoke", "repo.read"],
            context: "fresh",
          }],
        }],
      }),
    } as any, "parent-attempt")).rejects.toThrow(/prior evidence has too many receipts/);
    expect(dispatchLoopAction).not.toHaveBeenCalled();
  });
});
