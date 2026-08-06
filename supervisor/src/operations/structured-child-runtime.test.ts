import { describe, expect, it, vi } from "vitest";
import { canonicalJson, digestNormalized } from "../pipeline/manifest.js";
import type { ExecutionGateReceipt, ExecutionWorkAttempt } from "../persistence/pipeline/unit-store.js";
import type { ExecutionUnitState } from "../pipeline/unit-coordinator.js";
import type { LoopActionRequest } from "../runtime/contracts.js";
import { aggregateOutcomeFor, createStructuredChildRuntime } from "./structured-child-runtime.js";

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
    receipt: null,
    receipt_hash: null,
    native_session_id: null,
    lease_owner: null,
    lease_until: null,
    output_subject: null,
    payload: "",
    created_at: `2099-07-22T12:00:0${overrides.cycle}.000Z`,
    updated_at: "2099-07-22T12:00:00.000Z",
    completed_at: null,
    last_error: null,
    ...overrides,
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
              timeout_seconds: 60,
            },
            worker: {
              id: "worker-1",
              agent: "inherit",
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
      generation: 7,
      baseSubject: "a".repeat(40),
      inputSubject: "a".repeat(40),
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
        listWorkAttempts: () => [staleCandidate, currentCandidate, lead],
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
    });
  });
});
