import {
  canonicalJson,
  digestNormalized,
  type PipelineStage,
} from "./manifest.js";
import {
  STAGE_EXECUTOR_PROTOCOL,
  createStageRequestHash,
  type StageRequestEnvelope,
} from "../runtime/contracts.js";

function deterministicId(prefix: string, input: unknown): string {
  return `${prefix}-${digestNormalized(canonicalJson(input)).slice(0, 32)}`;
}

export function plannedStageRunId(attemptId: string): string {
  return deterministicId("run", [attemptId, "stage-execution"]);
}

export function buildStageRequest(input: {
  instanceId: string;
  manifestDigest: string;
  runtimeRelease: string;
  capabilityDigest: string;
  repositoryConfigDigest: string;
  stage: PipelineStage;
  attemptId: string;
  runId: string;
  issueId: string;
  sessionId: string;
  generation: number;
  taskType: "implement" | "investigate";
  taskContext: string;
  transitionContext: string;
  repository: string;
  baseCommit: string;
  baseBranch: string;
  branch: string;
  agent: "claude" | "codex" | "opencode";
  contextRevision: number;
  expectedSubject: string | null;
  nativeSessionId: string | null;
}): StageRequestEnvelope {
  const commandNames = new Set(["test", "lint", "build", "format"] as const);
  const withoutFence: Omit<StageRequestEnvelope, "requestHash" | "idempotencyKey"> = {
    protocol: STAGE_EXECUTOR_PROTOCOL,
    pipelineInstanceId: input.instanceId,
    manifestDigest: input.manifestDigest,
    runtimeRelease: input.runtimeRelease,
    capabilityDigest: input.capabilityDigest,
    repositoryConfigDigest: input.repositoryConfigDigest,
    stageId: input.stage.id,
    attemptId: input.attemptId,
    runId: input.runId,
    issueId: input.issueId,
    sessionId: input.sessionId,
    generation: input.generation,
    taskType: input.taskType,
    taskContext: input.taskContext,
    transitionContext: input.transitionContext,
    repository: input.repository,
    baseCommit: input.baseCommit,
    baseBranch: input.baseBranch,
    branch: input.branch,
    agent: input.agent,
    contextRevision: input.contextRevision,
    expectedSubject: input.expectedSubject,
    contextPolicy: input.stage.context,
    nativeSessionId: input.nativeSessionId,
    capability: input.stage.executor.capability,
    requiredArtifacts: [...new Set(["stage_result" as const, ...input.stage.evaluator.required_artifacts])].sort(),
    credentialScopes: [...input.stage.credentials].sort(),
    liveSteering: input.stage.live_steering,
    ...(input.stage.executor.kind === "command" && commandNames.has(input.stage.id as never)
      ? { commandName: input.stage.id as "test" | "lint" | "build" | "format" }
      : {}),
  };
  return { ...withoutFence, ...createStageRequestHash(withoutFence) };
}
