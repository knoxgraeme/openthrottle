import { Daytona, type Sandbox } from "@daytona/sdk";
import {
  type RuntimeResource,
  type RuntimeControl,
  type RuntimeInventoryResource,
  type RuntimeWorktreeHandle,
  type LoopActionRequest,
  type LoopActionResult,
  type StageExecutionResult,
} from "../../runtime/contracts.js";
import { canonicalJson, digestNormalized, STAGE_OUTCOMES } from "../../pipeline/manifest.js";
import {
  createStageRequestHash,
  type StageRequestEnvelope,
} from "../../pipeline/stage-request.js";

const ACTIVE_SANDBOX_AUTOSTOP_MINUTES = 60;
const IDLE_SANDBOX_AUTOSTOP_MINUTES = 5;
const STAGE_INPUT_DIR = "/var/lib/openthrottle/stage-input";
const STAGE_RESULT_DIR = "/var/lib/openthrottle/stage-results";
const LOOP_INPUT_DIR = "/var/lib/openthrottle/loop-input";
const LOOP_RESULT_DIR = "/var/lib/openthrottle/loop-results";
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
    scopes: readonly string[]
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
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} is not path-safe`);
  return value;
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
  safeStagePathId(request.runId, "loop parent run ID");
  const expectedHash = digestNormalized(canonicalJson({
    ...request,
    requestHash: undefined,
    idempotencyKey: undefined,
  }));
  const expectedKey = `loop:${request.attemptId}:${request.actionId}:${expectedHash}`;
  if (request.requestHash !== expectedHash || request.idempotencyKey !== expectedKey) {
    throw new Error(`loop action ${request.actionId} has a stale hash or idempotency key`);
  }
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

function parseCollectedLoopResult(raw: string, actionId: string): LoopActionResult {
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) throw new Error("sealed loop result exceeds 256 KiB");
  const event = JSON.parse(raw) as Record<string, unknown>;
  if (event.kind !== "loop_action_result" || event.version !== 1 || event.action_id !== actionId ||
      typeof event.attempt_id !== "string" || typeof event.request_hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(event.request_hash) ||
      !["success", "failure", "needs_human", "retryable_infrastructure_failure"].includes(String(event.outcome)) ||
      typeof event.created_at !== "string" || Number.isNaN(Date.parse(event.created_at)) ||
      (event.subject !== null && (typeof event.subject !== "string" || !/^[a-f0-9]{40,64}$/.test(event.subject))) ||
      (event.native_session_id !== null && typeof event.native_session_id !== "string") ||
      typeof event.receipt !== "string") {
    throw new Error(`sealed loop result ${actionId} has an invalid envelope`);
  }
  return {
    actionId,
    attemptId: event.attempt_id as string,
    requestHash: event.request_hash as string,
    outcome: event.outcome as LoopActionResult["outcome"],
    nativeSessionId: event.native_session_id as string | null,
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
  const getSandbox = async (resource: RuntimeResource) => daytona.get(resource.providerResourceId);
  const ensureStarted = async (resource: RuntimeResource) => {
    const sandbox = await getSandbox(resource);
    if (sandbox.state !== "started") await sandbox.start(60);
    await ensureSandboxActive(sandbox);
    return sandbox;
  };
  const prepareRootFolder = async (sandbox: Sandbox, path: string) => {
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
      const unknown = Object.keys(materialization.env).find((name) => !STAGE_CREDENTIAL_ENV.has(name));
      if (unknown) throw new Error(`credential provider returned forbidden sandbox variable ${unknown}`);
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
      }, { unset: request.childActionId ? [] : ["OT_CHILD_ACTION_ID"] });
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
        `/opt/openthrottle/runner/worktrees.mjs create --handle '${handle.id}' --base '${input.baseCommit}'`,
        120
      );
      return handle;
    },

    async dispatchLoopAction(resource, request) {
      assertLoopRequestFence(request);
      const sandbox = await ensureStarted(resource);
      await prepareRootFolder(sandbox, LOOP_INPUT_DIR);
      await prepareRootFolder(sandbox, LOOP_RESULT_DIR);
      const requestPath = `${LOOP_INPUT_DIR}/${request.actionId}.json`;
      await sandbox.fs.uploadFile(Buffer.from(canonicalJson(request)), requestPath);
      await sandbox.fs.setFilePermissions(requestPath, { owner: "root", group: "root", mode: "400" });
      await sandbox.updateEnv({
        RUN_ID: request.runId,
        OT_CHILD_ACTION_ID: request.actionId,
      }, { unset: [] });
      const sessionId = `loop-${request.actionId}`;
      if (!sandbox.process?.executeSessionCommand) {
        throw new Error("Daytona runtime does not expose session command execution");
      }
      await sandbox.process?.createSession?.(sessionId).catch(() => undefined);
      const dispatched = await sandbox.process.executeSessionCommand(sessionId, {
        command: `flock --nonblock ${LOOP_RESULT_DIR}/${request.actionId}.lock sh -c ` +
          `'test -f ${LOOP_RESULT_DIR}/${request.actionId}.json || ` +
          `(node /opt/openthrottle/runner/heartbeat.mjs & heartbeat=$!; ` +
          `trap "kill $heartbeat 2>/dev/null || true" EXIT; ` +
          `/opt/openthrottle/runner/execute-loop.mjs --request ${requestPath})'`,
        runAsync: true,
        suppressInputEcho: true,
      }, Math.ceil(request.timeoutMs / 1000));
      return { providerDispatchId: dispatched.cmdId ?? sessionId };
    },

    async collectLoopActionResult(resource, actionId) {
      safeStagePathId(actionId, "loop action ID");
      const sandbox = await getSandbox(resource);
      try {
        const raw = (await sandbox.fs.downloadFile(`${LOOP_RESULT_DIR}/${actionId}.json`)).toString("utf8");
        return parseCollectedLoopResult(raw, actionId);
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
