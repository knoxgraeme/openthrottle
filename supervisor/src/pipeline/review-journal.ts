import {
  REVIEW_JOURNAL_SCHEMA,
  REVIEW_REPAIR_DISPOSITION_SCHEMA,
  REVIEW_ROSTER_SCHEMA,
  REVIEW_SELECTION_SCHEMA,
  REVIEW_SYNTHESIS_SCHEMA,
  REVIEW_VALIDATION_SCHEMA,
  deriveReviewSemanticGroupId,
  digestCanonicalJson,
  validateReviewJournalContract,
  type ReviewFindingContract,
  type ReviewJournalContract,
  type ReviewPersonaReceiptEvidence,
  type ReviewSelectionContract,
  type ReviewSubactionTimingEvidence,
  type ReviewSynthesisContract,
  type ReviewValidationContract,
  type SemanticReviewReceipt,
  type SealedReviewRosterContract,
} from "@openthrottle/contracts";
import {
  compareReviewFindingRepresentatives,
  contractReviewFinding,
  reviewFindingKey,
  reviewPolicyContract,
  type ReviewFanoutPlan,
  type ReviewPersonaId,
  type ValidatedReviewFanout,
} from "./review-fanout.js";

function journalOutcome(outcome: ValidatedReviewFanout["synthesis"]["outcome"]): ReviewSynthesisContract["outcome"] {
  if (outcome === "success" || outcome === "semantic_repair_required" || outcome === "failure" || outcome === "needs_human") {
    return outcome;
  }
  return "failure";
}

export function buildReviewJournal(input: {
  plan: ReviewFanoutPlan;
  baseSubject: string;
  receipts: ReadonlyArray<{
    receipt: SemanticReviewReceipt;
    actionId: string;
    dispatchedAt: string;
    dispatchTimeSource: "acknowledged" | "prepared_fallback";
    completedAt: string;
  }>;
  selectorTiming: {
    actionId: string;
    dispatchedAt: string;
    dispatchTimeSource: "acknowledged" | "prepared_fallback";
    completedAt: string;
  };
  validatorTiming: {
    actionId: string;
    dispatchedAt: string;
    dispatchTimeSource: "acknowledged" | "prepared_fallback";
    completedAt: string;
  } | null;
  validation: ValidatedReviewFanout;
  cycle: number;
  actionCreatedAt: string;
  recordedAt: string;
  previousJournal?: ReviewJournalContract;
}): ReviewJournalContract {
  const timingSample = (input: {
    actionId: string;
    dispatchedAt: string;
    dispatchTimeSource: "acknowledged" | "prepared_fallback";
    completedAt: string;
  }): ReviewSubactionTimingEvidence => {
    const dispatchedAt = Date.parse(input.dispatchedAt);
    const completedAt = Date.parse(input.completedAt);
    if (!Number.isFinite(dispatchedAt) || !Number.isFinite(completedAt) || completedAt < dispatchedAt) {
      throw new Error(`review timing for ${input.actionId} is invalid`);
    }
    return {
      action_id: input.actionId,
      dispatched_at: input.dispatchedAt,
      completed_at: input.completedAt,
      dispatch_time_source: input.dispatchTimeSource,
      latency_ms: completedAt - dispatchedAt,
    };
  };
  const policy = reviewPolicyContract();
  if (digestCanonicalJson(policy) !== input.plan.policy_digest) {
    throw new Error("review journal policy does not match the sealed fanout plan");
  }
  const selectedPolicy = new Map(policy.personas.map((persona) => [persona.persona_id, persona]));
  const roster: SealedReviewRosterContract = {
    schema: REVIEW_ROSTER_SCHEMA,
    roster_id: input.plan.roster_id,
    policy_digest: input.plan.policy_digest,
    personas: input.plan.personas.map((persona) => ({ ...selectedPolicy.get(persona.id)! })),
    sealed_at: input.actionCreatedAt,
  };
  const selection: ReviewSelectionContract = {
    schema: REVIEW_SELECTION_SCHEMA,
    selection_id: input.plan.selection_id,
    roster_digest: digestCanonicalJson(roster),
    personas: input.plan.personas.map((persona) => ({
      persona_id: persona.id,
      rationale: `${persona.reason}: ${persona.rationale}`,
    })),
  };
  const planPersonas = new Map(input.plan.personas.map((persona) => [persona.id, persona]));
  const findingsByPersona = new Map<string, ReviewFindingContract[]>();
  const personaTimings = new Map<string, ReviewSubactionTimingEvidence & { persona_id: ReviewPersonaId }>();
  const personaReceipts: ReviewPersonaReceiptEvidence[] = input.receipts.map(({
    receipt, actionId, dispatchedAt, dispatchTimeSource, completedAt,
  }) => {
    const personaId = receipt.producer.worker_id as ReviewPersonaId;
    const persona = planPersonas.get(personaId);
    if (!persona) throw new Error(`review journal received unknown persona ${personaId}`);
    if (actionId !== receipt.fence.action_attempt_id) {
      throw new Error(`review timing action ${actionId} does not match ${personaId} receipt fence`);
    }
    const findings = receipt.payload.findings.map((finding) => contractReviewFinding({
      finding,
      personaId,
      evidence: receipt.evidence,
      invariant: persona.invariant,
    }));
    findingsByPersona.set(personaId, findings);
    const timing = timingSample({ actionId, dispatchedAt, dispatchTimeSource, completedAt });
    personaTimings.set(personaId, { persona_id: personaId, ...timing });
    return {
      persona_id: personaId,
      receipt_digest: digestCanonicalJson(receipt),
      subject: input.plan.subject,
      finding_ids: findings.map((finding) => finding.finding_id),
      finding_count: findings.length,
      latency_ms: timing.latency_ms,
      cost_microusd: null,
    };
  });
  const semanticGroups = new Map<string, {
    canonical: ReviewFindingContract;
    memberIds: Set<string>;
    fixedByAbsence: boolean;
  }>();
  const currentGroupByFindingId = new Map<string, string>();
  for (const persona of input.plan.personas) {
    for (const finding of findingsByPersona.get(persona.id) ?? []) {
      const semanticGroupId = deriveReviewSemanticGroupId(finding);
      const existingGroupId = currentGroupByFindingId.get(finding.finding_id);
      if (existingGroupId && existingGroupId !== semanticGroupId) {
        throw new Error(`current review finding ${finding.finding_id} split across semantic groups`);
      }
      currentGroupByFindingId.set(finding.finding_id, semanticGroupId);
      const group = semanticGroups.get(semanticGroupId);
      if (!group) {
        semanticGroups.set(semanticGroupId, {
          canonical: finding,
          memberIds: new Set([finding.finding_id]),
          fixedByAbsence: false,
        });
        continue;
      }
      group.memberIds.add(finding.finding_id);
      if (compareReviewFindingRepresentatives(finding, group.canonical) < 0) group.canonical = finding;
    }
  }
  if (input.previousJournal) {
    const previousFindings = new Map(
      input.previousJournal.synthesis.findings.map((finding) => [finding.finding_id, finding])
    );
    for (const resolution of input.previousJournal.finding_resolutions) {
      if (resolution.state !== "unresolved") continue;
      const finding = previousFindings.get(resolution.finding_id);
      if (!finding) throw new Error(`previous review journal lost unresolved finding ${resolution.finding_id}`);
      const matchedGroupIds = new Set<string>();
      if (semanticGroups.has(resolution.semantic_group_id)) matchedGroupIds.add(resolution.semantic_group_id);
      for (const findingId of [resolution.finding_id, ...resolution.semantic_dedup_finding_ids]) {
        const semanticGroupId = currentGroupByFindingId.get(findingId);
        if (semanticGroupId) matchedGroupIds.add(semanticGroupId);
      }
      if (matchedGroupIds.size > 1) {
        throw new Error(`previous semantic finding group ${resolution.semantic_group_id} split across current groups`);
      }
      const currentGroupId = [...matchedGroupIds][0];
      const currentGroup = currentGroupId ? semanticGroups.get(currentGroupId) : undefined;
      if (currentGroup) {
        for (const findingId of resolution.semantic_dedup_finding_ids) currentGroup.memberIds.add(findingId);
        continue;
      }
      semanticGroups.set(resolution.semantic_group_id, {
        canonical: finding,
        memberIds: new Set(resolution.semantic_dedup_finding_ids),
        fixedByAbsence: true,
      });
    }
  }
  const carriedResolvedGroupCount = [...semanticGroups.values()].filter((group) => group.fixedByAbsence).length;
  const synthesis: ReviewSynthesisContract = {
    schema: REVIEW_SYNTHESIS_SCHEMA,
    selection_id: selection.selection_id,
    roster_digest: selection.roster_digest,
    outcome: journalOutcome(input.validation.synthesis.outcome),
    summary: carriedResolvedGroupCount > 0
      ? `${input.validation.synthesis.summary} ${carriedResolvedGroupCount} prior semantic finding group(s) are absent on exact-roster rereview.`
      : input.validation.synthesis.summary,
    findings: [...semanticGroups.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, group]) => group.canonical),
  };
  const validation: ReviewValidationContract = {
    schema: REVIEW_VALIDATION_SCHEMA,
    synthesis_digest: digestCanonicalJson(synthesis),
    valid: true,
    errors: [],
  };
  const acceptedBlocking = new Set(input.validation.accepted_blocking_finding_keys);
  const rejectedBlocking = new Set(input.validation.rejected_blocking_finding_keys);
  const repairDisposition = {
    schema: REVIEW_REPAIR_DISPOSITION_SCHEMA,
    synthesis_digest: digestCanonicalJson(synthesis),
    dispositions: [...semanticGroups.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, group]) => {
        const representativeKey = reviewFindingKey(group.canonical);
        const representativeIsBlocking = group.canonical.severity === "P0" || group.canonical.severity === "P1";
        const representativeAccepted = acceptedBlocking.has(representativeKey);
        const representativeRejected = rejectedBlocking.has(representativeKey);
        if (!group.fixedByAbsence && representativeIsBlocking && representativeAccepted === representativeRejected) {
          throw new Error(`blocking review representative ${group.canonical.finding_id} needs exactly one validator disposition`);
        }
        const disposition = group.fixedByAbsence ? "fixed" as const
          : representativeAccepted ? "accepted" as const
            : representativeRejected ? "rejected" as const
              : "deferred" as const;
        return {
          finding_id: group.canonical.finding_id,
          disposition,
          rationale: disposition === "fixed"
            ? "The finding is absent on an exact-roster rereview of the repaired subject."
            : disposition === "rejected"
            ? "Independent blocker validation rejected this finding."
            : disposition === "accepted"
              ? "Independent blocker validation accepted this finding for consolidated repair."
              : "Advisory findings are journaled without entering the blocking repair set.",
        };
      }),
  };
  const findingResolutions = [...semanticGroups.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([semanticGroupId, group]) => {
      const semanticMemberIds = [...group.memberIds].sort();
      const semanticMembers = new Set(semanticMemberIds);
      const reporters = personaReceipts
        .filter((receipt) => receipt.finding_ids.some((findingId) => semanticMembers.has(findingId)))
        .map((receipt) => receipt.persona_id);
      const disposition = repairDisposition.dispositions.find((entry) => entry.finding_id === group.canonical.finding_id)!;
      const rejected = disposition.disposition === "rejected";
      const fixed = disposition.disposition === "fixed";
      const validatorResult = disposition.disposition === "accepted"
        ? "accepted" as const
        : disposition.disposition === "rejected"
          ? "rejected" as const
          : "not_validated" as const;
      return {
        finding_id: group.canonical.finding_id,
        semantic_group_id: semanticGroupId,
        exact_dedup_personas: reporters,
        semantic_dedup_finding_ids: semanticMemberIds,
        validator_result: validatorResult,
        corroboration_count: reporters.length,
        repair_disposition: disposition.disposition,
        convergence_cycle: input.cycle,
        state: rejected || fixed ? "resolved" as const : "unresolved" as const,
      };
    });
  const timingEvidence = {
    selector: timingSample(input.selectorTiming),
    personas: input.plan.personas.map((persona) => {
      const timing = personaTimings.get(persona.id);
      if (!timing) throw new Error(`review timing is missing persona ${persona.id}`);
      return timing;
    }),
    validator: input.validatorTiming ? timingSample(input.validatorTiming) : null,
  };
  const timingSamples = [
    timingEvidence.selector,
    ...timingEvidence.personas,
    ...(timingEvidence.validator ? [timingEvidence.validator] : []),
  ];
  const measurements = {
    persona_count: personaReceipts.length,
    finding_count: synthesis.findings.length,
    accepted_finding_count: findingResolutions.filter((entry) => entry.validator_result === "accepted").length,
    rejected_finding_count: findingResolutions.filter((entry) => entry.validator_result === "rejected").length,
    resolved_finding_count: findingResolutions.filter((entry) => entry.state === "resolved").length,
    unresolved_finding_count: findingResolutions.filter((entry) => entry.state === "unresolved").length,
    total_latency_ms: timingSamples.reduce((total, timing) => total + timing.latency_ms, 0),
    critical_path_latency_ms: Math.max(
      0,
      Math.max(...timingSamples.map((timing) => Date.parse(timing.completed_at))) -
        Date.parse(timingEvidence.selector.dispatched_at)
    ),
    total_cost_microusd: null,
  };
  const journal: ReviewJournalContract = {
    schema: REVIEW_JOURNAL_SCHEMA,
    subject: { base: input.baseSubject, pre: input.plan.subject, post: input.plan.subject },
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
    entries: [
      { at: input.recordedAt, kind: "selection", digest: digestCanonicalJson(selection) },
      { at: input.recordedAt, kind: "persona_receipts", digest: digestCanonicalJson(personaReceipts) },
      { at: input.recordedAt, kind: "synthesis", digest: digestCanonicalJson(synthesis) },
      { at: input.recordedAt, kind: "validation", digest: digestCanonicalJson(validation) },
      { at: input.recordedAt, kind: "repair_disposition", digest: digestCanonicalJson(repairDisposition) },
      { at: input.recordedAt, kind: "finding_resolutions", digest: digestCanonicalJson(findingResolutions) },
      { at: input.recordedAt, kind: "timing_evidence", digest: digestCanonicalJson(timingEvidence) },
      { at: input.recordedAt, kind: "measurements", digest: digestCanonicalJson(measurements) },
    ],
  };
  return validateReviewJournalContract(journal, { source: "review_journal" }).value;
}
