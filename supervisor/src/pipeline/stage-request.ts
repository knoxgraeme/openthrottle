import {
  type ArtifactKind,
  canonicalJson,
  COMMAND_NAMES,
  type CommandName,
  digestNormalized,
  type ContextPolicy,
  type PipelineStage,
} from "./manifest.js";

export const STAGE_EXECUTOR_PROTOCOL = "stage-executor@1";

export interface StageRequestEnvelope {
  protocol: typeof STAGE_EXECUTOR_PROTOCOL;
  pipelineInstanceId: string;
  manifestDigest: string;
  runtimeRelease: string;
  capabilityDigest: string;
  repositoryConfigDigest: string;
  stageId: string;
  attemptId: string;
  requestHash: string;
  idempotencyKey: string;
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
  contextPolicy: ContextPolicy;
  nativeSessionId: string | null;
  capability: string;
  requiredArtifacts: ArtifactKind[];
  credentialScopes: string[];
  liveSteering: boolean;
  commandName?: CommandName;
}

export function createStageRequestHash(
  request: Omit<StageRequestEnvelope, "requestHash" | "idempotencyKey">
): Pick<StageRequestEnvelope, "requestHash" | "idempotencyKey"> {
  const requestHash = digestNormalized(canonicalJson(request));
  return {
    requestHash,
    idempotencyKey: `stage:${request.pipelineInstanceId}:${request.stageId}:${request.attemptId}:${requestHash}`,
  };
}

function deterministicId(prefix: string, input: unknown): string {
  return `${prefix}-${digestNormalized(canonicalJson(input)).slice(0, 32)}`;
}

export function plannedStageRunId(attemptId: string): string {
  return deterministicId("run", [attemptId, "stage-execution"]);
}

function legacyImplicitCommandName(stage: PipelineStage): CommandName | undefined {
  if (stage.executor.kind !== "command") return undefined;
  return COMMAND_NAMES.find((commandName) => commandName === stage.id);
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
  const commandName = input.stage.commandName ?? legacyImplicitCommandName(input.stage);
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
    ...(commandName ? { commandName } : {}),
  };
  return { ...withoutFence, ...createStageRequestHash(withoutFence) };
}
