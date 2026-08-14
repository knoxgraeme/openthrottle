#!/usr/bin/env node

import { chmodSync, chownSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runGitAsExecutor, stageCanonicalWorkspaceIndex } from "./repository-control.mjs";
import { removeWorktreeBootstrapMarker } from "./worktree-bootstrap.mjs";
import { chmodOwnerPrivateTree, chmodTree, chownTree, ensureSandboxRootTraversal, ensureTraverseOnlyDirectory, identityForUser, isRoot, pathInside as containedPath } from "./filesystem-isolation.mjs";

const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const DEFAULT_ROOT = "/var/lib/openthrottle/worktrees";
const HOOKS_PATH = "/opt/openthrottle/safety";
const DISABLED_PUSH_URL = "DISABLED_BY_OPENTHROTTLE_LOOP_WORKTREE";
const ROOT_UID = 0;
const ROOT_GID = 0;
const NO_REPLACE_OBJECTS_ENV = { GIT_NO_REPLACE_OBJECTS: "1" };

function safeHandle(value) {
  if (typeof value !== "string" || !HANDLE.test(value)) throw new Error("worktree handle is invalid");
  return value;
}

function commit(value, label) {
  if (typeof value !== "string" || !COMMIT.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function pathInside(root, child) {
  return containedPath(root, child, "worktree path escapes the executor root");
}

function assertDirectory(path, label) {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

function linkedGitDir(target) {
  const gitFile = resolve(target, ".git");
  if (!existsSync(gitFile) || !lstatSync(gitFile).isFile()) return null;
  const match = readFileSync(gitFile, "utf8").match(/^gitdir: (.+)\s*$/);
  if (!match) return null;
  const gitDir = resolve(dirname(gitFile), match[1]);
  return existsSync(gitDir) && lstatSync(gitDir).isDirectory() ? gitDir : null;
}

function commonGitDirForLinked(gitDir) {
  const commonDirFile = resolve(gitDir, "commondir");
  if (!existsSync(commonDirFile) || !lstatSync(commonDirFile).isFile()) return null;
  const commonDir = resolve(gitDir, readFileSync(commonDirFile, "utf8").trim());
  return existsSync(commonDir) && lstatSync(commonDir).isDirectory() ? commonDir : null;
}

function lockLinkedGitDir(gitDir) {
  if (!isRoot()) return;
  chownTree(gitDir, ROOT_UID, ROOT_GID);
  chmodTree(gitDir, { fileMode: 0o600, directoryMode: 0o700 });
}

function lockObjectStore(path) {
  if (!isRoot() || !existsSync(path)) return;
  chownTree(path, ROOT_UID, ROOT_GID);
  chmodTree(path, { fileMode: 0o600, directoryMode: 0o700 });
}

function lockCandidateReadableWorktree(path) {
  if (!isRoot()) return;
  chownTree(path, ROOT_UID, ROOT_GID);
  chmodOwnerPrivateTree(path);
}

function prepareWorktreeRoot(rootDir) {
  ensureSandboxRootTraversal(rootDir);
  ensureTraverseOnlyDirectory(rootDir, "worktree root");
}

function lockGitIndirectionFile(target) {
  const gitFile = resolve(target, ".git");
  if (!existsSync(gitFile)) return;
  const metadata = lstatSync(gitFile);
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) return;
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("worktree .git indirection must be a regular file");
  }
  if (isRoot()) chownSync(gitFile, ROOT_UID, ROOT_GID);
  chmodSync(gitFile, 0o444);
}

function grantWritableWorktreeRoot(target, identity) {
  if (!isRoot() || !identity) return;
  chownSync(target, ROOT_UID, identity.gid);
  chmodSync(target, 0o1770);
}

export function lockWorktree({ rootDir = DEFAULT_ROOT, handle, lockLinkedGitDir: shouldLockLinkedGitDir = true }) {
  const target = worktreePath({ rootDir, handle });
  if (!existsSync(target)) throw new Error("worktree handle does not exist");
  assertDirectory(target, "worktree");
  const gitDir = linkedGitDir(target);
  chownTree(target, ROOT_UID, ROOT_GID);
  chmodOwnerPrivateTree(target);
  lockGitIndirectionFile(target);
  if (shouldLockLinkedGitDir && gitDir) lockLinkedGitDir(gitDir);
  return { id: safeHandle(handle), path: target, writable: false };
}

export function grantWorktreeToAgent({ rootDir = DEFAULT_ROOT, handle, grantLinkedGitDir = false }) {
  prepareWorktreeRoot(rootDir);
  const target = worktreePath({ rootDir, handle });
  if (!existsSync(target)) throw new Error("worktree handle does not exist");
  assertDirectory(target, "worktree");
  for (const entry of readdirSync(rootDir)) {
    const sibling = resolve(rootDir, entry);
    if (sibling !== target && lstatSync(sibling).isDirectory()) {
      const siblingGitDir = linkedGitDir(sibling);
      chownTree(sibling, ROOT_UID, ROOT_GID);
      chmodOwnerPrivateTree(sibling);
      lockGitIndirectionFile(sibling);
      if (siblingGitDir) lockLinkedGitDir(siblingGitDir);
    }
  }
  const identity = identityForUser("agent");
  const gitDir = linkedGitDir(target);
  if (identity) chownTree(target, identity.uid, identity.gid);
  chmodOwnerPrivateTree(target);
  lockGitIndirectionFile(target);
  grantWritableWorktreeRoot(target, identity);
  if (identity && gitDir && grantLinkedGitDir) {
    chownTree(gitDir, identity.uid, identity.gid);
    chmodTree(gitDir, { fileMode: 0o600, directoryMode: 0o700 });
  } else if (gitDir) {
    lockLinkedGitDir(gitDir);
  }
  return { id: safeHandle(handle), path: target, writable: true };
}

function requireClean(repoDir) {
  const status = runGitAsExecutor(repoDir, ["status", "--porcelain=v1", "--untracked-files=all"], NO_REPLACE_OBJECTS_ENV);
  if (status) throw new Error("integration checkout must be clean before creating a unit worktree");
}

function requireReachableWorktreeBase(repoDir, baseCommit) {
  const head = runGitAsExecutor(repoDir, ["rev-parse", "HEAD"], NO_REPLACE_OBJECTS_ENV);
  try {
    runGitAsExecutor(repoDir, ["rev-parse", "--verify", `${baseCommit}^{commit}`], NO_REPLACE_OBJECTS_ENV);
  } catch {
    throw new Error("requested worktree base commit does not exist");
  }
  try {
    runGitAsExecutor(repoDir, ["merge-base", "--is-ancestor", head, baseCommit], NO_REPLACE_OBJECTS_ENV);
  } catch {
    throw new Error("requested worktree base is not a descendant of the integration checkout HEAD");
  }
}

function existingWorktree({ rootDir, target, handle, baseCommit, hooksPath }) {
  assertDirectory(target, "worktree");
  const head = runGitAsExecutor(target, ["rev-parse", "HEAD"], NO_REPLACE_OBJECTS_ENV);
  if (head !== baseCommit) throw new Error("existing worktree handle points at a different base commit");
  const status = runGitAsExecutor(target, ["status", "--porcelain=v1", "--untracked-files=all"], NO_REPLACE_OBJECTS_ENV);
  if (status) throw new Error("existing worktree is dirty");
  runGitAsExecutor(target, ["config", "extensions.worktreeConfig", "true"]);
  runGitAsExecutor(target, ["config", "--worktree", "core.hooksPath", hooksPath]);
  runGitAsExecutor(target, ["config", "--worktree", "remote.origin.pushurl", DISABLED_PUSH_URL]);
  lockWorktree({ rootDir, handle });
  return { id: safeHandle(handle), path: target, baseCommit };
}

export function worktreePath({ rootDir = DEFAULT_ROOT, handle }) {
  return pathInside(rootDir, safeHandle(handle));
}

export function createWorktree({
  repoDir,
  rootDir = DEFAULT_ROOT,
  handle,
  baseCommit,
  hooksPath = HOOKS_PATH,
  idempotent = false,
  markerRootDir = undefined,
}) {
  const safeBase = commit(baseCommit, "worktree base commit");
  const target = worktreePath({ rootDir, handle });
  if (existsSync(target)) {
    if (idempotent) return existingWorktree({ rootDir, target, handle, baseCommit: safeBase, hooksPath });
    throw new Error("worktree handle already exists");
  }
  requireClean(repoDir);
  requireReachableWorktreeBase(repoDir, safeBase);
  prepareWorktreeRoot(rootDir);
  // A fresh checkout has no dependency state yet: a bootstrap marker left by
  // an earlier same-handle worktree must not let this one skip bootstrap.
  removeWorktreeBootstrapMarker({ ...(markerRootDir === undefined ? {} : { markerRootDir }), handle });
  try {
    runGitAsExecutor(repoDir, ["worktree", "add", "--detach", target, safeBase], NO_REPLACE_OBJECTS_ENV);
    const materializedHead = runGitAsExecutor(target, ["rev-parse", "HEAD"], NO_REPLACE_OBJECTS_ENV);
    if (materializedHead !== safeBase) throw new Error("new worktree HEAD does not match requested base commit");
    runGitAsExecutor(target, ["config", "extensions.worktreeConfig", "true"]);
    runGitAsExecutor(target, ["config", "--worktree", "core.hooksPath", hooksPath]);
    runGitAsExecutor(target, ["config", "--worktree", "remote.origin.pushurl", DISABLED_PUSH_URL]);
    const status = runGitAsExecutor(target, ["status", "--porcelain=v1", "--untracked-files=all"], NO_REPLACE_OBJECTS_ENV);
    if (status) throw new Error("new worktree is dirty");
    lockWorktree({ rootDir, handle });
    return { id: safeHandle(handle), path: target, baseCommit: safeBase };
  } catch (error) {
    try {
      runGitAsExecutor(repoDir, ["worktree", "remove", "--force", target]);
    } catch {
      // A partially registered linked worktree is best-effort cleaned before
      // the checkout directory is removed and the original failure is reported.
    }
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

export function deriveCandidateCommit({
  worktreeDir,
  baseCommit,
  message = "OpenThrottle internal candidate",
}) {
  const safeBase = commit(baseCommit, "candidate base commit");
  const gitDir = linkedGitDir(worktreeDir);
  const commonDir = gitDir ? commonGitDirForLinked(gitDir) : null;
  const temporary = mkdtempSync(join(tmpdir(), "ot-candidate-index-"));
  const indexPath = join(temporary, "index");
  try {
    if (isRoot()) {
      lockCandidateReadableWorktree(worktreeDir);
      if (gitDir) lockLinkedGitDir(gitDir);
      if (commonDir) lockObjectStore(resolve(commonDir, "objects"));
    }
    const head = runGitAsExecutor(worktreeDir, ["rev-parse", "HEAD"]);
    if (head !== safeBase) throw new Error("worker moved HEAD; executor refuses candidate creation");
    const env = {
      GIT_INDEX_FILE: indexPath,
      GIT_NO_REPLACE_OBJECTS: "1",
      // Never let repository core.worktree redirect evidence away from the
      // executor-selected worker checkout.
      GIT_WORK_TREE: worktreeDir,
    };
    const sparseCheckout = runGitAsExecutor(worktreeDir, [
      "config", "--bool", "--default=false", "--get", "core.sparseCheckout",
    ], env);
    if (sparseCheckout === "true") {
      throw new Error("candidate creation requires a full non-sparse checkout");
    }
    runGitAsExecutor(worktreeDir, ["read-tree", "HEAD"], env);
    stageCanonicalWorkspaceIndex(worktreeDir, env, { asExecutor: true, scratchDir: temporary });
    const tree = runGitAsExecutor(worktreeDir, ["write-tree"], env);
    const baseTree = runGitAsExecutor(worktreeDir, ["rev-parse", `${safeBase}^{tree}`], env);
    const changedPaths = runGitAsExecutor(worktreeDir, [
      "-c", "core.quotePath=true",
      "diff", "--name-only",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      "--no-renames",
      `${safeBase}^{tree}`,
      tree,
    ], env)
      .split("\n")
      .filter(Boolean);
    if (tree === baseTree) return { candidateCommit: null, tree, changedPaths };
    const candidateCommit = runGitAsExecutor(worktreeDir, ["commit-tree", tree, "-p", safeBase, "-m", message], env);
    return { candidateCommit, tree, changedPaths };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    if (isRoot()) {
      chownTree(worktreeDir, ROOT_UID, ROOT_GID);
      chmodOwnerPrivateTree(worktreeDir);
      if (gitDir) lockLinkedGitDir(gitDir);
      if (commonDir) lockObjectStore(resolve(commonDir, "objects"));
    }
  }
}

export function removeWorktree({ repoDir, rootDir = DEFAULT_ROOT, handle, markerRootDir = undefined }) {
  const target = worktreePath({ rootDir, handle });
  const markerArgs = { ...(markerRootDir === undefined ? {} : { markerRootDir }), handle };
  if (!existsSync(target)) {
    removeWorktreeBootstrapMarker(markerArgs);
    return { id: safeHandle(handle), removed: false };
  }
  try {
    runGitAsExecutor(repoDir, ["worktree", "remove", "--force", target]);
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    runGitAsExecutor(repoDir, ["worktree", "prune"]);
    const registered = runGitAsExecutor(repoDir, ["worktree", "list", "--porcelain"])
      .split(/\n(?=worktree )/)
      .some((entry) => entry.split("\n")[0] === `worktree ${target}`);
    if (registered || existsSync(target)) {
      // The worktree may still exist, so its bootstrap marker stays valid.
      throw new Error(`stale worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    removeWorktreeBootstrapMarker(markerArgs);
    return { id: safeHandle(handle), removed: true, recovered: true };
  }
  rmSync(target, { recursive: true, force: true });
  removeWorktreeBootstrapMarker(markerArgs);
  return { id: safeHandle(handle), removed: true };
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function main() {
  const command = process.argv[2];
  const repoDir = resolve(arg("--repo", "/home/agent/repo"));
  const rootDir = resolve(arg("--root", DEFAULT_ROOT));
  const handle = arg("--handle");
  if (command === "create") {
    const result = createWorktree({
      repoDir,
      rootDir,
      handle,
      baseCommit: arg("--base"),
      idempotent: process.argv.includes("--idempotent"),
    });
    writeFileSync(1, `${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "candidate") {
    const worktreeDir = worktreePath({ rootDir, handle });
    const result = deriveCandidateCommit({ worktreeDir, baseCommit: arg("--base"), message: arg("--message", "OpenThrottle internal candidate") });
    writeFileSync(1, `${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "remove") {
    const result = removeWorktree({ repoDir, rootDir, handle });
    writeFileSync(1, `${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error("Usage: worktrees.mjs create|candidate|remove --handle <id> [--repo <path>] [--root <path>] [--base <commit>]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`worktrees: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
