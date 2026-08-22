import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  KERNEL_ACTION_REQUEST_SCHEMA,
  type KernelWorkActionRequest,
} from "../../runtime/kernel-contracts.js";
import {
  authorizeKernelSteeringDelivery,
  createKernelSteeringEnvelope,
  type KernelRuntimeSessionBinding,
} from "../../pipeline/kernel/steering.js";
import { DaytonaKernelAdapter } from "./kernel-adapter.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function workRequest(overrides: Record<string, unknown> = {}): KernelWorkActionRequest {
  return {
    schema: KERNEL_ACTION_REQUEST_SCHEMA,
    phase: "work",
    pipeline_run_id: "run-1",
    attempt_id: "attempt-1",
    stage_id: "stage-1",
    scope: { kind: "stage", stage_id: "stage-1" },
    request_hash: "a".repeat(64),
    definition_bundle_hash: "b".repeat(64),
    input_subject: "c".repeat(40),
    repository_authority: "inspect",
    lease_id: "lease-1",
    worker_id: "worker-1",
    task_prompt: "execute the sealed task",
    context: { records: [], checkpoints: [] },
    runtime_resource: {
      provider: "daytona",
      provider_resource_id: "sandbox-1",
      delivery_record_ids: ["delivery-create", "delivery-start"],
    },
    change_boundary: null,
    action: {
      kind: "command",
      command_id: "command-1",
      command_line: "true",
      post_bootstrap: [],
      execution_limits: { max_turns: null, task_timeout_seconds: 60 },
    },
    executor_policy: {
      git_administration: "executor_only",
      commit: false,
      push: false,
      publish: false,
    },
    ...overrides,
  } as unknown as KernelWorkActionRequest;
}

function sandboxWith(downloadFile: (path: string) => Promise<Buffer>) {
  const files = new Map<string, Buffer>();
  const defaultExecuteCommand = async (command: string) => {
    const lockInitialization = /touch -- '([^']*lease-generation\.lock)'/.exec(command);
    if (lockInitialization) {
      if (!files.has(lockInitialization[1]!)) files.set(lockInitialization[1]!, Buffer.alloc(0));
      return { exitCode: 0, result: "" };
    }
    if (command.startsWith("flock --exclusive ")) {
      const stagedPath = [...files.keys()].find((path) =>
        path.endsWith(".part") && path.includes("lease-generation-") && command.includes(`'${path}'`),
      );
      if (!stagedPath) return { exitCode: 41, result: "" };
      const finalPath = stagedPath.replace(/lease-generation-[^/]+\.part$/, "lease-generation.json");
      const staged = files.get(stagedPath)!;
      const stagedGeneration = JSON.parse(staged.toString("utf8")).lease_generation;
      const current = files.get(finalPath);
      const currentGeneration = current ? JSON.parse(current.toString("utf8")).lease_generation : -1;
      if (currentGeneration > stagedGeneration) return { exitCode: 42, result: "" };
      if (currentGeneration < stagedGeneration) {
        files.set(finalPath, Buffer.from(staged));
        files.delete(stagedPath);
      }
      return { exitCode: 0, result: "" };
    }
    return { exitCode: 0, result: "" };
  };
  return {
    id: "sandbox-1",
    state: "started",
    autoStopInterval: 60,
    fs: {
      downloadFile: vi.fn(async (path: string) => {
        const value = files.get(path);
        if (value) return Buffer.from(value);
        if (path.startsWith("/var/lib/openthrottle/action-fences/")) {
          throw new Error("404 not found");
        }
        return downloadFile(path);
      }),
      createFolder: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockRejectedValue(new Error("404 not found")),
      setFilePermissions: vi.fn().mockResolvedValue(undefined),
      uploadFile: vi.fn(async (bytes: Buffer, path: string) => {
        files.set(path, Buffer.from(bytes));
      }),
    },
    process: {
      createSession: vi.fn().mockResolvedValue(undefined),
      executeSessionCommand: vi.fn().mockResolvedValue({ cmdId: "command-1" }),
      executeCommand: vi.fn(defaultExecuteCommand),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockRejectedValue(new Error("404 not found")),
      getSessionCommand: vi.fn().mockResolvedValue({ cmdId: "command-1", exitCode: undefined }),
    },
    git: {
      clone: vi.fn().mockResolvedValue(undefined),
    },
    updateEnv: vi.fn().mockResolvedValue(undefined),
    files,
    defaultExecuteCommand,
  };
}

function emulateRepositoryBinding(sandbox: ReturnType<typeof sandboxWith>) {
  let ready = false;
  sandbox.process.executeCommand.mockImplementation(async (command: string) => {
    if (command.includes("lease-generation.lock")) return sandbox.defaultExecuteCommand(command);
    if (command.includes("install -d") && command.includes("repository-source")) {
      return { exitCode: 0, result: "" };
    }
    if (command.includes("mv --") && command.includes("repository-source")) {
      ready = true;
      return { exitCode: 0, result: "" };
    }
    if (command.includes("repository-source")) {
      return { exitCode: ready ? 0 : 44, result: "" };
    }
    return sandbox.defaultExecuteCommand(command);
  });
  return { isReady: () => ready };
}

function adapterFor(
  sandbox: ReturnType<typeof sandboxWith>,
  blobStore: object = {},
  attemptInputs: object = {},
  optionOverrides: object = {},
) {
  return new DaytonaKernelAdapter({
    get: vi.fn().mockResolvedValue(sandbox),
  } as never, {
    snapshot: "snapshot-1",
    github_read_token: "github-token",
    task_timeout_seconds: 1,
    runtime_capability_digest: "d".repeat(64),
    blob_store: blobStore,
    environments: {
      loadExactRunEnvironment: vi.fn().mockReturnValue({
        repository: "owner/repository",
        base_branch: "main",
      }),
    },
    attempt_inputs: attemptInputs,
    materialize_model_credentials: vi.fn().mockResolvedValue({}),
    poll_interval_ms: 1,
    ...optionOverrides,
  } as never);
}

function runtimeResult(request: KernelWorkActionRequest): Buffer {
  return Buffer.from(JSON.stringify({
    schema: "openthrottle.kernel-runtime-result/v1",
    pipeline_run_id: request.pipeline_run_id,
    attempt_id: request.attempt_id,
    request_hash: request.request_hash,
    definition_bundle_hash: request.definition_bundle_hash,
    lease_id: request.lease_id,
    worker_id: request.worker_id,
    outcome: {
      state: "work_failed",
      retryable: true,
      reason: "runtime failed",
    },
  }));
}

function sessionEvent(request: KernelWorkActionRequest): Buffer {
  return Buffer.from(JSON.stringify({
    schema: "openthrottle.kernel-session-event/v1",
    pipeline_run_id: request.pipeline_run_id,
    attempt_id: request.attempt_id,
    request_hash: request.request_hash,
    definition_bundle_hash: request.definition_bundle_hash,
    lease_id: request.lease_id,
    worker_id: request.worker_id,
    native_session_id: "native-session-1",
    observed_at: "2026-08-20T12:00:00.000Z",
  }));
}

describe("DaytonaKernelAdapter", () => {
  it("materializes and verifies the exact initial Git subject before launching work", async () => {
    const request = workRequest();
    const stop = new Error("stop after repository materialization");
    const sandbox = sandboxWith(async (path) => {
      if (path.endsWith("/request.json")) throw stop;
      throw new Error("404 not found");
    });
    const repositoryBinding = emulateRepositoryBinding(sandbox);

    await expect(adapterFor(sandbox).executeWork(request, {
      lease_generation: 0,
      heartbeat_interval_ms: 10,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn(),
    })).rejects.toBe(stop);

    expect(sandbox.git.clone).toHaveBeenCalledWith(
      "https://github.com/owner/repository.git",
      "/var/lib/openthrottle/repository-source/repo.part",
      "main",
      request.input_subject,
      "x-access-token",
      "github-token",
      false,
    );
    const publish = sandbox.process.executeCommand.mock.calls.find(
      ([command]) => String(command).includes("mv --") && String(command).includes("repository-source"),
    );
    expect(publish).toBeDefined();
    expect(String(publish![0])).not.toContain("github-token");
    expect(spawnSync("/bin/sh", ["-n", "-c", String(publish![0])]).status).toBe(0);
    expect(repositoryBinding.isReady()).toBe(true);
    expect(sandbox.process.executeSessionCommand).not.toHaveBeenCalled();
  });

  it("replaces a partial owned clone on recovered exact-subject setup", async () => {
    const request = workRequest();
    const stop = new Error("stop after recovered repository materialization");
    const sandbox = sandboxWith(async (path) => {
      if (path.endsWith("/request.json")) throw stop;
      throw new Error("404 not found");
    });
    const repositoryBinding = emulateRepositoryBinding(sandbox);
    sandbox.git.clone
      .mockRejectedValueOnce(new Error("provider connection lost during clone"))
      .mockResolvedValueOnce(undefined);
    const adapter = adapterFor(sandbox);
    const callbacks = (lease_generation: number) => ({
      lease_generation,
      heartbeat_interval_ms: 10,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn(),
    });

    await expect(adapter.executeWork(request, callbacks(0)))
      .rejects.toThrow("provider connection lost during clone");
    await expect(adapter.executeWork(request, callbacks(1))).rejects.toBe(stop);

    expect(sandbox.git.clone).toHaveBeenCalledTimes(2);
    expect(sandbox.fs.deleteFile).toHaveBeenCalledTimes(2);
    expect(sandbox.fs.deleteFile).toHaveBeenCalledWith(
      "/var/lib/openthrottle/repository-source/repo.part",
      true,
    );
    expect(repositoryBinding.isReady()).toBe(true);
  });

  it("fails closed when the final repository conflicts with the sealed input subject", async () => {
    const request = workRequest();
    const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      if (command.includes("lease-generation.lock")) return sandbox.defaultExecuteCommand(command);
      if (command.includes("install -d") && command.includes("repository-source")) {
        return { exitCode: 0, result: "" };
      }
      if (command.includes("repository-source")) return { exitCode: 45, result: "" };
      return sandbox.defaultExecuteCommand(command);
    });

    await expect(adapterFor(sandbox).executeWork(request, {
      lease_generation: 0,
      heartbeat_interval_ms: 10,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn(),
    })).rejects.toThrow("repository source conflicts with the exact run binding");
    expect(sandbox.git.clone).not.toHaveBeenCalled();
    expect(sandbox.process.executeSessionCommand).not.toHaveBeenCalled();
  });

  it("emits a POSIX-valid exact lease-generation refresh command", async () => {
    const request = workRequest();
    const resultPath = "/var/lib/openthrottle/action-results/attempt-1/work-lease-1/result.json";
    let resultReads = 0;
    const sandbox = sandboxWith(async (path) => {
      if (path === resultPath && ++resultReads > 1) return runtimeResult(request);
      throw new Error("404 not found");
    });
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      if (!command.startsWith("flock --exclusive ")) return sandbox.defaultExecuteCommand(command);
      const parsed = spawnSync("/bin/sh", ["-c", [
        "flock() {",
        "  shift 2",
        "  test \"$1\" = sh && test \"$2\" = -c || exit 99",
        "  /bin/sh -n -c \"$3\"",
        "}",
        command,
      ].join("\n")], { encoding: "utf8" });
      expect(parsed.status, parsed.stderr).toBe(0);
      return sandbox.defaultExecuteCommand(command);
    });

    await expect(adapterFor(sandbox).executeWork(request, {
      lease_generation: 0,
      heartbeat_interval_ms: 10,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn(),
    })).resolves.toMatchObject({ state: "work_failed" });
    expect(sandbox.updateEnv).toHaveBeenCalledWith(expect.objectContaining({
      OT_LEASE_GENERATION_FENCE_FILE:
        "/var/lib/openthrottle/action-fences/attempt-1/lease-generation.json",
      OT_LEASE_GENERATION_LOCK_FILE:
        "/var/lib/openthrottle/action-fences/attempt-1/lease-generation.lock",
    }), expect.any(Object));
  });

  it("polls the independent session and result files together and binds before acceptance", async () => {
    const request = workRequest({
      action: {
        kind: "agent",
        engine: "codex",
        model: null,
        reasoning_effort: null,
        agent_id: "agent-1",
        skill_ids: [],
        entry_skill: null,
        eval_id: "eval-1",
        semantic_result_schema: { id: "result-schema", schema: {} },
        execution_limits: { max_turns: null, task_timeout_seconds: 60 },
        definition_entries: [],
      },
    });
    const session = deferred<Buffer>();
    const result = deferred<Buffer>();
    const sessionPath = "/var/lib/openthrottle/action-results/attempt-1/work-lease-1/session.json";
    const resultPath = "/var/lib/openthrottle/action-results/attempt-1/work-lease-1/result.json";
    const sandbox = sandboxWith((path) => {
      if (path === sessionPath) return session.promise;
      if (path === resultPath) return result.promise;
      return Promise.reject(new Error(`unexpected download ${path}`));
    });
    const onSession = vi.fn().mockResolvedValue(undefined);
    const onHeartbeat = vi.fn().mockResolvedValue(undefined);
    const execution = adapterFor(sandbox).executeWork(request, {
      lease_generation: 0,
      heartbeat_interval_ms: 10,
      on_heartbeat: onHeartbeat,
      on_session: onSession,
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    const downloadsBeforeEitherCompleted = sandbox.fs.downloadFile.mock.calls
      .map(([path]) => path)
      .filter((path) => path === sessionPath || path === resultPath);
    session.resolve(sessionEvent(request));
    result.resolve(runtimeResult(request));

    await expect(execution).resolves.toEqual({
      state: "work_failed",
      retryable: true,
      reason: "runtime failed",
    });
    expect(downloadsBeforeEitherCompleted).toEqual([sessionPath, resultPath]);
    expect(onSession).toHaveBeenCalledOnce();
    expect(onSession).toHaveBeenCalledWith("native-session-1");
    expect(onHeartbeat).toHaveBeenCalledOnce();
  });

  it("verifies a replayed input checkpoint from one binary download", async () => {
    const bytes = Buffer.from("existing checkpoint bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const pointer = {
      algorithm: "sha256",
      digest,
      bytes: bytes.byteLength,
      encoding: "binary",
      media_type: "application/x-git-bundle",
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
    } as const;
    const request = workRequest({
      context: {
        records: [],
        checkpoints: [{
          output_subject: "c".repeat(40),
          payload: { blob: pointer },
        }],
      },
    });
    const bundlePath = `/var/lib/openthrottle/action-input/attempt-1/work-lease-1/context-${digest}.bundle`;
    const stop = new Error("stop after checkpoint materialization");
    const sandbox = sandboxWith(async (path) => {
      if (path.endsWith("/session.json") || path.endsWith("/result.json")) {
        throw new Error("404 not found");
      }
      if (path === bundlePath) return bytes;
      if (path.endsWith("/request.json")) throw stop;
      throw new Error(`unexpected download ${path}`);
    });
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      if (command.includes("lease-generation.lock")) return sandbox.defaultExecuteCommand(command);
      return {
        exitCode: 0,
        result: command.startsWith("git bundle list-heads")
          ? `${request.input_subject} refs/openthrottle/checkpoints/${digest}\n`
          : "",
      };
    });
    const blobStore = { read: vi.fn().mockReturnValue(bytes) };

    await expect(adapterFor(sandbox, blobStore).executeWork(request, {
      lease_generation: 0,
      heartbeat_interval_ms: 10,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn(),
    })).rejects.toBe(stop);

    expect(sandbox.fs.downloadFile.mock.calls.filter(([path]) => path === bundlePath))
      .toHaveLength(1);
    expect(sandbox.fs.uploadFile).not.toHaveBeenCalledWith(bytes, bundlePath);
  });

  it("rejects a replaced source checkout before importing a checkpoint as executor", async () => {
    const bytes = Buffer.from("checkpoint bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const request = workRequest({
      context: {
        records: [],
        checkpoints: [{
          output_subject: "c".repeat(40),
          payload: { blob: {
            algorithm: "sha256",
            digest,
            bytes: bytes.byteLength,
            encoding: "binary",
            media_type: "application/x-git-bundle",
            payload_schema: "openthrottle.git-checkpoint-bundle/v1",
          } },
        }],
      },
    });
    const stop = new Error("checkpoint import reached the replaced repository");
    const sandbox = sandboxWith(async (path) => {
      if (path.endsWith("/request.json")) throw stop;
      throw new Error("404 not found");
    });
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      if (command.includes("lease-generation.lock")) return sandbox.defaultExecuteCommand(command);
      if (command.includes("/var/lib/openthrottle/repository-source")) {
        return { exitCode: 45, result: "" };
      }
      if (command.startsWith("git bundle list-heads")) {
        return {
          exitCode: 0,
          result: `${request.input_subject} refs/openthrottle/checkpoints/${digest}\n`,
        };
      }
      return { exitCode: 0, result: "" };
    });

    await expect(adapterFor(sandbox, { read: vi.fn().mockReturnValue(bytes) }).executeWork(request, {
      lease_generation: 0,
      heartbeat_interval_ms: 10,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn(),
    })).rejects.toThrow("repository source physical fence is invalid");
    expect(sandbox.process.executeCommand.mock.calls.some(
      ([command]) => String(command).startsWith("git bundle list-heads"),
    )).toBe(false);
  });

  it("fails closed before accepting a replay when the exact lease heartbeat is lost", async () => {
    const request = workRequest();
    const resultPath = "/var/lib/openthrottle/action-results/attempt-1/work-lease-1/result.json";
    const sandbox = sandboxWith(async (path) => {
      if (path === resultPath) return runtimeResult(request);
      throw new Error("404 not found");
    });
    const lost = new Error("attempt lease heartbeat lost its exact worker fence");

    await expect(adapterFor(sandbox).executeWork(request, {
      lease_generation: 0,
      heartbeat_interval_ms: 1,
      on_heartbeat: vi.fn().mockRejectedValue(lost),
      on_session: vi.fn(),
    })).rejects.toBe(lost);
    expect(sandbox.fs.downloadFile.mock.calls.some(([path]) =>
      path.endsWith("/session.json") || path.endsWith("/result.json"))).toBe(false);
  });

  it("publishes one exact idempotent steering envelope through a staged agent-owned file", async () => {
    const files = new Map<string, Buffer>();
    const sandbox = sandboxWith(async (path) => {
      const value = files.get(path);
      if (!value) throw new Error("404 not found");
      return value;
    });
    sandbox.fs.uploadFile.mockImplementation(async (bytes: Buffer, path: string) => {
      files.set(path, Buffer.from(bytes));
    });
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      const match = /^mv -n -- '([^']+)' '([^']+)'$/.exec(command);
      if (match) {
        const staged = files.get(match[1]!);
        if (staged && !files.has(match[2]!)) files.set(match[2]!, Buffer.from(staged));
      }
      return { exitCode: 0, result: "" };
    });
    const delivery = (id: string, effectKind: string) => ({
      id,
      kind: "delivery",
      pipeline_run_id: "run-1",
      attempt_id: "attempt-1",
      sequence: id === "delivery-create" ? 1 : 2,
      status: "confirmed",
      payload_schema: "openthrottle.effect-delivery/v1",
      payload: {
        inline: {
          effect_kind: effectKind,
          provider: "daytona",
          result: { sandbox_id: "sandbox-1", resource_state: "started" },
        },
      },
      created_at: "2026-08-20T12:00:00.000Z",
    });
    const attemptInputs = {
      loadAttemptRequestInputs: vi.fn().mockResolvedValue({
        task_prompt: "task",
        context: {
          records: new Map([
            ["delivery-create", delivery("delivery-create", "daytona/create-sandbox@1")],
            ["delivery-start", delivery("delivery-start", "daytona/start-sandbox@1")],
          ]),
          checkpoints: new Map(),
        },
      }),
    };
    const binding: KernelRuntimeSessionBinding = {
      pipeline_run_id: "run-1",
      attempt_id: "attempt-1",
      request_hash: "a".repeat(64),
      definition_bundle_hash: "b".repeat(64),
      input_subject: "c".repeat(40),
      native_session_id: "session-1",
      generation: 0,
      attempt_status: "running",
      repository_authority: "edit",
      lease_id: "lease-1",
      lease_generation: 0,
      lease_worker_id: "worker-1",
      lease_purpose: "work",
      lease_expires_at: "2026-08-20T12:05:00.000Z",
      lease_started: true,
    };
    const envelope = createKernelSteeringEnvelope({
      message_id: "message-1",
      source: "operator",
      body: "Also cover restart recovery.",
      binding,
    });
    const authorized = authorizeKernelSteeringDelivery({
      envelope,
      current_binding: binding,
    });
    const adapter = adapterFor(sandbox, {}, attemptInputs);
    const input = {
      event_id: "event-1",
      delivery_id: "delivery-1",
      envelope,
      authorized,
    };

    await adapter.deliverSteering(input);
    await adapter.deliverSteering(input);

    expect(sandbox.fs.uploadFile).toHaveBeenCalledOnce();
    const [uploaded, stagedPath] = sandbox.fs.uploadFile.mock.calls[0]!;
    expect(stagedPath).toMatch(/^\/home\/agent\/\.ot\/inbox\/steering-[a-f0-9]{64}\.json\.part$/);
    expect(JSON.parse((uploaded as Buffer).toString("utf8"))).toEqual({
      schema: "openthrottle.kernel-steering/v1",
      event_id: "event-1",
      delivery_id: "delivery-1",
      message_id: "message-1",
      source: "operator",
      body: "Also cover restart recovery.",
      pipeline_run_id: "run-1",
      attempt_id: "attempt-1",
      request_hash: "a".repeat(64),
      definition_bundle_hash: "b".repeat(64),
      input_subject: "c".repeat(40),
      native_session_id: "session-1",
      generation: 0,
      lease_id: "lease-1",
      lease_generation: 0,
      lease_purpose: "work",
    });
    expect(sandbox.fs.setFilePermissions).toHaveBeenCalledWith(
      stagedPath,
      { owner: "agent", group: "agent", mode: "600" },
    );
  });

  it("atomically advances the private lease-generation fence on recovery and rejects stale refreshes", async () => {
    const first = workRequest();
    const recovered = workRequest({ lease_id: "lease-2" });
    const sandbox = sandboxWith(async (path) => {
      if (path.endsWith("/work-lease-1/result.json")) return runtimeResult(first);
      if (path.endsWith("/work-lease-2/result.json")) return runtimeResult(recovered);
      throw new Error("404 not found");
    });
    const adapter = adapterFor(sandbox);
    const callbacks = (lease_generation: number) => ({
      lease_generation,
      heartbeat_interval_ms: 10,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn(),
    });

    await expect(adapter.executeWork(first, callbacks(0))).resolves.toMatchObject({ state: "work_failed" });
    await expect(adapter.executeWork(recovered, callbacks(1))).resolves.toMatchObject({ state: "work_failed" });
    const fencePath = "/var/lib/openthrottle/action-fences/attempt-1/lease-generation.json";
    expect(JSON.parse(sandbox.files.get(fencePath)!.toString("utf8"))).toEqual({
      schema: "openthrottle.kernel-lease-generation-fence/v1",
      attempt_id: "attempt-1",
      lease_generation: 1,
    });
    await expect(adapter.executeWork(first, callbacks(0))).rejects.toThrow(/newer lease-generation fence/);
  });

  it("does not publish a crashed generation's staged fence when the same lease recovers", async () => {
    const request = workRequest();
    const resultPath = "/var/lib/openthrottle/action-results/attempt-1/work-lease-1/result.json";
    const sandbox = sandboxWith(async (path) => {
      if (path === resultPath) return runtimeResult(request);
      throw new Error("404 not found");
    });
    let crashBeforeFirstPublish = true;
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      if (command.startsWith("flock --exclusive ") && crashBeforeFirstPublish) {
        crashBeforeFirstPublish = false;
        throw new Error("simulated process loss after staged upload");
      }
      return sandbox.defaultExecuteCommand(command);
    });
    const adapter = adapterFor(sandbox);
    const callbacks = (lease_generation: number) => ({
      lease_generation,
      heartbeat_interval_ms: 10,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn(),
    });

    await expect(adapter.executeWork(request, callbacks(0)))
      .rejects.toThrow("simulated process loss after staged upload");
    const staleStage = "/var/lib/openthrottle/action-fences/attempt-1/lease-generation-lease-1-0.part";
    expect(JSON.parse(sandbox.files.get(staleStage)!.toString("utf8"))).toMatchObject({
      lease_generation: 0,
    });

    await expect(adapter.executeWork(request, callbacks(1))).resolves.toMatchObject({ state: "work_failed" });
    const fencePath = "/var/lib/openthrottle/action-fences/attempt-1/lease-generation.json";
    expect(JSON.parse(sandbox.files.get(fencePath)!.toString("utf8"))).toEqual({
      schema: "openthrottle.kernel-lease-generation-fence/v1",
      attempt_id: "attempt-1",
      lease_generation: 1,
    });
    expect(sandbox.files.get(staleStage)).toBeDefined();
  });

  it("settles promptly when the asynchronous entrypoint exits without a sealed result", async () => {
    vi.useFakeTimers();
    try {
      const request = workRequest();
      const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
      sandbox.process.getSessionCommand.mockResolvedValue({ cmdId: "command-1", exitCode: 1 });
      const execution = adapterFor(sandbox, {}, {}, { task_timeout_seconds: 60 }).executeWork(request, {
        lease_generation: 0,
        heartbeat_interval_ms: 10_000,
        on_heartbeat: vi.fn().mockResolvedValue(undefined),
        on_session: vi.fn(),
      });
      let settled = false;
      void execution.then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(5);
      const settledPromptly = settled;
      await vi.advanceTimersByTimeAsync(60_100);

      await expect(execution).resolves.toEqual({
        state: "work_failed",
        retryable: true,
        reason: "Daytona action command exited with code 1 without producing a sealed result; session termination was verified",
      });
      expect(settledPromptly).toBe(true);
      expect(sandbox.process.getSessionCommand).toHaveBeenCalledWith(
        "kernel-attempt-1",
        "command-1",
      );
      expect(sandbox.process.deleteSession).toHaveBeenCalledWith("kernel-attempt-1");
      expect(sandbox.process.getSession).toHaveBeenCalledWith("kernel-attempt-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts an existing Attempt command when the asynchronous launch lock is contended", async () => {
    const request = workRequest();
    const resultPath = "/var/lib/openthrottle/action-results/attempt-1/work-lease-1/result.json";
    let resultReads = 0;
    const sandbox = sandboxWith(async (path) => {
      if (path === resultPath && ++resultReads === 4) return runtimeResult(request);
      throw new Error("404 not found");
    });
    sandbox.process.getSessionCommand.mockResolvedValue({ cmdId: "command-1", exitCode: 75 });

    await expect(adapterFor(sandbox).executeWork(request, {
      lease_generation: 1,
      heartbeat_interval_ms: 10,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn(),
    })).resolves.toEqual({
      state: "work_failed",
      retryable: true,
      reason: "runtime failed",
    });
    expect(resultReads).toBe(4);
    expect(sandbox.process.executeSessionCommand).toHaveBeenCalledWith(
      "kernel-attempt-1",
      expect.objectContaining({
        command: expect.stringContaining("flock --nonblock --conflict-exit-code 75 "),
      }),
      expect.any(Number),
    );
    expect(sandbox.process.getSessionCommand).toHaveBeenCalledWith(
      "kernel-attempt-1",
      "command-1",
    );
    expect(sandbox.process.deleteSession).not.toHaveBeenCalled();
  });

  it("terminates an asynchronously launched session when Daytona omits its launch response", async () => {
    const request = workRequest();
    const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
    sandbox.process.executeSessionCommand.mockResolvedValue(undefined);

    await expect(adapterFor(sandbox).executeWork(request, {
      lease_generation: 0,
      heartbeat_interval_ms: 10,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn(),
    })).resolves.toEqual({
      state: "work_failed",
      retryable: true,
      reason: "Daytona action launch omitted its command identity; session termination was verified",
    });
    expect(sandbox.process.deleteSession).toHaveBeenCalledWith("kernel-attempt-1");
    expect(sandbox.process.getSession).toHaveBeenCalledWith("kernel-attempt-1");
    expect(sandbox.process.getSessionCommand).not.toHaveBeenCalled();
  });

  it("fails closed when a command-less Daytona launch cannot be proven terminated", async () => {
    const request = workRequest();
    const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
    sandbox.process.executeSessionCommand.mockResolvedValue({ cmdId: undefined });
    sandbox.process.getSession.mockResolvedValue({ id: "kernel-attempt-1" });

    await expect(adapterFor(sandbox).executeWork(request, {
      lease_generation: 0,
      heartbeat_interval_ms: 10,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn(),
    })).resolves.toEqual({
      state: "work_failed",
      retryable: false,
      reason: "Daytona action launch omitted its command identity and session termination could not be verified",
    });
    expect(sandbox.process.deleteSession).toHaveBeenCalledWith("kernel-attempt-1");
    expect(sandbox.process.getSessionCommand).not.toHaveBeenCalled();
  });

  it("accepts a sealed result that races asynchronous command completion", async () => {
    const request = workRequest();
    const resultPath = "/var/lib/openthrottle/action-results/attempt-1/work-lease-1/result.json";
    let resultReads = 0;
    const sandbox = sandboxWith(async (path) => {
      if (path === resultPath && ++resultReads === 3) return runtimeResult(request);
      throw new Error("404 not found");
    });
    sandbox.process.getSessionCommand.mockResolvedValue({ cmdId: "command-1", exitCode: 0 });

    await expect(adapterFor(sandbox).executeWork(request, {
      lease_generation: 0,
      heartbeat_interval_ms: 10,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn(),
    })).resolves.toEqual({
      state: "work_failed",
      retryable: true,
      reason: "runtime failed",
    });
    expect(resultReads).toBe(3);
    expect(sandbox.process.deleteSession).not.toHaveBeenCalled();
  });

  it("final-collects and verifies Daytona session termination before allowing a deadline retry", async () => {
    vi.useFakeTimers();
    try {
      const request = workRequest({
        action: {
          kind: "command",
          command_id: "command-1",
          command_line: "true",
          post_bootstrap: [],
          execution_limits: { max_turns: null, task_timeout_seconds: 1 },
        },
      });
      const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
      const adapter = adapterFor(sandbox, {}, {}, { task_timeout_seconds: 60 });
      const execution = adapter.executeWork(request, {
        lease_generation: 0,
        heartbeat_interval_ms: 10_000,
        on_heartbeat: vi.fn().mockResolvedValue(undefined),
        on_session: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(1_100);

      await expect(execution).resolves.toMatchObject({
        state: "work_failed",
        retryable: true,
        reason: expect.stringMatching(/termination was verified/),
      });
      expect(sandbox.process.deleteSession).toHaveBeenCalledWith("kernel-attempt-1");
      expect(sandbox.process.getSession).toHaveBeenCalledWith("kernel-attempt-1");
      expect(sandbox.process.executeSessionCommand).toHaveBeenCalledWith(
        "kernel-attempt-1",
        expect.any(Object),
        1,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when Daytona cannot prove the timed-out session is absent", async () => {
    vi.useFakeTimers();
    try {
      const request = workRequest({
        action: {
          kind: "command",
          command_id: "command-1",
          command_line: "true",
          post_bootstrap: [],
          execution_limits: { max_turns: null, task_timeout_seconds: 1 },
        },
      });
      const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
      sandbox.process.getSession.mockResolvedValue({ sessionId: "kernel-attempt-1", commands: [] });
      const execution = adapterFor(sandbox).executeWork(request, {
        lease_generation: 0,
        heartbeat_interval_ms: 10_000,
        on_heartbeat: vi.fn().mockResolvedValue(undefined),
        on_session: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(1_100);

      await expect(execution).resolves.toEqual({
        state: "work_failed",
        retryable: false,
        reason: "Daytona action deadline expired and session termination could not be verified",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
