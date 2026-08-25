import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliveryRecord, EffectIntent } from "@openthrottle/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  KERNEL_ACTION_REQUEST_SCHEMA,
  KERNEL_RESULT_CORRECTION_REQUEST_SCHEMA,
  type KernelResultCorrectionRequest,
  type KernelWorkActionRequest,
} from "../../runtime/kernel-contracts.js";
import { KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES } from "../../runtime/kernel-wire.js";
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
    checkpoint_base_subject: "c".repeat(40),
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

function correctionRequest(overrides: Record<string, unknown> = {}): KernelResultCorrectionRequest {
  return {
    schema: KERNEL_RESULT_CORRECTION_REQUEST_SCHEMA,
    phase: "result_correction",
    engine: "codex",
    model: null,
    reasoning_effort: null,
    pipeline_run_id: "run-1",
    attempt_id: "attempt-1",
    stage_id: "stage-1",
    scope: { kind: "stage", stage_id: "stage-1" },
    request_hash: "a".repeat(64),
    definition_bundle_hash: "b".repeat(64),
    checkpoint_base_subject: "c".repeat(40),
    input_subject: "c".repeat(40),
    locked_subject: "c".repeat(40),
    completed_work_authority: "inspect",
    checkpoint_id: "checkpoint-1",
    native_session_id: "native-session-1",
    lease_id: "lease-2",
    worker_id: "worker-1",
    correction_deadline: "2099-08-20T13:00:00.000Z",
    diagnostics: [{ path: "/payload", detail: "provider emitted conflicting final result candidates" }],
    semantic_result_schema: {
      schema: "openthrottle.semantic-result-schema/v1",
      id: "result-schema-1",
      outcomes: ["success"],
      payload: {},
    },
    execution_limits: { max_turns: null, task_timeout_seconds: 60 },
    repository_authority: "inspect",
    tools: ["ot-result"],
    mcp: false,
    provider_access: false,
    ...overrides,
  } as KernelResultCorrectionRequest;
}

function runtimeDelivery(kind: "create" | "start"): DeliveryRecord {
  return {
    schema: "openthrottle.record/v1",
    id: `delivery-${kind}`,
    kind: "delivery",
    pipeline_run_id: "run-1",
    effect_id: `effect-${kind}`,
    idempotency_key: `run-1:${kind}`,
    external_identity: "daytona:sandbox-1",
    status: "confirmed",
    payload_schema: "openthrottle.effect-delivery/v1",
    payload: { inline: {
      effect_kind: `daytona/${kind}-sandbox@1`,
      provider: "daytona",
      observed_via: "reconciliation",
      result: { sandbox_id: "sandbox-1" },
    } },
    created_at: "2026-08-20T12:00:00.000Z",
  };
}

function sandboxWith(downloadFile: (path: string) => Promise<Buffer>) {
  const files = new Map<string, Buffer>();
  const daemonEnvironment = new Map<string, string>();
  const sessionEnvironments = new Map<string, Record<string, string>>();
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
      createSession: vi.fn(async (sessionId: string) => {
        if (!sessionEnvironments.has(sessionId)) {
          sessionEnvironments.set(sessionId, Object.fromEntries(daemonEnvironment));
        }
      }),
      executeSessionCommand: vi.fn().mockResolvedValue({ cmdId: "command-1" }),
      executeCommand: vi.fn(defaultExecuteCommand),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockRejectedValue(new Error("404 not found")),
      getSessionCommand: vi.fn().mockResolvedValue({ cmdId: "command-1", exitCode: undefined }),
    },
    git: {
      clone: vi.fn().mockResolvedValue(undefined),
    },
    updateEnv: vi.fn(async (
      env: Record<string, string>,
      options?: { unset?: readonly string[] },
    ) => {
      for (const name of options?.unset ?? []) daemonEnvironment.delete(name);
      for (const [name, value] of Object.entries(env)) daemonEnvironment.set(name, value);
    }),
    files,
    sessionEnvironments,
    defaultExecuteCommand,
  };
}

function createdSessionId(
  sandbox: ReturnType<typeof sandboxWith>,
  index = 0,
): string {
  const value = sandbox.process.createSession.mock.calls[index]?.[0];
  if (typeof value !== "string") throw new Error(`missing created Daytona session ${index}`);
  return value;
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
    list: vi.fn(() => (async function* () { yield sandbox; })()),
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

function selfContainedCheckpointBundle(requestHash: string) {
  const root = mkdtempSync(join(tmpdir(), "ot-daytona-inspect-checkpoint-"));
  const repository = join(root, "repository");
  const bundle = join(root, "checkpoint.bundle");
  try {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", repository]);
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
    writeFileSync(join(repository, "evidence.txt"), "self-contained evidence\n");
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "--quiet", "-m", "synthetic evidence"], { cwd: repository });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    const ref = `refs/openthrottle/checkpoints/${requestHash}`;
    execFileSync("git", ["update-ref", ref, commit], { cwd: repository });
    execFileSync("git", ["bundle", "create", bundle, ref], { cwd: repository });
    const bytes = readFileSync(bundle);
    return {
      bytes,
      descriptor: {
        file: "checkpoint.bundle",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
        media_type: "application/x-git-bundle",
        payload_schema: "openthrottle.git-checkpoint-bundle/v1",
        ref,
        commit,
        tree,
      },
    } as const;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function boundedEditCheckpointBundle(requestHash: string) {
  const root = mkdtempSync(join(tmpdir(), "ot-daytona-edit-checkpoint-"));
  const repository = join(root, "repository");
  const bundle = join(root, "checkpoint.bundle");
  try {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", repository]);
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
    writeFileSync(join(repository, "base.txt"), "base\n");
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: repository });
    execFileSync("git", ["switch", "--quiet", "--create", "topic"], { cwd: repository });
    writeFileSync(join(repository, "topic.txt"), "topic\n");
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "--quiet", "-m", "topic"], { cwd: repository });
    execFileSync("git", ["switch", "--quiet", "main"], { cwd: repository });
    writeFileSync(join(repository, "main.txt"), "main\n");
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "--quiet", "-m", "main"], { cwd: repository });
    execFileSync("git", ["merge", "--quiet", "--no-ff", "topic", "-m", "merge input"], {
      cwd: repository,
    });
    const input = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(repository, "edit.txt"), "edited\n");
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "--quiet", "-m", "edit output"], { cwd: repository });
    const output = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    const ref = `refs/openthrottle/checkpoints/${requestHash}`;
    execFileSync("git", ["update-ref", ref, output], { cwd: repository });
    writeFileSync(join(repository, ".git", "shallow"), `${input}\n`);
    execFileSync("git", ["bundle", "create", bundle, ref], { cwd: repository });
    const bytes = readFileSync(bundle);
    return {
      bytes,
      input,
      output,
      descriptor: {
        file: "checkpoint.bundle",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
        media_type: "application/x-git-bundle",
        payload_schema: "openthrottle.git-checkpoint-bundle/v1",
        ref,
        commit: output,
        tree,
      },
    } as const;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function integrationProofFromIdentity(
  candidate: ReturnType<typeof selfContainedCheckpointBundle>,
) {
  const root = mkdtempSync(join(tmpdir(), "ot-daytona-integration-proof-"));
  const repository = join(root, "repository");
  const candidatePath = join(root, "candidate.bundle");
  const proofPath = join(root, "proof.bundle");
  try {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", repository]);
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
    writeFileSync(candidatePath, candidate.bytes);
    execFileSync("git", ["fetch", "--quiet", candidatePath, candidate.descriptor.ref], {
      cwd: repository,
    });
    const commit = execFileSync("git", [
      "commit-tree", candidate.descriptor.tree,
      "-p", candidate.descriptor.commit,
      "-m", "current integration proof",
    ], { cwd: repository, encoding: "utf8" }).trim();
    const ref = `refs/openthrottle/integrations/${"9".repeat(64)}`;
    execFileSync("git", ["update-ref", ref, commit], { cwd: repository });
    writeFileSync(join(repository, ".git", "shallow"), `${candidate.descriptor.commit}\n`);
    execFileSync("git", ["bundle", "create", proofPath, ref], { cwd: repository });
    const bytes = readFileSync(proofPath);
    return {
      bytes,
      pointer: {
        algorithm: "sha256",
        digest: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
        encoding: "binary",
        media_type: "application/x-git-bundle",
        payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      } as const,
      descriptor: {
        file: "proof.bundle",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.byteLength,
        media_type: "application/x-git-bundle",
        payload_schema: "openthrottle.git-checkpoint-bundle/v1",
        ref,
        commit,
        tree: candidate.descriptor.tree,
      } as const,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function integrationIntentWithSealedBundleSizes(input: {
  candidate_bytes: number;
  ancestry_bytes: number;
}): EffectIntent {
  const candidateInput = "1".repeat(40);
  const ancestryOutput = "2".repeat(40);
  const candidateDigest = "3".repeat(64);
  const ancestryDigest = "4".repeat(64);
  const pointer = (digest: string, bytes: number) => ({
    algorithm: "sha256",
    digest,
    bytes,
    encoding: "binary",
    media_type: "application/x-git-bundle",
    payload_schema: "openthrottle.git-checkpoint-bundle/v1",
  } as const);
  const candidatePointer = pointer(candidateDigest, input.candidate_bytes);
  const ancestryPointer = pointer(ancestryDigest, input.ancestry_bytes);
  return {
    schema: "openthrottle.effect-intent/v1",
    id: "effect-integration-budget",
    pipeline_run_id: "run-1",
    decision_record_id: "decision-integration-budget",
    kind: "daytona/integrate-checkpoint@1",
    idempotency_key: "run-1:integrate:checkpoint-budget",
    target: `daytona:${"d".repeat(64)}:integration:checkpoint-budget`,
    subject: null,
    payload: {
      schema: "openthrottle.daytona-integration/v1",
      identity: "d".repeat(64),
      pipeline_run_id: "run-1",
      attempt_id: "attempt-integration-budget",
      definition_bundle_hash: "b".repeat(64),
      checkpoint_base_subject: candidateInput,
      current_subject: ancestryOutput,
      candidate_checkpoint_id: `checkpoint:${"c".repeat(32)}`,
      candidate_input_subject: candidateInput,
      candidate_output_subject: candidateInput,
      candidate_blob: candidatePointer,
      candidate_artifact: {
        file: "candidate.bundle",
        sha256: candidateDigest,
        bytes: input.candidate_bytes,
        media_type: "application/x-git-bundle",
        payload_schema: "openthrottle.git-checkpoint-bundle/v1",
        ref: `refs/openthrottle/checkpoints/${candidateDigest}`,
        commit: candidateInput,
        tree: "5".repeat(40),
      },
      current_ancestry: [{
        checkpoint_id: `checkpoint:${"a".repeat(32)}`,
        input_subject: candidateInput,
        output_subject: ancestryOutput,
        checkpoint_blob: ancestryPointer,
        checkpoint_artifact: {
          file: "ancestry.bundle",
          sha256: ancestryDigest,
          bytes: input.ancestry_bytes,
          media_type: "application/x-git-bundle",
          payload_schema: "openthrottle.git-checkpoint-bundle/v1",
          ref: `refs/openthrottle/integrations/${ancestryDigest}`,
          commit: ancestryOutput,
          tree: "6".repeat(40),
        },
      }],
    },
  };
}

function integrationIntentFor(
  candidate: ReturnType<typeof selfContainedCheckpointBundle>,
  effectId: string,
): EffectIntent {
  const candidatePointer = {
    algorithm: "sha256",
    digest: candidate.descriptor.sha256,
    bytes: candidate.descriptor.bytes,
    encoding: "binary",
    media_type: "application/x-git-bundle",
    payload_schema: "openthrottle.git-checkpoint-bundle/v1",
  } as const;
  return {
    schema: "openthrottle.effect-intent/v1",
    id: effectId,
    pipeline_run_id: "run-1",
    decision_record_id: `decision-${effectId}`,
    kind: "daytona/integrate-checkpoint@1",
    idempotency_key: `run-1:integrate:${effectId}`,
    target: `daytona:${"d".repeat(64)}:integration:${effectId}`,
    subject: null,
    payload: {
      schema: "openthrottle.daytona-integration/v1",
      identity: "d".repeat(64),
      pipeline_run_id: "run-1",
      attempt_id: "attempt-integration",
      definition_bundle_hash: "b".repeat(64),
      checkpoint_base_subject: candidate.descriptor.commit,
      current_subject: candidate.descriptor.commit,
      candidate_checkpoint_id: "checkpoint-candidate",
      candidate_input_subject: candidate.descriptor.commit,
      candidate_output_subject: candidate.descriptor.commit,
      candidate_blob: candidatePointer,
      candidate_artifact: candidate.descriptor,
      current_ancestry: [],
    },
  };
}

function checkpointWire(
  request: KernelWorkActionRequest,
  descriptor: ReturnType<typeof selfContainedCheckpointBundle>["descriptor"],
  nativeSessionId: string | null,
) {
  return {
    schema: "openthrottle.attempt-checkpoint-wire/v1",
    id: `checkpoint:${request.request_hash.slice(0, 32)}`,
    pipeline_run_id: request.pipeline_run_id,
    attempt_id: request.attempt_id,
    request_hash: request.request_hash,
    definition_bundle_hash: request.definition_bundle_hash,
    input_subject: request.input_subject,
    output_subject: null,
    native_session_id: nativeSessionId,
    payload_schema: "openthrottle.git-checkpoint-bundle/v1",
    payload_artifact: descriptor,
    captured_at: "2026-08-20T12:00:00.000Z",
  };
}

function checkpointRuntimeResult(
  request: KernelWorkActionRequest,
  checkpoint: ReturnType<typeof checkpointWire>,
  state: "command" | "inspect",
): Buffer {
  return Buffer.from(JSON.stringify({
    schema: "openthrottle.kernel-runtime-result/v1",
    pipeline_run_id: request.pipeline_run_id,
    attempt_id: request.attempt_id,
    request_hash: request.request_hash,
    definition_bundle_hash: request.definition_bundle_hash,
    lease_id: request.lease_id,
    worker_id: request.worker_id,
    outcome: state === "command" ? {
      state: "work_complete",
      checkpoint,
      result: {
        kind: "command",
        outcome: "success",
        command_id: "command-1",
        exit_code: 0,
        summary: "command completed",
      },
    } : {
      state: "result_pending",
      checkpoint,
      candidate_hash: null,
      diagnostics: [{ path: "/payload", detail: "result needs correction" }],
      correction_deadline: "2099-08-20T12:15:00.000Z",
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

function correctionCheckpointRuntimeResult(
  request: KernelResultCorrectionRequest,
  descriptor: ReturnType<typeof selfContainedCheckpointBundle>["descriptor"],
  outputSubject: string | null,
): Buffer {
  return Buffer.from(JSON.stringify({
    schema: "openthrottle.kernel-runtime-result/v1",
    pipeline_run_id: request.pipeline_run_id,
    attempt_id: request.attempt_id,
    request_hash: request.request_hash,
    definition_bundle_hash: request.definition_bundle_hash,
    lease_id: request.lease_id,
    worker_id: request.worker_id,
    outcome: {
      state: "needs_human",
      reason: "correction remains invalid",
      checkpoint: {
        schema: "openthrottle.attempt-checkpoint-wire/v1",
        id: request.checkpoint_id,
        pipeline_run_id: request.pipeline_run_id,
        attempt_id: request.attempt_id,
        request_hash: request.request_hash,
        definition_bundle_hash: request.definition_bundle_hash,
        input_subject: request.input_subject,
        output_subject: outputSubject,
        native_session_id: request.native_session_id,
        payload_schema: "openthrottle.git-checkpoint-bundle/v1",
        payload_artifact: descriptor,
        captured_at: "2026-08-20T12:00:00.000Z",
      },
      candidate_hash: null,
      diagnostics: request.diagnostics,
    },
  }));
}

function correctionCheckpointExecution(
  request: KernelResultCorrectionRequest,
  artifact: ReturnType<typeof selfContainedCheckpointBundle>,
  outputSubject: string | null,
) {
  const resultDirectory = "/var/lib/openthrottle/action-results/attempt-1/correction-lease-2";
  const sandbox = sandboxWith(async (path) => {
    if (path === `${resultDirectory}/result.json`) {
      return correctionCheckpointRuntimeResult(request, artifact.descriptor, outputSubject);
    }
    if (path === `${resultDirectory}/${artifact.descriptor.file}`) return artifact.bytes;
    throw new Error("404 not found");
  });
  const pointer = {
    algorithm: "sha256",
    digest: artifact.descriptor.sha256,
    bytes: artifact.descriptor.bytes,
    encoding: "binary",
    media_type: "application/x-git-bundle",
    payload_schema: "openthrottle.git-checkpoint-bundle/v1",
  } as const;
  const put = vi.fn().mockReturnValue({ pointer });
  const records = [runtimeDelivery("create"), runtimeDelivery("start")];
  const execution = adapterFor(sandbox, { put }, {
    loadAttemptRequestInputs: vi.fn().mockResolvedValue({
      task_prompt: "execute the sealed task",
      context: {
        records: new Map(records.map((record) => [record.id, record])),
        checkpoints: new Map(),
      },
    }),
  }).correctResult(request, {
    lease_generation: 0,
    heartbeat_interval_ms: 10,
    on_heartbeat: vi.fn().mockResolvedValue(undefined),
  });
  return { execution, put };
}

describe("DaytonaKernelAdapter", () => {
  it("replays a bounded edit checkpoint during result correction from a non-root merge input", async () => {
    const artifact = boundedEditCheckpointBundle("a".repeat(64));
    const request = correctionRequest({
      checkpoint_base_subject: artifact.input,
      input_subject: artifact.input,
      locked_subject: artifact.output,
      completed_work_authority: "edit",
    });
    const { execution, put } = correctionCheckpointExecution(request, artifact, artifact.output);

    await expect(execution).resolves.toMatchObject({
      state: "needs_human",
      checkpoint: {
        input_subject: artifact.input,
        output_subject: artifact.output,
      },
    });
    expect(put).toHaveBeenCalledOnce();
  });

  it("keeps an inspect checkpoint self-contained during result correction", async () => {
    const request = correctionRequest();
    const artifact = selfContainedCheckpointBundle(request.request_hash);
    const { execution, put } = correctionCheckpointExecution(request, artifact, null);

    await expect(execution).resolves.toMatchObject({
      state: "needs_human",
      checkpoint: {
        input_subject: request.input_subject,
        output_subject: null,
      },
    });
    expect(put).toHaveBeenCalledOnce();
  });

  it.each(["command", "inspect"] as const)(
    "ingests a self-contained output-null %s checkpoint without imposing the request input as its parent",
    async (kind) => {
      const request = workRequest(kind === "inspect" ? {
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
      } : {});
      const artifact = selfContainedCheckpointBundle(request.request_hash);
      const nativeSessionId = kind === "inspect" ? "native-session-1" : null;
      const checkpoint = checkpointWire(request, artifact.descriptor, nativeSessionId);
      const resultPath = "/var/lib/openthrottle/action-results/attempt-1/work-lease-1/result.json";
      const sessionPath = "/var/lib/openthrottle/action-results/attempt-1/work-lease-1/session.json";
      const artifactPath = `/var/lib/openthrottle/action-results/attempt-1/work-lease-1/${artifact.descriptor.file}`;
      const sandbox = sandboxWith(async (path) => {
        if (path === resultPath) return checkpointRuntimeResult(request, checkpoint, kind);
        if (path === sessionPath && kind === "inspect") return sessionEvent(request);
        if (path === artifactPath) return artifact.bytes;
        throw new Error("404 not found");
      });
      const pointer = {
        algorithm: "sha256",
        digest: artifact.descriptor.sha256,
        bytes: artifact.descriptor.bytes,
        encoding: "binary",
        media_type: "application/x-git-bundle",
        payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      } as const;
      const put = vi.fn().mockReturnValue({ pointer });

      await expect(adapterFor(sandbox, { put }).executeWork(request, {
        lease_generation: 0,
        heartbeat_interval_ms: 10,
        on_heartbeat: vi.fn().mockResolvedValue(undefined),
        on_session: vi.fn().mockResolvedValue(undefined),
      })).resolves.toMatchObject({
        state: kind === "command" ? "work_complete" : "result_pending",
        checkpoint: { input_subject: request.input_subject, output_subject: null },
      });
      expect(put).toHaveBeenCalledOnce();
    },
  );

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

  it("clears the opposite request family before Daytona sessions snapshot daemon env", async () => {
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
    const candidate = selfContainedCheckpointBundle(request.request_hash);
    const beforeAction = integrationIntentFor(candidate, "effect-before-action");
    const afterAction = integrationIntentFor(candidate, "effect-after-action");
    const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
    emulateRepositoryBinding(sandbox);
    sandbox.process.executeSessionCommand.mockImplementation(async (sessionId: string) => {
      const environment = sandbox.sessionEnvironments.get(sessionId);
      if (!environment) throw new Error(`missing Daytona session environment for ${sessionId}`);
      if (
        sessionId.startsWith("kernel-action-") &&
        !environment.OT_INTEGRATION_REQUEST_FILE &&
        !environment.OT_INTEGRATION_RESULT_FILE
      ) {
        sandbox.files.set(environment.OT_ACTION_SESSION_FILE!, sessionEvent(request));
        sandbox.files.set(environment.OT_ACTION_RESULT_FILE!, runtimeResult(request));
      }
      return { cmdId: `command-${sessionId}` };
    });
    sandbox.process.getSessionCommand.mockResolvedValue({
      cmdId: "command-action",
      exitCode: 0,
    });
    const adapter = adapterFor(sandbox, {
      read: vi.fn().mockReturnValue(candidate.bytes),
    }, {}, {
      materialize_model_credentials: vi.fn().mockResolvedValue({
        CODEX_AUTH_JSON: "sealed-codex-credentials",
      }),
    });
    const integration = adapter.effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;
    const dispatchIntegration = (intent: EffectIntent) => integration.adapter.dispatch({
      intent,
      external_identity: intent.target,
      dispatch_fence: {
        lease_id: `lease-${intent.id}`,
        worker_id: "worker-integration",
      },
      deduplication: {
        strategy: "deterministic_target",
        key: intent.idempotency_key,
        target: intent.target,
      },
    });

    await dispatchIntegration(beforeAction);
    const outcome = await adapter.executeWork(request, {
      lease_generation: 0,
      heartbeat_interval_ms: 10,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn().mockResolvedValue(undefined),
    });
    await dispatchIntegration(afterAction);

    const actionEnvironment = [...sandbox.sessionEnvironments]
      .find(([sessionId]) => sessionId.startsWith("kernel-action-"))?.[1];
    const integrationEnvironments = [...sandbox.sessionEnvironments]
      .filter(([sessionId]) => sessionId.startsWith("kernel-effect-"))
      .map(([, environment]) => environment);
    expect(actionEnvironment).toBeDefined();
    expect(integrationEnvironments).toHaveLength(2);
    expect.soft(Object.keys(actionEnvironment!).filter(
      (name) => name.startsWith("OT_INTEGRATION_"),
    )).toEqual([]);
    expect.soft(Object.keys(integrationEnvironments[1]!).filter((name) => [
      "OT_ACTION_REQUEST_FILE",
      "OT_ACTION_RESULT_FILE",
      "OT_ACTION_SESSION_FILE",
      "OT_LEASE_GENERATION_FENCE_FILE",
      "OT_LEASE_GENERATION_LOCK_FILE",
    ].includes(name))).toEqual([]);
    expect.soft(Object.keys(integrationEnvironments[1]!).filter((name) => [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CODEX_AUTH_JSON",
      "GITHUB_TOKEN",
      "KIMI_CODE_API_KEY",
    ].includes(name))).toEqual([]);
    expect(outcome).toEqual({
      state: "work_failed",
      retryable: true,
      reason: "runtime failed",
    });
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

  it("materializes a later integration checkpoint at its exact immediate parent", async () => {
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
      checkpoint_base_subject: "a".repeat(40),
      context: {
        records: [],
        checkpoints: [{
          input_subject: "b".repeat(40),
          output_subject: "c".repeat(40),
          payload: { blob: pointer },
        }],
      },
    });
    const bundlePath = `/var/lib/openthrottle/action-input/attempt-1/work-lease-1/context-${digest}.bundle`;
    const shallowPath = `/var/lib/openthrottle/action-input/attempt-1/work-lease-1/context-${digest}.shallow`;
    const stop = new Error("stop after checkpoint materialization");
    const sandbox = sandboxWith(async (path) => {
      if (path.endsWith("/session.json") || path.endsWith("/result.json")) {
        throw new Error("404 not found");
      }
      if (path === bundlePath) return bytes;
      if (path.endsWith(".shallow")) throw new Error("404 not found");
      if (path.endsWith("/request.json")) throw stop;
      throw new Error(`unexpected download ${path}`);
    });
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      if (command.includes("lease-generation.lock")) return sandbox.defaultExecuteCommand(command);
      return {
        exitCode: 0,
        result: command.includes("git bundle list-heads")
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
    expect(sandbox.files.get(shallowPath)?.toString("utf8")).toBe(`${"b".repeat(40)}\n`);
    const gitCommands = sandbox.process.executeCommand.mock.calls as unknown as Array<[
      string,
      string?,
      Record<string, string>?,
    ]>;
    expect(gitCommands.filter(
      ([command, , environment]) =>
        String(command).includes("git bundle verify") &&
        String(command).startsWith("env -u GIT_ALTERNATE_OBJECT_DIRECTORIES") &&
        String(command).includes("-u GIT_DIR") &&
        String(command).includes("GIT_CONFIG_COUNT=0") &&
        typeof environment?.GIT_SHALLOW_FILE === "string",
    )).toHaveLength(1);
  });

  it("rejects a replaced source checkout before importing a checkpoint as executor", async () => {
    const bytes = Buffer.from("checkpoint bytes");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const request = workRequest({
      context: {
        records: [],
        checkpoints: [{
          input_subject: "b".repeat(40),
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
      if (command.includes("git bundle list-heads")) {
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
      ([command]) => String(command).includes("git bundle list-heads"),
    )).toBe(false);
  });

  it.each([
    {
      label: "candidate bundle above its individual ceiling",
      candidate_bytes: KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES + 1,
      ancestry_bytes: 1,
      expected: /invalid Daytona integration authority/i,
    },
    {
      label: "ancestry bundle above its individual ceiling",
      candidate_bytes: 1,
      ancestry_bytes: KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES + 1,
      expected: /invalid exact current ancestry entry/i,
    },
    {
      label: "aggregate sealed proof above its total ceiling",
      candidate_bytes: KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES / 2,
      ancestry_bytes: KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES / 2 + 1,
      expected: /aggregate.*bundle.*byte ceiling/i,
    },
  ])("rejects a $label before BlobStore or provider access", async ({
    candidate_bytes,
    ancestry_bytes,
    expected,
  }) => {
    const intent = integrationIntentWithSealedBundleSizes({ candidate_bytes, ancestry_bytes });
    const sandbox = sandboxWith(async () => {
      throw new Error("provider access must not happen for an oversized sealed integration proof");
    });
    const read = vi.fn(() => {
      throw new Error("BlobStore access must not happen for an oversized sealed integration proof");
    });
    const adapter = adapterFor(sandbox, { read });
    const binding = adapter.effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;

    await expect(binding.adapter.reconcile({
      intent,
      external_identity: intent.target,
      dispatch_fence: null,
    })).rejects.toThrow(expected);
    expect(read).not.toHaveBeenCalled();
    expect(sandbox.fs.downloadFile).not.toHaveBeenCalled();
  });

  it("accepts a normal sealed candidate and ancestry bundle budget", async () => {
    const intent = integrationIntentWithSealedBundleSizes({
      candidate_bytes: 1,
      ancestry_bytes: KERNEL_CHECKPOINT_ARTIFACT_MAX_BYTES - 1,
    });
    const read = vi.fn();
    const sandbox = sandboxWith(async () => {
      throw new Error("provider access is not expected without a dispatch fence");
    });
    const adapter = adapterFor(sandbox, { read });
    const binding = adapter.effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;

    await expect(binding.adapter.reconcile({
      intent,
      external_identity: intent.target,
      dispatch_fence: null,
    })).resolves.toEqual({ kind: "not_found" });
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps current ancestry supervisor-only and rejects a forged integration before BlobStore put", async () => {
    const candidate = selfContainedCheckpointBundle("a".repeat(64));
    const proof = integrationProofFromIdentity(candidate);
    const candidatePointer = {
      algorithm: "sha256",
      digest: candidate.descriptor.sha256,
      bytes: candidate.descriptor.bytes,
      encoding: "binary",
      media_type: "application/x-git-bundle",
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
    } as const;
    const effectId = "effect-integration";
    const idempotencyKey = "run-1:integrate:checkpoint-candidate";
    const forgedBytes = Buffer.from("forged integration bundle bytes");
    const forgedCommit = "f".repeat(40);
    const forgedDescriptor = {
      file: "forged.bundle",
      sha256: createHash("sha256").update(forgedBytes).digest("hex"),
      bytes: forgedBytes.byteLength,
      media_type: "application/x-git-bundle",
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      ref: `refs/openthrottle/integrations/${createHash("sha256").update(idempotencyKey).digest("hex")}`,
      commit: forgedCommit,
      tree: "e".repeat(40),
    } as const;
    const intent: EffectIntent = {
      schema: "openthrottle.effect-intent/v1",
      id: effectId,
      pipeline_run_id: "run-1",
      decision_record_id: "decision-integration",
      kind: "daytona/integrate-checkpoint@1",
      idempotency_key: idempotencyKey,
      target: `daytona:${"d".repeat(64)}:integration:checkpoint-candidate`,
      subject: null,
      payload: {
        schema: "openthrottle.daytona-integration/v1",
        identity: "d".repeat(64),
        pipeline_run_id: "run-1",
        attempt_id: "attempt-integration",
        definition_bundle_hash: "b".repeat(64),
        checkpoint_base_subject: candidate.descriptor.commit,
        current_subject: proof.descriptor.commit,
        candidate_checkpoint_id: "checkpoint-candidate",
        candidate_input_subject: candidate.descriptor.commit,
        candidate_output_subject: candidate.descriptor.commit,
        candidate_blob: candidatePointer,
        candidate_artifact: candidate.descriptor,
        current_ancestry: [{
          checkpoint_id: "checkpoint-proof",
          input_subject: candidate.descriptor.commit,
          output_subject: proof.descriptor.commit,
          checkpoint_blob: proof.pointer,
          checkpoint_artifact: proof.descriptor,
        }],
      },
    };
    const resultPath = `/var/lib/openthrottle/integration-results/${effectId}/lease-integration/result.json`;
    const artifactPath = `/var/lib/openthrottle/integration-results/${effectId}/lease-integration/${forgedDescriptor.file}`;
    const sandbox = sandboxWith(async (path) => {
      if (path === resultPath) return Buffer.from(JSON.stringify({
        schema: "openthrottle.kernel-integration-result/v1",
        pipeline_run_id: "run-1",
        effect_id: effectId,
        idempotency_key: idempotencyKey,
        lease_id: "lease-integration",
        worker_id: "worker-integration",
        definition_bundle_hash: "b".repeat(64),
        state: "integrated",
        input_subject: proof.descriptor.commit,
        candidate_checkpoint_id: "checkpoint-candidate",
        output_subject: forgedCommit,
        payload_schema: "openthrottle.git-checkpoint-bundle/v1",
        payload_artifact: forgedDescriptor,
        reason: null,
      }));
      if (path === artifactPath) return forgedBytes;
      throw new Error("404 not found");
    });
    const put = vi.fn();
    const read = vi.fn((value: { digest: string }) =>
      value.digest === candidatePointer.digest ? candidate.bytes : proof.bytes);
    const adapter = adapterFor(sandbox, {
      read,
      put,
    });
    const binding = adapter.effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;
    const dispatchFence = { lease_id: "lease-integration", worker_id: "worker-integration" };

    await binding.adapter.dispatch({
      intent,
      external_identity: intent.target,
      dispatch_fence: dispatchFence,
      deduplication: {
        strategy: "deterministic_target",
        key: intent.idempotency_key,
        target: intent.target,
      },
    });
    const requestPath = `/var/lib/openthrottle/integration-input/${effectId}/lease-integration/request.json`;
    const sandboxRequest = JSON.parse(sandbox.files.get(requestPath)!.toString("utf8"));
    expect(sandboxRequest).not.toHaveProperty("current_ancestry");

    await expect(binding.adapter.reconcile({
      intent,
      external_identity: intent.target,
      dispatch_fence: dispatchFence,
    })).rejects.toThrow(/bundle|integration/i);
    expect(read).toHaveBeenCalledWith(candidatePointer);
    expect(read).toHaveBeenCalledWith(proof.pointer);
    expect(put).not.toHaveBeenCalled();

    await expect(binding.adapter.reconcile({
      intent: {
        ...intent,
        payload: {
          ...(intent.payload as Record<string, unknown>),
          current_ancestry: Array.from({ length: 65 }, () => ({})),
        } as never,
      },
      external_identity: intent.target,
      dispatch_fence: dispatchFence,
    })).rejects.toThrow(/bounded current ancestry/i);

    const proofBytes = Buffer.from("proof bytes are read only after a dispatched result exists");
    const proofPointer = {
      algorithm: "sha256",
      digest: createHash("sha256").update(proofBytes).digest("hex"),
      bytes: proofBytes.byteLength,
      encoding: "binary",
      media_type: "application/x-git-bundle",
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
    } as const;
    const proofInput = "1".repeat(40);
    const proofOutput = "2".repeat(40);
    const exactProof = {
      checkpoint_id: "checkpoint-proof",
      input_subject: proofInput,
      output_subject: proofOutput,
      checkpoint_blob: proofPointer,
      checkpoint_artifact: {
        file: "proof.bundle",
        sha256: proofPointer.digest,
        bytes: proofPointer.bytes,
        media_type: "application/x-git-bundle",
        payload_schema: "openthrottle.git-checkpoint-bundle/v1",
        ref: `refs/openthrottle/integrations/${"9".repeat(64)}`,
        commit: proofOutput,
        tree: "3".repeat(40),
      },
    };
    const proofIntent: EffectIntent = {
      ...intent,
      payload: {
        ...(intent.payload as Record<string, unknown>),
        checkpoint_base_subject: proofInput,
        candidate_input_subject: proofInput,
        current_subject: proofOutput,
        current_ancestry: [exactProof],
      } as never,
    };
    await expect(binding.adapter.reconcile({
      intent: proofIntent,
      external_identity: proofIntent.target,
      dispatch_fence: null,
    })).resolves.toEqual({ kind: "not_found" });
    await expect(binding.adapter.reconcile({
      intent: {
        ...proofIntent,
        payload: {
          ...(proofIntent.payload as Record<string, unknown>),
          current_ancestry: [{ ...exactProof, unexpected: true }],
        } as never,
      },
      external_identity: proofIntent.target,
      dispatch_fence: null,
    })).rejects.toThrow(/exact current ancestry entry/i);
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

  it("classifies an ENOSPC fence write as sandbox-fatal instead of relaunching in place", async () => {
    const request = workRequest();
    const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
    sandbox.fs.setFilePermissions.mockRejectedValueOnce(
      Object.assign(new Error("no space left on device"), { code: "ENOSPC", errno: -28 }),
    );

    await expect(adapterFor(sandbox).executeWork(request, {
      lease_generation: 0,
      heartbeat_interval_ms: 10,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn(),
    })).resolves.toMatchObject({
      state: "work_failed",
      retryable: true,
      sandbox_fatal: true,
      reason: expect.stringMatching(/no space left on device/i),
    });
    expect(sandbox.process.executeSessionCommand).not.toHaveBeenCalled();
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
      const sessionId = createdSessionId(sandbox);
      expect(sandbox.process.getSessionCommand).toHaveBeenCalledWith(
        sessionId,
        "command-1",
      );
      expect(sandbox.process.deleteSession).toHaveBeenCalledWith(sessionId);
      expect(sandbox.process.getSession).toHaveBeenCalledWith(sessionId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates a fresh Daytona process session for correction and reuses it only on recovery", async () => {
    const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
    sandbox.process.getSessionCommand.mockResolvedValue({ cmdId: "command-1", exitCode: 1 });
    const records = [runtimeDelivery("create"), runtimeDelivery("start")];
    const adapter = adapterFor(sandbox, {}, {
      loadAttemptRequestInputs: vi.fn().mockResolvedValue({
        task_prompt: "execute the sealed task",
        context: {
          records: new Map(records.map((record) => [record.id, record])),
          checkpoints: new Map(),
        },
      }),
    }, { task_timeout_seconds: 60 });
    const callbacks = (leaseGeneration: number) => ({
      lease_generation: leaseGeneration,
      heartbeat_interval_ms: 10_000,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn(),
    });

    await adapter.executeWork(workRequest(), callbacks(0));
    await adapter.correctResult(correctionRequest(), callbacks(0));
    await adapter.correctResult(correctionRequest(), callbacks(1));

    const sessionIds = sandbox.process.createSession.mock.calls.map(([sessionId]) => sessionId);
    expect(sessionIds).toHaveLength(3);
    expect(sessionIds[0]).toMatch(/^kernel-action-[a-f0-9]{48}$/);
    expect(sessionIds[1]).not.toBe(sessionIds[0]);
    expect(sessionIds[2]).toBe(sessionIds[1]);
    expect(sandbox.process.executeSessionCommand.mock.calls.map(([sessionId]) => sessionId))
      .toEqual(sessionIds);
    expect(sandbox.process.deleteSession.mock.calls.map(([sessionId]) => sessionId))
      .toEqual(sessionIds);
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
    const sessionId = createdSessionId(sandbox);
    expect(sandbox.process.executeSessionCommand).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        command: expect.stringContaining("flock --nonblock --conflict-exit-code 75 "),
      }),
      expect.any(Number),
    );
    expect(sandbox.process.getSessionCommand).toHaveBeenCalledWith(
      sessionId,
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
    const sessionId = createdSessionId(sandbox);
    expect(sandbox.process.deleteSession).toHaveBeenCalledWith(sessionId);
    expect(sandbox.process.getSession).toHaveBeenCalledWith(sessionId);
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
    expect(sandbox.process.deleteSession).toHaveBeenCalledWith(createdSessionId(sandbox));
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
      const sessionId = createdSessionId(sandbox);
      expect(sandbox.process.deleteSession).toHaveBeenCalledWith(sessionId);
      expect(sandbox.process.getSession).toHaveBeenCalledWith(sessionId);
      expect(sandbox.process.executeSessionCommand).toHaveBeenCalledWith(
        sessionId,
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
