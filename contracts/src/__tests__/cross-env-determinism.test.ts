import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, digestNormalized } from "../canonical.js";
import { DIGEST_DETERMINISM_FIXTURE } from "../__fixtures__/determinism.js";

const contractsRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = path.resolve(contractsRoot, "..");

interface DeterminismResult {
  normalized: string;
  digest: string;
}

function runNode(cwd: string, script: string): DeterminismResult {
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd,
    encoding: "utf8",
  })) as DeterminismResult;
}

function packCliResult(tempDir: string, fixture: unknown): DeterminismResult {
  const packDir = path.join(tempDir, "pack");
  const installDir = path.join(tempDir, "packed-cli");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  rmSync(path.join(repoRoot, "contracts", "dist"), { recursive: true, force: true });
  execFileSync("npm", ["pack", "--pack-destination", packDir], {
    cwd: path.join(repoRoot, "cli"),
    stdio: "ignore",
  });
  const tarball = readdirSync(packDir).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("CLI pack did not produce a tarball");
  execFileSync("npm", ["init", "-y"], { cwd: installDir, stdio: "ignore" });
  execFileSync("npm", ["install", path.join(packDir, tarball)], { cwd: installDir, stdio: "ignore" });
  const packageRoot = path.join(installDir, "node_modules", "openthrottle");
  writeFileSync(path.join(packageRoot, "fixture.json"), JSON.stringify(fixture));
  return runNode(packageRoot, `
    import { readFileSync } from "node:fs";
    import { canonicalJson, digestNormalized } from "@openthrottle/contracts";
    const fixture = JSON.parse(readFileSync("fixture.json", "utf8"));
    const normalized = canonicalJson(fixture);
    console.log(JSON.stringify({ normalized, digest: digestNormalized(normalized) }));
  `);
}

function supervisorResult(fixture: unknown): DeterminismResult {
  const fixturePath = path.join(repoRoot, "supervisor", "dist", "__determinism-fixture.json");
  writeFileSync(fixturePath, JSON.stringify(fixture));
  try {
    return runNode(path.join(repoRoot, "supervisor"), `
      import { readFileSync } from "node:fs";
      import { canonicalJson, digestNormalized } from "./dist/pipeline/manifest.js";
      const fixture = JSON.parse(readFileSync("dist/__determinism-fixture.json", "utf8"));
      const normalized = canonicalJson(fixture);
      console.log(JSON.stringify({ normalized, digest: digestNormalized(normalized) }));
    `);
  } finally {
    rmSync(fixturePath, { force: true });
  }
}

describe("canonical digest determinism across packages", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "openthrottle-contracts-"));
    execFileSync("npm", ["run", "build", "--prefix", path.join(repoRoot, "contracts")], { stdio: "ignore" });
    execFileSync("npm", ["run", "build", "--prefix", path.join(repoRoot, "supervisor")], { stdio: "ignore" });
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("emits byte-identical canonical JSON and sha256 in contracts source, packed CLI, and built supervisor", () => {
    const normalized = canonicalJson(DIGEST_DETERMINISM_FIXTURE);
    const source: DeterminismResult = {
      normalized,
      digest: digestNormalized(normalized),
    };
    const packedCli = packCliResult(tempDir, DIGEST_DETERMINISM_FIXTURE);
    const supervisor = supervisorResult(DIGEST_DETERMINISM_FIXTURE);

    expect(packedCli).toEqual(source);
    expect(supervisor).toEqual(source);
  }, 20_000);
});
