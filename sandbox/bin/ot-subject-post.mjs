#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeWorkspaceTreeOid } from "../runner/repository-control.mjs";

// Resolves the top of the worktree this invocation would compute against,
// under exactly the git environment the tool itself already inherits. When
// the action seals a `GIT_WORK_TREE`, that value *is* the top and
// `git rev-parse --show-toplevel` only echoes it back, so read it directly
// rather than depending on a subprocess that could fail for an unrelated
// reason; otherwise ask git, inheriting `GIT_DIR` and friends from the
// environment the same way `computeWorkspaceTreeOid` does.
function worktreeTop(repoDir) {
  const sealedWorkTree = process.env.GIT_WORK_TREE;
  if (typeof sealedWorkTree === "string" && sealedWorkTree) return realpathSync(sealedWorkTree);
  const top = execFileSync("git", ["-c", `safe.directory=${repoDir}`, "rev-parse", "--show-toplevel"], {
    cwd: repoDir,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!top) throw new Error("git rev-parse --show-toplevel produced no worktree root");
  return realpathSync(top);
}

// Fail closed when this runs anywhere but the worktree root. The underlying
// computation stages with the pathspec `.` (repository-control.mjs
// `computeWorkspaceTreeOidFromTree`), so from a subdirectory it only refreshes
// that subtree and returns a well-formed but WRONG 40-hex oid with exit 0 --
// which either hard-fails the action later with a fence mismatch that names
// nothing about the cause, or, when every edit happens to live under that
// subdirectory, silently matches. A wrong subject must never be printable.
export function assertWorktreeRoot(repoDir = process.cwd()) {
  const top = worktreeTop(repoDir);
  const current = realpathSync(repoDir);
  if (current !== top) {
    throw new Error(`run from the worktree root: ${top} (current directory: ${current})`);
  }
  return top;
}

// Prints the workspace tree subject the executor's own post-run
// `computeWorkspaceTreeOid` will independently recompute for this worktree,
// so a completion receipt's `subject.post` can be copied from here rather
// than described in prose (the algorithm is not documentable that way -- it
// depends on the action's private index/object isolation). Run from the unit
// worktree root -- enforced, see `assertWorktreeRoot`: it operates on
// `process.cwd()` and the git environment
// (`GIT_DIR`/`GIT_WORK_TREE`/`GIT_OBJECT_DIRECTORY`/
// `GIT_ALTERNATE_OBJECT_DIRECTORIES`) already set for this action, exactly
// mirroring `execute-loop.mjs`'s own post-run fence computation. The executor
// still recomputes and cross-checks the value independently
// (`assertLoopReceiptFence`) -- this helper only lets the agent produce the
// value honestly instead of guessing; it never gets executor authority.
export function subjectPost(repoDir = process.cwd()) {
  assertWorktreeRoot(repoDir);
  return computeWorkspaceTreeOid(repoDir);
}

function main() {
  process.stdout.write(`${subjectPost()}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]))) {
  try {
    main();
  } catch (error) {
    console.error(`ot-subject-post: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
