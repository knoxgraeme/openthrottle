import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pushRepositoryCheckpoint } from "./checkpoint-push.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createBoundedBundle(work: string, path: string, ref: string, boundary: string): void {
  writeFileSync(join(work, ".git", "shallow"), `${boundary}\n`);
  execFileSync("git", ["bundle", "create", path, ref], { cwd: work });
}

describe("GitHub checkpoint push", () => {
  it("imports a shallow-bound bundle and advances the exact remote head idempotently", async () => {
    const root = mkdtempSync(join(tmpdir(), "ot-checkpoint-push-test-"));
    directories.push(root);
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    const bundle = join(root, "checkpoint.bundle");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    execFileSync("git", ["init", "-q", "-b", "main", work]);
    execFileSync("git", ["config", "user.name", "Test"], { cwd: work });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: work });
    writeFileSync(join(work, "file.txt"), "base\n");
    execFileSync("git", ["add", "."], { cwd: work });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: work });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
    execFileSync("git", ["push", "-q", remote, "HEAD:refs/heads/ot/test"], { cwd: work });
    writeFileSync(join(work, "file.txt"), "integrated\n");
    execFileSync("git", ["commit", "-qam", "integrated"], { cwd: work });
    const integrated = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
    const integratedTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: work,
      encoding: "utf8",
    }).trim();
    const checkpointRef = `refs/openthrottle/checkpoints/${"a".repeat(64)}`;
    execFileSync("git", ["update-ref", checkpointRef, integrated], { cwd: work });
    createBoundedBundle(work, bundle, checkpointRef, base);
    const payload = readFileSync(bundle);
    const input = {
      repository: "owner/repo",
      ref: "refs/heads/ot/test",
      mode: "update" as const,
      expectedOldSha: base,
      expectedNewSha: integrated,
      checkpointBaseSha: base,
      allowAlreadyAdvanced: false,
      checkpointObject: {
        payload,
        payloadBytes: payload.byteLength,
        payloadSha256: createHash("sha256").update(payload).digest("hex"),
        expectedTreeSha: integratedTree,
      },
    };

    await expect(pushRepositoryCheckpoint({ token: "test-token", remoteUrl: remote }, {
      ...input,
      checkpointObject: { ...input.checkpointObject, expectedTreeSha: "f".repeat(40) },
    })).rejects.toMatchObject({ name: "RepositoryRefConflictError", retryable: false });
    expect(execFileSync("git", ["rev-parse", "refs/heads/ot/test"], {
      cwd: remote, encoding: "utf8",
    }).trim()).toBe(base);

    const hooks = join(root, "ambient-hooks");
    const marker = join(root, "ambient-pre-push-ran");
    mkdirSync(hooks);
    const prePush = join(hooks, "pre-push");
    writeFileSync(prePush, `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`);
    chmodSync(prePush, 0o700);
    const ambientKeys = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
    const original = new Map(ambientKeys.map((key) => [key, process.env[key]]));
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
    process.env.GIT_CONFIG_VALUE_0 = hooks;
    try {
      await expect(pushRepositoryCheckpoint({ token: "test-token", remoteUrl: remote }, input))
        .resolves.toEqual({ sha: integrated });
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(existsSync(marker)).toBe(false);
    expect(execFileSync("git", ["rev-parse", "refs/heads/ot/test"], {
      cwd: remote, encoding: "utf8",
    }).trim()).toBe(integrated);
    await expect(pushRepositoryCheckpoint(
      { token: "test-token", remoteUrl: remote }, { ...input, allowAlreadyAdvanced: true }
    )).resolves.toEqual({ sha: integrated });
  }, 15_000);

  it("rejects a non-descendant bundle as a permanent ref conflict", async () => {
    const root = mkdtempSync(join(tmpdir(), "ot-checkpoint-push-conflict-"));
    directories.push(root);
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    const bundle = join(root, "checkpoint.bundle");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    execFileSync("git", ["init", "-q", "-b", "main", work]);
    execFileSync("git", ["config", "user.name", "Test"], { cwd: work });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: work });
    writeFileSync(join(work, "file.txt"), "base\n");
    execFileSync("git", ["add", "."], { cwd: work });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: work });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
    execFileSync("git", ["push", "-q", remote, "HEAD:refs/heads/ot/test"], { cwd: work });
    execFileSync("git", ["checkout", "-q", "--orphan", "unrelated"], { cwd: work });
    execFileSync("git", ["rm", "-q", "-rf", "."], { cwd: work });
    writeFileSync(join(work, "file.txt"), "unrelated\n");
    execFileSync("git", ["add", "."], { cwd: work });
    execFileSync("git", ["commit", "-qm", "unrelated"], { cwd: work });
    const unrelated = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
    const unrelatedTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: work,
      encoding: "utf8",
    }).trim();
    const checkpointRef = `refs/openthrottle/checkpoints/${"b".repeat(64)}`;
    execFileSync("git", ["update-ref", checkpointRef, unrelated], { cwd: work });
    createBoundedBundle(work, bundle, checkpointRef, base);
    const payload = readFileSync(bundle);

    await expect(pushRepositoryCheckpoint({ token: "test-token", remoteUrl: remote }, {
      repository: "owner/repo",
      ref: "refs/heads/ot/test",
      mode: "update",
      expectedOldSha: base,
      expectedNewSha: unrelated,
      checkpointBaseSha: base,
      allowAlreadyAdvanced: false,
      checkpointObject: {
        payload,
        payloadBytes: payload.byteLength,
        payloadSha256: createHash("sha256").update(payload).digest("hex"),
        expectedTreeSha: unrelatedTree,
      },
    })).rejects.toMatchObject({ name: "RepositoryRefConflictError", retryable: false });
    expect(execFileSync("git", ["rev-parse", "refs/heads/ot/test"], {
      cwd: remote, encoding: "utf8",
    }).trim()).toBe(base);
  });

  it("rejects an orphan bundle before first task-ref creation and leaves the ref absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "ot-checkpoint-push-create-conflict-"));
    directories.push(root);
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    const bundle = join(root, "checkpoint.bundle");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    execFileSync("git", ["init", "-q", "-b", "main", work]);
    execFileSync("git", ["config", "user.name", "Test"], { cwd: work });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: work });
    writeFileSync(join(work, "file.txt"), "base\n");
    execFileSync("git", ["add", "."], { cwd: work });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: work });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
    execFileSync("git", ["push", "-q", remote, "HEAD:refs/heads/main"], { cwd: work });
    execFileSync("git", ["checkout", "-q", "--orphan", "unrelated"], { cwd: work });
    execFileSync("git", ["rm", "-q", "-rf", "."], { cwd: work });
    writeFileSync(join(work, "file.txt"), "unrelated\n");
    execFileSync("git", ["add", "."], { cwd: work });
    execFileSync("git", ["commit", "-qm", "unrelated"], { cwd: work });
    const unrelated = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
    const unrelatedTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: work,
      encoding: "utf8",
    }).trim();
    const checkpointRef = `refs/openthrottle/checkpoints/${"c".repeat(64)}`;
    execFileSync("git", ["update-ref", checkpointRef, unrelated], { cwd: work });
    execFileSync("git", ["bundle", "create", bundle, checkpointRef], { cwd: work });
    const payload = readFileSync(bundle);

    await expect(pushRepositoryCheckpoint({ token: "test-token", remoteUrl: remote }, {
      repository: "owner/repo",
      ref: "refs/heads/ot/first",
      mode: "create",
      expectedOldSha: base,
      expectedNewSha: unrelated,
      checkpointBaseSha: base,
      allowAlreadyAdvanced: false,
      checkpointObject: {
        payload,
        payloadBytes: payload.byteLength,
        payloadSha256: createHash("sha256").update(payload).digest("hex"),
        expectedTreeSha: unrelatedTree,
      },
    })).rejects.toMatchObject({ name: "RepositoryRefConflictError", retryable: false });
    expect(() => execFileSync("git", ["show-ref", "--verify", "refs/heads/ot/first"], {
      cwd: remote,
      stdio: "pipe",
    })).toThrow();
  });

  it("creates a first task ref only from a connected bundle", async () => {
    const root = mkdtempSync(join(tmpdir(), "ot-checkpoint-push-create-"));
    directories.push(root);
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    const bundle = join(root, "checkpoint.bundle");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    execFileSync("git", ["init", "-q", "-b", "main", work]);
    execFileSync("git", ["config", "user.name", "Test"], { cwd: work });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: work });
    writeFileSync(join(work, "file.txt"), "base\n");
    execFileSync("git", ["add", "."], { cwd: work });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: work });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
    execFileSync("git", ["push", "-q", remote, "HEAD:refs/heads/main"], { cwd: work });
    writeFileSync(join(work, "file.txt"), "connected\n");
    execFileSync("git", ["commit", "-qam", "connected"], { cwd: work });
    const connected = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
    const connectedTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: work,
      encoding: "utf8",
    }).trim();
    const checkpointRef = `refs/openthrottle/checkpoints/${"d".repeat(64)}`;
    execFileSync("git", ["update-ref", checkpointRef, connected], { cwd: work });
    createBoundedBundle(work, bundle, checkpointRef, base);
    const payload = readFileSync(bundle);

    await expect(pushRepositoryCheckpoint({ token: "test-token", remoteUrl: remote }, {
      repository: "owner/repo",
      ref: "refs/heads/ot/first",
      mode: "create",
      expectedOldSha: base,
      expectedNewSha: connected,
      checkpointBaseSha: base,
      allowAlreadyAdvanced: false,
      checkpointObject: {
        payload,
        payloadBytes: payload.byteLength,
        payloadSha256: createHash("sha256").update(payload).digest("hex"),
        expectedTreeSha: connectedTree,
      },
    })).resolves.toEqual({ sha: connected });
    expect(execFileSync("git", ["rev-parse", "refs/heads/ot/first"], {
      cwd: remote,
      encoding: "utf8",
    }).trim()).toBe(connected);
  });

  it("publishes only a compacted child and leaves deleted private history unreachable", async () => {
    const root = mkdtempSync(join(tmpdir(), "ot-checkpoint-push-chain-"));
    directories.push(root);
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    const bundle = join(root, "checkpoint.bundle");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    execFileSync("git", ["init", "-q", "-b", "main", work]);
    execFileSync("git", ["config", "user.name", "Test"], { cwd: work });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: work });
    writeFileSync(join(work, "file.txt"), "base\n");
    execFileSync("git", ["add", "."], { cwd: work });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: work });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
    execFileSync("git", ["push", "-q", remote, "HEAD:refs/heads/main"], { cwd: work });

    writeFileSync(join(work, "secret.txt"), "publication must not retain this\n");
    execFileSync("git", ["add", "secret.txt"], { cwd: work });
    execFileSync("git", ["commit", "-qm", "private secret checkpoint"], { cwd: work });
    const privateCheckpoint = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: work,
      encoding: "utf8",
    }).trim();
    const secretBlob = execFileSync("git", ["rev-parse", "HEAD:secret.txt"], {
      cwd: work,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["rm", "-q", "secret.txt"], { cwd: work });
    writeFileSync(join(work, "file.txt"), "accepted final tree\n");
    execFileSync("git", ["commit", "-qam", "delete private secret"], { cwd: work });
    const finalTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: work,
      encoding: "utf8",
    }).trim();
    const published = execFileSync(
      "git",
      ["commit-tree", finalTree, "-p", base, "-m", "OpenThrottle publication checkpoint"],
      { cwd: work, encoding: "utf8" },
    ).trim();
    const checkpointRef = `refs/openthrottle/checkpoints/${"e".repeat(64)}`;
    execFileSync("git", ["update-ref", checkpointRef, published], { cwd: work });
    createBoundedBundle(work, bundle, checkpointRef, base);
    const payload = readFileSync(bundle);

    await expect(pushRepositoryCheckpoint({ token: "test-token", remoteUrl: remote }, {
      repository: "owner/repo",
      ref: "refs/heads/ot/first-chain",
      mode: "create",
      expectedOldSha: base,
      expectedNewSha: published,
      checkpointBaseSha: base,
      allowAlreadyAdvanced: false,
      checkpointObject: {
        payload,
        payloadBytes: payload.byteLength,
        payloadSha256: createHash("sha256").update(payload).digest("hex"),
        expectedTreeSha: finalTree,
      },
    })).resolves.toEqual({ sha: published });
    expect(execFileSync("git", ["rev-parse", "refs/heads/ot/first-chain"], {
      cwd: remote,
      encoding: "utf8",
    }).trim()).toBe(published);
    expect(() => execFileSync("git", ["cat-file", "-e", `${privateCheckpoint}^{commit}`], {
      cwd: remote,
      stdio: "pipe",
    })).toThrow();
    expect(() => execFileSync("git", ["cat-file", "-e", secretBlob], {
      cwd: remote,
      stdio: "pipe",
    })).toThrow();
  });

  it("accepts an identity checkpoint without requiring its commit to parent itself", async () => {
    const root = mkdtempSync(join(tmpdir(), "ot-checkpoint-push-identity-"));
    directories.push(root);
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    const bundle = join(root, "checkpoint.bundle");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    execFileSync("git", ["init", "-q", "-b", "main", work]);
    execFileSync("git", ["config", "user.name", "Test"], { cwd: work });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: work });
    writeFileSync(join(work, "file.txt"), "base\n");
    execFileSync("git", ["add", "."], { cwd: work });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: work });
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
    writeFileSync(join(work, "file.txt"), "already edited\n");
    execFileSync("git", ["commit", "-qam", "already edited"], { cwd: work });
    const identity = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: work,
      encoding: "utf8",
    }).trim();
    const identityTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: work,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["push", "-q", remote, "HEAD:refs/heads/ot/identity"], { cwd: work });
    const checkpointRef = `refs/openthrottle/checkpoints/${"f".repeat(64)}`;
    execFileSync("git", ["update-ref", checkpointRef, identity], { cwd: work });
    createBoundedBundle(work, bundle, checkpointRef, identity);
    const payload = readFileSync(bundle);

    await expect(pushRepositoryCheckpoint({ token: "test-token", remoteUrl: remote }, {
      repository: "owner/repo",
      ref: "refs/heads/ot/identity",
      mode: "update",
      expectedOldSha: identity,
      expectedNewSha: identity,
      checkpointBaseSha: identity,
      allowAlreadyAdvanced: false,
      checkpointObject: {
        payload,
        payloadBytes: payload.byteLength,
        payloadSha256: createHash("sha256").update(payload).digest("hex"),
        expectedTreeSha: identityTree,
      },
    })).resolves.toEqual({ sha: identity });
  });
});
