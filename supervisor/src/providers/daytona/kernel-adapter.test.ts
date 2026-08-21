import { createHash } from "node:crypto";
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
  return {
    id: "sandbox-1",
    state: "started",
    autoStopInterval: 60,
    fs: {
      downloadFile: vi.fn(downloadFile),
      createFolder: vi.fn().mockResolvedValue(undefined),
      setFilePermissions: vi.fn().mockResolvedValue(undefined),
      uploadFile: vi.fn().mockResolvedValue(undefined),
    },
    process: {
      createSession: vi.fn().mockResolvedValue(undefined),
      executeSessionCommand: vi.fn().mockResolvedValue(undefined),
      executeCommand: vi.fn().mockResolvedValue({ exitCode: 0, result: "" }),
    },
    updateEnv: vi.fn().mockResolvedValue(undefined),
  };
}

function adapterFor(
  sandbox: ReturnType<typeof sandboxWith>,
  blobStore: object = {},
  attemptInputs: object = {},
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
      heartbeat_interval_ms: 10,
      on_heartbeat: onHeartbeat,
      on_session: onSession,
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    const downloadsBeforeEitherCompleted = sandbox.fs.downloadFile.mock.calls
      .map(([path]) => path);
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
    sandbox.process.executeCommand.mockImplementation(async (command: string) => ({
      exitCode: 0,
      result: command.startsWith("git bundle list-heads")
        ? `${request.input_subject} refs/openthrottle/checkpoints/${digest}\n`
        : "",
    }));
    const blobStore = { read: vi.fn().mockReturnValue(bytes) };

    await expect(adapterFor(sandbox, blobStore).executeWork(request, {
      heartbeat_interval_ms: 10,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn(),
    })).rejects.toBe(stop);

    expect(sandbox.fs.downloadFile.mock.calls.filter(([path]) => path === bundlePath))
      .toHaveLength(1);
    expect(sandbox.fs.uploadFile).not.toHaveBeenCalledWith(bytes, bundlePath);
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
      heartbeat_interval_ms: 1,
      on_heartbeat: vi.fn().mockRejectedValue(lost),
      on_session: vi.fn(),
    })).rejects.toBe(lost);
    expect(sandbox.fs.downloadFile).not.toHaveBeenCalled();
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
      lease_purpose: "work",
    });
    expect(sandbox.fs.setFilePermissions).toHaveBeenCalledWith(
      stagedPath,
      { owner: "agent", group: "agent", mode: "600" },
    );
  });
});
