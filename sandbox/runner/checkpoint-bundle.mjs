import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { runGitAsExecutor } from "./repository-control.mjs";

export const CHECKPOINT_WIRE_SCHEMA = "openthrottle.attempt-checkpoint-wire/v1";
export const CHECKPOINT_PAYLOAD_SCHEMA = "openthrottle.git-checkpoint-bundle/v1";
export const MAX_CHECKPOINT_BUNDLE_BYTES = 64 * 1024 * 1024;

const SUBJECT = /^[a-f0-9]{40,64}$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: "OpenThrottle Executor",
  GIT_AUTHOR_EMAIL: "executor@openthrottle.local",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "OpenThrottle Executor",
  GIT_COMMITTER_EMAIL: "executor@openthrottle.local",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

function checkpointId(requestHash) {
  return `checkpoint:${requestHash.slice(0, 32)}`;
}

function artifactName(request) {
  const stem = `${request.attempt_id}-${request.lease_id ?? request.request_hash.slice(0, 16)}`;
  const safe = stem.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 170);
  const name = `${safe}.checkpoint.bundle`;
  if (!SAFE_FILE.test(name)) throw new Error("checkpoint artifact filename is invalid");
  return name;
}

export function createAttemptCheckpoint({
  request,
  repository,
  verification,
  outputSubject,
  nativeSessionId,
  artifactDirectory,
  capturedAt = new Date().toISOString(),
}) {
  if (!SUBJECT.test(verification.output_subject)) throw new Error("checkpoint output tree is invalid");
  if (outputSubject !== null && outputSubject !== verification.output_subject) {
    throw new Error("checkpoint output subject does not match executor verification");
  }
  mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(tmpdir(), "ot-kernel-checkpoint-"));
  const gitDir = join(temporary, "repository.git");
  const file = artifactName(request);
  const bundlePath = join(artifactDirectory, file);
  const checkpointRef = `refs/openthrottle/checkpoints/${request.request_hash}`;
  let checkpointCommit;
  try {
    mkdirSync(gitDir, { recursive: true, mode: 0o700 });
    runGitAsExecutor(temporary, ["init", "--quiet", "--bare", gitDir]);
    const environment = {
      GIT_DIR: gitDir,
      GIT_OBJECT_DIRECTORY: join(gitDir, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [
        repository.executor_object_dir,
        join(repository.destination, ".git", "objects"),
      ].join(delimiter),
      GIT_NO_REPLACE_OBJECTS: "1",
    };
    const parent = repository.head_commit;
    checkpointCommit = runGitAsExecutor(temporary, [
      "commit-tree", verification.output_subject,
      "-p", parent,
      "-m", "OpenThrottle attempt checkpoint",
    ], { ...environment, ...AUTHOR_ENV });
    runGitAsExecutor(temporary, [
      "update-ref", checkpointRef, checkpointCommit,
    ], environment);
    runGitAsExecutor(temporary, [
      "bundle", "create", bundlePath, checkpointRef,
    ], environment);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const bytes = statSync(bundlePath).size;
  if (bytes < 1 || bytes > MAX_CHECKPOINT_BUNDLE_BYTES) {
    throw new Error(`checkpoint bundle exceeds ${MAX_CHECKPOINT_BUNDLE_BYTES} bytes`);
  }
  const sha256 = createHash("sha256").update(readFileSync(bundlePath)).digest("hex");
  return {
    schema: CHECKPOINT_WIRE_SCHEMA,
    id: checkpointId(request.request_hash),
    pipeline_run_id: request.pipeline_run_id,
    attempt_id: request.attempt_id,
    request_hash: request.request_hash,
    definition_bundle_hash: request.definition_bundle_hash,
    input_subject: request.input_subject,
    // Mutating subjects are executor commits, never model-authored commits or
    // bare content trees. The accepted tree is separately bound below.
    output_subject: outputSubject === null ? null : checkpointCommit,
    native_session_id: nativeSessionId,
    payload_schema: CHECKPOINT_PAYLOAD_SCHEMA,
    payload_artifact: {
      file: basename(bundlePath),
      sha256,
      bytes,
      media_type: "application/x-git-bundle",
      payload_schema: CHECKPOINT_PAYLOAD_SCHEMA,
      ref: checkpointRef,
      commit: checkpointCommit,
      tree: verification.output_subject,
    },
    captured_at: capturedAt,
  };
}
