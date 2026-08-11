import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureRepositoryControl,
  computeWorkspaceTreeOid,
  computeWorkspaceTreeOidAsExecutor,
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

  it("attests executable-bit changes even when repository config ignores file modes", () => {
    const repoDir = repository();
    const before = computeWorkspaceTreeOid(repoDir);
    execFileSync("git", ["config", "core.fileMode", "false"], { cwd: repoDir });
    chmodSync(join(repoDir, "file.txt"), 0o755);

    const after = computeWorkspaceTreeOid(repoDir);

    expect(after).not.toBe(before);
    expect(execFileSync("git", ["ls-tree", after, "file.txt"], {
      cwd: repoDir,
      encoding: "utf8",
    })).toContain("100755");
  });

  it.runIf(process.platform !== "darwin")("attests case-only renames even when repository config ignores case", () => {
    const repoDir = repository();
    const before = computeWorkspaceTreeOid(repoDir);
    execFileSync("git", ["config", "core.ignoreCase", "true"], { cwd: repoDir });
    renameSync(join(repoDir, "file.txt"), join(repoDir, "FILE.txt"));

    const after = computeWorkspaceTreeOid(repoDir);
    const paths = execFileSync("git", ["ls-tree", "--name-only", after], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim().split("\n");

    expect(after).not.toBe(before);
    expect(paths).toContain("FILE.txt");
    expect(paths).not.toContain("file.txt");
  });

  it("attests symlink-to-file changes even when repository config disables symlinks", () => {
    const repoDir = repository();
    symlinkSync("target", join(repoDir, "item"));
    execFileSync("git", ["add", "item"], { cwd: repoDir });
    execFileSync("git", ["commit", "-qm", "symlink base"], { cwd: repoDir });
    execFileSync("git", ["config", "core.symlinks", "false"], { cwd: repoDir });
    const before = computeWorkspaceTreeOid(repoDir);
    rmSync(join(repoDir, "item"));
    writeFileSync(join(repoDir, "item"), "target");

    const after = computeWorkspaceTreeOid(repoDir);

    expect(after).not.toBe(before);
    expect(execFileSync("git", ["ls-tree", after, "item"], {
      cwd: repoDir,
      encoding: "utf8",
    })).toContain("100644");
  });

  it("attests the selected checkout when repository config redirects core.worktree", () => {
    const repoDir = repository();
    const alternate = mkdtempSync(join(tmpdir(), "ot-control-alternate-worktree-"));
    directories.push(alternate);
    writeFileSync(join(alternate, "file.txt"), "initial\n");
    writeFileSync(join(alternate, "other.txt"), "other\n");
    execFileSync("git", ["config", "core.worktree", alternate], { cwd: repoDir });
    writeFileSync(join(repoDir, "file.txt"), "selected checkout\n");

    const subject = computeWorkspaceTreeOid(repoDir);

    expect(execFileSync("git", ["show", `${subject}:file.txt`], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim()).toBe("selected checkout");
  });

  it("fails closed when repository config enables sparse checkout", () => {
    const repoDir = repository();
    execFileSync("git", ["config", "core.sparseCheckout", "true"], { cwd: repoDir });

    expect(() => computeWorkspaceTreeOid(repoDir)).toThrow(/requires a full non-sparse checkout/);
  });

  it("attests new worker files hidden by global and Git metadata excludes", () => {
    const repoDir = repository();
    const excludesRoot = mkdtempSync(join(tmpdir(), "ot-control-global-excludes-"));
    directories.push(excludesRoot);
    const excludesFile = join(excludesRoot, "ignore");
    writeFileSync(excludesFile, "*.worker-output\n");
    execFileSync("git", ["config", "core.excludesFile", excludesFile], { cwd: repoDir });
    const infoExclude = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();
    writeFileSync(infoExclude, "*.info-output\n*.hidden-executable\n");
    execFileSync("git", ["config", "core.fileMode", "false"], { cwd: repoDir });
    writeFileSync(join(repoDir, ".gitignore"), "*.intentionally-ignored\nignored-nested/\n");
    writeFileSync(join(repoDir, "completed.worker-output"), "completed work\n");
    writeFileSync(join(repoDir, "completed.info-output"), "completed info-excluded work\n");
    writeFileSync(join(repoDir, "tool.hidden-executable"), "#!/bin/sh\n");
    chmodSync(join(repoDir, "tool.hidden-executable"), 0o755);
    writeFileSync(join(repoDir, "cache.intentionally-ignored"), "ignored cache\n");
    const ignoredNested = join(repoDir, "ignored-nested");
    execFileSync("git", ["init", "-q", "-b", "main", ignoredNested]);
    execFileSync("git", ["config", "user.name", "Nested Test"], { cwd: ignoredNested });
    execFileSync("git", ["config", "user.email", "nested@example.com"], { cwd: ignoredNested });
    writeFileSync(join(ignoredNested, "nested.txt"), "ignored nested work\n");
    execFileSync("git", ["add", "nested.txt"], { cwd: ignoredNested });
    execFileSync("git", ["commit", "--quiet", "-m", "ignored nested"], { cwd: ignoredNested });

    const subject = computeWorkspaceTreeOid(repoDir);

    expect(execFileSync("git", ["show", `${subject}:completed.worker-output`], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim()).toBe("completed work");
    expect(execFileSync("git", ["show", `${subject}:completed.info-output`], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim()).toBe("completed info-excluded work");
    expect(execFileSync("git", ["ls-tree", subject, "tool.hidden-executable"], {
      cwd: repoDir,
      encoding: "utf8",
    })).toContain("100755");
    expect(() => execFileSync("git", ["cat-file", "-e", `${subject}:cache.intentionally-ignored`], {
      cwd: repoDir,
      stdio: ["ignore", "ignore", "pipe"],
    })).toThrow();
    expect(() => execFileSync("git", ["cat-file", "-e", `${subject}:ignored-nested`], {
      cwd: repoDir,
      stdio: ["ignore", "ignore", "pipe"],
    })).toThrow();
  });

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

describe("computeWorkspaceTreeOidAsExecutor", () => {
  // Real gosu refuses to drop privileges unless the calling process is
  // genuinely root (verified: `gosu agent true` as a non-root process exits
  // "operation not permitted"). Mocking process.getuid() to report 0, without
  // the OS process actually being root, reproduces that same denial for
  // computeWorkspaceTreeOid's agent-authority git calls without requiring
  // this test to run as real root -- standing in for a linked worktree admin
  // dir another loop action's cleanup already relocked to root:root.
  it("computes the workspace subject with executor authority when agent-authority gosu is unavailable", () => {
    const repoDir = repository();
    const expectedTree = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    const getuidSpy = vi.spyOn(process, "getuid").mockReturnValue(0);
    try {
      expect(() => computeWorkspaceTreeOid(repoDir)).toThrow(
        /operation not permitted|failed switching|gosu|could not resolve the installed agent identity/i
      );
      expect(computeWorkspaceTreeOidAsExecutor(repoDir)).toBe(expectedTree);
    } finally {
      getuidSpy.mockRestore();
    }
  });
});
