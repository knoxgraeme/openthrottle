import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

function requireSubject(value, label) {
  if (typeof value !== "string" || !SUBJECT.test(value)) {
    throw new Error(`${label} must be a Git object id`);
  }
  return value;
}

function requireObjectType(repoDir, subject, expected, environment, label) {
  const type = runGitAsExecutor(repoDir, ["cat-file", "-t", subject], environment);
  if (type !== expected) throw new Error(`${label} must name a ${expected}`);
  return subject;
}

function requireCheckpointCommit(repoDir, commit, parent, tree, environment) {
  requireObjectType(repoDir, commit, "commit", environment, "checkpoint artifact commit");
  const raw = runGitAsExecutor(repoDir, ["cat-file", "-p", commit], environment);
  const headers = raw.split("\n\n", 1)[0].split("\n");
  const treeHeaders = headers.filter((line) => line.startsWith("tree "));
  const parentHeaders = headers.filter((line) => line.startsWith("parent "));
  if (treeHeaders.length !== 1 || treeHeaders[0] !== `tree ${tree}`) {
    throw new Error("checkpoint artifact commit changed its verified tree");
  }
  if (parentHeaders.length !== 1 || parentHeaders[0] !== `parent ${parent}`) {
    throw new Error("checkpoint artifact commit must have exactly its sealed parent");
  }
  return commit;
}

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
  const requestInputSubject = requireSubject(request.input_subject, "checkpoint input subject");
  const checkpointBaseSubject = requireSubject(
    request.checkpoint_base_subject,
    "checkpoint base subject",
  );
  if (repository.requested_input_subject !== requestInputSubject) {
    throw new Error("checkpoint input subject does not match the action repository");
  }
  const inputTree = requireSubject(repository.input_subject, "checkpoint input tree");
  if (verification.input_subject !== inputTree) {
    throw new Error("checkpoint verification changed the input tree");
  }
  const outputTree = requireSubject(verification.output_subject, "checkpoint output tree");
  if (outputSubject !== null && outputSubject !== verification.output_subject) {
    throw new Error("checkpoint output subject does not match executor verification");
  }
  const durableEdit = outputSubject !== null;
  const identityEdit = durableEdit && outputTree === inputTree;
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
    // A publishable edit retains the real input commit as its parent. The
    // DefinitionBundle source commit is the stable shallow boundary, so the
    // artifact carries the complete run-authored chain needed for first
    // publication while excluding all older or deleted pre-run history.
    const environment = {
      GIT_DIR: gitDir,
      GIT_OBJECT_DIRECTORY: join(gitDir, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: (durableEdit ? [
        repository.executor_object_dir,
        repository.executor_source_object_dir,
      ] : [
        repository.executor_object_dir,
        join(repository.destination, ".git", "objects"),
      ]).join(delimiter),
      GIT_NO_REPLACE_OBJECTS: "1",
    };
    const validationEnvironment = {
      ...environment,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [
        repository.executor_object_dir,
        repository.executor_source_object_dir,
        join(repository.destination, ".git", "objects"),
      ].join(delimiter),
    };
    requireObjectType(
      temporary,
      requestInputSubject,
      "commit",
      validationEnvironment,
      "checkpoint input subject",
    );
    const exactInputTree = requireSubject(
      runGitAsExecutor(
        temporary,
        ["rev-parse", `${requestInputSubject}^{tree}`],
        validationEnvironment,
      ),
      "checkpoint input subject tree",
    );
    if (exactInputTree !== inputTree) {
      throw new Error("checkpoint input commit changed its action tree");
    }
    requireObjectType(
      temporary,
      checkpointBaseSubject,
      "commit",
      validationEnvironment,
      "checkpoint base subject",
    );
    try {
      runGitAsExecutor(temporary, [
        "merge-base", "--is-ancestor", checkpointBaseSubject, requestInputSubject,
      ], validationEnvironment);
    } catch {
      throw new Error("checkpoint input subject does not descend from its sealed run base");
    }
    requireObjectType(
      temporary,
      outputTree,
      "tree",
      validationEnvironment,
      "checkpoint output subject",
    );
    if (identityEdit) {
      checkpointCommit = requestInputSubject;
    } else {
      const parent = durableEdit
        ? requestInputSubject
        : requireSubject(repository.head_commit, "synthetic checkpoint parent");
      checkpointCommit = runGitAsExecutor(temporary, [
        "commit-tree", outputTree,
        "-p", parent,
        "-m", "OpenThrottle attempt checkpoint",
      ], { ...environment, ...AUTHOR_ENV });
      requireCheckpointCommit(
        temporary,
        checkpointCommit,
        parent,
        outputTree,
        environment,
      );
    }
    if (durableEdit) {
      writeFileSync(join(gitDir, "shallow"), `${checkpointBaseSubject}\n`, { mode: 0o400 });
    }
    runGitAsExecutor(temporary, [
      "update-ref", checkpointRef, checkpointCommit,
    ], environment);
    runGitAsExecutor(temporary, [
      "bundle", "create", bundlePath, checkpointRef,
    ], environment);
    const advertised = runGitAsExecutor(temporary, [
      "bundle", "list-heads", bundlePath, checkpointRef,
    ], environment);
    if (advertised !== `${checkpointCommit} ${checkpointRef}`) {
      throw new Error("checkpoint bundle changed its sealed ref");
    }
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
      tree: outputTree,
    },
    captured_at: capturedAt,
  };
}
