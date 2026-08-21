import {
  canonicalJson,
  compileManifestFromDefinitionBundle,
  digestCanonicalJson,
  validateDefinitionBundle,
  type CompiledPipelineManifest,
  type DefinitionBundle,
  type TrustedCompilerEnvironment,
  type TrustedPlatformDefinitionHashes,
} from "@openthrottle/contracts";
import type {
  KernelDefinitionBundleBytesPort,
  KernelDefinitionBundlePort,
} from "../pipeline/kernel/ports.js";
import type { KernelRuntimeCompatibilityPort } from "../runtime/kernel-contracts.js";

const RUNTIME_CAPABILITY_SOURCE_SCHEMA = "openthrottle.runtime-capability-source/v1" as const;
const authenticatedExecutionPolicies = new WeakSet<object>();

export interface KernelExecutionPolicy {
  readonly max_concurrent_attempts: 1;
  readonly runtime_capability_digest: string;
}

export interface KernelRuntimeCapabilitySource {
  readonly schema: typeof RUNTIME_CAPABILITY_SOURCE_SCHEMA;
  readonly protocol: string;
  readonly engines: readonly string[];
  readonly executor_primitives: readonly string[];
  readonly max_concurrent_attempts: number;
}

export interface AuthenticatedKernelRuntimeCapabilities {
  readonly source: KernelRuntimeCapabilitySource;
  readonly execution_policy: KernelExecutionPolicy;
}

function exactObject(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${path} has unknown or missing fields`);
  }
  return input;
}

function capabilityString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || value.includes("\0")) {
    throw new Error(`${path} must be a non-empty bounded string`);
  }
  return value;
}

function capabilityStrings(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    throw new Error(`${path} must be a non-empty bounded string array`);
  }
  const entries = value.map((entry, index) => capabilityString(entry, `${path}[${index}]`));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]! >= entries[index]!) {
      throw new Error(`${path} must be strictly sorted without duplicates`);
    }
  }
  return Object.freeze(entries);
}

function assertAuthenticatedExecutionPolicy(policy: KernelExecutionPolicy): void {
  if (!policy || typeof policy !== "object" || !authenticatedExecutionPolicies.has(policy)) {
    throw new Error("kernel execution policy is not authenticated release policy");
  }
}

/**
 * Authenticates the canonical runtime manifest before extracting any policy.
 * The returned policy is the sole provider-neutral serial-execution value.
 */
export function authenticateKernelRuntimeCapabilities(input: {
  source: unknown;
  compiler_environment: TrustedCompilerEnvironment;
}): AuthenticatedKernelRuntimeCapabilities {
  const compilerEnvironment = input.compiler_environment.descriptor;
  const manifestDigest = digestCanonicalJson(input.source);
  if (
    manifestDigest !== compilerEnvironment.runtime_capability_inputs.runtime_manifest_digest
  ) {
    throw new Error(
      "release runtime manifest digest does not match the trusted compiler environment",
    );
  }
  const source = exactObject(input.source, "runtime_capabilities", [
    "schema", "release", "protocol", "engines", "repository_authorities", "stage_kinds",
    "record_kinds", "result_candidate_schema", "checkpoint_protocol", "executor_primitives",
    "max_concurrent_attempts",
  ]);
  if (source.schema !== RUNTIME_CAPABILITY_SOURCE_SCHEMA) {
    throw new Error(`runtime_capabilities.schema must be ${RUNTIME_CAPABILITY_SOURCE_SCHEMA}`);
  }
  if (
    !Number.isSafeInteger(source.max_concurrent_attempts) ||
    (source.max_concurrent_attempts as number) < 1
  ) {
    throw new Error("runtime_capabilities.max_concurrent_attempts must be a positive integer");
  }
  if (source.max_concurrent_attempts !== 1) {
    throw new Error(
      "runtime_capabilities.max_concurrent_attempts must be the supported release value 1",
    );
  }
  const normalized: KernelRuntimeCapabilitySource = Object.freeze({
    schema: RUNTIME_CAPABILITY_SOURCE_SCHEMA,
    protocol: capabilityString(source.protocol, "runtime_capabilities.protocol"),
    engines: capabilityStrings(source.engines, "runtime_capabilities.engines"),
    executor_primitives: capabilityStrings(
      source.executor_primitives,
      "runtime_capabilities.executor_primitives",
    ),
    max_concurrent_attempts: source.max_concurrent_attempts as number,
  });
  const executionPolicy: KernelExecutionPolicy = Object.freeze({
    max_concurrent_attempts: 1,
    runtime_capability_digest: compilerEnvironment.runtime_capability_digest,
  });
  authenticatedExecutionPolicies.add(executionPolicy);
  return Object.freeze({ source: normalized, execution_policy: executionPolicy });
}

/** Release policy executes before any provider/runtime compatibility checks. */
export class PolicyEnforcedKernelRuntimeCompatibility implements KernelRuntimeCompatibilityPort {
  readonly #executionPolicy: KernelExecutionPolicy;
  readonly #downstream: KernelRuntimeCompatibilityPort;

  constructor(input: {
    execution_policy: KernelExecutionPolicy;
    downstream: KernelRuntimeCompatibilityPort;
  }) {
    assertAuthenticatedExecutionPolicy(input.execution_policy);
    this.#executionPolicy = input.execution_policy;
    this.#downstream = input.downstream;
  }

  async assertCompatible(
    input: Parameters<KernelRuntimeCompatibilityPort["assertCompatible"]>[0],
  ): Promise<void> {
    if (
      input.manifest_runtime_capability_digest !==
      this.#executionPolicy.runtime_capability_digest
    ) {
      throw new Error(
        "compiled pipeline runtime capability digest does not match the release execution policy",
      );
    }
    const pipelines = input.definition_entries.filter(
      (entry) => entry.definition_kind === "pipeline",
    );
    if (pipelines.length !== 1) {
      throw new Error("compiled DefinitionBundle must contain exactly one selected pipeline");
    }
    const pipelineId = pipelines[0]!.definition_id;
    for (const stage of input.stages) {
      if (!stage.loop || stage.loop.max_parallel <= this.#executionPolicy.max_concurrent_attempts) {
        continue;
      }
      throw new Error(
        `pipeline ${pipelineId} loop ${stage.id} (${stage.loop.over}) offered width ` +
        `${stage.loop.max_parallel}; supported limit ${this.#executionPolicy.max_concurrent_attempts}`,
      );
    }
    await this.#downstream.assertCompatible(input);
  }
}

function validatedDefinitionBundleBytes(input: {
  bytes: Uint8Array;
  expected_hash: string;
  source: string;
  trusted_platform_definitions: TrustedPlatformDefinitionHashes;
}): DefinitionBundle {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  } catch {
    throw new Error("pinned DefinitionBundle is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("pinned DefinitionBundle is not valid JSON");
  }
  const bundle = validateDefinitionBundle(parsed, {
    source: input.source,
    trustedPlatformDefinitions: input.trusted_platform_definitions,
  });
  if (
    bundle.digest !== input.expected_hash ||
    digestCanonicalJson(bundle.value) !== input.expected_hash ||
    canonicalJson(bundle.value) !== text
  ) {
    throw new Error("pinned DefinitionBundle bytes do not match the pipeline run identity");
  }
  return bundle.value;
}

/**
 * Turns the persistence-owned blob read into a validated DefinitionBundle.
 * Release platform hashes are injected by the composition root; deriving
 * trust from the bundle's own contents would make the platform fence circular.
 */
export class VerifiedKernelDefinitionBundleResolver implements KernelDefinitionBundlePort {
  readonly #bytes: KernelDefinitionBundleBytesPort;
  readonly #trustedPlatformDefinitions: TrustedPlatformDefinitionHashes;

  constructor(input: {
    bytes: KernelDefinitionBundleBytesPort;
    trusted_platform_definitions: TrustedPlatformDefinitionHashes;
  }) {
    this.#bytes = input.bytes;
    this.#trustedPlatformDefinitions = input.trusted_platform_definitions;
  }

  async resolveExactDefinitionBundle(input: {
    pipeline_run_id: string;
    definition_bundle_hash: string;
  }): Promise<DefinitionBundle> {
    const bytes = await this.#bytes.loadExactDefinitionBundleBytes(input);
    return validatedDefinitionBundleBytes({
      bytes,
      expected_hash: input.definition_bundle_hash,
      source: `pipeline_run:${input.pipeline_run_id}.definition_bundle`,
      trusted_platform_definitions: this.#trustedPlatformDefinitions,
    });
  }
}

/** Cold, deterministic manifest reconstruction for the persistence reducer. */
export class VerifiedKernelManifestResolver {
  readonly #compilerEnvironment: TrustedCompilerEnvironment;
  readonly #trustedPlatformDefinitions: TrustedPlatformDefinitionHashes;

  constructor(input: {
    compiler_environment: TrustedCompilerEnvironment;
    trusted_platform_definitions: TrustedPlatformDefinitionHashes;
  }) {
    this.#compilerEnvironment = input.compiler_environment;
    this.#trustedPlatformDefinitions = input.trusted_platform_definitions;
  }

  resolve(input: {
    pipeline_id: string;
    definition_bundle_hash: string;
    definition_bundle_bytes: Uint8Array;
  }): CompiledPipelineManifest {
    const bundle = validatedDefinitionBundleBytes({
      bytes: input.definition_bundle_bytes,
      expected_hash: input.definition_bundle_hash,
      source: `pipeline:${input.pipeline_id}.definition_bundle`,
      trusted_platform_definitions: this.#trustedPlatformDefinitions,
    });
    if (bundle.pipeline_id !== input.pipeline_id) {
      throw new Error("pinned DefinitionBundle selects another pipeline");
    }
    return compileManifestFromDefinitionBundle({
      bundle,
      compiler_environment: this.#compilerEnvironment,
      trusted_platform_definitions: this.#trustedPlatformDefinitions,
    }).value;
  }
}
