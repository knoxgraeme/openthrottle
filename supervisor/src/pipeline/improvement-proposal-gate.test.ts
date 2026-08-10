import { describe, expect, it } from "vitest";
import type { CitationContractProposal, RatchetDifferentialInput } from "@openthrottle/contracts";
import { evaluateCitationGate } from "./citation-gate.js";
import { evaluateImprovementProposalGate } from "./improvement-proposal-gate.js";

const proposalHash = "d".repeat(64);
const run = {
  pipeline_instance_id: "instance-1",
  generation: 1,
  execution_graph_id: "structured",
  outcome: "failed" as const,
  closed_reason: "failure" as const,
  fault_attribution: "agent" as const,
  created_at: "2026-08-08T00:00:00.000Z",
};

function citationProposal(): CitationContractProposal {
  return {
    schema: "openthrottle.citation-contract/v1",
    id: "proposal_one",
    summary: "Grounded proposal.",
    claims: [{ id: "claim_one", text: "First claim.", citation_ids: ["citation_one"] }],
    citations: [{
      id: "citation_one",
      query: { outcome: "failed" },
      expected_result: [run],
      source_digests: ["a".repeat(64)],
    }],
    dispositions: [{
      claim_id: "claim_one",
      disposition: "supported",
      rationale: "Reproduced.",
      citation_ids: ["citation_one"],
    }],
    grades: [{ id: "overall", value: "pass", disposition_claim_ids: ["claim_one"], rationale: "Survives." }],
  };
}

function citationGate(actualResult = [run]) {
  return evaluateCitationGate({
    proposal: citationProposal(),
    proposalHash,
    resolvedCitations: [{ id: "citation_one", actual_result: actualResult }],
  });
}

function ratchetInput(): RatchetDifferentialInput {
  return {
    schema: "openthrottle.ratchet-contract/v1",
    id: "proposal_one",
    pinned: [{
      id: "skill_package",
      kind: "standard_receipt",
      artifact_digest: "a".repeat(64),
      provenance_digest: "b".repeat(64),
    }],
    proposed: [{
      id: "skill_package",
      kind: "standard_receipt",
      artifact_digest: "a".repeat(64),
      provenance_digest: "b".repeat(64),
    }],
    human_authority: {
      actor_id: "linear-user-1",
      approval_digest: "c".repeat(64),
    },
    tuner_authority: {
      tuner_id: "structured_tuner",
      proposal_digest: proposalHash,
      model_digest: "e".repeat(64),
    },
  };
}

describe("improvement proposal gate", () => {
  it("deterministically accepts exact citation and differential inputs", () => {
    const input = { citationGate: citationGate(), ratchetInput: ratchetInput() };
    const first = evaluateImprovementProposalGate(input);
    const second = evaluateImprovementProposalGate(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      accepted: true,
      decision: { outcome: "accept", reject_reasons: [] },
      journal: { result: "passed", reasons: [] },
    });
    expect(first.journal.policy_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.journal.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns complete bounded reasons for missing or malformed inputs", () => {
    expect(evaluateImprovementProposalGate({ citationGate: null, ratchetInput: null })).toMatchObject({
      accepted: false,
      journal: {
        result: "failed",
        reasons: ["citation_gate_missing", "differential_ratchet_missing"],
      },
    });

    const forgedCitation = { ...citationGate(), proposal_hash: "f".repeat(64) };
    expect(evaluateImprovementProposalGate({
      citationGate: forgedCitation,
      ratchetInput: { ...ratchetInput(), unexpected: true },
    })).toMatchObject({
      accepted: false,
      journal: {
        reasons: ["citation_gate_invalid", "differential_ratchet_invalid"],
      },
    });
  });

  it("rejects failed citation evidence and stale proposal binding", () => {
    expect(evaluateImprovementProposalGate({
      citationGate: citationGate([]),
      ratchetInput: ratchetInput(),
    })).toMatchObject({
      accepted: false,
      journal: { reasons: ["citation_gate_failed"] },
    });

    const staleRatchet = ratchetInput();
    staleRatchet.tuner_authority!.proposal_digest = "f".repeat(64);
    expect(evaluateImprovementProposalGate({
      citationGate: citationGate(),
      ratchetInput: staleRatchet,
    })).toMatchObject({
      accepted: false,
      journal: { reasons: ["citation_proposal_mismatch"] },
    });
  });

  it("surfaces repairable differential reasons without trusting an accept claim", () => {
    const rejected = ratchetInput();
    rejected.proposed[0]!.artifact_digest = "f".repeat(64);

    expect(evaluateImprovementProposalGate({
      citationGate: citationGate(),
      ratchetInput: rejected,
    })).toMatchObject({
      accepted: false,
      decision: {
        outcome: "reject",
        reject_reasons: ["artifact_digest_changed"],
      },
      journal: {
        reasons: ["ratchet:artifact_digest_changed"],
      },
    });
  });
});
