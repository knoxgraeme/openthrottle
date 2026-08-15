import { describe, expect, it } from "vitest";
import { canonicalJson, digestNormalized, type PipelineManifest } from "./manifest.js";
import {
  actionKindForUnitPhase,
  BUILTIN_UNIT_PHASES,
  buildAggregateStageEvent,
  decideDownstreamContext,
  deriveUnitTerminalState,
  nextUnitPhase,
  repairCyclePhaseSequence,
  routeFinalReviewDecision,
  routeIntegrationDecision,
  routeUnitAcceptanceDecision,
  selectNextReadyUnit,
  type ExecutionUnitState,
} from "./unit-coordinator.js";
import type { PipelineInstance, PipelineStageAttempt } from "./store.js";

function unit(overrides: Partial<ExecutionUnitState> & { unitId: string; ordinal: number }): ExecutionUnitState {
  return {
    id: `unit-${overrides.unitId}`,
    dependencies: [],
    status: "pending",
    activeActionId: null,
    phase: "implement",
    currentCycle: 1,
    repairRounds: 0,
    commandIndex: 0,
    acceptedCandidateSubject: null,
    integrationSubject: null,
    terminalLevel: null,
    alarm: false,
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

  it("levels unit terminals into one supervisor-derived operator alarm value", () => {
    expect(deriveUnitTerminalState("acceptance_passed")).toEqual({
      status: "completed",
      terminalLevel: "completed",
      alarm: false,
    });
    expect(deriveUnitTerminalState("structural_exit")).toEqual({
      status: "exited",
      terminalLevel: "exited",
      alarm: false,
    });
    expect(deriveUnitTerminalState("defect")).toEqual({
      status: "failed",
      terminalLevel: "failed",
      alarm: true,
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
      ticket_id: "issue-1",
      session_id: "session-1",
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
    const finalSubject = "5".repeat(40);

    const event = buildAggregateStageEvent({
      id: "aggregate-1",
      manifest,
      instance,
      parentAttempt,
      subject: finalSubject,
      completedAt: "2026-07-29T00:00:02.000Z",
      units: [
        unit({ unitId: "a", ordinal: 0, status: "completed", terminalLevel: "completed", integrationSubject: subject }),
        unit({ unitId: "b", ordinal: 1, status: "completed", terminalLevel: "completed", integrationSubject: subject }),
      ],
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
      details: {
        units: Array<{
          id: string;
          status: string;
          terminal_level: string | null;
          alarm: boolean;
          integration_subject: string | null;
        }>;
      };
      repository: { subject: string };
    };
    expect(stagePayload).toMatchObject({
      schema: "openthrottle.artifact/stage_result@1",
      evidence: [graphResult!.hash],
      details: { execution_graph_result_hash: graphResult!.hash },
      repository: { subject: finalSubject },
    });
    expect(graphPayload).toMatchObject({
      schema: "openthrottle.artifact/execution_graph_result@1",
      details: {
        units: [
          {
            id: "a",
            status: "completed",
            terminal_level: "completed",
            alarm: false,
            integration_subject: subject,
          },
          {
            id: "b",
            status: "completed",
            terminal_level: "completed",
            alarm: false,
            integration_subject: subject,
          },
        ],
      },
      repository: { subject: finalSubject },
    });
    expect(() => buildAggregateStageEvent({
      id: "aggregate-exited",
      manifest,
      instance,
      parentAttempt,
      subject,
      units: [
        unit({ unitId: "a", ordinal: 0, status: "completed", terminalLevel: "completed", integrationSubject: subject }),
        unit({ unitId: "b", ordinal: 1, status: "exited", terminalLevel: "exited", alarm: false }),
      ],
    })).toThrow(/requires every unit/);
    expect(() => buildAggregateStageEvent({
      id: "aggregate-1",
      manifest,
      instance,
      parentAttempt,
      subject: null,
      units: [unit({ unitId: "a", ordinal: 0, status: "completed", terminalLevel: "completed", integrationSubject: null })],
    })).toThrow(/requires a gated subject/);
    expect(() => buildAggregateStageEvent({
      id: "aggregate-1",
      manifest,
      instance,
      parentAttempt: { ...parentAttempt, run_id: null, planned_run_id: null },
      subject,
      units: [unit({ unitId: "a", ordinal: 0, status: "completed", terminalLevel: "completed", integrationSubject: subject })],
    })).toThrow(/requires a parent run binding/);
  });

  it("advances the durable unit phase sequence and derives the action kind for repair cycles", () => {
    expect(BUILTIN_UNIT_PHASES).toEqual(["implement", "simplify", "command", "candidate", "lead", "integrate"]);
    expect(nextUnitPhase("implement")).toBe("simplify");
    expect(nextUnitPhase("simplify")).toBe("command");
    expect(nextUnitPhase("command")).toBe("candidate");
    expect(nextUnitPhase("candidate")).toBe("lead");
    expect(nextUnitPhase("lead")).toBe("integrate");
    expect(nextUnitPhase("integrate")).toBeUndefined();

    expect(actionKindForUnitPhase("implement", 1)).toBe("implement");
    expect(actionKindForUnitPhase("implement", 2)).toBe("repair");
    expect(actionKindForUnitPhase("simplify", 2)).toBe("simplify");
    expect(actionKindForUnitPhase("command", 1)).toBe("command");
    expect(actionKindForUnitPhase("candidate", 1)).toBe("candidate");
    expect(actionKindForUnitPhase("lead", 1)).toBe("lead");
    expect(actionKindForUnitPhase("integrate", 1)).toBe("integrate");
    expect(repairCyclePhaseSequence(["command", "implement", "simplify", "candidate", "lead", "integrate"]))
      .toEqual(["implement", "simplify", "command", "candidate", "lead", "integrate"]);
  });

  it("routes a unit acceptance decision to integrate, bounded repair, or escalation", () => {
    expect(routeUnitAcceptanceDecision({
      outcome: "success", reason: "lead_scope_match_accept", repairRounds: 0, maxRepairRounds: 3,
    })).toEqual({ action: "integrate" });
    expect(routeUnitAcceptanceDecision({
      outcome: "semantic_repair_required", reason: "command_exit_nonzero", repairRounds: 0, maxRepairRounds: 3,
    })).toEqual({ action: "repair", repairRounds: 1 });
    expect(routeUnitAcceptanceDecision({
      outcome: "semantic_repair_required", reason: "command_exit_nonzero", repairRounds: 3, maxRepairRounds: 3,
    })).toEqual({ action: "settle", reason: "defect" });
    expect(routeUnitAcceptanceDecision({
      outcome: "needs_human", reason: "lead_needs_human", repairRounds: 0, maxRepairRounds: 3,
    })).toEqual({ action: "escalate", reason: "lead_needs_human" });
  });

  it("routes an integration decision to settlement or escalation", () => {
    expect(routeIntegrationDecision({ outcome: "success", reason: "executor_integrated_candidate" }))
      .toEqual({ action: "settle_completed" });
    expect(routeIntegrationDecision({ outcome: "failure", reason: "integration_evidence_failed" }))
      .toEqual({ action: "escalate", reason: "integration_evidence_failed" });
  });

  it("routes a final review decision to done, bounded repair, or escalation", () => {
    expect(routeFinalReviewDecision({
      outcome: "success", reason: "typed_semantic_result", repairRounds: 0, maxRepairRounds: 3,
    })).toEqual({ action: "done" });
    expect(routeFinalReviewDecision({
      outcome: "no_change", reason: "no_findings", repairRounds: 0, maxRepairRounds: 3,
    })).toEqual({ action: "done" });
    expect(routeFinalReviewDecision({
      outcome: "semantic_repair_required", reason: "unresolved_review_finding", repairRounds: 0, maxRepairRounds: 3,
    })).toEqual({ action: "repair", repairRounds: 1 });
    expect(routeFinalReviewDecision({
      outcome: "failure", reason: "command_exit_nonzero", repairRounds: 0, maxRepairRounds: 3,
    })).toEqual({ action: "repair", repairRounds: 1 });
    expect(routeFinalReviewDecision({
      outcome: "semantic_repair_required", reason: "unresolved_review_finding", repairRounds: 3, maxRepairRounds: 3,
    })).toEqual({ action: "escalate", reason: "final_review_repair_rounds_exhausted" });
    expect(routeFinalReviewDecision({
      outcome: "failure", reason: "command_exit_nonzero", repairRounds: 3, maxRepairRounds: 3,
    })).toEqual({ action: "escalate", reason: "final_review_repair_rounds_exhausted" });
    expect(routeFinalReviewDecision({
      outcome: "needs_human", reason: "review_needs_human", repairRounds: 0, maxRepairRounds: 3,
    })).toEqual({ action: "escalate", reason: "review_needs_human" });
  });
});
