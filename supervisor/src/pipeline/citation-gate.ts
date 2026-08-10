import {
  canonicalJson,
  digestNormalized,
  parseCitationContractProposal,
  type AnalysisRunResult,
  type CitationContractProposal,
} from "@openthrottle/contracts";
import type { StageOutcome } from "./manifest.js";

export const CITATION_GRADE_SCHEMA = "openthrottle.citation-grade/v1" as const;
export const CITATION_GATE_SCHEMA = "openthrottle.citation-gate/v1" as const;

export const CITATION_GATE_REASONS = Object.freeze([
  "all_citations_reproduced",
  "partial_claim_survival",
  "no_claims_survived",
  "proposal_tampered",
  "stale_evidence",
] as const);
export type CitationGateReason = (typeof CITATION_GATE_REASONS)[number];

export interface CitationGradeCitation {
  id: string;
  result: "reproduced" | "mismatch";
  expected_result: AnalysisRunResult[];
  actual_result: AnalysisRunResult[];
}

export interface CitationGradeClaim {
  id: string;
  result: "survived" | "dropped";
  citation_ids: string[];
}

export interface CitationGrade {
  schema: typeof CITATION_GRADE_SCHEMA;
  proposal_id: string;
  result: "pass" | "fail";
  surviving_claim_ids: string[];
  dropped_claim_ids: string[];
  citations: CitationGradeCitation[];
  claims: CitationGradeClaim[];
}

export interface CitationGateDecision {
  schema: typeof CITATION_GATE_SCHEMA;
  proposal_id: string;
  proposal_hash: string;
  result: "passed" | "failed";
  outcome: StageOutcome;
  reason: CitationGateReason;
  surviving_claim_ids: string[];
  dropped_claim_ids: string[];
  grade_hash: string;
  source_digests: string[];
  payload: string;
  hash: string;
}

export interface ResolvedCitation {
  id: string;
  actual_result: AnalysisRunResult[];
}

function sameResult(left: readonly AnalysisRunResult[], right: readonly AnalysisRunResult[]): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function gradeCitationContractProposal(
  proposal: CitationContractProposal,
  resolvedCitations: readonly ResolvedCitation[]
): CitationGrade {
  const actualById = new Map(resolvedCitations.map((citation) => [citation.id, citation.actual_result]));
  const citations = proposal.citations.map((citation): CitationGradeCitation => {
    const actual = actualById.get(citation.id);
    if (!actual) throw new Error(`resolved citation ${citation.id} is missing`);
    return {
      id: citation.id,
      result: sameResult(actual, citation.expected_result) ? "reproduced" : "mismatch",
      expected_result: citation.expected_result,
      actual_result: actual,
    };
  });

  const reproducedCitationIds = new Set(
    citations.filter((citation) => citation.result === "reproduced").map((citation) => citation.id)
  );
  const claims = proposal.claims.map((claim): CitationGradeClaim => ({
    id: claim.id,
    result: claim.citation_ids.every((citationId) => reproducedCitationIds.has(citationId)) ? "survived" : "dropped",
    citation_ids: claim.citation_ids,
  }));
  const survivingClaimIds = claims.filter((claim) => claim.result === "survived").map((claim) => claim.id);
  const droppedClaimIds = claims.filter((claim) => claim.result === "dropped").map((claim) => claim.id);

  return {
    schema: CITATION_GRADE_SCHEMA,
    proposal_id: proposal.id,
    result: survivingClaimIds.length > 0 ? "pass" : "fail",
    surviving_claim_ids: survivingClaimIds,
    dropped_claim_ids: droppedClaimIds,
    citations,
    claims,
  };
}

function gateReasonForGrade(grade: CitationGrade): CitationGateReason {
  const hasMismatch = grade.citations.some((citation) => citation.result === "mismatch");
  if (grade.surviving_claim_ids.length === 0) return hasMismatch ? "stale_evidence" : "no_claims_survived";
  if (grade.dropped_claim_ids.length > 0) return "partial_claim_survival";
  return "all_citations_reproduced";
}

function sealCitationGate(input: {
  proposal: CitationContractProposal;
  proposalHash: string;
  grade: CitationGrade;
}): CitationGateDecision {
  const grade = input.grade;
  const gradePayload = canonicalJson(grade);
  const gradeHash = digestNormalized(gradePayload);
  const reason = gateReasonForGrade(grade);
  const sourceDigests = [...new Set(input.proposal.citations.flatMap((citation) => citation.source_digests))].sort();
  const result = grade.result === "pass" ? "passed" : "failed";
  const outcome = grade.result === "pass" ? "success" : "failure";
  const payload = canonicalJson({
    schema: CITATION_GATE_SCHEMA,
    proposal_id: input.proposal.id,
    proposal_hash: input.proposalHash,
    result,
    outcome,
    reason,
    surviving_claim_ids: grade.surviving_claim_ids,
    dropped_claim_ids: grade.dropped_claim_ids,
    grade_hash: gradeHash,
    source_digests: sourceDigests,
  });
  return {
    schema: CITATION_GATE_SCHEMA,
    proposal_id: input.proposal.id,
    proposal_hash: input.proposalHash,
    result,
    outcome,
    reason,
    surviving_claim_ids: grade.surviving_claim_ids,
    dropped_claim_ids: grade.dropped_claim_ids,
    grade_hash: gradeHash,
    source_digests: sourceDigests,
    payload,
    hash: digestNormalized(payload),
  };
}

function evaluateCitationGateWithGrade(input: {
  proposal: CitationContractProposal;
  proposalHash: string;
  resolvedCitations: readonly ResolvedCitation[];
}): { grade: CitationGrade; decision: CitationGateDecision } {
  const grade = gradeCitationContractProposal(input.proposal, input.resolvedCitations);
  return { grade, decision: sealCitationGate({ proposal: input.proposal, proposalHash: input.proposalHash, grade }) };
}

export function evaluateCitationGate(input: {
  proposal: CitationContractProposal;
  proposalHash: string;
  resolvedCitations: readonly ResolvedCitation[];
}): CitationGateDecision {
  return evaluateCitationGateWithGrade(input).decision;
}

export function evaluateRawCitationGate(input: {
  raw: unknown;
  resolvedCitations: readonly ResolvedCitation[];
}): { proposal: CitationContractProposal; proposalHash: string; grade: CitationGrade; decision: CitationGateDecision } {
  const proposalContract = parseCitationContractProposal(JSON.stringify(input.raw), { source: "citation_contract" });
  const proposal = proposalContract.value;
  const evaluated = evaluateCitationGateWithGrade({
    proposal,
    proposalHash: proposalContract.digest,
    resolvedCitations: input.resolvedCitations,
  });
  return {
    proposal,
    proposalHash: proposalContract.digest,
    grade: evaluated.grade,
    decision: evaluated.decision,
  };
}
