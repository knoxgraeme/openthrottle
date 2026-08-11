import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorktree,
  deriveCandidateCommit,
  grantWorktreeToAgent,
  lockWorktree,
  removeWorktree,
  worktreePath,
} from "./worktrees.mjs";
import { ensureWorktreeBootstrap, worktreeBootstrapMarkerPath } from "./worktree-bootstrap.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(repoDir, args) {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
}

function repository() {
  const directory = mkdtempSync(join(tmpdir(), "ot-worktree-repo-"));
  directories.push(directory);
  git(directory, ["init", "-q", "-b", "main"]);
  git(directory, ["config", "user.name", "Test"]);
  git(directory, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(directory, "file.txt"), "initial\n");
  writeFileSync(join(directory, "run.sh"), "#!/bin/sh\n");
  chmodSync(join(directory, "run.sh"), 0o755);
  git(directory, ["add", "."]);
  git(directory, ["commit", "-qm", "initial"]);
  return directory;
}

function markerRoot() {
  const markerRootDir = mkdtempSync(join(tmpdir(), "ot-worktree-markers-"));
  directories.push(markerRootDir);
  return markerRootDir;
}

function worktreeEnvironment() {
  const rootDir = mkdtempSync(join(tmpdir(), "ot-worktrees-"));
  directories.push(rootDir);
  return { rootDir, markerRootDir: markerRoot() };
}

function createTestWorktree(options) {
  if (!options.markerRootDir) throw new Error("worktree tests must use a temporary marker root");
  return createWorktree(options);
}

function removeTestWorktree(options) {
  if (!options.markerRootDir) throw new Error("worktree tests must use a temporary marker root");
  return removeWorktree(options);
}

describe("executor-owned worktrees", () => {
  it("rejects traversal handles before touching the filesystem", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ot-worktrees-"));
    directories.push(rootDir);
    expect(() => worktreePath({ rootDir, handle: "../escape" })).toThrow(/handle is invalid/);
  });

  it("creates an exact-base clean worktree with sealed hooks and disabled push URL", () => {
    const repoDir = repository();
    const { rootDir, markerRootDir } = worktreeEnvironment();
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);

    const created = createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "unit-1", baseCommit, hooksPath: "/sealed/hooks" });

    expect(git(created.path, ["rev-parse", "HEAD"])).toBe(baseCommit);
    expect(git(created.path, ["status", "--porcelain"])).toBe("");
    expect(git(created.path, ["config", "--get", "core.hooksPath"])).toBe("/sealed/hooks");
    expect(git(created.path, ["config", "--get", "remote.origin.pushurl"])).toBe("DISABLED_BY_OPENTHROTTLE_LOOP_WORKTREE");
    expect(statSync(join(created.path, "run.sh")).mode & 0o777).toBe(0o700);
  });

  it("refuses wrong-base and dirty integration checkouts", () => {
    const repoDir = repository();
    const { rootDir, markerRootDir } = worktreeEnvironment();
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    expect(() => createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "wrong", baseCommit: "b".repeat(40) }))
      .toThrow(/does not match requested/);

    writeFileSync(join(repoDir, "dirty.txt"), "dirty\n");
    expect(() => createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "dirty", baseCommit }))
      .toThrow(/must be clean/);
  });

  it("reuses an existing clean exact-base worktree only in idempotent mode", () => {
    const repoDir = repository();
    const { rootDir, markerRootDir } = worktreeEnvironment();
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    const created = createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "unit-repeat", baseCommit, hooksPath: "/sealed/hooks" });

    expect(() => createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "unit-repeat", baseCommit }))
      .toThrow(/already exists/);
    writeFileSync(join(repoDir, "next.txt"), "next\n");
    git(repoDir, ["add", "next.txt"]);
    git(repoDir, ["commit", "-qm", "next"]);
    const nextCommit = git(repoDir, ["rev-parse", "HEAD"]);
    expect(() => createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "unit-repeat", baseCommit: nextCommit, idempotent: true }))
      .toThrow(/different base commit/);
    git(created.path, ["config", "--worktree", "core.hooksPath", "/tmp/unsealed-hooks"]);
    git(created.path, ["config", "--worktree", "remote.origin.pushurl", "https://example.invalid/push.git"]);
    expect(createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "unit-repeat", baseCommit, hooksPath: "/sealed/hooks", idempotent: true }))
      .toEqual({ id: "unit-repeat", path: created.path, baseCommit });
    expect(git(created.path, ["config", "--get", "core.hooksPath"])).toBe("/sealed/hooks");
    expect(git(created.path, ["config", "--get", "remote.origin.pushurl"])).toBe("DISABLED_BY_OPENTHROTTLE_LOOP_WORKTREE");

    writeFileSync(join(created.path, "dirty.txt"), "dirty\n");
    expect(() => createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "unit-repeat", baseCommit, idempotent: true }))
      .toThrow(/existing worktree is dirty/);
  });

  it("derives an internal candidate commit without moving worker HEAD", () => {
    const repoDir = repository();
    const { rootDir, markerRootDir } = worktreeEnvironment();
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    const created = createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "unit-2", baseCommit });
    git(created.path, ["config", "core.fileMode", "false"]);
    writeFileSync(join(created.path, "file.txt"), "changed\n");
    writeFileSync(join(created.path, "new-executable.sh"), "#!/bin/sh\n");
    chmodSync(join(created.path, "new-executable.sh"), 0o755);
    chmodSync(join(created.path, "file.txt"), 0o755);

    const candidate = deriveCandidateCommit({ worktreeDir: created.path, baseCommit, message: "candidate" });

    expect(candidate.candidateCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(candidate.changedPaths).toEqual(["file.txt", "new-executable.sh"]);
    expect(git(repoDir, ["ls-tree", candidate.candidateCommit, "file.txt"])).toContain("100755");
    expect(git(repoDir, ["ls-tree", candidate.candidateCommit, "new-executable.sh"])).toContain("100755");
    expect(git(created.path, ["rev-parse", "HEAD"])).toBe(baseCommit);
  });

  it.runIf(process.platform !== "darwin")("derives a case-only rename even when repository config ignores case", () => {
    const repoDir = repository();
    const { rootDir, markerRootDir } = worktreeEnvironment();
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    const created = createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "unit-case", baseCommit });
    git(created.path, ["config", "core.ignoreCase", "true"]);
    renameSync(join(created.path, "file.txt"), join(created.path, "FILE.txt"));

    const candidate = deriveCandidateCommit({ worktreeDir: created.path, baseCommit, message: "case candidate" });
    const paths = git(repoDir, ["ls-tree", "--name-only", candidate.candidateCommit]).split("\n");

    expect(candidate.candidateCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(paths).toContain("FILE.txt");
    expect(paths).not.toContain("file.txt");
  });

  it("derives a symlink-to-file change even when repository config disables symlinks", () => {
    const repoDir = repository();
    symlinkSync("target", join(repoDir, "item"));
    git(repoDir, ["add", "item"]);
    git(repoDir, ["commit", "-qm", "symlink base"]);
    const { rootDir, markerRootDir } = worktreeEnvironment();
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    const created = createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "unit-symlink", baseCommit });
    git(created.path, ["config", "core.symlinks", "false"]);
    rmSync(join(created.path, "item"));
    writeFileSync(join(created.path, "item"), "target");

    const candidate = deriveCandidateCommit({ worktreeDir: created.path, baseCommit, message: "symlink candidate" });

    expect(candidate.candidateCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(git(repoDir, ["ls-tree", candidate.candidateCommit, "item"])).toContain("100644");
  });

  it("derives from the selected worktree when repository config redirects core.worktree", () => {
    const repoDir = repository();
    const { rootDir, markerRootDir } = worktreeEnvironment();
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    const created = createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "unit-redirect", baseCommit });
    const alternate = mkdtempSync(join(tmpdir(), "ot-alternate-worktree-"));
    directories.push(alternate);
    writeFileSync(join(alternate, "file.txt"), "initial\n");
    writeFileSync(join(alternate, "run.sh"), "#!/bin/sh\n");
    chmodSync(join(alternate, "run.sh"), 0o755);
    git(created.path, ["config", "core.worktree", alternate]);
    writeFileSync(join(created.path, "file.txt"), "selected checkout\n");

    const candidate = deriveCandidateCommit({ worktreeDir: created.path, baseCommit, message: "redirect candidate" });

    expect(candidate.candidateCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(git(repoDir, ["show", `${candidate.candidateCommit}:file.txt`])).toBe("selected checkout");
  });

  it("fails closed when repository config enables sparse checkout", () => {
    const repoDir = repository();
    const { rootDir, markerRootDir } = worktreeEnvironment();
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    const created = createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "unit-sparse", baseCommit });
    git(created.path, ["config", "core.sparseCheckout", "true"]);

    expect(() => deriveCandidateCommit({ worktreeDir: created.path, baseCommit }))
      .toThrow(/requires a full non-sparse checkout/);
  });

  it("derives new worker files hidden by global and Git metadata excludes", () => {
    const repoDir = repository();
    const { rootDir, markerRootDir } = worktreeEnvironment();
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    const created = createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "unit-excludes", baseCommit });
    const excludesRoot = mkdtempSync(join(tmpdir(), "ot-global-excludes-"));
    directories.push(excludesRoot);
    const excludesFile = join(excludesRoot, "ignore");
    writeFileSync(excludesFile, "*.worker-output\n");
    git(created.path, ["config", "core.excludesFile", excludesFile]);
    const infoExclude = git(created.path, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
    writeFileSync(infoExclude, "*.info-output\n*.hidden-executable\n");
    git(created.path, ["config", "core.fileMode", "false"]);
    writeFileSync(join(created.path, ".gitignore"), "*.intentionally-ignored\nignored-nested/\n");
    writeFileSync(join(created.path, "completed.worker-output"), "completed work\n");
    writeFileSync(join(created.path, "completed.info-output"), "completed info-excluded work\n");
    writeFileSync(join(created.path, "tool.hidden-executable"), "#!/bin/sh\n");
    chmodSync(join(created.path, "tool.hidden-executable"), 0o755);
    writeFileSync(join(created.path, "cache.intentionally-ignored"), "ignored cache\n");
    const ignoredNested = join(created.path, "ignored-nested");
    execFileSync("git", ["init", "-q", "-b", "main", ignoredNested]);
    execFileSync("git", ["config", "user.name", "Nested Test"], { cwd: ignoredNested });
    execFileSync("git", ["config", "user.email", "nested@example.com"], { cwd: ignoredNested });
    writeFileSync(join(ignoredNested, "nested.txt"), "ignored nested work\n");
    execFileSync("git", ["add", "nested.txt"], { cwd: ignoredNested });
    execFileSync("git", ["commit", "--quiet", "-m", "ignored nested"], { cwd: ignoredNested });
    const ignoredCacheBlob = git(created.path, ["hash-object", "--no-filters", "cache.intentionally-ignored"]);

    const candidate = deriveCandidateCommit({ worktreeDir: created.path, baseCommit, message: "exclude candidate" });

    expect(candidate.candidateCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(candidate.changedPaths).toContain("completed.worker-output");
    expect(candidate.changedPaths).toContain("completed.info-output");
    expect(candidate.changedPaths).toContain("tool.hidden-executable");
    expect(candidate.changedPaths).not.toContain("cache.intentionally-ignored");
    expect(candidate.changedPaths).not.toContain("ignored-nested");
    expect(git(repoDir, ["show", `${candidate.candidateCommit}:completed.worker-output`])).toBe("completed work");
    expect(git(repoDir, ["show", `${candidate.candidateCommit}:completed.info-output`])).toBe("completed info-excluded work");
    expect(git(repoDir, ["ls-tree", candidate.candidateCommit, "tool.hidden-executable"])).toContain("100755");
    expect(() => git(repoDir, ["cat-file", "-e", ignoredCacheBlob])).toThrow();
  });

  it("derives a changed gitlink when repository diff config ignores submodules", () => {
    const repoDir = repository();
    const { rootDir, markerRootDir } = worktreeEnvironment();
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    const created = createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "unit-gitlink-diff", baseCommit });
    git(created.path, ["config", "diff.ignoreSubmodules", "all"]);
    const nested = join(created.path, "nested-worker-repo");
    execFileSync("git", ["init", "-q", "-b", "main", nested]);
    execFileSync("git", ["config", "user.name", "Nested Test"], { cwd: nested });
    execFileSync("git", ["config", "user.email", "nested@example.com"], { cwd: nested });
    writeFileSync(join(nested, "nested.txt"), "nested work\n");
    execFileSync("git", ["add", "nested.txt"], { cwd: nested });
    execFileSync("git", ["commit", "--quiet", "-m", "nested worker"], { cwd: nested });

    const candidate = deriveCandidateCommit({ worktreeDir: created.path, baseCommit, message: "gitlink candidate" });

    expect(candidate.candidateCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(candidate.changedPaths).toContain("nested-worker-repo");
    expect(git(repoDir, ["ls-tree", candidate.candidateCommit, "nested-worker-repo"])).toContain("160000");
  });

  it("removes only the selected worktree handle", () => {
    const repoDir = repository();
    const { rootDir, markerRootDir } = worktreeEnvironment();
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    const first = createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "unit-a", baseCommit });
    const second = createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "unit-b", baseCommit });

    removeTestWorktree({ repoDir, rootDir, markerRootDir, handle: "unit-a" });

    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(true);
    expect(removeTestWorktree({ repoDir, rootDir, markerRootDir, handle: "unit-a" })).toEqual({
      id: "unit-a",
      removed: false,
    });
  });

  it("clears the bootstrap marker on removal and on fresh creation so a recreated handle bootstraps again", () => {
    const repoDir = repository();
    const { rootDir, markerRootDir } = worktreeEnvironment();
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    const sealMarker = () => ensureWorktreeBootstrap({
      worktreeDir: worktreePath({ rootDir, handle: "unit-a" }),
      handle: "unit-a",
      config: { post_bootstrap: ["true"] },
      configDigest: "a".repeat(64),
      markerRootDir,
      executeCommand: () => ({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" }),
    });
    const markerPath = worktreeBootstrapMarkerPath({ markerRootDir, handle: "unit-a" });

    createTestWorktree({ repoDir, rootDir, handle: "unit-a", baseCommit, markerRootDir });
    sealMarker();
    removeTestWorktree({ repoDir, rootDir, handle: "unit-a", markerRootDir });
    expect(existsSync(markerPath)).toBe(false);

    // A marker left behind by any earlier same-handle worktree must not let
    // a freshly created (dependency-free) worktree skip its bootstrap.
    sealMarker();
    createTestWorktree({ repoDir, rootDir, handle: "unit-a", baseCommit, markerRootDir });
    expect(existsSync(markerPath)).toBe(false);
  });

  it("recovers a stale worktree registration when normal removal fails", () => {
    const repoDir = repository();
    const { rootDir, markerRootDir } = worktreeEnvironment();
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    const created = createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "stale", baseCommit });
    rmSync(join(created.path, ".git"), { force: true });

    expect(removeTestWorktree({ repoDir, rootDir, markerRootDir, handle: "stale" })).toEqual({
      id: "stale",
      removed: true,
      recovered: true,
    });
    expect(existsSync(created.path)).toBe(false);
    expect(git(repoDir, ["worktree", "list", "--porcelain"])).not.toContain(created.path);
    expect(createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "stale", baseCommit }).id).toBe("stale");
  });

  it("locks retained worktrees and grants only the current handle", () => {
    const repoDir = repository();
    const { rootDir, markerRootDir } = worktreeEnvironment();
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    const first = createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "unit-a", baseCommit });
    const second = createTestWorktree({ repoDir, rootDir, markerRootDir, handle: "unit-b", baseCommit });

    expect(statSync(rootDir).mode & 0o777).toBe(0o711);
    expect(statSync(first.path).mode & 0o777).toBe(0o700);
    expect(statSync(join(first.path, ".git")).mode & 0o777).toBe(0o444);
    expect(statSync(second.path).mode & 0o777).toBe(0o700);
    expect(statSync(join(second.path, ".git")).mode & 0o777).toBe(0o444);

    grantWorktreeToAgent({ rootDir, handle: "unit-b" });
    expect(statSync(first.path).mode & 0o777).toBe(0o700);
    expect(statSync(second.path).mode & 0o777).toBe(0o700);
    expect(statSync(join(second.path, ".git")).mode & 0o777).toBe(0o444);

    lockWorktree({ rootDir, handle: "unit-b" });
    expect(statSync(second.path).mode & 0o777).toBe(0o700);
  });

  it("rejects a symlinked worktree root before chown/chmod ever follows it to its target", () => {
    const attackTarget = mkdtempSync(join(tmpdir(), "ot-worktrees-attack-target-"));
    directories.push(attackTarget);
    chmodSync(attackTarget, 0o755);
    const symlinkParent = mkdtempSync(join(tmpdir(), "ot-worktrees-symlink-parent-"));
    directories.push(symlinkParent);
    const rootDir = join(symlinkParent, "root");
    symlinkSync(attackTarget, rootDir);

    expect(() => grantWorktreeToAgent({ rootDir, handle: "unit-1" })).toThrow(/worktree root must be a real directory/);
    // The attacker-controlled symlink target must never be touched: if
    // assertDirectory ran after chown/chmod instead of before, this mode
    // would already be 0711.
    expect(statSync(attackTarget).mode & 0o777).toBe(0o755);
  });
});
