import { describe, expect, it } from "vitest";
import {
  STAGE_EXECUTOR_PROTOCOL,
  createStageRequestHash,
  type StageRequestEnvelope,
} from "./stage-request.js";

describe("stage request construction", () => {
  it("hashes the complete immutable stage fence without credential material", () => {
    const request: Omit<StageRequestEnvelope, "requestHash" | "idempotencyKey"> = {
      protocol: STAGE_EXECUTOR_PROTOCOL,
      pipelineInstanceId: "pipeline-1",
      manifestDigest: "a".repeat(64),
      runtimeRelease: "snapshot/v1",
      capabilityDigest: "b".repeat(64),
      repositoryConfigDigest: "d".repeat(64),
      stageId: "command",
      attemptId: "attempt-1",
      runId: "run-1",
      issueId: "issue-1",
      sessionId: "session-1",
      generation: 1,
      taskType: "implement",
      taskContext: "Implement the approved plan.",
      transitionContext: "",
      repository: "owner/repo",
      baseCommit: "c".repeat(40),
      baseBranch: "release/2.0",
      branch: "ot/issue-1",
      agent: "codex",
      contextRevision: 0,
      expectedSubject: null,
      contextPolicy: "none",
      nativeSessionId: null,
      capability: "command/run@1",
      requiredArtifacts: ["command_result"],
      credentialScopes: ["repo.read"],
      liveSteering: false,
    };
    expect(createStageRequestHash(request)).toEqual(createStageRequestHash({ ...request }));
    expect(createStageRequestHash({ ...request, generation: 2 }).requestHash)
      .not.toBe(createStageRequestHash(request).requestHash);
    expect(createStageRequestHash({ ...request, taskType: "investigate" }).requestHash)
      .not.toBe(createStageRequestHash(request).requestHash);
    expect(createStageRequestHash({ ...request, baseBranch: "main" }).requestHash)
      .not.toBe(createStageRequestHash(request).requestHash);
    expect(createStageRequestHash({ ...request, taskContext: "Different plan" }).requestHash)
      .not.toBe(createStageRequestHash(request).requestHash);
    expect(JSON.stringify(createStageRequestHash(request))).not.toContain("token");
  });
});
