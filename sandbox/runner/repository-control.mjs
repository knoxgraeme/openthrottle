import {
  chownSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  accessSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./capabilities.mjs";
import { digest, sanitizeArtifactText } from "./artifacts.mjs";
import { runCapturedProcess } from "./bounded-process.mjs";
import { identityForUser } from "./filesystem-isolation.mjs";

const COMMIT = /^[a-f0-9]{40}$/;
const LOCAL_GIT_TIMEOUT_MS = 120_000;
const REPOSITORY_CONTROL_TIMEOUT_MS = 30_000;
const MAX_VERIFIED_TUNE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CANONICAL_UNTRACKED_PATH_BYTES = 8 * 1024 * 1024;
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

export function runGitAsExecutor(repoDir, args, env = {}, { timeoutMs = LOCAL_GIT_TIMEOUT_MS } = {}) {
  return runGit(repoDir, args, env, { timeoutMs });
}

export function readGitBlobAsExecutor(repoDir, subject, path) {
  const revision = commit(subject, "tune verification subject");
  if (typeof path !== "string" ||
      !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+$/.test(path)) {
    throw new Error("tune verification path is invalid");
  }
  const object = `${revision}:${path}`;
  let size;
  try {
    size = Number(runGitAsExecutor(repoDir, ["cat-file", "-s", object]));
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_VERIFIED_TUNE_FILE_BYTES) {
    throw new Error(`tune verification file ${path} exceeds the executor size limit`);
  }
  const result = runCapturedProcess("git", [
    "-c", `safe.directory=${repoDir}`, "cat-file", "blob", object,
  ], {
    cwd: repoDir,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: REPOSITORY_CONTROL_TIMEOUT_MS,
    captureBytes: Math.max(1024, size + 1),
  });
  if (result.error || result.status !== 0) {
    throw new Error(`tune verification could not read ${path}`);
  }
  if (Buffer.byteLength(result.stdout, "utf8") !== size) {
    throw new Error(`tune verification file ${path} is not exact UTF-8 content`);
  }
  return result.stdout;
}

export function readGitFileEntryAsExecutor(repoDir, subject, path) {
  const revision = commit(subject, "tune verification subject");
  if (typeof path !== "string" ||
      !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+$/.test(path)) {
    throw new Error("tune verification path is invalid");
  }
  const listing = runGitAsExecutor(repoDir, ["-c", "core.quotepath=false", "ls-tree", revision, "--", path]);
  if (listing === "") return null;
  const match = /^(\d{6}) ([a-z]+) ([a-f0-9]{40,64})\t(.+)$/.exec(listing);
  if (!match || match[4] !== path) throw new Error(`tune verification could not resolve the exact tree entry for ${path}`);
  return {
    mode: match[1],
    type: match[2],
    content: match[2] === "blob" ? readGitBlobAsExecutor(repoDir, revision, path) : null,
  };
}

function ownerGit(asExecutor) {
  return asExecutor ? runGitAsExecutor : runGitAsRepositoryOwner;
}

function runRepositoryOwnerShell(repoDir, script, positionalArgs, env, asExecutor) {
  let command = "/bin/sh";
  let args = ["-c", script, "ot-canonical-stage", ...positionalArgs];
  const childEnv = { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" };
  if (!asExecutor && typeof process.getuid === "function" && process.getuid() === 0) {
    if (!existsSync("/usr/local/bin/gosu")) {
      throw new Error("repository control requires the installed gosu privilege boundary");
    }
    command = "/usr/local/bin/gosu";
    args = ["agent", "/bin/sh", ...args];
    childEnv.HOME = "/home/agent";
    childEnv.USER = "agent";
  }
  const result = runCapturedProcess(command, args, {
    cwd: repoDir,
    env: childEnv,
    timeout: LOCAL_GIT_TIMEOUT_MS,
    captureBytes: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`canonical workspace staging failed: ${sanitizeArtifactText(result.stderr || result.error?.message || "").slice(-1_000)}`);
  }
}

export function stageCanonicalWorkspaceIndex(repoDir, env, { asExecutor = false, scratchDir }) {
  const untrackedPaths = join(scratchDir, "repository-untracked-paths.tmp");
  const runOwnerGit = ownerGit(asExecutor);
  rmSync(untrackedPaths, { force: true });
  try {
    // Enumerate untracked paths while applying only per-directory .gitignore
    // rules. Deliberately omit --exclude-standard: non-repository global and
    // $GIT_DIR/info excludes must not make completed worker output disappear.
    // Ignored dependency/build trees are never enumerated or objectified.
    runRepositoryOwnerShell(repoDir,
      "exec git -c \"safe.directory=$2\" -c core.ignoreCase=false -c core.symlinks=true -c core.excludesFile=/dev/null ls-files --others --exclude-per-directory=.gitignore -z -- > \"$1\"",
      [untrackedPaths, repoDir], env, asExecutor);
    const untrackedPathBytes = statSync(untrackedPaths).size;
    if (untrackedPathBytes > MAX_CANONICAL_UNTRACKED_PATH_BYTES) {
      throw new Error(`repository untracked path evidence exceeds ${MAX_CANONICAL_UNTRACKED_PATH_BYTES} byte platform bound`);
    }
    runOwnerGit(repoDir, [
      "-c", "core.fileMode=true",
      "-c", "core.ignoreCase=false",
      "-c", "core.symlinks=true",
      "-c", "core.excludesFile=/dev/null",
      "add", "-A", "--", ".",
    ], env);
    if (untrackedPathBytes > 0) {
      // Force-add only the bounded untracked set that repository .gitignore
      // permits. Literal NUL pathspecs preserve arbitrary path bytes.
      runOwnerGit(repoDir, [
        "--literal-pathspecs",
        "-c", "core.fileMode=true",
        "-c", "core.ignoreCase=false",
        "-c", "core.symlinks=true",
        "add", "-f",
        `--pathspec-from-file=${untrackedPaths}`,
        "--pathspec-file-nul",
      ], env);
    }
  } finally {
    rmSync(untrackedPaths, { force: true });
  }
}

function optionalOwnerGit(repoDir, args, asExecutor = false) {
  try {
    return ownerGit(asExecutor)(repoDir, args);
  } catch {
    return null;
  }
}

function prepareRepositoryOwnerDirectory(path) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
  let identity;
  try {
    identity = identityForUser("agent");
  } catch {
    throw new Error("repository control could not resolve the installed agent identity");
  }
  chownSync(path, identity.uid, identity.gid);
  chmodSync(path, 0o700);
}

function canWriteDirectory(path) {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function gitAlternateObjectDirectories(extraGitEnv) {
  if (!extraGitEnv || typeof extraGitEnv !== "object") return [];
  const directories = [];
  if (typeof extraGitEnv.GIT_OBJECT_DIRECTORY === "string" && extraGitEnv.GIT_OBJECT_DIRECTORY) {
    directories.push(extraGitEnv.GIT_OBJECT_DIRECTORY);
  }
  if (typeof extraGitEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES === "string" && extraGitEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES) {
    directories.push(...extraGitEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES.split(delimiter).filter(Boolean));
  }
  return directories;
}

function inheritedGitEnvironment() {
  return Object.fromEntries(
    ["GIT_DIR", "GIT_WORK_TREE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]
      .filter((name) => typeof process.env[name] === "string" && process.env[name])
      .map((name) => [name, process.env[name]])
  );
}

function gitRepositoryEnvironment(extraGitEnv) {
  if (!extraGitEnv || typeof extraGitEnv !== "object") return {};
  return Object.fromEntries(
    ["GIT_DIR", "GIT_WORK_TREE"]
      .filter((name) => typeof extraGitEnv[name] === "string" && extraGitEnv[name])
      .map((name) => [name, extraGitEnv[name]])
  );
}

export function computeWorkspaceTreeOidFromTree(repoDir, baseTree, extraGitEnv = {}, { asExecutor = false } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), "ot-stage-index-"));
  const indexPath = join(temporary, "index");
  const objectPath = join(temporary, "objects");
  try {
    // Executor-authority reads run every git call as the literal executor
    // (root), never gosu'd to agent: the mkdtemp'd temp dir is already
    // executor-owned, so no agent-identity handoff is needed or wanted.
    if (!asExecutor) prepareRepositoryOwnerDirectory(temporary);
    const effectiveGitEnv = { ...inheritedGitEnvironment(), ...extraGitEnv };
    const extraAlternates = gitAlternateObjectDirectories(effectiveGitEnv);
    const commonDir = extraAlternates.length === 0
      ? optionalOwnerGit(repoDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"], asExecutor)
      : null;
    const commonObjects = commonDir ? join(commonDir, "objects") : null;
    const isolateObjects = extraAlternates.length > 0 || (commonObjects &&
      ((typeof process.getuid === "function" && process.getuid() === 0) || !canWriteDirectory(commonObjects))
    );
    if (isolateObjects) {
      mkdirSync(objectPath, { recursive: true, mode: 0o700 });
      if (!asExecutor) prepareRepositoryOwnerDirectory(objectPath);
    }
    const alternates = extraAlternates.length > 0 ? extraAlternates : (commonObjects ? [commonObjects] : []);
    const env = {
      ...gitRepositoryEnvironment(effectiveGitEnv),
      // A repository-level core.worktree must not redirect canonical subject
      // evidence away from the checkout selected by the executor.
      GIT_WORK_TREE: repoDir,
      GIT_INDEX_FILE: indexPath,
      // Local replace refs must not change the meaning of a sealed object id.
      GIT_NO_REPLACE_OBJECTS: "1",
      ...(isolateObjects ? {
        GIT_OBJECT_DIRECTORY: objectPath,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates.join(delimiter),
      } : {}),
    };
    const runOwnerGit = ownerGit(asExecutor);
    const sparseCheckout = runOwnerGit(repoDir, [
      "config", "--bool", "--default=false", "--get", "core.sparseCheckout",
    ], env);
    if (sparseCheckout === "true") {
      throw new Error("workspace subject requires a full non-sparse checkout");
    }
    runOwnerGit(repoDir, ["read-tree", baseTree], env);
    stageCanonicalWorkspaceIndex(repoDir, env, { asExecutor, scratchDir: temporary });
    return commit(runOwnerGit(repoDir, ["write-tree"], env), "workspace tree");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

// Canonical workspace subject: tracked files plus non-ignored untracked files,
// with Git's native blob/tree hashing and executable/symlink modes. A private
// temporary index means the agent-controlled index is never consulted.
export function computeWorkspaceTreeOid(repoDir, extraGitEnv = {}) {
  return computeWorkspaceTreeOidFromTree(repoDir, "HEAD", extraGitEnv);
}

// Same computation, but every git call runs with executor (root) authority
// instead of being gosu'd to the agent user. Needed post-command/post-action,
// after another action's cleanup may already have re-locked this worktree's
// linked admin dir (.git/worktrees/<handle>) to root:root 0700 -- running as
// agent there fails "not a git repository", not because the worktree changed,
// but because the parent repo's shared admin metadata was relocked in
// between. Never grants the agent standing access to that metadata; it just
// reads it with the authority the executor already has.
export function computeWorkspaceTreeOidAsExecutor(repoDir, extraGitEnv = {}) {
  return computeWorkspaceTreeOidFromTree(repoDir, "HEAD", extraGitEnv, { asExecutor: true });
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
    symbolicRef: optionalOwnerGit(repoDir, ["symbolic-ref", "-q", "HEAD"]),
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
    optionalOwnerGit(repoDir, ["rev-parse", "HEAD"]) === snapshot.headOid &&
    optionalOwnerGit(repoDir, ["symbolic-ref", "-q", "HEAD"]) === snapshot.symbolicRef &&
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
