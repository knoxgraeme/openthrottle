import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeExactSubjectReadOnlyRepositoryView } from "./loop-paths.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (existsSync(directory)) execFileSync("chmod", ["-R", "u+w", directory]);
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(repoDir, args) {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
}

describe("exact-subject read-only repository views", () => {
  it("packs only the current commit and tree closure from deep history", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "ot-deep-history-source-"));
    const viewRoot = mkdtempSync(join(tmpdir(), "ot-deep-history-view-"));
    directories.push(repoDir, viewRoot);
    git(repoDir, ["init", "-q", "-b", "main"]);
    git(repoDir, ["config", "user.name", "Test"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    for (let index = 0; index < 80; index += 1) {
      mkdirSync(join(repoDir, "history"), { recursive: true });
      writeFileSync(join(repoDir, "history", `old-${index}.txt`), `${index}:${"x".repeat(4_096)}\n`);
      if (index > 0) rmSync(join(repoDir, "history", `old-${index - 1}.txt`));
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-qm", `history ${index}`]);
    }
    rmSync(join(repoDir, "history"), { recursive: true, force: true });
    writeFileSync(join(repoDir, "current.txt"), "current-only\n");
    git(repoDir, ["add", "-A"]);
    git(repoDir, ["commit", "-qm", "current tree"]);
    const subject = git(repoDir, ["rev-parse", "HEAD"]);
    const destination = join(viewRoot, "repo-view");

    materializeExactSubjectReadOnlyRepositoryView({ sourceRepoDir: repoDir, sourceSubject: subject, destination });

    expect(git(destination, ["rev-parse", "HEAD"])).toBe(subject);
    expect(readFileSync(join(destination, "current.txt"), "utf8")).toBe("current-only\n");
    expect(existsSync(join(destination, "history"))).toBe(false);
    expect(() => git(destination, ["cat-file", "-e", "HEAD^"])).toThrow();
    const objectCount = Number(git(destination, ["count-objects", "-v"]).match(/in-pack: (\d+)/)?.[1]);
    expect(objectCount).toBeLessThanOrEqual(4);
    expect(statSync(destination).mode & 0o777).toBe(0o555);
  });
});
