#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCapturedProcess } from "./bounded-process.mjs";
import { ATTEMPT_FORENSICS_SCHEMA, stageJsonEvidenceArtifact } from "./evidence-artifact.mjs";
import { repositoryGitEnvironment } from "./repository-authority.mjs";

const MAX_TAIL_BYTES = 16 * 1024;
const MAX_STATUS_BYTES = 32 * 1024;
const MAX_STATE_FILE_BYTES = 2 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const ENTRYPOINT_TIMESTAMP = /\[kernel-entrypoint \d{2}:\d{2}:\d{2}\]/g;
const SEALED_OUTCOME_STATES = new Set([
  "work_complete",
  "result_pending",
  "work_failed",
  "needs_human",
]);

function operationalTail(tail) {
  return tail.replaceAll(ENTRYPOINT_TIMESTAMP, "[kernel-entrypoint]");
}

function boundedTail(path, maximum = MAX_TAIL_BYTES) {
  if (!existsSync(path)) return "";
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size === 0) return "";
    const length = Math.min(metadata.size, maximum);
    const bytes = Buffer.alloc(length);
    readSync(descriptor, bytes, 0, length, metadata.size - length);
    return bytes.toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function fileState(path) {
  try {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile()) return { state: "not_regular" };
      if (metadata.size > MAX_STATE_FILE_BYTES) {
        return { state: "oversized", bytes: metadata.size };
      }
      const bytes = readFileSync(descriptor);
      return {
        state: "present",
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    return error?.code === "ENOENT"
      ? { state: "missing" }
      : { state: "unreadable", detail: String(error?.code ?? "unknown").slice(0, 100) };
  }
}

function workspaceStatus(repositoryPath) {
  if (!existsSync(repositoryPath)) return { state: "missing", summary: "" };
  try {
    const execution = runCapturedProcess(
      "git",
      ["-C", repositoryPath, "status", "--short", "--untracked-files=normal"],
      {
        cwd: repositoryPath,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          ...repositoryGitEnvironment(repositoryPath),
        },
        timeout: 10_000,
        captureBytes: MAX_STATUS_BYTES,
      },
    );
    return {
      state: execution.status === 0 ? "present" : "failed",
      summary: String(execution.stdout ?? "").slice(-MAX_STATUS_BYTES),
      detail: String(execution.stderr ?? "").slice(-2_000),
    };
  } catch (error) {
    return { state: "failed", summary: "", detail: String(error?.message ?? error).slice(-2_000) };
  }
}

function requestAt(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request is invalid");
  for (const key of ["pipeline_run_id", "attempt_id", "request_hash", "definition_bundle_hash", "lease_id"]) {
    if (typeof value[key] !== "string") throw new Error(`request.${key} is invalid`);
  }
  if (!ID.test(value.attempt_id)) throw new Error("request.attempt_id is invalid");
  return value;
}

function hasSealedRuntimeResult(path, request) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_STATE_FILE_BYTES) return false;
    const value = JSON.parse(readFileSync(descriptor, "utf8"));
    return value?.schema === "openthrottle.kernel-runtime-result/v1" &&
      value.pipeline_run_id === request.pipeline_run_id &&
      value.attempt_id === request.attempt_id &&
      value.request_hash === request.request_hash &&
      value.definition_bundle_hash === request.definition_bundle_hash &&
      value.lease_id === request.lease_id &&
      value.worker_id === request.worker_id &&
      value.outcome && typeof value.outcome === "object" && !Array.isArray(value.outcome) &&
      SEALED_OUTCOME_STATES.has(value.outcome.state);
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function stageAttemptForensics({ env = process.env, exitCode }) {
  const resultPath = resolve(env.OT_ACTION_RESULT_FILE);
  const descriptorPath = resolve(env.OT_ACTION_FORENSICS_FILE);
  const stdoutPath = resolve(env.OT_ACTION_RUNNER_STDOUT_FILE);
  const stderrPath = resolve(env.OT_ACTION_RUNNER_STDERR_FILE);
  const sessionPath = resolve(env.OT_ACTION_SESSION_FILE);
  if (dirname(descriptorPath) !== dirname(resultPath)) {
    throw new Error("forensics descriptor escapes the result directory");
  }
  const request = requestAt(resolve(env.OT_ACTION_REQUEST_FILE));
  if (hasSealedRuntimeResult(resultPath, request)) return null;
  const actionRoot = resolve(env.OT_ACTION_ROOT ?? "/var/lib/openthrottle/actions");
  const actionDirectory = join(actionRoot, request.attempt_id.replaceAll(":", "-"));
  const runnerStdoutTail = boundedTail(stdoutPath);
  const runnerStderrTail = boundedTail(stderrPath);
  const resultPathState = fileState(resultPath);
  const sessionEventState = fileState(sessionPath);
  const workspace = workspaceStatus(join(actionDirectory, "repository"));
  const signatureInput = {
    exit_code: exitCode,
    runner_stdout_tail: operationalTail(runnerStdoutTail),
    runner_stderr_tail: operationalTail(runnerStderrTail),
    // Retry-local candidate and session bytes are retained as evidence but do
    // not distinguish the operational failure that prevented a sealed result.
    result_path_state: resultPathState.state,
    session_event_state: sessionEventState.state,
  };
  const operationalSignature = createHash("sha256")
    .update(JSON.stringify(signatureInput))
    .digest("hex");
  return stageJsonEvidenceArtifact({
    directory: dirname(resultPath),
    descriptorPath,
    value: {
      schema: ATTEMPT_FORENSICS_SCHEMA,
      pipeline_run_id: request.pipeline_run_id,
      attempt_id: request.attempt_id,
      request_hash: request.request_hash,
      definition_bundle_hash: request.definition_bundle_hash,
      lease_id: request.lease_id,
      operational_signature: operationalSignature,
      exit_code: exitCode,
      runner_stdout_tail: runnerStdoutTail,
      runner_stderr_tail: runnerStderrTail,
      result_path_state: resultPathState,
      session_event_state: sessionEventState,
      workspace_git_status: workspace,
    },
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const exitCode = Number(process.argv[2]);
  if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new Error("forensics exit code is invalid");
  }
  stageAttemptForensics({ exitCode });
}
