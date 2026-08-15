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
  validateCitationGateDecision,
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

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// The full structural predicate lives in validateCitationGateDecision
// (citation-gate.ts); this wrapper converts its throwing contract into the
// null-on-invalid contract used here. The only checks kept locally are the
// stricter inbound bounds this gate has always applied to untrusted stage
// output (id length, array entry counts, entry lengths), which the shared
// validator deliberately does not impose.
function validatedCitationGate(value: unknown): CitationGateDecision | null {
  const input = recordValue(value);
  if (!input) return null;
  if (typeof input.proposal_id === "string" && input.proposal_id.length > 160) return null;
  for (const field of ["surviving_claim_ids", "dropped_claim_ids", "source_digests"]) {
    const entries = input[field];
    if (
      Array.isArray(entries) &&
      (entries.length > 128 ||
        entries.some((entry) => typeof entry === "string" && entry.length > 200))
    ) {
      return null;
    }
  }
  try {
    return validateCitationGateDecision(value);
  } catch {
    return null;
  }
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
