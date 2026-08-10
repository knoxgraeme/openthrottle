import { describe, expect, it } from "vitest";
import type { ReviewFinding, SemanticReviewReceipt } from "@openthrottle/contracts";
import { buildReviewFanoutPlan, synthesizeReviewFanout, validateReviewFanoutBlockers } from "./review-fanout.js";
import { buildReviewJournal } from "./review-journal.js";

function receipt(input: {
  personaId: string;
  subject: string;
  findings: ReviewFinding[];
}): SemanticReviewReceipt {
  return {
    schema: "openthrottle.receipt/v1",
    type: "semantic_review",
    assurance: "semantic_attested",
    result: input.findings.length > 0 ? "semantic_repair_required" : "success",
    producer: {
      worker_id: input.personaId,
      skill: `builtin://${input.personaId}@1`,
      capability_digest: "a".repeat(64),
      skill_package_digest: null,
    },
    subject: { base: "0".repeat(40), pre: input.subject, post: input.subject },
    fence: {
      pipeline_instance_id: "instance-1",
      graph_digest: "b".repeat(64),
      unit_id: "__final__",
      attempt_id: "attempt-1",
      parent_run_id: "run-1",
      action_attempt_id: `review-${input.personaId}`,
      generation: 1,
      native_session_id: null,
      request_hash: "c".repeat(64),
    },
    evidence: [`${input.personaId} traced settleEffect`],
    payload: { summary: "Review complete.", findings: input.findings },
    issued_at: "2099-07-22T12:00:01.000Z",
  };
}

describe("review journal construction", () => {
  it("groups the same defect across persona invariants without inventing a synthesized finding", () => {
    const subject = "1".repeat(40);
    const plan = buildReviewFanoutPlan({ subject });
    const findingsByPersona: Record<string, ReviewFinding[]> = {
      "correctness-dataflow": [{
        severity: "P1",
        path: "supervisor/src/effects.ts",
        message: "[supervisor/src/effects.ts#settleEffect: changed control and data flow preserves declared behavior] A failed effect is marked complete before retry scheduling.",
      }],
      "tests-contracts": [{
        severity: "P1",
        path: "supervisor/src/effects.ts",
        message: "[supervisor/src/effects.ts#settleEffect: changed behavior has executable contract proof] A failed effect is marked complete before retry scheduling.",
      }],
    };
    const personaReceipts = plan.personas.map((persona) => receipt({
      personaId: persona.id,
      subject,
      findings: findingsByPersona[persona.id] ?? [],
    }));
    const rawSynthesis = synthesizeReviewFanout({ plan, receipts: personaReceipts });
    const validator = receipt({
      personaId: "review-validator",
      subject,
      findings: rawSynthesis.findings,
    });
    const validated = validateReviewFanoutBlockers({ synthesis: rawSynthesis, validator });
    const journal = buildReviewJournal({
      plan,
      baseSubject: "0".repeat(40),
      receipts: personaReceipts.map((personaReceipt) => ({
        receipt: personaReceipt,
        completedAt: "2099-07-22T12:00:01.000Z",
      })),
      validation: validated,
      cycle: 1,
      actionCreatedAt: "2099-07-22T12:00:00.000Z",
      recordedAt: "2099-07-22T12:00:02.000Z",
    });

    expect(validated.synthesis.findings).toHaveLength(2);
    expect(journal.synthesis.findings).toHaveLength(1);
    expect(journal.finding_resolutions).toEqual([
      expect.objectContaining({
        semantic_group_id: expect.stringMatching(/^semantic_group_[a-f0-9]{32}$/),
        exact_dedup_personas: ["correctness-dataflow", "tests-contracts"],
        semantic_dedup_finding_ids: expect.arrayContaining([
          ...journal.persona_receipts.flatMap((personaReceipt) => personaReceipt.finding_ids),
        ]),
        corroboration_count: 2,
      }),
    ]);
  });
});
