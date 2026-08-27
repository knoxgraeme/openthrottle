import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  type DeliveryRecord,
  type EffectIntent,
  type ExecutionRecordPayloadRegistry,
} from "@openthrottle/contracts";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  KernelEffectPort,
  LeasedEffectView,
} from "../../pipeline/kernel/ports.js";
import type { EffectReconciliation } from "../../pipeline/kernel/effect-intent.js";
import {
  KERNEL_EFFECT_DELIVERY_PAYLOAD_CONTRACT,
  KERNEL_EFFECT_DELIVERY_PAYLOAD_SCHEMA,
  createKernelEffectAdapterRegistry,
  createKernelEffectExecutionService,
} from "../../operations/kernel-effects.js";
import { effectIntentContentHash } from "../../pipeline/kernel/effect-intent.js";
import {
  freshKernelFixture,
  seedKernelRun,
} from "../../persistence/__fixtures__/kernel-epoch.js";
import { SqliteKernelStore } from "../../persistence/kernel-store.js";
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

const REPLAYED_EVIDENCE_OBSERVED_AT = "2026-08-20T12:00:00.000Z";

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

function runtimeDelivery(kind: "create" | "start", slotIndex = 0): DeliveryRecord {
  const suffix = slotIndex === 0 ? "" : `-${slotIndex + 1}`;
  const sandboxId = `sandbox-${slotIndex + 1}`;
  return {
    schema: "openthrottle.record/v1",
    id: `delivery-${kind}${suffix}`,
    kind: "delivery",
    pipeline_run_id: "run-1",
    effect_id: `effect-${kind}${suffix}`,
    idempotency_key: `run-1:${kind}${suffix}`,
    external_identity: `daytona:${sandboxId}`,
    status: "confirmed",
    payload_schema: "openthrottle.effect-delivery/v1",
    payload: { inline: {
      effect_kind: `daytona/${kind}-sandbox@1`,
      provider: "daytona",
      observed_via: "reconciliation",
      result: {
        sandbox_id: sandboxId,
        identity: `${slotIndex + 1}`.repeat(64),
      },
    } },
    created_at: "2026-08-20T12:00:00.000Z",
  };
}

function sandboxWith(downloadFile: (path: string) => Promise<Buffer>) {
  const files = new Map<string, Buffer>();
  const daemonEnvironment = new Map<string, string>();
  const sessionEnvironments = new Map<string, Record<string, string>>();
  const integrationRunnerLaunches: string[] = [];
  const defaultExecuteCommand = async (command: string) => {
    const immutableLink = /^ln -- '([^']+)' '([^']+)'$/.exec(command);
    if (immutableLink) {
      const staged = files.get(immutableLink[1]!);
      if (!staged) return { exitCode: 1, result: "" };
      if (files.has(immutableLink[2]!)) return { exitCode: 1, result: "" };
      files.set(immutableLink[2]!, Buffer.from(staged));
      return { exitCode: 0, result: "" };
    }
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
  const defaultExecuteSessionCommand = async (
    _sessionId: string,
    request: { command: string },
  ): Promise<{ cmdId?: string } | undefined> => {
    const stagedLaunch = request.command.match(
      /\/var\/lib\/openthrottle\/integration-results\/[^/'" ]+\/[^/'" ]+\/launch\.sealed/,
    )?.[0];
    if (stagedLaunch) {
      const launch = stagedLaunch.replace(/launch\.sealed$/, "launch.json");
      const stagedBytes = files.get(stagedLaunch);
      if (stagedBytes && !files.has(launch)) {
        files.set(launch, Buffer.from(stagedBytes));
        integrationRunnerLaunches.push(launch);
      }
    }
    return { cmdId: "command-1" };
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
      deleteFile: vi.fn(async (path: string, recursive?: boolean) => {
        if (recursive) {
          let deleted = false;
          for (const candidate of [...files.keys()]) {
            if (candidate === path || candidate.startsWith(`${path}/`)) {
              files.delete(candidate);
              deleted = true;
            }
          }
          if (deleted) return;
        } else if (files.delete(path)) {
          return;
        }
        throw new Error("404 not found");
      }),
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
      executeSessionCommand: vi.fn(defaultExecuteSessionCommand),
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
    integrationRunnerLaunches,
    defaultExecuteCommand,
    defaultExecuteSessionCommand,
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
  daytonaOverrides: object = {},
) {
  return new DaytonaKernelAdapter({
    get: vi.fn().mockResolvedValue(sandbox),
    list: vi.fn(() => (async function* () { yield sandbox; })()),
    ...daytonaOverrides,
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

function publishSteeringFiles(sandbox: ReturnType<typeof sandboxWith>): void {
  sandbox.process.executeCommand.mockImplementation(async (command: string) => {
    const match = /^mv -n -- '([^']+)' '([^']+)'$/.exec(command);
    if (match) {
      const staged = sandbox.files.get(match[1]!);
      if (staged && !sandbox.files.has(match[2]!)) {
        sandbox.files.set(match[2]!, Buffer.from(staged));
      }
      return { exitCode: 0, result: "" };
    }
    return sandbox.defaultExecuteCommand(command);
  });
}

class DurableIntegrationEffectPort implements KernelEffectPort {
  prior_unknown_detail: string | null = null;
  delivery: DeliveryRecord | null = null;
  #reconciliationOrdinal = 0;

  constructor(readonly intent: EffectIntent) {}

  async leaseNextEffect(input: {
    worker_id: string;
    lease_id: string;
    expires_at: string;
  }): Promise<LeasedEffectView | null> {
    if (this.delivery !== null) return null;
    this.#reconciliationOrdinal += 1;
    return {
      intent: this.intent,
      lease_id: input.lease_id,
      expires_at: input.expires_at,
      execution_mode: "reconcile_only",
      reconciliation_ordinal: this.#reconciliationOrdinal,
      prior_unknown_detail: this.prior_unknown_detail,
      dispatch_fence: {
        lease_id: "integration-dispatch-lease",
        worker_id: "integration-dispatch-worker",
      },
    };
  }

  async markLeasedEffectDispatchStarted(): Promise<LeasedEffectView> {
    throw new Error("reconcile-only integration must not dispatch");
  }

  async completeLeasedEffect(input: {
    effect_id: string;
    lease_id: string;
    worker_id: string;
    reconciliation: EffectReconciliation;
  }): Promise<void> {
    if (input.reconciliation.kind === "execute") {
      throw new Error("integration reconciliation must settle or remain unknown");
    }
    if (input.reconciliation.kind === "hold_unknown") {
      this.prior_unknown_detail = input.reconciliation.detail;
      return;
    }
    this.delivery = input.reconciliation.delivery;
    this.prior_unknown_detail = null;
  }
}

function integrationEffectService(
  adapter: DaytonaKernelAdapter,
  port: KernelEffectPort,
  now: () => string = () => "2026-08-20T12:00:00.000Z",
) {
  const binding = adapter.effectBindings().find(
    ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
  );
  if (!binding) throw new Error("missing Daytona integration binding");
  return createKernelEffectExecutionService({
    effects: port,
    adapters: createKernelEffectAdapterRegistry([binding]),
    now,
  });
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

function selfContainedCheckpointBundle(requestHash: string, stableRef = false) {
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
    const ref = `refs/openthrottle/checkpoints/${stableRef
      ? createHash("sha256").update(commit, "utf8").digest("hex")
      : requestHash}`;
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

function siblingIntegrationProof() {
  const root = mkdtempSync(join(tmpdir(), "ot-daytona-sibling-integration-"));
  const repository = join(root, "repository");
  const candidatePath = join(root, "candidate.bundle");
  const currentOnePath = join(root, "current-one.bundle");
  const currentTwoPath = join(root, "current-two.bundle");
  let retained = false;
  try {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", repository]);
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repository });
    writeFileSync(join(repository, "base.txt"), "base\n");
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: repository });
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();

    execFileSync("git", ["switch", "--quiet", "--create", "candidate"], { cwd: repository });
    writeFileSync(join(repository, "candidate-input.txt"), "candidate input\n");
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "--quiet", "-m", "candidate input"], { cwd: repository });
    const candidateInput = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(repository, "candidate-output.txt"), "candidate output\n");
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "--quiet", "-m", "candidate output"], { cwd: repository });
    const candidateOutput = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    const candidateTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();

    execFileSync("git", ["switch", "--quiet", "main"], { cwd: repository });
    writeFileSync(join(repository, "current-one.txt"), "first current integration\n");
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "--quiet", "-m", "first current integration"], {
      cwd: repository,
    });
    const currentOne = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    const currentOneTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(repository, "current-two.txt"), "second current integration\n");
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["commit", "--quiet", "-m", "second current integration"], {
      cwd: repository,
    });
    const currentTwo = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    const currentTwoTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();

    const candidateRef = `refs/openthrottle/checkpoints/${"7".repeat(64)}`;
    const currentOneRef = `refs/openthrottle/integrations/${"8".repeat(64)}`;
    const currentTwoRef = `refs/openthrottle/integrations/${"9".repeat(64)}`;
    execFileSync("git", ["update-ref", candidateRef, candidateOutput], { cwd: repository });
    execFileSync("git", ["update-ref", currentOneRef, currentOne], { cwd: repository });
    execFileSync("git", ["update-ref", currentTwoRef, currentTwo], { cwd: repository });
    writeFileSync(join(repository, ".git", "shallow"), `${base}\n`);
    execFileSync("git", ["bundle", "create", candidatePath, candidateRef], { cwd: repository });
    execFileSync("git", ["bundle", "create", currentOnePath, currentOneRef], { cwd: repository });
    writeFileSync(join(repository, ".git", "shallow"), `${currentOne}\n`);
    execFileSync("git", ["bundle", "create", currentTwoPath, currentTwoRef], { cwd: repository });
    const candidateBytes = readFileSync(candidatePath);
    const currentOneBytes = readFileSync(currentOnePath);
    const currentTwoBytes = readFileSync(currentTwoPath);
    const descriptor = (
      file: string,
      ref: string,
      commit: string,
      tree: string,
      bytes: Buffer,
    ) => ({
      file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      media_type: "application/x-git-bundle",
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      ref,
      commit,
      tree,
    } as const);
    const pointer = (bytes: Buffer) => ({
      algorithm: "sha256",
      digest: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      encoding: "binary",
      media_type: "application/x-git-bundle",
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
    } as const);
    retained = true;
    return {
      root,
      repository,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
      base,
      candidate_input: candidateInput,
      candidate_output: candidateOutput,
      current: currentTwo,
      candidate: {
        bytes: candidateBytes,
        pointer: pointer(candidateBytes),
        descriptor: descriptor(
          "candidate.bundle",
          candidateRef,
          candidateOutput,
          candidateTree,
          candidateBytes,
        ),
      },
      ancestry: [{
        input: base,
        output: currentOne,
        bytes: currentOneBytes,
        pointer: pointer(currentOneBytes),
        descriptor: descriptor(
          "current-one.bundle",
          currentOneRef,
          currentOne,
          currentOneTree,
          currentOneBytes,
        ),
      }, {
        input: currentOne,
        output: currentTwo,
        bytes: currentTwoBytes,
        pointer: pointer(currentTwoBytes),
        descriptor: descriptor(
          "current-two.bundle",
          currentTwoRef,
          currentTwo,
          currentTwoTree,
          currentTwoBytes,
        ),
      }],
    };
  } finally {
    if (!retained) rmSync(root, { recursive: true, force: true });
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

function integrationDispatchRequest(
  intent: EffectIntent,
  dispatchFence = { lease_id: "lease-integration", worker_id: "worker-integration" },
) {
  return {
    intent,
    external_identity: intent.target,
    dispatch_fence: dispatchFence,
    deduplication: {
      strategy: "deterministic_target" as const,
      key: intent.idempotency_key,
      target: intent.target,
    },
  };
}

function siblingIntegrationIntent(
  proof: ReturnType<typeof siblingIntegrationProof>,
  effectId: string,
): EffectIntent {
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
      attempt_id: `attempt-${effectId}`,
      definition_bundle_hash: "b".repeat(64),
      checkpoint_base_subject: proof.base,
      current_subject: proof.current,
      candidate_checkpoint_id: `checkpoint-${effectId}`,
      candidate_input_subject: proof.candidate_input,
      candidate_output_subject: proof.candidate_output,
      candidate_blob: proof.candidate.pointer,
      candidate_artifact: proof.candidate.descriptor,
      current_ancestry: proof.ancestry.map((edge, index) => ({
        checkpoint_id: `checkpoint-prior-integration-${index}`,
        input_subject: edge.input,
        output_subject: edge.output,
        checkpoint_blob: edge.pointer,
        checkpoint_artifact: edge.descriptor,
      })),
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
  evidence = invalidResultEvidenceArtifact(request),
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
      invalid_result_evidence: evidence.descriptor,
    },
  }));
}

function invalidResultEvidenceArtifact(
  request: KernelWorkActionRequest,
  observedAt = REPLAYED_EVIDENCE_OBSERVED_AT,
) {
  const payload = {
    schema: "openthrottle.invalid-result-evidence/v1",
    pipeline_run_id: request.pipeline_run_id,
    attempt_id: request.attempt_id,
    request_hash: request.request_hash,
    definition_bundle_hash: request.definition_bundle_hash,
    phase: request.phase,
    candidate_hash: null,
    rejected_candidate: null,
    diagnostics: [{ path: "/payload", detail: "result needs correction" }],
    runner_stdout_tail: "",
    runner_stderr_tail: "",
    observed_at: observedAt,
  } as const;
  const bytes = Buffer.from(`${canonicalJson(payload)}\n`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    payload,
    bytes,
    descriptor: {
      schema: "openthrottle.evidence-artifact-descriptor/v1",
      file: `evidence-${sha256}.json`,
      sha256,
      bytes: bytes.byteLength,
      media_type: "application/json",
      payload_schema: "openthrottle.invalid-result-evidence/v1",
    },
  } as const;
}

function attemptForensicsArtifact(
  request: KernelWorkActionRequest,
  options: { workRetryOrdinal?: number; observedAt?: string } = {},
) {
  const operationalSignature = "9".repeat(64);
  const payload = {
    schema: "openthrottle.attempt-forensics/v1",
    pipeline_run_id: request.pipeline_run_id,
    attempt_id: request.attempt_id,
    request_hash: request.request_hash,
    definition_bundle_hash: request.definition_bundle_hash,
    lease_id: request.lease_id,
    work_retry_ordinal: options.workRetryOrdinal ?? 0,
    operational_signature: operationalSignature,
    exit_code: 1,
    runner_stdout_tail: "runner output",
    runner_stderr_tail: "runner failure",
    result_path_state: { state: "missing" },
    session_event_state: { state: "present", bytes: 100, sha256: "8".repeat(64) },
    workspace_git_status: { state: "present", summary: " M src/work.ts", detail: "" },
    observed_at: options.observedAt ?? REPLAYED_EVIDENCE_OBSERVED_AT,
  } as const;
  const bytes = Buffer.from(`${canonicalJson(payload)}\n`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    operationalSignature,
    payload,
    bytes,
    descriptor: {
      schema: "openthrottle.evidence-artifact-descriptor/v1",
      file: `evidence-${sha256}.json`,
      sha256,
      bytes: bytes.byteLength,
      media_type: "application/json",
      payload_schema: "openthrottle.attempt-forensics/v1",
    },
  } as const;
}

function attemptForensicsPointer(forensics: ReturnType<typeof attemptForensicsArtifact>) {
  return {
    algorithm: "sha256" as const,
    digest: forensics.descriptor.sha256,
    bytes: forensics.descriptor.bytes,
    encoding: "utf-8" as const,
    media_type: "application/json",
    payload_schema: "openthrottle.attempt-forensics/v1",
  } as const;
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
    work_retry_ordinal: 0,
    heartbeat_interval_ms: 10,
    on_heartbeat: vi.fn().mockResolvedValue(undefined),
  });
  return { execution, put };
}

describe("DaytonaKernelAdapter", () => {
  it("dispatches sibling work requests to their distinct sealed runtime slots", async () => {
    const sandboxes = [
      sandboxWith(async () => { throw new Error("404 not found"); }),
      sandboxWith(async () => { throw new Error("404 not found"); }),
    ];
    for (const sandbox of sandboxes) {
      sandbox.process.getSessionCommand.mockResolvedValue({ cmdId: "command-1", exitCode: 1 });
    }
    const get = vi.fn(async (sandboxId: string) => {
      const sandbox = sandboxes[Number(sandboxId.at(-1)) - 1];
      if (!sandbox) throw new Error(`unknown sandbox ${sandboxId}`);
      return sandbox;
    });
    const adapter = adapterFor(sandboxes[0]!, {}, {}, { task_timeout_seconds: 60 }, { get });
    const callbacks = {
      lease_generation: 0,
      work_retry_ordinal: 0,
      heartbeat_interval_ms: 10_000,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn().mockResolvedValue(undefined),
    };

    for (const itemIndex of [0, 1]) {
      await adapter.executeWork(workRequest({
        attempt_id: `attempt-${itemIndex + 1}`,
        lease_id: `lease-${itemIndex + 1}`,
        scope: {
          kind: "loop_item",
          stage_id: "implement",
          parent_attempt_id: "attempt-plan",
          loop_id: "units",
          item_id: `unit-${itemIndex + 1}`,
          item_index: itemIndex,
        },
        runtime_resource: {
          provider: "daytona",
          provider_resource_id: `sandbox-${itemIndex + 1}`,
          delivery_record_ids: [
            runtimeDelivery("create", itemIndex).id,
            runtimeDelivery("start", itemIndex).id,
          ],
        },
      }), callbacks);
    }

    expect(get.mock.calls.map(([sandboxId]) => sandboxId)).toEqual(["sandbox-1", "sandbox-2"]);
  });

  it("returns sibling result correction to each Attempt's original runtime slot", async () => {
    const sandboxes = [
      sandboxWith(async () => { throw new Error("404 not found"); }),
      sandboxWith(async () => { throw new Error("404 not found"); }),
    ];
    for (const sandbox of sandboxes) {
      sandbox.process.getSessionCommand.mockResolvedValue({ cmdId: "command-1", exitCode: 1 });
    }
    const get = vi.fn(async (sandboxId: string) => {
      const sandbox = sandboxes[Number(sandboxId.at(-1)) - 1];
      if (!sandbox) throw new Error(`unknown sandbox ${sandboxId}`);
      return sandbox;
    });
    const records = [
      runtimeDelivery("create", 0),
      runtimeDelivery("start", 0),
      runtimeDelivery("create", 1),
      runtimeDelivery("start", 1),
    ];
    const adapter = adapterFor(sandboxes[0]!, {}, {
      loadAttemptRequestInputs: vi.fn().mockResolvedValue({
        task_prompt: "execute the sealed task",
        context: {
          records: new Map(records.map((record) => [record.id, record])),
          checkpoints: new Map(),
        },
      }),
    }, { task_timeout_seconds: 60 }, { get });
    const callbacks = {
      lease_generation: 0,
      work_retry_ordinal: 0,
      heartbeat_interval_ms: 10_000,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn(),
    };

    for (const itemIndex of [0, 1]) {
      await adapter.correctResult(correctionRequest({
        attempt_id: `attempt-${itemIndex + 1}`,
        lease_id: `correction-lease-${itemIndex + 1}`,
        scope: {
          kind: "loop_item",
          stage_id: "implement",
          parent_attempt_id: "attempt-plan",
          loop_id: "units",
          item_id: `unit-${itemIndex + 1}`,
          item_index: itemIndex,
        },
      }), callbacks);
    }

    expect(get.mock.calls.map(([sandboxId]) => sandboxId)).toEqual(["sandbox-1", "sandbox-2"]);
  });

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
    const artifact = selfContainedCheckpointBundle(request.request_hash, true);
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
      const invalidEvidence = invalidResultEvidenceArtifact(request);
      const invalidEvidencePath =
        `/var/lib/openthrottle/action-results/attempt-1/work-lease-1/${invalidEvidence.descriptor.file}`;
      const sandbox = sandboxWith(async (path) => {
        if (path === resultPath) return checkpointRuntimeResult(request, checkpoint, kind);
        if (path === sessionPath && kind === "inspect") return sessionEvent(request);
        if (path === artifactPath) return artifact.bytes;
        if (path === invalidEvidencePath) return invalidEvidence.bytes;
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
      const put = vi.fn().mockImplementation((input) => ({
        pointer: input.payload_schema === "openthrottle.invalid-result-evidence/v1"
          ? {
            algorithm: "sha256",
            digest: invalidEvidence.descriptor.sha256,
            bytes: invalidEvidence.descriptor.bytes,
            encoding: "utf-8",
            media_type: "application/json",
            payload_schema: "openthrottle.invalid-result-evidence/v1",
          }
          : pointer,
      }));

      const outcome = await adapterFor(sandbox, { put }).executeWork(request, {
        lease_generation: 0,
        work_retry_ordinal: 0,
        heartbeat_interval_ms: 10,
        on_heartbeat: vi.fn().mockResolvedValue(undefined),
        on_session: vi.fn().mockResolvedValue(undefined),
      });
      expect(outcome).toMatchObject({
        state: kind === "command" ? "work_complete" : "result_pending",
        checkpoint: { input_subject: request.input_subject, output_subject: null },
      });
      if (kind === "inspect") {
        expect(outcome).toMatchObject({
          invalid_result_evidence: { observed_at: REPLAYED_EVIDENCE_OBSERVED_AT },
        });
      }
      expect(put).toHaveBeenCalledTimes(kind === "inspect" ? 2 : 1);
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
      work_retry_ordinal: 0,
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
      work_retry_ordinal: 0,
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
      work_retry_ordinal: 0,
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
      work_retry_ordinal: 0,
      heartbeat_interval_ms: 10,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn(),
    })).resolves.toMatchObject({ state: "work_failed" });
    expect(sandbox.updateEnv).toHaveBeenCalledWith(expect.objectContaining({
      OT_ACTION_WORK_RETRY_ORDINAL: "0",
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
    const dispatchIntegration = async (intent: EffectIntent) => {
      const input = {
        intent,
        external_identity: intent.target,
        dispatch_fence: {
        lease_id: `lease-${intent.id}`,
        worker_id: "worker-integration",
        },
        deduplication: {
          strategy: "deterministic_target" as const,
          key: intent.idempotency_key,
          target: intent.target,
        },
      };
      await integration.adapter.prepareDispatch!(input);
      await integration.adapter.dispatch(input);
    };

    await dispatchIntegration(beforeAction);
    const outcome = await adapter.executeWork(request, {
      lease_generation: 0,
      work_retry_ordinal: 0,
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
      work_retry_ordinal: 0,
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
      work_retry_ordinal: 0,
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
      work_retry_ordinal: 0,
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

  it("publishes PREPARED only after exact integration preparation completes", async () => {
    const candidate = selfContainedCheckpointBundle("1".repeat(64));
    const intent = integrationIntentFor(candidate, "effect-preparation-failure");
    const request = integrationDispatchRequest(intent);
    const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
    sandbox.updateEnv.mockRejectedValueOnce(new Error("environment update interrupted"));
    const binding = adapterFor(sandbox, {
      read: vi.fn().mockReturnValue(candidate.bytes),
    }).effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;
    const preparedPath =
      `/var/lib/openthrottle/integration-input/${intent.id}/lease-integration/prepared.json`;

    await expect(binding.adapter.prepareDispatch!(request))
      .rejects.toThrow("environment update interrupted");
    expect(sandbox.files.has(preparedPath)).toBe(false);
    await expect(binding.adapter.reconcile(request)).resolves.toEqual({ kind: "not_found" });
    expect(sandbox.process.createSession).not.toHaveBeenCalled();
    expect(sandbox.process.executeSessionCommand).not.toHaveBeenCalled();
  });

  it("recovers immutable publication after an interrupted truncated staging upload", async () => {
    const candidate = selfContainedCheckpointBundle("f".repeat(64));
    const intent = integrationIntentFor(candidate, "effect-truncated-immutable-staging");
    const request = integrationDispatchRequest(intent);
    const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
    sandbox.fs.uploadFile.mockImplementationOnce(async (bytes: Buffer, path: string) => {
      sandbox.files.set(path, Buffer.from(bytes.subarray(0, 1)));
      throw new Error("provider upload was interrupted");
    });
    const binding = adapterFor(sandbox, {
      read: vi.fn().mockReturnValue(candidate.bytes),
    }).effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;
    const cachedCandidatePath =
      `/var/lib/openthrottle/integration-artifacts/${candidate.descriptor.sha256}.bundle`;

    await expect(binding.adapter.prepareDispatch!(request))
      .rejects.toThrow("provider upload was interrupted");
    expect(sandbox.files.has(cachedCandidatePath)).toBe(false);

    await expect(binding.adapter.prepareDispatch!(request)).resolves.toBeUndefined();
    expect(sandbox.files.get(cachedCandidatePath)).toEqual(candidate.bytes);
    expect([...sandbox.files.keys()].filter((path) => path.includes(".stage-"))).toEqual([]);
    expect(sandbox.fs.uploadFile.mock.calls.some(([, path]) => path === cachedCandidatePath))
      .toBe(false);
  });

  it("reconciles exact PREPARED without LAUNCH as dispatch-not-started", async () => {
    const candidate = selfContainedCheckpointBundle("2".repeat(64));
    const intent = integrationIntentFor(candidate, "effect-prepared-not-launched");
    const request = integrationDispatchRequest(intent);
    const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
    const binding = adapterFor(sandbox, {
      read: vi.fn().mockReturnValue(candidate.bytes),
    }).effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;

    await binding.adapter.prepareDispatch!(request);

    const preparedPath =
      `/var/lib/openthrottle/integration-input/${intent.id}/lease-integration/prepared.json`;
    const prepared = JSON.parse(sandbox.files.get(preparedPath)!.toString("utf8"));
    expect(prepared).toEqual({
      schema: "openthrottle.daytona-integration-prepared-fence/v1",
      pipeline_run_id: intent.pipeline_run_id,
      effect_id: intent.id,
      idempotency_key: intent.idempotency_key,
      runtime_identity: "d".repeat(64),
      lease_id: "lease-integration",
      worker_id: "worker-integration",
      request_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(binding.adapter.reconcile(request)).resolves.toEqual({
      kind: "dispatch_not_started",
    });
    expect(sandbox.process.createSession).not.toHaveBeenCalled();
    expect(sandbox.process.executeSessionCommand).not.toHaveBeenCalled();
  });

  it("never invokes an integration command twice after publishing exact LAUNCH", async () => {
    const candidate = selfContainedCheckpointBundle("3".repeat(64));
    const intent = integrationIntentFor(candidate, "effect-launch-acknowledgement-loss");
    const request = integrationDispatchRequest(intent);
    const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
    sandbox.process.executeSessionCommand.mockImplementationOnce(async (...args) => {
      await sandbox.defaultExecuteSessionCommand(...args);
      throw new Error("provider acknowledgement was lost");
    });
    const binding = adapterFor(sandbox, {
      read: vi.fn().mockReturnValue(candidate.bytes),
    }).effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;

    await binding.adapter.prepareDispatch!(request);
    await expect(binding.adapter.dispatch(request))
      .rejects.toThrow("provider acknowledgement was lost");

    const launchPath =
      `/var/lib/openthrottle/integration-results/${intent.id}/lease-integration/launch.json`;
    expect(JSON.parse(sandbox.files.get(launchPath)!.toString("utf8"))).toMatchObject({
      schema: "openthrottle.daytona-integration-launch-fence/v1",
      effect_id: intent.id,
      lease_id: "lease-integration",
      worker_id: "worker-integration",
      session_id: `kernel-effect-${intent.id}`,
    });
    await expect(binding.adapter.reconcile(request)).resolves.toEqual({ kind: "not_found" });
    await expect(binding.adapter.dispatch(request)).resolves.toBeUndefined();
    expect(sandbox.process.createSession).toHaveBeenCalledTimes(1);
    expect(sandbox.process.executeSessionCommand).toHaveBeenCalledTimes(1);
    expect(sandbox.integrationRunnerLaunches).toEqual([launchPath]);
  });

  it("recovers when command submission fails before command-side LAUNCH election", async () => {
    const candidate = selfContainedCheckpointBundle("e".repeat(64));
    const intent = integrationIntentFor(candidate, "effect-integration-submit-crash");
    const request = integrationDispatchRequest(intent);
    const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
    sandbox.process.executeSessionCommand.mockRejectedValueOnce(
      new Error("supervisor crashed before command submission"),
    );
    const binding = adapterFor(sandbox, {
      read: vi.fn().mockReturnValue(candidate.bytes),
    }).effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;

    await binding.adapter.prepareDispatch!(request);
    await expect(binding.adapter.dispatch(request))
      .rejects.toThrow("supervisor crashed before command submission");

    const launchPath =
      `/var/lib/openthrottle/integration-results/${intent.id}/lease-integration/launch.json`;
    expect(sandbox.files.has(launchPath)).toBe(false);
    await expect(binding.adapter.reconcile(request)).resolves.toEqual({
      kind: "dispatch_not_started",
    });

    await expect(binding.adapter.dispatch(request)).resolves.toBeUndefined();
    expect(sandbox.files.has(launchPath)).toBe(true);
    expect(sandbox.process.executeSessionCommand).toHaveBeenCalledTimes(2);
    expect(sandbox.integrationRunnerLaunches).toEqual([launchPath]);
  });

  it("atomically grants one integration launch across concurrent exact-fence recovery", async () => {
    const candidate = selfContainedCheckpointBundle("a".repeat(64));
    const intent = integrationIntentFor(candidate, "effect-concurrent-integration-launch");
    const request = integrationDispatchRequest(intent);
    const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
    const binding = adapterFor(sandbox, {
      read: vi.fn().mockReturnValue(candidate.bytes),
    }).effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;

    await binding.adapter.prepareDispatch!(request);
    await expect(Promise.all([
      binding.adapter.dispatch(request),
      binding.adapter.dispatch(request),
    ])).resolves.toEqual([undefined, undefined]);

    expect(sandbox.process.executeSessionCommand).toHaveBeenCalledTimes(2);
    expect(sandbox.integrationRunnerLaunches).toHaveLength(1);
    expect(sandbox.files.has(
      `/var/lib/openthrottle/integration-results/${intent.id}/lease-integration/launch.json`,
    )).toBe(true);
  });

  it("fails closed on conflicting integration preparation and launch fences", async () => {
    const candidate = selfContainedCheckpointBundle("4".repeat(64));
    const intent = integrationIntentFor(candidate, "effect-conflicting-integration-fence");
    const request = integrationDispatchRequest(intent);
    const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
    const binding = adapterFor(sandbox, {
      read: vi.fn().mockReturnValue(candidate.bytes),
    }).effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;
    const preparedPath =
      `/var/lib/openthrottle/integration-input/${intent.id}/lease-integration/prepared.json`;
    const launchPath =
      `/var/lib/openthrottle/integration-results/${intent.id}/lease-integration/launch.json`;

    await binding.adapter.prepareDispatch!(request);
    const exactPrepared = sandbox.files.get(preparedPath)!;
    sandbox.files.set(preparedPath, Buffer.from('{"forged":true}\n'));
    await expect(binding.adapter.reconcile(request)).rejects.toThrow(/prepared fence changed/i);
    await expect(binding.adapter.dispatch(request)).rejects.toThrow(/prepared fence changed/i);

    sandbox.files.set(preparedPath, exactPrepared);
    sandbox.files.set(launchPath, Buffer.from('{"forged":true}\n'));
    await expect(binding.adapter.reconcile(request)).rejects.toThrow(/launch fence changed/i);
    await expect(binding.adapter.dispatch(request)).rejects.toThrow(/launch fence changed/i);
    expect(sandbox.process.executeSessionCommand).not.toHaveBeenCalled();
  });

  it("allows a new proposed fence to replace abandoned preparation before launch", async () => {
    const candidate = selfContainedCheckpointBundle("5".repeat(64));
    const intent = integrationIntentFor(candidate, "effect-reprepared-integration");
    const original = integrationDispatchRequest(intent, {
      lease_id: "proposed-lease-one",
      worker_id: "proposed-worker-one",
    });
    const replacement = integrationDispatchRequest(intent, {
      lease_id: "proposed-lease-two",
      worker_id: "proposed-worker-two",
    });
    const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
    const binding = adapterFor(sandbox, {
      read: vi.fn().mockReturnValue(candidate.bytes),
    }).effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;

    await binding.adapter.prepareDispatch!(original);
    await expect(binding.adapter.dispatch(replacement)).rejects.toThrow(/no exact PREPARED fence/);
    await expect(binding.adapter.reconcile({
      intent,
      external_identity: intent.target,
      dispatch_fence: null,
    })).resolves.toEqual({ kind: "not_found" });
    await binding.adapter.prepareDispatch!(replacement);
    const cachedCandidatePath =
      `/var/lib/openthrottle/integration-artifacts/${candidate.descriptor.sha256}.bundle`;
    expect(sandbox.fs.uploadFile.mock.calls.filter(([, path]) =>
      String(path).startsWith(`${cachedCandidatePath}.stage-`)
    ))
      .toHaveLength(1);
    expect(sandbox.process.executeCommand.mock.calls.filter(([command]) =>
      String(command).startsWith(`ln -- '${cachedCandidatePath}'`)
    )).toHaveLength(2);
    await expect(binding.adapter.reconcile(original)).resolves.toEqual({
      kind: "dispatch_not_started",
    });
    await expect(binding.adapter.reconcile(replacement)).resolves.toEqual({
      kind: "dispatch_not_started",
    });
    await binding.adapter.dispatch(replacement);
    expect(sandbox.process.executeSessionCommand).toHaveBeenCalledTimes(1);
    expect(sandbox.files.has(
      `/var/lib/openthrottle/integration-results/${intent.id}/proposed-lease-one/launch.json`,
    )).toBe(false);
  });

  it("imports source-rooted current ancestry before dispatching a sibling integration", async () => {
    const proof = siblingIntegrationProof();
    const effectId = "effect-sibling-integration";
    const intent = siblingIntegrationIntent(proof, effectId);
    const sourceRepository = join(proof.root, "selected-slot-source");
    onTestFinished(() => {
      if (existsSync(sourceRepository)) chmodSync(sourceRepository, 0o755);
      proof.cleanup();
    });
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", sourceRepository]);
    execFileSync("git", [
      "fetch", "--quiet", "--depth=1", `file://${proof.repository}`, proof.base,
    ], { cwd: sourceRepository });
    execFileSync("git", ["update-ref", "refs/heads/main", "FETCH_HEAD"], {
      cwd: sourceRepository,
    });
    chmodSync(sourceRepository, 0o555);
    expect(() => execFileSync("git", ["cat-file", "-e", `${proof.current}^{commit}`], {
      cwd: sourceRepository,
      stdio: "ignore",
    })).toThrow();
    const sandbox = sandboxWith(async () => {
      throw new Error("404 not found");
    });
    const physicalInputs = new Map<string, string>();
    sandbox.process.executeCommand.mockImplementation(async (
      command: string,
      _cwd?: string,
      environment: Record<string, string> = {},
    ) => {
      if (command.startsWith("ln -- ")) return sandbox.defaultExecuteCommand(command);
      if (command.includes("repository-source") && !command.includes("git bundle")) {
        return { exitCode: 0, result: "" };
      }
      let localCommand = command;
      const localEnvironment = { ...environment };
      for (const [remotePath, bytes] of sandbox.files) {
        const commandUsesPath = command.includes(remotePath) ||
          Object.values(environment).includes(remotePath);
        const isSealedGitInput = remotePath.endsWith(".bundle") ||
          remotePath.endsWith(".shallow");
        if (!commandUsesPath || !isSealedGitInput) continue;
        let physicalPath = physicalInputs.get(remotePath);
        if (!physicalPath) {
          physicalPath = join(proof.root, `sealed-${physicalInputs.size}`);
          writeFileSync(physicalPath, bytes);
          chmodSync(physicalPath, 0o400);
          physicalInputs.set(remotePath, physicalPath);
        }
        localCommand = localCommand.replaceAll(remotePath, physicalPath);
        for (const [name, value] of Object.entries(localEnvironment)) {
          if (value === remotePath) localEnvironment[name] = physicalPath;
        }
      }
      const executed = spawnSync("sh", ["-c", localCommand], {
        cwd: sourceRepository,
        env: { ...process.env, ...localEnvironment },
        encoding: "utf8",
      });
      return {
        exitCode: executed.status ?? 1,
        result: executed.stdout ?? "",
      };
    });
    sandbox.process.executeSessionCommand.mockImplementation(async (sessionId, request) => {
      expect(execFileSync("git", ["rev-parse", `${proof.current}^{commit}`], {
        cwd: sourceRepository,
        encoding: "utf8",
      }).trim()).toBe(proof.current);
      for (const edge of proof.ancestry) {
        expect(sandbox.files.get(
          `/var/lib/openthrottle/integration-artifacts/${edge.pointer.digest}.bundle`,
        )).toEqual(edge.bytes);
      }
      return sandbox.defaultExecuteSessionCommand(sessionId, request);
    });
    const read = vi.fn((pointer: { digest: string }) => {
      if (pointer.digest === proof.candidate.pointer.digest) return proof.candidate.bytes;
      const edge = proof.ancestry.find((candidate) => candidate.pointer.digest === pointer.digest);
      if (edge) return edge.bytes;
      throw new Error(`unexpected BlobStore pointer ${pointer.digest}`);
    });
    const adapter = adapterFor(sandbox, { read });
    const binding = adapter.effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;
    const dispatchFence = { lease_id: "lease-sibling", worker_id: "worker-sibling" };
    const dispatchRequest = integrationDispatchRequest(intent, dispatchFence);

    expect(statSync(sourceRepository).mode & 0o777).toBe(0o555);
    await expect(binding.adapter.prepareDispatch!(dispatchRequest)).resolves.toBeUndefined();
    await expect(binding.adapter.dispatch(dispatchRequest)).resolves.toBeUndefined();

    const requestPath =
      `/var/lib/openthrottle/integration-input/${effectId}/${dispatchFence.lease_id}/request.json`;
    const sandboxRequest = JSON.parse(sandbox.files.get(requestPath)!.toString("utf8"));
    expect(sandboxRequest).not.toHaveProperty("current_ancestry");
    expect(read).toHaveBeenNthCalledWith(1, proof.candidate.pointer);
    for (const [index, edge] of proof.ancestry.entries()) {
      expect(read).toHaveBeenNthCalledWith(index + 2, edge.pointer);
      expect(sandbox.process.executeCommand.mock.calls.some(([command]) =>
        String(command).includes("git bundle verify") &&
        String(command).includes(edge.pointer.digest),
      )).toBe(true);
      expect(sandbox.process.executeCommand.mock.calls.some(([command]) =>
        String(command).includes("git fetch --quiet --no-tags") &&
        String(command).includes(edge.descriptor.ref),
      )).toBe(true);
    }
    expect(sandbox.process.executeCommand.mock.calls.some(([command]) =>
      String(command).includes("env -u GIT_ALTERNATE_OBJECT_DIRECTORIES") &&
      String(command).includes("GIT_CONFIG_GLOBAL=/dev/null") &&
      String(command).includes("GIT_NO_REPLACE_OBJECTS=1") &&
      String(command).includes("git fetch --quiet --no-tags"),
    )).toBe(true);
    expect(sandbox.process.executeCommand.mock.calls.some(([command]) =>
      String(command).includes("git rev-parse") && String(command).includes(proof.current),
    )).toBe(true);

    const uploadsAfterFirstDispatch = sandbox.fs.uploadFile.mock.calls.length;
    const fetchesAfterFirstDispatch = sandbox.process.executeCommand.mock.calls.filter(([command]) =>
      String(command).includes("git fetch --quiet --no-tags")
    ).length;
    const readsAfterFirstDispatch = read.mock.calls.length;
    const shallowSnapshots = [...physicalInputs]
      .filter(([remotePath]) => remotePath.endsWith(".shallow"))
      .map(([, physicalPath]) => ({
        physicalPath,
        bytes: readFileSync(physicalPath),
        mode: statSync(physicalPath).mode & 0o777,
      }));
    expect(shallowSnapshots).toHaveLength(2);
    expect(shallowSnapshots.every(({ mode }) => mode === 0o400)).toBe(true);
    await expect(binding.adapter.prepareDispatch!(dispatchRequest)).resolves.toBeUndefined();
    await expect(binding.adapter.dispatch(dispatchRequest)).resolves.toBeUndefined();
    expect(sandbox.fs.uploadFile).toHaveBeenCalledTimes(uploadsAfterFirstDispatch);
    expect(sandbox.process.executeCommand.mock.calls.filter(([command]) =>
      String(command).includes("git fetch --quiet --no-tags")
    )).toHaveLength(fetchesAfterFirstDispatch);
    expect(read).toHaveBeenCalledTimes(readsAfterFirstDispatch);
    expect(sandbox.process.executeSessionCommand).toHaveBeenCalledTimes(1);
    for (const snapshot of shallowSnapshots) {
      expect(existsSync(snapshot.physicalPath)).toBe(true);
      expect(statSync(snapshot.physicalPath).mode & 0o777).toBe(snapshot.mode);
      expect(readFileSync(snapshot.physicalPath)).toEqual(snapshot.bytes);
    }

    await expect(binding.adapter.reconcile({
      intent: {
        ...intent,
        payload: {
          ...(intent.payload as Record<string, unknown>),
          current_ancestry: [
            {
              ...((intent.payload as { current_ancestry: readonly Record<string, unknown>[] })
                .current_ancestry[0]!),
              input_subject: "f".repeat(40),
            },
            ...((intent.payload as { current_ancestry: readonly Record<string, unknown>[] })
              .current_ancestry.slice(1)),
          ],
        } as never,
      },
      external_identity: intent.target,
      dispatch_fence: null,
    })).rejects.toThrow(/current ancestry/i);
  });

  it("does not launch when an ancestry bundle is missing its exact source input", async () => {
    const proof = siblingIntegrationProof();
    onTestFinished(proof.cleanup);
    const intent = siblingIntegrationIntent(proof, "effect-missing-ancestry-input");
    const request = integrationDispatchRequest(intent);
    const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      if (command.includes("repository-source")) return { exitCode: 0, result: "" };
      if (command.includes("git bundle list-heads")) {
        const edge = proof.ancestry.find(({ pointer }) => command.includes(pointer.digest))!;
        return { exitCode: 0, result: `${edge.output} ${edge.descriptor.ref}\n` };
      }
      if (command.includes("git bundle verify")) return { exitCode: 0, result: "" };
      if (command.includes("git rev-parse")) return { exitCode: 128, result: "" };
      return sandbox.defaultExecuteCommand(command);
    });
    const read = vi.fn((pointer: { digest: string }) => {
      if (pointer.digest === proof.candidate.pointer.digest) return proof.candidate.bytes;
      return proof.ancestry.find((edge) => edge.pointer.digest === pointer.digest)!.bytes;
    });
    const binding = adapterFor(sandbox, { read }).effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;

    await expect(binding.adapter.prepareDispatch!(request))
      .rejects.toThrow(/missing its exact input commit/);
    expect(sandbox.process.executeSessionCommand).not.toHaveBeenCalled();
    expect(sandbox.files.has(
      `/var/lib/openthrottle/integration-input/${intent.id}/lease-integration/prepared.json`,
    )).toBe(false);
  });

  it("does not launch when an ancestry fetch omits its exact output commit", async () => {
    const proof = siblingIntegrationProof();
    onTestFinished(proof.cleanup);
    const intent = siblingIntegrationIntent(proof, "effect-missing-ancestry-output");
    const request = integrationDispatchRequest(intent);
    const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      if (command.includes("repository-source")) return { exitCode: 0, result: "" };
      if (command.includes("git bundle list-heads")) {
        const edge = proof.ancestry.find(({ pointer }) => command.includes(pointer.digest))!;
        return { exitCode: 0, result: `${edge.output} ${edge.descriptor.ref}\n` };
      }
      if (command.includes("git bundle verify") || command.includes("git fetch --quiet --no-tags")) {
        return { exitCode: 0, result: "" };
      }
      if (command.includes("git rev-parse")) {
        return command.includes(proof.base)
          ? { exitCode: 0, result: `${proof.base}\n` }
          : { exitCode: 128, result: "" };
      }
      return sandbox.defaultExecuteCommand(command);
    });
    const read = vi.fn((pointer: { digest: string }) => {
      if (pointer.digest === proof.candidate.pointer.digest) return proof.candidate.bytes;
      return proof.ancestry.find((edge) => edge.pointer.digest === pointer.digest)!.bytes;
    });
    const binding = adapterFor(sandbox, { read }).effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;

    await expect(binding.adapter.prepareDispatch!(request))
      .rejects.toThrow(/did not materialize its exact commit/);
    expect(sandbox.process.executeSessionCommand).not.toHaveBeenCalled();
    expect(sandbox.files.has(
      `/var/lib/openthrottle/integration-input/${intent.id}/lease-integration/prepared.json`,
    )).toBe(false);
  });

  it("resumes partial ancestry preparation without rereading an imported edge", async () => {
    const proof = siblingIntegrationProof();
    onTestFinished(proof.cleanup);
    const intent = siblingIntegrationIntent(proof, "effect-partial-ancestry-recovery");
    const request = integrationDispatchRequest(intent);
    const sourceCommits = new Set([proof.base]);
    let interruptSecondFetch = true;
    const sandbox = sandboxWith(async () => { throw new Error("404 not found"); });
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      if (command.includes("repository-source")) return { exitCode: 0, result: "" };
      if (command.includes("git bundle list-heads")) {
        const edge = proof.ancestry.find(({ pointer }) => command.includes(pointer.digest))!;
        return { exitCode: 0, result: `${edge.output} ${edge.descriptor.ref}\n` };
      }
      if (command.includes("git bundle verify")) return { exitCode: 0, result: "" };
      if (command.includes("git fetch --quiet --no-tags")) {
        const edge = proof.ancestry.find(({ pointer }) => command.includes(pointer.digest))!;
        if (edge === proof.ancestry[1] && interruptSecondFetch) {
          interruptSecondFetch = false;
          return { exitCode: 128, result: "" };
        }
        sourceCommits.add(edge.output);
        return { exitCode: 0, result: "" };
      }
      if (command.includes("git rev-parse")) {
        const subject = [...sourceCommits].find((commit) => command.includes(commit));
        return subject
          ? { exitCode: 0, result: `${subject}\n` }
          : { exitCode: 128, result: "" };
      }
      return sandbox.defaultExecuteCommand(command);
    });
    const read = vi.fn((pointer: { digest: string }) => {
      if (pointer.digest === proof.candidate.pointer.digest) return proof.candidate.bytes;
      return proof.ancestry.find((edge) => edge.pointer.digest === pointer.digest)!.bytes;
    });
    const binding = adapterFor(sandbox, { read }).effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;

    await expect(binding.adapter.prepareDispatch!(request))
      .rejects.toThrow(/could not import integration current ancestry\[1\]/);
    expect(sourceCommits.has(proof.ancestry[0]!.output)).toBe(true);
    expect(sourceCommits.has(proof.current)).toBe(false);
    expect(sandbox.process.executeSessionCommand).not.toHaveBeenCalled();

    await expect(binding.adapter.prepareDispatch!(request)).resolves.toBeUndefined();
    expect(sourceCommits.has(proof.current)).toBe(true);
    expect(read.mock.calls.filter(([pointer]) =>
      pointer.digest === proof.ancestry[0]!.pointer.digest,
    )).toHaveLength(1);
    expect(read.mock.calls.filter(([pointer]) =>
      pointer.digest === proof.ancestry[1]!.pointer.digest,
    )).toHaveLength(2);
    await binding.adapter.dispatch(request);
    expect(sandbox.process.executeSessionCommand).toHaveBeenCalledTimes(1);
  });

  it("starts a stopped integration sandbox and completes reconciliation in the same read", async () => {
    const candidate = selfContainedCheckpointBundle("6".repeat(64));
    const intent = integrationIntentFor(candidate, "effect-stopped-integration");
    const dispatchFence = { lease_id: "lease-stopped", worker_id: "worker-stopped" };
    const resultPath =
      `/var/lib/openthrottle/integration-results/${intent.id}/${dispatchFence.lease_id}/result.json`;
    const sandbox = sandboxWith(async (path) => {
      if (path !== resultPath) throw new Error("404 not found");
      return Buffer.from(JSON.stringify({
        schema: "openthrottle.kernel-integration-result/v1",
        pipeline_run_id: intent.pipeline_run_id,
        effect_id: intent.id,
        idempotency_key: intent.idempotency_key,
        lease_id: dispatchFence.lease_id,
        worker_id: dispatchFence.worker_id,
        definition_bundle_hash: "b".repeat(64),
        state: "needs_human",
        input_subject: candidate.descriptor.commit,
        candidate_checkpoint_id: "checkpoint-candidate",
        output_subject: null,
        payload_schema: null,
        payload_artifact: null,
        reason: "candidate conflicts with the current subject",
      }));
    });
    sandbox.state = "stopped";
    const start = vi.fn(async () => { sandbox.state = "started"; });
    Object.assign(sandbox, { start });
    const adapter = adapterFor(sandbox);
    const binding = adapter.effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;

    await expect(binding.adapter.reconcile({
      intent,
      external_identity: intent.target,
      dispatch_fence: dispatchFence,
    })).resolves.toMatchObject({
      kind: "found",
      status: "rejected",
      payload: { state: "needs_human", reason: "candidate conflicts with the current subject" },
    });
    expect(start).toHaveBeenCalledWith(60);
    expect(sandbox.fs.downloadFile).toHaveBeenCalledWith(resultPath);
  });

  it("holds a stopped integration sandbox with state-naming evidence when recovery start fails", async () => {
    const candidate = selfContainedCheckpointBundle("5".repeat(64));
    const intent = integrationIntentFor(candidate, "effect-stopped-start-failure");
    const sandbox = sandboxWith(async () => { throw new Error("provider read must not run"); });
    sandbox.state = "stopped";
    const startFailure = new Error("[object Object]");
    Object.assign(startFailure, { code: "quota_enforced", retryable: true });
    const start = vi.fn().mockRejectedValue(startFailure);
    Object.assign(sandbox, { start });
    const adapter = adapterFor(sandbox);
    const binding = adapter.effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;

    await expect(binding.adapter.reconcile({
      intent,
      external_identity: intent.target,
      dispatch_fence: { lease_id: "lease-start-failure", worker_id: "worker-start-failure" },
    })).resolves.toEqual({
      kind: "retry",
      detail: "integration runtime sandbox sandbox-1 is stopped; recovery start failed: " +
        '{"code":"quota_enforced","retryable":true}',
      continuation: {
        schema: "openthrottle.daytona-integration-absence-continuation/v1",
        consecutive_absences: 0,
      },
    });
    expect(sandbox.fs.downloadFile).not.toHaveBeenCalled();
  });

  it.each(["stopped", "archived"] as const)(
    "starts a %s sandbox while reconciling its lifecycle start effect",
    async (inactiveState) => {
      const sandbox = sandboxWith(async () => { throw new Error("provider read is not expected"); });
      sandbox.state = inactiveState;
      const start = vi.fn(async () => { sandbox.state = "started"; });
      Object.assign(sandbox, { start });
      const adapter = adapterFor(sandbox);
      const binding = adapter.effectBindings().find(
        ({ effect_kind }) => effect_kind === "daytona/start-sandbox@1",
      )!;
      const intent: EffectIntent = {
        schema: "openthrottle.effect-intent/v1",
        id: "effect-start-stopped",
        pipeline_run_id: "run-1",
        decision_record_id: "decision-start-stopped",
        kind: "daytona/start-sandbox@1",
        idempotency_key: "run-1:start:sandbox-1",
        target: `daytona:${"d".repeat(64)}`,
        subject: null,
        payload: {
          schema: "openthrottle.daytona-start/v1",
          identity: "d".repeat(64),
          pipeline_run_id: "run-1",
          repository: "owner/repository",
          base_branch: "main",
          base_commit: "c".repeat(40),
          snapshot: "snapshot-1",
        },
      };

      await expect(binding.adapter.reconcile({
        intent,
        external_identity: intent.target,
        dispatch_fence: null,
      })).resolves.toEqual({
        kind: "found",
        status: "confirmed",
        payload: { sandbox_id: "sandbox-1", resource_state: "started", identity: "d".repeat(64) },
      });
      expect(start).toHaveBeenCalledWith(60);
    },
  );

  it("classifies two consecutive authoritative integration sandbox absences as sandbox-fatal", async () => {
    const candidate = selfContainedCheckpointBundle("7".repeat(64));
    const intent = integrationIntentFor(candidate, "effect-absent-integration");
    const sandbox = sandboxWith(async () => { throw new Error("provider access is not expected"); });
    const adapter = adapterFor(sandbox, {}, {}, {}, {
      list: vi.fn(() => (async function* () {})()),
    });
    const binding = adapter.effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;
    const dispatchFence = { lease_id: "lease-absent", worker_id: "worker-absent" };

    const first = await binding.adapter.reconcile({
      intent,
      external_identity: intent.target,
      dispatch_fence: dispatchFence,
      continuation: null,
    });
    expect(first).toMatchObject({
      kind: "retry",
      continuation: { consecutive_absences: 1 },
    });
    if (first.kind !== "retry") throw new Error("first absence was not retryable");

    await expect(binding.adapter.reconcile({
      intent,
      external_identity: intent.target,
      dispatch_fence: dispatchFence,
      continuation: first.continuation,
    })).resolves.toMatchObject({
      kind: "found",
      status: "rejected",
      payload: {
        state: "retryable_failure",
        reason: expect.stringMatching(/^sandbox_fatal_absent:/),
      },
    });
  });

  it("settles two consecutive integration absences after expired SQLite lease recovery", async () => {
    const candidate = selfContainedCheckpointBundle("a".repeat(64));
    const intent = integrationIntentFor(candidate, "effect-drained-absent-integration");
    const sandbox = sandboxWith(async () => { throw new Error("provider access is not expected"); });
    const adapter = adapterFor(sandbox, {}, {}, {}, {
      list: vi.fn(() => (async function* () {})()),
    });
    const fixture = freshKernelFixture();
    let currentTime = "2026-08-20T12:00:00.000Z";
    try {
      seedKernelRun({ db: fixture.db, run_id: intent.pipeline_run_id });
      fixture.db.transaction(() => {
        fixture.db.prepare(`
          INSERT INTO records (
            id, pipeline_run_id, sequence, record_hash, kind, payload_schema,
            inline_payload, reducer, input_record_ids_json, input_record_count, created_at
          ) VALUES (?, ?, 1, ?, 'decision', 'test/integration-decision@1', '{}',
            'test/integration-decision@1', '[]', 0, ?)
        `).run(
          intent.decision_record_id,
          intent.pipeline_run_id,
          "e".repeat(64),
          currentTime,
        );
        fixture.db.prepare(`
          INSERT INTO effects (
            id, pipeline_run_id, decision_record_id, kind, idempotency_key, target,
            subject, payload_schema, inline_payload, intent_hash, status, version,
            attempt_count, available_at, dispatch_lease_id, dispatch_worker_id,
            unknown_detail, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', 0, 0, ?, ?, ?, ?, ?, ?)
        `).run(
          intent.id,
          intent.pipeline_run_id,
          intent.decision_record_id,
          intent.kind,
          intent.idempotency_key,
          intent.target,
          intent.subject,
          intent.kind,
          canonicalJson(intent.payload),
          effectIntentContentHash(intent),
          currentTime,
          "integration-dispatch-lease",
          "integration-dispatch-worker",
          "integration runtime sandbox outcome is unresolved",
          currentTime,
          currentTime,
        );
      }).immediate();
      const store = new SqliteKernelStore({
        db: fixture.db,
        blob_store: fixture.blobs,
        manifest_resolver: { resolve: () => { throw new Error("not used"); } },
        payload_schemas: new Map([
          [KERNEL_EFFECT_DELIVERY_PAYLOAD_SCHEMA, KERNEL_EFFECT_DELIVERY_PAYLOAD_CONTRACT],
        ]) as ExecutionRecordPayloadRegistry,
        execution_policy: Object.freeze({ max_concurrent_attempts: 1 }),
        now: () => currentTime,
      });
      const service = integrationEffectService(adapter, store, () => currentTime);

      await expect(service.drainOne({
        worker_id: "effect-worker-1",
        lease_id: "reconcile-lease-1",
        expires_at: "2026-08-20T12:00:01.000Z",
      })).resolves.toMatchObject({
        kind: "held_unknown",
        detail: expect.stringMatching(/confirming authoritative absence/i),
      });
      const firstDetail = fixture.db.prepare(
        "SELECT unknown_detail FROM effects WHERE id = ?",
      ).get(intent.id) as { unknown_detail: string };
      expect(JSON.parse(firstDetail.unknown_detail)).toMatchObject({
        schema: "openthrottle.effect-retry-continuation/v1",
        continuation: { consecutive_absences: 1 },
      });

      currentTime = "2026-08-20T12:00:05.000Z";
      await expect(store.leaseNextEffect({
        worker_id: "interrupted-worker",
        lease_id: "interrupted-reconcile-lease",
        expires_at: "2026-08-20T12:00:06.000Z",
      })).resolves.toMatchObject({
        intent: { id: intent.id },
        execution_mode: "reconcile_only",
        prior_unknown_detail: firstDetail.unknown_detail,
      });

      currentTime = "2026-08-20T12:00:07.000Z";
      await expect(service.drainOne({
        worker_id: "effect-worker-2",
        lease_id: "reconcile-lease-2",
        expires_at: "2026-08-20T12:01:00.000Z",
      })).resolves.toMatchObject({
        kind: "delivered",
        status: "rejected",
        path: "reconciled",
      });
      expect(fixture.db.prepare(`
        SELECT e.status, e.unknown_detail, r.inline_payload
        FROM effects e JOIN records r ON r.id = e.delivery_record_id
        WHERE e.id = ?
      `).get(intent.id)).toMatchObject({
        status: "rejected",
        unknown_detail: null,
        inline_payload: expect.stringContaining("sandbox_fatal_absent:"),
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("resets consecutive absence evidence across a transient Daytona lookup error", async () => {
    const candidate = selfContainedCheckpointBundle("8".repeat(64));
    const intent = integrationIntentFor(candidate, "effect-transient-integration");
    const sandbox = sandboxWith(async () => { throw new Error("provider access is not expected"); });
    const observations: Array<"absent" | "error"> = ["absent", "error", "absent"];
    const list = vi.fn(() => (async function* () {
      const observation = observations.shift();
      if (observation === "error") throw new Error("Daytona API temporarily unavailable");
    })());
    const adapter = adapterFor(sandbox, {}, {}, {}, { list });
    const binding = adapter.effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;
    const dispatchFence = { lease_id: "lease-transient", worker_id: "worker-transient" };

    const first = await binding.adapter.reconcile({
      intent,
      external_identity: intent.target,
      dispatch_fence: dispatchFence,
      continuation: null,
    });
    if (first.kind !== "retry") throw new Error("first absence was not retryable");
    const transient = await binding.adapter.reconcile({
      intent,
      external_identity: intent.target,
      dispatch_fence: dispatchFence,
      continuation: first.continuation,
    });
    expect(transient).toMatchObject({
      kind: "retry",
      detail: expect.stringMatching(/temporarily unavailable/i),
      continuation: { consecutive_absences: 0 },
    });
    if (transient.kind !== "retry") throw new Error("transient lookup was not held");
    await expect(binding.adapter.reconcile({
      intent,
      external_identity: intent.target,
      dispatch_fence: dispatchFence,
      continuation: transient.continuation,
    })).resolves.toMatchObject({
      kind: "retry",
      continuation: { consecutive_absences: 1 },
    });
  });

  it("resets drained integration absence evidence across a transient provider object failure", async () => {
    const candidate = selfContainedCheckpointBundle("b".repeat(64));
    const intent = integrationIntentFor(candidate, "effect-drained-transient-integration");
    const sandbox = sandboxWith(async () => { throw new Error("provider access is not expected"); });
    const observations: Array<"absent" | "error"> = ["absent", "error", "absent", "absent"];
    const list = vi.fn(() => (async function* () {
      if (observations.shift() === "error") {
        throw { code: "temporarily_unavailable", retryable: true };
      }
    })());
    const adapter = adapterFor(sandbox, {}, {}, {}, { list });
    const port = new DurableIntegrationEffectPort(intent);
    const service = integrationEffectService(adapter, port);
    const drain = (ordinal: number) => service.drainOne({
      worker_id: "effect-worker",
      lease_id: `transient-reconcile-lease-${ordinal}`,
      expires_at: "2026-08-20T12:01:00.000Z",
    });

    await expect(drain(1)).resolves.toMatchObject({ kind: "held_unknown" });
    await expect(drain(2)).resolves.toMatchObject({
      kind: "held_unknown",
      detail: '{"code":"temporarily_unavailable","retryable":true}',
    });
    expect(port.prior_unknown_detail).not.toContain("[object Object]");
    expect(JSON.parse(port.prior_unknown_detail!)).toMatchObject({
      continuation: { consecutive_absences: 0 },
    });

    await expect(drain(3)).resolves.toMatchObject({ kind: "held_unknown" });
    expect(port.delivery).toBeNull();
    expect(JSON.parse(port.prior_unknown_detail!)).toMatchObject({
      continuation: { consecutive_absences: 1 },
    });
    await expect(drain(4)).resolves.toMatchObject({
      kind: "delivered",
      status: "rejected",
    });
    expect(port.delivery).toMatchObject({
      payload: { inline: { result: {
        reason: expect.stringMatching(/^sandbox_fatal_absent:/),
      } } },
    });
  });

  it("resets consecutive absence evidence when a found sandbox has a transient read error", async () => {
    const candidate = selfContainedCheckpointBundle("9".repeat(64));
    const intent = integrationIntentFor(candidate, "effect-transient-read-integration");
    const sandbox = sandboxWith(async () => {
      throw new Error("Daytona filesystem temporarily unavailable");
    });
    const observations: Array<"absent" | "found"> = ["absent", "found", "absent"];
    const list = vi.fn(() => (async function* () {
      if (observations.shift() === "found") yield sandbox;
    })());
    const adapter = adapterFor(sandbox, {}, {}, {}, { list });
    const binding = adapter.effectBindings().find(
      ({ effect_kind }) => effect_kind === "daytona/integrate-checkpoint@1",
    )!;
    const dispatchFence = { lease_id: "lease-transient-read", worker_id: "worker-transient-read" };

    const first = await binding.adapter.reconcile({
      intent,
      external_identity: intent.target,
      dispatch_fence: dispatchFence,
      continuation: null,
    });
    if (first.kind !== "retry") throw new Error("first absence was not retryable");
    const transient = await binding.adapter.reconcile({
      intent,
      external_identity: intent.target,
      dispatch_fence: dispatchFence,
      continuation: first.continuation,
    });
    expect(transient).toMatchObject({
      kind: "retry",
      detail: expect.stringMatching(/filesystem temporarily unavailable/i),
      continuation: { consecutive_absences: 0 },
    });
    if (transient.kind !== "retry") throw new Error("transient read was not held");
    await expect(binding.adapter.reconcile({
      intent,
      external_identity: intent.target,
      dispatch_fence: dispatchFence,
      continuation: transient.continuation,
    })).resolves.toMatchObject({
      kind: "retry",
      continuation: { consecutive_absences: 1 },
    });
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
    sandbox.process.executeCommand.mockImplementation(async (command: string) => {
      if (command.includes("repository-source") && !command.includes("git bundle")) {
        return { exitCode: 0, result: "" };
      }
      if (command.includes("git bundle list-heads")) {
        return {
          exitCode: 0,
          result: `${proof.descriptor.commit} ${proof.descriptor.ref}\n`,
        };
      }
      if (command.includes("git rev-parse")) {
        const subject = [candidate.descriptor.commit, proof.descriptor.commit]
          .find((commit) => command.includes(commit));
        return subject
          ? { exitCode: 0, result: `${subject}\n` }
          : { exitCode: 128, result: "" };
      }
      return sandbox.defaultExecuteCommand(command);
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
    const dispatchRequest = {
      intent,
      external_identity: intent.target,
      dispatch_fence: dispatchFence,
      deduplication: {
        strategy: "deterministic_target" as const,
        key: intent.idempotency_key,
        target: intent.target,
      },
    };

    await binding.adapter.prepareDispatch!(dispatchRequest);
    await binding.adapter.dispatch(dispatchRequest);
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
      work_retry_ordinal: 0,
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
          result: {
            sandbox_id: "sandbox-1",
            resource_state: "started",
            identity: "1".repeat(64),
          },
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
      scope: { kind: "stage", stage_id: "stage-1" },
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

  it("returns correction-phase steering for sibling Attempts to their original runtime slots", async () => {
    const sandboxes = [
      sandboxWith(async () => { throw new Error("404 not found"); }),
      sandboxWith(async () => { throw new Error("404 not found"); }),
    ];
    sandboxes.forEach(publishSteeringFiles);
    const get = vi.fn(async (sandboxId: string) => {
      const sandbox = sandboxes[Number(sandboxId.at(-1)) - 1];
      if (!sandbox) throw new Error(`unknown sandbox ${sandboxId}`);
      return sandbox;
    });
    const records = [
      runtimeDelivery("create", 0),
      runtimeDelivery("start", 0),
      runtimeDelivery("create", 1),
      runtimeDelivery("start", 1),
    ];
    const adapter = adapterFor(sandboxes[0]!, {}, {
      loadAttemptRequestInputs: vi.fn().mockResolvedValue({
        task_prompt: "execute the sealed task",
        context: {
          records: new Map(records.map((record) => [record.id, record])),
          checkpoints: new Map(),
        },
      }),
    }, {}, { get });

    for (const itemIndex of [0, 1]) {
      const binding: KernelRuntimeSessionBinding = {
        pipeline_run_id: "run-1",
        attempt_id: `attempt-${itemIndex + 1}`,
        request_hash: "a".repeat(64),
        definition_bundle_hash: "b".repeat(64),
        input_subject: "c".repeat(40),
        native_session_id: `session-${itemIndex + 1}`,
        scope: {
          kind: "loop_item",
          stage_id: "implement",
          parent_attempt_id: "attempt-plan",
          loop_id: "units",
          item_id: `unit-${itemIndex + 1}`,
          item_index: itemIndex,
        },
        generation: 1,
        attempt_status: "result_pending",
        repository_authority: "edit",
        lease_id: `correction-lease-${itemIndex + 1}`,
        lease_generation: 0,
        lease_worker_id: `worker-${itemIndex + 1}`,
        lease_purpose: "result_correction",
        lease_expires_at: "2099-08-20T12:05:00.000Z",
        lease_started: true,
      };
      const envelope = createKernelSteeringEnvelope({
        message_id: `message-${itemIndex + 1}`,
        source: "operator",
        body: "Return only the corrected semantic result.",
        binding,
      });
      await adapter.deliverSteering({
        event_id: `event-${itemIndex + 1}`,
        delivery_id: `steering-delivery-${itemIndex + 1}`,
        envelope,
        authorized: authorizeKernelSteeringDelivery({
          envelope,
          current_binding: binding,
        }),
      });
    }

    expect(get.mock.calls.map(([sandboxId]) => sandboxId)).toEqual(["sandbox-1", "sandbox-2"]);
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
      work_retry_ordinal: 0,
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
      work_retry_ordinal: 0,
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
      work_retry_ordinal: 0,
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

  it("settles promptly and collects generation-zero forensics during generation-one recovery", async () => {
    vi.useFakeTimers();
    try {
      const request = workRequest();
      const forensics = attemptForensicsArtifact(request);
      const resultDirectory = "/var/lib/openthrottle/action-results/attempt-1/work-lease-1";
      let commandObserved = false;
      const sandbox = sandboxWith(async (path) => {
        if (path === `${resultDirectory}/result.json`) return Buffer.from('{"schema":');
        if (commandObserved && path === `${resultDirectory}/forensics.json`) {
          return Buffer.from(`${canonicalJson(forensics.descriptor)}\n`);
        }
        if (commandObserved && path === `${resultDirectory}/${forensics.descriptor.file}`) {
          return forensics.bytes;
        }
        throw new Error("404 not found");
      });
      sandbox.process.getSessionCommand.mockImplementation(async () => {
        commandObserved = true;
        return { cmdId: "command-1", exitCode: 1 };
      });
      const pointer = attemptForensicsPointer(forensics);
      const put = vi.fn().mockReturnValue({ pointer });
      const execution = adapterFor(
        sandbox,
        { put },
        {},
        { task_timeout_seconds: 60 },
      ).executeWork(request, {
        lease_generation: 1,
        work_retry_ordinal: 0,
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
        forensics: {
          blob: pointer,
          operational_signature: forensics.operationalSignature,
          observed_at: REPLAYED_EVIDENCE_OBSERVED_AT,
        },
      });
      expect(forensics.payload).toMatchObject({
        work_retry_ordinal: 0,
        observed_at: REPLAYED_EVIDENCE_OBSERVED_AT,
      });
      expect(forensics.payload).not.toHaveProperty("lease_generation");
      expect(settledPromptly).toBe(true);
      const sessionId = createdSessionId(sandbox);
      expect(sandbox.process.getSessionCommand).toHaveBeenCalledWith(
        sessionId,
        "command-1",
      );
      expect(sandbox.process.deleteSession).toHaveBeenCalledWith(sessionId);
      expect(sandbox.process.getSession).toHaveBeenCalledWith(sessionId);
      expect(put).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts replayed forensics but rejects evidence beyond the supervisor clock bound", async () => {
    const collect = (observedAt: string) => {
      const request = workRequest();
      const forensics = attemptForensicsArtifact(request, { observedAt });
      const resultDirectory = "/var/lib/openthrottle/action-results/attempt-1/work-lease-1";
      let terminated = false;
      const sandbox = sandboxWith(async (path) => {
        if (terminated && path === `${resultDirectory}/forensics.json`) {
          return Buffer.from(`${canonicalJson(forensics.descriptor)}\n`);
        }
        if (terminated && path === `${resultDirectory}/${forensics.descriptor.file}`) {
          return forensics.bytes;
        }
        throw new Error("404 not found");
      });
      sandbox.process.executeSessionCommand.mockResolvedValue(undefined);
      sandbox.process.deleteSession.mockImplementation(async () => { terminated = true; });
      const pointer = attemptForensicsPointer(forensics);
      return adapterFor(sandbox, {
        put: vi.fn().mockReturnValue({ pointer }),
      }).executeWork(request, {
        lease_generation: 0,
        work_retry_ordinal: 0,
        heartbeat_interval_ms: 10,
        on_heartbeat: vi.fn().mockResolvedValue(undefined),
        on_session: vi.fn(),
      });
    };

    await expect(collect(REPLAYED_EVIDENCE_OBSERVED_AT)).resolves.toMatchObject({
      state: "work_failed",
      forensics: { observed_at: REPLAYED_EVIDENCE_OBSERVED_AT },
    });
    const futureObservedAt = new Date(Date.now() + (6 * 60 * 1_000)).toISOString();
    await expect(collect(futureObservedAt)).rejects.toThrow(
      /runtime evidence timestamp exceeds the supervisor clock bound/,
    );
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
      work_retry_ordinal: 0,
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
      work_retry_ordinal: 0,
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
    const forensics = attemptForensicsArtifact(request);
    const resultDirectory = "/var/lib/openthrottle/action-results/attempt-1/work-lease-1";
    let terminated = false;
    const sandbox = sandboxWith(async (path) => {
      if (terminated && path === `${resultDirectory}/forensics.json`) {
        return Buffer.from(`${canonicalJson(forensics.descriptor)}\n`);
      }
      if (terminated && path === `${resultDirectory}/${forensics.descriptor.file}`) {
        return forensics.bytes;
      }
      throw new Error("404 not found");
    });
    sandbox.process.executeSessionCommand.mockResolvedValue(undefined);
    sandbox.process.deleteSession.mockImplementation(async () => { terminated = true; });
    const pointer = attemptForensicsPointer(forensics);

    await expect(adapterFor(sandbox, {
      put: vi.fn().mockReturnValue({ pointer }),
    }).executeWork(request, {
      lease_generation: 0,
      work_retry_ordinal: 0,
      heartbeat_interval_ms: 10,
      on_heartbeat: vi.fn().mockResolvedValue(undefined),
      on_session: vi.fn(),
    })).resolves.toEqual({
      state: "work_failed",
      retryable: true,
      reason: "Daytona action launch omitted its command identity; session termination was verified",
      forensics: {
        blob: pointer,
        operational_signature: forensics.operationalSignature,
        observed_at: REPLAYED_EVIDENCE_OBSERVED_AT,
      },
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
      work_retry_ordinal: 0,
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
      work_retry_ordinal: 0,
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
      const forensics = attemptForensicsArtifact(request);
      const resultDirectory = "/var/lib/openthrottle/action-results/attempt-1/work-lease-1";
      let terminated = false;
      const sandbox = sandboxWith(async (path) => {
        if (terminated && path === `${resultDirectory}/forensics.json`) {
          return Buffer.from(`${canonicalJson(forensics.descriptor)}\n`);
        }
        if (terminated && path === `${resultDirectory}/${forensics.descriptor.file}`) {
          return forensics.bytes;
        }
        throw new Error("404 not found");
      });
      sandbox.process.deleteSession.mockImplementation(async () => { terminated = true; });
      const pointer = attemptForensicsPointer(forensics);
      const adapter = adapterFor(
        sandbox,
        { put: vi.fn().mockReturnValue({ pointer }) },
        {},
        { task_timeout_seconds: 60 },
      );
      const execution = adapter.executeWork(request, {
        lease_generation: 0,
        work_retry_ordinal: 0,
        heartbeat_interval_ms: 10_000,
        on_heartbeat: vi.fn().mockResolvedValue(undefined),
        on_session: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(1_100);

      await expect(execution).resolves.toMatchObject({
        state: "work_failed",
        retryable: true,
        reason: expect.stringMatching(/termination was verified/),
        forensics: {
          blob: pointer,
          operational_signature: forensics.operationalSignature,
          observed_at: REPLAYED_EVIDENCE_OBSERVED_AT,
        },
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
        work_retry_ordinal: 0,
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
