#!/usr/bin/env node

import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runGitAsExecutor, runGitAsRepositoryOwner } from "./repository-control.mjs";
import { chmodTree, chownTree, identityForUser, isRoot, pathInside as containedPath } from "./filesystem-isolation.mjs";

const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const DEFAULT_ROOT = "/var/lib/openthrottle/worktrees";
const HOOKS_PATH = "/opt/openthrottle/safety";
const DISABLED_PUSH_URL = "DISABLED_BY_OPENTHROTTLE_LOOP_WORKTREE";
const ROOT_UID = 0;
const ROOT_GID = 0;

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
  chmodTree(gitDir, { fileMode: 0o444, directoryMode: 0o555 });
}

function grantTreeToAgent(path) {
  const identity = identityForUser("agent");
  if (!identity) return;
  chownTree(path, identity.uid, identity.gid);
  chmodTree(path, { fileMode: 0o600, directoryMode: 0o700 });
}

function lockReadOnlyTree(path) {
  if (!isRoot() || !existsSync(path)) return;
  chownTree(path, ROOT_UID, ROOT_GID);
  chmodTree(path, { fileMode: 0o444, directoryMode: 0o555 });
}

function lockObjectStore(path) {
  if (!isRoot() || !existsSync(path)) return;
  chownTree(path, ROOT_UID, ROOT_GID);
  chmodTree(path, { fileMode: 0o600, directoryMode: 0o700 });
}

function prepareWorktreeRoot(rootDir) {
  mkdirSync(rootDir, { recursive: true, mode: 0o711 });
  assertDirectory(rootDir, "worktree root");
  if (isRoot()) chownSync(rootDir, ROOT_UID, ROOT_GID);
  chmodSync(rootDir, 0o711);
}

export function lockWorktree({ rootDir = DEFAULT_ROOT, handle, lockLinkedGitDir = true }) {
  const target = worktreePath({ rootDir, handle });
  if (!existsSync(target)) throw new Error("worktree handle does not exist");
  assertDirectory(target, "worktree");
  const gitDir = linkedGitDir(target);
  chownTree(target, ROOT_UID, ROOT_GID);
  chmodTree(target, { fileMode: 0o600, directoryMode: 0o700 });
  if (lockLinkedGitDir && gitDir) {
    chownTree(gitDir, ROOT_UID, ROOT_GID);
    chmodTree(gitDir, { fileMode: 0o600, directoryMode: 0o700 });
  }
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
      chmodTree(sibling, { fileMode: 0o600, directoryMode: 0o700 });
      if (siblingGitDir) lockLinkedGitDir(siblingGitDir);
    }
  }
  const identity = identityForUser("agent");
  const gitDir = linkedGitDir(target);
  if (identity) chownTree(target, identity.uid, identity.gid);
  chmodTree(target, { fileMode: 0o600, directoryMode: 0o700 });
  if (identity && gitDir && grantLinkedGitDir) {
    chownTree(gitDir, identity.uid, identity.gid);
    chmodTree(gitDir, { fileMode: 0o600, directoryMode: 0o700 });
  } else if (gitDir) {
    lockLinkedGitDir(gitDir);
  }
  return { id: safeHandle(handle), path: target, writable: true };
}

function requireClean(repoDir) {
  const status = runGitAsExecutor(repoDir, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status) throw new Error("integration checkout must be clean before creating a unit worktree");
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
}) {
  const safeBase = commit(baseCommit, "worktree base commit");
  const target = worktreePath({ rootDir, handle });
  if (existsSync(target)) throw new Error("worktree handle already exists");
  requireClean(repoDir);
  const head = runGitAsExecutor(repoDir, ["rev-parse", "HEAD"]);
  if (head !== safeBase) throw new Error("integration checkout HEAD does not match requested worktree base");
  prepareWorktreeRoot(rootDir);
  runGitAsExecutor(repoDir, ["worktree", "add", "--detach", target, safeBase]);
  try {
    grantWorktreeToAgent({ rootDir, handle, grantLinkedGitDir: true });
    runGitAsRepositoryOwner(target, ["config", "extensions.worktreeConfig", "true"]);
    runGitAsRepositoryOwner(target, ["config", "--worktree", "core.hooksPath", hooksPath]);
    runGitAsRepositoryOwner(target, ["config", "--worktree", "remote.origin.pushurl", DISABLED_PUSH_URL]);
    const status = runGitAsRepositoryOwner(target, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status) throw new Error("new worktree is dirty");
    lockWorktree({ rootDir, handle, lockLinkedGitDir: false });
    return { id: safeHandle(handle), path: target, baseCommit: safeBase };
  } catch (error) {
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
  try {
    if (isRoot()) {
      grantTreeToAgent(worktreeDir);
      if (gitDir) grantTreeToAgent(gitDir);
      if (commonDir) grantTreeToAgent(resolve(commonDir, "objects"));
    }
    const head = runGitAsRepositoryOwner(worktreeDir, ["rev-parse", "HEAD"]);
    if (head !== safeBase) throw new Error("worker moved HEAD; executor refuses candidate creation");
    runGitAsRepositoryOwner(worktreeDir, ["add", "-A", "--", "."]);
    const tree = runGitAsRepositoryOwner(worktreeDir, ["write-tree"]);
    const changedPaths = runGitAsRepositoryOwner(worktreeDir, ["diff", "--name-only", `${safeBase}^{tree}`, tree])
      .split("\n")
      .filter(Boolean);
    if (changedPaths.length === 0) return { candidateCommit: null, tree, changedPaths };
    const candidateCommit = runGitAsRepositoryOwner(worktreeDir, ["commit-tree", tree, "-p", safeBase, "-m", message]);
    return { candidateCommit, tree, changedPaths };
  } finally {
    if (isRoot()) {
      chownTree(worktreeDir, ROOT_UID, ROOT_GID);
      chmodTree(worktreeDir, { fileMode: 0o600, directoryMode: 0o700 });
      if (gitDir) lockLinkedGitDir(gitDir);
      if (commonDir) lockObjectStore(resolve(commonDir, "objects"));
    }
  }
}

export function removeWorktree({ repoDir, rootDir = DEFAULT_ROOT, handle }) {
  const target = worktreePath({ rootDir, handle });
  if (!existsSync(target)) return { id: safeHandle(handle), removed: false };
  grantWorktreeToAgent({ rootDir, handle, grantLinkedGitDir: true });
  runGitAsExecutor(repoDir, ["worktree", "remove", "--force", target]);
  rmSync(target, { recursive: true, force: true });
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
    const result = createWorktree({ repoDir, rootDir, handle, baseCommit: arg("--base") });
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
  if (command === "grant") {
    const result = grantWorktreeToAgent({ rootDir, handle });
    writeFileSync(1, `${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "lock") {
    const result = lockWorktree({ rootDir, handle });
    writeFileSync(1, `${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error("Usage: worktrees.mjs create|candidate|remove|grant|lock --handle <id> [--repo <path>] [--root <path>] [--base <commit>]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`worktrees: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
