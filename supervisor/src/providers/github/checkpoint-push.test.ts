import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pushRepositoryCheckpoint } from "./checkpoint-push.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("GitHub checkpoint push", () => {
  it("imports an incremental bundle and advances the exact remote head idempotently", async () => {
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
    execFileSync("git", ["update-ref", "refs/openthrottle/checkpoints/test", integrated], { cwd: work });
    execFileSync("git", [
      "bundle", "create", bundle, "refs/openthrottle/checkpoints/test", `^${base}`,
    ], { cwd: work });
    const payload = readFileSync(bundle);
    const input = {
      repository: "owner/repo",
      ref: "refs/heads/ot/test",
      expectedOldSha: base,
      expectedNewSha: integrated,
      allowAlreadyAdvanced: false,
      checkpointObject: {
        payload,
        payloadBytes: payload.byteLength,
        payloadSha256: createHash("sha256").update(payload).digest("hex"),
      },
    };

    await expect(pushRepositoryCheckpoint({ token: "test-token", remoteUrl: remote }, input))
      .resolves.toEqual({ sha: integrated });
    expect(execFileSync("git", ["rev-parse", "refs/heads/ot/test"], {
      cwd: remote, encoding: "utf8",
    }).trim()).toBe(integrated);
    await expect(pushRepositoryCheckpoint(
      { token: "test-token", remoteUrl: remote }, { ...input, allowAlreadyAdvanced: true }
    )).resolves.toEqual({ sha: integrated });
  });
});
