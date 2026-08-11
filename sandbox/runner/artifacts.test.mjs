import { describe, expect, it } from "vitest";
import { RUNTIME_DESCRIPTOR } from "./capabilities.mjs";
import {
  buildCommandArtifacts,
  buildStandardReceiptArtifacts,
  buildSemanticArtifacts,
  digest,
  isStageProposalShaped,
  isStandardReceiptShaped,
  parseAgentJson,
  sanitizeArtifactText,
  validateStandardReceipt,
  validateSemanticProposal,
} from "./artifacts.mjs";

const fence = {
  pipelineInstanceId: "pipeline-1",
  manifestDigest: "a".repeat(64),
  runtimeRelease: RUNTIME_DESCRIPTOR.release,
  capabilityDigest: "b".repeat(64),
  stageId: "review",
  attemptId: "attempt-1",
  requestHash: "c".repeat(64),
  runId: "run-1",
  issueId: "issue-1",
  sessionId: "session-1",
  generation: 1,
  contextRevision: 0,
  contextPolicy: "fresh",
  nativeSessionId: null,
  capability: "agent/semantic@1",
  repository: "owner/repo",
  baseCommit: "d".repeat(40),
  subject: "tree-current",
  preSubject: "tree-current",
  postSubject: "tree-current",
  startedAt: "2026-07-22T00:00:00.000Z",
  completedAt: "2026-07-22T00:00:01.000Z",
};

const proposal = {
  schema: "openthrottle.stage-proposal/v1",
  suggested_outcome: "success",
  summary: "Review complete",
  evidence: ["Tests passed"],
  findings: [],
  actions: ["Reviewed diff"],
  uncertainty: ["Semantic judgment"],
};

describe("normalized stage artifacts", () => {
  it("seals supervisor-authored provenance and deterministic hashes", () => {
    const first = buildSemanticArtifacts({
      proposal,
      fence,
      requiredArtifacts: ["review"],
      env: {},
    });
    const second = buildSemanticArtifacts({
      proposal,
      fence,
      requiredArtifacts: ["review"],
      env: {},
    });
    expect(first).toEqual(second);
    expect(first.map((artifact) => artifact.kind)).toEqual(["stage_result", "review"]);
    for (const artifact of first) {
      expect(digest(artifact.payload)).toBe(artifact.hash);
      const payload = JSON.parse(artifact.payload);
      expect(payload.pipeline.instance_id).toBe("pipeline-1");
      expect(payload.assurance).toBe("semantic_attested");
      expect(payload.repository.subject).toBe("tree-current");
    }
  });

  it("rejects attempts to author fenced metadata or pass flags", () => {
    for (const authoritative of ["pipeline", "assurance", "subject", "artifact_hash", "passed"]) {
      expect(() => validateSemanticProposal({ ...proposal, [authoritative]: true }, {}))
        .toThrow(/cannot set authoritative field/);
    }
    expect(() => validateSemanticProposal({ ...proposal, suggested_outcome: "canceled" }, {}))
      .toThrow(/invalid suggested_outcome/);
    expect(() => validateSemanticProposal({ ...proposal, suggested_outcome: "superseded" }, {}))
      .toThrow(/invalid suggested_outcome/);
  });

  it("sanitizes secret-shaped evidence and bounds agent content", () => {
    const [artifact] = buildSemanticArtifacts({
      proposal: {
        ...proposal,
        summary: `saw ghp_abcdefghijklmnop and ${"x".repeat(3_000)}`,
        evidence: ["private-value"],
      },
      fence,
      requiredArtifacts: [],
      env: { MODEL_TOKEN: "private-value" },
    });
    expect(artifact.payload).not.toContain("ghp_abcdefghijklmnop");
    expect(artifact.payload).not.toContain("private-value");
    expect(JSON.parse(artifact.payload).summary.length).toBeLessThanOrEqual(2_000);
    expect(Buffer.byteLength(artifact.payload, "utf8")).toBeLessThanOrEqual(12 * 1024);
  });

  it("keeps bearer prose but redacts bearer-token shapes", () => {
    const prose = "CODEX_AUTH_JSON bearer credentials. Supports bearer token-based authentication and Bearer token.";
    expect(sanitizeArtifactText(prose, {})).toBe(prose);
    for (const secret of [
      "Bearer eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl",
      "Bearer k7dP3nQ9xR2mV8z",
      "Bearer opaque._~+/-value-1234567890=",
      "Authorization: Bearer abc123",
      "Authorization: Bearer\nabc123",
      "{\"authorization\":\"Bearer\\nabc123\"}",
      '{"authorization":"Bearer abc123"}',
      'summary: "{\\"authorization\\":\\"Bearer abc123\\"}"',
    ]) {
      expect(sanitizeArtifactText(secret, {})).not.toContain(secret.split("Bearer ")[1]);
      expect(sanitizeArtifactText(secret, {})).toContain("[REDACTED]");
    }
  });

  it("records mechanical command context and never treats termination as success", () => {
    const artifacts = buildCommandArtifacts({
      fence: { ...fence, capability: "command/run@1", contextPolicy: "none" },
      command: "npm test",
      commandName: "test",
      execution: { exitCode: 137, signal: "SIGKILL", timedOut: false, stdout: "", stderr: "killed" },
      requiredArtifacts: ["command_result"],
      env: {},
    });
    const result = JSON.parse(artifacts[0].payload);
    expect(result.result).toBe("retryable_infrastructure_failure");
    expect(result.details.command_digest).toBe(digest("npm test"));
    expect(result.details.exit_code).toBe(137);
  });

  it("validates standard receipts without semantic assurance upgrades", () => {
    const receipt = {
      schema: "openthrottle.receipt/v1",
      type: "unit_decision",
      assurance: "semantic_attested",
      result: "accept",
      producer: {
        worker_id: "lead-1",
        skill: "builtin://accept-unit@1",
        capability_digest: "e".repeat(64),
        skill_package_digest: null,
      },
      subject: { base: "1".repeat(40), pre: "1".repeat(40), post: "2".repeat(40) },
      fence: {
        pipeline_instance_id: "pipeline-1",
        graph_digest: "f".repeat(64),
        unit_id: "unit-1",
        attempt_id: "attempt-1",
        parent_run_id: "run-1",
        action_attempt_id: "action-1",
        generation: 1,
        native_session_id: null,
        request_hash: "a".repeat(64),
      },
      evidence: ["candidate-evidence"],
      payload: {
        rationale: "Matches the assigned unit scope.",
        context_updates: [],
        accepted_subject: "2".repeat(40),
      },
      issued_at: "2026-07-29T00:00:00.000Z",
    };

    expect(validateStandardReceipt(receipt, {})).toMatchObject({
      type: "unit_decision",
      assurance: "semantic_attested",
      result: "accept",
    });
    expect(() => validateStandardReceipt({ ...receipt, assurance: "executor_verified" }, {}))
      .toThrow(/semantic standard receipt cannot claim/);
    expect(() => validateStandardReceipt({
      ...receipt,
      producer: { ...receipt.producer, skill: "accept-unit" },
    }, {})).toThrow(/producer skill/);
    expect(() => validateStandardReceipt({ ...receipt, payload: {} }, {}))
      .toThrow(/payload rationale/);

    const commandReceipt = {
      ...receipt,
      type: "command_result",
      assurance: "executor_verified",
      result: "failure",
      producer: { ...receipt.producer, skill: "builtin://command@1" },
      payload: {
        command: "test",
        exit_code: 1,
        summary: "Tests failed.",
        stdout_tail: "AssertionError: expected 2 to equal 3",
        stderr_tail: "FAIL runner/command.test.mjs",
      },
    };
    expect(validateStandardReceipt(commandReceipt, {}).payload).toMatchObject({
      stdout_tail: "AssertionError: expected 2 to equal 3",
      stderr_tail: "FAIL runner/command.test.mjs",
    });
    for (const result of ["success", "not_configured"]) {
      for (const tailField of ["stdout_tail", "stderr_tail"]) {
        expect(() => validateStandardReceipt({
          ...commandReceipt,
          result,
          payload: {
            command: "test",
            exit_code: 0,
            summary: "No failed command output.",
            [tailField]: "unexpected diagnostic tail",
          },
        }, {})).toThrow(/diagnostic tails are only valid for failed command receipts/);
      }
    }

    const artifacts = buildStandardReceiptArtifacts({
      receipt,
      fence: {
        ...fence,
        capability: "agent/semantic@1",
        subject: "2".repeat(40),
        preSubject: "1".repeat(40),
        postSubject: "2".repeat(40),
      },
      env: {},
    });
    expect(artifacts.map((artifact) => artifact.kind)).toEqual(["stage_result", "standard_receipt"]);
    expect(JSON.parse(artifacts[1].payload).details.receipt.result).toBe("accept");
  });

  it("maps every standard receipt result to a stage outcome", () => {
    const baseReceipt = {
      schema: "openthrottle.receipt/v1",
      assurance: "human_approved",
      producer: {
        worker_id: "human-1",
        skill: "builtin://human-approval@1",
        capability_digest: "e".repeat(64),
        skill_package_digest: null,
      },
      subject: { base: "1".repeat(40), pre: "1".repeat(40), post: "1".repeat(40) },
      fence: {
        pipeline_instance_id: "pipeline-1",
        graph_digest: "f".repeat(64),
        unit_id: "unit-1",
        attempt_id: "attempt-1",
        parent_run_id: "run-1",
        action_attempt_id: "action-1",
        generation: 1,
        native_session_id: null,
        request_hash: "a".repeat(64),
      },
      evidence: ["approval"],
      payload: { approver: "person", rationale: "Rejected." },
      issued_at: "2026-07-29T00:00:00.000Z",
    };

    const [stageResult] = buildStandardReceiptArtifacts({
      receipt: { ...baseReceipt, type: "human_approval", result: "rejected" },
      fence: {
        ...fence,
        capability: "agent/semantic@1",
      },
      env: {},
    });

    expect(JSON.parse(stageResult.payload).result).toBe("failure");
  });

  it("allows semantic review findings without paths", () => {
    expect(validateStandardReceipt({
      schema: "openthrottle.receipt/v1",
      type: "semantic_review",
      assurance: "semantic_attested",
      result: "semantic_repair_required",
      producer: {
        worker_id: "reviewer-1",
        skill: "builtin://final-review@1",
        capability_digest: "e".repeat(64),
        skill_package_digest: null,
      },
      subject: { base: "1".repeat(40), pre: "1".repeat(40), post: "2".repeat(40) },
      fence: {
        pipeline_instance_id: "pipeline-1",
        graph_digest: "f".repeat(64),
        unit_id: "whole-change",
        attempt_id: "attempt-1",
        parent_run_id: "run-1",
        action_attempt_id: "action-1",
        generation: 1,
        native_session_id: null,
        request_hash: "a".repeat(64),
      },
      evidence: ["review"],
      payload: {
        summary: "One finding.",
        findings: [{ severity: "P1", message: "Missing receipt." }],
      },
      issued_at: "2026-07-29T00:00:00.000Z",
    }, {}).payload.findings[0]).toEqual({ severity: "P1", message: "Missing receipt." });
  });

  it("binds full provenance and rejects a wrong graph, run, action, generation, session, or skill digest", () => {
    const receipt = {
      schema: "openthrottle.receipt/v1",
      type: "candidate_evidence",
      assurance: "executor_verified",
      result: "success",
      producer: {
        worker_id: "worker-1",
        skill: "repo://acme/graphs@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#.openthrottle/skills/implement_unit",
        capability_digest: "e".repeat(64),
        skill_package_digest: "d".repeat(64),
      },
      subject: { base: "1".repeat(40), pre: "1".repeat(40), post: "2".repeat(40) },
      fence: {
        pipeline_instance_id: "pipeline-1",
        graph_digest: "f".repeat(64),
        unit_id: "unit-1",
        attempt_id: "attempt-1",
        parent_run_id: "run-1",
        action_attempt_id: "action-1",
        generation: 1,
        native_session_id: "session-1",
        request_hash: "a".repeat(64),
      },
      evidence: ["tree observed"],
      payload: { tree: "2".repeat(40), diff_digest: "b".repeat(64), changed_paths: [], clean: true },
      issued_at: "2026-07-29T00:00:00.000Z",
    };

    expect(validateStandardReceipt(receipt, {})).toMatchObject({
      producer: { skill_package_digest: "d".repeat(64) },
      fence: {
        parent_run_id: "run-1",
        action_attempt_id: "action-1",
        generation: 1,
        native_session_id: "session-1",
      },
    });

    expect(() => validateStandardReceipt({
      ...receipt,
      fence: { ...receipt.fence, generation: 0 },
    }, {})).toThrow(/generation/);
    expect(() => validateStandardReceipt({
      ...receipt,
      producer: { ...receipt.producer, skill_package_digest: "not-a-digest" },
    }, {})).toThrow(/skill package digest/);
    expect(() => validateStandardReceipt({
      ...receipt,
      producer: {
        ...receipt.producer,
        skill: "repo://acme/graphs@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#../../etc/passwd",
      },
    }, {})).toThrow(/producer skill/);
    expect(() => validateStandardReceipt({
      ...receipt,
      fence: { ...receipt.fence, native_session_id: "" },
    }, {})).toThrow(/native session/);
    expect(() => validateStandardReceipt({
      ...receipt,
      fence: { ...receipt.fence, graph_digest: "not-a-digest" },
    }, {})).toThrow(/fence digest is invalid/);
    expect(() => validateStandardReceipt({
      ...receipt,
      fence: { ...receipt.fence, parent_run_id: "" },
    }, {})).toThrow(/parent run/);
    expect(() => validateStandardReceipt({
      ...receipt,
      fence: { ...receipt.fence, action_attempt_id: "" },
    }, {})).toThrow(/action attempt/);
  });
});

describe("agent-authored JSON parsing", () => {
  const payload = { schema: "openthrottle.receipt/v1", nested: { list: ["a", "b"] } };
  const pretty = JSON.stringify(payload, null, 2);

  it("parses unfenced JSON exactly as JSON.parse does", () => {
    expect(parseAgentJson(JSON.stringify(payload))).toEqual(payload);
    expect(parseAgentJson(`  ${pretty}\n`)).toEqual(payload);
  });

  it("peels exactly one complete outer code fence, with or without a language tag", () => {
    // OPE-101 generation 6 emitted a byte-perfect receipt inside ```json.
    expect(parseAgentJson(`\`\`\`json\n${pretty}\n\`\`\``)).toEqual(payload);
    expect(parseAgentJson(`\`\`\`\n${pretty}\n\`\`\``)).toEqual(payload);
    expect(parseAgentJson(`\n\`\`\`JSON \n${pretty}\n\`\`\`\n`)).toEqual(payload);
  });

  it("rejects anything that is not one whole fence, keeping the original parse error", () => {
    // Text outside the fence means the model wrote something other than one
    // object; guessing which part it meant is exactly what must not happen.
    expect(() => parseAgentJson(`Here it is:\n\`\`\`json\n${pretty}\n\`\`\``)).toThrow(SyntaxError);
    expect(() => parseAgentJson(`\`\`\`json\n${pretty}\n\`\`\`\nDone.`)).toThrow(SyntaxError);
    // A partial fence is not a fence.
    expect(() => parseAgentJson(`\`\`\`json\n${pretty}`)).toThrow(SyntaxError);
    expect(() => parseAgentJson(`${pretty}\n\`\`\``)).toThrow(SyntaxError);
    // Only one fence is peeled: two concatenated blocks stay unparseable.
    expect(() => parseAgentJson(`\`\`\`json\n${pretty}\n\`\`\`\n\`\`\`json\n${pretty}\n\`\`\``)).toThrow(SyntaxError);
    expect(() => parseAgentJson("not json at all")).toThrow(SyntaxError);
  });
});

describe("narrated agent JSON extraction", () => {
  const receipt = { schema: "openthrottle.receipt/v1", type: "unit_completion", result: "success" };
  const proposal = { schema: "openthrottle.stage-proposal/v1", suggested_outcome: "success", summary: "ok" };
  const asReceipt = { qualifies: isStandardReceiptShaped, label: "receipt" };
  const asProposal = { qualifies: isStageProposalShaped, label: "proposal" };
  const fence = (value) => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
  // OPE-101 generation 8, verbatim.
  const narrated = `Good — only the test file is modified. Now composing the receipt.\n\n${fence(receipt)}`;

  it("recognizes only an exact schema id and a known kind", () => {
    expect(isStandardReceiptShaped(receipt)).toBe(true);
    expect(isStandardReceiptShaped({ ...receipt, type: "unit_invented" })).toBe(false);
    expect(isStandardReceiptShaped({ ...receipt, schema: "openthrottle.receipt/v2" })).toBe(false);
    expect(isStandardReceiptShaped({ type: "unit_completion" })).toBe(false);
    expect(isStandardReceiptShaped([receipt])).toBe(false);
    expect(isStandardReceiptShaped(null)).toBe(false);
    expect(isStageProposalShaped(proposal)).toBe(true);
    expect(isStageProposalShaped({ ...proposal, suggested_outcome: "canceled" })).toBe(false);
    expect(isStageProposalShaped(receipt)).toBe(false);
    expect(isStandardReceiptShaped(proposal)).toBe(false);
  });

  it("takes the one recognizable block out of a narrated message", () => {
    expect(parseAgentJson(narrated, asReceipt)).toEqual(receipt);
    expect(parseAgentJson(`${fence(receipt)}\n\nLet me know if anything else is needed.`, asReceipt)).toEqual(receipt);
    expect(parseAgentJson(`Before.\n\`\`\`\n${JSON.stringify(receipt)}\n\`\`\`\nAfter.`, asReceipt)).toEqual(receipt);
    // Other fenced blocks are not competition unless they are receipts too.
    expect(parseAgentJson(
      `Diff:\n\`\`\`diff\n- old\n+ new\n\`\`\`\nReceipt:\n${fence(receipt)}`,
      asReceipt,
    )).toEqual(receipt);
    expect(parseAgentJson(`Notes.\n${fence(proposal)}`, asProposal)).toEqual(proposal);
  });

  it("refuses to choose between recognizable blocks and says how many it saw", () => {
    const twoReceipts = `${narrated}\n\nOn reflection, this one:\n${fence({ ...receipt, result: "failure" })}`;
    expect(() => parseAgentJson(twoReceipts, asReceipt))
      .toThrow(/2 receipt-like blocks found; refusing to guess which one is the receipt/);
    try {
      parseAgentJson(twoReceipts, asReceipt);
    } catch (error) {
      // The flag is what lets parseLoopReceipt prefer this over a validator
      // error that would describe only whichever block it reached first.
      expect(error.ambiguousAgentJson).toBe(true);
    }
    expect(() => parseAgentJson(`x\n${fence(proposal)}\ny\n${fence(proposal)}`, asProposal))
      .toThrow(/2 proposal-like blocks found/);
  });

  it("keeps the original parse error when nothing in the message is recognizable", () => {
    // A fenced object that is not this document is not a candidate at all, so
    // the failure is the one the caller would have reported before extraction.
    expect(() => parseAgentJson(`Checked the diff.\n\`\`\`json\n{"files":1}\n\`\`\``, asReceipt)).toThrow(SyntaxError);
    expect(() => parseAgentJson(`Here it is.\n${fence(proposal)}`, asReceipt)).toThrow(SyntaxError);
    // Un-fenced receipt-shaped JSON in prose never qualifies: where the object
    // starts and stops is a guess, and guessing is the thing being avoided.
    expect(() => parseAgentJson(`Here it is: ${JSON.stringify(receipt)} — done.`, asReceipt)).toThrow(SyntaxError);
    // An unterminated fence has no extent, so it holds no block.
    expect(() => parseAgentJson(`Composing:\n\`\`\`json\n${JSON.stringify(receipt)}`, asReceipt)).toThrow(SyntaxError);
  });

  it("extracts only after a direct parse and a whole-message fence both fail", () => {
    // Tier order matters: a message that already parses is never rescanned, so
    // extraction can never change an outcome #151/#152 already decided.
    expect(parseAgentJson(JSON.stringify(receipt), asReceipt)).toEqual(receipt);
    expect(parseAgentJson(fence(receipt), asReceipt)).toEqual(receipt);
    // The whole-message fence peel is unconditional, so an unrecognizable
    // interior is still returned for the validator to reject by name rather
    // than being replaced by a recognizable block from somewhere else.
    const { schema: _schema, ...withoutSchema } = receipt;
    expect(parseAgentJson(fence(withoutSchema), asReceipt)).toEqual(withoutSchema);
    // Callers that pass no qualifier stay exactly on the #152 chain.
    expect(() => parseAgentJson(narrated)).toThrow(SyntaxError);
  });
});
