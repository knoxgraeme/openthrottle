import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { integrateCandidate } from "./integrate-unit.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository() {
  const directory = mkdtempSync(join(tmpdir(), "ot-integrate-unit-"));
  directories.push(directory);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  writeFileSync(join(directory, "file.txt"), "initial\n");
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: directory });
  return directory;
}

describe("unit integration", () => {
  it("fast-forwards to an executor-owned candidate commit", () => {
    const repoDir = repository();
    const expectedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    writeFileSync(join(repoDir, "file.txt"), "changed\n");
    writeFileSync(join(repoDir, "candidate-executable.sh"), "#!/bin/sh\n");
    chmodSync(join(repoDir, "candidate-executable.sh"), 0o755);
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-am", "candidate"], { cwd: repoDir });
    const candidateCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    execFileSync("git", ["reset", "--hard", expectedHead], { cwd: repoDir });

    const result = integrateCandidate({ repoDir, expectedHead, candidateCommit });

    expect(result).toMatchObject({ integrated: true, reason: "fast_forwarded", integrated_head: candidateCommit });
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim()).toBe(candidateCommit);
    expect(statSync(join(repoDir, "candidate-executable.sh")).mode & 0o111).not.toBe(0);
  });

  it("recognizes exact-tree replay without integrating twice", () => {
    const repoDir = repository();
    const expectedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    const candidateCommit = expectedHead;

    expect(integrateCandidate({ repoDir, expectedHead, candidateCommit }))
      .toMatchObject({ integrated: false, reason: "already_applied_exact_tree" });
  });
});
