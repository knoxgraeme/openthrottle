import { randomUUID } from "node:crypto";
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
  type ContextPolicy,
  type EvaluatorKind,
  type ExecutorKind,
  type RuntimeCapabilityInventory,
  type StageOutcome,
} from "./pipeline/manifest.js";

export const STAGE_EXECUTOR_PROTOCOL = "stage-executor@1";

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

export interface StageRequestEnvelope {
  protocol: typeof STAGE_EXECUTOR_PROTOCOL;
  pipelineInstanceId: string;
  manifestDigest: string;
  runtimeRelease: string;
  capabilityDigest: string;
  repositoryConfigDigest: string;
  stageId: string;
  attemptId: string;
  requestHash: string;
  idempotencyKey: string;
  runId: string;
  issueId: string;
  sessionId: string;
  generation: number;
  taskType: "implement" | "investigate";
  taskContext: string;
  transitionContext: string;
  repository: string;
  baseCommit: string;
  baseBranch: string;
  branch: string;
  agent: "claude" | "codex" | "opencode";
  contextRevision: number;
  expectedSubject: string | null;
  contextPolicy: ContextPolicy;
  nativeSessionId: string | null;
  capability: string;
  requiredArtifacts: ArtifactKind[];
  credentialScopes: string[];
  liveSteering: boolean;
  commandName?: "test" | "lint" | "build" | "format";
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
  dispatchStage(resource: RuntimeResource, request: StageRequestEnvelope): Promise<{ providerDispatchId: string }>;
  collectStageResult(resource: RuntimeResource, attemptId: string): Promise<StageExecutionResult | null>;
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

function sortedUnique(values: readonly string[]): string[] {
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

export function buildInstalledRuntimeDescriptor(
  release: string,
  overrides: Partial<Pick<RuntimeCapabilityDescriptor,
    "capabilities" | "executors" | "evaluators" | "artifacts" | "contextPolicies" | "credentialScopes" | "adapters">> = {}
): ValidatedRuntimeCapabilityDescriptor {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(release)) {
    throw new Error("runtime release has an invalid format");
  }
  const descriptor = {
    schema: "openthrottle.runtime-capabilities/v1",
    release,
    generatedBy: "sandbox-runtime-build",
    protocol: STAGE_EXECUTOR_PROTOCOL,
    capabilities: sortedUnique(overrides.capabilities ?? [
      "agent/semantic@1",
      "ce/plan@1",
      "ce/implement@1",
      "ce/investigate@1",
      "ce/publish@1",
      "ce/review@1",
      "ce/simplify@1",
      "command/run@1",
      "provider/wait@1",
    ]),
    executors: sortedUnique(overrides.executors ?? EXECUTOR_KINDS) as ExecutorKind[],
    evaluators: sortedUnique(overrides.evaluators ?? EVALUATOR_KINDS) as EvaluatorKind[],
    artifacts: sortedUnique(overrides.artifacts ?? ARTIFACT_KINDS) as ArtifactKind[],
    contextPolicies: sortedUnique(overrides.contextPolicies ?? CONTEXT_POLICIES) as ContextPolicy[],
    credentialScopes: sortedUnique(overrides.credentialScopes ?? [
      "model.invoke",
      "provider.read",
      "repo.read",
      "repo.write",
    ]),
    adapters: Object.fromEntries(Object.entries(overrides.adapters ?? {
      claude: "claude-jsonl@1",
      codex: "codex-jsonl@1",
      opencode: "opencode-jsonl@1",
    }).sort(([left], [right]) => left.localeCompare(right))),
  } satisfies RuntimeCapabilityDescriptor;
  return validateRuntimeCapabilityDescriptor(descriptor, release);
}

export function createStageRequestHash(
  request: Omit<StageRequestEnvelope, "requestHash" | "idempotencyKey">
): Pick<StageRequestEnvelope, "requestHash" | "idempotencyKey"> {
  const requestHash = digestNormalized(canonicalJson(request));
  return {
    requestHash,
    idempotencyKey: `stage:${request.pipelineInstanceId}:${request.stageId}:${request.attemptId}:${requestHash}`,
  };
}

export function newOpaqueResourceId(): string {
  return randomUUID();
}
