import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_COMPILER_ENVIRONMENT_DIGEST,
  RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST,
  verifyCompilerEnvironment,
  verifyPlatformDefinitionSource,
} from "@openthrottle/contracts";
import { describe, expect, it } from "vitest";
import { readLocalDefinitionFiles } from "../definition-files.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliRoot = join(repositoryRoot, "cli");
const packagedPlatformRoot = join(cliRoot, "dist/platform-definitions");
const generatedCatalogPath = join(
  repositoryRoot,
  "contracts/generated/platform-definition-catalog.json",
);
const generatedEnvironmentPath = join(
  repositoryRoot,
  "contracts/generated/compiler-environment.json",
);

function packagedFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? packagedFiles(path) : [relative(packagedPlatformRoot, path)];
  }).sort();
}

describe("CLI package inventory", () => {
  it("packages the release-sealed core corpus byte-for-byte", () => {
    const generatedCatalogBytes = readFileSync(generatedCatalogPath);
    const packagedCatalogBytes = readFileSync(join(packagedPlatformRoot, "catalog.json"));
    expect(packagedCatalogBytes).toEqual(generatedCatalogBytes);
    const catalog = JSON.parse(packagedCatalogBytes.toString("utf8"));

    const sourceFiles = new Map(readLocalDefinitionFiles(repositoryRoot));
    sourceFiles.delete(".openthrottle/config.yml");
    const source = verifyPlatformDefinitionSource(
      catalog,
      sourceFiles,
      RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST,
    );
    const packaged = verifyPlatformDefinitionSource(
      catalog,
      readLocalDefinitionFiles(packagedPlatformRoot),
      RELEASE_PLATFORM_DEFINITION_CATALOG_DIGEST,
    );

    expect([...packaged.files.keys()]).toEqual(catalog.files.map(({ path }: { path: string }) => path));
    expect(packaged.files.size).toBe(46);
    for (const [path, packagedFile] of packaged.files) {
      const sourceFile = source.files.get(path);
      expect(packagedFile.type).toBe("file");
      expect(sourceFile?.type).toBe("file");
      if (packagedFile.type !== "file" || sourceFile?.type !== "file") {
        throw new Error(`${path}: expected regular files`);
      }
      expect(packagedFile.content).toEqual(sourceFile.content);
    }

    const generatedEnvironmentBytes = readFileSync(generatedEnvironmentPath);
    const packagedEnvironmentBytes = readFileSync(join(
      packagedPlatformRoot,
      "compiler-environment.json",
    ));
    expect(packagedEnvironmentBytes).toEqual(generatedEnvironmentBytes);
    const environment = JSON.parse(packagedEnvironmentBytes.toString("utf8"));
    expect(verifyCompilerEnvironment(environment, RELEASE_COMPILER_ENVIRONMENT_DIGEST).descriptor)
      .toEqual(environment);
    expect(packagedFiles(packagedPlatformRoot)).toEqual([
      ...catalog.files.map(({ path }: { path: string }) => path),
      "catalog.json",
      "compiler-environment.json",
    ].sort());
  });

  it("retains operator/planning assets without legacy graph or editable task scaffolds", () => {
    expect(existsSync(join(cliRoot, "dist/skills/operator/openthrottle/SKILL.md"))).toBe(true);
    expect(existsSync(join(cliRoot, "dist/skills/planning/ot-plan/SKILL.md"))).toBe(true);
    expect(existsSync(join(cliRoot, "dist/scaffolds/simple-v1.json"))).toBe(false);
    expect(existsSync(join(cliRoot, "dist/skills/tasks"))).toBe(false);

    const packageJson = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8"));
    expect(packageJson.files).toEqual(["dist"]);
  });
});
