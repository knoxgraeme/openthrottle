import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(directory, "run.sh"), "#!/bin/sh\n");
  chmodSync(join(directory, "run.sh"), 0o755);
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
    expect(statSync(join(created.path, "run.sh")).mode & 0o777).toBe(0o700);
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

  it("reuses an existing clean exact-base worktree only in idempotent mode", () => {
    const repoDir = repository();
    const rootDir = mkdtempSync(join(tmpdir(), "ot-worktrees-"));
    directories.push(rootDir);
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    const created = createWorktree({ repoDir, rootDir, handle: "unit-repeat", baseCommit, hooksPath: "/sealed/hooks" });

    expect(() => createWorktree({ repoDir, rootDir, handle: "unit-repeat", baseCommit }))
      .toThrow(/already exists/);
    writeFileSync(join(repoDir, "next.txt"), "next\n");
    git(repoDir, ["add", "next.txt"]);
    git(repoDir, ["commit", "-qm", "next"]);
    const nextCommit = git(repoDir, ["rev-parse", "HEAD"]);
    expect(() => createWorktree({ repoDir, rootDir, handle: "unit-repeat", baseCommit: nextCommit, idempotent: true }))
      .toThrow(/different base commit/);
    git(created.path, ["config", "--worktree", "core.hooksPath", "/tmp/unsealed-hooks"]);
    git(created.path, ["config", "--worktree", "remote.origin.pushurl", "https://example.invalid/push.git"]);
    expect(createWorktree({ repoDir, rootDir, handle: "unit-repeat", baseCommit, hooksPath: "/sealed/hooks", idempotent: true }))
      .toEqual({ id: "unit-repeat", path: created.path, baseCommit });
    expect(git(created.path, ["config", "--get", "core.hooksPath"])).toBe("/sealed/hooks");
    expect(git(created.path, ["config", "--get", "remote.origin.pushurl"])).toBe("DISABLED_BY_OPENTHROTTLE_LOOP_WORKTREE");

    writeFileSync(join(created.path, "dirty.txt"), "dirty\n");
    expect(() => createWorktree({ repoDir, rootDir, handle: "unit-repeat", baseCommit, idempotent: true }))
      .toThrow(/existing worktree is dirty/);
  });

  it("derives an internal candidate commit without moving worker HEAD", () => {
    const repoDir = repository();
    const rootDir = mkdtempSync(join(tmpdir(), "ot-worktrees-"));
    directories.push(rootDir);
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    const created = createWorktree({ repoDir, rootDir, handle: "unit-2", baseCommit });
    writeFileSync(join(created.path, "file.txt"), "changed\n");
    writeFileSync(join(created.path, "new-executable.sh"), "#!/bin/sh\n");
    chmodSync(join(created.path, "new-executable.sh"), 0o755);

    const candidate = deriveCandidateCommit({ worktreeDir: created.path, baseCommit, message: "candidate" });

    expect(candidate.candidateCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(candidate.changedPaths).toEqual(["file.txt", "new-executable.sh"]);
    expect(git(repoDir, ["ls-tree", candidate.candidateCommit, "new-executable.sh"])).toContain("100755");
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

  it("recovers a stale worktree registration when normal removal fails", () => {
    const repoDir = repository();
    const rootDir = mkdtempSync(join(tmpdir(), "ot-worktrees-"));
    directories.push(rootDir);
    const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
    const created = createWorktree({ repoDir, rootDir, handle: "stale", baseCommit });
    rmSync(join(created.path, ".git"), { force: true });

    expect(removeWorktree({ repoDir, rootDir, handle: "stale" })).toEqual({
      id: "stale",
      removed: true,
      recovered: true,
    });
    expect(existsSync(created.path)).toBe(false);
    expect(git(repoDir, ["worktree", "list", "--porcelain"])).not.toContain(created.path);
    expect(createWorktree({ repoDir, rootDir, handle: "stale", baseCommit }).id).toBe("stale");
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
