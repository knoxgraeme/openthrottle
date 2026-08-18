import type { Sandbox } from "@daytona/sdk";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createDaytonaSandboxRuntime } from "./adapter.js";
import { canonicalJson, digestNormalized } from "@openthrottle/contracts";
import { STAGE_EXECUTOR_PROTOCOL, createStageRequestHash, type StageRequestEnvelope } from "../../pipeline/stage-request.js";
import type { ChildExecutorActionRequest, LoopActionRequest } from "../../runtime/contracts.js";

function fencedLoopRequest(overrides: Partial<Omit<LoopActionRequest, "requestHash" | "idempotencyKey">> = {}): LoopActionRequest {
  const withoutFence = {
    protocol: "loop-action@3" as const,
    actionId: "loop-1",
    attemptId: "attempt-child",
    graphId: "graph-1",
    parentRunId: "run-parent",
    unitId: "unit-1",
    role: "worker" as const,
    loop: "implement" as const,
    agent: "codex" as const,
    skill: "implement-unit",
    worktree: { id: "worktree-1" },
    candidateSubject: null,
    nativeSessionId: null,
    contextPolicy: "prefer_resume" as const,
    timeoutMs: 30_000,
    transitionContext: "implement unit",
    allowedMcpServers: ["github"],
    credentialScopes: ["model.invoke", "repo.read"] as const,
    receiptSchema: "openthrottle.receipt/v1",
    expectedReceiptType: "unit_completion" as const,
    ...overrides,
  } as Omit<LoopActionRequest, "requestHash" | "idempotencyKey">;
  const { candidateSubject, ...withoutCandidateSubject } = withoutFence;
  const hashInput = candidateSubject === null || candidateSubject === undefined
    ? withoutCandidateSubject
    : withoutFence;
  const requestHash = digestNormalized(canonicalJson(hashInput));
  return {
    ...withoutFence,
    requestHash,
    idempotencyKey: `loop:${withoutFence.attemptId}:${withoutFence.actionId}:${requestHash}`,
  };
}

const REVIEW_SELECTOR_ACTION_ID = "execution-work-ae57a59455a2ff9c73af69b9d6266328.review.selector";
const REVIEW_PERSONA_ACTION_ID = "execution-work-ae57a59455a2ff9c73af69b9d6266328.review.correctness-dataflow";

function fencedChildExecutorRequest(
  overrides: Partial<Omit<ChildExecutorActionRequest, "requestHash" | "idempotencyKey">> = {}
): ChildExecutorActionRequest {
  const withoutFence = {
    protocol: "child-executor-action@1" as const,
    actionId: "child-action-1",
    attemptId: "attempt-child",
    graphId: "graph-1",
    pipelineInstanceId: "pipeline-1",
    graphDigest: "a".repeat(64),
    parentRunId: "run-parent",
    generation: 1,
    capabilityDigest: "b".repeat(64),
    unitId: "unit-1",
    actionKind: "command" as const,
    commandName: "test",
    worktree: { id: "worktree-1" },
    baseSubject: "c".repeat(40),
    inputSubject: "d".repeat(40),
    ...overrides,
  } as Omit<ChildExecutorActionRequest, "requestHash" | "idempotencyKey">;
  const requestHash = digestNormalized(canonicalJson(withoutFence));
  return {
    ...withoutFence,
    requestHash,
    idempotencyKey: `child-executor:${withoutFence.attemptId}:${withoutFence.actionId}:${requestHash}`,
  };
}

describe("Daytona stage execution", () => {
  it("does not let destroyed inventory consume the bounded live-resource window", async () => {
    const list = vi.fn(async function* () {
      for (let index = 0; index < 60; index += 1) {
        yield { id: `destroyed-${index}`, state: "destroyed" };
      }
      yield { id: "destroying-live", state: "destroying" };
      yield { id: "started-live", state: "started" };
    });
    const runtime = createDaytonaSandboxRuntime({ list } as never, {
      snapshot: "snapshot-v1",
      materializeCredentialEnv: vi.fn(async () => ({ env: {} })),
    });

    await expect(runtime.listLabeledResources(2)).resolves.toEqual([
      expect.objectContaining({ id: "destroying-live", state: "destroying" }),
      expect.objectContaining({ id: "started-live", state: "started" }),
    ]);
    expect(list).toHaveBeenCalledWith({ labels: { openthrottle: "true" } });
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
        executeSessionCommand: vi.fn(async (sessionId: string) => ({
          cmdId: "dispatch-opaque-1",
          ...(sessionId.startsWith("composite-prepare-") ? { stdout: "a".repeat(40) } : {}),
        })),
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
    // Belt-and-braces (OPE-104): the sandbox root itself is normalized
    // traversable ahead of every root:root 0700 child folder, so a future
    // path can never recreate the untraversable-root trap.
    expect(sandbox.fs.createFolder).toHaveBeenCalledWith("/var/lib/openthrottle", "711");
    expect(sandbox.fs.setFilePermissions).toHaveBeenCalledWith(
      "/var/lib/openthrottle",
      { owner: "root", group: "root", mode: "711" }
    );
    const rootTraversalCallOrder = (sandbox.fs.setFilePermissions as ReturnType<typeof vi.fn>).mock.calls
      .findIndex(([path]) => path === "/var/lib/openthrottle");
    const stageInputCallOrder = (sandbox.fs.setFilePermissions as ReturnType<typeof vi.fn>).mock.calls
      .findIndex(([path]) => path === "/var/lib/openthrottle/stage-input");
    expect(rootTraversalCallOrder).toBeGreaterThanOrEqual(0);
    expect(stageInputCallOrder).toBeGreaterThan(rootTraversalCallOrder);
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
    }), { unset: ["OT_CHILD_ACTION_ID", "OT_COMPOSITE_PREPARE_ONLY"] });
    // The sandbox root traversal grant is memoized per sandbox: bootstrap()
    // above already triggered it once (for STAGE_INPUT_DIR), so this
    // dispatchStage call's own prepareStageInput -> prepareRootFolder must
    // not repeat the two Daytona API round-trips for an already-granted root.
    expect(
      (sandbox.fs.setFilePermissions as ReturnType<typeof vi.fn>).mock.calls
        .filter(([path]) => path === "/var/lib/openthrottle")
    ).toHaveLength(1);

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
    }), { unset: ["OT_COMPOSITE_PREPARE_ONLY"] });
    expect(sandbox.process.executeSessionCommand).toHaveBeenCalledWith(
      "stage-attempt-1",
      expect.objectContaining({
        command: expect.stringMatching(/flock --nonblock .*attempt-1\.lock.*test -f .*attempt-1\.json/),
      }),
      expect.any(Number)
    );
    expect(JSON.stringify(updateEnv.mock.calls.at(-1))).not.toContain("secret-token");

    const compositeWithoutFence: Omit<StageRequestEnvelope, "requestHash" | "idempotencyKey"> = {
      ...withoutFence,
      stageId: "structured",
      attemptId: "attempt-composite",
      capability: "graph/for-each-unit@1",
      commandName: undefined,
    };
    const compositeRequest = { ...compositeWithoutFence, ...createStageRequestHash(compositeWithoutFence) };
    await expect(runtime.prepareCompositeWorkspace(resource, compositeRequest)).resolves.toEqual({
      subject: "a".repeat(40),
    });
    expect(sandbox.updateEnv).toHaveBeenLastCalledWith({ OT_COMPOSITE_PREPARE_ONLY: "1" }, { unset: [] });
    expect(sandbox.process.executeSessionCommand).toHaveBeenCalledWith(
      "composite-prepare-attempt-composite",
      expect.objectContaining({
        runAsync: false,
        command: expect.stringMatching(/OT_COMPOSITE_PREPARE_ONLY=1 \/opt\/openthrottle\/entrypoint\.sh.*rev-parse HEAD.*cat \/var\/lib\/openthrottle\/stage-results\/attempt-composite\.composite-prepared/),
      }),
      expect.any(Number)
    );

    const worktree = await runtime.createWorktree(resource, {
      idempotencyKey: "worktree:attempt-child",
      attemptId: "attempt-child",
      baseCommit: "a".repeat(40),
    });
    expect(worktree).toEqual({ id: expect.stringMatching(/^[a-f0-9]{32}$/) });
    expect(sandbox.process.executeCommand).toHaveBeenCalledWith(
      expect.stringContaining("/opt/openthrottle/runner/worktrees.mjs create --idempotent"),
      "/home/agent/repo",
      {},
      120
    );

    const loopRequest = fencedLoopRequest({
      actionId: REVIEW_PERSONA_ACTION_ID,
      worktree,
    });
    await expect(runtime.dispatchLoopAction(resource, loopRequest)).resolves.toEqual({
      providerDispatchId: "dispatch-opaque-1",
    });
    expect(credentialProvider).toHaveBeenLastCalledWith(
      resource,
      loopRequest.credentialScopes,
      "codex",
      loopRequest.timeoutMs
    );
    // Each dispatch stages its request/credentials under a dispatch-unique
    // (nonce'd) path -- see the dedicated "stages each dispatch ... under a
    // dispatch-unique path" test for the concurrent-redispatch rationale --
    // so this test discovers the actual staged paths from the upload calls
    // rather than asserting a fixed shared filename.
    const uploadedRequestCall = (sandbox.fs.uploadFile as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, path]) =>
        typeof path === "string" &&
        path.startsWith(`/var/lib/openthrottle/loop-dispatch/attempt-child.${REVIEW_PERSONA_ACTION_ID}.`) &&
        path.endsWith(".request.json")
    );
    expect(uploadedRequestCall).toBeDefined();
    const stagedRequestPath = uploadedRequestCall![1] as string;
    const uploadedCredentialsCall = (sandbox.fs.uploadFile as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, path]) =>
        typeof path === "string" &&
        path.startsWith(`/var/lib/openthrottle/loop-dispatch/attempt-child.${REVIEW_PERSONA_ACTION_ID}.`) &&
        path.endsWith(".credentials.json")
    );
    expect(uploadedCredentialsCall).toBeDefined();
    const stagedCredentialsPath = uploadedCredentialsCall![1] as string;
    expect(stagedRequestPath).not.toBe(
      "/var/lib/openthrottle/loop-dispatch/attempt-child.loop-1.request.json"
    );

    const escapeForRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedReviewPersonaActionId = escapeForRegExp(REVIEW_PERSONA_ACTION_ID);
    expect(sandbox.process.executeSessionCommand).toHaveBeenCalledWith(
      `loop-${REVIEW_PERSONA_ACTION_ID}`,
      expect.objectContaining({
        command: expect.stringMatching(new RegExp(
          `loop-dispatch/attempt-child\\.${escapedReviewPersonaActionId}\\.lock.*install -d .* -m 0711 .*loop-actions.*` +
          `loop-actions/attempt-child.*loop-actions/attempt-child/${escapedReviewPersonaActionId}.*` +
          `cp .*${escapeForRegExp(stagedRequestPath)}.*loop-actions/attempt-child/${escapedReviewPersonaActionId}/request\\.json.*` +
          `env -i .*RUN_ID=.*run-parent.*OT_CHILD_ACTION_ID=.*${escapedReviewPersonaActionId}.*heartbeat\\.mjs.*` +
          `env -i .*execute-loop\\.mjs --request .*loop-actions/attempt-child/${escapedReviewPersonaActionId}/request\\.json.*` +
          `--output .*loop-actions/attempt-child/${escapedReviewPersonaActionId}/result\\.json`
        )),
      }),
      60
    );
    expect(sandbox.process.executeSessionCommand).not.toHaveBeenCalledWith(
      `loop-${REVIEW_PERSONA_ACTION_ID}`,
      expect.objectContaining({
        command: expect.stringMatching(/test -f .*&& exit 0 && install/),
      }),
      60
    );
    expect(sandbox.fs.setFilePermissions).not.toHaveBeenCalledWith(
      `/var/lib/openthrottle/loop-actions/attempt-child/${REVIEW_PERSONA_ACTION_ID}/request.json`,
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
      ["model.invoke", "repo.read"],
      "codex",
      loopRequest.timeoutMs
    );
    expect(JSON.parse((uploadedCredentialsCall![0] as Buffer).toString("utf8"))).toEqual({
      env: { GITHUB_TOKEN: "secret-token" },
    });
    expect(sandbox.fs.setFilePermissions).toHaveBeenCalledWith(
      stagedCredentialsPath,
      { owner: "root", group: "root", mode: "400" }
    );
    const dispatchLoopActionCommand = (sandbox.process.executeSessionCommand as ReturnType<typeof vi.fn>).mock.calls
      .find(([sessionId]) => sessionId === `loop-${REVIEW_PERSONA_ACTION_ID}`)?.[1].command as string;
    expect(dispatchLoopActionCommand).toContain("env -i HOME=/home/agent");
    expect(dispatchLoopActionCommand).not.toContain("GITHUB_TOKEN");
    expect(dispatchLoopActionCommand).not.toContain("secret-token");
    expect(dispatchLoopActionCommand).not.toContain("CODEX_AUTH_JSON");
    expect(dispatchLoopActionCommand).toMatch(new RegExp(
      `cp .*${escapeForRegExp(stagedCredentialsPath)}.*loop-actions/attempt-child/${escapedReviewPersonaActionId}/credentials\\.json.*` +
      `rm -f .*${escapeForRegExp(stagedCredentialsPath)}.*env -i .*execute-loop\\.mjs --request .*request\\.json.*` +
      `--credentials .*loop-actions/attempt-child/${escapedReviewPersonaActionId}/credentials\\.json.*--output`
    ));
    // A losing `flock --nonblock` (another dispatch for this exact action
    // already holds it) must still clean up the staged files this call just
    // uploaded, since the script body above never runs in that case.
    expect(dispatchLoopActionCommand).toMatch(new RegExp(
      `\\|\\| rm -f .*${escapeForRegExp(stagedCredentialsPath)}.*${escapeForRegExp(stagedRequestPath)}`
    ));
    // Redispatch always reaches execute-loop so replay can finish retention.
    expect(dispatchLoopActionCommand).not.toMatch(/if test -f .*result\.json/);

    const loopWithOpencodeAgent = fencedLoopRequest({
      actionId: "loop-opencode",
      agent: "opencode" as const,
      worktree,
    });
    await expect(runtime.dispatchLoopAction(resource, loopWithOpencodeAgent))
      .rejects.toThrow(/opencode loop actions are not supported/);

    const loopWithNullCandidateSubject = fencedLoopRequest({
      actionId: "loop-null-candidate",
      worktree,
      candidateSubject: null,
    });
    await expect(runtime.dispatchLoopAction(resource, loopWithNullCandidateSubject)).resolves.toEqual({
      providerDispatchId: "dispatch-opaque-1",
    });

    const artifactPayload = canonicalJson({ result: "success", sealed_tune_corpus: "x".repeat(70 * 1024) });
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
    remoteFiles.set(`/var/lib/openthrottle/loop-actions/attempt-child/${REVIEW_PERSONA_ACTION_ID}/result.json`, Buffer.from(JSON.stringify({
      version: 1,
      kind: "loop_action_result",
      action_id: REVIEW_PERSONA_ACTION_ID,
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
      actionId: REVIEW_PERSONA_ACTION_ID,
      requestHash: loopRequest.requestHash,
    })).resolves.toMatchObject({
      actionId: REVIEW_PERSONA_ACTION_ID,
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

  it("redispatches persisted deterministic correction state under the original action lock", async () => {
    const requestHash = "a".repeat(64);
    const correctionPath = "/var/lib/openthrottle/loop-actions/attempt-child/loop-1/receipt-correction.json";
    const correctionState = JSON.stringify({
      schema: "openthrottle.loop-receipt-correction/v1",
      action_id: "loop-1",
      attempt_id: "attempt-child",
      request_hash: requestHash,
      diagnostics: [{ pointer: "/payload/status" }],
      invalid_receipt: { extra: "x".repeat(300_000) },
      invalid_receipt_text: "{}",
    });
    expect(Buffer.byteLength(correctionState, "utf8")).toBeGreaterThan(256 * 1024);
    const executeSessionCommand = vi.fn(async (_sessionId: string, _options: { command: string }) => ({
      cmdId: "correction-resume",
    }));
    const sandbox = {
      id: "provider-opaque-correction-resume",
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async () => undefined),
      fs: {
        downloadFile: vi.fn(async (path: string) => {
          if (path.endsWith("/result.json")) throw new Error("not found");
          if (path === correctionPath) return Buffer.from(correctionState);
          throw new Error("not found");
        }),
      },
      process: {
        executeSessionCommand,
        createSession: vi.fn(async () => undefined),
      },
    } as unknown as Sandbox;
    const runtime = createDaytonaSandboxRuntime({ get: vi.fn(async () => sandbox) } as never, {
      snapshot: "snapshot-v1",
      materializeCredentialEnv: vi.fn(async () => ({ env: {} })),
    });

    await expect(runtime.collectLoopActionResult({ providerResourceId: sandbox.id }, {
      attemptId: "attempt-child",
      actionId: "loop-1",
      requestHash,
    })).resolves.toBeNull();

    expect(executeSessionCommand).toHaveBeenCalledOnce();
    const command = executeSessionCommand.mock.calls[0][1].command;
    expect(command).toContain("flock --nonblock /var/lib/openthrottle/loop-dispatch/attempt-child.loop-1.lock");
    expect(command).toContain("/opt/openthrottle/runner/execute-loop.mjs");
    expect(command).toContain("/var/lib/openthrottle/loop-actions/attempt-child/loop-1/request.json");
    expect(command).toContain("/var/lib/openthrottle/loop-actions/attempt-child/loop-1/credentials.json");
    expect(command).not.toContain("codex");
    expect(command).not.toContain("claude");
  });

  it("rejects unsafe loop action IDs before dispatching Daytona paths", async () => {
    const sandbox = {
      id: "provider-opaque-loop-unsafe",
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async () => undefined),
      fs: { createFolder: vi.fn(async () => undefined), uploadFile: vi.fn(async () => undefined), setFilePermissions: vi.fn(async () => undefined) },
      process: { executeSessionCommand: vi.fn(async () => ({ cmdId: "dispatch" })), createSession: vi.fn(async () => undefined) },
    } as unknown as Sandbox;
    const runtime = createDaytonaSandboxRuntime({ get: vi.fn(async () => sandbox) } as never, {
      snapshot: "snapshot-v1",
      materializeCredentialEnv: vi.fn(async () => ({ env: {} })),
    });

    for (const actionId of ["../bad", "unit/1", ".leading", " action", `a${"b".repeat(128)}`]) {
      await expect(runtime.dispatchLoopAction(
        { providerResourceId: "provider-opaque-loop-unsafe" },
        fencedLoopRequest({ actionId, worktree: { id: "worktree-1" } })
      )).rejects.toThrow(/loop action ID is not path-safe/);
    }
    await expect(runtime.dispatchLoopAction(
      { providerResourceId: "provider-opaque-loop-unsafe" },
      fencedLoopRequest({ actionId: REVIEW_SELECTOR_ACTION_ID, worktree: { id: "worktree-1" } })
    )).resolves.toEqual({ providerDispatchId: "dispatch" });
  });

  it("never carries auth material out of a sealed loop result", async () => {
    const remoteFiles = new Map<string, Buffer>();
    const sandbox = {
      id: "provider-opaque-codex-auth",
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
    const resource = { providerResourceId: "provider-opaque-codex-auth" };
    const baseResult = {
      version: 1,
      kind: "loop_action_result",
      action_id: "loop-1",
      attempt_id: "attempt-child",
      outcome: "success",
      native_session_id: "thread-1",
      subject: "d".repeat(40),
      receipt: "done",
      created_at: "2026-07-22T00:00:00.000Z",
    };

    // The supervisor is the sole Codex refresh authority and nothing is ever
    // read back out of a sandbox, so a result that still carries a rotated
    // blob (an older sandbox image, or a forged one) has that field dropped
    // on the floor rather than parsed into the runtime contract.
    remoteFiles.set("/var/lib/openthrottle/loop-actions/attempt-child/loop-1/result.json", Buffer.from(JSON.stringify({
      ...baseResult,
      request_hash: "a".repeat(64),
      codex_auth_json: "rotated-codex-auth-blob",
    })));
    const collected = await runtime.collectLoopActionResult(resource, {
      attemptId: "attempt-child",
      actionId: "loop-1",
      requestHash: "a".repeat(64),
    });
    expect(collected).toMatchObject({ actionId: "loop-1", outcome: "success" });
    expect(collected).not.toHaveProperty("codexAuthJson");
    expect(JSON.stringify(collected)).not.toContain("rotated-codex-auth-blob");
  });

  it("parses a fenced private recovery artifact with a long reversible path", async () => {
    const remoteFiles = new Map<string, Buffer>();
    const sandbox = {
      id: "provider-opaque-recovery",
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
    const quotedPath = `"${Array.from({ length: 5 }, () => "\\377".repeat(240)).join("/")}"`;
    const changedPaths = [quotedPath];
    expect(quotedPath.length).toBeGreaterThan(4_096);
    const recoveryArtifact = canonicalJson({
      schema: "openthrottle.loop-receipt-recovery/v1",
      action_id: "loop-1",
      attempt_id: "attempt-child",
      request_hash: "a".repeat(64),
      subject: "d".repeat(40),
      base_commit: "c".repeat(40),
      candidate_commit: null,
      candidate_tree: "e".repeat(40),
      changed_paths: changedPaths,
      changed_paths_count: changedPaths.length,
      changed_paths_sha256: digestNormalized(canonicalJson(changedPaths)),
      changed_paths_truncated: false,
      diff_encoding: "git-diff",
      diff_base64: "",
      diff_bytes: 0,
      diff_sha256: digestNormalized(""),
      diff_truncated: false,
    });
    remoteFiles.set("/var/lib/openthrottle/loop-actions/attempt-child/loop-1/result.json", Buffer.from(JSON.stringify({
      version: 1,
      kind: "loop_action_result",
      action_id: "loop-1",
      attempt_id: "attempt-child",
      request_hash: "a".repeat(64),
      outcome: "failure",
      native_session_id: "thread-1",
      subject: "d".repeat(40),
      receipt: "agent_output_contract_failure",
      recovery_artifact: recoveryArtifact,
      created_at: "2026-07-22T00:00:00.000Z",
    })));
    await expect(runtime.collectLoopActionResult({ providerResourceId: "provider-opaque-recovery" }, {
      attemptId: "attempt-child",
      actionId: "loop-1",
      requestHash: "a".repeat(64),
    })).resolves.toMatchObject({
      actionId: "loop-1",
      recoveryArtifact,
    });

    remoteFiles.set("/var/lib/openthrottle/loop-actions/attempt-child/loop-1/result.json", Buffer.from(JSON.stringify({
      version: 1,
      kind: "loop_action_result",
      action_id: "loop-1",
      attempt_id: "attempt-child",
      request_hash: "b".repeat(64),
      outcome: "failure",
      native_session_id: "thread-1",
      subject: "d".repeat(40),
      receipt: "agent_output_contract_failure",
      recovery_artifact: recoveryArtifact,
      created_at: "2026-07-22T00:00:00.000Z",
    })));
    await expect(runtime.collectLoopActionResult({ providerResourceId: "provider-opaque-recovery" }, {
      attemptId: "attempt-child",
      actionId: "loop-1",
      requestHash: "b".repeat(64),
    })).resolves.toMatchObject({
      outcome: "needs_human",
      recoveryArtifact: expect.stringContaining("requires_workspace_preservation"),
    });
  });

  it("downloads and verifies an oversized private recovery payload before cleanup", async () => {
    const remoteFiles = new Map<string, Buffer>();
    const sandbox = {
      id: "provider-opaque-large-recovery",
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
    const rawDiff = Buffer.from("private recovery line\n".repeat(3_500));
    const payload = gzipSync(rawDiff, { level: 9 });
    const payloadHash = createHash("sha256").update(payload).digest("hex");
    const recoveryArtifact = canonicalJson({
      schema: "openthrottle.loop-receipt-recovery/v1",
      action_id: "loop-1",
      attempt_id: "attempt-child",
      request_hash: "a".repeat(64),
      subject: "d".repeat(40),
      base_commit: "c".repeat(40),
      candidate_commit: null,
      candidate_tree: "e".repeat(40),
      changed_paths: [],
      changed_paths_count: 0,
      changed_paths_sha256: digestNormalized(canonicalJson([])),
      changed_paths_truncated: false,
      diff_encoding: "gzip+git-diff",
      diff_base64: null,
      diff_bytes: rawDiff.byteLength,
      diff_sha256: createHash("sha256").update(rawDiff).digest("hex"),
      diff_truncated: false,
      diff_payload: {
        file: "recovery.patch.gz",
        bytes: payload.byteLength,
        sha256: payloadHash,
      },
    });
    remoteFiles.set("/var/lib/openthrottle/loop-actions/attempt-child/loop-1/result.json", Buffer.from(JSON.stringify({
      version: 1,
      kind: "loop_action_result",
      action_id: "loop-1",
      attempt_id: "attempt-child",
      request_hash: "a".repeat(64),
      outcome: "failure",
      native_session_id: "thread-1",
      subject: "d".repeat(40),
      receipt: "agent_output_contract_failure",
      recovery_artifact: recoveryArtifact,
      created_at: "2026-07-22T00:00:00.000Z",
    })));
    remoteFiles.set("/var/lib/openthrottle/loop-actions/attempt-child/loop-1/recovery.patch.gz", payload);

    const result = await runtime.collectLoopActionResult({ providerResourceId: sandbox.id }, {
      attemptId: "attempt-child",
      actionId: "loop-1",
      requestHash: "a".repeat(64),
    });
    const persisted = JSON.parse(result?.recoveryArtifact ?? "{}");
    expect(persisted).toMatchObject({
      diff_encoding: "gzip+git-diff",
      diff_base64: null,
      private_payload: {
        schema: "openthrottle.execution-work-private-artifact/v1",
        encoding: "gzip+git-diff",
        bytes: payload.byteLength,
        sha256: payloadHash,
      },
      source_manifest_sha256: digestNormalized(recoveryArtifact),
      diff_truncated: false,
    });
    expect(persisted).not.toHaveProperty("diff_payload");
    expect(Buffer.from(result?.recoveryPayload ?? [])).toEqual(payload);

    remoteFiles.set("/var/lib/openthrottle/loop-actions/attempt-child/loop-1/recovery.patch.gz", Buffer.from("tampered"));
    await expect(runtime.collectLoopActionResult({ providerResourceId: sandbox.id }, {
      attemptId: "attempt-child",
      actionId: "loop-1",
      requestHash: "a".repeat(64),
    })).resolves.toMatchObject({
      outcome: "needs_human",
      recoveryPayload: null,
      recoveryArtifact: expect.stringContaining("requires_workspace_preservation"),
    });

    remoteFiles.delete("/var/lib/openthrottle/loop-actions/attempt-child/loop-1/recovery.patch.gz");
    await expect(runtime.collectLoopActionResult({ providerResourceId: sandbox.id }, {
      attemptId: "attempt-child",
      actionId: "loop-1",
      requestHash: "a".repeat(64),
    })).resolves.toMatchObject({
      outcome: "needs_human",
      recoveryPayload: null,
      recoveryArtifact: expect.stringContaining("requires_workspace_preservation"),
    });
  });

  it("refuses credentials outside the sandbox allowlist, including the deployment token", async () => {
    const sandbox = {
      id: "provider-opaque-2",
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async () => undefined),
      updateEnv: vi.fn(async () => undefined),
    } as unknown as Sandbox;
    const runtime = createDaytonaSandboxRuntime({ get: vi.fn(async () => sandbox) } as never, {
      snapshot: "snapshot-v1",
      materializeCredentialEnv: vi.fn(async () => ({ env: { OT_DEPLOY_TOKEN: "forbidden" } })),
    });
    await expect(runtime.materializeCredentials(
      { providerResourceId: "provider-opaque-2" },
      ["repo.read"]
    )).rejects.toThrow(/forbidden sandbox variable OT_DEPLOY_TOKEN/);
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
      protocol: "loop-action@3" as const,
      actionId: "loop-forbidden",
      attemptId: "attempt-forbidden",
      graphId: "graph-1",
      parentRunId: "run-parent",
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
      expectedReceiptType: "unit_decision" as const,
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

  it("dispatches child executor actions with clean process env, heartbeat, and unit worktree fences", async () => {
    const uploadedPaths: string[] = [];
    const sandbox = {
      id: "provider-opaque-child-executor",
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
      process: {
        createSession: vi.fn(async () => undefined),
        executeSessionCommand: vi.fn(async () => ({ cmdId: "dispatch-child" })),
      },
    } as unknown as Sandbox;
    const runtime = createDaytonaSandboxRuntime({ get: vi.fn(async () => sandbox) } as never, {
      snapshot: "snapshot-v1",
      materializeCredentialEnv: vi.fn(async () => ({ env: {} })),
    });
    const resource = { providerResourceId: "provider-opaque-child-executor" };
    const request = fencedChildExecutorRequest({
      actionId: "child-command",
      attemptId: "attempt-child-executor",
      parentRunId: "run-child-executor",
      worktree: { id: "worktree-child" },
    });

    await expect(runtime.dispatchChildExecutorAction(resource, request)).resolves.toEqual({
      providerDispatchId: "dispatch-child",
    });

    const command = (sandbox.process.executeSessionCommand as ReturnType<typeof vi.fn>).mock.calls[0]?.[1].command as string;
    expect(command).toContain("env -i HOME=/home/agent");
    expect(command).toMatch(/RUN_ID=.*run-child-executor/);
    expect(command).toMatch(/OT_CHILD_ACTION_ID=.*child-command/);
    expect(command).toContain("/opt/openthrottle/runner/heartbeat.mjs");
    expect(command).toContain("/opt/openthrottle/runner/execute-child-action.mjs");
    expect(command).not.toMatch(/if test -f .*result\.json/);
    expect(command).not.toContain("GITHUB_TOKEN");
    expect(command).not.toContain("secret-token");
    expect(command).not.toContain("CODEX_AUTH_JSON");
    expect(uploadedPaths).toContainEqual(expect.stringMatching(
      /^\/var\/lib\/openthrottle\/child-executor-dispatch\/attempt-child-executor\.child-command\..*\.request\.json$/
    ));

    const missingWorktree = fencedChildExecutorRequest({
      actionId: "child-command-missing-worktree",
      worktree: null,
    });
    await expect(runtime.dispatchChildExecutorAction(resource, missingWorktree))
      .rejects.toThrow(/requires a unit worktree/);
    expect(sandbox.process.executeSessionCommand).toHaveBeenCalledTimes(1);

    const wrongProtocol = fencedChildExecutorRequest({
      protocol: "stage-executor@1" as never,
      actionId: "child-command-wrong-protocol",
    });
    await expect(runtime.dispatchChildExecutorAction(resource, wrongProtocol))
      .rejects.toThrow(/invalid protocol/);
    expect(sandbox.process.executeSessionCommand).toHaveBeenCalledTimes(1);

    const graphCandidate = fencedChildExecutorRequest({
      actionId: "child-final-candidate",
      actionKind: "candidate",
      commandName: undefined,
      unitId: null,
      worktree: { id: "worktree-final-repair" },
    });
    await expect(runtime.dispatchChildExecutorAction(resource, graphCandidate)).resolves.toEqual({
      providerDispatchId: "dispatch-child",
    });
    expect(sandbox.process.executeSessionCommand).toHaveBeenCalledTimes(2);
  });

  it("collects child executor results only from the exact attempt/action path", async () => {
    const remoteFiles = new Map<string, Buffer>();
    const sandbox = {
      id: "provider-child-collect",
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
    const result = {
      version: 1,
      kind: "child_executor_action_result",
      action_id: "child-1",
      attempt_id: "attempt-child",
      request_hash: "a".repeat(64),
      outcome: "success",
      subject: "b".repeat(40),
      receipt: "done",
      created_at: "2026-07-22T00:00:00.000Z",
    };

    await expect(runtime.collectChildExecutorActionResult(
      { providerResourceId: "provider-child-collect" },
      { attemptId: "attempt-child", actionId: "child-1", requestHash: "a".repeat(64) }
    )).resolves.toBeNull();

    remoteFiles.set(
      "/var/lib/openthrottle/child-executor-actions/attempt-child/child-1/result.json",
      Buffer.from(JSON.stringify(result))
    );
    await expect(runtime.collectChildExecutorActionResult(
      { providerResourceId: "provider-child-collect" },
      { attemptId: "attempt-child", actionId: "child-1", requestHash: "a".repeat(64) }
    )).resolves.toMatchObject({
      actionId: "child-1",
      attemptId: "attempt-child",
      outcome: "success",
      subject: "b".repeat(40),
    });

    await expect(runtime.collectChildExecutorActionResult(
      { providerResourceId: "provider-child-collect" },
      { attemptId: "attempt-child", actionId: "child-1", requestHash: "c".repeat(64) }
    )).rejects.toThrow(/invalid envelope/);
  });

  it("refuses lead loop write credentials before materializing credentials", async () => {
    const sandbox = {
      id: "provider-opaque-lead-write",
      state: "started",
      autoStopInterval: 60,
      setAutostopInterval: vi.fn(async () => undefined),
      fs: { createFolder: vi.fn(async () => undefined), uploadFile: vi.fn(async () => undefined), setFilePermissions: vi.fn(async () => undefined) },
      process: { executeSessionCommand: vi.fn(async () => ({ cmdId: "dispatch" })), createSession: vi.fn(async () => undefined) },
    } as unknown as Sandbox;
    const materializeCredentialEnv = vi.fn(async () => ({ env: { GITHUB_TOKEN: "secret-token" } }));
    const runtime = createDaytonaSandboxRuntime({ get: vi.fn(async () => sandbox) } as never, {
      snapshot: "snapshot-v1",
      materializeCredentialEnv,
    });
    const request = fencedLoopRequest({
      actionId: "loop-lead-write",
      attemptId: "attempt-lead-write",
      role: "lead" as const,
      loop: "lead" as const,
      skill: "accept-unit",
      worktree: null,
      candidateSubject: "a".repeat(40),
      contextPolicy: "fresh" as const,
      transitionContext: "",
      allowedMcpServers: [],
      credentialScopes: ["model.invoke", "repo.read", "repo.write"],
    });

    await expect(runtime.dispatchLoopAction({ providerResourceId: "provider-opaque-lead-write" }, request))
      .rejects.toThrow(/structured loop actions cannot request repo\.write/);
    expect(materializeCredentialEnv).not.toHaveBeenCalled();
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
      protocol: "loop-action@3" as const,
      actionId: "loop-redispatch",
      attemptId: "attempt-redispatch",
      graphId: "graph-1",
      parentRunId: "run-parent",
      unitId: null,
      role: "worker" as const,
      loop: "implement" as const,
      agent: "claude" as const,
      skill: "implement-unit",
      worktree: null,
      nativeSessionId: null,
      contextPolicy: "fresh" as const,
      timeoutMs: 30_000,
      transitionContext: "",
      allowedMcpServers: [],
      credentialScopes: ["repo.read"] as const,
      receiptSchema: "openthrottle.receipt/v1",
      expectedReceiptType: "unit_completion" as const,
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
      protocol: "loop-action@3" as const,
      actionId: "loop-scope",
      attemptId: "attempt-scope",
      graphId: "graph-1",
      parentRunId: "run-parent",
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
      expectedReceiptType: "semantic_review" as const,
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
