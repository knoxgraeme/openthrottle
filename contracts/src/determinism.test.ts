import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_DETERMINISM_FIXTURE,
  canonicalJson,
  digestCanonicalJson,
  type CanonicalDigestFixtureResult,
} from "./index.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function requireBuiltArtifact(file: string): void {
  if (existsSync(file)) return;
  throw new Error(`missing built artifact ${path.relative(repoRoot, file)}; run package builds before this fixture`);
}

function npmPack(packageDir: string, destination: string): string {
  const raw = execFileSync("npm", ["pack", "--json", "--pack-destination", destination], {
    cwd: packageDir,
    encoding: "utf8",
  });
  const [packed] = JSON.parse(raw) as Array<{ filename: string }>;
  if (!packed) throw new Error(`npm pack did not produce an archive for ${packageDir}`);
  return path.join(destination, packed.filename);
}

function packedCliResult(tempDir: string): CanonicalDigestFixtureResult {
  const cliInstall = path.join(tempDir, "packed-cli");
  const nodeModules = path.join(cliInstall, "node_modules");
  const contractsInstall = path.join(nodeModules, "@openthrottle", "contracts");
  mkdirSync(contractsInstall, { recursive: true });
  mkdirSync(cliInstall, { recursive: true });

  const contractsArchive = npmPack(path.join(repoRoot, "contracts"), tempDir);
  const cliArchive = npmPack(path.join(repoRoot, "cli"), tempDir);
  execFileSync("tar", ["-xzf", contractsArchive, "-C", contractsInstall, "--strip-components=1"]);
  execFileSync("tar", ["-xzf", cliArchive, "-C", cliInstall, "--strip-components=1"]);

  const fixturePath = path.join(tempDir, "fixture.json");
  const resultPath = path.join(tempDir, "packed-cli-result.json");
  writeFileSync(fixturePath, JSON.stringify(CANONICAL_DETERMINISM_FIXTURE), "utf8");
  execFileSync("node", [
    "--input-type=module",
    "--eval",
    `
      import { readFileSync, writeFileSync } from "node:fs";
      import { canonicalJson, digestCanonicalJson } from "@openthrottle/contracts";
      const value = JSON.parse(readFileSync(process.argv[1], "utf8"));
      writeFileSync(process.argv[2], JSON.stringify({
        environment: "packed-cli",
        canonicalJson: canonicalJson(value),
        digest: digestCanonicalJson(value),
      }));
    `,
    fixturePath,
    resultPath,
  ], { cwd: cliInstall });
  return JSON.parse(readFileSync(resultPath, "utf8")) as CanonicalDigestFixtureResult;
}

describe("canonical digest determinism fixture", () => {
  it("matches contracts source, packed CLI, and the sealed sandbox runtime artifact", async () => {
    requireBuiltArtifact(path.join(repoRoot, "contracts", "dist", "index.js"));
    requireBuiltArtifact(path.join(repoRoot, "cli", "dist", "index.js"));
    requireBuiltArtifact(path.join(repoRoot, "contracts", "generated", "runtime", "canonical.js"));

    const expected: CanonicalDigestFixtureResult = {
      environment: "contracts-source",
      canonicalJson: canonicalJson(CANONICAL_DETERMINISM_FIXTURE),
      digest: digestCanonicalJson(CANONICAL_DETERMINISM_FIXTURE),
    };

    const tempDir = mkdtempSync(path.join(tmpdir(), "openthrottle-contracts-"));
    try {
      const cli = packedCliResult(tempDir);

      const runtime = await import(
        pathToFileURL(path.join(repoRoot, "contracts", "generated", "runtime", "canonical.js")).href
      ) as {
        canonicalJson(value: unknown): string;
        digestCanonicalJson(value: unknown): string;
      };
      const runtimeResult: CanonicalDigestFixtureResult = {
        environment: "sealed-runtime",
        canonicalJson: runtime.canonicalJson(CANONICAL_DETERMINISM_FIXTURE),
        digest: runtime.digestCanonicalJson(CANONICAL_DETERMINISM_FIXTURE),
      };

      expect(cli).toEqual({ ...expected, environment: "packed-cli" });
      expect(runtimeResult).toEqual({ ...expected, environment: "sealed-runtime" });
      expect(Buffer.from(cli.canonicalJson, "utf8")).toEqual(Buffer.from(expected.canonicalJson, "utf8"));
      expect(Buffer.from(runtimeResult.canonicalJson, "utf8"))
        .toEqual(Buffer.from(expected.canonicalJson, "utf8"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});
