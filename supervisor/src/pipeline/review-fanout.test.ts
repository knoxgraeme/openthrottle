import { describe, expect, it } from "vitest";
import type { SemanticReviewReceipt } from "@openthrottle/contracts";
import { buildReviewFanoutPlan, synthesizeReviewFanout, validateReviewFanoutRepair } from "./review-fanout.js";

function reviewReceipt(input: {
  persona: string;
  subject: string;
  result?: SemanticReviewReceipt["result"];
  findings?: SemanticReviewReceipt["payload"]["findings"];
}): SemanticReviewReceipt {
  return {
    schema: "openthrottle.receipt/v1",
    type: "semantic_review",
    assurance: "semantic_attested",
    result: input.result ?? "success",
    producer: {
      worker_id: input.persona,
      skill: `builtin://${input.persona}@1`,
      capability_digest: "a".repeat(64),
      skill_package_digest: null,
    },
    subject: { base: "0".repeat(40), pre: input.subject, post: input.subject },
    fence: {
      pipeline_instance_id: "instance-1",
      graph_digest: "b".repeat(64),
      unit_id: "unit_a",
      attempt_id: "attempt-1",
      parent_run_id: "run-1",
      action_attempt_id: `review-${input.persona}`,
      generation: 1,
      native_session_id: null,
      request_hash: "c".repeat(64),
    },
    evidence: ["reviewed exact subject"],
    payload: { summary: "Reviewed.", findings: input.findings ?? [] },
    issued_at: "2099-07-22T12:00:00.000Z",
  };
}

describe("review fanout runtime contract", () => {
  it("selects mandatory personas first, then risk-triggered personas in deterministic order", () => {
    const subject = "1".repeat(40);
    const plan = buildReviewFanoutPlan({
      subject,
      unit: {
        id: "fanout_runtime",
        title: "Implement deterministic persona fanout and validated repair",
        instructions: ["runtime"],
        acceptance: ["fanout_safe"],
      },
      instructions: {
        runtime: "Implement bounded independent dispatch, exact roster rerun, receipt fences, and repair settlement.",
      },
      acceptance: {
        fanout_safe: "The supervisor seals and dispatches one bounded roster and validation controls the gate.",
      },
      commandNames: ["test", "build"],
    });

    expect(plan.personas.map((persona) => persona.id)).toEqual([
      "correctness-dataflow",
      "tests-contracts",
      "reliability-adversarial",
      "agent-native-contracts",
      "performance",
    ]);
    expect(new Set(plan.personas.map((persona) => persona.id)).size).toBe(plan.personas.length);
  });

  it("requires every selected persona to complete against the exact subject before synthesis", () => {
    const subject = "2".repeat(40);
    const plan = buildReviewFanoutPlan({
      subject,
      unit: { id: "unit_a", title: "Unit A", instructions: ["one"], acceptance: ["done"] },
      instructions: { one: "Implement a simple leaf." },
      acceptance: { done: "The leaf is done." },
    });

    expect(() => synthesizeReviewFanout({
      plan,
      receipts: [reviewReceipt({ persona: "correctness-dataflow", subject })],
    })).toThrow(/missing personas: tests-contracts/);

    expect(() => synthesizeReviewFanout({
      plan,
      receipts: plan.personas.map((persona) => reviewReceipt({
        persona: persona.id,
        subject: persona.id === "tests-contracts" ? "3".repeat(40) : subject,
      })),
    })).toThrow(/is not bound to the exact subject/);
  });

  it("deduplicates semantically exact findings and rejects repair roster drift", () => {
    const subject = "4".repeat(40);
    const plan = buildReviewFanoutPlan({
      subject,
      unit: { id: "unit_a", title: "Unit A", instructions: ["one"], acceptance: ["done"] },
      instructions: { one: "Implement retry receipt validation." },
      acceptance: { done: "The leaf is done." },
    });
    const finding = { severity: "P1" as const, message: "Candidate omits the acceptance check.", path: "src/unit.ts" };
    const synthesis = synthesizeReviewFanout({
      plan,
      receipts: plan.personas.map((persona) => reviewReceipt({
        persona: persona.id,
        subject,
        result: "semantic_repair_required",
        findings: [finding],
      })),
    });

    expect(synthesis.findings).toEqual([finding]);
    expect(synthesis.outcome).toBe("semantic_repair_required");
    expect(() => validateReviewFanoutRepair({
      previous: synthesis,
      nextPlan: buildReviewFanoutPlan({
        subject: "5".repeat(40),
        unit: { id: "unit_a", title: "Unit A", instructions: ["one"], acceptance: ["done"] },
        instructions: { one: "Implement a simple leaf." },
        acceptance: { done: "The leaf is done." },
      }),
    })).toThrow(/must rerun the exact prior roster/);
    expect(() => validateReviewFanoutRepair({ previous: synthesis, nextPlan: { ...plan, subject: "5".repeat(40) } }))
      .not.toThrow();
  });
});
