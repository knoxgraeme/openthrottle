import { describe, expect, it } from "vitest";
import { RUNTIME_DESCRIPTOR } from "./capabilities.mjs";
import {
  buildCommandArtifacts,
  buildSemanticArtifacts,
  digest,
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
  contextPolicy: "fresh_review",
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
});
