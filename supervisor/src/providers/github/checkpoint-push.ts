import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { RepositoryRefConflictError } from "../../app/ports.js";
import {
  GIT_CHECKPOINT_OBJECT_FILE,
  MAX_GIT_CHECKPOINT_OBJECT_BYTES,
  type GitCheckpointPayload,
} from "../../pipeline/checkpoint-object.js";

const SHA = /^[a-f0-9]{40}$/;
const REF = /^refs\/heads\/(?!.*\.\.)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;

function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, output = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(output.trim());
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 8 * 1024 * 1024) {
        child.kill("SIGKILL");
        finish(new Error("git checkpoint transport exceeded its output bound"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(undefined, Buffer.concat(stdout).toString("utf8"));
        return;
      }
      const token = env.OT_GITHUB_TOKEN;
      const raw = Buffer.concat(stderr).toString("utf8") ||
        `git checkpoint command exited ${code ?? signal ?? "unknown"}`;
      const detail = (token ? raw.replaceAll(token, "[REDACTED]") : raw).slice(-1_000);
      finish(new Error(`git checkpoint transport failed: ${detail}`));
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("git checkpoint transport timed out after 120000ms"));
    }, 120_000);
    timeout.unref();
  });
}

export async function pushRepositoryCheckpoint(
  client: { token: string; remoteUrl?: string },
  input: {
    repository: string;
    ref: string;
    expectedOldSha: string;
    expectedNewSha: string;
    allowAlreadyAdvanced: boolean;
    checkpointObject: GitCheckpointPayload;
  }
): Promise<{ sha: string }> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) || !REF.test(input.ref) ||
      !SHA.test(input.expectedOldSha) || !SHA.test(input.expectedNewSha) ||
      input.expectedOldSha === input.expectedNewSha) {
    throw new Error("GitHub checkpoint push has an invalid repository or ref fence");
  }
  const source = input.checkpointObject.payload;
  const payload = Buffer.isBuffer(source)
    ? source
    : Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  if (input.checkpointObject.payloadBytes !== payload.byteLength || payload.byteLength < 1 ||
      payload.byteLength > MAX_GIT_CHECKPOINT_OBJECT_BYTES ||
      createHash("sha256").update(payload).digest("hex") !== input.checkpointObject.payloadSha256) {
    throw new Error("GitHub checkpoint push has an invalid bounded object payload");
  }
  const scratch = mkdtempSync(join(tmpdir(), "openthrottle-checkpoint-"));
  const bundlePath = join(scratch, GIT_CHECKPOINT_OBJECT_FILE);
  const askpassPath = join(scratch, "askpass.sh");
  const remote = client.remoteUrl ?? `https://github.com/${input.repository}.git`;
  const env = {
    ...process.env,
    OT_GITHUB_TOKEN: client.token,
    GIT_ASKPASS: askpassPath,
    GIT_TERMINAL_PROMPT: "0",
  };
  try {
    writeFileSync(bundlePath, payload, { mode: 0o400 });
    writeFileSync(askpassPath,
      "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s' x-access-token ;; *) printf '%s' \"$OT_GITHUB_TOKEN\" ;; esac\n",
      { mode: 0o700 });
    chmodSync(askpassPath, 0o700);
    await runGit(scratch, ["init", "--bare", "repository.git"], env);
    const repo = join(scratch, "repository.git");
    const remoteHead = (await runGit(repo, ["ls-remote", remote, input.ref], env)).split(/\s+/)[0] ?? "";
    if (remoteHead === input.expectedNewSha && input.allowAlreadyAdvanced) return { sha: remoteHead };
    if (remoteHead !== input.expectedOldSha) {
      throw new RepositoryRefConflictError(
        `repository ref conflict: ${input.ref} expected ${input.expectedOldSha} but found ${remoteHead || "missing"}`
      );
    }
    await runGit(repo, ["fetch", "--no-tags", remote, `${input.ref}:refs/checkpoint/remote`], env);
    const heads = (await runGit(repo, ["bundle", "list-heads", bundlePath], env)).split("\n").filter(Boolean);
    if (heads.length !== 1) throw new Error("git checkpoint bundle must advertise exactly one head");
    const [bundleHead, bundleRef] = heads[0]!.trim().split(/\s+/, 2);
    if (bundleHead !== input.expectedNewSha || !bundleRef?.startsWith("refs/openthrottle/checkpoints/")) {
      throw new Error("git checkpoint bundle does not advertise the accepted integration");
    }
    await runGit(repo, ["bundle", "verify", bundlePath], env);
    await runGit(repo, ["fetch", "--no-tags", bundlePath, `${bundleRef}:refs/checkpoint/accepted`], env);
    await runGit(repo, ["cat-file", "-e", `${input.expectedNewSha}^{commit}`], env);
    await runGit(repo, ["merge-base", "--is-ancestor", input.expectedOldSha, input.expectedNewSha], env);
    await runGit(repo, [
      "push", "--porcelain", `--force-with-lease=${input.ref}:${input.expectedOldSha}`,
      remote, `${input.expectedNewSha}:${input.ref}`,
    ], env);
    const verified = (await runGit(repo, ["ls-remote", remote, input.ref], env)).split(/\s+/)[0] ?? "";
    if (verified !== input.expectedNewSha) throw new Error("git checkpoint push did not verify the exact remote head");
    return { sha: verified };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
