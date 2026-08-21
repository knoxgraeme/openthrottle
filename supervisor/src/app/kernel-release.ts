import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  RELEASE_COMPILER_ENVIRONMENT_DIGEST,
  RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST,
  deriveTrustedPlatformDefinitionHashes,
  verifyCompilerEnvironment,
  verifyPlatformDefinitionSource,
  type CompilerEnvironmentDescriptor,
  type PlatformDefinitionCatalog,
  type TrustedCompilerEnvironment,
  type TrustedPlatformDefinitionHashes,
  type TrustedPlatformDefinitionSource,
  type VirtualDefinitionFile,
} from "@openthrottle/contracts";

export interface KernelReleaseDefinitions {
  platform: TrustedPlatformDefinitionSource;
  compiler_environment: TrustedCompilerEnvironment;
  trusted_platform_definitions: TrustedPlatformDefinitionHashes;
}

function regularFile(path: string, label: string): Buffer {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  return readFileSync(path);
}

function json(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function containedPath(root: string, virtualPath: string): string {
  const candidate = resolve(root, virtualPath);
  const relation = relative(root, candidate);
  if (
    relation === "" || relation.startsWith("..") || isAbsolute(relation)
  ) throw new Error(`release catalog path ${virtualPath} escapes its release root`);
  return candidate;
}

/**
 * Loads the two source-anchored release artifacts and the exact raw files
 * authenticated by them. Normalized definition hashes are derived from those
 * sealed inputs instead of being copied from a stored DefinitionBundle.
 */
export function loadKernelReleaseDefinitions(input: {
  release_root: string;
  generated_root: string;
}): KernelReleaseDefinitions {
  const releaseRoot = realpathSync(input.release_root);
  const generatedRoot = realpathSync(input.generated_root);
  const catalogBytes = regularFile(
    join(generatedRoot, "platform-definition-catalog.json"),
    "platform definition catalog",
  );
  const environmentBytes = regularFile(
    join(generatedRoot, "compiler-environment.json"),
    "compiler environment",
  );
  const catalog = json(catalogBytes, "platform definition catalog") as PlatformDefinitionCatalog;
  const files = new Map<string, VirtualDefinitionFile>();
  for (const entry of catalog.files ?? []) {
    if (!entry || typeof entry.path !== "string") {
      throw new Error("platform definition catalog contains an invalid file entry");
    }
    const path = containedPath(releaseRoot, entry.path);
    files.set(entry.path, { type: "file", content: regularFile(path, entry.path) });
  }
  const platform = verifyPlatformDefinitionSource(
    catalog,
    files,
    RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST,
  );
  const compilerEnvironment = verifyCompilerEnvironment(
    json(environmentBytes, "compiler environment") as CompilerEnvironmentDescriptor,
    RELEASE_COMPILER_ENVIRONMENT_DIGEST,
  );
  return {
    platform,
    compiler_environment: compilerEnvironment,
    trusted_platform_definitions: deriveTrustedPlatformDefinitionHashes({
      platform,
      compiler_environment: compilerEnvironment,
    }),
  };
}
