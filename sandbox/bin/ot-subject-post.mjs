#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeWorkspaceTreeOid } from "../runner/repository-control.mjs";

// Prints the workspace tree subject the executor's own post-run
// `computeWorkspaceTreeOid` will independently recompute for this worktree,
// so a completion receipt's `subject.post` can be copied from here rather
// than described in prose (the algorithm is not documentable that way -- it
// depends on the action's private index/object isolation). Run from the unit
// worktree root: it operates on `process.cwd()` and the git environment
// (`GIT_DIR`/`GIT_WORK_TREE`/`GIT_OBJECT_DIRECTORY`/
// `GIT_ALTERNATE_OBJECT_DIRECTORIES`) already set for this action, exactly
// mirroring `execute-loop.mjs`'s own post-run fence computation. The executor
// still recomputes and cross-checks the value independently
// (`assertLoopReceiptFence`) -- this helper only lets the agent produce the
// value honestly instead of guessing; it never gets executor authority.
export function subjectPost(repoDir = process.cwd()) {
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
