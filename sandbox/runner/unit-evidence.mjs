#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "./capabilities.mjs";
import { digest } from "./artifacts.mjs";
import { computeWorkspaceTreeOid, runGitAsRepositoryOwner } from "./repository-control.mjs";

const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function string(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function changedPaths(repoDir, baseTree, tree) {
  const output = runGitAsRepositoryOwner(repoDir, ["diff", "--name-only", `${baseTree}`, tree]);
  return output.split("\n").filter(Boolean).sort();
}

function diffDigest(repoDir, baseTree, tree) {
  const patch = runGitAsRepositoryOwner(repoDir, ["diff", "--binary", `${baseTree}`, tree]);
  return digest(patch);
}

export function deriveCandidateEvidence({
  repoDir,
  baseCommit,
  preSubject = baseCommit,
  postSubject,
}) {
  const safeBase = string(baseCommit, "baseCommit", COMMIT);
  const tree = postSubject ?? computeWorkspaceTreeOid(repoDir);
  string(tree, "postSubject", COMMIT);
  const baseTree = runGitAsRepositoryOwner(repoDir, ["rev-parse", `${safeBase}^{tree}`]);
  const status = runGitAsRepositoryOwner(repoDir, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const payload = {
    schema: "openthrottle.candidate-evidence/v1",
    base: safeBase,
    pre: preSubject,
    post: tree,
    tree,
    diff_digest: diffDigest(repoDir, baseTree, tree),
    changed_paths: changedPaths(repoDir, baseTree, tree),
    clean: status.length === 0,
  };
  return { ...payload, hash: digest(canonicalJson(payload)) };
}

// Every fence field a command receipt must bind to the executor's current
// identity envelope before its evidence is trusted by a gate. Checked ahead
// of (and independent from) contracts/artifacts.mjs schema validation, which
// only proves the receipt is well-formed, not that it describes *this* run.
const COMMAND_RECEIPT_FENCE_FIELDS = [
  ["pipelineInstanceId", "pipeline_instance_id", "pipeline"],
  ["graphDigest", "graph_digest", "graph"],
  ["unitId", "unit_id", "unit"],
  ["attemptId", "attempt_id", "attempt"],
  ["parentRunId", "parent_run_id", "run"],
  ["actionAttemptId", "action_attempt_id", "action"],
  ["generation", "generation", "generation"],
  ["nativeSessionId", "native_session_id", "session"],
];

export function bindCommandReceipt({
  receipt,
  commandName,
  expectedSubject,
  requestHash,
  expectedFence,
}) {
  const subject = string(expectedSubject, "expectedSubject", COMMIT);
  string(requestHash, "requestHash", SHA256);
  if (!receipt || typeof receipt !== "object") throw new Error("command receipt must be an object");
  if (receipt.type !== "command_result") throw new Error("receipt is not a command_result");
  if (!expectedFence || typeof expectedFence !== "object") throw new Error("expectedFence must be an object");
  for (const [key, fenceKey, label] of COMMAND_RECEIPT_FENCE_FIELDS) {
    if (receipt.fence?.[fenceKey] !== expectedFence[key]) {
      throw new Error(`command receipt ${label} fence mismatch`);
    }
  }
  if (receipt.fence?.request_hash !== requestHash) throw new Error("command receipt request fence mismatch");
  if (receipt.subject?.post !== subject) throw new Error("command receipt subject fence mismatch");
  if (receipt.payload?.command !== commandName) throw new Error("command receipt command mismatch");
  const payload = {
    schema: "openthrottle.bound-command-receipt/v1",
    command: commandName,
    subject,
    result: receipt.result,
    receipt_hash: digest(canonicalJson(receipt)),
  };
  return { ...payload, hash: digest(canonicalJson(payload)) };
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function main() {
  const result = deriveCandidateEvidence({
    repoDir: resolve(arg("--repo", process.cwd())),
    baseCommit: arg("--base"),
    preSubject: arg("--pre", arg("--base")),
    postSubject: arg("--post"),
  });
  writeFileSync(1, `${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`unit-evidence: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
