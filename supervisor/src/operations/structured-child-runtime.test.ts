import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson, digestNormalized, type ExecutionPlanContractV2 } from "@openthrottle/contracts";
import type { ExecutionGateReceipt, ExecutionWorkAttempt } from "../persistence/pipeline/unit-store.js";
import type { ExecutionUnitState } from "../pipeline/unit-coordinator.js";
import type { ChildExecutorActionRequest, LoopActionRequest, SandboxRuntime } from "../runtime/contracts.js";
import { MAX_VALID_DOWNSTREAM_CONTEXT, structuredPlanLoopEnvelopeBytes } from "../pipeline/structured-loop-envelope.js";
import { MAX_LOOP_REQUEST_ENVELOPE_BYTES } from "../pipeline/structured-loop-limits.js";
import {
  aggregateOutcomeFor,
  assertStructuredPlanEnvelopeBoundForInstance,
  createStructuredChildRuntime as createProductionStructuredChildRuntime,
  structuredPlanContextFor,
} from "./structured-child-runtime.js";

function automaticStructuredPlanFixture() {
  const manifestDigest = "c".repeat(64);
  const subject = "a".repeat(40);
  const executionPlan = {
    schema: "openthrottle.execution-plan/v2",
    graph_id: "structured",
    plan_id: "automatic",
    units: [{
      id: "unit_a", title: "Unit A", depends_on: [], objective: "Implement it.",
      requirements: ["Keep the contract."], files: ["src/a.ts"], approach: ["Follow patterns."],
      tests: ["Covers success."], acceptance: ["It works."], verification: ["npm test"],
    }],
    commands: [{ name: "test" }],
  };
  const wrapper = {
    schema: "openthrottle.admission-execution-plan-artifact/v1",
    execution_plan: executionPlan,
    generated_plan_digest: digestNormalized(canonicalJson(executionPlan)),
    producer: {
      skill: "builtin://admission-plan@1",
      capability_digest: "d".repeat(64),
      skill_package_digest: null,
    },
    assurance: "executor_verified",
    source: {
      admission_basis_digest: "e".repeat(64),
      effective_manifest_digest: manifestDigest,
      request_hash: "f".repeat(64),
    },
  };
  const artifact = {
    kind: "execution_plan" as const,
    schemaVersion: 1,
    assurance: "executor_verified" as const,
    subject,
    payload: canonicalJson(wrapper),
    hash: digestNormalized(canonicalJson(wrapper)),
  };
  const instance = {
    pipeline_id: "core/automatic/identity",
    manifest_digest: manifestDigest,
    normalized_manifest: canonicalJson({
      stages: [
        { id: "admission_planner", loop: { skill: "builtin://admission-plan@1" }, executor: { kind: "agent" } },
        { id: "structured_edit", executor: { kind: "loop_action", capability: "graph/for-each-unit@1" } },
      ],
    }),
  };
  const request = { inputArtifacts: [artifact], expectedSubject: subject, taskContext: "bounded ticket" };
  return { instance, request, artifact, wrapper, executionPlan };
}

describe("automatic structured-plan bridge", () => {
  it("consumes only the immediate executor-verified exact-subject wrapper", () => {
    const input = automaticStructuredPlanFixture();
    const context = structuredPlanContextFor(input.instance, input.request, input.wrapper.source.admission_basis_digest);
    expect(context).toContain("openthrottle.execution-plan/v2");
    expect(context).toContain('"unit_a"');
  });

  it("accepts the nearest valid automatic plan below the child envelope and rejects the next size", () => {
    const input = automaticStructuredPlanFixture();
    const planAt = (scale: number): ExecutionPlanContractV2 => ({
      schema: "openthrottle.execution-plan/v2",
      graph_id: "structured",
      plan_id: "near_limit",
      units: [{
        id: "unit_a", title: "Unit A", depends_on: [], objective: "x".repeat(scale),
        requirements: Array.from({ length: 32 }, () => "x".repeat(scale)),
        files: ["src/a.ts"],
        approach: Array.from({ length: 32 }, () => "x".repeat(scale)),
        tests: Array.from({ length: 32 }, () => "x".repeat(scale)),
        acceptance: Array.from({ length: 32 }, () => "x".repeat(scale)),
        verification: Array.from({ length: 32 }, () => "x".repeat(scale)),
      }],
      commands: [{ name: "test" }],
    });
    let low = 1;
    let high = 2_000;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (structuredPlanLoopEnvelopeBytes(planAt(mid)) <= MAX_LOOP_REQUEST_ENVELOPE_BYTES) low = mid;
      else high = mid - 1;
    }
    const accepted = planAt(low);
    const rejected = planAt(low + 1);
    expect(MAX_LOOP_REQUEST_ENVELOPE_BYTES - structuredPlanLoopEnvelopeBytes(accepted)).toBeLessThan(512);
    expect(structuredPlanLoopEnvelopeBytes(rejected)).toBeGreaterThan(MAX_LOOP_REQUEST_ENVELOPE_BYTES);
    expect(() => assertStructuredPlanEnvelopeBoundForInstance({ ...input.instance, agent: "codex" }, accepted)).not.toThrow();
    expect(() => assertStructuredPlanEnvelopeBoundForInstance({ ...input.instance, agent: "codex" }, rejected))
      .toThrow(/child loop request/);
  });

  it("rejects stale, substituted, duplicate, wrong-lineage, and downgraded wrappers", () => {
    const input = automaticStructuredPlanFixture();
    expect(() => structuredPlanContextFor(input.instance, {
      ...input.request,
      expectedSubject: "b".repeat(40),
    }, input.wrapper.source.admission_basis_digest)).toThrow(/subject mismatch/);
    expect(() => structuredPlanContextFor(input.instance, {
      ...input.request,
      inputArtifacts: [{ ...input.artifact, hash: "0".repeat(64) }],
    }, input.wrapper.source.admission_basis_digest)).toThrow(/hash mismatch/);
    expect(() => structuredPlanContextFor(input.instance, {
      ...input.request,
      inputArtifacts: [input.artifact, input.artifact],
    }, input.wrapper.source.admission_basis_digest)).toThrow(/exactly one/);

    const wrongLineage = {
      ...input.wrapper,
      source: { ...input.wrapper.source, effective_manifest_digest: "1".repeat(64) },
    };
    expect(() => structuredPlanContextFor(input.instance, {
      ...input.request,
      inputArtifacts: [{
        ...input.artifact,
        payload: canonicalJson(wrongLineage),
        hash: digestNormalized(canonicalJson(wrongLineage)),
      }],
    }, input.wrapper.source.admission_basis_digest)).toThrow(/manifest lineage mismatch/);

    const downgraded = { ...input.wrapper, assurance: "semantic_attested" };
    expect(() => structuredPlanContextFor(input.instance, {
      ...input.request,
      inputArtifacts: [{
        ...input.artifact,
        payload: canonicalJson(downgraded),
        hash: digestNormalized(canonicalJson(downgraded)),
      }],
    }, input.wrapper.source.admission_basis_digest)).toThrow(/wrapper assurance mismatch/);

    expect(() => structuredPlanContextFor(
      input.instance,
      input.request,
      "2".repeat(64),
    )).toThrow(/admission basis mismatch/);
  });
});

function createStructuredChildRuntime(
  deps: Parameters<typeof createProductionStructuredChildRuntime>[0]
): ReturnType<typeof createProductionStructuredChildRuntime> {
  return createProductionStructuredChildRuntime({
    ...deps,
    store: Object.assign({
      completeGatedAction: vi.fn(),
      completeUnitAction: vi.fn(),
      failUnitAction: vi.fn(),
      healExpiredCurrentChildAction: vi.fn(),
      recordActionObservationFailure: vi.fn(),
      stopRetryableUnitAction: vi.fn(),
    }, deps.store, {
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

function candidateReceipt(
  subject: string,
  attempt: ExecutionWorkAttempt,
  preSubject = "a".repeat(40),
  baseSubject = "a".repeat(40)
): string {
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
      base: baseSubject,
      pre: preSubject,
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

function completedCandidateAction(input: {
  id: string;
  subject: string;
  cycle?: number;
  attemptOrdinal?: number;
  preSubject?: string;
  baseSubject?: string;
  outputSubject?: string;
}): ExecutionWorkAttempt {
  const candidate = action({
    id: input.id,
    action_kind: "candidate",
    cycle: input.cycle ?? 1,
    status: "completed",
    attempt_ordinal: input.attemptOrdinal ?? 2,
    request_hash: "b".repeat(64),
    output_subject: input.outputSubject ?? input.subject,
  });
  candidate.receipt = candidateReceipt(input.subject, candidate, input.preSubject, input.baseSubject);
  candidate.receipt_hash = digestNormalized(candidate.receipt);
  return candidate;
}

function worktreeHandleId(action: ExecutionWorkAttempt, baseCommit: string): string {
  return digestNormalized(canonicalJson({
    idempotencyKey: `worktree:${action.parent_attempt_id}:${action.unit_id ?? "final"}:${action.cycle}`,
    attemptId: action.parent_attempt_id,
    baseCommit,
  })).slice(0, 32);
}

function completionReceipt(
  subject: string,
  attempt: ExecutionWorkAttempt,
  preSubject = "a".repeat(40),
  baseSubject = "a".repeat(40)
): string {
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
      base: baseSubject,
      pre: preSubject,
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

function unitDecisionReceipt(
  unitId: string,
  attempt: ExecutionWorkAttempt,
  revisionRequest: string,
  subject = "a".repeat(40)
): string {
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
      pre: subject,
      post: subject,
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

function structuredInstance(
  overrides: Record<string, unknown> = {},
  unitPhaseBindings: unknown[] = []
): any {
  return {
    id: "instance-1",
    active_stage_id: "structured",
    agent: "codex",
    generation: 1,
    base_commit: "a".repeat(40),
    immutable_subject: "a".repeat(40),
    manifest_digest: "c".repeat(64),
    capability_digest: "d".repeat(64),
    normalized_manifest: canonicalJson({ stages: [{ id: "structured", unitPhaseBindings }] }),
    ...overrides,
  };
}

function repairStructuredInstance(overrides: Record<string, unknown> = {}): any {
  return structuredInstance(overrides, [{
    id: "implement",
    kind: "agent",
    loop: { skill: "builtin://ce/implement@1", timeout_seconds: 60 },
    worker: { id: "unit-worker", agent: "inherit", allowed_mcp_servers: [] },
    credentials: ["model.invoke", "provider.read", "repo.read"],
    context: "resume_required",
  }]);
}

function repairCycleStructuredInstance(overrides: Record<string, unknown> = {}): any {
  return structuredInstance(overrides, [{
    id: "implement",
    kind: "agent",
    loop: { skill: "builtin://ce/implement@1", timeout_seconds: 60 },
    worker: { id: "unit-worker", agent: "inherit", allowed_mcp_servers: [] },
    credentials: ["model.invoke", "provider.read", "repo.read"],
    context: "resume_required",
  }, {
    id: "simplify",
    kind: "agent",
    loop: { skill: "builtin://ce/simplify@1", timeout_seconds: 60 },
    worker: { id: "unit-worker", agent: "inherit", allowed_mcp_servers: [] },
    credentials: ["model.invoke", "provider.read", "repo.read"],
    context: "resume_required",
  }, {
    id: "lead",
    kind: "gate",
    loop: { skill: "builtin://accept-unit@1", timeout_seconds: 60 },
    worker: { id: "lead-worker", agent: "inherit", allowed_mcp_servers: [] },
    credentials: ["model.invoke", "repo.read"],
    context: "fresh",
  }]);
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

  it("preserves an exact needs_human action outcome when another unit failed", () => {
    const needsHumanAttempt = action({
      id: "needs-human-unit-a",
      action_kind: "implement",
      cycle: 1,
      status: "failed",
      terminal_result_outcome: "needs_human",
    });
    const failedAttempt = action({
      id: "failed-unit-b",
      action_kind: "implement",
      cycle: 1,
      status: "failed",
      unit_id: "unit_b",
      execution_unit_id: "unit-row-b",
      terminal_result_outcome: "failure",
    });

    expect(aggregateOutcomeFor([
      unit({
        unitId: "unit_a",
        ordinal: 0,
        status: "exited",
        terminalLevel: "exited",
        integrationSubject: null,
      }),
      unit({
        unitId: "unit_b",
        ordinal: 1,
        status: "failed",
        terminalLevel: "failed",
        alarm: true,
        integrationSubject: null,
      }),
    ], [], [needsHumanAttempt, failedAttempt])).toBe("needs_human");
  });

  it("keeps needs_human preservation above a concurrent retryable attempt", () => {
    const needsHumanAttempt = action({
      id: "needs-human-final-repair",
      action_kind: "final_repair",
      cycle: 1,
      status: "failed",
      unit_id: null,
      execution_unit_id: null,
      terminal_result_outcome: "needs_human",
    });
    const retryableAttempt = action({
      id: "retryable-provider-stop",
      action_kind: "final_review",
      cycle: 1,
      status: "dead",
      unit_id: null,
      execution_unit_id: null,
      terminal_result_outcome: "retryable_infrastructure_failure",
    });

    expect(aggregateOutcomeFor([
      unit({
        unitId: "unit_a",
        ordinal: 0,
        status: "failed",
        terminalLevel: "failed",
        alarm: true,
        integrationSubject: null,
      }),
    ], [], [needsHumanAttempt, retryableAttempt])).toBe("needs_human");
  });

  it("keeps the prior needs_human fallback for a structurally exited dependent", () => {
    const subject = "1".repeat(40);

    expect(aggregateOutcomeFor([
      unit({ unitId: "unit_a", ordinal: 0, integrationSubject: subject }),
      unit({
        unitId: "unit_b",
        ordinal: 1,
        dependencies: ["unit_a"],
        status: "exited",
        terminalLevel: "exited",
        integrationSubject: null,
      }),
    ], [integrationGate("unit_a", subject)])).toBe("needs_human");
  });

  it("drains a stopped final-repair needs_human result as a preserving parent outcome", async () => {
    const subject = "1".repeat(40);
    const finalRepair = action({
      id: "final-repair-needs-human",
      action_kind: "final_repair",
      cycle: 1,
      status: "failed",
      unit_id: null,
      execution_unit_id: null,
      terminal_result_outcome: "needs_human",
      result_hash: "2".repeat(64),
      completed_at: "2099-07-22T12:00:00.000Z",
      last_error: "needs_human: operator decision required",
    });
    const retryableAttempt = action({
      id: "concurrent-retryable-stop",
      action_kind: "final_review",
      cycle: 1,
      status: "dead",
      unit_id: null,
      execution_unit_id: null,
      terminal_result_outcome: "retryable_infrastructure_failure",
      result_hash: "4".repeat(64),
      completed_at: "2099-07-22T12:00:00.000Z",
      last_error: "retryable_infrastructure_failure: provider unavailable",
    });
    const parentAttempt = {
      id: "parent-attempt",
      pipeline_instance_id: "instance-1",
      stage_id: "structured",
      attempt_ordinal: 1,
      reentry_ordinal: 0,
      run_id: "run-1",
      planned_run_id: null,
      expected_subject: subject,
      native_session_id: null,
      request_payload: parentAttemptRequestPayload(),
      request_hash: "3".repeat(64),
      idempotency_key: "parent-idempotency-key",
      context_revision: 1,
      native_context_policy: "fresh",
      status: "running",
      outcome: null,
      result_hash: null,
      started_at: "2099-07-22T11:59:00.000Z",
      completed_at: null,
      created_at: "2099-07-22T11:59:00.000Z",
      updated_at: "2099-07-22T11:59:00.000Z",
    };
    const instance = {
      id: "instance-1",
      ticket_id: "ticket-1",
      session_id: "session-1",
      generation: 7,
      repository: "knoxgraeme/openthrottle",
      base_commit: "a".repeat(40),
      immutable_subject: subject,
      runtime_release: "test-runtime",
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({
        stages: [{
          id: "structured",
          executor: { capability: "graph/for-each-unit@1" },
          evaluator: { assurance: "semantic_attested" },
        }],
      }),
    };
    const completeParentStage = vi.fn(() => instance as any);
    const emitAggregateOnce = vi.fn(() => "emitted" as const);
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {} as SandboxRuntime,
      completeParentStage,
      store: {
        leaseNextUnitAction: () => undefined,
        getGraphForAttempt: () => ({
          stopped_at: "2099-07-22T12:00:00.000Z",
          stop_reason: "retryable_infrastructure_failure: provider unavailable",
          integration_subject: subject,
          final_phase: "repair",
          aggregate_emitted_at: null,
          aggregate_artifact_hash: null,
        }),
        getAttempt: () => parentAttempt,
        listUnits: () => [unit({ unitId: "unit_a", ordinal: 0, integrationSubject: subject })],
        listWorkAttempts: () => [finalRepair, retryableAttempt],
        listGateReceipts: () => [],
        emitAggregateOnce,
      } as any,
    });

    await childRuntime.drainCompositeChildren(
      { providerResourceId: "sandbox-1" },
      instance as any,
      "parent-attempt"
    );

    expect(emitAggregateOnce).toHaveBeenCalledWith(expect.objectContaining({
      parentAttemptId: "parent-attempt",
      requireFinalReview: false,
    }));
    expect(completeParentStage).toHaveBeenCalledWith(expect.objectContaining({
      kind: "stage_result",
      outcome: "needs_human",
      subject,
    }));
  });

  it.each([
    {
      name: "a typed non-retry stop never becomes an infra retry on agent-authored stop text",
      stopOutcome: "failure" as const,
      expected: "failure",
    },
    {
      name: "a typed retryable stop drives the infra-retry outcome",
      stopOutcome: "retryable_infrastructure_failure" as const,
      expected: "retryable_infrastructure_failure",
    },
    {
      name: "a pre-migration stop without a typed outcome takes the conservative non-retryable path",
      stopOutcome: null,
      expected: "needs_human",
    },
  ])("drains a stopped graph where $name", async ({ stopOutcome, expected }) => {
    const subject = "1".repeat(40);
    // The sanitized agent receipt text carries the literal token; only the
    // typed stop_outcome may select the aggregate outcome.
    const poisonedStopReason =
      "failure: the agent wrote retryable_infrastructure_failure in its receipt";
    const deadAttempt = action({
      id: "dead-untyped-stop",
      action_kind: "final_review",
      cycle: 1,
      status: "dead",
      unit_id: null,
      execution_unit_id: null,
      completed_at: "2099-07-22T12:00:00.000Z",
      last_error: poisonedStopReason,
    });
    const parentAttempt = {
      id: "parent-attempt",
      pipeline_instance_id: "instance-1",
      stage_id: "structured",
      attempt_ordinal: 1,
      reentry_ordinal: 0,
      run_id: "run-1",
      planned_run_id: null,
      expected_subject: subject,
      native_session_id: null,
      request_payload: parentAttemptRequestPayload(),
      request_hash: "3".repeat(64),
      idempotency_key: "parent-idempotency-key",
      context_revision: 1,
      native_context_policy: "fresh",
      status: "running",
      outcome: null,
      result_hash: null,
      started_at: "2099-07-22T11:59:00.000Z",
      completed_at: null,
      created_at: "2099-07-22T11:59:00.000Z",
      updated_at: "2099-07-22T11:59:00.000Z",
    };
    const instance = {
      id: "instance-1",
      ticket_id: "ticket-1",
      session_id: "session-1",
      generation: 7,
      repository: "knoxgraeme/openthrottle",
      base_commit: "a".repeat(40),
      immutable_subject: subject,
      runtime_release: "test-runtime",
      manifest_digest: "c".repeat(64),
      capability_digest: "d".repeat(64),
      normalized_manifest: canonicalJson({
        stages: [{
          id: "structured",
          executor: { capability: "graph/for-each-unit@1" },
          evaluator: { assurance: "semantic_attested" },
        }],
      }),
    };
    const completeParentStage = vi.fn(() => instance as any);
    const emitAggregateOnce = vi.fn(() => "emitted" as const);
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {} as SandboxRuntime,
      completeParentStage,
      store: {
        leaseNextUnitAction: () => undefined,
        getGraphForAttempt: () => ({
          stopped_at: "2099-07-22T12:00:00.000Z",
          stop_reason: poisonedStopReason,
          stop_outcome: stopOutcome,
          integration_subject: subject,
          final_phase: "repair",
          aggregate_emitted_at: null,
          aggregate_artifact_hash: null,
        }),
        getAttempt: () => parentAttempt,
        listUnits: () => [unit({ unitId: "unit_a", ordinal: 0, integrationSubject: subject })],
        listWorkAttempts: () => [deadAttempt],
        listGateReceipts: () => [],
        emitAggregateOnce,
      } as any,
    });

    await childRuntime.drainCompositeChildren(
      { providerResourceId: "sandbox-1" },
      instance as any,
      "parent-attempt"
    );

    expect(completeParentStage).toHaveBeenCalledWith(expect.objectContaining({
      kind: "stage_result",
      outcome: expected,
      subject,
    }));
  });

  it("settles a chain of collectable child actions in one drainCompositeChildren call", async () => {
    const first = action({
      id: "implement-chain-1",
      action_kind: "implement",
      cycle: 1,
      status: "dispatched",
      attempt_ordinal: 1,
      request_hash: "b".repeat(64),
    });
    const second = action({
      id: "implement-chain-2",
      action_kind: "implement",
      cycle: 1,
      status: "dispatched",
      attempt_ordinal: 2,
      request_hash: "b".repeat(64),
    });
    const ready = [first, second];
    const failUnitAction = vi.fn((input: { actionId: string }) => {
      if (ready[0]?.id === input.actionId) ready.shift();
    });
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        collectLoopActionResult: async (_resource: unknown, collection: { actionId: string; requestHash: string }) => ({
          actionId: collection.actionId,
          attemptId: "parent-attempt",
          requestHash: collection.requestHash,
          outcome: "failure",
          nativeSessionId: null,
          subject: null,
          receipt: `loop action failed (reason=${collection.actionId})`,
          completedAt: "2099-07-22T12:00:00.000Z",
        }),
      } as any,
      store: {
        leaseNextUnitAction: () => ready[0],
        failUnitAction,
        getGraphForAttempt: () => undefined,
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

    // One drain call walks the whole ready chain instead of settling a single
    // action per 30s scheduler tick.
    expect(failUnitAction).toHaveBeenCalledTimes(2);
    expect(failUnitAction).toHaveBeenCalledWith(expect.objectContaining({ actionId: first.id }));
    expect(failUnitAction).toHaveBeenCalledWith(expect.objectContaining({ actionId: second.id }));
  });

  it("honors the maxChildDrainsPerTick seam so harnesses can pause at one action per drain", async () => {
    const first = action({
      id: "implement-capped-1",
      action_kind: "implement",
      cycle: 1,
      status: "dispatched",
      attempt_ordinal: 1,
      request_hash: "b".repeat(64),
    });
    const second = action({
      id: "implement-capped-2",
      action_kind: "implement",
      cycle: 1,
      status: "dispatched",
      attempt_ordinal: 2,
      request_hash: "b".repeat(64),
    });
    const ready = [first, second];
    const failUnitAction = vi.fn((input: { actionId: string }) => {
      if (ready[0]?.id === input.actionId) ready.shift();
    });
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      maxChildDrainsPerTick: 1,
      runtime: {
        collectLoopActionResult: async (_resource: unknown, collection: { actionId: string; requestHash: string }) => ({
          actionId: collection.actionId,
          attemptId: "parent-attempt",
          requestHash: collection.requestHash,
          outcome: "failure",
          nativeSessionId: null,
          subject: null,
          receipt: `loop action failed (reason=${collection.actionId})`,
          completedAt: "2099-07-22T12:00:00.000Z",
        }),
      } as any,
      store: {
        leaseNextUnitAction: () => ready[0],
        failUnitAction,
        getGraphForAttempt: () => undefined,
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

    expect(failUnitAction).toHaveBeenCalledTimes(1);
    expect(failUnitAction).toHaveBeenCalledWith(expect.objectContaining({ actionId: first.id }));
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

    childRuntime.seedCompositeGraph(instance as any, request(executionPlan) as any, "a".repeat(40));

    expect(createGraph).toHaveBeenCalledWith(expect.objectContaining({
      initialSubject: "a".repeat(40),
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

    childRuntime.seedCompositeGraph(manifestInstance as any, request(executionPlan) as any, "a".repeat(40));

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

    expect(() => childRuntime.seedCompositeGraph(instance as any, request(executionPlan) as any, "a".repeat(40)))
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
        protocol: "loop-action@3",
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
        expectedReceiptType: "unit_decision",
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
    const recoveryPayload = Buffer.from("compressed recovery bytes");
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
          recoveryPayload,
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
      privateArtifact: {
        schema: "openthrottle.execution-work-private-artifact/v1",
        manifest: recoveryArtifact,
        payload: recoveryPayload,
        payloadSha256: createHash("sha256").update(recoveryPayload).digest("hex"),
        payloadBytes: recoveryPayload.byteLength,
      },
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
        getRepositoryConfigSnapshot: () => ({
          digest: "f".repeat(64),
          normalized_config: canonicalJson({
            agent: "codex",
            agent_defaults: {
              codex: { model: "gpt-5.6-sol", reasoning_effort: "high" },
            },
          }),
        }),
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
      repository_config_snapshot_id: "config-1",
      repository_config_digest: "f".repeat(64),
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
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      generation: 7,
      baseSubject: "a".repeat(40),
      recoveryBaseSubject: "a".repeat(40),
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
      protocol: "loop-action@3",
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
      expectedReceiptType: "unit_completion",
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
    const failUnitAction = vi.fn();
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
        failUnitAction,
        listWorkAttempts: () => attempts(finalReview, finalRepair),
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

    // A deterministic dispatch fence violation terminal-fails the action
    // through the bounded path instead of rethrowing into the drain cycle.
    expect(failUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: finalRepair.id,
      outcome: "failure",
      lastError: expect.stringMatching(error),
    }));
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

  it("collects a completed Codex worker's result without carrying any auth material", async () => {
    const implement = action({
      id: "implement-codex-worker",
      action_kind: "implement",
      cycle: 1,
      status: "dispatched",
      attempt_ordinal: 1,
      request_hash: "b".repeat(64),
    });
    const completeUnitAction = vi.fn();
    const failUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: {
        // The action ran as a Codex worker override under a Claude-selected
        // ticket. Under the token broker its sandbox holds an access-token-only
        // copy of what the supervisor seeded, so there is nothing to read back
        // and the sealed result carries no auth field at all.
        collectLoopActionResult: async () => ({
          actionId: implement.id,
          attemptId: "parent-attempt",
          requestHash: "b".repeat(64),
          outcome: "success",
          nativeSessionId: null,
          subject: "a".repeat(40),
          receipt: completionReceipt("a".repeat(40), implement),
          completedAt: "2099-07-22T12:00:00.000Z",
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
    expect(completeUnitAction).toHaveBeenCalled();
    // Nothing the supervisor persists for this action carries auth material.
    expect(JSON.stringify(completeUnitAction.mock.calls)).not.toMatch(/auth|refresh_token/i);
  });

  it("gives a repair action the triggering lead decision and failing command evidence", async () => {
    const rejectedCandidateSubject = "2".repeat(40);
    const candidate = completedCandidateAction({
      id: "candidate-cycle-1",
      subject: rejectedCandidateSubject,
      preSubject: rejectedCandidateSubject,
    });
    const lead = action({
      id: "lead-cycle-1",
      action_kind: "lead",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 3,
      request_hash: "f".repeat(64),
      output_subject: rejectedCandidateSubject,
    });
    lead.receipt = unitDecisionReceipt("unit_a", lead, "Fix the off-by-one in the paginator.", rejectedCandidateSubject);
    lead.receipt_hash = digestNormalized(lead.receipt);
    const command = action({
      id: "command-cycle-1",
      action_kind: "command",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 1,
      command_name: "test",
      request_hash: "e".repeat(64),
      output_subject: rejectedCandidateSubject,
    });
    command.receipt = commandReceipt(rejectedCandidateSubject, command, "unit tests failed: off-by-one");
    command.receipt_hash = digestNormalized(command.receipt);
    const repair = action({
      id: "repair-cycle-2",
      action_kind: "repair",
      cycle: 2,
      status: "leased",
      attempt_ordinal: 4,
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
        leaseNextUnitAction: () => repair,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        markActionWorktreeReady: vi.fn(),
        listWorkAttempts: () => [command, candidate, lead, repair],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload() }),
      } as any,
    });

    await childRuntime.drainCompositeChildren(
      { providerResourceId: "sandbox-1" },
      repairStructuredInstance(),
      "parent-attempt"
    );

    expect(createWorktree).toHaveBeenCalledWith({ providerResourceId: "sandbox-1" }, expect.objectContaining({
      attemptId: "parent-attempt",
      baseCommit: rejectedCandidateSubject,
    }));
    expect(dispatched).toMatchObject({
      actionId: "repair-cycle-2",
      skill: "repair-unit",
      loop: "repair",
      baseSubject: rejectedCandidateSubject,
      inputSubject: rejectedCandidateSubject,
      recoveryBaseSubject: "a".repeat(40),
      priorEvidence: {
        schema: "openthrottle.loop-prior-evidence/v1",
        role: "repair",
      },
    });
    expect(dispatched?.worktree).not.toBeNull();
    expect(dispatched?.priorEvidence?.receipts.map((receipt) => receipt.role)).toEqual(["candidate", "lead", "command"]);
    expect(dispatched?.priorEvidence?.receipts[0]?.actionAttemptId).toBe("candidate-cycle-1");
    expect(dispatched?.priorEvidence?.receipts[1]?.receipt).toContain("Fix the off-by-one in the paginator.");
    expect(dispatched?.priorEvidence?.receipts[2]?.receipt).toContain("unit tests failed: off-by-one");
  });

  it("reuses the rejected candidate worktree base across a repair cycle and rejects stale replay", async () => {
    const rejectedCandidateSubject = "2".repeat(40);
    const repairOutputSubject = "3".repeat(40);
    const simplifyOutputSubject = "4".repeat(40);
    const commandOutputSubject = "5".repeat(40);
    const candidateOutputSubject = "6".repeat(40);
    const staleBaseSubject = "a".repeat(40);
    const previousCandidate = completedCandidateAction({
      id: "candidate-cycle-1-worktree",
      subject: rejectedCandidateSubject,
    });
    const triggeringLead = action({
      id: "lead-cycle-1-worktree",
      action_kind: "lead",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 3,
      request_hash: "f".repeat(64),
      output_subject: rejectedCandidateSubject,
    });
    triggeringLead.receipt = unitDecisionReceipt("unit_a", triggeringLead, "Fix the failed repair-cycle command.", rejectedCandidateSubject);
    triggeringLead.receipt_hash = digestNormalized(triggeringLead.receipt);
    const repair = action({
      id: "repair-cycle-2-worktree",
      action_kind: "repair",
      cycle: 2,
      status: "leased",
      attempt_ordinal: 4,
    });
    const simplify = action({
      id: "simplify-cycle-2-worktree",
      action_kind: "simplify",
      cycle: 2,
      status: "leased",
      attempt_ordinal: 5,
    });
    const command = action({
      id: "command-cycle-2-worktree",
      action_kind: "command",
      cycle: 2,
      status: "leased",
      attempt_ordinal: 6,
      command_name: "test",
    });
    const candidate = action({
      id: "candidate-cycle-2-worktree",
      action_kind: "candidate",
      cycle: 2,
      status: "leased",
      attempt_ordinal: 7,
    });
    const lead = action({
      id: "lead-cycle-2-worktree",
      action_kind: "lead",
      cycle: 2,
      status: "leased",
      attempt_ordinal: 8,
    });
    const attempts = [previousCandidate, triggeringLead, repair, simplify, command, candidate, lead];
    let leased: ExecutionWorkAttempt | null = null;
    const createWorktree = vi.fn(async () => ({ id: "worktree-handle" }));
    const loopRequests = new Map<string, LoopActionRequest>();
    const childRequests = new Map<string, ChildExecutorActionRequest>();
    const dispatchLoopAction = vi.fn(async (_resource: { providerResourceId: string }, request: LoopActionRequest) => {
      loopRequests.set(request.actionId, request);
      return { providerDispatchId: `loop-${request.actionId}` };
    });
    const dispatchChildExecutorAction = vi.fn(async (
      _resource: { providerResourceId: string },
      request: ChildExecutorActionRequest
    ) => {
      childRequests.set(request.actionId, request);
      return { providerDispatchId: `child-${request.actionId}` };
    });
    const failUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: { createWorktree, dispatchLoopAction, dispatchChildExecutorAction } as any,
      store: {
        leaseNextUnitAction: () => leased,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        markActionWorktreeReady: vi.fn(),
        failUnitAction,
        listUnits: () => [unit({
          unitId: "unit_a",
          ordinal: 0,
          status: "running",
          phase: "lead",
          currentCycle: 2,
          integrationSubject: null,
          terminalLevel: null,
        })],
        listWorkAttempts: () => attempts,
        getGraphForAttempt: () => ({
          integration_subject: staleBaseSubject,
          command_names: JSON.stringify(["test"]),
        }),
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload() }),
      } as any,
    });
    const drain = async (actionToLease: ExecutionWorkAttempt) => {
      leased = actionToLease;
      await childRuntime.drainCompositeChildren(
        { providerResourceId: "sandbox-1" },
        repairCycleStructuredInstance(),
        "parent-attempt"
      );
      leased = null;
    };

    await drain(repair);
    const repairRequest = loopRequests.get(repair.id)!;
    repair.status = "completed";
    repair.output_subject = repairOutputSubject;
    repair.request_hash = repairRequest.requestHash;
    repair.receipt = completionReceipt(repairOutputSubject, repair, rejectedCandidateSubject, rejectedCandidateSubject);
    repair.receipt_hash = digestNormalized(repair.receipt);
    const repairHandle = repairRequest.worktree?.id;
    expect(repairRequest).toMatchObject({
      baseSubject: rejectedCandidateSubject,
      inputSubject: rejectedCandidateSubject,
      recoveryBaseSubject: staleBaseSubject,
    });
    expect(createWorktree).toHaveBeenCalledWith({ providerResourceId: "sandbox-1" }, expect.objectContaining({
      baseCommit: rejectedCandidateSubject,
    }));

    await drain(simplify);
    const simplifyRequest = loopRequests.get(simplify.id)!;
    simplify.status = "completed";
    simplify.output_subject = simplifyOutputSubject;
    simplify.request_hash = simplifyRequest.requestHash;
    simplify.receipt = completionReceipt(simplifyOutputSubject, simplify, repairOutputSubject, rejectedCandidateSubject);
    simplify.receipt_hash = digestNormalized(simplify.receipt);
    expect(simplifyRequest).toMatchObject({
      baseSubject: rejectedCandidateSubject,
      inputSubject: repairOutputSubject,
      worktree: { id: repairHandle },
    });

    await drain(command);
    const commandRequest = childRequests.get(command.id)!;
    command.status = "completed";
    command.output_subject = commandOutputSubject;
    command.request_hash = commandRequest.requestHash;
    expect(commandRequest).toMatchObject({
      baseSubject: rejectedCandidateSubject,
      inputSubject: simplifyOutputSubject,
      worktree: { id: repairHandle },
    });

    await drain(candidate);
    const candidateRequest = childRequests.get(candidate.id)!;
    candidate.status = "completed";
    candidate.output_subject = candidateOutputSubject;
    candidate.request_hash = candidateRequest.requestHash;
    candidate.receipt = candidateReceipt(candidateOutputSubject, candidate, commandOutputSubject, rejectedCandidateSubject);
    candidate.receipt_hash = digestNormalized(candidate.receipt);
    expect(candidateRequest).toMatchObject({
      baseSubject: rejectedCandidateSubject,
      inputSubject: commandOutputSubject,
      worktree: { id: repairHandle },
    });

    await drain(lead);
    const leadRequest = loopRequests.get(lead.id)!;
    expect(leadRequest).toMatchObject({
      baseSubject: rejectedCandidateSubject,
      inputSubject: candidateOutputSubject,
      candidateSubject: candidateOutputSubject,
      worktree: null,
    });

    const staleReplay = action({
      id: "command-cycle-2-stale-replay-worktree",
      action_kind: "command",
      cycle: 2,
      status: "dispatched",
      attempt_ordinal: 9,
      command_name: "test",
      request_hash: "3".repeat(64),
      request_launch_state: "prepared",
      request_payload: canonicalJson({
        ...commandRequest,
        actionId: "command-cycle-2-stale-replay-worktree",
        baseSubject: staleBaseSubject,
        inputSubject: staleBaseSubject,
        worktree: { id: "stale-worktree-handle" },
        requestHash: "3".repeat(64),
      } satisfies ChildExecutorActionRequest),
    });
    attempts.push(staleReplay);
    leased = staleReplay;
    dispatchChildExecutorAction.mockClear();
    await childRuntime.drainCompositeChildren(
      { providerResourceId: "sandbox-1" },
      repairCycleStructuredInstance(),
      "parent-attempt"
    );
    expect(failUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: staleReplay.id,
      outcome: "failure",
      lastError: expect.stringMatching(/prepared request is not bound to the current unit worktree/),
    }));
    expect(dispatchChildExecutorAction).not.toHaveBeenCalled();
  });

  it("replays prepared repair dispatch with the rejected candidate worktree base", async () => {
    const rejectedCandidateSubject = "2".repeat(40);
    const candidate = completedCandidateAction({
      id: "candidate-cycle-1-replay",
      subject: rejectedCandidateSubject,
    });
    const repair = action({
      id: "repair-cycle-2-replay",
      action_kind: "repair",
      cycle: 2,
      status: "dispatched",
      attempt_ordinal: 4,
      request_hash: "3".repeat(64),
      request_launch_state: "prepared",
    });
    repair.request_payload = canonicalJson({
        protocol: "loop-action@3",
        actionId: "repair-cycle-2-replay",
        attemptId: "parent-attempt",
        graphId: "graph-1",
        unitId: "unit_a",
        role: "worker",
        loop: "repair",
        agent: "codex",
        skill: "repair-unit",
        worktree: { id: worktreeHandleId(repair, rejectedCandidateSubject) },
        baseSubject: rejectedCandidateSubject,
        recoveryBaseSubject: "a".repeat(40),
        inputSubject: rejectedCandidateSubject,
        nativeSessionId: "native-repair-1",
        contextPolicy: "resume_required",
        timeoutMs: 60_000,
        transitionContext: "",
        allowedMcpServers: [],
        credentialScopes: ["model.invoke", "provider.read", "repo.read"],
        receiptSchema: "openthrottle.receipt/v1",
        expectedReceiptType: "unit_completion",
        expectedProducerSkill: "repair-unit",
        expectedProducer: {
          workerId: "unit-worker",
          skill: "repair-unit",
          capabilityDigest: "d".repeat(64),
          skillPackageDigest: null,
          assurance: "semantic_attested",
        },
        requestHash: "3".repeat(64),
        idempotencyKey: "loop:parent-attempt:repair-cycle-2-replay:prepared",
    } satisfies LoopActionRequest);
    const createWorktree = vi.fn(async () => ({ id: "worktree-handle" }));
    const dispatchLoopAction = vi.fn(async () => ({ providerDispatchId: "dispatch-1" }));
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: { createWorktree, dispatchLoopAction } as any,
      store: {
        leaseNextUnitAction: () => repair,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        markActionWorktreeReady: vi.fn(),
        listWorkAttempts: () => [candidate, repair],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
      } as any,
    });

    await childRuntime.drainCompositeChildren(
      { providerResourceId: "sandbox-1" },
      structuredInstance(),
      "parent-attempt"
    );

    expect(createWorktree).toHaveBeenCalledWith({ providerResourceId: "sandbox-1" }, expect.objectContaining({
      baseCommit: rejectedCandidateSubject,
    }));
    expect(dispatchLoopAction).toHaveBeenCalledWith({ providerResourceId: "sandbox-1" }, expect.objectContaining({
      requestHash: "3".repeat(64),
      baseSubject: rejectedCandidateSubject,
      inputSubject: rejectedCandidateSubject,
      recoveryBaseSubject: "a".repeat(40),
    }));
  });

  it("fails closed before replaying a prepared repair request with stale subjects", async () => {
    const rejectedCandidateSubject = "2".repeat(40);
    const staleBaseSubject = "a".repeat(40);
    const candidate = completedCandidateAction({
      id: "candidate-cycle-1-stale-replay",
      subject: rejectedCandidateSubject,
    });
    const repair = action({
      id: "repair-cycle-2-stale-replay",
      action_kind: "repair",
      cycle: 2,
      status: "dispatched",
      attempt_ordinal: 4,
      request_hash: "3".repeat(64),
      request_launch_state: "prepared",
      request_payload: canonicalJson({
        protocol: "loop-action@3",
        actionId: "repair-cycle-2-stale-replay",
        attemptId: "parent-attempt",
        graphId: "graph-1",
        unitId: "unit_a",
        role: "worker",
        loop: "repair",
        agent: "codex",
        skill: "repair-unit",
        worktree: { id: "worktree-stale" },
        baseSubject: staleBaseSubject,
        recoveryBaseSubject: staleBaseSubject,
        inputSubject: staleBaseSubject,
        nativeSessionId: "native-repair-1",
        contextPolicy: "resume_required",
        timeoutMs: 60_000,
        transitionContext: "",
        allowedMcpServers: [],
        credentialScopes: ["model.invoke", "provider.read", "repo.read"],
        receiptSchema: "openthrottle.receipt/v1",
        expectedReceiptType: "unit_completion",
        expectedProducerSkill: "repair-unit",
        expectedProducer: {
          workerId: "unit-worker",
          skill: "repair-unit",
          capabilityDigest: "d".repeat(64),
          skillPackageDigest: null,
          assurance: "semantic_attested",
        },
        requestHash: "3".repeat(64),
        idempotencyKey: "loop:parent-attempt:repair-cycle-2-stale-replay:prepared",
      } satisfies LoopActionRequest),
    });
    const createWorktree = vi.fn(async () => ({ id: "worktree-handle" }));
    const dispatchLoopAction = vi.fn();
    const failUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: { createWorktree, dispatchLoopAction } as any,
      store: {
        leaseNextUnitAction: () => repair,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        markActionWorktreeReady: vi.fn(),
        failUnitAction,
        listWorkAttempts: () => [candidate, repair],
        getGraphForAttempt: () => ({
          integration_subject: staleBaseSubject,
          command_names: "[]",
        }),
      } as any,
    });

    await childRuntime.drainCompositeChildren(
      { providerResourceId: "sandbox-1" },
      structuredInstance({
        base_commit: staleBaseSubject,
        immutable_subject: staleBaseSubject,
      }),
      "parent-attempt"
    );
    expect(failUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: repair.id,
      outcome: "failure",
      lastError: expect.stringMatching(/prepared request is not bound to the current unit worktree/),
    }));
    expect(createWorktree).not.toHaveBeenCalled();
    expect(dispatchLoopAction).not.toHaveBeenCalled();
  });

  it("fails closed before repair worktree creation without unique rejected candidate evidence", async () => {
    const lead = action({
      id: "lead-cycle-1-no-candidate",
      action_kind: "lead",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 3,
      request_hash: "f".repeat(64),
      output_subject: "a".repeat(40),
    });
    lead.receipt = unitDecisionReceipt("unit_a", lead, "Fix the off-by-one in the paginator.");
    lead.receipt_hash = digestNormalized(lead.receipt);
    const repair = action({
      id: "repair-cycle-2-no-candidate",
      action_kind: "repair",
      cycle: 2,
      status: "leased",
      attempt_ordinal: 4,
    });
    const createWorktree = vi.fn(async () => ({ id: "worktree-handle" }));
    const dispatchLoopAction = vi.fn();
    const failUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: { createWorktree, dispatchLoopAction } as any,
      store: {
        leaseNextUnitAction: () => repair,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        markActionWorktreeReady: vi.fn(),
        failUnitAction,
        listWorkAttempts: () => [lead, repair],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload() }),
      } as any,
    });

    await childRuntime.drainCompositeChildren(
      { providerResourceId: "sandbox-1" },
      repairStructuredInstance(),
      "parent-attempt"
    );
    expect(failUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: repair.id,
      outcome: "failure",
      lastError: expect.stringMatching(/requires exactly one rejected candidate evidence/),
    }));
    expect(createWorktree).not.toHaveBeenCalled();
    expect(dispatchLoopAction).not.toHaveBeenCalled();
  });

  it("fails closed before repair worktree creation with ambiguous rejected candidate evidence", async () => {
    const rejectedCandidateSubject = "2".repeat(40);
    const firstCandidate = completedCandidateAction({
      id: "candidate-cycle-1-ambiguous-a",
      subject: rejectedCandidateSubject,
    });
    const secondCandidate = completedCandidateAction({
      id: "candidate-cycle-1-ambiguous-b",
      subject: rejectedCandidateSubject,
      attemptOrdinal: 3,
    });
    const lead = action({
      id: "lead-cycle-1-ambiguous-candidate",
      action_kind: "lead",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 4,
      request_hash: "f".repeat(64),
      output_subject: rejectedCandidateSubject,
    });
    lead.receipt = unitDecisionReceipt("unit_a", lead, "Fix the off-by-one in the paginator.", rejectedCandidateSubject);
    lead.receipt_hash = digestNormalized(lead.receipt);
    const repair = action({
      id: "repair-cycle-2-ambiguous-candidate",
      action_kind: "repair",
      cycle: 2,
      status: "leased",
      attempt_ordinal: 5,
    });
    const createWorktree = vi.fn(async () => ({ id: "worktree-handle" }));
    const dispatchLoopAction = vi.fn();
    const failUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: { createWorktree, dispatchLoopAction } as any,
      store: {
        leaseNextUnitAction: () => repair,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        markActionWorktreeReady: vi.fn(),
        failUnitAction,
        listWorkAttempts: () => [firstCandidate, secondCandidate, lead, repair],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload() }),
      } as any,
    });

    await childRuntime.drainCompositeChildren(
      { providerResourceId: "sandbox-1" },
      repairStructuredInstance(),
      "parent-attempt"
    );
    expect(failUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: repair.id,
      outcome: "failure",
      lastError: expect.stringMatching(/requires exactly one rejected candidate evidence/),
    }));
    expect(createWorktree).not.toHaveBeenCalled();
    expect(dispatchLoopAction).not.toHaveBeenCalled();
  });

  it("fails closed before repair worktree creation when rejected candidate evidence is stale", async () => {
    const rejectedCandidateSubject = "2".repeat(40);
    const candidate = completedCandidateAction({
      id: "candidate-cycle-1-stale",
      subject: rejectedCandidateSubject,
      outputSubject: "3".repeat(40),
    });
    const lead = action({
      id: "lead-cycle-1-stale-candidate",
      action_kind: "lead",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 3,
      request_hash: "f".repeat(64),
      output_subject: rejectedCandidateSubject,
    });
    lead.receipt = unitDecisionReceipt("unit_a", lead, "Fix the off-by-one in the paginator.", rejectedCandidateSubject);
    lead.receipt_hash = digestNormalized(lead.receipt);
    const repair = action({
      id: "repair-cycle-2-stale-candidate",
      action_kind: "repair",
      cycle: 2,
      status: "leased",
      attempt_ordinal: 4,
    });
    const createWorktree = vi.fn(async () => ({ id: "worktree-handle" }));
    const dispatchLoopAction = vi.fn();
    const failUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: { createWorktree, dispatchLoopAction } as any,
      store: {
        leaseNextUnitAction: () => repair,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        markActionWorktreeReady: vi.fn(),
        failUnitAction,
        listWorkAttempts: () => [candidate, lead, repair],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload() }),
      } as any,
    });

    await childRuntime.drainCompositeChildren(
      { providerResourceId: "sandbox-1" },
      repairStructuredInstance(),
      "parent-attempt"
    );
    expect(failUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: repair.id,
      outcome: "failure",
      lastError: expect.stringMatching(/rejected candidate subject disagrees/),
    }));
    expect(createWorktree).not.toHaveBeenCalled();
    expect(dispatchLoopAction).not.toHaveBeenCalled();
  });

  it("fails closed before repair dispatch when the triggering lead receipt's request-hash fence does not match", async () => {
    const rejectedCandidateSubject = "2".repeat(40);
    const candidate = completedCandidateAction({
      id: "candidate-cycle-1-invalid-lead",
      subject: rejectedCandidateSubject,
    });
    const lead = action({
      id: "lead-cycle-1-invalid",
      action_kind: "lead",
      cycle: 1,
      status: "completed",
      attempt_ordinal: 3,
      request_hash: "f".repeat(64),
      output_subject: rejectedCandidateSubject,
    });
    lead.receipt = unitDecisionReceipt("unit_a", lead, "Fix the off-by-one in the paginator.", rejectedCandidateSubject);
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
    const failUnitAction = vi.fn();
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
        failUnitAction,
        listWorkAttempts: () => [candidate, lead, repair],
        getGraphForAttempt: () => ({
          integration_subject: "a".repeat(40),
          command_names: "[]",
        }),
        getAttempt: () => ({ request_payload: parentAttemptRequestPayload() }),
      } as any,
    });

    await childRuntime.drainCompositeChildren(
      { providerResourceId: "sandbox-1" },
      repairStructuredInstance(),
      "parent-attempt"
    );
    expect(failUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: repair.id,
      outcome: "failure",
      lastError: expect.stringMatching(/triggering lead fence is invalid/),
    }));
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
        protocol: "loop-action@3",
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
    const failUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: { dispatchLoopAction } as any,
      store: {
        leaseNextUnitAction: () => lead,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        failUnitAction,
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
            loop: { skill: "builtin://accept-unit@1", timeout_seconds: 60 },
            worker: { id: "lead-worker", agent: "inherit", allowed_mcp_servers: [] },
            credentials: ["model.invoke", "repo.read"],
            context: "fresh",
          }],
        }],
      }),
    } as any, "parent-attempt");
    expect(failUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: lead.id,
      outcome: "failure",
      lastError: expect.stringMatching(/prior evidence exceeds aggregate bound/),
    }));
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
    const failUnitAction = vi.fn();
    const childRuntime = createStructuredChildRuntime({
      now: () => new Date("2099-07-22T12:00:00.000Z"),
      taskTimeoutSeconds: 300,
      runtime: { dispatchLoopAction } as any,
      store: {
        leaseNextUnitAction: () => lead,
        markActionDispatching: vi.fn(),
        markActionDispatched: vi.fn(),
        failUnitAction,
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
            loop: { skill: "builtin://accept-unit@1", timeout_seconds: 60 },
            worker: { id: "lead-worker", agent: "inherit", allowed_mcp_servers: [] },
            credentials: ["model.invoke", "repo.read"],
            context: "fresh",
          }],
        }],
      }),
    } as any, "parent-attempt");
    expect(failUnitAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: lead.id,
      outcome: "failure",
      lastError: expect.stringMatching(/prior evidence has too many receipts/),
    }));
    expect(dispatchLoopAction).not.toHaveBeenCalled();
  });
});
