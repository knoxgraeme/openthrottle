import {
  canonicalJson,
  digestCanonicalJson,
  validateDefinitionBundle,
  type DefinitionBundle,
  type TrustedPlatformDefinitionHashes,
} from "@openthrottle/contracts";
import type {
  KernelDefinitionBundleBytesPort,
  KernelDefinitionBundlePort,
} from "../pipeline/kernel/ports.js";

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
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
      source: `pipeline_run:${input.pipeline_run_id}.definition_bundle`,
      trustedPlatformDefinitions: this.#trustedPlatformDefinitions,
    });
    if (
      bundle.digest !== input.definition_bundle_hash ||
      digestCanonicalJson(bundle.value) !== input.definition_bundle_hash ||
      canonicalJson(bundle.value) !== text
    ) {
      throw new Error("pinned DefinitionBundle bytes do not match the pipeline run identity");
    }
    return bundle.value;
  }
}
