#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_CHECKPOINT_BUNDLE_BYTES } from "./checkpoint-bundle.mjs";
import { runCapturedProcess } from "./bounded-process.mjs";
import { runGitAsExecutor } from "./repository-control.mjs";

export const INTEGRATION_REQUEST_SCHEMA = "openthrottle.kernel-integration-request/v1";
export const INTEGRATION_RESULT_SCHEMA = "openthrottle.kernel-integration-result/v1";

const SUBJECT = /^[a-f0-9]{40,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "OpenThrottle Executor",
  GIT_AUTHOR_EMAIL: "executor@openthrottle.local",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "OpenThrottle Executor",
  GIT_COMMITTER_EMAIL: "executor@openthrottle.local",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

function required(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request) || request.schema !== INTEGRATION_REQUEST_SCHEMA) {
    throw new Error("integration request schema is invalid");
  }
  for (const key of ["pipeline_run_id", "effect_id", "idempotency_key", "lease_id", "worker_id", "candidate_checkpoint_id"]) {
    required(request[key], `request.${key}`, ID);
  }
  required(request.definition_bundle_hash, "request.definition_bundle_hash", SHA256);
  for (const key of ["current_subject", "candidate_input_subject", "candidate_output_subject"]) {
    required(request[key], `request.${key}`, SUBJECT);
  }
  const artifact = request.candidate_artifact;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) throw new Error("candidate artifact is invalid");
  required(artifact.file, "candidate_artifact.file", SAFE_FILE);
  required(artifact.sha256, "candidate_artifact.sha256", SHA256);
  required(artifact.ref, "candidate_artifact.ref", /^refs\/openthrottle\/checkpoints\/[a-f0-9]{64}$/);
  required(artifact.commit, "candidate_artifact.commit", SUBJECT);
  required(artifact.tree, "candidate_artifact.tree", SUBJECT);
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > MAX_CHECKPOINT_BUNDLE_BYTES ||
      artifact.media_type !== "application/x-git-bundle" ||
      artifact.payload_schema !== "openthrottle.git-checkpoint-bundle/v1") {
    throw new Error("candidate artifact contract is invalid");
  }
  if (artifact.commit !== request.candidate_output_subject) throw new Error("candidate output subject must equal artifact commit");
  return request;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function commonResult(request) {
  return {
    schema: INTEGRATION_RESULT_SCHEMA,
    pipeline_run_id: request.pipeline_run_id,
    effect_id: request.effect_id,
    idempotency_key: request.idempotency_key,
    lease_id: request.lease_id,
    worker_id: request.worker_id,
    definition_bundle_hash: request.definition_bundle_hash,
    input_subject: request.current_subject,
    candidate_checkpoint_id: request.candidate_checkpoint_id,
  };
}

function syncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeImmutable(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const bytes = `${JSON.stringify(value)}\n`;
  try {
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o400);
    try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    syncDirectory(dirname(path));
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (readFileSync(path, "utf8") !== bytes) throw new Error("integration result conflicts with immutable replay");
  }
}

function mergeTree(repoDir, left, right, environment) {
  const result = runCapturedProcess("git", [
    "-c", `safe.directory=${repoDir}`,
    "merge-tree", "--write-tree", left, right,
  ], {
    cwd: repoDir,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...AUTHOR_ENV, ...environment },
    timeout: 120_000,
    captureBytes: 2 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return { conflict: true, detail: String(result.stdout || result.stderr).slice(-4_000) };
  const tree = result.stdout.split(/\s+/)[0];
  required(tree, "integrated tree", SUBJECT);
  return { conflict: false, tree };
}

export function integrateCheckpoint({
  request,
  requestDirectory,
  resultPath,
  sourceRepoDir = "/home/agent/repo",
}) {
  validateRequest(request);
  if (existsSync(resultPath)) {
    const replay = JSON.parse(readFileSync(resultPath, "utf8"));
    for (const [key, value] of Object.entries(commonResult(request))) {
      if (replay[key] !== value) throw new Error(`integration replay ${key} mismatch`);
    }
    return replay;
  }
  let result;
  const temporary = mkdtempSync(join(tmpdir(), "ot-kernel-integration-"));
  try {
    const artifactPath = join(resolve(requestDirectory), request.candidate_artifact.file);
    const metadata = statSync(artifactPath);
    if (!metadata.isFile() || metadata.size !== request.candidate_artifact.bytes || sha256(artifactPath) !== request.candidate_artifact.sha256) {
      throw new Error("candidate checkpoint artifact failed size or digest verification");
    }
    runGitAsExecutor(temporary, ["init", "--quiet"]);
    runGitAsExecutor(temporary, [
      "fetch", "--quiet", artifactPath,
      `${request.candidate_artifact.ref}:refs/openthrottle/candidate`,
    ]);
    const candidateCommit = runGitAsExecutor(temporary, ["rev-parse", "refs/openthrottle/candidate"]);
    const candidateTree = runGitAsExecutor(temporary, ["rev-parse", `${candidateCommit}^{tree}`]);
    const candidateParent = runGitAsExecutor(temporary, ["rev-parse", `${candidateCommit}^`]);
    const candidateBaseTree = runGitAsExecutor(temporary, ["rev-parse", `${candidateParent}^{tree}`]);
    if (candidateCommit !== request.candidate_artifact.commit || candidateTree !== request.candidate_artifact.tree) {
      throw new Error("candidate bundle ref, commit, or tree does not match its descriptor");
    }
    const inputTree = runGitAsExecutor(sourceRepoDir, ["rev-parse", `${request.candidate_input_subject}^{tree}`]);
    if (inputTree !== candidateBaseTree) throw new Error("candidate checkpoint parent does not match its input subject");

    const sourceGitDir = resolve(sourceRepoDir, runGitAsExecutor(sourceRepoDir, ["rev-parse", "--git-common-dir"]));
    const environment = { GIT_ALTERNATE_OBJECT_DIRECTORIES: join(sourceGitDir, "objects"), ...AUTHOR_ENV };
    const currentTree = runGitAsExecutor(sourceRepoDir, ["rev-parse", `${request.current_subject}^{tree}`]);
    let outputTree;
    let outputCommit;
    if (currentTree === inputTree) {
      outputTree = candidateTree;
      outputCommit = candidateCommit;
    } else {
      const currentCommit = runGitAsExecutor(temporary, [
        "commit-tree", currentTree, "-p", candidateParent, "-m", "OpenThrottle integration current subject",
      ], environment);
      const merged = mergeTree(temporary, currentCommit, candidateCommit, environment);
      if (merged.conflict) {
        result = {
          ...commonResult(request),
          state: "needs_human",
          output_subject: null,
          payload_schema: null,
          payload_artifact: null,
          reason: `checkpoint integration conflict: ${merged.detail}`,
        };
        writeImmutable(resultPath, result);
        return result;
      }
      outputTree = merged.tree;
      outputCommit = runGitAsExecutor(temporary, [
        "commit-tree", outputTree, "-p", currentCommit, "-p", candidateCommit,
        "-m", "OpenThrottle integrated checkpoint",
      ], { ...environment, ...AUTHOR_ENV });
    }
    const refSuffix = createHash("sha256").update(request.idempotency_key).digest("hex");
    const ref = `refs/openthrottle/integrations/${refSuffix}`;
    runGitAsExecutor(temporary, ["update-ref", ref, outputCommit]);
    mkdirSync(dirname(resultPath), { recursive: true, mode: 0o700 });
    const file = `${refSuffix}.integration.bundle`;
    const outputPath = join(dirname(resultPath), file);
    runGitAsExecutor(temporary, ["bundle", "create", outputPath, ref], environment);
    const bytes = statSync(outputPath).size;
    if (bytes < 1 || bytes > MAX_CHECKPOINT_BUNDLE_BYTES) throw new Error("integrated checkpoint bundle exceeds the platform bound");
    result = {
      ...commonResult(request),
      state: "integrated",
      output_subject: outputCommit,
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      payload_artifact: {
        file,
        sha256: sha256(outputPath),
        bytes,
        media_type: "application/x-git-bundle",
        payload_schema: "openthrottle.git-checkpoint-bundle/v1",
        ref,
        commit: outputCommit,
        tree: outputTree,
      },
      reason: null,
    };
  } catch (error) {
    result = {
      ...commonResult(request),
      state: "retryable_failure",
      output_subject: null,
      payload_schema: null,
      payload_artifact: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  writeImmutable(resultPath, result);
  return result;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const requestPath = resolve(process.env.OT_INTEGRATION_REQUEST_FILE);
  const resultPath = resolve(process.env.OT_INTEGRATION_RESULT_FILE);
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  integrateCheckpoint({ request, requestDirectory: dirname(requestPath), resultPath });
}
