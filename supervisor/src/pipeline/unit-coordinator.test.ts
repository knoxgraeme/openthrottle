import { describe, expect, it } from "vitest";
import { canonicalJson, digestNormalized, type PipelineManifest } from "./manifest.js";
import {
  buildAggregateStageEvent,
  decideChildGate,
  decideDownstreamContext,
  selectNextReadyUnit,
  unitBudgetDecision,
  type ChildGateEvidence,
  type ExecutionUnitState,
} from "./unit-coordinator.js";
import type { PipelineInstance, PipelineStageAttempt } from "./store.js";

function unit(overrides: Partial<ExecutionUnitState> & { unitId: string; ordinal: number }): ExecutionUnitState {
  return {
    id: `unit-${overrides.unitId}`,
    dependencies: [],
    status: "pending",
    activeActionId: null,
    integrationSubject: null,
    ...overrides,
  };
}

describe("unit coordinator", () => {
  it("selects one deterministic ready unit in authored dependency order", () => {
    const units = [
      unit({ unitId: "c", ordinal: 2, dependencies: ["a"] }),
      unit({ unitId: "b", ordinal: 1 }),
      unit({ unitId: "a", ordinal: 0, status: "integrated", integrationSubject: "111" }),
    ];

    expect(selectNextReadyUnit(units)?.unitId).toBe("b");
    expect(selectNextReadyUnit([units[0]!, { ...units[1]!, activeActionId: "action-b" }, units[2]!])).toBeUndefined();
    expect(selectNextReadyUnit([units[0]!, { ...units[1]!, status: "running" }, units[2]!])).toBeUndefined();
  });

  it("uses parent repair, transition, and whole-run attempt caps", () => {
    expect(unitBudgetDecision({
      manifestMaxRepairRounds: 5,
      instanceReentryCount: 5,
      targetStageReentryCount: 0,
      manifestMaxAttempts: 200,
      instanceAttemptCount: 1,
    })).toMatchObject({ allowed: false, exhausted: "repair_rounds" });
    expect(unitBudgetDecision({
      instanceReentryCount: 0,
      transitionMaxReentries: 2,
      transitionOnExhausted: "failed",
      targetStageReentryCount: 2,
      manifestMaxAttempts: 200,
      instanceAttemptCount: 1,
    })).toMatchObject({ allowed: false, exhausted: "reentries", terminal: "failed" });
    expect(unitBudgetDecision({
      instanceReentryCount: 0,
      targetStageReentryCount: 0,
      manifestMaxAttempts: 2,
      instanceAttemptCount: 2,
    })).toMatchObject({ allowed: false, exhausted: "attempts" });
  });

  it("deterministically validates child semantic receipts against producer, subject, and freshness fences", () => {
    const evidence = childGateEvidence({
      result: "no_change",
      repository: {
        subject: "2".repeat(40),
        pre_subject: "1".repeat(40),
        post_subject: "2".repeat(40),
      },
    });

    expect(decideChildGate({
      gateKind: "unit_acceptance",
      evaluatorKind: "semantic",
      expected: childGateFence({ inputSubject: "1".repeat(40), currentSubject: "2".repeat(40) }),
      evidence,
    })).toMatchObject({
      outcome: "success",
      result: "passed",
      reason: "no_change_contradicted_by_tree_delta",
    });

    expect(() => decideChildGate({
      gateKind: "unit_acceptance",
      evaluatorKind: "semantic",
      expected: childGateFence({ producerCapability: "graph/for-each-unit@1" }),
      evidence,
    })).toThrow(/producer fence mismatch/);
    expect(() => decideChildGate({
      gateKind: "unit_acceptance",
      evaluatorKind: "semantic",
      expected: childGateFence({ inputSubject: "3".repeat(40), currentSubject: "2".repeat(40) }),
      evidence,
    })).toThrow(/subject fence mismatch/);
    expect(() => decideChildGate({
      gateKind: "unit_acceptance",
      evaluatorKind: "semantic",
      expected: childGateFence({ currentSubject: "3".repeat(40) }),
      evidence,
    })).toThrow(/subject fence mismatch/);
    expect(() => decideChildGate({
      gateKind: "unit_acceptance",
      evaluatorKind: "semantic",
      expected: childGateFence({ requestHash: "0".repeat(64) }),
      evidence,
    })).toThrow(/freshness fence mismatch/);
    expect(() => decideChildGate({
      gateKind: "unit_acceptance",
      evaluatorKind: "semantic",
      expected: childGateFence({ currentSubject: "2".repeat(40) }),
      evidence: childGateEvidence({ findings: [{ severity: "P4" }] }),
    })).toThrow(/findings are invalid/);
    expect(() => decideChildGate({
      gateKind: "unit_acceptance",
      evaluatorKind: "semantic",
      expected: childGateFence({ currentSubject: "2".repeat(40) }),
      evidence: childGateEvidence({ artifact_hashes: ["not-a-sha"] }),
    })).toThrow(/artifact hashes are invalid/);
    expect(() => decideChildGate({
      gateKind: "unit_acceptance",
      evaluatorKind: "human",
      expected: childGateFence({ inputSubject: "1".repeat(40), currentSubject: "2".repeat(40) }),
      evidence,
    })).toThrow(/evaluator human is not supported/);
  });

  it("maps child command receipts through the command gate contract", () => {
    expect(decideChildGate({
      gateKind: "unit_command",
      evaluatorKind: "command",
      expected: childGateFence({}),
      evidence: childGateEvidence({
        result: "success",
        command: { not_configured: true, timed_out: false, exit_code: null, signal: null },
      }),
    })).toMatchObject({
      outcome: "no_change",
      result: "not_configured",
      reason: "command_not_configured",
    });
    expect(decideChildGate({
      gateKind: "unit_command",
      evaluatorKind: "command",
      expected: childGateFence({}),
      evidence: childGateEvidence({
        result: "failure",
        command: { not_configured: false, timed_out: false, exit_code: 1, signal: null },
      }),
    })).toMatchObject({
      outcome: "failure",
      result: "failed",
      reason: "command_exit_nonzero",
    });
  });

  it("accepts immutable downstream context only for existing pending units", () => {
    const units = [
      unit({ unitId: "done", ordinal: 0, status: "integrated" }),
      unit({ unitId: "next", ordinal: 1 }),
      unit({ unitId: "later", ordinal: 2, dependencies: ["next"] }),
    ];

    expect(decideDownstreamContext({
      units,
      fromUnitId: "done",
      records: [
        { toUnitId: "next", payload: { note: "carry this exact decision" } },
        { toUnitId: "later", payload: { note: "same graph only" } },
      ],
    })).toMatchObject({
      outcome: "success",
      reason: "accepted_downstream_context",
    });
    expect(decideDownstreamContext({
      units,
      fromUnitId: "done",
      records: [{ toUnitId: "done", payload: { note: "too late" } }],
    })).toMatchObject({
      outcome: "needs_human",
      reason: "downstream_context_target_not_pending",
    });
    expect(decideDownstreamContext({
      units,
      fromUnitId: "done",
      records: [],
      topologyChange: { kind: "split", summary: "split next" },
    })).toMatchObject({
      outcome: "needs_human",
      reason: "topology_change_rejected",
    });
    expect(decideDownstreamContext({
      units,
      fromUnitId: "next",
      records: [{ toUnitId: "later", payload: { note: "not sealed yet" } }],
    })).toMatchObject({
      outcome: "needs_human",
      reason: "downstream_context_source_not_integrated",
    });
  });

  it("builds one aggregate event that can settle the parent through the stage-result path", () => {
    const manifest = {
      schema: "openthrottle.pipeline/v1",
      id: "structured",
      version: 1,
      description: "test",
      entry_stage: "units",
      max_attempts: 10,
      requires: { protocol: "stage-executor@1", capabilities: ["graph/for-each-unit@1"] },
      stages: [{
        id: "units",
        executor: { kind: "agent", capability: "graph/for-each-unit@1" },
        evaluator: { kind: "semantic", assurance: "executor_verified", required_artifacts: ["execution_graph_result"] },
        context: "none",
        live_steering: false,
        credentials: ["repo.read", "repo.write"],
        produces: ["stage_result", "execution_graph_result"],
        transitions: {
          success: { terminal: "shipped" },
          no_change: { terminal: "no_change" },
          semantic_repair_required: { terminal: "needs_human" },
          retryable_infrastructure_failure: { terminal: "failed" },
          needs_human: { terminal: "needs_human" },
          canceled: { terminal: "canceled" },
          superseded: { terminal: "superseded" },
          failure: { terminal: "failed" },
        },
      }],
    } satisfies PipelineManifest;
    const subject = "1".repeat(40);
    const instance = {
      id: "instance-1",
      generation: 1,
      active_stage_id: "units",
      linear_issue_id: "issue-1",
      linear_session_id: "session-1",
      manifest_digest: "2".repeat(64),
      runtime_release: "runtime/v1",
      capability_digest: "3".repeat(64),
      repository: "owner/repo",
      base_commit: "4".repeat(40),
    } as PipelineInstance;
    const parentAttempt = {
      id: "attempt-parent",
      stage_id: "units",
      request_hash: digestNormalized(canonicalJson({ request: true })),
      run_id: "run-parent",
      planned_run_id: "run-parent",
      native_session_id: null,
      context_revision: 0,
      native_context_policy: "none",
      expected_subject: subject,
      started_at: "2026-07-29T00:00:00.000Z",
      created_at: "2026-07-29T00:00:00.000Z",
      updated_at: "2026-07-29T00:00:01.000Z",
    } as PipelineStageAttempt;

    const event = buildAggregateStageEvent({
      id: "aggregate-1",
      manifest,
      instance,
      parentAttempt,
      subject,
      completedAt: "2026-07-29T00:00:02.000Z",
      units: [unit({ unitId: "a", ordinal: 0, status: "integrated", integrationSubject: subject })],
    });

    expect(event).toMatchObject({
      kind: "stage_result",
      attemptId: "attempt-parent",
      requestHash: parentAttempt.request_hash,
      outcome: "success",
      resultHash: event.artifacts![0]!.hash,
    });
    expect(event.artifacts?.map((artifact) => artifact.kind)).toEqual(["stage_result", "execution_graph_result"]);
    const [stageResult, graphResult] = event.artifacts!;
    const stagePayload = JSON.parse(stageResult!.payload) as {
      schema: string;
      evidence: string[];
      details: { execution_graph_result_hash: string };
      repository: { subject: string };
    };
    const graphPayload = JSON.parse(graphResult!.payload) as {
      schema: string;
      details: { units: Array<{ id: string; status: string; integration_subject: string }> };
      repository: { subject: string };
    };
    expect(stagePayload).toMatchObject({
      schema: "openthrottle.artifact/stage_result@1",
      evidence: [graphResult!.hash],
      details: { execution_graph_result_hash: graphResult!.hash },
      repository: { subject },
    });
    expect(graphPayload).toMatchObject({
      schema: "openthrottle.artifact/execution_graph_result@1",
      details: { units: [{ id: "a", status: "integrated", integration_subject: subject }] },
      repository: { subject },
    });
    expect(() => buildAggregateStageEvent({
      id: "aggregate-1",
      manifest,
      instance,
      parentAttempt,
      subject: null,
      units: [unit({ unitId: "a", ordinal: 0, status: "integrated", integrationSubject: subject })],
    })).toThrow(/requires a gated subject/);
    expect(() => buildAggregateStageEvent({
      id: "aggregate-1",
      manifest,
      instance,
      parentAttempt: { ...parentAttempt, run_id: null, planned_run_id: null },
      subject,
      units: [unit({ unitId: "a", ordinal: 0, status: "integrated", integrationSubject: subject })],
    })).toThrow(/requires a parent run binding/);
  });
});

function childGateFence(overrides: Partial<Parameters<typeof decideChildGate>[0]["expected"]>): Parameters<typeof decideChildGate>[0]["expected"] {
  return {
    pipelineInstanceId: "instance-1",
    manifestDigest: "a".repeat(64),
    parentAttemptId: "attempt-parent",
    parentRunId: "run-parent",
    requestHash: "b".repeat(64),
    unitId: "unit-a",
    actionId: "action-a",
    producerCapability: "unit/implement@1",
    runtimeRelease: "runtime/v1",
    capabilityDigest: "c".repeat(64),
    generation: 1,
    inputSubject: "2".repeat(40),
    currentSubject: "2".repeat(40),
    nativeSessionId: "native-1",
    ...overrides,
  };
}

function childGateEvidence(overrides: Partial<ChildGateEvidence>): ChildGateEvidence {
  return {
    schema: "openthrottle.child-gate-evidence/v1",
    producer: {
      capability: "unit/implement@1",
      runtime_release: "runtime/v1",
      capability_digest: "c".repeat(64),
      version: 1,
    },
    pipeline: { instance_id: "instance-1", manifest_digest: "a".repeat(64) },
    parent: { attempt_id: "attempt-parent", run_id: "run-parent", request_hash: "b".repeat(64) },
    unit: { id: "unit-a", action_id: "action-a" },
    run: { generation: 1, native_session_id: "native-1" },
    repository: {
      subject: "2".repeat(40),
      pre_subject: "2".repeat(40),
      post_subject: "2".repeat(40),
    },
    result: "success",
    findings: [],
    artifact_hashes: ["d".repeat(64)],
    completed_at: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}
