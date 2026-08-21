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
