import { statSync } from "node:fs";
import { join } from "node:path";
import { runCapturedProcess } from "./bounded-process.mjs";
import { sanitizeArtifactText } from "./kernel-json.mjs";

const GIT_TIMEOUT_MS = 120_000;
const MAX_UNTRACKED_PATH_BYTES = 8 * 1024 * 1024;

function gitResult(result, args) {
  if (result.error?.code === "ETIMEDOUT") throw new Error(`git ${args.join(" ")} timed out`);
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${sanitizeArtifactText(result.stderr || result.error?.message || "").slice(-1_000)}`);
  }
  return result.stdout.trim();
}
export function runGitAsExecutor(repoDir, args, env = {}, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const result = runCapturedProcess("git", ["-c", `safe.directory=${repoDir}`, ...args], {
    cwd: repoDir,
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
    timeout: timeoutMs,
    captureBytes: 8 * 1024 * 1024,
  });
  return gitResult(result, args);
}

// Stages content into an executor-private index/object directory. The action's
// own index and refs are never consulted or mutated.
export function stageCanonicalWorkspaceIndex(repoDir, env, { scratchDir }) {
  const sparse = runGitAsExecutor(repoDir, [
    "config", "--bool", "--default=false", "--get", "core.sparseCheckout",
  ], env);
  if (sparse === "true") throw new Error("kernel action requires a full non-sparse repository view");
  const untracked = runGitAsExecutor(repoDir, [
    "-c", "core.excludesFile=/dev/null",
    "ls-files", "--others", "--exclude-per-directory=.gitignore", "-z", "--",
  ], env);
  if (Buffer.byteLength(untracked, "utf8") > MAX_UNTRACKED_PATH_BYTES) {
    throw new Error(`repository untracked path evidence exceeds ${MAX_UNTRACKED_PATH_BYTES} bytes`);
  }
  // Ensure the caller really supplied a private index beneath its scratch
  // directory; this catches accidental writes to the sealed repository index.
  if (typeof env.GIT_INDEX_FILE !== "string" || !env.GIT_INDEX_FILE.startsWith(`${scratchDir}/`)) {
    throw new Error("canonical staging requires an executor-private Git index");
  }
  runGitAsExecutor(repoDir, [
    "-c", "core.fileMode=true",
    "-c", "core.ignoreCase=false",
    "-c", "core.symlinks=true",
    "-c", "core.excludesFile=/dev/null",
    "add", "-A", "--", ".",
  ], env);
  statSync(env.GIT_INDEX_FILE);
}
