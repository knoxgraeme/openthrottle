import { digestCanonicalJson, digestNormalized } from "./canonical.js";
import {
  SHA256,
  arrayAt,
  fail,
  integerAt,
  normalizedContract,
  objectAt,
  stringAt,
  type ValidatedContract,
} from "./validation.js";
import {
  VIRTUAL_DEFINITION_MAX_FILE_BYTES,
  VIRTUAL_DEFINITION_MAX_FILES,
  VIRTUAL_DEFINITION_MAX_TOTAL_BYTES,
  type VirtualDefinitionFile,
  type VirtualDefinitionFileMap,
} from "./definition-source.js";

export const PLATFORM_DEFINITION_CATALOG_SCHEMA =
  "openthrottle.platform-definition-catalog/v1" as const;
export const PLATFORM_DEFINITION_CATALOG_VERSION = 1 as const;

const SAFE_VIRTUAL_PATH = /^[A-Za-z0-9._/-]+$/;
const CORE_PLATFORM_PATH = /^\.openthrottle\/(?:agents|pipelines|skills|evals)\/core\//;
interface PlatformDefinitionSnapshot {
  catalog: PlatformDefinitionCatalog;
  files: VirtualDefinitionFileMap;
}

const trustedPlatformSource = Symbol("openthrottle.trusted-platform-definition-source");
const trustedPlatformSources = new WeakMap<object, PlatformDefinitionSnapshot>();

export interface PlatformDefinitionCatalogFile {
  path: string;
  byte_size: number;
  sha256: string;
}

export interface PlatformDefinitionCatalog {
  schema: typeof PLATFORM_DEFINITION_CATALOG_SCHEMA;
  version: typeof PLATFORM_DEFINITION_CATALOG_VERSION;
  files: PlatformDefinitionCatalogFile[];
  catalog_digest: string;
}

export interface TrustedPlatformDefinitionSource {
  readonly catalog: PlatformDefinitionCatalog;
  readonly files: VirtualDefinitionFileMap;
  readonly [trustedPlatformSource]: true;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertCorePlatformPath(value: unknown, source: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) {
    fail(source, "must be a safe relative POSIX path containing at most 500 characters");
  }
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    !SAFE_VIRTUAL_PATH.test(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(source, "must be a safe relative POSIX path");
  }
  if (!CORE_PLATFORM_PATH.test(value)) {
    fail(source, "must use the reserved core namespace under .openthrottle");
  }
}

function parseCatalogFile(value: unknown, source: string): PlatformDefinitionCatalogFile {
  const input = objectAt(value, source, ["path", "byte_size", "sha256"]);
  assertCorePlatformPath(input.path, `${source}.path`);
  return {
    path: input.path,
    byte_size: integerAt(
      input.byte_size,
      `${source}.byte_size`,
      0,
      VIRTUAL_DEFINITION_MAX_FILE_BYTES,
    ),
    sha256: stringAt(input.sha256, `${source}.sha256`, { pattern: SHA256 }),
  };
}

export function validatePlatformDefinitionCatalog(
  value: unknown,
  options: { source?: string } = {},
): ValidatedContract<PlatformDefinitionCatalog> {
  const source = options.source ?? "platform_catalog";
  const input = objectAt(value, source, ["schema", "version", "files", "catalog_digest"]);
  if (input.schema !== PLATFORM_DEFINITION_CATALOG_SCHEMA) {
    fail(`${source}.schema`, `must be ${PLATFORM_DEFINITION_CATALOG_SCHEMA}`);
  }
  const version = integerAt(
    input.version,
    `${source}.version`,
    PLATFORM_DEFINITION_CATALOG_VERSION,
    PLATFORM_DEFINITION_CATALOG_VERSION,
  ) as typeof PLATFORM_DEFINITION_CATALOG_VERSION;
  const files = arrayAt(input.files, `${source}.files`, parseCatalogFile, {
    min: 1,
    max: VIRTUAL_DEFINITION_MAX_FILES,
  });
  const casePaths = new Map<string, string>();
  let totalBytes = 0;
  for (const [index, file] of files.entries()) {
    if (index > 0 && compareCodeUnits(files[index - 1]!.path, file.path) >= 0) {
      fail(`${source}.files`, "must be strictly code-unit sorted by path");
    }
    const caseKey = file.path.toLowerCase();
    const existing = casePaths.get(caseKey);
    if (existing !== undefined) {
      if (existing === file.path) fail(`${source}.files`, `contains duplicate path ${file.path}`);
      fail(`${source}.files`, `contains case-colliding paths ${existing} and ${file.path}`);
    }
    casePaths.set(caseKey, file.path);
    totalBytes += file.byte_size;
    if (totalBytes > VIRTUAL_DEFINITION_MAX_TOTAL_BYTES) {
      fail(`${source}.files`, `total bytes exceed ${VIRTUAL_DEFINITION_MAX_TOTAL_BYTES}`);
    }
  }
  const content = {
    schema: PLATFORM_DEFINITION_CATALOG_SCHEMA,
    version,
    files,
  };
  const catalogDigest = stringAt(input.catalog_digest, `${source}.catalog_digest`, {
    pattern: SHA256,
  });
  if (catalogDigest !== digestCanonicalJson(content)) {
    fail(`${source}.catalog_digest`, "does not match the canonical catalog content");
  }
  return normalizedContract({ ...content, catalog_digest: catalogDigest });
}

export function verifyPlatformDefinitionSource(
  catalog: unknown,
  files: VirtualDefinitionFileMap,
  expectedCatalogDigest: string,
): TrustedPlatformDefinitionSource {
  const validated = validatePlatformDefinitionCatalog(catalog);
  const expected = stringAt(expectedCatalogDigest, "expected_catalog_digest", { pattern: SHA256 });
  if (validated.value.catalog_digest !== expected) {
    fail("platform_catalog.catalog_digest", "does not match the pinned release digest");
  }
  if (!files || typeof files.entries !== "function") {
    fail("platform.files", "must be a ReadonlyMap");
  }
  const expectedPaths = new Set(validated.value.files.map(({ path }) => path));
  const provided = new Map<string, VirtualDefinitionFile>();
  const casePaths = new Map<string, string>();
  for (const [path, file] of files.entries()) {
    assertCorePlatformPath(path, "platform.files");
    const caseKey = path.toLowerCase();
    const existing = casePaths.get(caseKey);
    if (existing !== undefined && existing !== path) {
      fail("platform.files", `contains case-colliding paths ${existing} and ${path}`);
    }
    casePaths.set(caseKey, path);
    if (!expectedPaths.has(path)) fail("platform.files", `contains extra file ${path}`);
    provided.set(path, file);
  }

  const trustedFiles = new Map<string, {
    type: "file";
    content: Uint8Array;
  }>();
  for (const catalogFile of validated.value.files) {
    const file = provided.get(catalogFile.path);
    if (file === undefined) {
      fail("platform.files", `missing catalog file ${catalogFile.path}`);
    }
    if (file.type !== "file") {
      fail(catalogFile.path, "must be a regular file; symlinks and non-files are forbidden");
    }
    if (!(file.content instanceof Uint8Array)) {
      fail(catalogFile.path, "platform trust requires raw Uint8Array content");
    }
    if (file.content.byteLength !== catalogFile.byte_size) {
      fail(catalogFile.path, "byte size does not match the platform catalog");
    }
    if (digestNormalized(file.content) !== catalogFile.sha256) {
      fail(catalogFile.path, "sha256 does not match the platform catalog");
    }
    trustedFiles.set(catalogFile.path, {
      type: "file",
      content: new Uint8Array(file.content),
    });
  }
  const catalogSnapshot = (): PlatformDefinitionCatalog => {
    const snapshot = {
      ...validated.value,
      files: validated.value.files.map((file) => Object.freeze({ ...file })),
    };
    Object.freeze(snapshot.files);
    return Object.freeze(snapshot);
  };
  const filesSnapshot = (): VirtualDefinitionFileMap => new Map([...trustedFiles].map(([path, file]) => [
    path,
    { type: "file" as const, content: new Uint8Array(file.content) },
  ]));
  const trusted = Object.freeze({
    catalog: catalogSnapshot(),
    files: filesSnapshot(),
    [trustedPlatformSource]: true as const,
  });
  trustedPlatformSources.set(trusted, {
    catalog: catalogSnapshot(),
    files: filesSnapshot(),
  });
  return trusted;
}

export function reverifyPlatformDefinitionSource(
  source: TrustedPlatformDefinitionSource,
): PlatformDefinitionSnapshot {
  if (!source || typeof source !== "object") {
    fail("platform", "must be a verified platform definition source");
  }
  const snapshot = trustedPlatformSources.get(source);
  if (snapshot === undefined) {
    fail("platform", "must be produced by verifyPlatformDefinitionSource");
  }
  return {
    catalog: {
      ...snapshot.catalog,
      files: snapshot.catalog.files.map((file) => ({ ...file })),
    },
    files: new Map([...snapshot.files].map(([path, file]) => [
      path,
      file.type === "file"
        ? { ...file, content: new Uint8Array(file.content as Uint8Array) }
        : file,
    ])),
  };
}
