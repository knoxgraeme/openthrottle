import {
  canonicalJson,
  decideDifferentialRatchet,
  digestNormalized,
  RATCHET_CONTRACT_MAX_BYTES,
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
export const IMPROVEMENT_PROPOSAL_BINDING_SCHEMA = "openthrottle.improvement-proposal-binding/v1" as const;

export const IMPROVEMENT_PROPOSAL_GATE_REASONS = Object.freeze([
  "citation_gate_missing",
  "citation_gate_invalid",
  "citation_gate_failed",
  "citation_receipt_missing",
  "citation_receipt_invalid",
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

export interface ImprovementProposalCitationReceipt {
  id: string;
  proposal_id: string;
  proposal_hash: string;
  gate_result: "passed" | "failed";
  outcome: CitationGateDecision["outcome"];
  reason: CitationGateDecision["reason"];
  grade_hash: string;
  payload: string;
  receipt_hash: string;
  created_at: string;
}

export interface ImprovementProposalJournal {
  schema: typeof IMPROVEMENT_PROPOSAL_JOURNAL_SCHEMA;
  result: "passed" | "failed";
  reasons: ImprovementProposalGateReason[];
  policy_digest: string;
  citation_gate: CitationGateDecision | null;
  citation_receipt: ImprovementProposalCitationReceipt | null;
  differential_ratchet: ImprovementProposalRatchetJournal | null;
  proposal_binding_digest: string | null;
  hash: string;
}

export interface ImprovementProposalGateEvaluation {
  accepted: boolean;
  decision: RatchetDecision | null;
  journal: ImprovementProposalJournal;
}

/**
 * Trusted, immutable OPE-113 receipt source. The mutation producer supplies
 * proposal data, never this capability; the OPE-115 application path wires it
 * to CitationGateStore.
 */
export interface CitationGateReceiptLookup {
  getCitationGateReceipt(proposalHash: string): unknown;
}

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

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
    sourceDigests.length === 0 ||
    (result === "passed") !== (outcome === "success") ||
    (result === "passed" && survivingClaimIds.length === 0) ||
    (result === "failed" && (survivingClaimIds.length !== 0 || droppedClaimIds.length === 0)) ||
    (reason === "all_citations_reproduced" && (result !== "passed" || droppedClaimIds.length !== 0)) ||
    (reason === "partial_claim_survival" && (result !== "passed" || droppedClaimIds.length === 0)) ||
    ((reason === "no_claims_survived" || reason === "stale_evidence") && result !== "failed") ||
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

function validatedCitationReceipt(
  value: unknown,
  decision: CitationGateDecision | null
): ImprovementProposalCitationReceipt | null {
  const input = recordValue(value);
  if (!input || !decision || Object.keys(input).length !== 10) return null;
  const expectedId = `citation-gate-${digestNormalized(
    canonicalJson([decision.proposal_hash, decision.hash])
  ).slice(0, 32)}`;
  if (
    input.id !== expectedId ||
    input.proposal_id !== decision.proposal_id ||
    input.proposal_hash !== decision.proposal_hash ||
    input.gate_result !== decision.result ||
    input.outcome !== decision.outcome ||
    input.reason !== decision.reason ||
    input.grade_hash !== decision.grade_hash ||
    input.payload !== decision.payload ||
    input.receipt_hash !== decision.hash ||
    typeof input.created_at !== "string" ||
    !RFC3339.test(input.created_at) ||
    Number.isNaN(Date.parse(input.created_at))
  ) return null;
  return {
    id: input.id,
    proposal_id: decision.proposal_id,
    proposal_hash: decision.proposal_hash,
    gate_result: decision.result,
    outcome: decision.outcome,
    reason: decision.reason,
    grade_hash: decision.grade_hash,
    payload: decision.payload,
    receipt_hash: decision.hash,
    created_at: input.created_at,
  };
}

function validatedRatchetInput(value: unknown): RatchetDifferentialInput | null {
  try {
    if (Buffer.byteLength(canonicalJson(value), "utf8") > RATCHET_CONTRACT_MAX_BYTES) return null;
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
}, ports: {
  citationReceipts: CitationGateReceiptLookup;
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
  let rawCitationReceipt: unknown;
  if (citationGate) {
    try {
      rawCitationReceipt = ports.citationReceipts.getCitationGateReceipt(citationGate.proposal_hash);
    } catch {
      rawCitationReceipt = undefined;
    }
  }
  const citationReceipt = rawCitationReceipt === null || rawCitationReceipt === undefined
    ? null
    : validatedCitationReceipt(rawCitationReceipt, citationGate);
  if (rawCitationReceipt === null || rawCitationReceipt === undefined) {
    reasons.push("citation_receipt_missing");
  } else if (!citationReceipt) {
    reasons.push("citation_receipt_invalid");
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
    ratchetInput &&
    (
      citationGate.proposal_id !== ratchetInput.id ||
      !ratchetInput.tuner_authority ||
      citationGate.proposal_hash !== ratchetInput.tuner_authority.proposal_digest
    )
  ) reasons.push("citation_proposal_mismatch");

  const differentialRatchet = ratchetInput && decision
    ? { input: ratchetInput, decision }
    : null;
  const proposalBindingDigest = citationGate && citationReceipt && decision
    ? digestNormalized(canonicalJson({
      schema: IMPROVEMENT_PROPOSAL_BINDING_SCHEMA,
      citation_decision_hash: citationGate.hash,
      citation_receipt_id: citationReceipt.id,
      citation_receipt_hash: citationReceipt.receipt_hash,
      ratchet_input_digest: decision.input_digest,
    }))
    : null;
  const policy = {
    schema: IMPROVEMENT_PROPOSAL_POLICY_SCHEMA,
    citation_gate: citationGate,
    citation_receipt: citationReceipt,
    differential_ratchet: differentialRatchet,
    proposal_binding_digest: proposalBindingDigest,
  };
  const policyDigest = digestNormalized(canonicalJson(policy));
  const journalWithoutHash = {
    schema: IMPROVEMENT_PROPOSAL_JOURNAL_SCHEMA,
    result: reasons.length === 0 ? "passed" as const : "failed" as const,
    reasons,
    policy_digest: policyDigest,
    citation_gate: citationGate,
    citation_receipt: citationReceipt,
    differential_ratchet: differentialRatchet,
    proposal_binding_digest: proposalBindingDigest,
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
