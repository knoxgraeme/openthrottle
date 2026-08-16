import { describe, expect, it } from "vitest";
import { canonicalJson, type SemanticReviewReceipt } from "@openthrottle/contracts";
import {
  REVIEW_SELECTOR_RECOMMENDATION_SCHEMA,
  buildReviewFanoutPlan,
  buildReviewSelectorAuthority,
  parseReviewSelectorRecommendation,
  synthesizeReviewFanout,
  validateReviewFanoutBlockers,
  validateReviewFanoutRepair,
} from "./review-fanout.js";

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
    expect(plan.max_parallel).toBe(1);
    expect(new Set(plan.personas.map((persona) => persona.id)).size).toBe(plan.personas.length);
  });

  it("matches v2 title and file path risk signals without prose keywords", () => {
    const subject = "8".repeat(40);
    const plan = buildReviewFanoutPlan({
      subject,
      unit: {
        id: "unit_schema_auth",
        title: "Normalize standards adapter",
        instructions: ["Plain implementation text."],
        acceptance: ["Plain acceptance text."],
        files: [
          "supervisor/src/persistence/migrations/definitions.ts",
          "supervisor/src/providers/github/auth.ts",
        ],
      },
    });

    expect(plan.personas.map((persona) => persona.id)).toEqual([
      "correctness-dataflow",
      "tests-contracts",
      "security",
      "data-migration",
      "project-standards",
    ]);
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

  it("synthesizes byte-identically regardless of concurrent receipt arrival order", () => {
    const subject = "3".repeat(40);
    const plan = buildReviewFanoutPlan({
      subject,
      instructions: { one: "Review bounded parallel fanout retry dispatch." },
    });
    const receipts = plan.personas.map((persona) => reviewReceipt({ persona: persona.id, subject }));

    expect(canonicalJson(synthesizeReviewFanout({ plan, receipts }))).toBe(
      canonicalJson(synthesizeReviewFanout({ plan, receipts: [...receipts].reverse() }))
    );
  });

  it("deduplicates semantically exact findings and rejects repair roster drift", () => {
    const subject = "4".repeat(40);
    const plan = buildReviewFanoutPlan({
      subject,
      unit: { id: "unit_a", title: "Unit A", instructions: ["one"], acceptance: ["done"] },
      instructions: { one: "Implement retry receipt validation." },
      acceptance: { done: "The leaf is done." },
    });
    const synthesis = synthesizeReviewFanout({
      plan,
      receipts: plan.personas.map((persona) => reviewReceipt({
        persona: persona.id,
        subject,
        result: "semantic_repair_required",
        findings: [{
          severity: "P1",
          message: `[src/unit.ts#acceptCandidate|acceptance-check-omitted: ${persona.invariant}] Candidate omits the acceptance check.`,
          path: "src/unit.ts",
        }],
      })),
    });

    expect(synthesis.findings).toHaveLength(1);
    expect(synthesis.findings[0]).toMatchObject({ severity: "P1", path: "src/unit.ts" });
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

  it("validates an evidence-backed selector recommendation before deterministic policy additions", () => {
    const subject = "6".repeat(40);
    const authority = buildReviewSelectorAuthority({ subject });
    const recommendation = parseReviewSelectorRecommendation(JSON.stringify({
      schema: REVIEW_SELECTOR_RECOMMENDATION_SCHEMA,
      subject,
      policy_digest: authority.policy_digest,
      personas: [{ persona_id: "security", rationale: "The changed webhook crosses an HMAC trust boundary." }],
    }), authority);
    const plan = buildReviewFanoutPlan({
      subject,
      instructions: { risk: "Retry webhook dispatch after authorization." },
      recommendation,
      selectorReceiptHash: "d".repeat(64),
    });

    expect(plan.personas.map((persona) => [persona.id, persona.reason])).toEqual([
      ["correctness-dataflow", "mandatory_baseline"],
      ["tests-contracts", "mandatory_baseline"],
      ["reliability-adversarial", "risk_triggered"],
      ["security", "agent_selected"],
    ]);
    expect(plan.selector_receipt_hash).toBe("d".repeat(64));
    const synthesis = synthesizeReviewFanout({
      plan,
      receipts: plan.personas.map((persona) => reviewReceipt({ persona: persona.id, subject })),
    });
    expect(synthesis.receipt_hashes[0]).toBe("d".repeat(64));
    expect(() => parseReviewSelectorRecommendation(JSON.stringify({
      schema: REVIEW_SELECTOR_RECOMMENDATION_SCHEMA,
      subject,
      policy_digest: authority.policy_digest,
      personas: [{ persona_id: "unknown-persona", rationale: "Not allowlisted." }],
    }), authority)).toThrow(/unknown persona/);
  });

  it("rejects an over-bound persona receipt before journal or validator synthesis", () => {
    const subject = "f".repeat(40);
    const plan = buildReviewFanoutPlan({ subject });
    const findings = Array.from({ length: 9 }, (_, index) => ({
      severity: "P2" as const,
      message: `Advisory ${index + 1}.`,
      path: `src/advisory-${index + 1}.ts`,
    }));

    expect(() => synthesizeReviewFanout({
      plan,
      receipts: plan.personas.map((persona) => reviewReceipt({
        persona: persona.id,
        subject,
        findings: persona.id === "correctness-dataflow" ? findings : [],
      })),
    })).toThrow(/correctness-dataflow exceeds max_findings 8/);
  });

  it("requires independent validation and cannot invent or rewrite a blocker", () => {
    const subject = "7".repeat(40);
    const plan = buildReviewFanoutPlan({ subject });
    const blocker = {
      severity: "P1" as const,
      message: "[src/unit.ts#settle|settlement-silently-passes: changed control and data flow preserves declared behavior] Settlement can silently pass.",
      path: "src/unit.ts",
    };
    const synthesis = synthesizeReviewFanout({
      plan,
      receipts: plan.personas.map((persona) => reviewReceipt({
        persona: persona.id,
        subject,
        result: persona.id === "correctness-dataflow" ? "semantic_repair_required" : "success",
        findings: persona.id === "correctness-dataflow" ? [blocker] : [],
      })),
    });

    expect(() => validateReviewFanoutBlockers({ synthesis, validator: null }))
      .toThrow(/require independent validation/);
    expect(() => validateReviewFanoutBlockers({
      synthesis,
      validator: reviewReceipt({
        persona: "review-validator",
        subject,
        result: "semantic_repair_required",
        findings: [{ ...blocker, message: `${blocker.message} rewritten` }],
      }),
    })).toThrow(/invented or changed/);
    expect(validateReviewFanoutBlockers({
      synthesis,
      validator: reviewReceipt({
        persona: "review-validator",
        subject,
        result: "semantic_repair_required",
        findings: [blocker],
      }),
    })).toMatchObject({
      synthesis: { outcome: "semantic_repair_required", findings: [blocker] },
      accepted_blocking_finding_keys: [expect.any(String)],
      rejected_blocking_finding_keys: [],
    });
  });

  it("keeps advisory findings journal-visible without promoting them to blockers", () => {
    const subject = "8".repeat(40);
    const plan = buildReviewFanoutPlan({ subject });
    const advisory = {
      severity: "P2" as const,
      message: "[src/unit.ts#settle|settlement-silently-passes: changed control and data flow preserves declared behavior] Add a regression assertion.",
      path: "src/unit.ts",
    };
    const synthesis = synthesizeReviewFanout({
      plan,
      receipts: plan.personas.map((persona) => reviewReceipt({
        persona: persona.id,
        subject,
        result: persona.id === "correctness-dataflow" ? "semantic_repair_required" : "success",
        findings: persona.id === "correctness-dataflow" ? [advisory] : [],
      })),
    });

    expect(validateReviewFanoutBlockers({ synthesis, validator: null })).toMatchObject({
      synthesis: { outcome: "success", findings: [advisory] },
      accepted_blocking_finding_keys: [],
    });
  });

  it("requires the exact prior ordered roster on a repair-cycle selection", () => {
    const subject = "9".repeat(40);
    const authority = buildReviewSelectorAuthority({
      subject,
      requiredPersonaIds: ["correctness-dataflow", "tests-contracts", "security"],
    });
    const recommendation = {
      schema: REVIEW_SELECTOR_RECOMMENDATION_SCHEMA,
      subject,
      policy_digest: authority.policy_digest,
      personas: [
        { persona_id: "correctness-dataflow", rationale: "Recheck changed control flow." },
        { persona_id: "tests-contracts", rationale: "Recheck executable proof." },
        { persona_id: "security", rationale: "Recheck the same trust boundary." },
      ],
    };

    expect(parseReviewSelectorRecommendation(JSON.stringify(recommendation), authority).personas)
      .toHaveLength(3);
    expect(() => parseReviewSelectorRecommendation(JSON.stringify({
      ...recommendation,
      personas: recommendation.personas.slice(0, 2),
    }), authority)).toThrow(/exact prior-cycle roster/);

    const initialSubject = "a".repeat(40);
    const initialAuthority = buildReviewSelectorAuthority({ subject: initialSubject });
    const initial = buildReviewFanoutPlan({
      subject: initialSubject,
      recommendation: parseReviewSelectorRecommendation(JSON.stringify({
        ...recommendation,
        subject: initialSubject,
        policy_digest: initialAuthority.policy_digest,
      }), initialAuthority),
    });
    const rereview = buildReviewFanoutPlan({
      subject,
      recommendation: parseReviewSelectorRecommendation(JSON.stringify(recommendation), authority),
      requiredPersonaIds: authority.required_persona_ids!,
    });
    expect(rereview.personas.map((persona) => persona.id)).toEqual(authority.required_persona_ids);
    expect(rereview.roster_digest).toBe(initial.roster_digest);
  });
});
