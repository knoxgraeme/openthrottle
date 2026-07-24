import {
  chownSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { canonicalJson } from "./capabilities.mjs";
import { digest, sanitizeArtifactText } from "./artifacts.mjs";
import { runCapturedProcess } from "./bounded-process.mjs";

const COMMIT = /^[a-f0-9]{40}$/;
const LOCAL_GIT_TIMEOUT_MS = 120_000;
const REPOSITORY_CONTROL_TIMEOUT_MS = 30_000;
const REPOSITORY_CONTROL_HELPER = fileURLToPath(new URL("./repository-control-helper.mjs", import.meta.url));
const GIT_OPERATION_STATE = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "AUTO_MERGE",
  "rebase-apply",
  "rebase-merge",
  "sequencer",
  "BISECT_START",
];

function commit(value, label) {
  if (typeof value !== "string" || !COMMIT.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function gitOutput(result, args, timeoutMs) {
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`);
  }
  if (result.error) {
    throw new Error(`git ${args.join(" ")} failed: ${sanitizeArtifactText(result.error.message).slice(-1_000)}`);
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${sanitizeArtifactText(result.stderr ?? "").slice(-1_000)}`);
  }
  return result.stdout.trim();
}

function runGit(repoDir, args, env = {}, { timeoutMs = LOCAL_GIT_TIMEOUT_MS } = {}) {
  const result = runCapturedProcess("git", ["-c", `safe.directory=${repoDir}`, ...args], {
    cwd: repoDir,
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
    timeout: timeoutMs,
    captureBytes: 8 * 1024 * 1024,
  });
  return gitOutput(result, args, timeoutMs);
}

export function runGitAsRepositoryOwner(repoDir, args, env = {}, { timeoutMs = LOCAL_GIT_TIMEOUT_MS } = {}) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    return runGit(repoDir, args, env, { timeoutMs });
  }
  if (!existsSync("/usr/local/bin/gosu")) {
    throw new Error("repository control requires the installed gosu privilege boundary");
  }
  const result = runCapturedProcess("/usr/local/bin/gosu", [
    "agent", "git", "-c", `safe.directory=${repoDir}`, ...args,
  ], {
    cwd: repoDir,
    env: {
      ...process.env,
      ...env,
      HOME: "/home/agent",
      USER: "agent",
      GIT_TERMINAL_PROMPT: "0",
    },
    timeout: timeoutMs,
    captureBytes: 8 * 1024 * 1024,
  });
  return gitOutput(result, args, timeoutMs);
}

function optionalRepositoryOwnerGit(repoDir, args) {
  try {
    return runGitAsRepositoryOwner(repoDir, args);
  } catch {
    return null;
  }
}

let installedAgentIdentity;

function prepareRepositoryOwnerDirectory(path) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  if (!installedAgentIdentity) {
    const uid = spawnSync("id", ["-u", "agent"], { encoding: "utf8" });
    const gid = spawnSync("id", ["-g", "agent"], { encoding: "utf8" });
    if (uid.status !== 0 || gid.status !== 0 || !/^\d+\n?$/.test(uid.stdout) || !/^\d+\n?$/.test(gid.stdout)) {
      throw new Error("repository control could not resolve the installed agent identity");
    }
    installedAgentIdentity = { uid: Number(uid.stdout.trim()), gid: Number(gid.stdout.trim()) };
  }
  chownSync(path, installedAgentIdentity.uid, installedAgentIdentity.gid);
  chmodSync(path, 0o700);
}

export function computeWorkspaceTreeOidFromTree(repoDir, baseTree) {
  const temporary = mkdtempSync(join(tmpdir(), "ot-stage-index-"));
  const indexPath = join(temporary, "index");
  try {
    prepareRepositoryOwnerDirectory(temporary);
    const env = { GIT_INDEX_FILE: indexPath };
    runGitAsRepositoryOwner(repoDir, ["read-tree", baseTree], env);
    runGitAsRepositoryOwner(repoDir, ["add", "-A", "--", "."], env);
    return commit(runGitAsRepositoryOwner(repoDir, ["write-tree"], env), "workspace tree");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

// Canonical workspace subject: tracked files plus non-ignored untracked files,
// with Git's native blob/tree hashing and executable/symlink modes. A private
// temporary index means the agent-controlled index is never consulted.
export function computeWorkspaceTreeOid(repoDir) {
  return computeWorkspaceTreeOidFromTree(repoDir, "HEAD");
}

function fileModeAt(path) {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile()) throw new Error(`${path} must be a regular file`);
    return metadata.mode & 0o777;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function bufferAt(path) {
  try {
    return readFileSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function bufferSignature(value, mode) {
  return value === null
    ? { exists: false, type: null, size: 0, digest: null, mode: null }
    : { exists: true, type: "file", size: value.length, digest: digest(value), mode };
}

function captureRepositoryRefs(repoDir) {
  const output = runGitAsRepositoryOwner(repoDir, ["for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)"]);
  if (!output) return [];
  return output.split("\n").map((line) => {
    const [name, oid, symbolicTarget = ""] = line.split("\t");
    if (!name?.startsWith("refs/") || /[\u0000-\u0020\u007f]/.test(name)) {
      throw new Error("repository contains an invalid ref name");
    }
    commit(oid, `object for ${name}`);
    if (symbolicTarget && (!symbolicTarget.startsWith("refs/") || /[\u0000-\u0020\u007f]/.test(symbolicTarget))) {
      throw new Error(`repository contains an invalid symbolic ref target for ${name}`);
    }
    return { name, oid, symbolicTarget: symbolicTarget || null };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

function repositoryOwnerControl(operation, snapshot) {
  const input = {
    operation,
    headPath: snapshot.headPath,
    indexPath: snapshot.indexPath,
    operationPaths: snapshot.operationPaths,
    ...(operation === "restore" ? {
      head: snapshot.head.toString("base64"),
      headMode: snapshot.headMode,
      index: snapshot.index === null ? null : snapshot.index.toString("base64"),
      indexMode: snapshot.indexMode,
    } : {}),
  };
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  if (root && !existsSync("/usr/local/bin/gosu")) {
    throw new Error("repository control requires the installed gosu privilege boundary");
  }
  const command = root ? "/usr/local/bin/gosu" : process.execPath;
  const args = root
    ? ["agent", "env", "HOME=/home/agent", "USER=agent", "node", REPOSITORY_CONTROL_HELPER]
    : [REPOSITORY_CONTROL_HELPER];
  const result = runCapturedProcess(command, args, {
    cwd: dirname(REPOSITORY_CONTROL_HELPER),
    input: JSON.stringify(input),
    timeout: REPOSITORY_CONTROL_TIMEOUT_MS,
    captureBytes: 1024 * 1024,
  });
  if (result.error?.code === "ETIMEDOUT") throw new Error("repository control restoration timed out");
  if (result.error || result.status !== 0) {
    throw new Error(`repository control restoration failed: ${sanitizeArtifactText(result.stderr ?? result.error?.message ?? "").slice(-800)}`);
  }
  return JSON.parse(result.stdout);
}

export function captureRepositoryControl(repoDir) {
  const gitDir = runGitAsRepositoryOwner(repoDir, ["rev-parse", "--absolute-git-dir"]);
  // The disposable fresh-review checkout is copied without preserved stat
  // metadata, so every index entry starts stat-stale and the stage's first
  // read-only `git status` would rewrite .git/index. Settle the stat cache
  // before snapshotting the bytes so read-only git commands leave them stable.
  runGitAsRepositoryOwner(repoDir, ["status", "--porcelain"]);
  const headPath = join(gitDir, "HEAD");
  const indexPath = join(gitDir, "index");
  const headMode = fileModeAt(headPath);
  const indexMode = fileModeAt(indexPath);
  const head = readFileSync(headPath);
  const index = bufferAt(indexPath);
  const snapshot = {
    headPath,
    indexPath,
    head,
    headMode,
    headSignature: bufferSignature(head, headMode),
    headOid: commit(runGitAsRepositoryOwner(repoDir, ["rev-parse", "HEAD"]), "HEAD"),
    symbolicRef: optionalRepositoryOwnerGit(repoDir, ["symbolic-ref", "-q", "HEAD"]),
    index,
    indexMode,
    indexSignature: bufferSignature(index, indexMode),
    stagedEntries: runGitAsRepositoryOwner(repoDir, ["ls-files", "-s"]),
    refs: captureRepositoryRefs(repoDir),
    operationPaths: GIT_OPERATION_STATE.map((name) => join(gitDir, name)),
  };
  const inspected = repositoryOwnerControl("inspect", snapshot);
  if (inspected.operationState.some((entry) => entry.exists)) {
    throw new Error("fresh-review stages require a clean Git operation state");
  }
  snapshot.operationState = inspected.operationState;
  return snapshot;
}

// Git rewrites .git/index during nominally read-only commands whenever cached
// stat data goes stale, so index bytes alone cannot prove an agent mutation.
// A byte mismatch is benign exactly when the staged entries (mode, object,
// stage, path) are unchanged; anything staged, unstaged, or swapped changes
// `git ls-files -s` and still fails.
function indexMatches(repoDir, currentSignature, snapshot) {
  if (canonicalJson(currentSignature) === canonicalJson(snapshot.indexSignature)) return true;
  if (typeof snapshot.stagedEntries !== "string") return false;
  if (!currentSignature.exists || !snapshot.indexSignature.exists) return false;
  if (currentSignature.type !== "file" || currentSignature.mode !== snapshot.indexSignature.mode) return false;
  return runGitAsRepositoryOwner(repoDir, ["ls-files", "-s"]) === snapshot.stagedEntries;
}

export function repositoryControlMatches(repoDir, snapshot) {
  const control = repositoryOwnerControl("inspect", snapshot);
  return canonicalJson(control.head) === canonicalJson(snapshot.headSignature) &&
    indexMatches(repoDir, control.index, snapshot) &&
    canonicalJson(control.operationState) === canonicalJson(snapshot.operationState) &&
    optionalRepositoryOwnerGit(repoDir, ["rev-parse", "HEAD"]) === snapshot.headOid &&
    optionalRepositoryOwnerGit(repoDir, ["symbolic-ref", "-q", "HEAD"]) === snapshot.symbolicRef &&
    canonicalJson(captureRepositoryRefs(repoDir)) === canonicalJson(snapshot.refs);
}

function restoreRepositoryRefs(repoDir, expectedRefs) {
  const currentRefs = captureRepositoryRefs(repoDir);
  const expected = new Map(expectedRefs.map((ref) => [ref.name, ref]));
  for (const ref of currentRefs) {
    if (!expected.has(ref.name)) {
      runGitAsRepositoryOwner(repoDir, ["update-ref", "--no-deref", "-d", ref.name]);
    }
  }
  const current = new Map(currentRefs.map((ref) => [ref.name, ref]));
  for (const ref of expectedRefs) {
    if (canonicalJson(current.get(ref.name) ?? null) === canonicalJson(ref)) continue;
    if (ref.symbolicTarget) {
      runGitAsRepositoryOwner(repoDir, ["symbolic-ref", ref.name, ref.symbolicTarget]);
    } else {
      runGitAsRepositoryOwner(repoDir, ["update-ref", "--no-deref", ref.name, ref.oid]);
    }
  }
}

export function restoreReadOnlyRepository(repoDir, postSubject, preSubject, control) {
  const temporary = mkdtempSync(join(tmpdir(), "ot-stage-restore-"));
  const indexPath = join(temporary, "index");
  try {
    prepareRepositoryOwnerDirectory(temporary);
    const env = { GIT_INDEX_FILE: indexPath };
    runGitAsRepositoryOwner(repoDir, ["read-tree", postSubject], env);
    runGitAsRepositoryOwner(repoDir, ["read-tree", "--reset", "-u", preSubject], env);
    restoreRepositoryRefs(repoDir, control.refs);
    repositoryOwnerControl("restore", control);
    const restoredSubject = computeWorkspaceTreeOidFromTree(repoDir, preSubject);
    if (restoredSubject !== preSubject) {
      throw new Error("fresh-review workspace restoration did not recover the fenced subject");
    }
    if (!repositoryControlMatches(repoDir, control)) {
      throw new Error("fresh-review repository control restoration did not recover HEAD, ref, and index");
    }
    return restoredSubject;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
