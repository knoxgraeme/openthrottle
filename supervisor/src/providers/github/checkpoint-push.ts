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
function isolatedGitEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("GIT_")) delete environment[key];
  }
  return {
    ...environment,
    ...extra,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

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
    mode: "create" | "update";
    expectedOldSha: string;
    expectedNewSha: string;
    /** Exact publication parent and bundle shallow cutoff. */
    checkpointBaseSha: string;
    allowAlreadyAdvanced: boolean;
    checkpointObject: GitCheckpointPayload & { expectedTreeSha: string };
  }
): Promise<{ sha: string }> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) || !REF.test(input.ref) ||
      !SHA.test(input.expectedOldSha) || !SHA.test(input.expectedNewSha) ||
      !SHA.test(input.checkpointBaseSha) ||
      (input.mode !== "create" && input.mode !== "update") ||
      input.expectedOldSha !== input.checkpointBaseSha) {
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
  if (!/^[a-f0-9]{40,64}$/.test(input.checkpointObject.expectedTreeSha)) {
    throw new Error("GitHub checkpoint push has an invalid accepted tree fence");
  }
  const scratch = mkdtempSync(join(tmpdir(), "openthrottle-checkpoint-"));
  const bundlePath = join(scratch, GIT_CHECKPOINT_OBJECT_FILE);
  const askpassPath = join(scratch, "askpass.sh");
  const remote = client.remoteUrl ?? `https://github.com/${input.repository}.git`;
  const env = isolatedGitEnvironment({
    OT_GITHUB_TOKEN: client.token,
    GIT_ASKPASS: askpassPath,
    GIT_TERMINAL_PROMPT: "0",
  });
  try {
    writeFileSync(bundlePath, payload, { mode: 0o400 });
    writeFileSync(askpassPath,
      "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s' x-access-token ;; *) printf '%s' \"$OT_GITHUB_TOKEN\" ;; esac\n",
      { mode: 0o700 });
    chmodSync(askpassPath, 0o700);
    await runGit(scratch, ["init", "--bare", "repository.git"], env);
    const repo = join(scratch, "repository.git");
    const remoteHead = (await runGit(repo, ["ls-remote", remote, input.ref], env)).split(/\s+/)[0] ?? "";
    const identity = input.expectedOldSha === input.expectedNewSha;
    const alreadyAdvanced = remoteHead === input.expectedNewSha &&
      (input.allowAlreadyAdvanced || identity);
    const creating = input.mode === "create" && remoteHead === "";
    const updating = input.mode === "update" && remoteHead === input.expectedOldSha;
    if (!alreadyAdvanced && !creating && !updating) {
      throw new RepositoryRefConflictError(
        `repository ref conflict: ${input.ref} expected ${input.expectedOldSha} but found ${remoteHead || "missing"}`
      );
    }
    if (updating || alreadyAdvanced && input.mode === "update") {
      await runGit(repo, ["fetch", "--no-tags", remote, `${input.ref}:refs/checkpoint/remote`], env);
    }
    writeFileSync(join(repo, "shallow"), `${input.checkpointBaseSha}\n`, { mode: 0o600 });
    const heads = (await runGit(repo, ["bundle", "list-heads", bundlePath], env)).split("\n").filter(Boolean);
    if (heads.length !== 1) throw new Error("git checkpoint bundle must advertise exactly one head");
    const [bundleHead, bundleRef, ...extra] = heads[0]!.trim().split(/\s+/);
    if (
      extra.length !== 0 ||
      bundleHead !== input.expectedNewSha ||
      !/^refs\/openthrottle\/(?:checkpoints|integrations)\/[a-f0-9]{64}$/.test(bundleRef ?? "")
    ) {
      throw new Error("git checkpoint bundle does not advertise the accepted integration");
    }
    await runGit(repo, ["bundle", "verify", bundlePath], env);
    await runGit(repo, ["fetch", "--no-tags", bundlePath, `${bundleRef}:refs/checkpoint/accepted`], env);
    await runGit(repo, ["cat-file", "-e", `${input.expectedNewSha}^{commit}`], env);
    const acceptedTree = await runGit(repo, ["rev-parse", `${input.expectedNewSha}^{tree}`], env);
    if (acceptedTree !== input.checkpointObject.expectedTreeSha) {
      throw new RepositoryRefConflictError(
        `repository ref conflict: ${input.expectedNewSha} does not contain the accepted tree`
      );
    }
    if (!identity) {
      const revision = (await runGit(repo, ["rev-list", "--parents", "-n", "1", input.expectedNewSha], env))
        .split(/\s+/).filter(Boolean);
      const commit = revision.shift();
      if (
        commit !== input.expectedNewSha || revision.length !== 1 ||
        revision[0] !== input.expectedOldSha
      ) {
        throw new RepositoryRefConflictError(
          `repository ref conflict: ${input.expectedNewSha} does not have ${input.expectedOldSha} as its exact sole parent`
        );
      }
    }
    if (alreadyAdvanced) return { sha: remoteHead };
    await runGit(repo, [
      "push", "--porcelain", `--force-with-lease=${input.ref}:${creating ? "" : input.expectedOldSha}`,
      remote, `${input.expectedNewSha}:${input.ref}`,
    ], env);
    const verified = (await runGit(repo, ["ls-remote", remote, input.ref], env)).split(/\s+/)[0] ?? "";
    if (verified !== input.expectedNewSha) throw new Error("git checkpoint push did not verify the exact remote head");
    return { sha: verified };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
