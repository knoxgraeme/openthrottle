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
  "stale_evidence",
] as const);
export type CitationGateReason = (typeof CITATION_GATE_REASONS)[number];

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

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
  const dispositionByClaimId = new Map(
    proposal.dispositions.map((disposition) => [disposition.claim_id, disposition])
  );
  const claims = proposal.claims.map((claim): CitationGradeClaim => {
    const disposition = dispositionByClaimId.get(claim.id);
    if (!disposition) throw new Error(`disposition for claim ${claim.id} is missing`);
    const citationIds = [...new Set([...claim.citation_ids, ...disposition.citation_ids])];
    const citationsReproduced = citationIds.every((citationId) => reproducedCitationIds.has(citationId));
    return {
      id: claim.id,
      result: disposition.disposition === "supported" && citationsReproduced ? "survived" : "dropped",
      citation_ids: citationIds,
    };
  });
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

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")
    ? value
    : null;
}

export function validateCitationGateDecision(value: unknown): CitationGateDecision {
  const input = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (!input || input.schema !== CITATION_GATE_SCHEMA) throw new Error("citation gate decision is invalid");
  const proposalId = typeof input.proposal_id === "string" ? input.proposal_id : "";
  const proposalHash = typeof input.proposal_hash === "string" ? input.proposal_hash : "";
  const result: CitationGateDecision["result"] | null =
    input.result === "passed" || input.result === "failed" ? input.result : null;
  const outcome: CitationGateDecision["outcome"] | null =
    input.outcome === "success" || input.outcome === "failure" ? input.outcome : null;
  const reason = typeof input.reason === "string" && CITATION_GATE_REASONS.includes(
    input.reason as (typeof CITATION_GATE_REASONS)[number]
  ) ? input.reason as CitationGateReason : null;
  const survivingClaimIds = stringArray(input.surviving_claim_ids);
  const droppedClaimIds = stringArray(input.dropped_claim_ids);
  const sourceDigests = stringArray(input.source_digests);
  const gradeHash = typeof input.grade_hash === "string" ? input.grade_hash : "";
  if (
    !IDENTIFIER.test(proposalId) ||
    !SHA256.test(proposalHash) ||
    !SHA256.test(gradeHash) ||
    !result ||
    !outcome ||
    !reason ||
    !survivingClaimIds ||
    !droppedClaimIds ||
    !sourceDigests ||
    survivingClaimIds.some((entry) => !IDENTIFIER.test(entry)) ||
    droppedClaimIds.some((entry) => !IDENTIFIER.test(entry)) ||
    sourceDigests.length === 0 ||
    sourceDigests.some((entry) => !SHA256.test(entry)) ||
    (result === "passed") !== (outcome === "success") ||
    (result === "passed" && survivingClaimIds.length === 0) ||
    (result === "failed" && (survivingClaimIds.length !== 0 || droppedClaimIds.length === 0)) ||
    (reason === "all_citations_reproduced" && (result !== "passed" || droppedClaimIds.length !== 0)) ||
    (reason === "partial_claim_survival" && (result !== "passed" || droppedClaimIds.length === 0)) ||
    ((reason === "no_claims_survived" || reason === "stale_evidence") && result !== "failed") ||
    new Set([...survivingClaimIds, ...droppedClaimIds]).size !== survivingClaimIds.length + droppedClaimIds.length ||
    canonicalJson(sourceDigests) !== canonicalJson([...new Set(sourceDigests)].sort())
  ) throw new Error("citation gate decision is invalid");

  const payloadValue = {
    schema: CITATION_GATE_SCHEMA,
    proposal_id: proposalId,
    proposal_hash: proposalHash,
    result,
    outcome,
    reason,
    surviving_claim_ids: survivingClaimIds,
    dropped_claim_ids: droppedClaimIds,
    grade_hash: gradeHash,
    source_digests: sourceDigests,
  };
  const payload = canonicalJson(payloadValue);
  if (input.payload !== payload || input.hash !== digestNormalized(payload)) {
    throw new Error("citation gate decision hash mismatch");
  }
  if (Object.keys(input).length !== 12) throw new Error("citation gate decision has unknown fields");
  return { ...payloadValue, payload, hash: input.hash as string };
}
