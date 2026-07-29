import type { Sandbox } from "@daytona/sdk";
import { describe, expect, it, vi } from "vitest";
import { createDaytonaSandboxRuntime } from "./adapter.js";
import { canonicalJson, digestNormalized } from "../../pipeline/manifest.js";
import { STAGE_EXECUTOR_PROTOCOL, createStageRequestHash, type StageRequestEnvelope } from "../../pipeline/stage-request.js";

describe("Daytona stage execution", () => {
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
        executeCommand: vi.fn(async () => ({ exitCode: 0, result: "{}" })),
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
      taskType: "implement",
      taskContext: "Run the repository test fixture.",
      transitionContext: "",
      repository: "owner/repo",
      baseCommit: "a".repeat(40),
      baseBranch: "release/2.0",
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
      RUN_ID: "run-1",
      BASE_BRANCH: "release/2.0",
    }), { unset: ["OT_CHILD_ACTION_ID"] });

    const childWithoutFence: Omit<StageRequestEnvelope, "requestHash" | "idempotencyKey"> = {
      ...withoutFence,
      stageId: "child-implementation",
      attemptId: "attempt-child",
      runId: "run-parent",
      childActionId: "action-1",
    };
    const childRequest = { ...childWithoutFence, ...createStageRequestHash(childWithoutFence) };
    await expect(runtime.dispatchStage(resource, childRequest)).resolves.toEqual({
      providerDispatchId: "dispatch-opaque-1",
    });
    expect(sandbox.updateEnv).toHaveBeenLastCalledWith(expect.objectContaining({
      RUN_ID: "run-parent",
      OT_CHILD_ACTION_ID: "action-1",
    }), { unset: [] });
    expect(sandbox.process.executeSessionCommand).toHaveBeenCalledWith(
      "stage-attempt-1",
      expect.objectContaining({
        command: expect.stringMatching(/flock --nonblock .*attempt-1\.lock.*test -f .*attempt-1\.json/),
      }),
      expect.any(Number)
    );
    expect(JSON.stringify(updateEnv.mock.calls.at(-1))).not.toContain("secret-token");

    const worktree = await runtime.createWorktree(resource, {
      idempotencyKey: "worktree:attempt-child",
      attemptId: "attempt-child",
      baseCommit: "a".repeat(40),
    });
    expect(worktree).toEqual({ id: expect.stringMatching(/^[a-f0-9]{32}$/) });
    expect(sandbox.process.executeCommand).toHaveBeenCalledWith(
      expect.stringContaining("/opt/openthrottle/runner/worktrees.mjs create"),
      "/home/agent/repo",
      {},
      120
    );

    const loopWithoutFence = {
      protocol: "loop-action@1" as const,
      actionId: "loop-1",
      attemptId: "attempt-child",
      graphId: "graph-1",
      unitId: "unit-1",
      role: "worker" as const,
      loop: "implement" as const,
      agent: "codex" as const,
      skill: "ce-work",
      worktree,
      nativeSessionId: null,
      contextPolicy: "prefer_resume" as const,
      timeoutMs: 30_000,
      transitionContext: "implement unit",
      allowedMcpServers: ["github"],
      credentialScopes: ["model.invoke", "repo.read", "repo.write"],
      receiptSchema: "openthrottle.loop-receipt@1",
      requestHash: "",
      idempotencyKey: "",
    };
    const loopHash = digestNormalized(canonicalJson({
      ...loopWithoutFence,
      requestHash: undefined,
      idempotencyKey: undefined,
    }));
    const loopRequest = {
      ...loopWithoutFence,
      requestHash: loopHash,
      idempotencyKey: `loop:attempt-child:loop-1:${loopHash}`,
    };
    await expect(runtime.dispatchLoopAction(resource, loopRequest)).resolves.toEqual({
      providerDispatchId: "dispatch-opaque-1",
    });
    expect(sandbox.process.executeSessionCommand).toHaveBeenCalledWith(
      "loop-loop-1",
      expect.objectContaining({
        command: expect.stringContaining("/opt/openthrottle/runner/execute-loop.mjs"),
      }),
      30
    );

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
    remoteFiles.set("/var/lib/openthrottle/loop-results/loop-1.json", Buffer.from(JSON.stringify({
      version: 1,
      kind: "loop_action_result",
      action_id: "loop-1",
      attempt_id: "attempt-child",
      request_hash: loopRequest.requestHash,
      outcome: "success",
      native_session_id: "thread-1",
      subject: "d".repeat(40),
      receipt: "done",
      created_at: "2026-07-22T00:00:00.000Z",
    })));
    await expect(runtime.collectLoopActionResult(resource, "loop-1")).resolves.toMatchObject({
      actionId: "loop-1",
      attemptId: "attempt-child",
      outcome: "success",
    });
    await runtime.cleanupWorktree(resource, worktree);
    expect(sandbox.process.executeCommand).toHaveBeenLastCalledWith(
      expect.stringContaining("/opt/openthrottle/runner/worktrees.mjs remove"),
      "/home/agent/repo",
      {},
      120
    );
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

  it("passes bounded cleanup deadlines to Daytona stop, quarantine, and delete calls", async () => {
    const sandbox = {
      id: "provider-cleanup-bound",
      state: "started",
      labels: { openthrottle: "true" },
      stop: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      setLabels: vi.fn(async () => ({})),
    } as unknown as Sandbox;
    const runtime = createDaytonaSandboxRuntime({ get: vi.fn(async () => sandbox) } as never, {
      snapshot: "snapshot-v1",
      materializeCredentialEnv: vi.fn(async () => ({ env: {} })),
    });
    const resource = { providerResourceId: "provider-cleanup-bound" };

    await expect(runtime.stop(resource, "test stop")).resolves.toEqual({ confirmed: true });
    await expect(runtime.quarantine(resource, "test quarantine")).resolves.toBeUndefined();
    await expect(runtime.cleanup(resource)).resolves.toBeUndefined();
    await expect(runtime.stopResource("provider-cleanup-bound", "test reap")).resolves.toBeUndefined();
    await expect(runtime.deleteResource("provider-cleanup-bound")).resolves.toBeUndefined();

    expect(sandbox.stop).toHaveBeenNthCalledWith(1, 60, true);
    expect(sandbox.stop).toHaveBeenNthCalledWith(2, 60, true);
    expect(sandbox.stop).toHaveBeenNthCalledWith(3, 60, true);
    expect(sandbox.delete).toHaveBeenNthCalledWith(1, 60, false);
    expect(sandbox.delete).toHaveBeenNthCalledWith(2, 60, false);
  });

  it("treats not-found cleanup as already cleaned but propagates other cleanup errors", async () => {
    const notFound = {
      id: "provider-not-found",
      state: "stopped",
      delete: vi.fn(async () => {
        throw new Error("not found");
      }),
    } as unknown as Sandbox;
    const broken = {
      id: "provider-delete-timeout",
      state: "stopped",
      delete: vi.fn(async () => {
        throw new Error("delete timed out");
      }),
    } as unknown as Sandbox;
    const runtime = createDaytonaSandboxRuntime({
      get: vi.fn(async (id: string) => id === "provider-not-found" ? notFound : broken),
    } as never, {
      snapshot: "snapshot-v1",
      materializeCredentialEnv: vi.fn(async () => ({ env: {} })),
    });

    await expect(runtime.cleanup({ providerResourceId: "provider-not-found" }))
      .resolves.toBeUndefined();
    await expect(runtime.cleanup({ providerResourceId: "provider-delete-timeout" }))
      .rejects.toThrow(/delete timed out/);
  });
});
