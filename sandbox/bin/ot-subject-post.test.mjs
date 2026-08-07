import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: directory });
  return directory;
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
    const binDirectory = mkdtempSync(join(tmpdir(), "ot-subject-post-bin-"));
    directories.push(binDirectory);
    const command = join(binDirectory, "ot-subject-post");
    symlinkSync(fileURLToPath(new URL("./ot-subject-post.mjs", import.meta.url)), command);

    const result = spawnSync(process.execPath, [command], { cwd: repoDir, encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(computeWorkspaceTreeOid(repoDir));
  });
});
