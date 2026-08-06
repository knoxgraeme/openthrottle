import { readFileSync } from "node:fs";
import {
  ARTIFACT_KINDS,
  CONTEXT_POLICIES,
  EVALUATOR_KINDS,
  EXECUTOR_KINDS,
  canonicalJson,
  digestNormalized,
  type ArtifactKind,
  type AssuranceClass,
  type RuntimeCapabilityInventory,
  type StageOutcome,
} from "../pipeline/manifest.js";
import {
  STAGE_EXECUTOR_PROTOCOL,
  type StageRequestEnvelope,
} from "../pipeline/stage-request.js";
import type { RepositorySkillPackage } from "../pipeline/manifest.js";
import { LOGICAL_CREDENTIALS, type LogicalCredential } from "@openthrottle/contracts";

// The closed logical-scope set a loop action may declare (contracts/src/graph.ts
// LOGICAL_CREDENTIALS). Enforced again here at the runtime boundary so a loop
// action request can never carry an unrecognized scope, independent of the
// schema-level check upstream in graph compilation.
export function assertLogicalCredentialScopes(
  scopes: readonly string[]
): asserts scopes is readonly LogicalCredential[] {
  const invalid = scopes.find((scope) => !LOGICAL_CREDENTIALS.includes(scope as LogicalCredential));
  if (invalid) throw new Error(`credential scope ${invalid} is not a recognized logical credential`);
}

export interface RuntimeCapabilityDescriptor extends RuntimeCapabilityInventory {
  schema: "openthrottle.runtime-capabilities/v1";
  release: string;
  generatedBy: "sandbox-runtime-build";
  adapters: Readonly<Record<string, string>>;
}

export interface ValidatedRuntimeCapabilityDescriptor {
  descriptor: RuntimeCapabilityDescriptor;
  normalized: string;
  digest: string;
}

export interface StageExecutionResult {
  attemptId: string;
  requestHash: string;
  outcome: StageOutcome;
  nativeSessionId: string | null;
  subject: string | null;
  artifacts: Array<{
    kind: ArtifactKind;
    schemaVersion: number;
    assurance: AssuranceClass;
    subject: string | null;
    payload: string;
    hash: string;
  }>;
  completedAt: string;
}

export interface RuntimeWorktreeHandle {
  id: string;
}

export interface LoopActionRequest {
  protocol: "loop-action@2";
  actionId: string;
  attemptId: string;
  graphId: string;
  pipelineInstanceId?: string;
  graphDigest?: string;
  parentRunId?: string;
  unitId: string | null;
  generation?: number;
  role: "worker" | "lead" | "reviewer" | "publisher";
  loop: "implement" | "simplify" | "command" | "repair" | "lead" | "review" | "publish";
  agent: "claude" | "codex" | "opencode";
  model?: string;
  skill: string;
  worktree: RuntimeWorktreeHandle | null;
  baseSubject?: string;
  inputSubject?: string;
  candidateSubject?: string | null;
  nativeSessionId: string | null;
  contextPolicy: "fresh" | "resume_required" | "prefer_resume";
  timeoutMs: number;
  transitionContext: string;
  priorEvidence?: {
    schema: "openthrottle.loop-prior-evidence/v1";
    role: "lead" | "final_review" | "final_repair";
    receipts: Array<{
      role: ReceiptEvidenceRole;
      actionAttemptId: string;
      receiptHash: string;
      receipt: string;
    }>;
  };
  downstreamContext?: Array<{
    fromUnitId: string;
    payloadHash: string;
    payload: Record<string, unknown>;
  }>;
  allowedMcpServers: readonly string[];
  credentialScopes: readonly LogicalCredential[];
  receiptSchema: string;
  expectedProducerSkill?: string;
  expectedProducer?: {
    workerId: string;
    skill: string;
    capabilityDigest: string;
    skillPackageDigest: string | null;
    assurance: AssuranceClass;
  };
  repositorySkill?: RepositorySkillPackage;
  requestHash: string;
  idempotencyKey: string;
}

type ReceiptEvidenceRole = "completion" | "candidate" | "command" | "final_command" | "final_review";

export interface LoopActionResult {
  actionId: string;
  attemptId: string;
  requestHash: string;
  outcome: "success" | "failure" | "needs_human" | "retryable_infrastructure_failure";
  nativeSessionId: string | null;
  subject: string | null;
  receipt: string;
  completedAt: string;
}

export interface ChildExecutorActionRequest {
  protocol: "child-executor-action@1";
  actionId: string;
  attemptId: string;
  graphId: string;
  pipelineInstanceId: string;
  graphDigest: string;
  parentRunId: string;
  generation: number;
  capabilityDigest: string;
  unitId: string | null;
  actionKind: "command" | "final_command" | "candidate" | "integrate";
  commandName?: string;
  worktree?: RuntimeWorktreeHandle | null;
  baseSubject: string;
  inputSubject: string;
  candidateSubject?: string;
  requestHash: string;
  idempotencyKey: string;
}

export interface ChildExecutorActionResult {
  actionId: string;
  attemptId: string;
  requestHash: string;
  outcome: "success" | "failure" | "needs_human" | "retryable_infrastructure_failure";
  subject: string | null;
  receipt: string;
  completedAt: string;
}

export interface RuntimeResource {
  providerResourceId: string;
}

export interface SandboxRuntime {
  provision(input: {
    idempotencyKey: string;
    repository: string;
    baseCommit: string;
    runtimeRelease: string;
  }): Promise<RuntimeResource>;
  bootstrap(resource: RuntimeResource, input: {
    sealedRepositoryConfig: string;
    configDigest: string;
    normalizedManifest: string;
    manifestDigest: string;
  }): Promise<void>;
  prepareCompositeWorkspace(resource: RuntimeResource, request: StageRequestEnvelope): Promise<void>;
  dispatchStage(resource: RuntimeResource, request: StageRequestEnvelope): Promise<{ providerDispatchId: string }>;
  collectStageResult(resource: RuntimeResource, attemptId: string): Promise<StageExecutionResult | null>;
  createWorktree(resource: RuntimeResource, input: {
    idempotencyKey: string;
    attemptId: string;
    baseCommit: string;
  }): Promise<RuntimeWorktreeHandle>;
  dispatchLoopAction(resource: RuntimeResource, request: LoopActionRequest): Promise<{ providerDispatchId: string }>;
  collectLoopActionResult(resource: RuntimeResource, input: {
    attemptId: string;
    actionId: string;
    requestHash: string;
  }): Promise<LoopActionResult | null>;
  dispatchChildExecutorAction(resource: RuntimeResource, request: ChildExecutorActionRequest): Promise<{ providerDispatchId: string }>;
  collectChildExecutorActionResult(resource: RuntimeResource, input: {
    attemptId: string;
    actionId: string;
    requestHash: string;
  }): Promise<ChildExecutorActionResult | null>;
  cleanupWorktree(resource: RuntimeResource, handle: RuntimeWorktreeHandle): Promise<void>;
  renewLiveness(resource: RuntimeResource, attemptId: string): Promise<{ observedAt: string }>;
  stop(resource: RuntimeResource, reason: string): Promise<{ confirmed: boolean }>;
  quarantine(resource: RuntimeResource, reason: string): Promise<void>;
  cleanup(resource: RuntimeResource): Promise<void>;
  materializeCredentials(resource: RuntimeResource, scopes: readonly string[]): Promise<void>;
}

export interface SandboxAutostopRuntime {
  setActive(providerResourceId: string): Promise<void>;
  setIdle(providerResourceId: string): Promise<void>;
}

export interface RuntimeFileEntry {
  name?: string;
  path?: string;
  size: number;
  isDir: boolean;
}

export interface RuntimeWorkspace {
  id: string;
  state?: string;
  createdAt?: string;
  labels?: Record<string, string>;
  memory?: number;
  start?(timeoutSeconds?: number): Promise<void>;
  fs: {
    listFiles?(path: string): Promise<RuntimeFileEntry[]>;
    downloadFile?(path: string): Promise<Buffer | undefined>;
    uploadFile?(content: Buffer, path: string): Promise<void>;
    deleteFile?(path: string): Promise<unknown>;
    createFolder?(path: string, mode?: string): Promise<void>;
    setFilePermissions?(path: string, permissions: {
      owner: string;
      group: string;
      mode: string;
    }): Promise<void>;
  };
  process?: {
    executeCommand?(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeoutSeconds?: number
    ): Promise<{ exitCode?: number; result?: string }>;
  };
}

export interface RuntimeWorkspaceAccess {
  getWorkspace(providerResourceId: string): Promise<RuntimeWorkspace>;
}

export interface RuntimeLogs {
  getLogs(providerResourceId: string): Promise<string>;
}

export interface RuntimeStopper {
  stopResource(providerResourceId: string, reason: string): Promise<void>;
}

export type RuntimeInventoryResource = Pick<RuntimeWorkspace, "id" | "state" | "createdAt" | "labels" | "memory">;

export interface RuntimeInventory {
  listLabeledResources(): Promise<RuntimeInventoryResource[]>;
  deleteResource(providerResourceId: string): Promise<void>;
}

export interface RuntimeSnapshotReadiness {
  getSnapshot(name: string): Promise<{ name: string; state: string }>;
}

export interface RuntimeControl
  extends SandboxRuntime,
    SandboxAutostopRuntime,
    RuntimeWorkspaceAccess,
    RuntimeLogs,
    RuntimeStopper,
    RuntimeInventory,
    RuntimeSnapshotReadiness {}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function descriptorArray<T extends string>(
  value: unknown,
  label: string,
  allowed?: readonly T[]
): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64 ||
      value.some((entry) => typeof entry !== "string" || entry.length > 160)) {
    throw new Error(`runtime descriptor ${label} must be a bounded string array`);
  }
  const result = sortedUnique(value as string[]) as T[];
  if (result.length !== value.length) throw new Error(`runtime descriptor ${label} contains duplicates`);
  if (allowed && result.some((entry) => !allowed.includes(entry))) {
    throw new Error(`runtime descriptor ${label} contains an unknown value`);
  }
  return result;
}

export function validateRuntimeCapabilityDescriptor(
  value: unknown,
  expectedRelease?: string
): ValidatedRuntimeCapabilityDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime capability descriptor must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowedKeys = [
    "schema", "release", "generatedBy", "protocol", "capabilities", "executors",
    "evaluators", "artifacts", "contextPolicies", "credentialScopes", "adapters",
  ];
  const unknown = Object.keys(input).find((key) => !allowedKeys.includes(key));
  if (unknown) throw new Error(`runtime capability descriptor has unknown field ${unknown}`);
  if (input.schema !== "openthrottle.runtime-capabilities/v1" || input.generatedBy !== "sandbox-runtime-build") {
    throw new Error("runtime capability descriptor has an invalid schema or producer");
  }
  if (typeof input.release !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(input.release)) {
    throw new Error("runtime release has an invalid format");
  }
  if (expectedRelease && input.release !== expectedRelease) {
    throw new Error(`runtime descriptor release ${input.release} does not match configured ${expectedRelease}`);
  }
  if (input.protocol !== STAGE_EXECUTOR_PROTOCOL) throw new Error(`unsupported runtime protocol ${String(input.protocol)}`);
  const capabilities = descriptorArray<string>(input.capabilities, "capabilities");
  if (capabilities.some((entry) => !/^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*@\d+$/.test(entry))) {
    throw new Error("runtime descriptor contains an invalid capability ID");
  }
  if (!input.adapters || typeof input.adapters !== "object" || Array.isArray(input.adapters)) {
    throw new Error("runtime descriptor adapters must be an object");
  }
  const adapters: Record<string, string> = {};
  for (const [name, adapter] of Object.entries(input.adapters as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name) || typeof adapter !== "string" || adapter.length > 120) {
      throw new Error(`runtime descriptor adapter ${name} is invalid`);
    }
    adapters[name] = adapter;
  }
  const descriptor: RuntimeCapabilityDescriptor = {
    schema: "openthrottle.runtime-capabilities/v1",
    release: input.release,
    generatedBy: "sandbox-runtime-build",
    protocol: STAGE_EXECUTOR_PROTOCOL,
    capabilities,
    executors: descriptorArray(input.executors, "executors", EXECUTOR_KINDS),
    evaluators: descriptorArray(input.evaluators, "evaluators", EVALUATOR_KINDS),
    artifacts: descriptorArray(input.artifacts, "artifacts", ARTIFACT_KINDS),
    contextPolicies: descriptorArray(input.contextPolicies, "contextPolicies", CONTEXT_POLICIES),
    credentialScopes: descriptorArray<string>(input.credentialScopes, "credentialScopes"),
    adapters,
  };
  const normalized = canonicalJson(descriptor);
  return { descriptor, normalized, digest: digestNormalized(normalized) };
}

export function loadRuntimeCapabilityDescriptor(
  path: string,
  expectedRelease: string
): ValidatedRuntimeCapabilityDescriptor {
  const raw = readFileSync(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) throw new Error("runtime capability descriptor exceeds 256 KiB");
  return validateRuntimeCapabilityDescriptor(JSON.parse(raw) as unknown, expectedRelease);
}
