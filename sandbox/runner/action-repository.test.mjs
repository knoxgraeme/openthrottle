import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  INSPECT_CHANGE_ARTIFACT_MAX_BYTES,
  INSPECT_CHANGE_CONTEXT_SCHEMA,
  materializeActionRepository,
  materializeInspectChangeArtifact,
  verifyActionRepository,
} from "./action-repository.mjs";
import { runGitAsExecutor } from "./repository-control.mjs";

function git(repo, ...args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function gitSucceeds(repo, ...args) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf8" }).status === 0;
}

function sourceRepository() {
  const repo = mkdtempSync(join(tmpdir(), "ot-kernel-source-"));
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "value.txt"), "base\n");
  git(repo, "add", "value.txt");
  git(repo, "commit", "--quiet", "-m", "base");
  const before = git(repo, "rev-parse", "HEAD");
  const beforeTree = git(repo, "rev-parse", "HEAD^{tree}");
  writeFileSync(join(repo, "value.txt"), "changed\n");
  writeFileSync(join(repo, "new.txt"), "new\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "changed");
  const after = git(repo, "rev-parse", "HEAD");
  const afterTree = git(repo, "rev-parse", "HEAD^{tree}");
  return { repo, before, beforeTree, after, afterTree };
}

describe("kernel action repository", () => {
  it("ignores ambient Git object and config redirection for executor operations", () => {
    const source = sourceRepository();
    const keys = [
      "GIT_DIR",
      "GIT_OBJECT_DIRECTORY",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
    ];
    const original = new Map(keys.map((key) => [key, process.env[key]]));
    process.env.GIT_DIR = join(source.repo, "missing.git");
    process.env.GIT_OBJECT_DIRECTORY = join(source.repo, "missing-objects");
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
    process.env.GIT_CONFIG_VALUE_0 = join(source.repo, "untrusted-hooks");
    try {
      expect(runGitAsExecutor(source.repo, ["rev-parse", "HEAD"])).toBe(source.after);
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("materializes an exact inspect subject with its accepted-edit diff and no remote", () => {
    const source = sourceRepository();
    const destination = join(mkdtempSync(join(tmpdir(), "ot-kernel-inspect-")), "repository");
    const view = materializeActionRepository({
      sourceRepoDir: source.repo,
      inputSubject: source.after,
      repositoryAuthority: "inspect",
      destination,
      changeBoundary: {
        checkpoint_id: "checkpoint-1",
        input_subject: source.before,
        output_subject: source.after,
      },
    });

    expect(readFileSync(join(destination, "value.txt"), "utf8")).toBe("changed\n");
    expect(git(destination, "diff", "--name-only", view.base_commit, view.head_commit))
      .toBe("new.txt\nvalue.txt");
    expect(git(destination, "config", "--get", "remote.origin.url"))
      .toBe("DISABLED_BY_OPENTHROTTLE_INSPECT");
    expect(statSync(join(destination, "value.txt")).mode & 0o222).toBe(0);
    expect(verifyActionRepository(view)).toMatchObject({
      input_subject: source.afterTree,
      output_subject: source.afterTree,
      changed_paths: [],
    });
    expect(git(destination, "rev-list", "--parents", "-n", "1", "HEAD").split(" "))
      .toHaveLength(2);
    expect(gitSucceeds(destination, "cat-file", "-e", `${source.after}^{commit}`)).toBe(false);
  });

  it("writes a bounded executor-owned artifact for the exact accepted-edit boundary", () => {
    const source = sourceRepository();
    const actionDirectory = mkdtempSync(join(tmpdir(), "ot-kernel-inspect-context-"));
    const destination = join(actionDirectory, "repository");
    const view = materializeActionRepository({
      sourceRepoDir: source.repo,
      inputSubject: source.after,
      repositoryAuthority: "inspect",
      destination,
      changeBoundary: {
        checkpoint_id: "checkpoint-1",
        input_subject: source.before,
        output_subject: source.after,
      },
    });
    const before = verifyActionRepository(view);
    const descriptor = materializeInspectChangeArtifact({
      view,
      destination: join(actionDirectory, "inspect-context", "change.json"),
    });
    const artifact = JSON.parse(readFileSync(descriptor.path, "utf8"));

    expect(artifact).toMatchObject({
      schema: INSPECT_CHANGE_CONTEXT_SCHEMA,
      checkpoint_id: "checkpoint-1",
      base_subject: source.before,
      input_subject: source.after,
      base_tree: source.beforeTree,
      input_tree: source.afterTree,
      changed_paths: ["new.txt", "value.txt"],
      omissions: [],
    });
    expect(artifact.textual_diff).toContain("diff --git a/new.txt b/new.txt");
    expect(artifact.textual_diff).toContain("-base");
    expect(artifact.textual_diff).toContain("+changed");
    expect(statSync(descriptor.path).mode & 0o777).toBe(0o444);
    expect(descriptor.bytes).toBeLessThanOrEqual(INSPECT_CHANGE_ARTIFACT_MAX_BYTES);
    expect(verifyActionRepository(view)).toEqual(before);
  });

  it("omits an oversized textual diff with an explicit bounded diagnostic", () => {
    const source = sourceRepository();
    writeFileSync(join(source.repo, "large.txt"), `${"0123456789abcdef".repeat(32_000)}\n`);
    git(source.repo, "add", ".");
    git(source.repo, "commit", "--quiet", "-m", "large");
    const largeAfter = git(source.repo, "rev-parse", "HEAD");
    const actionDirectory = mkdtempSync(join(tmpdir(), "ot-kernel-inspect-large-"));
    const view = materializeActionRepository({
      sourceRepoDir: source.repo,
      inputSubject: largeAfter,
      repositoryAuthority: "inspect",
      destination: join(actionDirectory, "repository"),
      changeBoundary: {
        checkpoint_id: "checkpoint-large",
        input_subject: source.before,
        output_subject: largeAfter,
      },
    });
    const descriptor = materializeInspectChangeArtifact({
      view,
      destination: join(actionDirectory, "inspect-context", "change.json"),
    });
    const artifact = JSON.parse(readFileSync(descriptor.path, "utf8"));

    expect(artifact.changed_paths).toEqual(["large.txt", "new.txt", "value.txt"]);
    expect(artifact.textual_diff).toBeNull();
    expect(artifact.omissions).toContainEqual({
      section: "textual_diff",
      reason: "capture_limit_exceeded",
      limit_bytes: 256 * 1024,
    });
    expect(statSync(descriptor.path).size).toBeLessThanOrEqual(INSPECT_CHANGE_ARTIFACT_MAX_BYTES);
  });

  it("rejects a change boundary that only shares the input tree", () => {
    const source = sourceRepository();
    git(source.repo, "commit", "--quiet", "--allow-empty", "-m", "same tree");
    const commitWithSameTree = git(source.repo, "rev-parse", "HEAD");
    expect(() => materializeActionRepository({
      sourceRepoDir: source.repo,
      inputSubject: source.after,
      repositoryAuthority: "inspect",
      destination: join(mkdtempSync(join(tmpdir(), "ot-kernel-inspect-mismatch-")), "repository"),
      changeBoundary: {
        checkpoint_id: "checkpoint-1",
        input_subject: source.before,
        output_subject: commitWithSameTree,
      },
    })).toThrow("exact action input subject");
  });

  it("rejects a bare tree as an action input subject", () => {
    const source = sourceRepository();
    expect(() => materializeActionRepository({
      sourceRepoDir: source.repo,
      inputSubject: source.afterTree,
      repositoryAuthority: "inspect",
      destination: join(mkdtempSync(join(tmpdir(), "ot-kernel-tree-input-")), "repository"),
    })).toThrow("action input subject must name a commit");
  });

  it("lets edit actions change content while Git administration stays executor-owned", () => {
    const source = sourceRepository();
    const destination = join(mkdtempSync(join(tmpdir(), "ot-kernel-edit-")), "repository");
    const view = materializeActionRepository({
      sourceRepoDir: source.repo,
      inputSubject: source.before,
      repositoryAuthority: "edit",
      destination,
    });

    writeFileSync(join(destination, "value.txt"), "implemented\n");
    writeFileSync(join(destination, "added.txt"), "added\n");
    expect(statSync(join(destination, ".git")).mode & 0o222).toBe(0);
    expect(verifyActionRepository(view)).toMatchObject({
      input_subject: source.beforeTree,
      output_subject: expect.stringMatching(/^[a-f0-9]{40,64}$/),
      changed_paths: ["added.txt", "value.txt"],
    });
    expect(gitSucceeds(destination, "cat-file", "-e", `${source.before}^{commit}`)).toBe(false);
  });
});
