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
  deriveReviewSemanticGroupId,
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
    claim_discriminator: "finding-id-derivation",
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
      disposition: "accepted",
      rationale: "The independently validated finding enters repair.",
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
    semantic_group_id: deriveReviewSemanticGroupId(finding),
    exact_dedup_personas: ["contract_reviewer"],
    semantic_dedup_finding_ids: [finding.finding_id],
    validator_result: "accepted" as const,
    corroboration_count: 1,
    repair_disposition: "accepted" as const,
    convergence_cycle: 1,
    state: "unresolved" as const,
  }];
  const timingEvidence = {
    selector: {
      action_id: "review-parent:review:selector",
      dispatched_at: "2026-08-10T00:00:01.000Z",
      completed_at: "2026-08-10T00:00:01.020Z",
      dispatch_time_source: "acknowledged" as const,
      latency_ms: 20,
    },
    personas: [{
      persona_id: "contract_reviewer",
      action_id: "review-parent:review:contract_reviewer",
      dispatched_at: "2026-08-10T00:00:01.020Z",
      completed_at: "2026-08-10T00:00:01.140Z",
      dispatch_time_source: "acknowledged" as const,
      latency_ms: 120,
    }],
    validator: {
      action_id: "review-parent:review:validator",
      dispatched_at: "2026-08-10T00:00:01.140Z",
      completed_at: "2026-08-10T00:00:01.180Z",
      dispatch_time_source: "acknowledged" as const,
      latency_ms: 40,
    },
  };
  const measurements = {
    persona_count: 1,
    finding_count: 1,
    accepted_finding_count: 1,
    rejected_finding_count: 0,
    resolved_finding_count: 0,
    unresolved_finding_count: 1,
    total_latency_ms: 180,
    critical_path_latency_ms: 180,
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
    timing_evidence: timingEvidence,
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
      at: "2026-08-10T00:00:06.500Z",
      kind: "timing_evidence",
      digest: digestCanonicalJson(timingEvidence),
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
        claim_discriminator: "finding-id-derivation",
        violated_invariant: "finding identity is semantic and stable",
      })
    );
  });

  it("keeps semantic group identity stable across diagnostic prose and persona invariants", () => {
    const finding = validJournal().synthesis.findings[0]!;
    const changedDiagnostic = {
      ...finding,
      violated_invariant: "review authority is roster-bound",
      message: "The same anchored defect is described with different diagnostic prose.",
    };

    expect(deriveReviewSemanticGroupId(changedDiagnostic)).toBe(deriveReviewSemanticGroupId(finding));
  });

  it("separates distinct claims against the same stable semantic anchor", () => {
    const finding = validJournal().synthesis.findings[0]!;
    const distinctClaim = {
      ...finding,
      claim_discriminator: "persona-invariant-membership",
    };

    expect(deriveReviewSemanticGroupId(distinctClaim)).not.toBe(deriveReviewSemanticGroupId(finding));
  });

  it("keeps advisory findings out of independent validator decision metrics", () => {
    const journal = validJournal();
    journal.synthesis.findings[0]!.severity = "P2";
    const synthesisDigest = digestCanonicalJson(journal.synthesis);
    journal.validation.synthesis_digest = synthesisDigest;
    journal.repair_disposition.synthesis_digest = synthesisDigest;
    journal.repair_disposition.dispositions[0] = {
      finding_id: journal.synthesis.findings[0]!.finding_id,
      disposition: "deferred",
      rationale: "Advisory findings do not enter independent blocker validation.",
    };
    journal.finding_resolutions[0] = {
      ...journal.finding_resolutions[0]!,
      repair_disposition: "deferred",
      state: "unresolved",
    };
    journal.measurements = {
      ...journal.measurements,
      accepted_finding_count: 0,
      rejected_finding_count: 0,
      resolved_finding_count: 0,
      unresolved_finding_count: 1,
    };
    journal.entries = journal.entries.map((entry) => ({
      ...entry,
      digest: digestCanonicalJson(
        entry.kind === "selection" ? journal.selection
          : entry.kind === "persona_receipts" ? journal.persona_receipts
            : entry.kind === "synthesis" ? journal.synthesis
              : entry.kind === "validation" ? journal.validation
                : entry.kind === "repair_disposition" ? journal.repair_disposition
                  : entry.kind === "finding_resolutions" ? journal.finding_resolutions
                    : entry.kind === "timing_evidence" ? journal.timing_evidence
                    : journal.measurements
      ),
    }));

    expect(() => validateReviewJournalContract(journal, { source: "review" }))
      .toThrow(/validator_result: must be not_validated for repair disposition deferred/);

    journal.finding_resolutions[0]!.validator_result = "not_validated";
    journal.timing_evidence.validator = null;
    journal.measurements.total_latency_ms = 140;
    journal.measurements.critical_path_latency_ms = 140;
    journal.entries.find((entry) => entry.kind === "finding_resolutions")!.digest =
      digestCanonicalJson(journal.finding_resolutions);
    journal.entries.find((entry) => entry.kind === "timing_evidence")!.digest =
      digestCanonicalJson(journal.timing_evidence);
    journal.entries.find((entry) => entry.kind === "measurements")!.digest =
      digestCanonicalJson(journal.measurements);
    expect(() => validateReviewJournalContract(journal, { source: "review" })).not.toThrow();
  });

  it("rejects unknown fields that could escalate authority", () => {
    const journal = validJournal() as ReviewJournalContract & { roster: ReviewJournalContract["roster"] & { credentials: string[] } };
    journal.roster.credentials = ["repo.write"];

    expect(() => validateReviewJournalContract(journal, { source: "review" }))
      .toThrow(/review\.roster\.credentials: unknown field/);
  });

  it("accepts explicitly labeled conservative timing after a lost launch acknowledgement", () => {
    const journal = validJournal();
    journal.timing_evidence.selector.dispatch_time_source = "prepared_fallback";
    journal.entries.find((entry) => entry.kind === "timing_evidence")!.digest =
      digestCanonicalJson(journal.timing_evidence);

    expect(() => validateReviewJournalContract(journal, { source: "review" })).not.toThrow();
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
      claim_discriminator: "finding-id-derivation",
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
      claim_discriminator: "finding-id-derivation",
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

  it("rejects generic semantic anchors that would over-group unrelated defects", () => {
    const journal = validJournal();
    const identity = {
      path: "contracts/src/review.ts",
      semantic_anchor: "module",
      claim_discriminator: "finding-id-derivation",
      violated_invariant: "finding identity is semantic and stable",
    };
    journal.synthesis.findings[0] = {
      ...journal.synthesis.findings[0]!,
      ...identity,
      finding_id: deriveReviewFindingId(identity),
    };

    expect(() => validateReviewJournalContract(journal, { source: "review" }))
      .toThrow(/semantic_anchor: must name a sufficiently specific stable symbol/);
  });

  it("rejects generic claim discriminators that cannot distinguish same-symbol defects", () => {
    const journal = validJournal();
    const identity = {
      path: "contracts/src/review.ts",
      semantic_anchor: "parseFinding validates finding_id",
      claim_discriminator: "validation",
      violated_invariant: "finding identity is semantic and stable",
    };
    journal.synthesis.findings[0] = {
      ...journal.synthesis.findings[0]!,
      ...identity,
      finding_id: deriveReviewFindingId(identity),
    };

    expect(() => validateReviewJournalContract(journal, { source: "review" }))
      .toThrow(/claim_discriminator: must be a stable lowercase kebab-case defect claim/);
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
    const wrongSemanticGroup = validJournal();
    wrongSemanticGroup.finding_resolutions[0]!.semantic_group_id = "semantic_group_" + "0".repeat(32);
    expect(() => validateReviewJournalContract(wrongSemanticGroup, { source: "review" }))
      .toThrow(/semantic_group_id: must be derived from the canonical finding semantics/);

    const unknownMembership = validJournal();
    unknownMembership.finding_resolutions[0]!.semantic_dedup_finding_ids = ["finding_" + "1".repeat(32)];
    expect(() => validateReviewJournalContract(unknownMembership, { source: "review" }))
      .toThrow(/semantic_dedup_finding_ids: must include its canonical finding_id/);

    const badCorroboration = validJournal();
    badCorroboration.finding_resolutions[0]!.corroboration_count = 2;
    expect(() => validateReviewJournalContract(badCorroboration, { source: "review" }))
      .toThrow(/corroboration_count: does not match exact_dedup_personas length/);

    const duplicateTimingAction = validJournal();
    duplicateTimingAction.timing_evidence.personas[0]!.action_id =
      duplicateTimingAction.timing_evidence.selector.action_id;
    expect(() => validateReviewJournalContract(duplicateTimingAction, { source: "review" }))
      .toThrow(/timing_evidence\.action_id: must not contain duplicates/);

    const wrongPersonaTimingAction = validJournal();
    wrongPersonaTimingAction.timing_evidence.personas[0]!.action_id =
      "review-parent:review:other-persona";
    expect(() => validateReviewJournalContract(wrongPersonaTimingAction, { source: "review" }))
      .toThrow(/timing_evidence\.personas\.contract_reviewer\.action_id/);

    const earlyValidator = validJournal();
    earlyValidator.timing_evidence.validator!.dispatched_at = "2026-08-10T00:00:01.100Z";
    earlyValidator.timing_evidence.validator!.completed_at = "2026-08-10T00:00:01.140Z";
    expect(() => validateReviewJournalContract(earlyValidator, { source: "review" }))
      .toThrow(/timing_evidence\.validator\.dispatched_at: must not precede persona completion/);

    const wrongMeasurements = validJournal();
    wrongMeasurements.measurements.total_latency_ms = 119;
    expect(() => validateReviewJournalContract(wrongMeasurements, { source: "review" }))
      .toThrow(/review\.measurements: does not match persona and finding evidence/);
  });

  it("represents a prior finding fixed by exact-roster absence without false current corroboration", () => {
    const journal = validJournal();
    journal.persona_receipts[0]!.finding_ids = [];
    journal.persona_receipts[0]!.finding_count = 0;
    journal.repair_disposition.dispositions[0]!.disposition = "fixed";
    journal.finding_resolutions[0]!.validator_result = "not_validated";
    journal.finding_resolutions[0]!.repair_disposition = "fixed";
    journal.finding_resolutions[0]!.state = "resolved";
    journal.finding_resolutions[0]!.exact_dedup_personas = [];
    journal.finding_resolutions[0]!.corroboration_count = 0;
    journal.measurements.accepted_finding_count = 0;
    journal.measurements.total_latency_ms = 140;
    journal.measurements.critical_path_latency_ms = 140;
    journal.measurements.resolved_finding_count = 1;
    journal.measurements.unresolved_finding_count = 0;
    journal.timing_evidence.validator = null;
    journal.entries[1]!.digest = digestCanonicalJson(journal.persona_receipts);
    journal.entries[4]!.digest = digestCanonicalJson(journal.repair_disposition);
    journal.entries[5]!.digest = digestCanonicalJson(journal.finding_resolutions);
    journal.entries[6]!.digest = digestCanonicalJson(journal.timing_evidence);
    journal.entries[7]!.digest = digestCanonicalJson(journal.measurements);

    expect(() => validateReviewJournalContract(journal, { source: "review" })).not.toThrow();

    journal.finding_resolutions[0]!.state = "unresolved";
    journal.entries[5]!.digest = digestCanonicalJson(journal.finding_resolutions);
    expect(() => validateReviewJournalContract(journal, { source: "review" }))
      .toThrow(/exact_dedup_personas: may be empty only for a fixed or superseded resolved finding/);
  });
});
