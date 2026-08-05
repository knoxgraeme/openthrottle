import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureRepositoryControl,
  computeWorkspaceTreeOid,
  repositoryControlMatches,
} from "./repository-control.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    try {
      chmodSync(directory, 0o700);
      execFileSync("chmod", ["-R", "u+rwX", directory]);
    } catch {
      // Tests may deliberately hide repository metadata from the agent user.
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

function repository() {
  const directory = mkdtempSync(join(tmpdir(), "ot-control-repo-"));
  directories.push(directory);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  writeFileSync(join(directory, "file.txt"), "initial\n");
  writeFileSync(join(directory, "other.txt"), "other\n");
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: directory });
  return directory;
}

// Copy the way the entrypoint builds the disposable fresh-review checkout
// (`cp -R --reflink=auto`): contents only, stat metadata not preserved. Bump
// worktree mtimes past the copied index so every entry is stat-stale exactly
// as after the real copy, independent of filesystem timestamp granularity.
function staleCheckoutCopy(sourceDir) {
  const directory = mkdtempSync(join(tmpdir(), "ot-control-copy-"));
  directories.push(directory);
  cpSync(sourceDir, directory, { recursive: true, force: true });
  const later = new Date(Date.now() + 2_000);
  for (const file of ["file.txt", "other.txt"]) {
    utimesSync(join(directory, file), later, later);
  }
  return directory;
}

describe("repositoryControlMatches", () => {
  it("survives the agent's first git status in a stat-stale checkout copy", () => {
    const repoDir = staleCheckoutCopy(repository());
    const control = captureRepositoryControl(repoDir);
    execFileSync("git", ["status", "--porcelain"], { cwd: repoDir });
    expect(repositoryControlMatches(repoDir, control)).toBe(true);
  });

  it("treats a benign stat-cache index rewrite after capture as unchanged", () => {
    const repoDir = repository();
    const control = captureRepositoryControl(repoDir);
    const later = new Date(Date.now() + 2_000);
    utimesSync(join(repoDir, "file.txt"), later, later);
    execFileSync("git", ["status", "--porcelain"], { cwd: repoDir });
    expect(repositoryControlMatches(repoDir, control)).toBe(true);
  });

  it("still detects staged content changes", () => {
    const repoDir = repository();
    const control = captureRepositoryControl(repoDir);
    writeFileSync(join(repoDir, "new.txt"), "added\n");
    execFileSync("git", ["add", "new.txt"], { cwd: repoDir });
    expect(repositoryControlMatches(repoDir, control)).toBe(false);
  });

  it("still detects a staged content swap that keeps the entry count", () => {
    const repoDir = repository();
    const control = captureRepositoryControl(repoDir);
    writeFileSync(join(repoDir, "file.txt"), "tampered\n");
    execFileSync("git", ["add", "file.txt"], { cwd: repoDir });
    expect(repositoryControlMatches(repoDir, control)).toBe(false);
  });

  it("still detects HEAD movement", () => {
    const repoDir = repository();
    const control = captureRepositoryControl(repoDir);
    writeFileSync(join(repoDir, "file.txt"), "changed\n");
    execFileSync("git", ["add", "file.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-qm", "mutation"], { cwd: repoDir });
    expect(repositoryControlMatches(repoDir, control)).toBe(false);
  });
});

describe("computeWorkspaceTreeOid", () => {
  function withGitEnvironment(env, callback) {
    const names = ["GIT_DIR", "GIT_WORK_TREE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"];
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) {
        if (env[name]) {
          process.env[name] = env[name];
        } else {
          delete process.env[name];
        }
      }
      return callback();
    } finally {
      for (const name of names) {
        if (previous[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = previous[name];
        }
      }
    }
  }

  it("uses a supplied Git directory when linked worktree metadata is locked", () => {
    const repoDir = repository();
    const gitDir = mkdtempSync(join(tmpdir(), "ot-control-git-dir-"));
    const baseObjects = mkdtempSync(join(tmpdir(), "ot-control-base-objects-"));
    const writeObjects = mkdtempSync(join(tmpdir(), "ot-control-objects-"));
    directories.push(gitDir, baseObjects, writeObjects);
    const head = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const expectedTree = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    cpSync(join(repoDir, ".git", "objects"), baseObjects, { recursive: true });
    mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
    mkdirSync(join(gitDir, "objects"), { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), `${head}\n`);
    writeFileSync(join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");

    chmodSync(join(repoDir, ".git"), 0o000);
    try {
      expect(computeWorkspaceTreeOid(repoDir, {
        GIT_DIR: gitDir,
        GIT_WORK_TREE: repoDir,
        GIT_OBJECT_DIRECTORY: writeObjects,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: baseObjects,
      })).toBe(expectedTree);
    } finally {
      chmodSync(join(repoDir, ".git"), 0o700);
    }
  });

  it("preserves inherited action-local Git object directories", () => {
    const repoDir = repository();
    const gitDir = mkdtempSync(join(tmpdir(), "ot-control-inherited-git-dir-"));
    const baseObjects = mkdtempSync(join(tmpdir(), "ot-control-inherited-base-objects-"));
    const writeObjects = mkdtempSync(join(tmpdir(), "ot-control-inherited-objects-"));
    directories.push(gitDir, baseObjects, writeObjects);
    const head = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const expectedTree = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    cpSync(join(repoDir, ".git", "objects"), baseObjects, { recursive: true });
    mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
    mkdirSync(join(gitDir, "objects"), { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), `${head}\n`);
    writeFileSync(join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");

    chmodSync(join(repoDir, ".git"), 0o000);
    try {
      expect(withGitEnvironment({
        GIT_DIR: gitDir,
        GIT_WORK_TREE: repoDir,
        GIT_OBJECT_DIRECTORY: writeObjects,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: baseObjects,
      }, () => computeWorkspaceTreeOid(repoDir))).toBe(expectedTree);
    } finally {
      chmodSync(join(repoDir, ".git"), 0o700);
    }
  });
});
