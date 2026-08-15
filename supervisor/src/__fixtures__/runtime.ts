import { canonicalJson, digestNormalized } from "@openthrottle/contracts";
import {
  ARTIFACT_KINDS,
  CONTEXT_POLICIES,
  EVALUATOR_KINDS,
  EXECUTOR_KINDS,
  type ArtifactKind,
  type ContextPolicy,
  type EvaluatorKind,
  type ExecutorKind,
} from "../pipeline/manifest.js";
import { STAGE_EXECUTOR_PROTOCOL } from "../pipeline/stage-request.js";
import {
  loadRuntimeCapabilityDescriptor,
  validateRuntimeCapabilityDescriptor,
  type RuntimeInventory,
  type RuntimeLogs,
  type RuntimeSnapshotReadiness,
  type SandboxAutostopRuntime,
  type SandboxRuntime,
  type RuntimeCapabilityDescriptor,
  type ValidatedRuntimeCapabilityDescriptor,
} from "../runtime/contracts.js";

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
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
      "accept-unit@1",
      "agent-native-contracts@1",
      "agent/repository-skill@1",
      "ce/plan@1",
      "ce/implement@1",
      "ce/investigate@1",
      "ce/publish@1",
      "ce/review@1",
      "ce/simplify@1",
      "command/run@1",
      "core/tune@1",
      "correctness-dataflow@1",
      "data-migration@1",
      "graph/for-each-unit@1",
      "loop-action@3",
      "performance@1",
      "project-standards@1",
      "provider/wait@1",
      "reliability-adversarial@1",
      "security@1",
      "select-review-personas@1",
      "supervisor/citation-gate@1",
      "supervisor/differential-ratchet@1",
      "tests-contracts@1",
      "validate-review-findings@1",
    ]),
    executors: sortedUnique(overrides.executors ?? EXECUTOR_KINDS) as ExecutorKind[],
    evaluators: sortedUnique(overrides.evaluators ?? EVALUATOR_KINDS) as EvaluatorKind[],
    artifacts: sortedUnique(overrides.artifacts ?? ARTIFACT_KINDS) as ArtifactKind[],
    contextPolicies: sortedUnique(overrides.contextPolicies ?? CONTEXT_POLICIES) as ContextPolicy[],
    credentialScopes: sortedUnique(overrides.credentialScopes ?? [
      "mcp",
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

export { canonicalJson, digestNormalized, loadRuntimeCapabilityDescriptor };
export type {
  RuntimeInventory,
  RuntimeLogs,
  RuntimeSnapshotReadiness,
  SandboxAutostopRuntime,
  SandboxRuntime,
};
