import { describe, expect, it } from "vitest";
import {
  EXECUTION_PLAN_SCHEMA_V2,
  EXECUTION_RECORD_SCHEMA,
  type ExecutionPlanContractV2,
  type ResultRecord,
} from "@openthrottle/contracts";
import { SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA } from "../pipeline/kernel/evaluator-registry.js";
import {
  admissionPlannerEvidence,
  approvedAdmissionReviewEvidence,
} from "./kernel-admission-promotion.js";

const NOW = "2026-08-20T12:00:00.000Z";

function executionPlan(pipelineId = "core/structured"): ExecutionPlanContractV2 {
  return {
    schema: EXECUTION_PLAN_SCHEMA_V2,
    pipeline_id: pipelineId,
    plan_id: "plan-1",
    units: [{
      id: "unit-a",
      title: "Implement the change",
      depends_on: [],
      objective: "Implement the accepted work item.",
      requirements: ["Preserve the sealed contract."],
      files: ["src/change.ts"],
      approach: ["Follow the existing boundary."],
      tests: ["Cover the accepted behavior."],
      acceptance: ["The focused test passes."],
      verification: ["npm test"],
    }],
    commands: [{ name: "test", unit: "unit-a" }],
  };
}

function semanticResult(input: {
  id: string;
  semantic_schema_id: "core/admission-result" | "core/admission-review-result";
  outcome: string;
  payload: Record<string, unknown>;
}): ResultRecord {
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: input.id,
    kind: "result",
    pipeline_run_id: "run-admission",
    attempt_id: "attempt-admission",
    request_hash: "a".repeat(64),
    definition_bundle_hash: "b".repeat(64),
    input_subject: "c".repeat(40),
    output_subject: null,
    original_candidate_hash: "d".repeat(64),
    normalized_candidate_hash: "e".repeat(64),
    payload_schema: SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA,
    payload: {
      inline: {
        schema: SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA,
        semantic_schema_id: input.semantic_schema_id,
        outcome: input.outcome,
        payload: input.payload,
        transformations: [],
      } as never,
    },
    created_at: NOW,
  };
}

function plannerResult(input: {
  outcome: string;
  plan: ExecutionPlanContractV2 | null;
  questions?: string[];
}): ResultRecord {
  return semanticResult({
    id: `result-planner-${input.outcome}`,
    semantic_schema_id: "core/admission-result",
    outcome: input.outcome,
    payload: {
      summary: "Selected an execution route.",
      execution_plan: input.plan,
      questions: input.questions ?? [],
    },
  });
}

function reviewerResult(input: {
  outcome: string;
  findings?: string[];
  questions?: string[];
}): ResultRecord {
  return semanticResult({
    id: `result-reviewer-${input.outcome}`,
    semantic_schema_id: "core/admission-review-result",
    outcome: input.outcome,
    payload: {
      summary: "Reviewed the proposed route.",
      findings: input.findings ?? [],
      questions: input.questions ?? [],
    },
  });
}

describe("admission promotion evidence semantics", () => {
  it("accepts only route-consistent executable planner evidence", () => {
    expect(admissionPlannerEvidence(plannerResult({ outcome: "simple", plan: null })))
      .toMatchObject({ route: "simple", execution_plan: null });
    expect(admissionPlannerEvidence(plannerResult({ outcome: "structured", plan: executionPlan() })))
      .toMatchObject({ route: "structured", execution_plan: { pipeline_id: "core/structured" } });
  });

  it.each([
    ["simple route with a plan", "simple", executionPlan(), []],
    ["structured route without a plan", "structured", null, []],
    ["structured route with another pipeline", "structured", executionPlan("core/implement"), []],
    ["executable route with unresolved questions", "simple", null, ["Which route?"]],
  ] as const)("rejects planner evidence for %s", (_label, outcome, plan, questions) => {
    expect(() => admissionPlannerEvidence(plannerResult({
      outcome,
      plan,
      questions: [...questions],
    }))).toThrow(/has inconsistent route semantics/);
  });

  it.each([
    ["blocking findings", ["The plan is incomplete."], []],
    ["unresolved questions", [], ["Which repository owns this?"]],
  ] as const)("rejects an approved reviewer outcome with %s", (_label, findings, questions) => {
    expect(() => approvedAdmissionReviewEvidence(reviewerResult({
      outcome: "approved",
      findings: [...findings],
      questions: [...questions],
    }))).toThrow(/is not an exact approval/);
  });

  it("does not treat a non-approved reviewer outcome as approval evidence", () => {
    expect(approvedAdmissionReviewEvidence(reviewerResult({
      outcome: "rejected",
      findings: ["The route is unsafe."],
    }))).toBeNull();
  });
});
