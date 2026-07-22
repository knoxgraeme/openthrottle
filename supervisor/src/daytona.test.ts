import type { Sandbox } from "@daytona/sdk";
import { describe, expect, it, vi } from "vitest";
import type { SandboxEnvContract } from "./daytona.js";
import { createDaytonaSandboxRuntime, findSandboxForTicket, startTask, toEnvVars } from "./daytona.js";
import { canonicalJson, digestNormalized } from "./pipeline-manifest.js";
import { STAGE_EXECUTOR_PROTOCOL, createStageRequestHash, type StageRequestEnvelope } from "./sandbox-runtime.js";

const baseEnv: SandboxEnvContract = {
  TASK_TYPE: "resume",
  AGENT: "claude",
  GITHUB_REPO: "owner/repo",
  GITHUB_TOKEN: "github",
  BASE_BRANCH: "main",
  BRANCH_NAME: "ot/test",
  LINEAR_ISSUE_ID: "issue",
  LINEAR_ISSUE_IDENTIFIER: "OT-1",
  RUN_ID: "run",
  RUN_CALLBACK_TOKEN: "callback",
  MAX_TURNS: "200",
  TASK_TIMEOUT: "7200",
  DEV_PORT: "3000",
};

describe("Daytona task execution", () => {
  it("filters undefined env and clears optional values left by prior tasks", async () => {
    expect(toEnvVars({ ...baseEnv, RESUME_MESSAGE: undefined })).not.toHaveProperty(
      "RESUME_MESSAGE"
    );
    const updateEnv = vi.fn(async () => undefined);
    const uploadFile = vi.fn(async () => undefined);
    const setFilePermissions = vi.fn(async () => undefined);
    const setAutostopInterval = vi.fn(async () => undefined);
    const execute = vi.fn(async () => undefined);
    const sandbox = {
      state: "started",
      autoStopInterval: 5,
      setAutostopInterval,
      updateEnv,
      fs: { uploadFile, setFilePermissions },
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: execute,
      },
    } as unknown as Sandbox;

    await startTask(sandbox, {
      env: baseEnv,
      linearContext: "# OT-1\n\nApproved plan",
      taskTimeoutSeconds: 60,
    });

    expect(updateEnv).toHaveBeenCalledWith(expect.any(Object), {
      unset: [
        "RESUME_MESSAGE",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CODEX_AUTH_JSON",
        "KIMI_CODE_API_KEY",
        "OT_GIT_AUTHOR_NAME",
        "OT_GIT_AUTHOR_EMAIL",
        "LINEAR_ACCESS_TOKEN",
        "LINEAR_MCP_API_KEY",
        "ANTHROPIC_API_KEY",
        "CODEX_API_KEY",
      ],
    });
    expect(uploadFile).toHaveBeenCalledWith(
      Buffer.from("# OT-1\n\nApproved plan"),
      "/home/agent/.ot/linear-context.md"
    );
    expect(setFilePermissions).toHaveBeenCalledWith(
      "/home/agent/.ot/linear-context.md",
      { owner: "agent", group: "agent", mode: "600" }
    );
    expect(setAutostopInterval).toHaveBeenCalledWith(60);
    expect(setAutostopInterval.mock.invocationCallOrder[0]).toBeLessThan(
      execute.mock.invocationCallOrder[0]
    );
    expect(execute).toHaveBeenCalledWith(
      "resume-run",
      {
        command: "/opt/openthrottle/entrypoint.sh",
        runAsync: true,
        suppressInputEcho: true,
      },
      60
    );
  });

  it("recovers a sandbox by its durable ticket labels", async () => {
    const sandbox = { id: "sandbox-existing" } as Sandbox;
    const daytona = {
      list: vi.fn(() =>
        (async function* () {
          yield sandbox;
        })()
      ),
    };

    await expect(findSandboxForTicket(daytona as never, "OT-1")).resolves.toBe(sandbox);
    expect(daytona.list).toHaveBeenCalledWith({
      labels: { openthrottle: "true", ticket: "OT-1" },
    });
  });

  it("waits for activation to settle before reporting a concurrent setup failure", async () => {
    let releaseActivation!: () => void;
    const activationReleased = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    let markActivationStarted!: () => void;
    const activationStarted = new Promise<void>((resolve) => {
      markActivationStarted = resolve;
    });
    const executeSessionCommand = vi.fn();
    const sandbox = {
      state: "started",
      autoStopInterval: 5,
      setAutostopInterval: vi.fn(async () => {
        markActivationStarted();
        await activationReleased;
      }),
      updateEnv: vi.fn(async () => {
        throw new Error("environment update failed");
      }),
      fs: {
        uploadFile: vi.fn(),
        setFilePermissions: vi.fn(),
      },
      process: {
        createSession: vi.fn(),
        executeSessionCommand,
      },
    } as unknown as Sandbox;

    const task = startTask(sandbox, {
      env: baseEnv,
      linearContext: "# OT-1",
      taskTimeoutSeconds: 60,
    });
    let rejected = false;
    void task.catch(() => {
      rejected = true;
    });
    await activationStarted;
    await Promise.resolve();
    expect(rejected).toBe(false);

    releaseActivation();
    await expect(task).rejects.toThrow("environment update failed");
    expect(executeSessionCommand).not.toHaveBeenCalled();
  });

  it("implements the opaque, fenced one-stage lifecycle without leaking provider details", async () => {
    const remoteFiles = new Map<string, Buffer>();
    const updateEnv = vi.fn(async () => undefined);
    const sandbox = {
      id: "provider-opaque-1",
      state: "started",
      autoStopInterval: 60,
      labels: { openthrottle: "true", "stage-runtime": "true" },
      setAutostopInterval: vi.fn(async () => undefined),
      updateEnv,
      setLabels: vi.fn(async () => ({})),
      stop: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      fs: {
        createFolder: vi.fn(async () => undefined),
        uploadFile: vi.fn(async (content: Buffer, path: string) => {
          remoteFiles.set(path, content);
        }),
        setFilePermissions: vi.fn(async () => undefined),
        downloadFile: vi.fn(async (path: string) => {
          const value = remoteFiles.get(path);
          if (!value) throw new Error("not found");
          return value;
        }),
      },
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(async () => ({ cmdId: "dispatch-opaque-1" })),
      },
    } as unknown as Sandbox;
    const list = vi.fn(() => (async function* () {})());
    const daytona = {
      list,
      create: vi.fn(async () => sandbox),
      get: vi.fn(async () => sandbox),
    };
    const credentialProvider = vi.fn(async () => ({ env: { GITHUB_TOKEN: "secret-token" } }));
    const runtime = createDaytonaSandboxRuntime(daytona as never, {
      snapshot: "snapshot-v1",
      materializeCredentialEnv: credentialProvider,
    });
    const resource = await runtime.provision({
      idempotencyKey: "provision:pipeline-1",
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      runtimeRelease: "snapshot/v1",
    });
    expect(resource).toEqual({ providerResourceId: "provider-opaque-1" });
    expect(daytona.create).toHaveBeenCalledWith(expect.objectContaining({
      public: false,
      labels: expect.not.objectContaining({ repository: "owner/repo" }),
    }));

    const sealedConfig = canonicalJson({ test: "npm test" });
    const manifest = canonicalJson({ id: "fixture", stages: [] });
    await runtime.bootstrap(resource, {
      sealedRepositoryConfig: sealedConfig,
      configDigest: digestNormalized(sealedConfig),
      normalizedManifest: manifest,
      manifestDigest: digestNormalized(manifest),
    });
    await runtime.materializeCredentials(resource, ["repo.read"]);
    expect(credentialProvider).toHaveBeenCalledWith(resource, ["repo.read"]);
    expect(updateEnv).toHaveBeenCalledWith({ GITHUB_TOKEN: "secret-token" }, {
      unset: ["CLAUDE_CODE_OAUTH_TOKEN", "CODEX_AUTH_JSON", "KIMI_CODE_API_KEY"],
    });

    const withoutFence: Omit<StageRequestEnvelope, "requestHash" | "idempotencyKey"> = {
      protocol: STAGE_EXECUTOR_PROTOCOL,
      pipelineInstanceId: "pipeline-1",
      manifestDigest: digestNormalized(manifest),
      runtimeRelease: "snapshot/v1",
      capabilityDigest: "b".repeat(64),
      repositoryConfigDigest: digestNormalized(sealedConfig),
      stageId: "command",
      attemptId: "attempt-1",
      runId: "run-1",
      issueId: "issue-1",
      sessionId: "session-1",
      generation: 1,
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      branch: "ot/issue-1",
      agent: "codex",
      contextRevision: 0,
      expectedSubject: null,
      contextPolicy: "none" as const,
      nativeSessionId: null,
      capability: "command/run@1",
      requiredArtifacts: ["stage_result" as const, "command_result" as const],
      credentialScopes: ["repo.read"],
      liveSteering: false,
      commandName: "test" as const,
    };
    const request = { ...withoutFence, ...createStageRequestHash(withoutFence) };
    await expect(runtime.dispatchStage(resource, request)).resolves.toEqual({
      providerDispatchId: "dispatch-opaque-1",
    });
    expect(sandbox.updateEnv).toHaveBeenLastCalledWith(expect.objectContaining({
      OT_STAGE_EXECUTION: "1",
      RUN_ID: "run-1",
    }), { unset: ["RUN_CALLBACK_TOKEN", "RESUME_MESSAGE"] });
    expect(JSON.stringify(updateEnv.mock.calls.at(-1))).not.toContain("secret-token");

    const artifactPayload = canonicalJson({ result: "success" });
    remoteFiles.set("/var/lib/openthrottle/stage-results/attempt-1.json", Buffer.from(JSON.stringify({
      version: 1,
      kind: "stage_result",
      attempt_id: "attempt-1",
      request_hash: request.requestHash,
      outcome: "success",
      native_session_id: null,
      subject: "c".repeat(40),
      created_at: "2026-07-22T00:00:00.000Z",
      artifacts: [{
        kind: "stage_result",
        schema_version: 1,
        assurance: "executor_verified",
        subject: "c".repeat(40),
        payload: artifactPayload,
        hash: digestNormalized(artifactPayload),
      }],
    })));
    await expect(runtime.collectStageResult(resource, "attempt-1")).resolves.toMatchObject({
      attemptId: "attempt-1",
      requestHash: request.requestHash,
      outcome: "success",
    });
    await expect(runtime.renewLiveness(resource, "attempt-1")).resolves.toEqual({
      observedAt: expect.any(String),
    });
    await expect(runtime.stop(resource, "test complete")).resolves.toEqual({ confirmed: true });
    await runtime.quarantine(resource, "stale subject");
    await runtime.cleanup(resource);
    expect(sandbox.delete).toHaveBeenCalledOnce();
  });

  it("refuses credentials outside the sandbox allowlist", async () => {
    const sandbox = {
      id: "provider-opaque-2",
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async () => undefined),
      updateEnv: vi.fn(async () => undefined),
    } as unknown as Sandbox;
    const runtime = createDaytonaSandboxRuntime({ get: vi.fn(async () => sandbox) } as never, {
      snapshot: "snapshot-v1",
      materializeCredentialEnv: vi.fn(async () => ({ env: { DAYTONA_API_KEY: "forbidden" } })),
    });
    await expect(runtime.materializeCredentials(
      { providerResourceId: "provider-opaque-2" },
      ["repo.read"]
    )).rejects.toThrow(/forbidden sandbox variable/);
    expect(sandbox.updateEnv).not.toHaveBeenCalled();
  });
});
