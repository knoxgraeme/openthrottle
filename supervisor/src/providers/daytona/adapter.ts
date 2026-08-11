import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Daytona, type Sandbox } from "@daytona/sdk";
import {
  MAX_PRIVATE_RECOVERY_DIFF_BYTES,
  parseLoopReceiptRecoveryContract,
} from "@openthrottle/contracts";
import {
  type RuntimeResource,
  type RuntimeControl,
  type RuntimeInventoryResource,
  type RuntimeWorktreeHandle,
  type ChildExecutorActionRequest,
  type ChildExecutorActionResult,
  type LoopActionRequest,
  type LoopActionResult,
  type StageExecutionResult,
  assertLogicalCredentialScopes,
} from "../../runtime/contracts.js";
import { canonicalJson, digestNormalized, STAGE_OUTCOMES } from "../../pipeline/manifest.js";
import {
  createStageRequestHash,
  type StageRequestEnvelope,
} from "../../pipeline/stage-request.js";
import { assertPathSafeActionId } from "../../runtime/action-id.js";

const ACTIVE_SANDBOX_AUTOSTOP_MINUTES = 60;
const IDLE_SANDBOX_AUTOSTOP_MINUTES = 5;
const LOOP_ACTION_DISPATCH_GRACE_SECONDS = 30;
const OPENTHROTTLE_ROOT = "/var/lib/openthrottle";
const STAGE_INPUT_DIR = "/var/lib/openthrottle/stage-input";
const STAGE_RESULT_DIR = "/var/lib/openthrottle/stage-results";
const LOOP_ACTION_DIR = "/var/lib/openthrottle/loop-actions";
const LOOP_DISPATCH_DIR = "/var/lib/openthrottle/loop-dispatch";
const CHILD_EXECUTOR_DIR = "/var/lib/openthrottle/child-executor-actions";
const CHILD_EXECUTOR_DISPATCH_DIR = "/var/lib/openthrottle/child-executor-dispatch";
const PRIVATE_RECOVERY_DIFF_FILE = "recovery.patch.gz";
const MAX_RECEIPT_CORRECTION_STATE_BYTES = 3 * 1024 * 1024;
const STAGE_CREDENTIAL_ENV = new Set([
  "GITHUB_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_AUTH_JSON",
  "KIMI_CODE_API_KEY",
]);

export interface DaytonaStageCredentialMaterialization {
  env: Record<string, string>;
  unset?: string[];
}

export interface DaytonaSandboxRuntimeOptions {
  snapshot: string;
  materializeCredentialEnv: (
    resource: RuntimeResource,
    scopes: readonly string[],
    agent?: LoopActionRequest["agent"]
  ) => Promise<DaytonaStageCredentialMaterialization>;
  taskTimeoutSeconds?: number;
}

export interface DaytonaRuntimeFactoryOptions extends DaytonaSandboxRuntimeOptions {
  apiKey: string;
}

export function createDaytonaRuntime(options: DaytonaRuntimeFactoryOptions): RuntimeControl {
  return createDaytonaSandboxRuntime(new Daytona({ apiKey: options.apiKey }), options);
}

function ensureSandboxAutostop(sandbox: Sandbox, minutes: number): Promise<void> {
  return sandbox.autoStopInterval === minutes
    ? Promise.resolve()
    : sandbox.setAutostopInterval(minutes);
}

function ensureSandboxActive(sandbox: Sandbox): Promise<void> {
  return ensureSandboxAutostop(sandbox, ACTIVE_SANDBOX_AUTOSTOP_MINUTES);
}

function safeStagePathId(value: string, label: string): string {
  return assertPathSafeActionId(value, label);
}

function loopActionDispatchTimeoutSeconds(timeoutMs: number): number {
  return Math.ceil(timeoutMs / 1000) + LOOP_ACTION_DISPATCH_GRACE_SECONDS;
}

function assertStageRequestFence(request: StageRequestEnvelope): void {
  const { requestHash, idempotencyKey, ...withoutFence } = request;
  const expected = createStageRequestHash(withoutFence);
  if (requestHash !== expected.requestHash || idempotencyKey !== expected.idempotencyKey) {
    throw new Error(`stage request ${request.attemptId} has a stale hash or idempotency key`);
  }
  safeStagePathId(request.attemptId, "stage attempt ID");
  safeStagePathId(request.runId, "stage run ID");
}

function assertLoopRequestFence(request: LoopActionRequest): void {
  safeStagePathId(request.actionId, "loop action ID");
  safeStagePathId(request.attemptId, "loop attempt ID");
  if (request.agent === "opencode") {
    // The sandbox rejects OpenCode loop actions until database-backed session
    // sealing lands; fail closed before dispatch rather than in-sandbox.
    throw new Error("opencode loop actions are not supported yet");
  }
  if (request.role !== "publisher" && request.credentialScopes.includes("repo.write")) {
    throw new Error("structured loop actions cannot request repo.write");
  }
  const expectedHash = digestNormalized(canonicalJson(normalizedLoopRequestForHash(request)));
  const expectedKey = `loop:${request.attemptId}:${request.actionId}:${expectedHash}`;
  if (request.requestHash !== expectedHash || request.idempotencyKey !== expectedKey) {
    throw new Error(`loop action ${request.actionId} has a stale hash or idempotency key`);
  }
}

function assertChildExecutorRequestFence(request: ChildExecutorActionRequest): void {
  if (request.protocol !== "child-executor-action@1") {
    throw new Error(`child executor action ${request.actionId} has an invalid protocol`);
  }
  safeStagePathId(request.actionId, "child executor action ID");
  safeStagePathId(request.attemptId, "child executor attempt ID");
  if (!["command", "final_command", "candidate", "integrate"].includes(request.actionKind)) {
    throw new Error(`child executor action ${request.actionId} has an invalid kind`);
  }
  if (request.actionKind === "command" &&
      (!request.unitId || !request.worktree?.id)) {
    throw new Error(`child executor action ${request.actionId} requires a unit worktree`);
  }
  if (request.actionKind === "candidate" && !request.worktree?.id) {
    throw new Error(`child executor action ${request.actionId} requires a worktree`);
  }
  if (request.actionKind === "final_command" && request.unitId !== null) {
    throw new Error(`child executor action ${request.actionId} final command must be graph-scoped`);
  }
  if ((request.actionKind === "command" || request.actionKind === "final_command") && !request.commandName) {
    throw new Error(`child executor action ${request.actionId} is missing its command name`);
  }
  if (request.actionKind === "integrate" && !request.candidateSubject) {
    throw new Error(`child executor action ${request.actionId} is missing its candidate subject`);
  }
  const { requestHash: _requestHash, idempotencyKey: _idempotencyKey, ...withoutFence } = request;
  const expectedHash = digestNormalized(canonicalJson(withoutFence));
  const expectedKey = `child-executor:${request.attemptId}:${request.actionId}:${expectedHash}`;
  if (request.requestHash !== expectedHash || request.idempotencyKey !== expectedKey) {
    throw new Error(`child executor action ${request.actionId} has a stale hash or idempotency key`);
  }
}

function normalizedLoopRequestForHash(request: LoopActionRequest): Omit<LoopActionRequest, "requestHash" | "idempotencyKey"> {
  const { requestHash: _requestHash, idempotencyKey: _idempotencyKey, candidateSubject, ...withoutFence } = request;
  return candidateSubject === null || candidateSubject === undefined
    ? withoutFence
    : { ...withoutFence, candidateSubject };
}

// Shared with materializeCredentials below: the sandbox-eligible credential
// allowlist. Provider-only secrets (Daytona, Fly, Linear, webhook, install)
// are never members of this set, so a materializer bug or a compromised
// credential provider can never leak them into a loop action either.
function assertSandboxCredentialEnv(env: Record<string, string>, context: string): void {
  const unknown = Object.keys(env).find((name) => !STAGE_CREDENTIAL_ENV.has(name));
  if (unknown) throw new Error(`credential provider returned forbidden sandbox variable ${unknown} for ${context}`);
}

function loopActionPath(attemptId: string, actionId: string, name: string): string {
  safeStagePathId(attemptId, "loop attempt ID");
  safeStagePathId(actionId, "loop action ID");
  return `${LOOP_ACTION_DIR}/${attemptId}/${actionId}/${name}`;
}

function assertReceiptCorrectionState(
  raw: string,
  input: { attemptId: string; actionId: string; requestHash: string }
): void {
  if (Buffer.byteLength(raw, "utf8") > MAX_RECEIPT_CORRECTION_STATE_BYTES) {
    throw new Error(`loop receipt correction state ${input.attemptId}/${input.actionId} exceeds 3 MiB`);
  }
  const state = JSON.parse(raw) as Record<string, unknown>;
  if (state.schema !== "openthrottle.loop-receipt-correction/v1" ||
      state.action_id !== input.actionId || state.attempt_id !== input.attemptId ||
      state.request_hash !== input.requestHash || !Array.isArray(state.diagnostics) ||
      typeof state.invalid_receipt_text !== "string") {
    throw new Error(`loop receipt correction state ${input.attemptId}/${input.actionId} is invalid`);
  }
}

function childExecutorActionPath(attemptId: string, actionId: string, name: string): string {
  safeStagePathId(attemptId, "child executor attempt ID");
  safeStagePathId(actionId, "child executor action ID");
  return `${CHILD_EXECUTOR_DIR}/${attemptId}/${actionId}/${name}`;
}

function shellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function childExecutorEnv(request: ChildExecutorActionRequest): string {
  return [
    "env -i",
    "HOME=/home/agent",
    "USER=agent",
    "LOGNAME=agent",
    "SHELL=/bin/bash",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    `OT_STAGE_CONFIG_FILE=${shellSingleQuoted(`${STAGE_INPUT_DIR}/repository-config.json`)}`,
    `RUN_ID=${shellSingleQuoted(request.parentRunId)}`,
    `OT_CHILD_ACTION_ID=${shellSingleQuoted(request.actionId)}`,
  ].join(" ");
}

function loopActionEnv(request: LoopActionRequest): string {
  return [
    "env -i",
    "HOME=/home/agent",
    "USER=agent",
    "LOGNAME=agent",
    "SHELL=/bin/bash",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ...(request.parentRunId ? [`RUN_ID=${shellSingleQuoted(request.parentRunId)}`] : []),
    `OT_CHILD_ACTION_ID=${shellSingleQuoted(request.actionId)}`,
  ].join(" ");
}

function parseCollectedStageResult(raw: string, attemptId: string): StageExecutionResult {
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) throw new Error("sealed stage result exceeds 64 KiB");
  const event = JSON.parse(raw) as Record<string, unknown>;
  if (event.kind !== "stage_result" || event.version !== 1 || event.attempt_id !== attemptId ||
      typeof event.request_hash !== "string" || !/^[a-f0-9]{64}$/.test(event.request_hash) ||
      !STAGE_OUTCOMES.includes(event.outcome as never) ||
      typeof event.created_at !== "string" || Number.isNaN(Date.parse(event.created_at)) ||
      (event.subject !== null && (typeof event.subject !== "string" || !/^[a-f0-9]{40,64}$/.test(event.subject))) ||
      (event.native_session_id !== null && typeof event.native_session_id !== "string") ||
      !Array.isArray(event.artifacts)) {
    throw new Error(`sealed stage result ${attemptId} has an invalid envelope`);
  }
  const artifacts = event.artifacts.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`sealed stage result artifact ${index} is invalid`);
    }
    const artifact = value as Record<string, unknown>;
    if (typeof artifact.kind !== "string" || !Number.isSafeInteger(artifact.schema_version) ||
        typeof artifact.assurance !== "string" ||
        (artifact.subject !== null && typeof artifact.subject !== "string") ||
        typeof artifact.payload !== "string" || typeof artifact.hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(artifact.hash) || digestNormalized(artifact.payload) !== artifact.hash) {
      throw new Error(`sealed stage result artifact ${index} is invalid`);
    }
    return {
      kind: artifact.kind as StageExecutionResult["artifacts"][number]["kind"],
      schemaVersion: artifact.schema_version as number,
      assurance: artifact.assurance as StageExecutionResult["artifacts"][number]["assurance"],
      subject: artifact.subject as string | null,
      payload: artifact.payload,
      hash: artifact.hash,
    };
  });
  return {
    attemptId,
    requestHash: event.request_hash,
    outcome: event.outcome as StageExecutionResult["outcome"],
    nativeSessionId: event.native_session_id as string | null,
    subject: event.subject as string | null,
    artifacts,
    completedAt: event.created_at,
  };
}

class PrivateRecoveryIntegrityError extends Error {
  constructor(readonly result: LoopActionResult) {
    super("private recovery artifact failed integrity validation");
  }
}

function parseCollectedLoopResult(raw: string, input: { attemptId: string; actionId: string; requestHash: string }): LoopActionResult {
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) throw new Error("sealed loop result exceeds 256 KiB");
  const event = JSON.parse(raw) as Record<string, unknown>;
  if (event.kind !== "loop_action_result" || event.version !== 1 || event.action_id !== input.actionId ||
      event.attempt_id !== input.attemptId || event.request_hash !== input.requestHash ||
      !["success", "failure", "needs_human", "retryable_infrastructure_failure"].includes(String(event.outcome)) ||
      typeof event.created_at !== "string" || Number.isNaN(Date.parse(event.created_at)) ||
      (event.subject !== null && (typeof event.subject !== "string" || !/^[a-f0-9]{40,64}$/.test(event.subject))) ||
      (event.native_session_id !== null && typeof event.native_session_id !== "string") ||
      typeof event.receipt !== "string" ||
      (event.codex_auth_json !== undefined &&
        (typeof event.codex_auth_json !== "string" || Buffer.byteLength(event.codex_auth_json, "utf8") > 65_536))) {
    throw new Error(`sealed loop result ${input.attemptId}/${input.actionId} has an invalid envelope`);
  }
  const baseResult: LoopActionResult = {
    actionId: input.actionId,
    attemptId: event.attempt_id as string,
    requestHash: event.request_hash as string,
    outcome: event.outcome as LoopActionResult["outcome"],
    nativeSessionId: event.native_session_id as string | null,
    subject: event.subject as string | null,
    receipt: event.receipt as string,
    completedAt: event.created_at as string,
    ...(typeof event.codex_auth_json === "string" ? { codexAuthJson: event.codex_auth_json } : {}),
  };
  let recoveryArtifact: string | null = null;
  if (event.recovery_artifact !== undefined) {
    try {
      if (typeof event.recovery_artifact !== "string" ||
          Buffer.byteLength(event.recovery_artifact, "utf8") > 128 * 1024) {
        throw new Error(`sealed loop result ${input.attemptId}/${input.actionId} has an invalid recovery artifact`);
      }
      const artifact = parseLoopReceiptRecoveryContract(JSON.parse(event.recovery_artifact), {
        source: `sealed_loop_result.${input.attemptId}.${input.actionId}.recovery_artifact`,
      }).value as unknown as Record<string, unknown>;
      if (artifact.action_id !== input.actionId || artifact.attempt_id !== input.attemptId ||
          artifact.request_hash !== input.requestHash) {
        throw new Error(`sealed loop result ${input.attemptId}/${input.actionId} has an invalid recovery artifact fence`);
      }
      recoveryArtifact = event.recovery_artifact;
    } catch {
      throw new PrivateRecoveryIntegrityError(baseResult);
    }
  }
  return {
    ...baseResult,
    ...(recoveryArtifact ? { recoveryArtifact } : {}),
  };
}

async function materializePrivateRecoveryPayload(
  sandbox: Sandbox,
  result: LoopActionResult,
  input: { attemptId: string; actionId: string; requestHash: string },
): Promise<LoopActionResult> {
  if (!result.recoveryArtifact) return result;
  const artifact = JSON.parse(result.recoveryArtifact) as Record<string, unknown>;
  if (artifact.diff_payload === undefined) return result;
  if (!artifact.diff_payload || typeof artifact.diff_payload !== "object" || Array.isArray(artifact.diff_payload)) {
    throw new Error(`sealed loop result ${input.attemptId}/${input.actionId} has an invalid recovery diff payload`);
  }
  const descriptor = artifact.diff_payload as Record<string, unknown>;
  const descriptorKeys = Object.keys(descriptor).sort();
  if (descriptorKeys.join(",") !== "bytes,file,sha256" ||
      descriptor.file !== PRIVATE_RECOVERY_DIFF_FILE ||
      !Number.isSafeInteger(descriptor.bytes) || Number(descriptor.bytes) < 1 ||
      Number(descriptor.bytes) > MAX_PRIVATE_RECOVERY_DIFF_BYTES ||
      typeof descriptor.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(descriptor.sha256) ||
      artifact.diff_encoding !== "gzip+git-diff" || artifact.diff_base64 !== null ||
      artifact.diff_truncated !== false || !Number.isSafeInteger(artifact.diff_bytes) ||
      Number(artifact.diff_bytes) <= 48 * 1024 || Number(artifact.diff_bytes) > MAX_PRIVATE_RECOVERY_DIFF_BYTES) {
    throw new Error(`sealed loop result ${input.attemptId}/${input.actionId} has an invalid recovery diff payload`);
  }
  const payload = await sandbox.fs.downloadFile(
    loopActionPath(input.attemptId, input.actionId, PRIVATE_RECOVERY_DIFF_FILE)
  );
  if (!payload || payload.byteLength !== descriptor.bytes ||
      createHash("sha256").update(payload).digest("hex") !== descriptor.sha256) {
    throw new Error(`sealed loop result ${input.attemptId}/${input.actionId} recovery diff payload does not match its fence`);
  }
  let uncompressed: Buffer;
  try {
    uncompressed = gunzipSync(payload, { maxOutputLength: MAX_PRIVATE_RECOVERY_DIFF_BYTES });
  } catch {
    throw new Error(`sealed loop result ${input.attemptId}/${input.actionId} recovery diff payload is not bounded gzip`);
  }
  if (uncompressed.byteLength !== artifact.diff_bytes) {
    throw new Error(`sealed loop result ${input.attemptId}/${input.actionId} recovery diff payload length does not match its fence`);
  }
  if (createHash("sha256").update(uncompressed).digest("hex") !== artifact.diff_sha256) {
    throw new Error(`sealed loop result ${input.attemptId}/${input.actionId} recovery diff payload content does not match its fence`);
  }
  const { diff_payload: _externalPayload, ...portableArtifact } = artifact;
  const recoveryArtifact = parseLoopReceiptRecoveryContract({
    ...portableArtifact,
    diff_base64: null,
    private_payload: {
      schema: "openthrottle.execution-work-private-artifact/v1",
      encoding: "gzip+git-diff",
      bytes: descriptor.bytes,
      sha256: descriptor.sha256,
    },
    source_manifest_sha256: createHash("sha256").update(result.recoveryArtifact).digest("hex"),
  }, { source: `materialized_recovery.${input.attemptId}.${input.actionId}` }).normalized;
  return { ...result, recoveryArtifact, recoveryPayload: payload };
}

function preserveWorkspaceForRecoveryFailure(
  result: LoopActionResult,
  input: { attemptId: string; actionId: string; requestHash: string }
): LoopActionResult {
  const recoveryArtifact = parseLoopReceiptRecoveryContract({
    schema: "openthrottle.loop-receipt-recovery/v1",
    action_id: input.actionId,
    attempt_id: input.attemptId,
    request_hash: input.requestHash,
    subject: result.subject,
    recovery_subject: result.subject,
    requires_workspace_preservation: true,
    error: "private recovery payload could not be verified; inspect the preserved workspace",
  }, { source: `recovery_preservation.${input.attemptId}.${input.actionId}` }).normalized;
  return {
    ...result,
    outcome: "needs_human",
    receipt: `${result.receipt} private recovery payload could not be verified; workspace preservation required`
      .slice(0, 128_000),
    recoveryArtifact,
    recoveryPayload: null,
  };
}

function parseCollectedChildExecutorResult(
  raw: string,
  input: { attemptId: string; actionId: string; requestHash: string }
): ChildExecutorActionResult {
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) throw new Error("sealed child executor result exceeds 256 KiB");
  const event = JSON.parse(raw) as Record<string, unknown>;
  if (event.kind !== "child_executor_action_result" || event.version !== 1 || event.action_id !== input.actionId ||
      event.attempt_id !== input.attemptId || event.request_hash !== input.requestHash ||
      !["success", "failure", "needs_human", "retryable_infrastructure_failure"].includes(String(event.outcome)) ||
      typeof event.created_at !== "string" || Number.isNaN(Date.parse(event.created_at)) ||
      (event.subject !== null && (typeof event.subject !== "string" || !/^[a-f0-9]{40,64}$/.test(event.subject))) ||
      typeof event.receipt !== "string") {
    throw new Error(`sealed child executor result ${input.attemptId}/${input.actionId} has an invalid envelope`);
  }
  return {
    actionId: input.actionId,
    attemptId: event.attempt_id as string,
    requestHash: event.request_hash as string,
    outcome: event.outcome as ChildExecutorActionResult["outcome"],
    subject: event.subject as string | null,
    receipt: event.receipt as string,
    completedAt: event.created_at as string,
  };
}

/**
 * Provider-specific implementation of the stage runtime boundary. Pipeline
 * state sees only RuntimeResource opaque IDs; all Daytona IDs, sessions,
 * filesystem paths, and environment mutation remain inside this adapter.
 */
export function createDaytonaSandboxRuntime(
  daytona: Daytona,
  options: DaytonaSandboxRuntimeOptions
): RuntimeControl {
  const materializedScopes = new Map<string, string>();
  const bootstrapped = new Map<string, { configDigest: string; manifestDigest: string }>();
  const sandboxRootTraversalGranted = new Set<string>();
  const getSandbox = async (resource: RuntimeResource) => daytona.get(resource.providerResourceId);
  const ensureStarted = async (resource: RuntimeResource) => {
    const sandbox = await getSandbox(resource);
    if (sandbox.state !== "started") await sandbox.start(60);
    await ensureSandboxActive(sandbox);
    return sandbox;
  };
  // Belt-and-braces alongside the runner's own traversal grant
  // (ensureCurrentActionTraversal / prepareWorktreeRoot): stamp the sandbox
  // root itself traversable, ahead of every root:root 0700 child folder this
  // adapter creates under it. MkdirAll-style folder creation stamps the same
  // mode on every parent it creates, so an 0700 child created before this
  // ever ran would otherwise leave OPENTHROTTLE_ROOT itself untraversable to
  // the agent uid -- the exact OPE-101 trap this closes off at the source.
  const prepareSandboxRootTraversal = async (sandbox: Sandbox) => {
    // The grant is idempotent but each call is two Daytona API round-trips;
    // prepareRootFolder runs on every stage/loop-action/child-executor
    // dispatch for the sandbox's whole lifetime, so skip the repeat once a
    // sandbox's root is already known-traversable (mirrors the `bootstrapped`
    // / `materializedScopes` per-resource memoization above).
    if (sandboxRootTraversalGranted.has(sandbox.id)) return;
    await sandbox.fs.createFolder(OPENTHROTTLE_ROOT, "711").catch(() => undefined);
    await sandbox.fs.setFilePermissions(OPENTHROTTLE_ROOT, { owner: "root", group: "root", mode: "711" });
    sandboxRootTraversalGranted.add(sandbox.id);
  };
  const prepareRootFolder = async (sandbox: Sandbox, path: string) => {
    await prepareSandboxRootTraversal(sandbox);
    await sandbox.fs.createFolder(path, "700").catch(() => undefined);
    await sandbox.fs.setFilePermissions(path, { owner: "root", group: "root", mode: "700" });
  };
  const executeSandboxCommand = async (sandbox: Sandbox, command: string, timeoutSeconds: number) => {
    if (!sandbox.process?.executeCommand) throw new Error("Daytona runtime does not expose process command execution");
    const result = await sandbox.process.executeCommand(command, "/home/agent/repo", {}, timeoutSeconds);
    if (result.exitCode !== undefined && result.exitCode !== 0) {
      throw new Error(`sandbox command failed with exit ${result.exitCode}`);
    }
    return result;
  };
  const prepareStageInput = async (sandbox: Sandbox, request: StageRequestEnvelope): Promise<string> => {
    const requestDirectory = `${STAGE_INPUT_DIR}/requests`;
    await prepareRootFolder(sandbox, requestDirectory);
    const requestPath = `${requestDirectory}/${request.attemptId}.json`;
    await sandbox.fs.uploadFile(Buffer.from(canonicalJson(request)), requestPath);
    await sandbox.fs.setFilePermissions(requestPath, { owner: "root", group: "root", mode: "400" });
    await sandbox.updateEnv({
      OT_STAGE_REQUEST_FILE: requestPath,
      OT_STAGE_CONFIG_FILE: `${STAGE_INPUT_DIR}/repository-config.json`,
      OT_STAGE_MANIFEST_FILE: `${STAGE_INPUT_DIR}/pipeline-manifest.json`,
      TASK_TYPE: request.taskType,
      GITHUB_REPO: request.repository,
      BASE_BRANCH: request.baseBranch,
      BRANCH_NAME: request.branch,
      AGENT: request.agent,
      RUN_ID: request.runId,
      ...(request.childActionId ? { OT_CHILD_ACTION_ID: request.childActionId } : {}),
      LINEAR_ISSUE_ID: request.issueId,
      LINEAR_ISSUE_IDENTIFIER: request.issueId,
    }, { unset: request.childActionId ? ["OT_COMPOSITE_PREPARE_ONLY"] : ["OT_CHILD_ACTION_ID", "OT_COMPOSITE_PREPARE_ONLY"] });
    return requestPath;
  };

  return {
    async provision(input) {
      const identity = digestNormalized(canonicalJson({
        idempotencyKey: input.idempotencyKey,
        repository: input.repository,
        baseCommit: input.baseCommit,
        runtimeRelease: input.runtimeRelease,
      }));
      for await (const existing of daytona.list({
        labels: { openthrottle: "true", "stage-runtime": "true", identity },
      })) {
        return { providerResourceId: existing.id };
      }
      const sandbox = await daytona.create({
        snapshot: options.snapshot,
        envVars: {},
        labels: { openthrottle: "true", "stage-runtime": "true", identity },
        public: false,
        autoStopInterval: ACTIVE_SANDBOX_AUTOSTOP_MINUTES,
        autoDeleteInterval: -1,
      });
      return { providerResourceId: sandbox.id };
    },

    async bootstrap(resource, input) {
      if (digestNormalized(input.sealedRepositoryConfig) !== input.configDigest) {
        throw new Error("repository config bootstrap digest mismatch");
      }
      if (digestNormalized(input.normalizedManifest) !== input.manifestDigest) {
        throw new Error("pipeline manifest bootstrap digest mismatch");
      }
      const prior = bootstrapped.get(resource.providerResourceId);
      if (prior) {
        if (prior.configDigest !== input.configDigest || prior.manifestDigest !== input.manifestDigest) {
          throw new Error("sandbox was already bootstrapped with different sealed inputs");
        }
        return;
      }
      const sandbox = await ensureStarted(resource);
      await prepareRootFolder(sandbox, STAGE_INPUT_DIR);
      const files: Array<[Buffer, string]> = [
        [Buffer.from(input.sealedRepositoryConfig), `${STAGE_INPUT_DIR}/repository-config.json`],
        [Buffer.from(input.normalizedManifest), `${STAGE_INPUT_DIR}/pipeline-manifest.json`],
      ];
      for (const [content, path] of files) {
        await sandbox.fs.uploadFile(content, path);
        await sandbox.fs.setFilePermissions(path, { owner: "root", group: "root", mode: "400" });
      }
      await prepareRootFolder(sandbox, STAGE_RESULT_DIR);
      bootstrapped.set(resource.providerResourceId, {
        configDigest: input.configDigest,
        manifestDigest: input.manifestDigest,
      });
    },

    async materializeCredentials(resource, scopes) {
      const canonicalScopes = canonicalJson([...new Set(scopes)].sort());
      if (canonicalScopes !== canonicalJson(scopes)) throw new Error("credential scopes are not canonical");
      const sandbox = await ensureStarted(resource);
      const materialization = await options.materializeCredentialEnv(resource, scopes);
      assertSandboxCredentialEnv(materialization.env, "stage credentials");
      const invalidUnset = (materialization.unset ?? []).find((name) => !STAGE_CREDENTIAL_ENV.has(name));
      if (invalidUnset) throw new Error(`credential provider tried to unset forbidden variable ${invalidUnset}`);
      const conflicting = (materialization.unset ?? []).find((name) => name in materialization.env);
      if (conflicting) throw new Error(`credential provider both set and unset ${conflicting}`);
      const unset = [...new Set([
        ...(materialization.unset ?? []),
        ...[...STAGE_CREDENTIAL_ENV].filter((name) => !(name in materialization.env)),
      ])].sort();
      await sandbox.updateEnv(materialization.env, { unset });
      materializedScopes.set(resource.providerResourceId, canonicalScopes);
    },

    async dispatchStage(resource, request) {
      assertStageRequestFence(request);
      if (materializedScopes.get(resource.providerResourceId) !== canonicalJson(request.credentialScopes)) {
        throw new Error(`stage ${request.attemptId} credentials were not materialized for the exact requested scopes`);
      }
      const bootstrap = bootstrapped.get(resource.providerResourceId);
      if (!bootstrap || bootstrap.configDigest !== request.repositoryConfigDigest ||
          bootstrap.manifestDigest !== request.manifestDigest) {
        throw new Error(`stage ${request.attemptId} does not match the sandbox bootstrap`);
      }
      const sandbox = await ensureStarted(resource);
      await prepareStageInput(sandbox, request);
      const sessionId = `stage-${request.attemptId}`;
      await sandbox.process.createSession(sessionId).catch(() => undefined);
      const dispatched = await sandbox.process.executeSessionCommand(sessionId, {
        // The deterministic provider session name is not sufficient on its
        // own: a supervisor crash after dispatch but before acknowledgement
        // can replay the effect. Check the result while holding the root-owned
        // attempt lock so both concurrent and just-after-completion replays are
        // no-ops.
        command: `flock --nonblock ${STAGE_RESULT_DIR}/${request.attemptId}.lock sh -c ` +
          `'test -f ${STAGE_RESULT_DIR}/${request.attemptId}.json || exec /opt/openthrottle/entrypoint.sh'`,
        runAsync: true,
        suppressInputEcho: true,
      }, options.taskTimeoutSeconds ?? 7_200);
      return { providerDispatchId: dispatched.cmdId ?? sessionId };
    },

    async prepareCompositeWorkspace(resource, request) {
      assertStageRequestFence(request);
      if (materializedScopes.get(resource.providerResourceId) !== canonicalJson(request.credentialScopes)) {
        throw new Error(`composite stage ${request.attemptId} credentials were not materialized for the exact requested scopes`);
      }
      const bootstrap = bootstrapped.get(resource.providerResourceId);
      if (!bootstrap || bootstrap.configDigest !== request.repositoryConfigDigest ||
          bootstrap.manifestDigest !== request.manifestDigest) {
        throw new Error(`composite stage ${request.attemptId} does not match the sandbox bootstrap`);
      }
      const sandbox = await ensureStarted(resource);
      await prepareStageInput(sandbox, request);
      await sandbox.updateEnv({ OT_COMPOSITE_PREPARE_ONLY: "1" }, { unset: [] });
      const marker = `${STAGE_RESULT_DIR}/${request.attemptId}.composite-prepared`;
      const sessionId = `composite-prepare-${request.attemptId}`;
      await sandbox.process?.createSession?.(sessionId).catch(() => undefined);
      if (!sandbox.process?.executeSessionCommand) {
        throw new Error("Daytona runtime does not expose session command execution");
      }
      const prepared = await sandbox.process.executeSessionCommand(sessionId, {
        command: `flock --nonblock ${STAGE_RESULT_DIR}/${request.attemptId}.prepare.lock sh -c ` +
          shellSingleQuoted(`test -f ${marker} || (OT_COMPOSITE_PREPARE_ONLY=1 /opt/openthrottle/entrypoint.sh && install -o root -g root -m 0400 /dev/null ${marker})`),
        runAsync: false,
        suppressInputEcho: true,
      }, options.taskTimeoutSeconds ?? 7_200);
      if (prepared.exitCode !== undefined && prepared.exitCode !== 0) {
        throw new Error(`composite workspace preparation failed with exit ${prepared.exitCode}`);
      }
    },

    async collectStageResult(resource, attemptId) {
      safeStagePathId(attemptId, "stage attempt ID");
      const sandbox = await getSandbox(resource);
      try {
        const raw = (await sandbox.fs.downloadFile(`${STAGE_RESULT_DIR}/${attemptId}.json`)).toString("utf8");
        return parseCollectedStageResult(raw, attemptId);
      } catch (error) {
        if (String(error).toLowerCase().includes("not found")) return null;
        throw error;
      }
    },

    async createWorktree(resource, input) {
      safeStagePathId(input.attemptId, "loop attempt ID");
      if (!/^[a-f0-9]{40}$/.test(input.baseCommit)) throw new Error("worktree base commit is invalid");
      const sandbox = await ensureStarted(resource);
      const handle: RuntimeWorktreeHandle = {
        id: digestNormalized(canonicalJson({
          idempotencyKey: input.idempotencyKey,
          attemptId: input.attemptId,
          baseCommit: input.baseCommit,
        })).slice(0, 32),
      };
      await executeSandboxCommand(
        sandbox,
        `/opt/openthrottle/runner/worktrees.mjs create --idempotent --handle ${shellSingleQuoted(handle.id)} --base ${shellSingleQuoted(input.baseCommit)}`,
        120
      );
      return handle;
    },

    async dispatchLoopAction(resource, request) {
      assertLoopRequestFence(request);
      assertLogicalCredentialScopes(request.credentialScopes);
      const sandbox = await ensureStarted(resource);
      // Each action materializes its own declared credentials from a clean
      // baseline rather than inheriting whatever the whole-attempt stage
      // credentials happen to be; the sandbox clears its inherited
      // environment and applies only this sealed envelope (execute-loop.mjs).
      // Pass the action's own agent explicitly: a graph worker can override
      // the ticket's default engine (e.g. a Codex action in a Claude
      // ticket), and the materializer must select that action's credential,
      // not whatever the ticket-level default happens to be.
      const credentialMaterialization = await options.materializeCredentialEnv(
        resource,
        request.credentialScopes,
        request.agent
      );
      assertSandboxCredentialEnv(credentialMaterialization.env, `loop action ${request.actionId}`);
      const actionDirectory = `${LOOP_ACTION_DIR}/${request.attemptId}/${request.actionId}`;
      const requestPath = loopActionPath(request.attemptId, request.actionId, "request.json");
      const credentialsPath = loopActionPath(request.attemptId, request.actionId, "credentials.json");
      const resultPath = loopActionPath(request.attemptId, request.actionId, "result.json");
      await prepareRootFolder(sandbox, LOOP_DISPATCH_DIR);
      // Dispatch-unique (not just action-unique) staging paths: a concurrent
      // redispatch of the same action must never stage over, or clean up,
      // another in-flight dispatch's uploads. Two calls that lose the race
      // for `lockPath` only ever touch their own nonce'd files, so the
      // winner's in-progress `cp` below can never be deleted out from under
      // it. `lockPath` itself stays action-scoped (no nonce) so it still
      // serializes concurrent dispatches of the exact same action.
      const dispatchNonce = randomUUID();
      const stagedRequestPath = `${LOOP_DISPATCH_DIR}/${request.attemptId}.${request.actionId}.${dispatchNonce}.request.json`;
      const stagedCredentialsPath = `${LOOP_DISPATCH_DIR}/${request.attemptId}.${request.actionId}.${dispatchNonce}.credentials.json`;
      const lockPath = `${LOOP_DISPATCH_DIR}/${request.attemptId}.${request.actionId}.lock`;
      // Upload-then-chmod each file immediately, one at a time: a request
      // upload/chmod failure must leave the credentials file never staged at
      // all, not merely unreadable. Parallelizing these would let the
      // credentials leg finish (fully uploaded and chmod 400) even when the
      // request leg fails, and would widen each file's window between
      // upload and chmod while the other file's round trip is in flight.
      await sandbox.fs.uploadFile(Buffer.from(canonicalJson(request)), stagedRequestPath);
      await sandbox.fs.setFilePermissions(stagedRequestPath, { owner: "root", group: "root", mode: "400" });
      await sandbox.fs.uploadFile(
        Buffer.from(canonicalJson({ env: credentialMaterialization.env })),
        stagedCredentialsPath
      );
      await sandbox.fs.setFilePermissions(stagedCredentialsPath, { owner: "root", group: "root", mode: "400" });
      const sessionId = `loop-${request.actionId}`;
      if (!sandbox.process?.executeSessionCommand) {
        throw new Error("Daytona runtime does not expose session command execution");
      }
      await sandbox.process?.createSession?.(sessionId).catch(() => undefined);
      const cleanEnv = loopActionEnv(request);
      const dispatched = await sandbox.process.executeSessionCommand(sessionId, {
        command: `flock --nonblock ${lockPath} sh -c ` +
          shellSingleQuoted([
            // A redispatch of an already-completed action must not orphan the
            // credential envelope this call just uploaded fresh: no later
            // invocation will ever reach the terminal `rm -f` below to clean
            // it up, since none will run this script body again.
            `if test -f ${shellSingleQuoted(resultPath)}; then rm -f ${shellSingleQuoted(stagedCredentialsPath)} ${shellSingleQuoted(stagedRequestPath)}; exit 0; fi`,
            `install -d -o root -g root -m 0711 ${shellSingleQuoted(LOOP_ACTION_DIR)} ${shellSingleQuoted(`${LOOP_ACTION_DIR}/${request.attemptId}`)} ${shellSingleQuoted(actionDirectory)}`,
            `cp ${shellSingleQuoted(stagedRequestPath)} ${shellSingleQuoted(requestPath)}`,
            `cp ${shellSingleQuoted(stagedCredentialsPath)} ${shellSingleQuoted(credentialsPath)}`,
            `chown root:root ${shellSingleQuoted(requestPath)} ${shellSingleQuoted(credentialsPath)}`,
            `chmod 400 ${shellSingleQuoted(requestPath)} ${shellSingleQuoted(credentialsPath)}`,
            `rm -f ${shellSingleQuoted(stagedCredentialsPath)}`,
            `${cleanEnv} /opt/openthrottle/runner/heartbeat.mjs & heartbeat_pid=$!`,
            `trap 'kill "$heartbeat_pid" 2>/dev/null || true' EXIT INT TERM`,
            `set +e; ${cleanEnv} /opt/openthrottle/runner/execute-loop.mjs --request ${shellSingleQuoted(requestPath)} --credentials ${shellSingleQuoted(credentialsPath)} --output ${shellSingleQuoted(resultPath)}; status=$?; kill "$heartbeat_pid" 2>/dev/null || true; wait "$heartbeat_pid" 2>/dev/null || true; exit "$status"`,
          ].join(" && ")) +
          // A losing `flock --nonblock` (another dispatch for this exact
          // action already holds it) exits nonzero without ever running the
          // body above, so this call's own freshly-uploaded staged files
          // would otherwise never be cleaned up by anyone. Remove them here
          // instead of leaving real credential material parked in
          // LOOP_DISPATCH_DIR indefinitely.
          ` || rm -f ${shellSingleQuoted(stagedCredentialsPath)} ${shellSingleQuoted(stagedRequestPath)}`,
        runAsync: true,
        suppressInputEcho: true,
      }, loopActionDispatchTimeoutSeconds(request.timeoutMs));
      return { providerDispatchId: dispatched.cmdId ?? sessionId };
    },

    async collectLoopActionResult(resource, input) {
      safeStagePathId(input.attemptId, "loop attempt ID");
      safeStagePathId(input.actionId, "loop action ID");
      if (!/^[a-f0-9]{64}$/.test(input.requestHash)) throw new Error("loop request hash is invalid");
      const sandbox = await getSandbox(resource);
      let raw: string;
      try {
        raw = (await sandbox.fs.downloadFile(loopActionPath(input.attemptId, input.actionId, "result.json"))).toString("utf8");
      } catch (error) {
        if (String(error).toLowerCase().includes("not found")) {
          let correctionState: string;
          try {
            correctionState = (await sandbox.fs.downloadFile(
              loopActionPath(input.attemptId, input.actionId, "receipt-correction.json")
            )).toString("utf8");
          } catch (correctionError) {
            if (String(correctionError).toLowerCase().includes("not found")) return null;
            throw correctionError;
          }
          assertReceiptCorrectionState(correctionState, input);
          const activeSandbox = await ensureStarted(resource);
          if (!activeSandbox.process?.executeSessionCommand) {
            throw new Error("Daytona runtime does not expose session command execution");
          }
          const sessionId = `loop-correction-${input.actionId}`;
          await activeSandbox.process.createSession?.(sessionId).catch(() => undefined);
          const requestPath = loopActionPath(input.attemptId, input.actionId, "request.json");
          const credentialsPath = loopActionPath(input.attemptId, input.actionId, "credentials.json");
          const resultPath = loopActionPath(input.attemptId, input.actionId, "result.json");
          const lockPath = `${LOOP_DISPATCH_DIR}/${input.attemptId}.${input.actionId}.lock`;
          const cleanEnv = [
            "env -i",
            "HOME=/home/agent",
            "USER=agent",
            "LOGNAME=agent",
            "SHELL=/bin/bash",
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            `OT_CHILD_ACTION_ID=${shellSingleQuoted(input.actionId)}`,
          ].join(" ");
          await activeSandbox.process.executeSessionCommand(sessionId, {
            command: `flock --nonblock ${lockPath} sh -c ` + shellSingleQuoted(
              `if test ! -f ${shellSingleQuoted(resultPath)}; then ` +
              `${cleanEnv} /opt/openthrottle/runner/execute-loop.mjs ` +
              `--request ${shellSingleQuoted(requestPath)} --credentials ${shellSingleQuoted(credentialsPath)} ` +
              `--output ${shellSingleQuoted(resultPath)}; fi`
            ),
            runAsync: true,
            suppressInputEcho: true,
          }, loopActionDispatchTimeoutSeconds(30_000));
          return null;
        }
        throw error;
      }
      // Once the sealed result exists, a referenced recovery payload is part
      // of that result. A missing/malformed payload is an integrity failure,
      // never evidence that the action result itself is merely pending.
      let parsed: LoopActionResult;
      try {
        parsed = parseCollectedLoopResult(raw, input);
      } catch (error) {
        if (error instanceof PrivateRecoveryIntegrityError) {
          return preserveWorkspaceForRecoveryFailure(error.result, input);
        }
        throw error;
      }
      try {
        return await materializePrivateRecoveryPayload(sandbox, parsed, input);
      } catch {
        return preserveWorkspaceForRecoveryFailure(parsed, input);
      }
    },

    async dispatchChildExecutorAction(resource, request) {
      assertChildExecutorRequestFence(request);
      const sandbox = await ensureStarted(resource);
      const actionDirectory = `${CHILD_EXECUTOR_DIR}/${request.attemptId}/${request.actionId}`;
      const requestPath = childExecutorActionPath(request.attemptId, request.actionId, "request.json");
      const resultPath = childExecutorActionPath(request.attemptId, request.actionId, "result.json");
      await prepareRootFolder(sandbox, CHILD_EXECUTOR_DISPATCH_DIR);
      const dispatchNonce = randomUUID();
      const stagedRequestPath =
        `${CHILD_EXECUTOR_DISPATCH_DIR}/${request.attemptId}.${request.actionId}.${dispatchNonce}.request.json`;
      const lockPath = `${CHILD_EXECUTOR_DISPATCH_DIR}/${request.attemptId}.${request.actionId}.lock`;
      await sandbox.fs.uploadFile(Buffer.from(canonicalJson(request)), stagedRequestPath);
      await sandbox.fs.setFilePermissions(stagedRequestPath, { owner: "root", group: "root", mode: "400" });
      const sessionId = `child-executor-${request.actionId}`;
      if (!sandbox.process?.executeSessionCommand) {
        throw new Error("Daytona runtime does not expose session command execution");
      }
      await sandbox.process?.createSession?.(sessionId).catch(() => undefined);
      const cleanEnv = childExecutorEnv(request);
      const dispatched = await sandbox.process.executeSessionCommand(sessionId, {
        command: `flock --nonblock ${lockPath} sh -c ` +
          shellSingleQuoted([
            `if test -f ${shellSingleQuoted(resultPath)}; then rm -f ${shellSingleQuoted(stagedRequestPath)}; exit 0; fi`,
            `install -d -o root -g root -m 0711 ${shellSingleQuoted(CHILD_EXECUTOR_DIR)} ${shellSingleQuoted(`${CHILD_EXECUTOR_DIR}/${request.attemptId}`)} ${shellSingleQuoted(actionDirectory)}`,
            `cp ${shellSingleQuoted(stagedRequestPath)} ${shellSingleQuoted(requestPath)}`,
            `chown root:root ${shellSingleQuoted(requestPath)}`,
            `chmod 400 ${shellSingleQuoted(requestPath)}`,
            `rm -f ${shellSingleQuoted(stagedRequestPath)}`,
            `${cleanEnv} /opt/openthrottle/runner/heartbeat.mjs & heartbeat_pid=$!`,
            `trap 'kill "$heartbeat_pid" 2>/dev/null || true' EXIT INT TERM`,
            `set +e; ${cleanEnv} /opt/openthrottle/runner/execute-child-action.mjs --request ${shellSingleQuoted(requestPath)} --output ${shellSingleQuoted(resultPath)}; status=$?; kill "$heartbeat_pid" 2>/dev/null || true; wait "$heartbeat_pid" 2>/dev/null || true; exit "$status"`,
          ].join(" && ")) +
          ` || rm -f ${shellSingleQuoted(stagedRequestPath)}`,
        runAsync: true,
        suppressInputEcho: true,
      }, options.taskTimeoutSeconds ?? 7_200);
      return { providerDispatchId: dispatched.cmdId ?? sessionId };
    },

    async collectChildExecutorActionResult(resource, input) {
      safeStagePathId(input.attemptId, "child executor attempt ID");
      safeStagePathId(input.actionId, "child executor action ID");
      if (!/^[a-f0-9]{64}$/.test(input.requestHash)) throw new Error("child executor request hash is invalid");
      const sandbox = await getSandbox(resource);
      try {
        const raw = (await sandbox.fs.downloadFile(childExecutorActionPath(input.attemptId, input.actionId, "result.json"))).toString("utf8");
        return parseCollectedChildExecutorResult(raw, input);
      } catch (error) {
        if (String(error).toLowerCase().includes("not found")) return null;
        throw error;
      }
    },

    async cleanupWorktree(resource, handle) {
      safeStagePathId(handle.id, "worktree handle ID");
      const sandbox = await ensureStarted(resource);
      await executeSandboxCommand(
        sandbox,
        `/opt/openthrottle/runner/worktrees.mjs remove --handle '${handle.id}'`,
        120
      );
    },

    async renewLiveness(resource) {
      const sandbox = await getSandbox(resource);
      if (sandbox.state !== "started") throw new Error(`sandbox ${resource.providerResourceId} is not running`);
      return { observedAt: new Date().toISOString() };
    },

    async stop(resource) {
      const sandbox = await getSandbox(resource);
      if (sandbox.state !== "stopped") await sandbox.stop(60, true);
      return { confirmed: true };
    },

    async quarantine(resource, reason) {
      const sandbox = await getSandbox(resource);
      await sandbox.setLabels({ ...sandbox.labels, quarantined: "true", quarantine: digestNormalized(reason) });
      if (sandbox.state !== "stopped") await sandbox.stop(60, true);
    },

    async cleanup(resource) {
      try {
        const sandbox = await getSandbox(resource);
        await sandbox.delete(60, false);
      } catch (error) {
        if (!String(error).toLowerCase().includes("not found")) throw error;
      }
      materializedScopes.delete(resource.providerResourceId);
      bootstrapped.delete(resource.providerResourceId);
      sandboxRootTraversalGranted.delete(resource.providerResourceId);
    },

    async setActive(providerResourceId) {
      await setSandboxActive(daytona, providerResourceId);
    },

    async setIdle(providerResourceId) {
      await setSandboxIdle(daytona, providerResourceId);
    },

    async getWorkspace(providerResourceId) {
      return daytona.get(providerResourceId);
    },

    async getLogs(providerResourceId) {
      return getSandboxLogs(daytona, providerResourceId);
    },

    async stopResource(providerResourceId) {
      await stopSandbox(daytona, providerResourceId);
    },

    async listLabeledResources() {
      return listLabeledSandboxes(daytona);
    },

    async deleteResource(providerResourceId) {
      await deleteSandbox(daytona, providerResourceId);
    },

    async getSnapshot(name) {
      const snapshot = await daytona.snapshot.get(name);
      return { name: String(snapshot.name), state: String(snapshot.state) };
    },
  };
}

async function setSandboxActive(daytona: Daytona, sandboxId: string): Promise<void> {
  const sandbox = await daytona.get(sandboxId);
  await ensureSandboxActive(sandbox);
}

async function setSandboxIdle(daytona: Daytona, sandboxId: string): Promise<void> {
  const sandbox = await daytona.get(sandboxId);
  await ensureSandboxAutostop(sandbox, IDLE_SANDBOX_AUTOSTOP_MINUTES);
}

async function stopSandbox(daytona: Daytona, sandboxId: string): Promise<void> {
  const sandbox = await daytona.get(sandboxId);
  await sandbox.stop(60, true);
}

async function deleteSandbox(daytona: Daytona, sandboxId: string): Promise<void> {
  const sandbox = await daytona.get(sandboxId);
  await sandbox.delete(60, false);
}

async function getSandboxLogs(daytona: Daytona, sandboxId: string): Promise<string> {
  const sandbox = await daytona.get(sandboxId);
  if (sandbox.state !== "started") await sandbox.start(60);
  const logs = await sandbox.process.getEntrypointLogs();
  return logs.output ?? [logs.stdout, logs.stderr].filter(Boolean).join("\n");
}

async function listLabeledSandboxes(daytona: Daytona): Promise<RuntimeInventoryResource[]> {
  const sandboxes: RuntimeInventoryResource[] = [];
  for await (const sandbox of daytona.list({ labels: { openthrottle: "true" } })) {
    sandboxes.push({
      id: sandbox.id,
      state: sandbox.state,
      createdAt: sandbox.createdAt,
      labels: sandbox.labels,
      memory: sandbox.memory,
    });
  }
  return sandboxes;
}
