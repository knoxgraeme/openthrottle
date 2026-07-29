#!/usr/bin/env node

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { runGitAsRepositoryOwner } from "./repository-control.mjs";

const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const DEFAULT_ROOT = "/var/lib/openthrottle/worktrees";
const HOOKS_PATH = "/opt/openthrottle/safety";
const DISABLED_PUSH_URL = "DISABLED_BY_OPENTHROTTLE_LOOP_WORKTREE";

function safeHandle(value) {
  if (typeof value !== "string" || !HANDLE.test(value)) throw new Error("worktree handle is invalid");
  return value;
}

function commit(value, label) {
  if (typeof value !== "string" || !COMMIT.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function pathInside(root, child) {
  const rootPath = resolve(root);
  const childPath = resolve(rootPath, child);
  if (childPath !== rootPath && !childPath.startsWith(`${rootPath}${sep}`)) {
    throw new Error("worktree path escapes the executor root");
  }
  return childPath;
}

function requireClean(repoDir) {
  const status = runGitAsRepositoryOwner(repoDir, ["status", "--porcelain=v1", "--untracked-files=all"]);
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
  const head = runGitAsRepositoryOwner(repoDir, ["rev-parse", "HEAD"]);
  if (head !== safeBase) throw new Error("integration checkout HEAD does not match requested worktree base");
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  runGitAsRepositoryOwner(repoDir, ["worktree", "add", "--detach", target, safeBase]);
  try {
    runGitAsRepositoryOwner(target, ["config", "extensions.worktreeConfig", "true"]);
    runGitAsRepositoryOwner(target, ["config", "--worktree", "core.hooksPath", hooksPath]);
    runGitAsRepositoryOwner(target, ["config", "--worktree", "remote.origin.pushurl", DISABLED_PUSH_URL]);
    const status = runGitAsRepositoryOwner(target, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status) throw new Error("new worktree is dirty");
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
}

export function removeWorktree({ repoDir, rootDir = DEFAULT_ROOT, handle }) {
  const target = worktreePath({ rootDir, handle });
  if (!existsSync(target)) return { id: safeHandle(handle), removed: false };
  runGitAsRepositoryOwner(repoDir, ["worktree", "remove", "--force", target]);
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
