import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { computeWorkspaceTreeOid } from "../runner/repository-control.mjs";
import { subjectPost } from "./ot-subject-post.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository() {
  const directory = mkdtempSync(join(tmpdir(), "ot-subject-post-repo-"));
  directories.push(directory);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  writeFileSync(join(directory, "file.txt"), "initial\n");
  mkdirSync(join(directory, "sub"));
  writeFileSync(join(directory, "sub", "nested.txt"), "nested\n");
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: directory });
  return directory;
}

function installedCommand() {
  const binDirectory = mkdtempSync(join(tmpdir(), "ot-subject-post-bin-"));
  directories.push(binDirectory);
  const command = join(binDirectory, "ot-subject-post");
  symlinkSync(fileURLToPath(new URL("./ot-subject-post.mjs", import.meta.url)), command);
  return command;
}

describe("ot-subject-post", () => {
  it("prints exactly the executor's own post-run subject for real edits in a worktree root", () => {
    const repoDir = repository();
    writeFileSync(join(repoDir, "file.txt"), "changed\n");
    writeFileSync(join(repoDir, "new-file.txt"), "new\n");

    expect(subjectPost(repoDir)).toBe(computeWorkspaceTreeOid(repoDir));
  });

  it("changes when the workspace changes and matches a fresh recomputation each time", () => {
    const repoDir = repository();
    const clean = subjectPost(repoDir);

    writeFileSync(join(repoDir, "new-file.txt"), "new\n");
    const dirty = subjectPost(repoDir);

    expect(dirty).not.toBe(clean);
    expect(dirty).toBe(computeWorkspaceTreeOid(repoDir));
  });

  it("runs through an installed symlink from the worktree root and matches the direct computation", () => {
    const repoDir = repository();
    writeFileSync(join(repoDir, "new-file.txt"), "new\n");

    const result = spawnSync(process.execPath, [installedCommand()], { cwd: repoDir, encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(computeWorkspaceTreeOid(repoDir));
  });

  // From a subdirectory the underlying `add -A -- .` only refreshes that
  // subtree, so edits elsewhere stay at their HEAD content and a well-formed
  // but wrong 40-hex oid used to print with exit 0. A worker that copies it
  // into subject.post either trips an unexplained fence mismatch later or,
  // when every edit happens to live under that subdirectory, passes silently.
  it("refuses to print a subject from a subdirectory instead of diverging silently", () => {
    const repoDir = repository();
    writeFileSync(join(repoDir, "file.txt"), "changed at the root\n");
    const subDirectory = join(repoDir, "sub");

    const result = spawnSync(process.execPath, [installedCommand()], { cwd: subDirectory, encoding: "utf8" });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/run from the worktree root: /);
    // Both paths are named, so the message says where to go and where it ran.
    expect(result.stderr).toContain(realpathSync(repoDir));
    expect(result.stderr).toContain(realpathSync(subDirectory));
    expect(() => subjectPost(subDirectory)).toThrow(/run from the worktree root: /);
  });

  it("honors a sealed GIT_WORK_TREE when deciding what the worktree root is", () => {
    const repoDir = repository();
    writeFileSync(join(repoDir, "file.txt"), "changed at the root\n");
    const env = { ...process.env, GIT_DIR: join(repoDir, ".git"), GIT_WORK_TREE: repoDir };
    const command = installedCommand();

    const fromRoot = spawnSync(process.execPath, [command], { cwd: repoDir, encoding: "utf8", env });
    const fromSub = spawnSync(process.execPath, [command], { cwd: join(repoDir, "sub"), encoding: "utf8", env });

    expect(fromRoot.status, fromRoot.stderr).toBe(0);
    expect(fromRoot.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(fromSub.status).not.toBe(0);
    expect(fromSub.stderr).toMatch(/run from the worktree root: /);
  });
});
