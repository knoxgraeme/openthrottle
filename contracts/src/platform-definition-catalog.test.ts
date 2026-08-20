import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  PLATFORM_DEFINITION_CATALOG_SCHEMA,
  PLATFORM_DEFINITION_CATALOG_VERSION,
  digestCanonicalJson,
  digestNormalized,
  validatePlatformDefinitionCatalog,
  verifyPlatformDefinitionSource,
  type PlatformDefinitionCatalog,
  type VirtualDefinitionFile,
} from "./index.js";

function catalogFor(
  files: ReadonlyMap<string, VirtualDefinitionFile>,
  paths = [...files.keys()].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
): PlatformDefinitionCatalog {
  const inventory = paths.map((path) => {
    const file = files.get(path);
    if (!file || file.type !== "file") throw new Error(`${path}: fixture must be a file`);
    const bytes = typeof file.content === "string" ? Buffer.from(file.content) : file.content;
    return {
      path,
      byte_size: bytes.byteLength,
      sha256: digestNormalized(bytes),
    };
  });
  const content = {
    schema: PLATFORM_DEFINITION_CATALOG_SCHEMA,
    version: PLATFORM_DEFINITION_CATALOG_VERSION,
    files: inventory,
  };
  return { ...content, catalog_digest: digestCanonicalJson(content) };
}

function platformFiles(): Map<string, VirtualDefinitionFile> {
  return new Map([
    [
      ".openthrottle/agents/core/reviewer/instructions.md",
      { type: "file", content: Buffer.from("Review exactly.\n") },
    ],
    [
      ".openthrottle/skills/core/review-change/SKILL.md",
      { type: "file", content: Buffer.from([0xff, 0x00, 0x0a]) },
    ],
  ]);
}

describe("platform definition catalog", () => {
  it("validates a canonical catalog and returns a raw-byte trusted source in catalog order", () => {
    const files = platformFiles();
    const catalog = catalogFor(files);

    const validated = validatePlatformDefinitionCatalog(catalog);
    const trusted = verifyPlatformDefinitionSource(
      catalog,
      new Map([...files].reverse()),
      catalog.catalog_digest,
    );

    expect(validated.value).toEqual(catalog);
    expect(validated.value.catalog_digest).toBe(digestCanonicalJson({
      schema: catalog.schema,
      version: catalog.version,
      files: catalog.files,
    }));
    expect([...trusted.files.keys()]).toEqual(catalog.files.map(({ path }) => path));
    const raw = trusted.files.get(".openthrottle/skills/core/review-change/SKILL.md");
    expect(raw?.type).toBe("file");
    if (!raw || raw.type !== "file" || typeof raw.content === "string") {
      throw new Error("expected trusted raw bytes");
    }
    expect([...raw.content]).toEqual([0xff, 0x00, 0x0a]);
    expect(trusted.catalog.catalog_digest).toBe(catalog.catalog_digest);
  });

  it("rejects missing, extra, tampered, and non-byte source files", () => {
    const files = platformFiles();
    const catalog = catalogFor(files);
    const missing = new Map(files);
    missing.delete(catalog.files[0]!.path);
    expect(() => verifyPlatformDefinitionSource(catalog, missing, catalog.catalog_digest))
      .toThrow(/missing catalog file/);

    const extra = new Map(files);
    extra.set(".openthrottle/evals/core/extra/eval.yml", {
      type: "file",
      content: Buffer.from("extra\n"),
    });
    expect(() => verifyPlatformDefinitionSource(catalog, extra, catalog.catalog_digest))
      .toThrow(/extra file/);

    const tampered = new Map(files);
    tampered.set(catalog.files[0]!.path, { type: "file", content: Buffer.from("tampered\n") });
    expect(() => verifyPlatformDefinitionSource(catalog, tampered, catalog.catalog_digest))
      .toThrow(/byte size|sha256/);

    const text = new Map(files);
    const first = catalog.files[0]!;
    text.set(first.path, { type: "file", content: "text is not trusted raw input" });
    expect(() => verifyPlatformDefinitionSource(catalog, text, catalog.catalog_digest))
      .toThrow(/raw Uint8Array/);
  });

  it("rejects stale digests, unsafe paths, non-core paths, ordering drift, and case collisions", () => {
    const files = platformFiles();
    const catalog = catalogFor(files);
    expect(() => validatePlatformDefinitionCatalog({
      ...catalog,
      catalog_digest: "0".repeat(64),
    })).toThrow(/catalog_digest.*does not match/);

    const unsafe = new Map(files);
    unsafe.set(".openthrottle/skills/core/../escape.md", {
      type: "file",
      content: Buffer.from("escape\n"),
    });
    expect(() => validatePlatformDefinitionCatalog(catalogFor(unsafe))).toThrow(/safe relative POSIX path/);

    const nonCore = new Map(files);
    nonCore.set(".openthrottle/skills/custom/SKILL.md", {
      type: "file",
      content: Buffer.from("custom\n"),
    });
    expect(() => validatePlatformDefinitionCatalog(catalogFor(nonCore))).toThrow(/reserved core namespace/);

    expect(() => validatePlatformDefinitionCatalog(catalogFor(
      files,
      [...files.keys()].sort().reverse(),
    ))).toThrow(/code-unit sorted/);

    const collisions = new Map(files);
    collisions.set(".openthrottle/agents/core/Reviewer/instructions.md", {
      type: "file",
      content: Buffer.from("case collision\n"),
    });
    expect(() => validatePlatformDefinitionCatalog(catalogFor(collisions))).toThrow(/case-colliding paths/);
  });

  it("rejects symlinks, non-files, config, and unknown catalog fields", () => {
    const files = platformFiles();
    const catalog = catalogFor(files);
    const first = catalog.files[0]!;

    for (const invalid of [
      { type: "symlink", target: "../../secret" } as const,
      { type: "directory" } as const,
    ]) {
      const changed = new Map(files);
      changed.set(first.path, invalid);
      expect(() => verifyPlatformDefinitionSource(catalog, changed, catalog.catalog_digest))
        .toThrow(/regular file/);
    }

    const config = new Map(files);
    config.set(".openthrottle/config.yml", { type: "file", content: Buffer.from("pipeline: core/x\n") });
    expect(() => validatePlatformDefinitionCatalog(catalogFor(config))).toThrow(/reserved core namespace/);
    expect(() => validatePlatformDefinitionCatalog({ ...catalog, release: "unsealed" }))
      .toThrow(/release: unknown field/);
  });

  it("requires a pinned digest and rejects structural forgery without granting mutable trust", () => {
    const files = platformFiles();
    const catalog = catalogFor(files);
    expect(() => verifyPlatformDefinitionSource(catalog, files, "f".repeat(64)))
      .toThrow(/pinned release digest/);

    const trusted = verifyPlatformDefinitionSource(catalog, files, catalog.catalog_digest);
    const publicFiles = trusted.files as Map<string, VirtualDefinitionFile>;
    publicFiles.clear();
    expect(trusted.files.size).toBe(0);

    expect(() => verifyPlatformDefinitionSource({ ...catalog, catalog_digest: "0".repeat(64) }, files, catalog.catalog_digest))
      .toThrow(/canonical catalog content/);
  });
});
