import { describe, expect, it } from "vitest";
import {
  EVAL_DEFINITION_SCHEMA,
  EXECUTION_RECORD_SCHEMA,
  SEMANTIC_RESULT_SCHEMA,
  type CompiledAgentPipelineStage,
  type EvalDefinition,
  type ResultRecord,
  type SemanticResultSchemaContract,
} from "@openthrottle/contracts";
import {
  KernelEvaluatorRegistry,
  SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA,
} from "./evaluator-registry.js";

const reviewSchema: SemanticResultSchemaContract = {
  schema: SEMANTIC_RESULT_SCHEMA,
  id: "core/review-result",
  outcomes: ["success", "no_change", "semantic_repair_required", "needs_human", "failure"],
  payload: {
    summary: { type: "string", max_length: 4_000 },
    findings: { type: "review_finding_list_v1", max_items: 64 },
  },
};

const evaluation: EvalDefinition = {
  schema: EVAL_DEFINITION_SCHEMA,
  id: "core/review-result",
  evaluator: "core/review-outcome@1",
  result: reviewSchema,
};

const stage: CompiledAgentPipelineStage = {
  id: "review",
  kind: "agent",
  engine: "codex",
  agent_id: "core/reviewer",
  repository_authority: "inspect",
  skills: ["core/review-change"],
  entry_skill: "core/review-change",
  eval: evaluation.id,
  on: {
    success: { terminal: "completed" },
    semantic_repair_required: { terminal: "needs_human" },
  },
};

function reviewResult(severity: "P0" | "P1" | "P2" | "P3"): ResultRecord {
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: `result-review-${severity}`,
    kind: "result",
    pipeline_run_id: "run-1",
    attempt_id: "attempt-review",
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
        semantic_schema_id: reviewSchema.id,
        outcome: "success",
        payload: {
          summary: "reviewed",
          findings: [{
            severity,
            path: "src/example.ts",
            anchor: "example",
            title: `${severity} finding`,
            evidence: "Observed against the sealed subject.",
          }],
        },
        transformations: [],
      },
    },
    created_at: "2026-08-22T12:00:00.000Z",
  };
}

describe("KernelEvaluatorRegistry review findings", () => {
  it.each(["P0", "P1"] as const)("treats %s findings as blocking", (severity) => {
    expect(new KernelEvaluatorRegistry().evaluateSemantic({
      stage,
      evaluation,
      result: reviewResult(severity),
    })).toEqual({
      evaluator: "core/review-outcome@1",
      outcome: "semantic_repair_required",
      reason: "blocking_review_finding",
    });
  });

  it.each(["P2", "P3"] as const)("treats %s findings as advisory", (severity) => {
    expect(new KernelEvaluatorRegistry().evaluateSemantic({
      stage,
      evaluation,
      result: reviewResult(severity),
    })).toEqual({
      evaluator: "core/review-outcome@1",
      outcome: "success",
      reason: "validated_semantic_result",
    });
  });
});
