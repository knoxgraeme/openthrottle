import type { Daytona, Sandbox } from "@daytona/sdk";
import type { Config } from "./config.js";
import type { Agent, TaskType } from "./db.js";
import {
  createStageRequestHash,
  type RuntimeResource,
  type SandboxRuntime,
  type StageExecutionResult,
  type StageRequestEnvelope,
} from "./sandbox-runtime.js";
import { canonicalJson, digestNormalized, STAGE_OUTCOMES } from "./pipeline-manifest.js";

const ACTIVE_SANDBOX_AUTOSTOP_MINUTES = 60;
const IDLE_SANDBOX_AUTOSTOP_MINUTES = 5;
const STAGE_INPUT_DIR = "/var/lib/openthrottle/stage-input";
const STAGE_RESULT_DIR = "/var/lib/openthrottle/stage-results";
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

export interface SandboxEnvContract {
  TASK_TYPE: TaskType;
  AGENT: Agent;
  GITHUB_REPO: string;
  GITHUB_TOKEN: string;
  BASE_BRANCH: string;
  BRANCH_NAME: string;
  LINEAR_ISSUE_ID: string;
  LINEAR_ISSUE_IDENTIFIER: string;
  RUN_ID: string;
  RUN_CALLBACK_TOKEN: string;
  RESUME_MESSAGE?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  CODEX_AUTH_JSON?: string;
  KIMI_CODE_API_KEY?: string;
  OT_GIT_AUTHOR_NAME?: string;
  OT_GIT_AUTHOR_EMAIL?: string;
  MAX_TURNS: string;
  TASK_TIMEOUT: string;
  DEV_PORT: string;
}

export function toEnvVars(env: SandboxEnvContract): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function ensureSandboxAutostop(sandbox: Sandbox, minutes: number): Promise<void> {
  return sandbox.autoStopInterval === minutes
    ? Promise.resolve()
    : sandbox.setAutostopInterval(minutes);
}

export function ensureSandboxActive(sandbox: Sandbox): Promise<void> {
  return ensureSandboxAutostop(sandbox, ACTIVE_SANDBOX_AUTOSTOP_MINUTES);
}

export async function createForTicket(
  daytona: Daytona,
  cfg: Config,
  params: { issueIdentifier: string; env: SandboxEnvContract }
): Promise<Sandbox> {
  return daytona.create({
    snapshot: cfg.daytonaSnapshot,
    envVars: toEnvVars(params.env),
    labels: {
      openthrottle: "true",
      ticket: params.issueIdentifier,
    },
    public: false,
    autoStopInterval: ACTIVE_SANDBOX_AUTOSTOP_MINUTES,
    autoDeleteInterval: -1,
  });
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

/**
 * Provider-specific implementation of the stage runtime boundary. Pipeline
 * state sees only RuntimeResource opaque IDs; all Daytona IDs, sessions,
 * filesystem paths, and environment mutation remain inside this adapter.
 */
export function createDaytonaSandboxRuntime(
  daytona: Daytona,
  options: DaytonaSandboxRuntimeOptions
): SandboxRuntime {
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
        OT_STAGE_EXECUTION: "1",
        OT_STAGE_REQUEST_FILE: requestPath,
        OT_STAGE_CONFIG_FILE: `${STAGE_INPUT_DIR}/repository-config.json`,
        OT_STAGE_MANIFEST_FILE: `${STAGE_INPUT_DIR}/pipeline-manifest.json`,
        TASK_TYPE: request.capability === "ce/investigate@1" ? "investigate" : "implement",
        GITHUB_REPO: request.repository,
        BASE_BRANCH: request.baseCommit,
        BRANCH_NAME: request.branch,
        AGENT: request.agent,
        RUN_ID: request.runId,
        LINEAR_ISSUE_ID: request.issueId,
        LINEAR_ISSUE_IDENTIFIER: request.issueId,
      }, { unset: ["RUN_CALLBACK_TOKEN", "RESUME_MESSAGE"] });
      const sessionId = `stage-${request.attemptId}`;
      await sandbox.process.createSession(sessionId).catch(() => undefined);
      const dispatched = await sandbox.process.executeSessionCommand(sessionId, {
        command: "/opt/openthrottle/entrypoint.sh",
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
      const sandbox = await getSandbox(resource);
      await sandbox.delete(60, false);
      materializedScopes.delete(resource.providerResourceId);
      bootstrapped.delete(resource.providerResourceId);
    },
  };
}

export async function findSandboxForTicket(
  daytona: Daytona,
  issueIdentifier: string
): Promise<Sandbox | undefined> {
  for await (const sandbox of daytona.list({
    labels: { openthrottle: "true", ticket: issueIdentifier },
  })) {
    return sandbox;
  }
  return undefined;
}

export async function startTask(
  sandbox: Sandbox,
  params: {
    env: SandboxEnvContract;
    linearContext: string;
    taskTimeoutSeconds: number;
  }
): Promise<void> {
  if (sandbox.state !== "started") await sandbox.start(60);
  const envVars = toEnvVars(params.env);
  const optionalNames = [
    "RESUME_MESSAGE",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_AUTH_JSON",
    "KIMI_CODE_API_KEY",
    "OT_GIT_AUTHOR_NAME",
    "OT_GIT_AUTHOR_EMAIL",
  ] as const;
  const retiredSecretNames = [
    "LINEAR_ACCESS_TOKEN",
    "LINEAR_MCP_API_KEY",
    "ANTHROPIC_API_KEY",
    "CODEX_API_KEY",
  ] as const;
  const activateSandbox = ensureSandboxActive(sandbox);
  const [activationResult, envResult] = await Promise.allSettled([
    activateSandbox,
    sandbox.updateEnv(envVars, {
      unset: [
        ...optionalNames.filter((name) => params.env[name] === undefined),
        ...retiredSecretNames,
      ],
    }),
  ]);
  if (activationResult.status === "rejected") throw activationResult.reason;
  if (envResult.status === "rejected") throw envResult.reason;
  await sandbox.fs.uploadFile(
    Buffer.from(params.linearContext),
    "/home/agent/.ot/linear-context.md"
  );
  await sandbox.fs.setFilePermissions("/home/agent/.ot/linear-context.md", {
    owner: "agent",
    group: "agent",
    mode: "600",
  });

  const sessionId = `${params.env.TASK_TYPE}-${params.env.RUN_ID}`;
  await sandbox.process.createSession(sessionId);
  await sandbox.process.executeSessionCommand(
    sessionId,
    {
      command: "/opt/openthrottle/entrypoint.sh",
      runAsync: true,
      suppressInputEcho: true,
    },
    params.taskTimeoutSeconds
  );
}

export async function setSandboxActive(daytona: Daytona, sandboxId: string): Promise<void> {
  const sandbox = await daytona.get(sandboxId);
  await ensureSandboxActive(sandbox);
}

export async function setSandboxIdle(daytona: Daytona, sandboxId: string): Promise<void> {
  const sandbox = await daytona.get(sandboxId);
  await ensureSandboxAutostop(sandbox, IDLE_SANDBOX_AUTOSTOP_MINUTES);
}

export async function stopSandbox(daytona: Daytona, sandboxId: string): Promise<void> {
  const sandbox = await daytona.get(sandboxId);
  await sandbox.stop(60, true);
}

export async function deleteSandbox(daytona: Daytona, sandboxId: string): Promise<void> {
  const sandbox = await daytona.get(sandboxId);
  await sandbox.delete(60, false);
}

export async function getSignedPreviewUrl(
  daytona: Daytona,
  sandboxId: string,
  port: number
): Promise<string> {
  const sandbox = await daytona.get(sandboxId);
  if (sandbox.state !== "started") await sandbox.start(60);
  const preview = await sandbox.getSignedPreviewUrl(port, 5 * 60);
  return preview.url;
}

// listening — the dev server is serving (redirect to it); starting — it was
// down and has been (re)started (show a "starting" page that auto-refreshes);
// no-dev — down with no `dev:` command configured; unknown — could not probe
// (fall back to the plain redirect).
export type DevServerState = "listening" | "starting" | "no-dev" | "unknown";
export interface DevServerRevival {
  state: DevServerState;
  // The latest dev-server log tail, shown alongside the starting/no-dev pages
  // so the startup/crash error is visible instead of a blank connection refusal.
  log: string;
}

// Wakes the sandbox and runs restart-dev.sh, which probes the dev server on
// `port` and (re)starts it from the repo's `dev:` command if it is down — so a
// preview opened after the workspace idled brings the app back rather than
// dead-ending. Captures the dev log either way.
export async function reviveDevServer(
  daytona: Daytona,
  sandboxId: string,
  port: number
): Promise<DevServerRevival> {
  const sandbox = await daytona.get(sandboxId);
  if (sandbox.state !== "started") await sandbox.start(60);
  if (!sandbox.process?.executeCommand) return { state: "unknown", log: "" };
  const result = await sandbox.process.executeCommand(
    `bash /opt/openthrottle/runner/restart-dev.sh ${port}`,
    undefined,
    undefined,
    20
  );
  const output = result.result ?? "";
  const state = (output.match(/OT_DEV_STATUS:(listening|starting|no-dev)/)?.[1] ??
    "unknown") as DevServerState;
  const log = output.replace(/OT_DEV_STATUS:(?:listening|starting|no-dev)\r?\n?/, "");
  return { state, log };
}

export async function getSandboxLogs(daytona: Daytona, sandboxId: string): Promise<string> {
  const sandbox = await daytona.get(sandboxId);
  if (sandbox.state !== "started") await sandbox.start(60);
  const logs = await sandbox.process.getEntrypointLogs();
  return logs.output ?? [logs.stdout, logs.stderr].filter(Boolean).join("\n");
}

export async function listLabeledSandboxes(daytona: Daytona): Promise<Sandbox[]> {
  const sandboxes: Sandbox[] = [];
  for await (const sandbox of daytona.list({ labels: { openthrottle: "true" } })) {
    sandboxes.push(sandbox);
  }
  return sandboxes;
}
