import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  digestNormalized,
  type CitationContractProposal,
  type RatchetDifferentialInput,
} from "@openthrottle/contracts";
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

function citationReceipt(decision = citationGate()) {
  return {
    id: `citation-gate-${digestNormalized(canonicalJson([
      decision.proposal_hash,
      decision.hash,
    ])).slice(0, 32)}`,
    proposal_id: decision.proposal_id,
    proposal_hash: decision.proposal_hash,
    gate_result: decision.result,
    outcome: decision.outcome,
    reason: decision.reason,
    grade_hash: decision.grade_hash,
    payload: decision.payload,
    receipt_hash: decision.hash,
    created_at: "2026-08-08T00:00:00.000Z",
  };
}

function proposalGateInput(actualResult = [run]) {
  const decision = citationGate(actualResult);
  return {
    input: {
      citationGate: decision,
      ratchetInput: ratchetInput(),
    },
    ports: receiptPorts(citationReceipt(decision)),
  };
}

function receiptPorts(receipt: ReturnType<typeof citationReceipt> | undefined) {
  return {
    citationReceipts: {
      getCitationGateReceipt: () => receipt,
    },
  };
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
    const { input, ports } = proposalGateInput();
    const first = evaluateImprovementProposalGate(input, ports);
    const second = evaluateImprovementProposalGate(input, ports);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      accepted: true,
      decision: { outcome: "accept", reject_reasons: [] },
      journal: { result: "passed", reasons: [] },
    });
    expect(first.journal.policy_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.journal.proposal_binding_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.journal.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts a bounded skill ratchet with duplicated exact file material", () => {
    const skillPath = ".openthrottle/skills/review/SKILL.md";
    const referencePath = ".openthrottle/skills/review/references/craft.md";
    const skill = "---\nname: review\ndescription: Review changes.\n---\n\n# Review\n";
    const pinnedReference = "a".repeat(64 * 1024);
    const proposedReference = pinnedReference;
    const ratchet = ratchetInput();
    const repositoryConfig = {
      schema: "openthrottle.config/v1" as const,
      default_graph: "simple",
      graphs: [{ id: "simple", kind: "builtin" as const, ref: "core/simple@1" }],
      skills: [{ id: "review", path: ".openthrottle/skills/review", tunable: true }],
    };
    ratchet.pinned_config = repositoryConfig;
    ratchet.proposed_config = structuredClone(repositoryConfig);
    ratchet.pinned_repository_skills = [{
      id: "review",
      tunable: true,
      files: [
        { path: skillPath, content: skill },
        { path: referencePath, content: pinnedReference },
      ],
    }];
    ratchet.proposed_repository_skills = [{
      id: "review",
      tunable: true,
      files: [
        { path: skillPath, content: skill },
        { path: referencePath, content: proposedReference },
      ],
    }];
    ratchet.pinned_files = [
      { path: skillPath, content: skill },
      { path: referencePath, content: pinnedReference },
    ];
    ratchet.proposed_files = [
      { path: skillPath, content: skill },
      { path: referencePath, content: proposedReference },
    ];
    expect(Buffer.byteLength(canonicalJson(ratchet), "utf8")).toBeGreaterThan(256 * 1024);

    const decision = citationGate();
    const evaluation = evaluateImprovementProposalGate({
      citationGate: decision,
      ratchetInput: ratchet,
    }, receiptPorts(citationReceipt(decision)));
    expect(evaluation.decision?.differences).toEqual([]);
    expect(evaluation).toMatchObject({
      accepted: true,
      decision: { outcome: "accept", reject_reasons: [] },
      journal: { result: "passed", reasons: [] },
    });
  });

  it("returns complete bounded reasons for missing or malformed inputs", () => {
    expect(evaluateImprovementProposalGate({
      citationGate: null,
      ratchetInput: null,
    }, receiptPorts(undefined))).toMatchObject({
      accepted: false,
      journal: {
        result: "failed",
        reasons: [
          "citation_gate_missing",
          "citation_receipt_missing",
          "differential_ratchet_missing",
        ],
      },
    });

    const forgedCitation = { ...citationGate(), proposal_hash: "f".repeat(64) };
    expect(evaluateImprovementProposalGate({
      citationGate: forgedCitation,
      ratchetInput: { ...ratchetInput(), unexpected: true },
    }, receiptPorts(citationReceipt()))).toMatchObject({
      accepted: false,
      journal: {
        reasons: [
          "citation_gate_invalid",
          "citation_receipt_missing",
          "differential_ratchet_invalid",
        ],
      },
    });
  });

  it("requires a producer receipt and rejects self-sealed empty citation evidence", () => {
    const decision = citationGate();
    expect(evaluateImprovementProposalGate({
      citationGate: decision,
      ratchetInput: ratchetInput(),
    }, receiptPorts(undefined))).toMatchObject({
      accepted: false,
      journal: { reasons: ["citation_receipt_missing"] },
    });
    expect(evaluateImprovementProposalGate({
      citationGate: decision,
      ratchetInput: ratchetInput(),
    }, receiptPorts({ ...citationReceipt(decision), receipt_hash: "f".repeat(64) }))).toMatchObject({
      accepted: false,
      journal: { reasons: ["citation_receipt_invalid"] },
    });

    const fabricatedWithoutHash = {
      ...decision,
      result: "passed",
      outcome: "success",
      reason: "all_citations_reproduced",
      surviving_claim_ids: [],
      dropped_claim_ids: [],
      source_digests: [],
    };
    const { payload: _payload, hash: _hash, ...fabricatedPayloadValue } = fabricatedWithoutHash;
    const payload = canonicalJson(fabricatedPayloadValue);
    const fabricated = { ...fabricatedPayloadValue, payload, hash: digestNormalized(payload) };
    expect(evaluateImprovementProposalGate({
      citationGate: fabricated,
      ratchetInput: ratchetInput(),
    }, receiptPorts(citationReceipt()))).toMatchObject({
      accepted: false,
      journal: { reasons: ["citation_gate_invalid", "citation_receipt_missing"] },
    });
  });

  it("rejects failed citation evidence and stale proposal binding", () => {
    const failed = proposalGateInput([]);
    expect(evaluateImprovementProposalGate(failed.input, failed.ports)).toMatchObject({
      accepted: false,
      journal: { reasons: ["citation_gate_failed"] },
    });

    const staleRatchet = ratchetInput();
    staleRatchet.tuner_authority!.proposal_digest = "f".repeat(64);
    const exactCitation = citationGate();
    expect(evaluateImprovementProposalGate({
      citationGate: exactCitation,
      ratchetInput: staleRatchet,
    }, receiptPorts(citationReceipt(exactCitation)))).toMatchObject({
      accepted: false,
      journal: { reasons: ["citation_proposal_mismatch"] },
    });

    const unrelated = ratchetInput();
    unrelated.id = "unrelated_proposal";
    expect(evaluateImprovementProposalGate({
      citationGate: exactCitation,
      ratchetInput: unrelated,
    }, receiptPorts(citationReceipt(exactCitation)))).toMatchObject({
      accepted: false,
      journal: { reasons: ["citation_proposal_mismatch"] },
    });
  });

  it("surfaces repairable differential reasons without trusting an accept claim", () => {
    const rejected = ratchetInput();
    rejected.proposed[0]!.artifact_digest = "f".repeat(64);

    const exactCitation = citationGate();
    expect(evaluateImprovementProposalGate({
      citationGate: exactCitation,
      ratchetInput: rejected,
    }, receiptPorts(citationReceipt(exactCitation)))).toMatchObject({
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
