import { describe, expect, it } from "vitest";
import {
  STAGE_EXECUTOR_PROTOCOL,
  buildStageRequest,
  createStageRequestHash,
  type StageRequestEnvelope,
} from "./stage-request.js";
import type { PipelineStage } from "./manifest.js";

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
      commandName: "test",
    };
    expect(createStageRequestHash(request)).toEqual({
      requestHash: "d4b66b65a42d195aaf4fa6a21c71107198c44ea4e8dd5d8cc75bb0357452f347",
      idempotencyKey: "stage:pipeline-1:command:attempt-1:d4b66b65a42d195aaf4fa6a21c71107198c44ea4e8dd5d8cc75bb0357452f347",
    });
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

  it("uses the commandName declared by the manifest stage", () => {
    const stage: PipelineStage = {
      id: "quality-gate",
      executor: { kind: "command", capability: "command/run@1" },
      commandName: "lint",
      evaluator: {
        kind: "command",
        assurance: "executor_verified",
        required_artifacts: ["command_result"],
      },
      context: "none",
      live_steering: false,
      credentials: ["repo.read"],
      produces: ["stage_result", "command_result"],
      transitions: {} as PipelineStage["transitions"],
    };
    const request = buildStageRequest({
      instanceId: "pipeline-1",
      manifestDigest: "a".repeat(64),
      runtimeRelease: "snapshot/v1",
      capabilityDigest: "b".repeat(64),
      repositoryConfigDigest: "d".repeat(64),
      stage,
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
      nativeSessionId: null,
    });

    expect(request).toMatchObject({
      stageId: "quality-gate",
      commandName: "lint",
      idempotencyKey: `stage:pipeline-1:quality-gate:attempt-1:${request.requestHash}`,
    });
  });

  it("includes an optional child action id in the immutable request fence", () => {
    const stage: PipelineStage = {
      id: "implementation",
      executor: { kind: "agent", capability: "ce/implement@1" },
      evaluator: {
        kind: "semantic",
        assurance: "semantic_attested",
        required_artifacts: [],
      },
      context: "fresh",
      live_steering: true,
      credentials: ["repo.read"],
      produces: ["stage_result"],
      transitions: {} as PipelineStage["transitions"],
    };
    const request = buildStageRequest({
      instanceId: "pipeline-1",
      manifestDigest: "a".repeat(64),
      runtimeRelease: "snapshot/v1",
      capabilityDigest: "b".repeat(64),
      repositoryConfigDigest: "d".repeat(64),
      stage,
      attemptId: "attempt-child",
      runId: "run-parent",
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
      nativeSessionId: null,
      childActionId: "action-1",
    });

    expect(request.childActionId).toBe("action-1");
    expect(request.idempotencyKey).toBe(`stage:pipeline-1:implementation:attempt-child:${request.requestHash}`);
    const { requestHash: _requestHash, idempotencyKey: _idempotencyKey, ...withoutFence } = request;
    const { childActionId: _childActionId, ...withoutChildAction } = withoutFence;
    expect(createStageRequestHash(withoutFence))
      .not.toEqual(createStageRequestHash(withoutChildAction));
  });
});
