import { describe, expect, it } from "vitest";
import type { ReviewFinding, ReviewJournalContract, SemanticReviewReceipt } from "@openthrottle/contracts";
import {
  buildReviewFanoutPlan,
  reviewFindingKey,
  synthesizeReviewFanout,
  validateReviewFanoutBlockers,
  type ReviewFanoutPlan,
  type ValidatedReviewFanout,
} from "./review-fanout.js";
import { buildReviewJournal } from "./review-journal.js";

function receipt(input: {
  personaId: string;
  subject: string;
  findings: ReviewFinding[];
  result?: SemanticReviewReceipt["result"];
}): SemanticReviewReceipt {
  return {
    schema: "openthrottle.receipt/v1",
    type: "semantic_review",
    assurance: "semantic_attested",
    result: input.result ?? (input.findings.length > 0 ? "semantic_repair_required" : "success"),
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

function personaReceipts(input: {
  plan: ReviewFanoutPlan;
  subject: string;
  findingsByPersona: Record<string, ReviewFinding[]>;
}): SemanticReviewReceipt[] {
  return input.plan.personas.map((persona) => receipt({
    personaId: persona.id,
    subject: input.subject,
    findings: input.findingsByPersona[persona.id] ?? [],
  }));
}

function journal(input: {
  plan: ReviewFanoutPlan;
  receipts: SemanticReviewReceipt[];
  validation: ValidatedReviewFanout;
  cycle: number;
  previousJournal?: ReviewJournalContract;
}): ReviewJournalContract {
  return buildReviewJournal({
    plan: input.plan,
    baseSubject: "0".repeat(40),
    receipts: input.receipts.map((personaReceipt) => ({
      receipt: personaReceipt,
      completedAt: "2099-07-22T12:00:01.000Z",
    })),
    validation: input.validation,
    cycle: input.cycle,
    actionCreatedAt: "2099-07-22T12:00:00.000Z",
    recordedAt: "2099-07-22T12:00:02.000Z",
    ...(input.previousJournal ? { previousJournal: input.previousJournal } : {}),
  });
}

describe("review journal construction", () => {
  it("groups differently worded cross-persona findings before validator, repair, and journal", () => {
    const subject = "1".repeat(40);
    const plan = buildReviewFanoutPlan({ subject });
    const receipts = personaReceipts({
      plan,
      subject,
      findingsByPersona: {
        "correctness-dataflow": [{
          severity: "P1",
          path: "supervisor/src/effects.ts",
          message: "[supervisor/src/effects.ts#settleEffect|failed-effect-retry-ordering: changed control and data flow preserves declared behavior] A failed effect is marked complete before retry scheduling.",
        }],
        "tests-contracts": [{
          severity: "P0",
          path: "supervisor/src/effects.ts",
          message: "[supervisor/src/effects.ts#settleEffect|failed-effect-retry-ordering: changed behavior has executable contract proof] No regression proves that retry scheduling precedes completion after failure.",
        }],
      },
    });

    const synthesis = synthesizeReviewFanout({ plan, receipts });
    expect(synthesis.findings).toHaveLength(1);
    const representative = synthesis.findings[0]!;
    expect(representative.severity).toBe("P0");
    const validation = validateReviewFanoutBlockers({
      synthesis,
      validator: receipt({
        personaId: "review-validator",
        subject,
        findings: [representative],
      }),
    });
    const repairFindings = validation.synthesis.findings.filter((finding) =>
      finding.severity === "P0" || finding.severity === "P1"
    );
    const reviewJournal = journal({ plan, receipts, validation, cycle: 1 });

    expect(repairFindings).toEqual([representative]);
    expect(reviewJournal.synthesis.findings).toHaveLength(1);
    expect(reviewJournal.synthesis.findings[0]).toMatchObject(representative);
    expect(reviewJournal.finding_resolutions).toEqual([
      expect.objectContaining({
        semantic_group_id: expect.stringMatching(/^semantic_group_[a-f0-9]{32}$/),
        exact_dedup_personas: ["correctness-dataflow", "tests-contracts"],
        semantic_dedup_finding_ids: expect.arrayContaining([
          ...reviewJournal.persona_receipts.flatMap((personaReceipt) => personaReceipt.finding_ids),
        ]),
        validator_result: "accepted",
        repair_disposition: "accepted",
        corroboration_count: 2,
        state: "unresolved",
      }),
    ]);
  });

  it("keeps a rejected representative resolved when its semantic group also has blocker and advisory members", () => {
    const subject = "2".repeat(40);
    const plan = buildReviewFanoutPlan({
      subject,
      commandNames: ["retry fanout"],
    });
    const receipts = personaReceipts({
      plan,
      subject,
      findingsByPersona: {
        "correctness-dataflow": [{
          severity: "P1",
          path: "supervisor/src/effects.ts",
          message: "[supervisor/src/effects.ts#settleEffect|failed-effect-retry-ordering: changed control and data flow preserves declared behavior] Failure may settle before retry scheduling.",
        }],
        "tests-contracts": [{
          severity: "P1",
          path: "supervisor/src/effects.ts",
          message: "[supervisor/src/effects.ts#settleEffect|failed-effect-retry-ordering: changed behavior has executable contract proof] The retry ordering assertion is missing.",
        }],
        "reliability-adversarial": [{
          severity: "P2",
          path: "supervisor/src/effects.ts",
          message: "[supervisor/src/effects.ts#settleEffect|failed-effect-retry-ordering: retries ordering and settlement fail closed] Add operator telemetry for the retry ordering path.",
        }],
      },
    });
    const synthesis = synthesizeReviewFanout({ plan, receipts });
    expect(synthesis.findings).toHaveLength(1);
    const representative = synthesis.findings[0]!;
    const validation = validateReviewFanoutBlockers({
      synthesis,
      validator: receipt({
        personaId: "review-validator",
        subject,
        findings: [],
        result: "success",
      }),
    });
    expect(validation.rejected_blocking_finding_keys).toEqual([reviewFindingKey(representative)]);

    const reviewJournal = journal({ plan, receipts, validation, cycle: 1 });

    expect(reviewJournal.finding_resolutions).toEqual([
      expect.objectContaining({
        exact_dedup_personas: ["correctness-dataflow", "tests-contracts", "reliability-adversarial"],
        semantic_dedup_finding_ids: expect.arrayContaining(
          reviewJournal.persona_receipts.flatMap((personaReceipt) => personaReceipt.finding_ids)
        ),
        validator_result: "rejected",
        repair_disposition: "rejected",
        state: "resolved",
      }),
    ]);
  });

  it("keeps distinct defect claims against the same symbol in separate journal groups", () => {
    const subject = "5".repeat(40);
    const plan = buildReviewFanoutPlan({ subject });
    const receipts = personaReceipts({
      plan,
      subject,
      findingsByPersona: {
        "correctness-dataflow": [{
          severity: "P1",
          path: "supervisor/src/effects.ts",
          message: "[supervisor/src/effects.ts#settleEffect|failed-effect-retry-ordering: changed control and data flow preserves declared behavior] Completion is recorded before retry scheduling.",
        }, {
          severity: "P1",
          path: "supervisor/src/effects.ts",
          message: "[supervisor/src/effects.ts#settleEffect|terminal-error-attribution: changed control and data flow preserves declared behavior] Terminal errors are attributed to the wrong action.",
        }],
      },
    });

    const synthesis = synthesizeReviewFanout({ plan, receipts });
    expect(synthesis.findings).toHaveLength(2);
    const validation = validateReviewFanoutBlockers({
      synthesis,
      validator: receipt({
        personaId: "review-validator",
        subject,
        findings: synthesis.findings,
      }),
    });
    const reviewJournal = journal({ plan, receipts, validation, cycle: 1 });

    expect(new Set(reviewJournal.synthesis.findings.map((finding) => finding.finding_id)).size).toBe(2);
    expect(new Set(reviewJournal.finding_resolutions.map((resolution) => resolution.semantic_group_id)).size).toBe(2);
    expect(reviewJournal.finding_resolutions).toHaveLength(2);
    expect(reviewJournal.finding_resolutions.every((resolution) => resolution.state === "unresolved")).toBe(true);
  });

  it("carries a cycle-two finding by stable id when only its diagnostic prose changes", () => {
    const firstSubject = "3".repeat(40);
    const firstPlan = buildReviewFanoutPlan({ subject: firstSubject });
    const firstReceipts = personaReceipts({
      plan: firstPlan,
      subject: firstSubject,
      findingsByPersona: {
        "correctness-dataflow": [{
          severity: "P1",
          path: "supervisor/src/effects.ts",
          message: "[supervisor/src/effects.ts#settleEffect|failed-effect-retry-ordering: changed control and data flow preserves declared behavior] Failure can settle before retry scheduling.",
        }],
      },
    });
    const firstSynthesis = synthesizeReviewFanout({ plan: firstPlan, receipts: firstReceipts });
    const firstValidation = validateReviewFanoutBlockers({
      synthesis: firstSynthesis,
      validator: receipt({
        personaId: "review-validator",
        subject: firstSubject,
        findings: firstSynthesis.findings,
      }),
    });
    const firstJournal = journal({
      plan: firstPlan,
      receipts: firstReceipts,
      validation: firstValidation,
      cycle: 1,
    });

    const secondSubject = "4".repeat(40);
    const secondPlan = buildReviewFanoutPlan({
      subject: secondSubject,
      requiredPersonaIds: firstPlan.personas.map((persona) => persona.id),
    });
    const secondReceipts = personaReceipts({
      plan: secondPlan,
      subject: secondSubject,
      findingsByPersona: {
        "correctness-dataflow": [{
          severity: "P1",
          path: "supervisor/src/effects.ts",
          message: "[supervisor/src/effects.ts#settleEffect|failed-effect-retry-ordering: changed control and data flow preserves declared behavior] The error branch still records completion before it makes the retry durable.",
        }],
      },
    });
    const secondSynthesis = synthesizeReviewFanout({ plan: secondPlan, receipts: secondReceipts });
    const secondValidation = validateReviewFanoutBlockers({
      synthesis: secondSynthesis,
      validator: receipt({
        personaId: "review-validator",
        subject: secondSubject,
        findings: secondSynthesis.findings,
      }),
    });
    const secondJournal = journal({
      plan: secondPlan,
      receipts: secondReceipts,
      validation: secondValidation,
      cycle: 2,
      previousJournal: firstJournal,
    });

    expect(secondJournal.synthesis.findings).toHaveLength(1);
    expect(secondJournal.synthesis.findings[0]!.finding_id).toBe(firstJournal.synthesis.findings[0]!.finding_id);
    expect(secondJournal.finding_resolutions).toEqual([
      expect.objectContaining({
        finding_id: firstJournal.finding_resolutions[0]!.finding_id,
        semantic_group_id: firstJournal.finding_resolutions[0]!.semantic_group_id,
        convergence_cycle: 2,
        repair_disposition: "accepted",
        state: "unresolved",
      }),
    ]);
  });
});
