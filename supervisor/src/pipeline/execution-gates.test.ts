import { describe, expect, it } from "vitest";
import {
  evaluateFinalReviewGate,
  evaluateIntegrationGate,
  evaluateUnitAcceptanceGate,
  type StandardReceiptFence,
} from "./execution-gates.js";

const expected: StandardReceiptFence = {
  pipelineInstanceId: "instance-1",
  graphDigest: "a".repeat(64),
  unitId: "unit-1",
  attemptId: "attempt-1",
  requestHash: "b".repeat(64),
  subject: "1".repeat(40),
};

function receipt(type: string, result: string, overrides: Record<string, unknown> = {}) {
  return {
    schema: "openthrottle.receipt/v1",
    type,
    assurance: type === "command_result" || type.endsWith("_evidence") ? "executor_verified" : "semantic_attested",
    result,
    producer: {
      worker_id: "worker-1",
      skill: `builtin://${type}@1`,
      capability_digest: "c".repeat(64),
    },
    subject: {
      base: "0".repeat(40),
      pre: "0".repeat(40),
      post: expected.subject,
    },
    fence: {
      pipeline_instance_id: expected.pipelineInstanceId,
      graph_digest: expected.graphDigest,
      unit_id: expected.unitId,
      attempt_id: expected.attemptId,
      request_hash: expected.requestHash,
    },
    evidence: ["evidence"],
    payload: {},
    issued_at: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

const command = (result: "success" | "failure" | "not_configured", exitCode: number | null) => receipt("command_result", result, {
  payload: { command: "test", exit_code: exitCode, summary: "command done" },
});

describe("structured execution gates", () => {
  it("accepts a unit only from worker success, executor candidate evidence, commands, and a lead scope decision", () => {
    expect(evaluateUnitAcceptanceGate({
      expected,
      completion: receipt("unit_completion", "success") as never,
      candidate: receipt("candidate_evidence", "success") as never,
      commands: [command("success", 0) as never, command("not_configured", null) as never],
      lead: receipt("unit_decision", "accept", {
        payload: {
          rationale: "Matches assigned scope.",
          context_updates: [],
          accepted_subject: expected.subject,
        },
      }) as never,
    })).toMatchObject({
      outcome: "success",
      result: "passed",
      reason: "lead_scope_match_accept",
    });
  });

  it("rejects per-unit acceptance produced by code review", () => {
    expect(() => evaluateUnitAcceptanceGate({
      expected,
      completion: receipt("unit_completion", "success") as never,
      candidate: receipt("candidate_evidence", "success") as never,
      commands: [],
      lead: receipt("unit_decision", "accept", {
        producer: {
          worker_id: "lead-1",
          skill: "builtin://ce-code-review@1",
          capability_digest: "c".repeat(64),
        },
        payload: {
          rationale: "Reviewed code.",
          context_updates: [],
          accepted_subject: expected.subject,
        },
      }) as never,
    })).toThrow(/must not be produced by ce-code-review/);
  });

  it("maps lead revision and command failure to repair-required/failure deterministically", () => {
    expect(evaluateUnitAcceptanceGate({
      expected,
      completion: receipt("unit_completion", "success") as never,
      candidate: receipt("candidate_evidence", "success") as never,
      commands: [],
      lead: receipt("unit_decision", "revise", {
        payload: { rationale: "Missing scoped behavior.", revision_request: "Add the required case.", context_updates: [] },
      }) as never,
    })).toMatchObject({ outcome: "semantic_repair_required", reason: "lead_requested_revision" });

    expect(evaluateUnitAcceptanceGate({
      expected,
      completion: receipt("unit_completion", "success") as never,
      candidate: receipt("candidate_evidence", "success") as never,
      commands: [command("failure", 1) as never],
      lead: receipt("unit_decision", "accept", {
        payload: { rationale: "Matches.", context_updates: [], accepted_subject: expected.subject },
      }) as never,
    })).toMatchObject({ outcome: "failure", reason: "command_exit_nonzero" });
  });

  it("accepts exact integration evidence and rejects stale final review subjects", () => {
    expect(evaluateIntegrationGate({
      expected,
      integration: receipt("integration_evidence", "success") as never,
    })).toMatchObject({ outcome: "success", reason: "executor_integrated_candidate" });

    expect(() => evaluateFinalReviewGate({
      expected,
      commands: [command("success", 0) as never],
      review: receipt("semantic_review", "success", {
        subject: { base: "0".repeat(40), pre: "0".repeat(40), post: "2".repeat(40) },
        payload: { summary: "clean", findings: [] },
      }) as never,
    })).toThrow(/review receipt subject mismatch/);
  });

  it("runs whole-change commands before accepting the final semantic review", () => {
    expect(evaluateFinalReviewGate({
      expected,
      commands: [command("success", 0) as never],
      review: receipt("semantic_review", "success", {
        payload: { summary: "clean", findings: [] },
      }) as never,
    })).toMatchObject({ outcome: "success", reason: "typed_semantic_result" });

    expect(evaluateFinalReviewGate({
      expected,
      commands: [command("failure", 1) as never],
      review: receipt("semantic_review", "success", {
        payload: { summary: "clean", findings: [] },
      }) as never,
    })).toMatchObject({ outcome: "failure", reason: "command_exit_nonzero" });

    expect(() => evaluateFinalReviewGate({
      expected,
      commands: [receipt("command_result", "success", {
        issued_at: "2026-07-29T00:00:02.000Z",
        payload: { command: "test", exit_code: 0, summary: "command done" },
      }) as never],
      review: receipt("semantic_review", "success", {
        issued_at: "2026-07-29T00:00:01.000Z",
        payload: { summary: "clean", findings: [] },
      }) as never,
    })).toThrow(/predates whole-change command evidence/);
  });
});
