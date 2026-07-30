import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  git(directory, ["add", "."]);
  git(directory, ["commit", "-qm", "initial"]);
  return directory;
}

describe("executor-owned worktrees", () => {
  it("rejects traversal handles before touching the filesystem", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ot-worktrees-"));
    directories.push(rootDir);
    expect(() => worktreePath({ rootDir, handle: "../escape" })).toThrow(/handle is invalid/);
  });

  it("creates an exact-base clean worktree with sealed hooks and disabled push URL", () => {
    const repoDir = repository();
    const rootDir = mkdtempSync(join(tmpdir(), "ot-worktrees-"));
    directories.push(rootDir);
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);

    const created = createWorktree({ repoDir, rootDir, handle: "unit-1", baseCommit, hooksPath: "/sealed/hooks" });

    expect(git(created.path, ["rev-parse", "HEAD"])).toBe(baseCommit);
    expect(git(created.path, ["status", "--porcelain"])).toBe("");
    expect(git(created.path, ["config", "--get", "core.hooksPath"])).toBe("/sealed/hooks");
    expect(git(created.path, ["config", "--get", "remote.origin.pushurl"])).toBe("DISABLED_BY_OPENTHROTTLE_LOOP_WORKTREE");
  });

  it("refuses wrong-base and dirty integration checkouts", () => {
    const repoDir = repository();
    const rootDir = mkdtempSync(join(tmpdir(), "ot-worktrees-"));
    directories.push(rootDir);
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    expect(() => createWorktree({ repoDir, rootDir, handle: "wrong", baseCommit: "b".repeat(40) }))
      .toThrow(/does not match requested/);

    writeFileSync(join(repoDir, "dirty.txt"), "dirty\n");
    expect(() => createWorktree({ repoDir, rootDir, handle: "dirty", baseCommit }))
      .toThrow(/must be clean/);
  });

  it("derives an internal candidate commit without moving worker HEAD", () => {
    const repoDir = repository();
    const rootDir = mkdtempSync(join(tmpdir(), "ot-worktrees-"));
    directories.push(rootDir);
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    const created = createWorktree({ repoDir, rootDir, handle: "unit-2", baseCommit });
    writeFileSync(join(created.path, "file.txt"), "changed\n");

    const candidate = deriveCandidateCommit({ worktreeDir: created.path, baseCommit, message: "candidate" });

    expect(candidate.candidateCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(candidate.changedPaths).toEqual(["file.txt"]);
    expect(git(created.path, ["rev-parse", "HEAD"])).toBe(baseCommit);
  });

  it("removes only the selected worktree handle", () => {
    const repoDir = repository();
    const rootDir = mkdtempSync(join(tmpdir(), "ot-worktrees-"));
    directories.push(rootDir);
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    const first = createWorktree({ repoDir, rootDir, handle: "unit-a", baseCommit });
    const second = createWorktree({ repoDir, rootDir, handle: "unit-b", baseCommit });

    removeWorktree({ repoDir, rootDir, handle: "unit-a" });

    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(true);
    expect(removeWorktree({ repoDir, rootDir, handle: "unit-a" })).toEqual({
      id: "unit-a",
      removed: false,
    });
  });

  it("locks retained worktrees and grants only the current handle", () => {
    const repoDir = repository();
    const rootDir = mkdtempSync(join(tmpdir(), "ot-worktrees-"));
    directories.push(rootDir);
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    const first = createWorktree({ repoDir, rootDir, handle: "unit-a", baseCommit });
    const second = createWorktree({ repoDir, rootDir, handle: "unit-b", baseCommit });

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
});
