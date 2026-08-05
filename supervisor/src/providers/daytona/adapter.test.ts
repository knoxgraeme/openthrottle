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
        listFiles: vi.fn(async (path: string) => {
          if (path === "/var/lib/openthrottle/loop-actions") {
            return [{ name: "attempt-child", path: "/var/lib/openthrottle/loop-actions/attempt-child", size: 0, isDir: true }];
          }
          return [];
        }),
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
      protocol: "loop-action@2" as const,
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
      credentialScopes: ["model.invoke", "repo.read", "repo.write"] as const,
      receiptSchema: "openthrottle.receipt/v1",
      requestHash: "",
      idempotencyKey: "",
    };
    const { requestHash: _requestHash, idempotencyKey: _idempotencyKey, ...loopCanonicalFence } = loopWithoutFence;
    const loopHash = digestNormalized(canonicalJson(loopCanonicalFence));
    const loopRequest = {
      ...loopWithoutFence,
      requestHash: loopHash,
      idempotencyKey: `loop:attempt-child:loop-1:${loopHash}`,
    };
    await expect(runtime.dispatchLoopAction(resource, loopRequest)).resolves.toEqual({
      providerDispatchId: "dispatch-opaque-1",
    });
    // Each dispatch stages its request/credentials under a dispatch-unique
    // (nonce'd) path -- see the dedicated "stages each dispatch ... under a
    // dispatch-unique path" test for the concurrent-redispatch rationale --
    // so this test discovers the actual staged paths from the upload calls
    // rather than asserting a fixed shared filename.
    const uploadedRequestCall = (sandbox.fs.uploadFile as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, path]) =>
        typeof path === "string" &&
        path.startsWith("/var/lib/openthrottle/loop-dispatch/attempt-child.loop-1.") &&
        path.endsWith(".request.json")
    );
    expect(uploadedRequestCall).toBeDefined();
    const stagedRequestPath = uploadedRequestCall![1] as string;
    const uploadedCredentialsCall = (sandbox.fs.uploadFile as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, path]) =>
        typeof path === "string" &&
        path.startsWith("/var/lib/openthrottle/loop-dispatch/attempt-child.loop-1.") &&
        path.endsWith(".credentials.json")
    );
    expect(uploadedCredentialsCall).toBeDefined();
    const stagedCredentialsPath = uploadedCredentialsCall![1] as string;
    expect(stagedRequestPath).not.toBe(
      "/var/lib/openthrottle/loop-dispatch/attempt-child.loop-1.request.json"
    );

    const escapeForRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(sandbox.process.executeSessionCommand).toHaveBeenCalledWith(
      "loop-loop-1",
      expect.objectContaining({
        command: expect.stringMatching(new RegExp(
          `loop-dispatch/attempt-child\\.loop-1\\.lock.*if test -f .*loop-actions/attempt-child/loop-1/result\\.json.*` +
          `then rm -f .*${escapeForRegExp(stagedCredentialsPath)}.*exit 0; fi.*install -d .* -m 0711 .*loop-actions.*` +
          `loop-actions/attempt-child.*loop-actions/attempt-child/loop-1.*` +
          `cp .*${escapeForRegExp(stagedRequestPath)}.*loop-actions/attempt-child/loop-1/request\\.json.*` +
          `execute-loop\\.mjs --request .*loop-actions/attempt-child/loop-1/request\\.json.*` +
          `--output .*loop-actions/attempt-child/loop-1/result\\.json`
        )),
      }),
      60
    );
    expect(sandbox.process.executeSessionCommand).not.toHaveBeenCalledWith(
      "loop-loop-1",
      expect.objectContaining({
        command: expect.stringMatching(/test -f .*&& exit 0 && install/),
      }),
      60
    );
    expect(sandbox.fs.setFilePermissions).not.toHaveBeenCalledWith(
      "/var/lib/openthrottle/loop-actions/attempt-child/loop-1/request.json",
      expect.anything()
    );

    // Each loop action materializes its own credential envelope from the
    // exact scopes it declared, distinct from the whole-attempt stage
    // credentials materialized earlier in this test. It also passes the
    // action's own agent ("codex" here) so a worker whose agent overrides
    // the ticket's default receives that agent's own credential rather than
    // whatever the ticket-level default would have selected.
    expect(credentialProvider).toHaveBeenLastCalledWith(
      resource,
      ["model.invoke", "repo.read", "repo.write"],
      "codex"
    );
    expect(JSON.parse((uploadedCredentialsCall![0] as Buffer).toString("utf8"))).toEqual({
      env: { GITHUB_TOKEN: "secret-token" },
    });
    expect(sandbox.fs.setFilePermissions).toHaveBeenCalledWith(
      stagedCredentialsPath,
      { owner: "root", group: "root", mode: "400" }
    );
    const dispatchLoopActionCommand = (sandbox.process.executeSessionCommand as ReturnType<typeof vi.fn>).mock.calls
      .find(([sessionId]) => sessionId === "loop-loop-1")?.[1].command as string;
    expect(dispatchLoopActionCommand).toMatch(new RegExp(
      `cp .*${escapeForRegExp(stagedCredentialsPath)}.*loop-actions/attempt-child/loop-1/credentials\\.json.*` +
      `rm -f .*${escapeForRegExp(stagedCredentialsPath)}.*execute-loop\\.mjs --request .*request\\.json.*` +
      `--credentials .*loop-actions/attempt-child/loop-1/credentials\\.json.*--output`
    ));
    // A losing `flock --nonblock` (another dispatch for this exact action
    // already holds it) must still clean up the staged files this call just
    // uploaded, since the script body above never runs in that case.
    expect(dispatchLoopActionCommand).toMatch(new RegExp(
      `\\|\\| rm -f .*${escapeForRegExp(stagedCredentialsPath)}.*${escapeForRegExp(stagedRequestPath)}`
    ));
    // A redispatch of an already-completed action must clean up both staged
    // uploads, not just the credentials file -- the request file is not
    // secret, but it is otherwise never removed on this fast-exit path.
    expect(dispatchLoopActionCommand).toMatch(new RegExp(
      `then rm -f .*${escapeForRegExp(stagedCredentialsPath)}.*${escapeForRegExp(stagedRequestPath)}.*; exit 0; fi`
    ));

    const loopWithOpencodeAgent = {
      ...loopWithoutFence,
      actionId: "loop-opencode",
      agent: "opencode" as const,
    };
    const {
      requestHash: _opencodeRequestHash,
      idempotencyKey: _opencodeIdempotencyKey,
      ...canonicalOpencode
    } = loopWithOpencodeAgent;
    const opencodeHash = digestNormalized(canonicalJson(canonicalOpencode));
    await expect(runtime.dispatchLoopAction(resource, {
      ...loopWithOpencodeAgent,
      requestHash: opencodeHash,
      idempotencyKey: `loop:attempt-child:loop-opencode:${opencodeHash}`,
    })).rejects.toThrow(/opencode loop actions are not supported/);

    const loopWithNullCandidateSubject = {
      ...loopWithoutFence,
      actionId: "loop-null-candidate",
      candidateSubject: null,
    };
    const {
      requestHash: _nullRequestHash,
      idempotencyKey: _nullIdempotencyKey,
      candidateSubject: _candidateSubject,
      ...canonicalNullCandidate
    } = loopWithNullCandidateSubject;
    const nullCandidateHash = digestNormalized(canonicalJson(canonicalNullCandidate));
    await expect(runtime.dispatchLoopAction(resource, {
      ...loopWithNullCandidateSubject,
      requestHash: nullCandidateHash,
      idempotencyKey: `loop:attempt-child:loop-null-candidate:${nullCandidateHash}`,
    })).resolves.toEqual({
      providerDispatchId: "dispatch-opaque-1",
    });

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
    remoteFiles.set("/var/lib/openthrottle/loop-actions/attempt-child/loop-1/result.json", Buffer.from(JSON.stringify({
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
    await expect(runtime.collectLoopActionResult(resource, {
      attemptId: "attempt-child",
      actionId: "loop-1",
      requestHash: loopRequest.requestHash,
    })).resolves.toMatchObject({
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

  it("collects loop results only from the exact attempt/action path", async () => {
    const remoteFiles = new Map<string, Buffer>();
    const sandbox = {
      id: "provider-opaque-loop-fence",
      state: "started",
      fs: {
        downloadFile: vi.fn(async (path: string) => {
          const file = remoteFiles.get(path);
          if (!file) throw new Error("not found");
          return file;
        }),
      },
    } as unknown as Sandbox;
    const runtime = createDaytonaSandboxRuntime({ get: vi.fn(async () => sandbox) } as never, {
      snapshot: "snapshot-v1",
      materializeCredentialEnv: vi.fn(async () => ({ env: {} })),
    });
    const resource = { providerResourceId: "provider-opaque-loop-fence" };
    const result = {
      version: 1,
      kind: "loop_action_result",
      action_id: "loop-1",
      attempt_id: "attempt-other",
      request_hash: "a".repeat(64),
      outcome: "success",
      native_session_id: "thread-1",
      subject: "d".repeat(40),
      receipt: "done",
      created_at: "2026-07-22T00:00:00.000Z",
    };
    remoteFiles.set("/var/lib/openthrottle/loop-actions/attempt-other/loop-1/result.json", Buffer.from(JSON.stringify(result)));
    await expect(runtime.collectLoopActionResult(resource, {
      attemptId: "attempt-child",
      actionId: "loop-1",
      requestHash: "a".repeat(64),
    })).resolves.toBeNull();

    remoteFiles.set("/var/lib/openthrottle/loop-actions/attempt-child/loop-1/result.json", Buffer.from(JSON.stringify(result)));
    await expect(runtime.collectLoopActionResult(resource, {
      attemptId: "attempt-child",
      actionId: "loop-1",
      requestHash: "b".repeat(64),
    })).rejects.toThrow(/invalid envelope/);
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

  it("refuses to dispatch a loop action whose credentials fall outside the sandbox allowlist", async () => {
    const sandbox = {
      id: "provider-opaque-loop-forbidden",
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async () => undefined),
      fs: { createFolder: vi.fn(async () => undefined), uploadFile: vi.fn(async () => undefined), setFilePermissions: vi.fn(async () => undefined) },
      process: { executeSessionCommand: vi.fn(async () => ({ cmdId: "dispatch" })), createSession: vi.fn(async () => undefined) },
    } as unknown as Sandbox;
    const runtime = createDaytonaSandboxRuntime({ get: vi.fn(async () => sandbox) } as never, {
      snapshot: "snapshot-v1",
      materializeCredentialEnv: vi.fn(async () => ({ env: { DAYTONA_API_KEY: "forbidden" } })),
    });
    const withoutFence = {
      protocol: "loop-action@2" as const,
      actionId: "loop-forbidden",
      attemptId: "attempt-forbidden",
      graphId: "graph-1",
      unitId: null,
      role: "lead" as const,
      loop: "lead" as const,
      agent: "codex" as const,
      skill: "accept-unit",
      worktree: null,
      nativeSessionId: null,
      contextPolicy: "fresh" as const,
      timeoutMs: 30_000,
      transitionContext: "",
      allowedMcpServers: [],
      credentialScopes: ["repo.read"] as const,
      receiptSchema: "openthrottle.receipt/v1",
      candidateSubject: "a".repeat(40),
      requestHash: "",
      idempotencyKey: "",
    };
    const { requestHash: _requestHash, idempotencyKey: _idempotencyKey, ...canonicalFence } = withoutFence;
    const hash = digestNormalized(canonicalJson(canonicalFence));
    const request = { ...withoutFence, requestHash: hash, idempotencyKey: `loop:attempt-forbidden:loop-forbidden:${hash}` };
    await expect(runtime.dispatchLoopAction({ providerResourceId: "provider-opaque-loop-forbidden" }, request))
      .rejects.toThrow(/forbidden sandbox variable DAYTONA_API_KEY for loop action loop-forbidden/);
    expect(sandbox.fs.uploadFile).not.toHaveBeenCalled();
  });

  it("stages each dispatch of the same action under a dispatch-unique path, not a shared one", async () => {
    // A concurrent redispatch of the same action (attemptId + actionId) must
    // never stage over, or share a cleanup target with, another in-flight
    // dispatch: a losing `flock` contender's cleanup runs unconditionally on
    // its own staged files, and if two dispatches shared one staged path, a
    // loser could delete the winner's request/credentials mid-copy.
    const uploadedPaths: string[] = [];
    const sandbox = {
      id: "provider-opaque-loop-redispatch",
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async () => undefined),
      fs: {
        createFolder: vi.fn(async () => undefined),
        uploadFile: vi.fn(async (_content: Buffer, path: string) => {
          uploadedPaths.push(path);
        }),
        setFilePermissions: vi.fn(async () => undefined),
      },
      process: { executeSessionCommand: vi.fn(async () => ({ cmdId: "dispatch" })), createSession: vi.fn(async () => undefined) },
    } as unknown as Sandbox;
    const runtime = createDaytonaSandboxRuntime({ get: vi.fn(async () => sandbox) } as never, {
      snapshot: "snapshot-v1",
      materializeCredentialEnv: vi.fn(async () => ({ env: { GITHUB_TOKEN: "secret-token" } })),
    });
    const withoutFence = {
      protocol: "loop-action@2" as const,
      actionId: "loop-redispatch",
      attemptId: "attempt-redispatch",
      graphId: "graph-1",
      unitId: null,
      role: "worker" as const,
      loop: "implement" as const,
      agent: "claude" as const,
      skill: "ce-work",
      worktree: null,
      nativeSessionId: null,
      contextPolicy: "fresh" as const,
      timeoutMs: 30_000,
      transitionContext: "",
      allowedMcpServers: [],
      credentialScopes: ["repo.read"] as const,
      receiptSchema: "openthrottle.receipt/v1",
      requestHash: "",
      idempotencyKey: "",
    };
    const { requestHash: _requestHash, idempotencyKey: _idempotencyKey, ...canonicalFence } = withoutFence;
    const hash = digestNormalized(canonicalJson(canonicalFence));
    const request = { ...withoutFence, requestHash: hash, idempotencyKey: `loop:attempt-redispatch:loop-redispatch:${hash}` };

    await runtime.dispatchLoopAction({ providerResourceId: "provider-opaque-loop-redispatch" }, request);
    await runtime.dispatchLoopAction({ providerResourceId: "provider-opaque-loop-redispatch" }, request);

    const requestUploads = uploadedPaths.filter((path) =>
      path.startsWith("/var/lib/openthrottle/loop-dispatch/attempt-redispatch.loop-redispatch.") &&
      path.endsWith(".request.json")
    );
    const credentialUploads = uploadedPaths.filter((path) =>
      path.startsWith("/var/lib/openthrottle/loop-dispatch/attempt-redispatch.loop-redispatch.") &&
      path.endsWith(".credentials.json")
    );
    expect(requestUploads).toHaveLength(2);
    expect(credentialUploads).toHaveLength(2);
    // Distinct nonce'd paths, not the same shared filename reused twice.
    expect(new Set(requestUploads).size).toBe(2);
    expect(new Set(credentialUploads).size).toBe(2);

    const commands = (sandbox.process.executeSessionCommand as ReturnType<typeof vi.fn>).mock.calls.map(
      ([, options]) => options.command as string
    );
    expect(commands).toHaveLength(2);
    for (const [index, command] of commands.entries()) {
      // Each dispatch's script only ever references its own staged paths --
      // never the other dispatch's -- in both its happy-path `cp` chain and
      // its losing-flock cleanup fallback.
      expect(command).toContain(requestUploads[index]);
      expect(command).toContain(credentialUploads[index]);
      const otherIndex = index === 0 ? 1 : 0;
      expect(command).not.toContain(requestUploads[otherIndex]);
      expect(command).not.toContain(credentialUploads[otherIndex]);
    }
    // The action lock itself stays shared (not nonce'd) so concurrent
    // dispatches of the exact same action still serialize on one lock.
    for (const command of commands) {
      expect(command).toContain("/var/lib/openthrottle/loop-dispatch/attempt-redispatch.loop-redispatch.lock");
    }
  });

  it("refuses to dispatch a loop action outside the closed logical credential scope set", async () => {
    const sandbox = { id: "provider-opaque-loop-scope", state: "started" } as unknown as Sandbox;
    const runtime = createDaytonaSandboxRuntime({ get: vi.fn(async () => sandbox) } as never, {
      snapshot: "snapshot-v1",
      materializeCredentialEnv: vi.fn(async () => ({ env: {} })),
    });
    const withoutFence = {
      protocol: "loop-action@2" as const,
      actionId: "loop-scope",
      attemptId: "attempt-scope",
      graphId: "graph-1",
      unitId: null,
      role: "reviewer" as const,
      loop: "review" as const,
      agent: "codex" as const,
      skill: "final-review",
      worktree: null,
      nativeSessionId: null,
      contextPolicy: "fresh" as const,
      timeoutMs: 30_000,
      transitionContext: "",
      allowedMcpServers: [],
      credentialScopes: ["daytona.admin"],
      receiptSchema: "openthrottle.receipt/v1",
      requestHash: "",
      idempotencyKey: "",
    };
    const { requestHash: _requestHash, idempotencyKey: _idempotencyKey, ...canonicalFence } = withoutFence;
    const hash = digestNormalized(canonicalJson(canonicalFence));
    const request = { ...withoutFence, requestHash: hash, idempotencyKey: `loop:attempt-scope:loop-scope:${hash}` };
    await expect(runtime.dispatchLoopAction({ providerResourceId: "provider-opaque-loop-scope" }, request as never))
      .rejects.toThrow(/credential scope daytona\.admin is not a recognized logical credential/);
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
