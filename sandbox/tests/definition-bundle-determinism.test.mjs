import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RELEASE_COMPILER_ENVIRONMENT_DIGEST,
  RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST,
  compileDefinitionBundle,
  validatePlatformDefinitionCatalog,
  verifyCompilerEnvironment,
  verifyPlatformDefinitionSource,
} from "../../contracts/dist/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function releaseInputs() {
  const catalog = validatePlatformDefinitionCatalog(JSON.parse(readFileSync(
    join(repositoryRoot, "contracts/generated/platform-definition-catalog.json"),
    "utf8",
  ))).value;
  const files = new Map(catalog.files.map(({ path }) => [
    path,
    { type: "file", content: new Uint8Array(readFileSync(join(repositoryRoot, path))) },
  ]));
  return {
    catalog,
    files,
    platform: verifyPlatformDefinitionSource(
      catalog,
      files,
      RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST,
    ),
    compiler_environment: verifyCompilerEnvironment(
      JSON.parse(readFileSync(
        join(repositoryRoot, "contracts/generated/compiler-environment.json"),
        "utf8",
      )),
      RELEASE_COMPILER_ENVIRONMENT_DIGEST,
    ),
  };
}

describe("definition bundle cross-environment determinism", () => {
  it("matches the contracts, CLI, and supervisor committed golden", () => {
    const golden = JSON.parse(readFileSync(
      join(repositoryRoot, "contracts/fixtures/definition-compiler/committed-golden.json"),
      "utf8",
    ));
    const config = new Uint8Array(readFileSync(join(
      repositoryRoot,
      "contracts/fixtures/definition-compiler/committed-repository/.openthrottle/config.yml",
    )));
    const release = releaseInputs();
    const repositoryFiles = new Map([
      [".openthrottle/config.yml", { type: "file", content: config }],
      // The OpenThrottle repository dogfoods exact checked-in core mirrors.
      // The compiler must omit these repository copies and retain release-
      // verified platform origin without changing canonical output.
      ...[...release.files].map(([path, file]) => [path, file]),
    ]);
    const result = compileDefinitionBundle({
      repository: {
        source_commit: golden.source_commit,
        files: repositoryFiles,
      },
      platform: release.platform,
      compiler_environment: release.compiler_environment,
    });

    expect(result.bundle.value.source_commit).toBe(golden.source_commit);
    expect(result.bundle.digest).toBe(golden.bundle_digest);
    expect(result.manifest.digest).toBe(golden.manifest_digest);
    expect(result.manifest.value.definition_bundle_hash).toBe(result.bundle.digest);
    expect(result.bundle.value.entries.filter((entry) => entry.definition_kind !== "config")
      .every((entry) => entry.origin.kind === "platform")).toBe(true);
  });
});
