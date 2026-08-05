#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "./capabilities.mjs";
import { digest } from "./artifacts.mjs";
import { runGitAsExecutor } from "./repository-control.mjs";
import { restoreIntegrationCheckout } from "./execute-loop.mjs";

const COMMIT = /^[a-f0-9]{40}$/;

function commit(value, label) {
  if (typeof value !== "string" || !COMMIT.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function clean(repoDir) {
  return runGitAsExecutor(repoDir, ["status", "--porcelain=v1", "--untracked-files=all"]) === "";
}

function treeOf(repoDir, subject) {
  return runGitAsExecutor(repoDir, ["rev-parse", `${subject}^{tree}`]);
}

export function integrateCandidate({
  repoDir,
  expectedHead,
  candidateCommit,
}) {
  try {
    const expected = commit(expectedHead, "expectedHead");
    const candidate = commit(candidateCommit, "candidateCommit");
    if (!clean(repoDir)) throw new Error("integration checkout must be clean");
    const head = runGitAsExecutor(repoDir, ["rev-parse", "HEAD"]);
    if (head === candidate && head !== expected) {
      // Exact replay after the fast-forward already happened (for example a
      // post-integration cleanup failure): accept only the exact candidate
      // head that descends from the expected head; any other drift fails.
      const replayBase = runGitAsExecutor(repoDir, ["merge-base", expected, candidate]);
      if (replayBase !== expected) throw new Error("integrated head is not a descendant of the expected head");
      return receipt({ repoDir, expected, candidate, integrated: false, reason: "already_integrated_exact_head" });
    }
    if (head !== expected) throw new Error("integration checkout HEAD does not match expected head");
    const currentTree = treeOf(repoDir, head);
    const candidateTree = treeOf(repoDir, candidate);
    if (currentTree === candidateTree) {
      return receipt({ repoDir, expected, candidate, integrated: false, reason: "already_applied_exact_tree" });
    }
    const mergeBase = runGitAsExecutor(repoDir, ["merge-base", head, candidate]);
    if (mergeBase !== head) throw new Error("candidate is not a fast-forward of the integration head");
    runGitAsExecutor(repoDir, ["merge", "--ff-only", candidate]);
    return receipt({ repoDir, expected, candidate, integrated: true, reason: "fast_forwarded" });
  } finally {
    restoreIntegrationCheckout(repoDir);
  }
}

function receipt({ repoDir, expected, candidate, integrated, reason }) {
  const head = runGitAsExecutor(repoDir, ["rev-parse", "HEAD"]);
  const tree = treeOf(repoDir, head);
  const payload = {
    schema: "openthrottle.integration-evidence/v1",
    expected_head: expected,
    candidate_commit: candidate,
    integrated_head: head,
    tree,
    integrated,
    reason,
  };
  return { ...payload, hash: digest(canonicalJson(payload)) };
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function main() {
  const result = integrateCandidate({
    repoDir: resolve(arg("--repo", process.cwd())),
    expectedHead: arg("--expected-head"),
    candidateCommit: arg("--candidate"),
  });
  writeFileSync(1, `${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`integrate-unit: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
