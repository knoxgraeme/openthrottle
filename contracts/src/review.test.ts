import { describe, expect, it } from "vitest";
import { digestCanonicalJson } from "./canonical.js";
import {
  REVIEW_FINDING_SCHEMA,
  REVIEW_JOURNAL_SCHEMA,
  REVIEW_POLICY_SCHEMA,
  REVIEW_REPAIR_DISPOSITION_SCHEMA,
  REVIEW_ROSTER_SCHEMA,
  REVIEW_SELECTION_SCHEMA,
  REVIEW_SYNTHESIS_SCHEMA,
  REVIEW_VALIDATION_SCHEMA,
  deriveReviewFindingId,
  validateReviewJournalContract,
  type ReviewFindingContract,
  type ReviewJournalContract,
  type ReviewRepairDispositionContract,
  type ReviewSynthesisContract,
} from "./review.js";

function validJournal(): ReviewJournalContract {
  const policy = {
    schema: REVIEW_POLICY_SCHEMA,
    policy_id: "deterministic_review",
    personas: [{
      persona_id: "contract_reviewer",
      title: "Contract reviewer",
      focus: "Closed review contracts.",
      invariants: ["finding identity is semantic and stable", "review authority is roster-bound"],
      max_findings: 4,
    }, {
      persona_id: "security_reviewer",
      title: "Security reviewer",
      focus: "Authority and provenance.",
      invariants: ["review authority is roster-bound"],
      max_findings: 2,
    }],
    max_personas_per_selection: 2,
    max_findings_per_journal: 8,
  };
  const roster = {
    schema: REVIEW_ROSTER_SCHEMA,
    roster_id: "sealed_review_roster",
    policy_digest: digestCanonicalJson(policy),
    personas: policy.personas.map((persona) => ({ ...persona })),
    sealed_at: "2026-08-10T00:00:00.000Z",
  };
  const selection = {
    schema: REVIEW_SELECTION_SCHEMA,
    selection_id: "selection_one",
    roster_digest: digestCanonicalJson(roster),
    personas: [{ persona_id: "contract_reviewer", rationale: "The unit edits review contracts." }],
  };
  const identity = {
    path: "contracts/src/review.ts",
    semantic_anchor: "parseFinding validates finding_id",
    violated_invariant: "finding identity is semantic and stable",
  };
  const finding: ReviewFindingContract = {
    schema: REVIEW_FINDING_SCHEMA,
    finding_id: deriveReviewFindingId(identity),
    persona_id: "contract_reviewer",
    severity: "P1",
    ...identity,
    message: "A finding ID must be derived from stable review semantics.",
    evidence: ["The finding contains no line number or cycle ordinal."],
  };
  const synthesis: ReviewSynthesisContract = {
    schema: REVIEW_SYNTHESIS_SCHEMA,
    selection_id: selection.selection_id,
    roster_digest: selection.roster_digest,
    outcome: "semantic_repair_required",
    summary: "One bounded finding.",
    findings: [finding],
  };
  const validation = {
    schema: REVIEW_VALIDATION_SCHEMA,
    synthesis_digest: digestCanonicalJson(synthesis),
    valid: true,
    errors: [],
  };
  const repairDisposition: ReviewRepairDispositionContract = {
    schema: REVIEW_REPAIR_DISPOSITION_SCHEMA,
    synthesis_digest: digestCanonicalJson(synthesis),
    dispositions: [{
      finding_id: finding.finding_id,
      disposition: "fixed",
      rationale: "The semantic identity rule is now enforced.",
    }],
  };
  const personaReceipts = [{
    persona_id: "contract_reviewer",
    receipt_digest: "d".repeat(64),
    subject: "b".repeat(40),
    finding_ids: [finding.finding_id],
    finding_count: 1,
    latency_ms: 120,
    cost_microusd: 450,
  }];
  const findingResolutions = [{
    finding_id: finding.finding_id,
    exact_dedup_personas: ["contract_reviewer"],
    semantic_dedup_finding_ids: [finding.finding_id],
    validator_result: "accepted" as const,
    corroboration_count: 1,
    repair_disposition: "fixed" as const,
    convergence_cycle: 1,
    state: "resolved" as const,
  }];
  const measurements = {
    persona_count: 1,
    finding_count: 1,
    accepted_finding_count: 1,
    rejected_finding_count: 0,
    resolved_finding_count: 1,
    unresolved_finding_count: 0,
    total_latency_ms: 120,
    critical_path_latency_ms: 120,
    total_cost_microusd: 450,
  };
  return {
    schema: REVIEW_JOURNAL_SCHEMA,
    subject: {
      base: "a".repeat(40),
      pre: "b".repeat(40),
      post: "c".repeat(40),
    },
    policy,
    roster,
    selection,
    persona_receipts: personaReceipts,
    synthesis,
    validation,
    repair_disposition: repairDisposition,
    finding_resolutions: findingResolutions,
    measurements,
    entries: [{
      at: "2026-08-10T00:00:01.000Z",
      kind: "selection",
      digest: digestCanonicalJson(selection),
    }, {
      at: "2026-08-10T00:00:02.000Z",
      kind: "persona_receipts",
      digest: digestCanonicalJson(personaReceipts),
    }, {
      at: "2026-08-10T00:00:03.000Z",
      kind: "synthesis",
      digest: digestCanonicalJson(synthesis),
    }, {
      at: "2026-08-10T00:00:04.000Z",
      kind: "validation",
      digest: digestCanonicalJson(validation),
    }, {
      at: "2026-08-10T00:00:05.000Z",
      kind: "repair_disposition",
      digest: digestCanonicalJson(repairDisposition),
    }, {
      at: "2026-08-10T00:00:06.000Z",
      kind: "finding_resolutions",
      digest: digestCanonicalJson(findingResolutions),
    }, {
      at: "2026-08-10T00:00:07.000Z",
      kind: "measurements",
      digest: digestCanonicalJson(measurements),
    }],
  };
}

describe("review journal contracts", () => {
  it("accepts a bounded canonical review journal with a sealed roster and semantic finding identity", () => {
    const validated = validateReviewJournalContract(validJournal(), { source: "review" });

    expect(JSON.parse(validated.normalized)).toEqual(validated.value);
    expect(validated.value.synthesis.findings[0]!.finding_id).toBe(
      deriveReviewFindingId({
        path: "contracts/src/review.ts",
        semantic_anchor: "parseFinding validates finding_id",
        violated_invariant: "finding identity is semantic and stable",
      })
    );
  });

  it("rejects unknown fields that could escalate authority", () => {
    const journal = validJournal() as ReviewJournalContract & { roster: ReviewJournalContract["roster"] & { credentials: string[] } };
    journal.roster.credentials = ["repo.write"];

    expect(() => validateReviewJournalContract(journal, { source: "review" }))
      .toThrow(/review\.roster\.credentials: unknown field/);
  });

  it("rejects mutable roster and synthesis digest drift", () => {
    const personaDrift = validJournal();
    personaDrift.roster.personas[0] = { ...personaDrift.roster.personas[0]!, max_findings: 5 };
    expect(() => validateReviewJournalContract(personaDrift, { source: "review" }))
      .toThrow(/review\.roster\.personas\.contract_reviewer: must match the policy persona snapshot/);

    const rosterDrift = validJournal();
    rosterDrift.roster.sealed_at = "2026-08-10T00:00:05.000Z";
    expect(() => validateReviewJournalContract(rosterDrift, { source: "review" }))
      .toThrow(/review\.selection\.roster_digest: does not match sealed roster digest/);

    const synthesisDrift = validJournal();
    synthesisDrift.synthesis.summary = "Changed after validation.";
    expect(() => validateReviewJournalContract(synthesisDrift, { source: "review" }))
      .toThrow(/review\.validation\.synthesis_digest: does not match synthesis digest/);
  });

  it("rejects unknown personas and invariants outside the sealed roster", () => {
    const unknownPersona = validJournal();
    unknownPersona.selection.personas[0] = { persona_id: "unsealed_reviewer", rationale: "Not on the roster." };
    expect(() => validateReviewJournalContract(unknownPersona, { source: "review" }))
      .toThrow(/review\.selection\.personas\.unsealed_reviewer: references an unknown roster persona/);

    const unknownInvariant = validJournal();
    unknownInvariant.synthesis.findings[0] = {
      ...unknownInvariant.synthesis.findings[0]!,
      violated_invariant: "line number is stable",
      finding_id: deriveReviewFindingId({
        path: "contracts/src/review.ts",
        semantic_anchor: "parseFinding validates finding_id",
        violated_invariant: "line number is stable",
      }),
    };
    expect(() => validateReviewJournalContract(unknownInvariant, { source: "review" }))
      .toThrow(/violated_invariant: is not declared by the persona/);
  });

  it("rejects finding IDs not derived from path, stable semantic anchor, and violated invariant", () => {
    const journal = validJournal();
    journal.synthesis.findings[0] = {
      ...journal.synthesis.findings[0]!,
      finding_id: "finding_" + "0".repeat(32),
    };

    expect(() => validateReviewJournalContract(journal, { source: "review" }))
      .toThrow(/review\.synthesis\.findings\[0\]\.finding_id: must be derived/);
  });

  it("rejects paths that smuggle line numbers into identity", () => {
    const journal = validJournal();
    const identity = {
      path: "contracts/src/review.ts:120",
      semantic_anchor: "parseFinding validates finding_id",
      violated_invariant: "finding identity is semantic and stable",
    };
    journal.synthesis.findings[0] = {
      ...journal.synthesis.findings[0]!,
      ...identity,
      finding_id: deriveReviewFindingId(identity),
    };

    expect(() => validateReviewJournalContract(journal, { source: "review" }))
      .toThrow(/review\.synthesis\.findings\[0\]\.path: must not encode line numbers/);
  });

  it("rejects persona receipt attribution, subject, latency, cost, and finding-count drift", () => {
    const wrongCount = validJournal();
    wrongCount.persona_receipts[0]!.finding_count = 0;
    expect(() => validateReviewJournalContract(wrongCount, { source: "review" }))
      .toThrow(/review\.persona_receipts\.contract_reviewer\.finding_count: does not match finding_ids length/);

    const wrongSubject = validJournal();
    wrongSubject.persona_receipts[0]!.subject = "e".repeat(40);
    expect(() => validateReviewJournalContract(wrongSubject, { source: "review" }))
      .toThrow(/review\.persona_receipts\.contract_reviewer\.subject: does not match the reviewed subject/);

    const invalidLatency = validJournal();
    invalidLatency.persona_receipts[0]!.latency_ms = -1;
    expect(() => validateReviewJournalContract(invalidLatency, { source: "review" }))
      .toThrow(/review\.persona_receipts\[0\]\.latency_ms: must be an integer between 0/);

    const invalidCost = validJournal();
    invalidCost.persona_receipts[0]!.cost_microusd = -1;
    expect(() => validateReviewJournalContract(invalidCost, { source: "review" }))
      .toThrow(/review\.persona_receipts\[0\]\.cost_microusd: must be an integer between 0/);
  });

  it("rejects untraceable resolution membership and aggregate measurement drift", () => {
    const unknownMembership = validJournal();
    unknownMembership.finding_resolutions[0]!.semantic_dedup_finding_ids = ["finding_" + "1".repeat(32)];
    expect(() => validateReviewJournalContract(unknownMembership, { source: "review" }))
      .toThrow(/semantic_dedup_finding_ids: must include its canonical finding_id/);

    const badCorroboration = validJournal();
    badCorroboration.finding_resolutions[0]!.corroboration_count = 2;
    expect(() => validateReviewJournalContract(badCorroboration, { source: "review" }))
      .toThrow(/corroboration_count: does not match exact_dedup_personas length/);

    const wrongMeasurements = validJournal();
    wrongMeasurements.measurements.total_latency_ms = 119;
    expect(() => validateReviewJournalContract(wrongMeasurements, { source: "review" }))
      .toThrow(/review\.measurements: does not match persona and finding evidence/);
  });
});
