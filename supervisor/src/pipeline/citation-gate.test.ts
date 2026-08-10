import { describe, expect, it } from "vitest";
import {
  evaluateCitationGate,
  gradeCitationContractProposal,
} from "./citation-gate.js";
import type { CitationContractProposal } from "@openthrottle/contracts";

const run = {
  pipeline_instance_id: "instance-1",
  generation: 1,
  execution_graph_id: "structured",
  outcome: "failed" as const,
  closed_reason: "failure" as const,
  fault_attribution: "agent" as const,
  created_at: "2026-08-08T00:00:00.000Z",
};

function proposal(): CitationContractProposal {
  return {
    schema: "openthrottle.citation-contract/v1",
    id: "proposal_one",
    summary: "Grounded proposal.",
    claims: [
      { id: "claim_one", text: "First claim.", citation_ids: ["citation_one"] },
      { id: "claim_two", text: "Second claim.", citation_ids: ["citation_two"] },
    ],
    citations: [
      { id: "citation_one", query: { outcome: "failed" }, expected_result: [run], source_digests: ["a".repeat(64)] },
      { id: "citation_two", query: { outcome: "shipped" }, expected_result: [], source_digests: ["b".repeat(64)] },
    ],
    dispositions: [
      { claim_id: "claim_one", disposition: "supported", rationale: "Reproduced.", citation_ids: ["citation_one"] },
      { claim_id: "claim_two", disposition: "supported", rationale: "Expected empty.", citation_ids: ["citation_two"] },
    ],
    grades: [{ id: "overall", value: "pass", disposition_claim_ids: ["claim_one", "claim_two"], rationale: "Both survive." }],
  };
}

describe("citation gate", () => {
  it("passes when all claims survive and seals source digests into the decision payload", () => {
    const input = proposal();
    const decision = evaluateCitationGate({
      proposal: input,
      proposalHash: "c".repeat(64),
      resolvedCitations: [
        { id: "citation_one", actual_result: [run] },
        { id: "citation_two", actual_result: [] },
      ],
    });

    expect(decision).toMatchObject({
      result: "passed",
      outcome: "success",
      reason: "all_citations_reproduced",
      source_digests: ["a".repeat(64), "b".repeat(64)],
    });
    expect(JSON.parse(decision.payload)).toMatchObject({ grade_hash: decision.grade_hash });
  });

  it("allows partial claim survival but records the reason code", () => {
    const input = proposal();
    const grade = gradeCitationContractProposal(input, [
      { id: "citation_one", actual_result: [run] },
      { id: "citation_two", actual_result: [{ ...run, outcome: "shipped", closed_reason: "success" }] },
    ]);
    const decision = evaluateCitationGate({
      proposal: input,
      proposalHash: "c".repeat(64),
      resolvedCitations: [
        { id: "citation_one", actual_result: [run] },
        { id: "citation_two", actual_result: [{ ...run, outcome: "shipped", closed_reason: "success" }] },
      ],
    });

    expect(grade).toMatchObject({
      result: "pass",
      surviving_claim_ids: ["claim_one"],
      dropped_claim_ids: ["claim_two"],
    });
    expect(decision).toMatchObject({
      result: "passed",
      outcome: "success",
      reason: "partial_claim_survival",
    });
  });

  it("fails closed when stale citation evidence leaves no surviving claims", () => {
    const input = proposal();
    input.claims = [{ id: "claim_one", text: "First claim.", citation_ids: ["citation_one"] }];
    input.dispositions = [
      { claim_id: "claim_one", disposition: "supported", rationale: "Reproduced.", citation_ids: ["citation_one"] },
    ];
    input.grades = [{ id: "overall", value: "pass", disposition_claim_ids: ["claim_one"], rationale: "Survives." }];

    expect(evaluateCitationGate({
      proposal: input,
      proposalHash: "c".repeat(64),
      resolvedCitations: [{ id: "citation_one", actual_result: [] }, { id: "citation_two", actual_result: [] }],
    })).toMatchObject({
      result: "failed",
      outcome: "failure",
      reason: "stale_evidence",
    });
  });

  it.each(["contradicted", "insufficient", "not_applicable"] as const)(
    "drops a claim whose disposition is %s even when every citation reproduces",
    (disposition) => {
      const input = proposal();
      input.claims = [{ id: "claim_one", text: "First claim.", citation_ids: ["citation_one"] }];
      input.dispositions = [
        { claim_id: "claim_one", disposition, rationale: "The claim is not supported.", citation_ids: ["citation_one"] },
      ];
      input.grades = [{ id: "overall", value: "fail", disposition_claim_ids: ["claim_one"], rationale: "Dropped." }];

      expect(evaluateCitationGate({
        proposal: input,
        proposalHash: "c".repeat(64),
        resolvedCitations: [
          { id: "citation_one", actual_result: [run] },
          { id: "citation_two", actual_result: [] },
        ],
      })).toMatchObject({
        result: "failed",
        outcome: "failure",
        reason: "no_claims_survived",
        surviving_claim_ids: [],
        dropped_claim_ids: ["claim_one"],
      });
    }
  );

  it("drops a supported claim when evidence cited by its disposition does not reproduce", () => {
    const input = proposal();
    input.claims = [{ id: "claim_one", text: "First claim.", citation_ids: ["citation_one"] }];
    input.dispositions = [
      {
        claim_id: "claim_one",
        disposition: "supported",
        rationale: "Both citations are required.",
        citation_ids: ["citation_one", "citation_two"],
      },
    ];
    input.grades = [{ id: "overall", value: "pass", disposition_claim_ids: ["claim_one"], rationale: "Supported." }];

    expect(gradeCitationContractProposal(input, [
      { id: "citation_one", actual_result: [run] },
      { id: "citation_two", actual_result: [{ ...run, outcome: "shipped", closed_reason: "success" }] },
    ])).toMatchObject({
      result: "fail",
      surviving_claim_ids: [],
      dropped_claim_ids: ["claim_one"],
      claims: [{ id: "claim_one", result: "dropped", citation_ids: ["citation_one", "citation_two"] }],
    });
  });

  it("rejects incomplete resolved citation input instead of querying analysis itself", () => {
    expect(() => gradeCitationContractProposal(proposal(), [
      { id: "citation_one", actual_result: [run] },
    ])).toThrow(/resolved citation citation_two is missing/);
  });
});
