import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { runCapturedProcess } from "./bounded-process.mjs";
import {
  chownTree,
  chmodReadOnlyPreservingExecuteTree,
  identityForUser,
  isRoot,
} from "./filesystem-isolation.mjs";
import {
  executorGitEnvironment,
  runGitAsExecutor,
  stageCanonicalWorkspaceIndex,
} from "./repository-control.mjs";

const SUBJECT = /^[a-f0-9]{40,64}$/;
const CAPTURE_OMISSION = /\n\.\.\.\[\d+ output bytes omitted\]\.\.\.\n/u;
export const INSPECT_CHANGE_CONTEXT_SCHEMA = "openthrottle.inspect-change-context/v1";
export const INSPECT_CHANGE_ARTIFACT_MAX_BYTES = 512 * 1024;
export const INSPECT_CHANGED_PATHS_MAX_BYTES = 128 * 1024;
export const INSPECT_TEXT_DIFF_MAX_BYTES = 256 * 1024;
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

function commitForSubject(repoDir, subject, label) {
  const resolved = requireSubject(
    runGitAsExecutor(repoDir, ["rev-parse", subject]),
    label,
  );
  const type = runGitAsExecutor(repoDir, ["cat-file", "-t", resolved]);
  if (type !== "commit") {
    throw new Error(`${label} must name a commit`);
  }
  return {
    commit: resolved,
    tree: requireSubject(
      runGitAsExecutor(repoDir, ["rev-parse", `${resolved}^{tree}`]),
      `${label} tree`,
    ),
  };
}

function sourceObjectDirectory(repoDir) {
  const commonGitDirectory = runGitAsExecutor(repoDir, ["rev-parse", "--git-common-dir"]);
  const objectDirectory = resolve(repoDir, commonGitDirectory, "objects");
  const metadata = lstatSync(objectDirectory);
  if (!metadata.isDirectory()) {
    throw new Error("executor source Git object store must be a directory");
  }
  return objectDirectory;
}

function packTree(repoDir, tree, destinationPackBase) {
  const entries = runGitAsExecutor(repoDir, [
    "ls-tree", "-r", "-t", "--full-tree", tree,
  ]);
  const objectIds = new Set([tree]);
  for (const line of entries.split("\n").filter(Boolean)) {
    const match = /^\d{6} (blob|tree|commit) ([a-f0-9]{40,64})\t/.exec(line);
    if (!match) throw new Error("Git returned an invalid tree entry");
    // Gitlinks point into another repository. Their object id is already part
    // of the enclosing tree and must not be disclosed from an unrelated store.
    if (match[1] !== "commit") objectIds.add(match[2]);
  }
  const result = runCapturedProcess("git", [
    "-c", `safe.directory=${repoDir}`,
    "pack-objects", destinationPackBase,
  ], {
    cwd: repoDir,
    env: executorGitEnvironment(),
    input: `${[...objectIds].join("\n")}\n`,
    timeout: 120_000,
    captureBytes: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`could not materialize the exact repository subject: ${String(result.stderr || result.error?.message || "").slice(-800)}`);
  }
}

function syntheticCommit(repoDir, tree, message, parent = null) {
  return requireSubject(runGitAsExecutor(repoDir, [
    "commit-tree", tree,
    ...(parent ? ["-p", parent] : []),
    "-m", message,
  ], AUTHOR_ENV), "executor commit");
}

function boundedGitEvidence(repoDir, args, captureBytes) {
  const result = runCapturedProcess("git", [
    "-c", `safe.directory=${repoDir}`,
    ...args,
  ], {
    cwd: repoDir,
    env: executorGitEnvironment({
      GIT_EXTERNAL_DIFF: "",
      GIT_OPTIONAL_LOCKS: "0",
    }),
    timeout: 120_000,
    captureBytes,
  });
  if (result.error?.code === "ETIMEDOUT") throw new Error(`git ${args.join(" ")} timed out`);
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr || result.error?.message || "").slice(-1_000)}`);
  }
  return CAPTURE_OMISSION.test(result.stdout) ? null : result.stdout;
}

function serializeInspectChangeArtifact(artifact) {
  let serialized = `${JSON.stringify(artifact)}\n`;
  if (Buffer.byteLength(serialized, "utf8") <= INSPECT_CHANGE_ARTIFACT_MAX_BYTES) {
    return serialized;
  }
  artifact.textual_diff = null;
  if (!artifact.omissions.some(({ section }) => section === "textual_diff")) {
    artifact.omissions.push({
      section: "textual_diff",
      reason: "artifact_size_bound",
      limit_bytes: INSPECT_CHANGE_ARTIFACT_MAX_BYTES,
    });
  }
  serialized = `${JSON.stringify(artifact)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > INSPECT_CHANGE_ARTIFACT_MAX_BYTES) {
    artifact.changed_paths = null;
    if (!artifact.omissions.some(({ section }) => section === "changed_paths")) {
      artifact.omissions.push({
        section: "changed_paths",
        reason: "artifact_size_bound",
        limit_bytes: INSPECT_CHANGE_ARTIFACT_MAX_BYTES,
      });
    }
    serialized = `${JSON.stringify(artifact)}\n`;
  }
  if (Buffer.byteLength(serialized, "utf8") > INSPECT_CHANGE_ARTIFACT_MAX_BYTES) {
    throw new Error("inspect change artifact exceeds its byte bound");
  }
  return serialized;
}

function makeAgentWritable(path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path)) makeAgentWritable(resolve(path, entry));
    return;
  }
  chmodSync(path, (metadata.mode & 0o111) === 0 ? 0o644 : 0o755);
}

function sealRepositoryAdministration(destination) {
  const gitDir = join(destination, ".git");
  if (isRoot()) chownTree(gitDir, 0, 0);
  chmodReadOnlyPreservingExecuteTree(gitDir);
}

function authorizeWorkingTree(destination, authority) {
  if (authority === "inspect") {
    if (isRoot()) chownTree(destination, 0, 0);
    chmodReadOnlyPreservingExecuteTree(destination);
    return;
  }

  const identity = identityForUser("agent");
  if (identity) {
    chownSync(destination, identity.uid, identity.gid);
    for (const entry of readdirSync(destination)) {
      if (entry !== ".git") chownTree(join(destination, entry), identity.uid, identity.gid);
    }
  }
  makeAgentWritable(destination);
  sealRepositoryAdministration(destination);
}

function fileFingerprint(path) {
  if (!existsSync(path)) return null;
  const metadata = lstatSync(path);
  if (!metadata.isFile()) throw new Error(`executor Git control path is not a file: ${path}`);
  const content = readFileSync(path);
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    uid: metadata.uid,
    gid: metadata.gid,
    mode: metadata.mode & 0o7777,
    bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function captureGitControl(destination) {
  const gitDir = join(destination, ".git");
  const metadata = lstatSync(gitDir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("executor Git administration must be a real directory");
  }
  return {
    directory: {
      dev: metadata.dev,
      ino: metadata.ino,
      uid: metadata.uid,
      gid: metadata.gid,
      mode: metadata.mode & 0o7777,
    },
    head: fileFingerprint(join(gitDir, "HEAD")),
    config: fileFingerprint(join(gitDir, "config")),
    index: fileFingerprint(join(gitDir, "index")),
    refs: runGitAsExecutor(destination, [
      "for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)",
    ]),
  };
}

function sameControl(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalWorkspaceTree(view) {
  rmSync(view.executor_object_dir, { recursive: true, force: true });
  mkdirSync(view.executor_object_dir, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(tmpdir(), "ot-kernel-action-index-"));
  const environment = {
    GIT_INDEX_FILE: join(scratch, "index"),
    GIT_WORK_TREE: view.destination,
    GIT_OBJECT_DIRECTORY: view.executor_object_dir,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(view.destination, ".git", "objects"),
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  try {
    runGitAsExecutor(view.destination, ["read-tree", view.input_subject], environment);
    stageCanonicalWorkspaceIndex(view.destination, environment, {
      asExecutor: true,
      scratchDir: scratch,
    });
    const output = requireSubject(
      runGitAsExecutor(view.destination, ["write-tree"], environment),
      "action output tree",
    );
    const changed = runGitAsExecutor(view.destination, [
      "-c", "core.quotepath=false",
      "diff", "--name-only", "-z", view.input_subject, output,
    ], environment);
    return {
      output,
      changedPaths: changed === "" ? [] : changed.split("\0").filter(Boolean).sort(),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function materializeActionRepository({
  sourceRepoDir,
  inputSubject,
  repositoryAuthority,
  destination,
  changeBoundary = null,
}) {
  if (repositoryAuthority !== "inspect" && repositoryAuthority !== "edit") {
    throw new Error("repository authority must be inspect or edit");
  }
  const requestedInputSubject = requireSubject(inputSubject, "action input subject");
  const input = commitForSubject(sourceRepoDir, requestedInputSubject, "action input subject");
  const inputTree = input.tree;
  const executorSourceObjectDir = sourceObjectDirectory(sourceRepoDir);
  let boundaryInputTree = null;
  if (changeBoundary !== null) {
    if (repositoryAuthority !== "inspect") {
      throw new Error("only inspect actions may receive a change boundary");
    }
    const boundaryInput = commitForSubject(
      sourceRepoDir,
      changeBoundary.input_subject,
      "change boundary input subject",
    );
    const boundaryOutput = commitForSubject(
      sourceRepoDir,
      changeBoundary.output_subject,
      "change boundary output subject",
    );
    if (changeBoundary.output_subject !== requestedInputSubject) {
      throw new Error("change boundary output must equal the exact action input subject");
    }
    if (boundaryOutput.commit !== input.commit || boundaryOutput.tree !== inputTree) {
      throw new Error("change boundary output must equal the action input subject");
    }
    boundaryInputTree = boundaryInput.tree;
  }

  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  runGitAsExecutor(destination, ["init", "--quiet"]);
  const packDir = join(destination, ".git", "objects", "pack");
  mkdirSync(packDir, { recursive: true, mode: 0o755 });
  packTree(sourceRepoDir, inputTree, join(packDir, "input"));

  const baseTree = boundaryInputTree ?? inputTree;
  if (boundaryInputTree !== null) {
    packTree(sourceRepoDir, baseTree, join(packDir, "boundary"));
  }
  const baseCommit = syntheticCommit(destination, baseTree, "OpenThrottle action boundary");
  const headCommit = baseTree === inputTree
    ? baseCommit
    : syntheticCommit(destination, inputTree, "OpenThrottle accepted action output", baseCommit);
  runGitAsExecutor(destination, ["update-ref", "refs/heads/kernel-action", headCommit]);
  runGitAsExecutor(destination, ["switch", "--quiet", "--detach", headCommit]);
  const disabledRemote = repositoryAuthority === "inspect"
    ? "DISABLED_BY_OPENTHROTTLE_INSPECT"
    : "DISABLED_BY_OPENTHROTTLE_EDIT";
  runGitAsExecutor(destination, ["config", "remote.origin.url", disabledRemote]);
  runGitAsExecutor(destination, ["config", "remote.origin.pushurl", disabledRemote]);
  authorizeWorkingTree(destination, repositoryAuthority);

  const view = {
    destination,
    authority: repositoryAuthority,
    requested_input_subject: requestedInputSubject,
    input_subject: inputTree,
    base_subject: changeBoundary?.input_subject ?? requestedInputSubject,
    base_tree: baseTree,
    change_boundary: changeBoundary === null ? null : {
      checkpoint_id: changeBoundary.checkpoint_id,
      input_subject: changeBoundary.input_subject,
      output_subject: changeBoundary.output_subject,
    },
    base_commit: baseCommit,
    head_commit: headCommit,
    executor_object_dir: join(dirname(destination), "executor-objects"),
    executor_source_object_dir: executorSourceObjectDir,
  };
  view.git_control = captureGitControl(destination);
  return view;
}

export function materializeInspectChangeArtifact({ view, destination }) {
  if (view?.authority !== "inspect" || view.change_boundary === null) {
    throw new Error("inspect change artifact requires an exact accepted-edit boundary");
  }
  const artifactPath = resolve(destination);
  const repositoryRoot = resolve(view.destination);
  const artifactDirectory = join(dirname(repositoryRoot), "inspect-context");
  if (artifactPath !== join(artifactDirectory, "change.json")) {
    throw new Error("inspect change artifact must use its executor-owned dedicated location");
  }
  if (!sameControl(captureGitControl(view.destination), view.git_control)) {
    throw new Error("inspect change artifact source changed executor-owned Git administration");
  }

  const omissions = [];
  const rawPaths = boundedGitEvidence(view.destination, [
    "--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--no-renames",
    "--name-only", "-z", view.base_commit, view.head_commit, "--",
  ], INSPECT_CHANGED_PATHS_MAX_BYTES);
  const rawDiff = boundedGitEvidence(view.destination, [
    "--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--no-renames",
    "--no-color", "--full-index", view.base_commit, view.head_commit, "--",
  ], INSPECT_TEXT_DIFF_MAX_BYTES);
  if (rawPaths === null) {
    omissions.push({
      section: "changed_paths",
      reason: "capture_limit_exceeded",
      limit_bytes: INSPECT_CHANGED_PATHS_MAX_BYTES,
    });
  }
  if (rawDiff === null) {
    omissions.push({
      section: "textual_diff",
      reason: "capture_limit_exceeded",
      limit_bytes: INSPECT_TEXT_DIFF_MAX_BYTES,
    });
  }
  const artifact = {
    schema: INSPECT_CHANGE_CONTEXT_SCHEMA,
    checkpoint_id: view.change_boundary.checkpoint_id,
    base_subject: view.change_boundary.input_subject,
    input_subject: view.change_boundary.output_subject,
    base_tree: view.base_tree,
    input_tree: view.input_subject,
    changed_paths: rawPaths === null
      ? null
      : rawPaths.split("\0").filter(Boolean).sort(),
    textual_diff: rawDiff,
    omissions,
  };
  const serialized = serializeInspectChangeArtifact(artifact);
  if (!sameControl(captureGitControl(view.destination), view.git_control)) {
    throw new Error("inspect change artifact generation changed executor-owned Git administration");
  }
  rmSync(artifactDirectory, { recursive: true, force: true });
  mkdirSync(artifactDirectory, { mode: 0o755 });
  writeFileSync(artifactPath, serialized, { flag: "wx", mode: 0o444 });
  if (isRoot()) {
    chownSync(artifactDirectory, 0, 0);
    chownSync(artifactPath, 0, 0);
  }
  chmodSync(artifactPath, 0o444);
  chmodSync(artifactDirectory, 0o555);
  return {
    schema: INSPECT_CHANGE_CONTEXT_SCHEMA,
    path: artifactPath,
    bytes: Buffer.byteLength(serialized, "utf8"),
    sha256: createHash("sha256").update(serialized).digest("hex"),
  };
}

export function verifyInspectChangeArtifact(descriptor) {
  if (
    descriptor?.schema !== INSPECT_CHANGE_CONTEXT_SCHEMA ||
    typeof descriptor.path !== "string" || !descriptor.path.startsWith("/") ||
    !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1 ||
    descriptor.bytes > INSPECT_CHANGE_ARTIFACT_MAX_BYTES ||
    typeof descriptor.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(descriptor.sha256)
  ) {
    throw new Error("inspect change artifact descriptor is invalid");
  }
  const metadata = lstatSync(descriptor.path);
  const directoryMetadata = lstatSync(dirname(descriptor.path));
  if (
    !directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() ||
    (directoryMetadata.mode & 0o222) !== 0 ||
    (isRoot() && (directoryMetadata.uid !== 0 || directoryMetadata.gid !== 0)) ||
    !metadata.isFile() || metadata.isSymbolicLink() ||
    metadata.size !== descriptor.bytes || (metadata.mode & 0o222) !== 0 ||
    (isRoot() && (metadata.uid !== 0 || metadata.gid !== 0))
  ) {
    throw new Error("inspect change artifact lost its executor-owned read-only seal");
  }
  const actual = createHash("sha256").update(readFileSync(descriptor.path)).digest("hex");
  if (actual !== descriptor.sha256) {
    throw new Error("inspect change artifact content changed after materialization");
  }
  return descriptor;
}

export function verifyActionRepository(view) {
  if (!sameControl(captureGitControl(view.destination), view.git_control)) {
    throw new Error("agent changed executor-owned Git administration");
  }
  const { output, changedPaths } = canonicalWorkspaceTree(view);
  if (!sameControl(captureGitControl(view.destination), view.git_control)) {
    throw new Error("repository verification changed executor-owned Git administration");
  }
  if (view.authority === "inspect" && output !== view.input_subject) {
    throw new Error("inspect action changed the exact repository subject");
  }
  return {
    input_subject: view.input_subject,
    output_subject: output,
    changed_paths: changedPaths,
  };
}

export function lockActionRepository(view) {
  if (!view?.destination) throw new Error("action repository view is invalid");
  if (isRoot()) chownTree(view.destination, 0, 0);
  chmodReadOnlyPreservingExecuteTree(view.destination);
  return view.destination;
}
