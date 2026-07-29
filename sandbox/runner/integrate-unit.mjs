#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "./capabilities.mjs";
import { digest } from "./artifacts.mjs";
import { runGitAsRepositoryOwner } from "./repository-control.mjs";

const COMMIT = /^[a-f0-9]{40}$/;

function commit(value, label) {
  if (typeof value !== "string" || !COMMIT.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function clean(repoDir) {
  return runGitAsRepositoryOwner(repoDir, ["status", "--porcelain=v1", "--untracked-files=all"]) === "";
}

function treeOf(repoDir, subject) {
  return runGitAsRepositoryOwner(repoDir, ["rev-parse", `${subject}^{tree}`]);
}

export function integrateCandidate({
  repoDir,
  expectedHead,
  candidateCommit,
}) {
  const expected = commit(expectedHead, "expectedHead");
  const candidate = commit(candidateCommit, "candidateCommit");
  if (!clean(repoDir)) throw new Error("integration checkout must be clean");
  const head = runGitAsRepositoryOwner(repoDir, ["rev-parse", "HEAD"]);
  if (head !== expected) throw new Error("integration checkout HEAD does not match expected head");
  const currentTree = treeOf(repoDir, head);
  const candidateTree = treeOf(repoDir, candidate);
  if (currentTree === candidateTree) {
    return receipt({ repoDir, expected, candidate, integrated: false, reason: "already_applied_exact_tree" });
  }
  const mergeBase = runGitAsRepositoryOwner(repoDir, ["merge-base", head, candidate]);
  if (mergeBase !== head) throw new Error("candidate is not a fast-forward of the integration head");
  runGitAsRepositoryOwner(repoDir, ["merge", "--ff-only", candidate]);
  return receipt({ repoDir, expected, candidate, integrated: true, reason: "fast_forwarded" });
}

function receipt({ repoDir, expected, candidate, integrated, reason }) {
  const head = runGitAsRepositoryOwner(repoDir, ["rev-parse", "HEAD"]);
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
