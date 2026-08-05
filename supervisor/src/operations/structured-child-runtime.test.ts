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

describe("structured child runtime repair fences", () => {
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
