import {
  canonicalJson,
  decideDifferentialRatchet,
  digestNormalized,
  validateRatchetDifferentialInput,
  type RatchetDecision,
  type RatchetDifferentialInput,
} from "@openthrottle/contracts";
import {
  CITATION_GATE_REASONS,
  CITATION_GATE_SCHEMA,
  type CitationGateDecision,
} from "./citation-gate.js";

export const IMPROVEMENT_PROPOSAL_POLICY_SCHEMA = "openthrottle.improvement-proposal-policy/v1" as const;
export const IMPROVEMENT_PROPOSAL_JOURNAL_SCHEMA = "openthrottle.improvement-proposal-journal/v1" as const;

export const IMPROVEMENT_PROPOSAL_GATE_REASONS = Object.freeze([
  "citation_gate_missing",
  "citation_gate_invalid",
  "citation_gate_failed",
  "citation_proposal_mismatch",
  "differential_ratchet_missing",
  "differential_ratchet_invalid",
] as const);

type BaseImprovementProposalGateReason = (typeof IMPROVEMENT_PROPOSAL_GATE_REASONS)[number];
export type ImprovementProposalGateReason =
  | BaseImprovementProposalGateReason
  | `ratchet:${RatchetDecision["reject_reasons"][number]}`;

export interface ImprovementProposalRatchetJournal {
  input: RatchetDifferentialInput;
  decision: RatchetDecision;
}

export interface ImprovementProposalJournal {
  schema: typeof IMPROVEMENT_PROPOSAL_JOURNAL_SCHEMA;
  result: "passed" | "failed";
  reasons: ImprovementProposalGateReason[];
  policy_digest: string;
  citation_gate: CitationGateDecision | null;
  differential_ratchet: ImprovementProposalRatchetJournal | null;
  hash: string;
}

export interface ImprovementProposalGateEvaluation {
  accepted: boolean;
  decision: RatchetDecision | null;
  journal: ImprovementProposalJournal;
}

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_RATCHET_INPUT_BYTES = 256 * 1024;

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedStringArray(value: unknown, options: {
  max: number;
  pattern?: RegExp;
}): string[] | null {
  if (!Array.isArray(value) || value.length > options.max) return null;
  const result: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > 200 ||
      (options.pattern && !options.pattern.test(entry))
    ) return null;
    result.push(entry);
  }
  return result;
}

function validatedCitationGate(value: unknown): CitationGateDecision | null {
  const input = recordValue(value);
  if (!input || input.schema !== CITATION_GATE_SCHEMA) return null;
  const proposalId = typeof input.proposal_id === "string" &&
    input.proposal_id.length <= 160 &&
    IDENTIFIER.test(input.proposal_id)
    ? input.proposal_id
    : null;
  const proposalHash = typeof input.proposal_hash === "string" && SHA256.test(input.proposal_hash)
    ? input.proposal_hash
    : null;
  const gradeHash = typeof input.grade_hash === "string" && SHA256.test(input.grade_hash)
    ? input.grade_hash
    : null;
  const result = input.result === "passed" || input.result === "failed" ? input.result : null;
  const outcome = input.outcome === "success" || input.outcome === "failure" ? input.outcome : null;
  const reason = typeof input.reason === "string" && CITATION_GATE_REASONS.includes(
    input.reason as (typeof CITATION_GATE_REASONS)[number]
  ) ? input.reason as (typeof CITATION_GATE_REASONS)[number] : null;
  const survivingClaimIds = boundedStringArray(input.surviving_claim_ids, { max: 128, pattern: IDENTIFIER });
  const droppedClaimIds = boundedStringArray(input.dropped_claim_ids, { max: 128, pattern: IDENTIFIER });
  const sourceDigests = boundedStringArray(input.source_digests, { max: 128, pattern: SHA256 });
  if (
    !proposalId ||
    !proposalHash ||
    !gradeHash ||
    !result ||
    !outcome ||
    !reason ||
    !survivingClaimIds ||
    !droppedClaimIds ||
    !sourceDigests ||
    (result === "passed") !== (outcome === "success") ||
    new Set([...survivingClaimIds, ...droppedClaimIds]).size !== survivingClaimIds.length + droppedClaimIds.length ||
    canonicalJson(sourceDigests) !== canonicalJson([...new Set(sourceDigests)].sort())
  ) return null;

  const payloadValue: Omit<CitationGateDecision, "payload" | "hash"> = {
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
  if (
    input.payload !== payload ||
    typeof input.hash !== "string" ||
    input.hash !== digestNormalized(payload)
  ) return null;
  if (Object.keys(input).length !== 12) return null;

  return {
    ...payloadValue,
    payload,
    hash: input.hash,
  };
}

function validatedRatchetInput(value: unknown): RatchetDifferentialInput | null {
  try {
    if (Buffer.byteLength(canonicalJson(value), "utf8") > MAX_RATCHET_INPUT_BYTES) return null;
    return validateRatchetDifferentialInput(value, { source: "improvement_proposal.ratchet" }).value;
  } catch {
    return null;
  }
}

/**
 * Composes an OPE-113 citation decision with the OPE-114 differential policy.
 * This is the provider-neutral authorization boundary OPE-115 must call before
 * it creates or mutates a proposal worktree. Ordinary code-integration gates do
 * not call it because ordinary candidates are not self-improvement proposals.
 */
export function evaluateImprovementProposalGate(input: {
  citationGate: unknown;
  ratchetInput: unknown;
}): ImprovementProposalGateEvaluation {
  const reasons: ImprovementProposalGateReason[] = [];
  const citationGate = input.citationGate === null || input.citationGate === undefined
    ? null
    : validatedCitationGate(input.citationGate);
  if (input.citationGate === null || input.citationGate === undefined) {
    reasons.push("citation_gate_missing");
  } else if (!citationGate) {
    reasons.push("citation_gate_invalid");
  } else if (citationGate.result !== "passed" || citationGate.outcome !== "success") {
    reasons.push("citation_gate_failed");
  }

  const ratchetInput = input.ratchetInput === null || input.ratchetInput === undefined
    ? null
    : validatedRatchetInput(input.ratchetInput);
  let decision: RatchetDecision | null = null;
  if (input.ratchetInput === null || input.ratchetInput === undefined) {
    reasons.push("differential_ratchet_missing");
  } else if (!ratchetInput) {
    reasons.push("differential_ratchet_invalid");
  } else {
    decision = decideDifferentialRatchet(ratchetInput);
    reasons.push(...decision.reject_reasons.map((reason) => `ratchet:${reason}` as const));
  }

  if (
    citationGate &&
    ratchetInput?.tuner_authority &&
    citationGate.proposal_hash !== ratchetInput.tuner_authority.proposal_digest
  ) reasons.push("citation_proposal_mismatch");

  const differentialRatchet = ratchetInput && decision
    ? { input: ratchetInput, decision }
    : null;
  const policy = {
    schema: IMPROVEMENT_PROPOSAL_POLICY_SCHEMA,
    citation_gate: citationGate,
    differential_ratchet: differentialRatchet,
  };
  const policyDigest = digestNormalized(canonicalJson(policy));
  const journalWithoutHash = {
    schema: IMPROVEMENT_PROPOSAL_JOURNAL_SCHEMA,
    result: reasons.length === 0 ? "passed" as const : "failed" as const,
    reasons,
    policy_digest: policyDigest,
    citation_gate: citationGate,
    differential_ratchet: differentialRatchet,
  };
  const journal: ImprovementProposalJournal = {
    ...journalWithoutHash,
    hash: digestNormalized(canonicalJson(journalWithoutHash)),
  };
  return {
    accepted: reasons.length === 0,
    decision,
    journal,
  };
}
