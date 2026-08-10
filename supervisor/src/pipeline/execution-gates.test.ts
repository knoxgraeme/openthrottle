import { describe, expect, it } from "vitest";
import {
  decideDifferentialRatchet,
  type RatchetDifferentialInput,
} from "@openthrottle/contracts";
import {
  evaluateFinalReviewGate,
  evaluateIntegrationGate,
  evaluateUnitAcceptanceGate,
  type IntegrationRatchetEvidence,
  type StandardReceiptFence,
} from "./execution-gates.js";
import { canonicalJson, digestNormalized } from "./manifest.js";

const expected: StandardReceiptFence = {
  pipelineInstanceId: "instance-1",
  graphDigest: "a".repeat(64),
  unitId: "unit-1",
  attemptId: "attempt-1",
  parentRunId: "run-1",
  actionAttemptId: "action-1",
  generation: 1,
  nativeSessionId: "session-1",
  requestHash: "b".repeat(64),
  baseSubject: "0".repeat(40),
  preSubject: "0".repeat(40),
  subject: "1".repeat(40),
  producers: {
    completion: {
      workerId: "worker-1",
      skill: "builtin://unit_completion@1",
      capabilityDigest: "c".repeat(64),
      skillPackageDigest: null,
      assurance: "semantic_attested",
    },
    candidate: {
      workerId: "worker-1",
      skill: "builtin://candidate_evidence@1",
      capabilityDigest: "c".repeat(64),
      skillPackageDigest: null,
      assurance: "executor_verified",
    },
    command: {
      workerId: "worker-1",
      skill: "builtin://command_result@1",
      capabilityDigest: "c".repeat(64),
      skillPackageDigest: null,
      assurance: "executor_verified",
    },
    lead: {
      workerId: "worker-1",
      skill: "builtin://unit_decision@1",
      capabilityDigest: "c".repeat(64),
      skillPackageDigest: null,
      assurance: "semantic_attested",
    },
    integration: {
      workerId: "worker-1",
      skill: "builtin://integration_evidence@1",
      capabilityDigest: "c".repeat(64),
      skillPackageDigest: null,
      assurance: "executor_verified",
    },
    review: {
      workerId: "worker-1",
      skill: "builtin://semantic_review@1",
      capabilityDigest: "c".repeat(64),
      skillPackageDigest: null,
      assurance: "semantic_attested",
    },
  },
};

function ratchetInput(): RatchetDifferentialInput {
  return {
    schema: "openthrottle.ratchet-contract/v1",
    id: "ope_114_differential_ratchet",
    pinned: [{
      id: "unit_receipt",
      kind: "standard_receipt",
      artifact_digest: "a".repeat(64),
      provenance_digest: "b".repeat(64),
    }],
    proposed: [{
      id: "unit_receipt",
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
      proposal_digest: "d".repeat(64),
      model_digest: "e".repeat(64),
    },
  };
}

function acceptedRatchet(input: RatchetDifferentialInput = ratchetInput()): IntegrationRatchetEvidence {
  return {
    citationGate: {
      hash: "2".repeat(64),
      proposalHash: "3".repeat(64),
      gradeHash: "4".repeat(64),
      result: "passed",
      outcome: "success",
      reason: "all_citations_reproduced",
      sourceDigests: ["5".repeat(64)],
    },
    differentialRatchet: {
      input,
      decision: decideDifferentialRatchet(input),
    },
  };
}

function receipt(type: string, result: string, overrides: Record<string, unknown> = {}) {
  return {
    schema: "openthrottle.receipt/v1",
    type,
    assurance: type === "command_result" || type.endsWith("_evidence") ? "executor_verified" : "semantic_attested",
    result,
    producer: {
      worker_id: "worker-1",
      skill: `builtin://${type}@1`,
      capability_digest: "c".repeat(64),
      skill_package_digest: null,
    },
    subject: {
      base: "0".repeat(40),
      pre: "0".repeat(40),
      post: expected.subject,
    },
    fence: {
      pipeline_instance_id: expected.pipelineInstanceId,
      graph_digest: expected.graphDigest,
      unit_id: expected.unitId,
      attempt_id: expected.attemptId,
      parent_run_id: expected.parentRunId,
      action_attempt_id: expected.actionAttemptId,
      generation: expected.generation,
      native_session_id: expected.nativeSessionId,
      request_hash: expected.requestHash,
    },
    evidence: ["evidence"],
    payload: {},
    issued_at: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

// Mirrors execution-gates.ts's own receiptHash so tests can bind a lead or
// review receipt's evidence to the exact prior receipts it attests to.
function hashOf(value: unknown): string {
  return digestNormalized(canonicalJson(value));
}

const command = (
  result: "success" | "failure" | "not_configured",
  exitCode: number,
  name = "test",
  overrides: Record<string, unknown> = {}
) => receipt("command_result", result, {
  payload: { command: name, exit_code: exitCode, summary: "command done" },
  ...overrides,
});

describe("structured execution gates", () => {
  it("accepts a unit only from worker success, executor candidate evidence, commands, and a lead scope decision", () => {
    const completion = receipt("unit_completion", "success");
    const candidate = receipt("candidate_evidence", "success");
    const commands = [command("success", 0), command("success", 0, "lint")];
    expect(evaluateUnitAcceptanceGate({
      expected,
      completion: completion as never,
      candidate: candidate as never,
      commands: commands as never,
      expectedCommandNames: ["test", "lint"],
      lead: receipt("unit_decision", "accept", {
        payload: {
          rationale: "Matches assigned scope.",
          context_updates: [],
          accepted_subject: expected.subject,
        },
        evidence: [hashOf(completion), hashOf(candidate), ...commands.map(hashOf)],
      }) as never,
    })).toMatchObject({
      outcome: "success",
      result: "passed",
      reason: "lead_scope_match_accept",
    });
  });

  it("fails unit acceptance when a declared plan command receipt was not executed", () => {
    const completion = receipt("unit_completion", "success");
    const candidate = receipt("candidate_evidence", "success");
    expect(evaluateUnitAcceptanceGate({
      expected,
      completion: completion as never,
      candidate: candidate as never,
      commands: [],
      expectedCommandNames: ["docs-check"],
      lead: receipt("unit_decision", "accept", {
        payload: {
          rationale: "Matches assigned scope.",
          context_updates: [],
          accepted_subject: expected.subject,
        },
        evidence: [hashOf(completion), hashOf(candidate)],
      }) as never,
    })).toMatchObject({
      outcome: "failure",
      result: "failed",
      reason: "command_receipts_missing_or_unexpected",
    });
  });

  it("fails unit acceptance when a declared plan command is reported not configured", () => {
    const completion = receipt("unit_completion", "success");
    const candidate = receipt("candidate_evidence", "success");
    const docsCheck = command("not_configured", 0, "docs-check");
    expect(evaluateUnitAcceptanceGate({
      expected,
      completion: completion as never,
      candidate: candidate as never,
      commands: [docsCheck] as never,
      expectedCommandNames: ["docs-check"],
      lead: receipt("unit_decision", "accept", {
        payload: {
          rationale: "Matches assigned scope.",
          context_updates: [],
          accepted_subject: expected.subject,
        },
        evidence: [hashOf(completion), hashOf(candidate), hashOf(docsCheck)],
      }) as never,
    })).toMatchObject({
      outcome: "failure",
      result: "failed",
      reason: "required_command_not_configured",
    });
  });

  it("fails command gates from receipt result before interpreting payload exit code", () => {
    const completion = receipt("unit_completion", "success");
    const candidate = receipt("candidate_evidence", "success");
    const failedCommand = command("failure", 0, "test");
    expect(evaluateUnitAcceptanceGate({
      expected,
      completion: completion as never,
      candidate: candidate as never,
      commands: [failedCommand] as never,
      expectedCommandNames: ["test"],
      lead: receipt("unit_decision", "accept", {
        payload: {
          rationale: "Matches assigned scope.",
          context_updates: [],
          accepted_subject: expected.subject,
        },
        evidence: [hashOf(completion), hashOf(candidate), hashOf(failedCommand)],
      }) as never,
    })).toMatchObject({
      outcome: "failure",
      result: "failed",
      reason: "command_receipt_failed",
    });
  });

  it("rejects per-unit acceptance produced by code review", () => {
    expect(() => evaluateUnitAcceptanceGate({
      expected,
      completion: receipt("unit_completion", "success") as never,
      candidate: receipt("candidate_evidence", "success") as never,
      commands: [],
      expectedCommandNames: [],
      lead: receipt("unit_decision", "accept", {
        producer: {
          worker_id: "lead-1",
          skill: "builtin://ce-code-review@1",
          capability_digest: "c".repeat(64),
        },
        payload: {
          rationale: "Reviewed code.",
          context_updates: [],
          accepted_subject: expected.subject,
        },
      }) as never,
    })).toThrow(/must not be produced by ce-code-review/);
  });

  it("maps lead revision and command failure to repair-required/failure deterministically", () => {
    const revisionCompletion = receipt("unit_completion", "success");
    const revisionCandidate = receipt("candidate_evidence", "success");
    expect(evaluateUnitAcceptanceGate({
      expected,
      completion: revisionCompletion as never,
      candidate: revisionCandidate as never,
      commands: [],
      expectedCommandNames: [],
      lead: receipt("unit_decision", "revise", {
        payload: { rationale: "Missing scoped behavior.", revision_request: "Add the required case.", context_updates: [] },
        evidence: [hashOf(revisionCompletion), hashOf(revisionCandidate)],
      }) as never,
    })).toMatchObject({ outcome: "semantic_repair_required", reason: "lead_requested_revision" });

    const failingCompletion = receipt("unit_completion", "success");
    const failingCandidate = receipt("candidate_evidence", "success");
    const failingCommand = command("failure", 1);
    expect(evaluateUnitAcceptanceGate({
      expected,
      completion: failingCompletion as never,
      candidate: failingCandidate as never,
      commands: [failingCommand] as never,
      expectedCommandNames: ["test"],
      lead: receipt("unit_decision", "accept", {
        payload: { rationale: "Matches.", context_updates: [], accepted_subject: expected.subject },
        evidence: [hashOf(failingCompletion), hashOf(failingCandidate), hashOf(failingCommand)],
      }) as never,
    })).toMatchObject({ outcome: "failure", reason: "command_exit_nonzero" });
  });

  it("accepts exact integration evidence and rejects stale final review subjects", () => {
    expect(evaluateIntegrationGate({
      expected,
      integration: receipt("integration_evidence", "success") as never,
      ratchet: acceptedRatchet(),
    })).toMatchObject({ outcome: "success", reason: "executor_integrated_candidate" });

    expect(() => evaluateFinalReviewGate({
      expected,
      commands: [command("success", 0) as never],
      expectedCommandNames: ["test"],
      review: receipt("semantic_review", "success", {
        subject: { base: "0".repeat(40), pre: "0".repeat(40), post: "2".repeat(40) },
        payload: { summary: "clean", findings: [] },
      }) as never,
    })).toThrow(/review receipt subject mismatch/);
  });

  it("runs whole-change commands before accepting the final semantic review", () => {
    const successCommand = command("success", 0);
    expect(evaluateFinalReviewGate({
      expected,
      commands: [successCommand] as never,
      expectedCommandNames: ["test"],
      review: receipt("semantic_review", "success", {
        payload: { summary: "clean", findings: [] },
        evidence: [hashOf(successCommand)],
      }) as never,
    })).toMatchObject({ outcome: "success", reason: "typed_semantic_result" });

    const failingCommand = command("failure", 1);
    expect(evaluateFinalReviewGate({
      expected,
      commands: [failingCommand] as never,
      expectedCommandNames: ["test"],
      review: receipt("semantic_review", "success", {
        payload: { summary: "clean", findings: [] },
        evidence: [hashOf(failingCommand)],
      }) as never,
    })).toMatchObject({ outcome: "failure", reason: "command_exit_nonzero" });

    expect(() => evaluateFinalReviewGate({
      expected,
      commands: [receipt("command_result", "success", {
        issued_at: "2026-07-29T00:00:02.000Z",
        payload: { command: "test", exit_code: 0, summary: "command done" },
      }) as never],
      expectedCommandNames: ["test"],
      review: receipt("semantic_review", "success", {
        issued_at: "2026-07-29T00:00:01.000Z",
        payload: { summary: "clean", findings: [] },
      }) as never,
    })).toThrow(/predates whole-change command evidence/);
  });

  it("rejects stale producer/input provenance and missing command receipts", () => {
    expect(() => evaluateUnitAcceptanceGate({
      expected,
      completion: receipt("unit_completion", "success", {
        producer: {
          worker_id: "other-worker",
          skill: "builtin://unit_completion@1",
          capability_digest: "c".repeat(64),
          skill_package_digest: null,
        },
      }) as never,
      candidate: receipt("candidate_evidence", "success") as never,
      commands: [command("success", 0) as never],
      expectedCommandNames: ["test"],
      lead: receipt("unit_decision", "accept", {
        payload: { rationale: "Matches.", context_updates: [], accepted_subject: expected.subject },
      }) as never,
    })).toThrow(/completion receipt producer mismatch/);

    expect(() => evaluateFinalReviewGate({
      expected,
      commands: [command("success", 0) as never],
      expectedCommandNames: ["test"],
      review: receipt("semantic_review", "success", {
        subject: { base: "2".repeat(40), pre: "0".repeat(40), post: expected.subject },
        payload: { summary: "clean", findings: [] },
      }) as never,
    })).toThrow(/review receipt input subject mismatch/);

    expect(evaluateFinalReviewGate({
      expected,
      commands: [],
      expectedCommandNames: ["test"],
      review: receipt("semantic_review", "success", {
        payload: { summary: "clean", findings: [] },
      }) as never,
    })).toMatchObject({
      outcome: "failure",
      reason: "command_receipts_missing_or_unexpected",
    });
  });

  it("rejects a candidate receipt bound to the wrong graph, attempt, run, action, generation, session, or request", () => {
    const overrides: Array<[Record<string, unknown>, string]> = [
      [{ graph_digest: "d".repeat(64) }, "fence mismatch"],
      [{ attempt_id: "attempt-2" }, "fence mismatch"],
      [{ parent_run_id: "run-2" }, "fence mismatch"],
      [{ action_attempt_id: "action-2" }, "fence mismatch"],
      [{ generation: 2 }, "fence mismatch"],
      [{ native_session_id: "session-2" }, "fence mismatch"],
      [{ unit_id: "unit-2" }, "fence mismatch"],
      [{ request_hash: "e".repeat(64) }, "fence mismatch"],
    ];
    for (const [fenceOverride, message] of overrides) {
      expect(() => evaluateUnitAcceptanceGate({
        expected,
        completion: receipt("unit_completion", "success") as never,
        candidate: receipt("candidate_evidence", "success", {
          fence: {
            pipeline_instance_id: expected.pipelineInstanceId,
            graph_digest: expected.graphDigest,
            unit_id: expected.unitId,
            attempt_id: expected.attemptId,
            parent_run_id: expected.parentRunId,
            action_attempt_id: expected.actionAttemptId,
            generation: expected.generation,
            native_session_id: expected.nativeSessionId,
            request_hash: expected.requestHash,
            ...fenceOverride,
          },
        }) as never,
        commands: [],
        expectedCommandNames: [],
        lead: receipt("unit_decision", "accept", {
          payload: { rationale: "Matches.", context_updates: [], accepted_subject: expected.subject },
        }) as never,
      })).toThrow(new RegExp(`candidate receipt ${message}`));
    }
  });

  it("rejects a completion receipt claiming the wrong repository skill package digest", () => {
    expect(() => evaluateUnitAcceptanceGate({
      expected,
      completion: receipt("unit_completion", "success", {
        producer: {
          worker_id: "worker-1",
          skill: "builtin://unit_completion@1",
          capability_digest: "c".repeat(64),
          skill_package_digest: "f".repeat(64),
        },
      }) as never,
      candidate: receipt("candidate_evidence", "success") as never,
      commands: [],
      expectedCommandNames: [],
      lead: receipt("unit_decision", "accept", {
        payload: { rationale: "Matches.", context_updates: [], accepted_subject: expected.subject },
      }) as never,
    })).toThrow(/completion receipt producer mismatch/);
  });

  it("rejects a receipt claiming the wrong producer for the candidate, command, lead, integration, or review role", () => {
    const impersonator = {
      worker_id: "impersonator",
      skill: "builtin://impersonator@1",
      capability_digest: "d".repeat(64),
      skill_package_digest: null,
    };

    const badCandidate = receipt("candidate_evidence", "success", { producer: impersonator });
    expect(() => evaluateUnitAcceptanceGate({
      expected,
      completion: receipt("unit_completion", "success") as never,
      candidate: badCandidate as never,
      commands: [],
      expectedCommandNames: [],
      lead: receipt("unit_decision", "accept", {
        payload: { rationale: "Matches.", context_updates: [], accepted_subject: expected.subject },
        evidence: [hashOf(badCandidate)],
      }) as never,
    })).toThrow(/candidate receipt producer mismatch/);

    const goodCandidate = receipt("candidate_evidence", "success");
    expect(() => evaluateUnitAcceptanceGate({
      expected,
      completion: receipt("unit_completion", "success") as never,
      candidate: goodCandidate as never,
      commands: [],
      expectedCommandNames: [],
      lead: receipt("unit_decision", "accept", {
        producer: impersonator,
        payload: { rationale: "Matches.", context_updates: [], accepted_subject: expected.subject },
        evidence: [hashOf(goodCandidate)],
      }) as never,
    })).toThrow(/lead receipt producer mismatch/);

    const badCommand = receipt("command_result", "success", {
      producer: impersonator,
      payload: { command: "test", exit_code: 0, summary: "command done" },
    });
    const goodCandidateForCommand = receipt("candidate_evidence", "success");
    expect(() => evaluateUnitAcceptanceGate({
      expected,
      completion: receipt("unit_completion", "success") as never,
      candidate: goodCandidateForCommand as never,
      commands: [badCommand] as never,
      expectedCommandNames: ["test"],
      lead: receipt("unit_decision", "accept", {
        payload: { rationale: "Matches.", context_updates: [], accepted_subject: expected.subject },
        evidence: [hashOf(goodCandidateForCommand), hashOf(badCommand)],
      }) as never,
    })).toThrow(/command receipt producer mismatch/);

    expect(() => evaluateFinalReviewGate({
      expected,
      commands: [badCommand] as never,
      expectedCommandNames: ["test"],
      review: receipt("semantic_review", "success", {
        payload: { summary: "clean", findings: [] },
        evidence: [hashOf(badCommand)],
      }) as never,
    })).toThrow(/command receipt producer mismatch/);

    expect(() => evaluateIntegrationGate({
      expected,
      integration: receipt("integration_evidence", "success", { producer: impersonator }) as never,
      ratchet: acceptedRatchet(),
    })).toThrow(/integration receipt producer mismatch/);

    const reviewCommand = command("success", 0);
    expect(() => evaluateFinalReviewGate({
      expected,
      commands: [reviewCommand] as never,
      expectedCommandNames: ["test"],
      review: receipt("semantic_review", "success", {
        producer: impersonator,
        payload: { summary: "clean", findings: [] },
        evidence: [hashOf(reviewCommand)],
      }) as never,
    })).toThrow(/review receipt producer mismatch/);
  });

  it("binds the lead decision to the exact candidate and command evidence receipts", () => {
    const candidate = receipt("candidate_evidence", "success");
    const testCommand = command("success", 0);

    expect(() => evaluateUnitAcceptanceGate({
      expected,
      completion: receipt("unit_completion", "success") as never,
      candidate: candidate as never,
      commands: [testCommand] as never,
      expectedCommandNames: ["test"],
      lead: receipt("unit_decision", "accept", {
        payload: { rationale: "Matches.", context_updates: [], accepted_subject: expected.subject },
        evidence: [],
      }) as never,
    })).toThrow(/lead receipt evidence missing required artifact hash/);

    const unrelatedCandidate = receipt("candidate_evidence", "success", { issued_at: "2026-07-29T00:00:05.000Z" });
    const unrelatedCommand = command("success", 0, "unrelated");
    expect(() => evaluateUnitAcceptanceGate({
      expected,
      completion: receipt("unit_completion", "success") as never,
      candidate: candidate as never,
      commands: [testCommand] as never,
      expectedCommandNames: ["test"],
      lead: receipt("unit_decision", "accept", {
        payload: { rationale: "Matches.", context_updates: [], accepted_subject: expected.subject },
        evidence: [hashOf(unrelatedCandidate), hashOf(unrelatedCommand)],
      }) as never,
    })).toThrow(/lead receipt evidence missing required artifact hash/);
  });

  it("rejects a command receipt from a prior unit repair cycle", () => {
    const repairedExpected: StandardReceiptFence = {
      ...expected,
      baseSubject: expected.subject,
      preSubject: expected.subject,
      subject: "2".repeat(40),
    };
    const repairedSubject = {
      base: repairedExpected.baseSubject,
      pre: repairedExpected.preSubject,
      post: repairedExpected.subject,
    };
    const completion = receipt("unit_completion", "success", {
      subject: repairedSubject,
    });
    const candidate = receipt("candidate_evidence", "success", {
      subject: repairedSubject,
    });
    const staleCommandSubject = {
      ...repairedSubject,
      post: expected.subject,
    };
    const priorCycleCommand = command("success", 0, "test", { subject: staleCommandSubject });

    expect(() => evaluateUnitAcceptanceGate({
      expected: repairedExpected,
      completion: completion as never,
      candidate: candidate as never,
      commands: [priorCycleCommand] as never,
      expectedCommandNames: ["test"],
      lead: receipt("unit_decision", "accept", {
        subject: repairedSubject,
        payload: { rationale: "Matches.", context_updates: [], accepted_subject: repairedExpected.subject },
        evidence: [hashOf(candidate), hashOf(priorCycleCommand)],
      }) as never,
    })).toThrow(/command receipt subject mismatch/);
  });

  it("binds the final review to the exact whole-change command evidence receipts", () => {
    const testCommand = command("success", 0);

    expect(() => evaluateFinalReviewGate({
      expected,
      commands: [testCommand] as never,
      expectedCommandNames: ["test"],
      review: receipt("semantic_review", "success", {
        payload: { summary: "clean", findings: [] },
        evidence: [],
      }) as never,
    })).toThrow(/review receipt evidence missing required artifact hash/);

    const unrelatedCommand = command("success", 0, "unrelated");
    expect(() => evaluateFinalReviewGate({
      expected,
      commands: [testCommand] as never,
      expectedCommandNames: ["test"],
      review: receipt("semantic_review", "success", {
        payload: { summary: "clean", findings: [] },
        evidence: [hashOf(unrelatedCommand)],
      }) as never,
    })).toThrow(/review receipt evidence missing required artifact hash/);
  });

  it("evaluates identically for an exact receipt replay and rejects a conflicting replay", () => {
    const first = evaluateIntegrationGate({ expected, integration: receipt("integration_evidence", "success") as never, ratchet: acceptedRatchet() });
    const second = evaluateIntegrationGate({ expected, integration: receipt("integration_evidence", "success") as never, ratchet: acceptedRatchet() });
    expect(second).toEqual(first);

    expect(() => evaluateIntegrationGate({
      expected,
      integration: receipt("integration_evidence", "success", {
        subject: { base: "0".repeat(40), pre: "0".repeat(40), post: "9".repeat(40) },
      }) as never,
      ratchet: acceptedRatchet(),
    })).toThrow(/integration receipt subject mismatch/);
  });

  it("rejects integration when the composed ratchet is missing, rejected, or forged", () => {
    expect(evaluateIntegrationGate({
      expected,
      integration: receipt("integration_evidence", "success") as never,
      ratchet: null,
    })).toMatchObject({
      outcome: "failure",
      result: "failed",
      reason: "integration_evidence_failed",
    });

    const rejectedInput = ratchetInput();
    rejectedInput.proposed[0]!.artifact_digest = "f".repeat(64);
    const rejectedDecision = evaluateIntegrationGate({
      expected,
      integration: receipt("integration_evidence", "success") as never,
      ratchet: acceptedRatchet(rejectedInput),
    });
    expect(rejectedDecision).toMatchObject({
      outcome: "failure",
      result: "failed",
      reason: "integration_evidence_failed",
    });
    expect(JSON.parse(rejectedDecision.payload)).toMatchObject({
      ratchet_journal: {
        result: "failed",
        reasons: ["ratchet:artifact_digest_changed"],
      },
    });

    const forged = acceptedRatchet();
    const mismatchedInput = ratchetInput();
    mismatchedInput.proposed[0]!.artifact_digest = "f".repeat(64);
    forged.differentialRatchet.input = mismatchedInput;
    const forgedDecision = evaluateIntegrationGate({
      expected,
      integration: receipt("integration_evidence", "success") as never,
      ratchet: forged,
    });
    expect(JSON.parse(forgedDecision.payload)).toMatchObject({
      ratchet_journal: {
        result: "failed",
        reasons: [
          "differential_ratchet_input_mismatch",
          "differential_ratchet_decision_mismatch",
          "ratchet:artifact_digest_changed",
        ],
      },
    });
  });
});
