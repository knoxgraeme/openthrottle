import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RELEASE_COMPILER_ENVIRONMENT_DIGEST,
  RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST,
  digestCanonicalJson,
  verifyCompilerEnvironment,
  verifyPlatformDefinitionSource,
  type VirtualDefinitionFile,
} from "./index.js";

const generatedRoot = fileURLToPath(new URL("../generated/", import.meta.url));
const catalog = JSON.parse(readFileSync(
  `${generatedRoot}platform-definition-catalog.json`,
  "utf8",
)) as {
  schema: string;
  version: number;
  files: Array<{ path: string; byte_size: number; sha256: string }>;
  catalog_digest: string;
};
const environment = JSON.parse(readFileSync(
  `${generatedRoot}compiler-environment.json`,
  "utf8",
)) as { environment_digest: string; [key: string]: unknown };

describe("definition release trust anchors", () => {
  it("pins generated catalog and compiler-environment identities in compiled source", () => {
    expect(catalog.catalog_digest).toBe(RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST);
    expect(environment.environment_digest).toBe(RELEASE_COMPILER_ENVIRONMENT_DIGEST);
    expect(verifyCompilerEnvironment(
      environment,
      RELEASE_COMPILER_ENVIRONMENT_DIGEST,
    ).descriptor.environment_digest).toBe(RELEASE_COMPILER_ENVIRONMENT_DIGEST);
  });

  it("rejects a self-consistent replacement artifact against the release anchors", () => {
    const path = ".openthrottle/agents/core/reviewer/instructions.md";
    const content = Buffer.from("replacement\n");
    const catalogContent = {
      schema: catalog.schema,
      version: catalog.version,
      files: [{
        path,
        byte_size: content.byteLength,
        sha256: "0".repeat(64),
      }],
    };
    const replacementCatalog = {
      ...catalogContent,
      catalog_digest: digestCanonicalJson(catalogContent),
    };
    const replacementFiles = new Map<string, VirtualDefinitionFile>([[path, {
      type: "file",
      content,
    }]]);

    expect(() => verifyPlatformDefinitionSource(
      replacementCatalog,
      replacementFiles,
      RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST,
    )).toThrow(/pinned release digest/);

    const replacementEnvironment = {
      ...environment,
      compiler_version: "definition-compiler/attacker",
    };
    const { environment_digest: _discarded, ...environmentContent } = replacementEnvironment;
    replacementEnvironment.environment_digest = digestCanonicalJson(environmentContent);
    expect(() => verifyCompilerEnvironment(
      replacementEnvironment,
      RELEASE_COMPILER_ENVIRONMENT_DIGEST,
    )).toThrow(/pinned release digest/);
  });
});
