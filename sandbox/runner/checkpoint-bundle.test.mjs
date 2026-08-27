import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  materializeActionRepository,
  verifyActionRepository,
} from "./action-repository.mjs";
import { createAttemptCheckpoint } from "./checkpoint-bundle.mjs";

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function gitSucceeds(repo, ...args) {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }).status === 0;
}

function shallowGit(repo, boundary, ...args) {
  const shallowFile = join(repo, ".git", "openthrottle-test-shallow");
  writeFileSync(shallowFile, `${boundary}\n`);
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_SHALLOW_FILE: shallowFile },
  }).trim();
}

function sourceRepository() {
  const repo = mkdtempSync(join(tmpdir(), "ot-checkpoint-source-"));
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "ancestor.txt"), "ancestor\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "ancestor");
  const ancestor = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "value.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "base");
  return {
    repo,
    ancestor,
    subject: git(repo, "rev-parse", "HEAD"),
    tree: git(repo, "rev-parse", "HEAD^{tree}"),
  };
}

function request({ attempt, requestHash, inputSubject, checkpointBaseSubject = inputSubject }) {
  return {
    pipeline_run_id: "run-1",
    attempt_id: attempt,
    lease_id: `lease-${attempt}`,
    request_hash: requestHash,
    definition_bundle_hash: "b".repeat(64),
    checkpoint_base_subject: checkpointBaseSubject,
    input_subject: inputSubject,
  };
}

function editCheckpoint({
  sourceRepoDir,
  inputSubject,
  checkpointBaseSubject = inputSubject,
  actionDirectory,
  attempt,
  requestHash,
  edit,
}) {
  const repository = materializeActionRepository({
    sourceRepoDir,
    inputSubject,
    repositoryAuthority: "edit",
    destination: join(actionDirectory, `${attempt}-repository`),
  });
  edit(repository.destination);
  const verification = verifyActionRepository(repository);
  const checkpoint = createAttemptCheckpoint({
    request: request({ attempt, requestHash, inputSubject, checkpointBaseSubject }),
    repository,
    verification,
    outputSubject: verification.output_subject,
    nativeSessionId: `session-${attempt}`,
    artifactDirectory: actionDirectory,
    capturedAt: "2026-08-20T00:00:00.000Z",
  });
  return { repository, verification, checkpoint };
}

function fetchCheckpoint(repo, actionDirectory, checkpoint, boundary = checkpoint.input_subject) {
  const bundlePath = join(actionDirectory, checkpoint.payload_artifact.file);
  shallowGit(
    repo,
    boundary,
    "fetch", "--quiet", bundlePath, checkpoint.payload_artifact.ref,
  );
  return bundlePath;
}

function stableCheckpointRef(commit) {
  return `refs/openthrottle/checkpoints/${createHash("sha256")
    .update(commit, "utf8")
    .digest("hex")}`;
}

describe("attempt checkpoint bundle", () => {
  it("authors a bounded shallow exact-parent bundle and identity-bound wire checkpoint", () => {
    const source = sourceRepository();
    const actionDirectory = mkdtempSync(join(tmpdir(), "ot-checkpoint-action-"));
    const { repository, verification, checkpoint } = editCheckpoint({
      sourceRepoDir: source.repo,
      inputSubject: source.subject,
      actionDirectory,
      attempt: "attempt-1",
      requestHash: "a".repeat(64),
      edit(destination) {
        writeFileSync(join(destination, "value.txt"), "implemented\n");
        writeFileSync(join(destination, "new.txt"), "proof\n");
      },
    });

    expect(checkpoint).toMatchObject({
      schema: "openthrottle.attempt-checkpoint-wire/v1",
      pipeline_run_id: "run-1",
      attempt_id: "attempt-1",
      request_hash: "a".repeat(64),
      definition_bundle_hash: "b".repeat(64),
      input_subject: source.subject,
      output_subject: expect.stringMatching(/^[a-f0-9]{40,64}$/),
      native_session_id: "session-attempt-1",
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      payload_artifact: {
        file: expect.stringMatching(/\.checkpoint\.bundle$/),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        bytes: expect.any(Number),
        media_type: "application/x-git-bundle",
        payload_schema: "openthrottle.git-checkpoint-bundle/v1",
        ref: stableCheckpointRef(checkpoint.payload_artifact.commit),
        commit: expect.stringMatching(/^[a-f0-9]{40,64}$/),
        tree: verification.output_subject,
      },
      captured_at: "2026-08-20T00:00:00.000Z",
    });
    const bundlePath = join(actionDirectory, checkpoint.payload_artifact.file);
    expect(statSync(bundlePath).size).toBe(checkpoint.payload_artifact.bytes);
    expect(() => shallowGit(source.repo, source.subject, "bundle", "verify", bundlePath))
      .not.toThrow();

    expect(checkpoint.output_subject).toBe(checkpoint.payload_artifact.commit);
    expect(gitSucceeds(repository.destination, "cat-file", "-e", `${source.subject}^{commit}`))
      .toBe(false);
    expect(git(repository.destination, "rev-list", "--parents", "-n", "1", "HEAD").split(" "))
      .toHaveLength(1);

    const restored = mkdtempSync(join(tmpdir(), "ot-checkpoint-restored-"));
    git(restored, "init", "--quiet");
    shallowGit(
      restored,
      source.subject,
      "fetch", "--quiet", bundlePath, checkpoint.payload_artifact.ref,
    );
    git(restored, "switch", "--quiet", "--detach", checkpoint.payload_artifact.commit);
    expect(git(restored, "cat-file", "-t", checkpoint.payload_artifact.commit)).toBe("commit");
    expect(git(restored, "rev-parse", `${checkpoint.payload_artifact.commit}^`))
      .toBe(source.subject);
    expect(git(restored, "rev-list", "--parents", "-n", "1", checkpoint.payload_artifact.commit)
      .split(" ")).toHaveLength(2);
    expect(git(restored, "rev-parse", `${checkpoint.payload_artifact.commit}^{tree}`))
      .toBe(checkpoint.payload_artifact.tree);
    expect(gitSucceeds(restored, "cat-file", "-e", `${source.ancestor}^{commit}`)).toBe(false);
    expect(readFileSync(join(restored, "value.txt"), "utf8")).toBe("implemented\n");
    expect(readFileSync(join(restored, "new.txt"), "utf8")).toBe("proof\n");
    expect(basename(bundlePath)).toBe(checkpoint.payload_artifact.file);
  });

  it("chains two successive edits through their exact input commits without widening agent Git authority", () => {
    const source = sourceRepository();
    const actionDirectory = mkdtempSync(join(tmpdir(), "ot-checkpoint-successors-"));
    const first = editCheckpoint({
      sourceRepoDir: source.repo,
      inputSubject: source.subject,
      actionDirectory,
      attempt: "attempt-1",
      requestHash: "c".repeat(64),
      edit(destination) {
        writeFileSync(join(destination, "value.txt"), "first edit\n");
      },
    });
    fetchCheckpoint(source.repo, actionDirectory, first.checkpoint);

    const second = editCheckpoint({
      sourceRepoDir: source.repo,
      inputSubject: first.checkpoint.output_subject,
      checkpointBaseSubject: source.subject,
      actionDirectory,
      attempt: "attempt-2",
      requestHash: "d".repeat(64),
      edit(destination) {
        writeFileSync(join(destination, "value.txt"), "second edit\n");
        writeFileSync(join(destination, "second.txt"), "second proof\n");
      },
    });

    expect(gitSucceeds(
      second.repository.destination,
      "cat-file",
      "-e",
      `${first.checkpoint.output_subject}^{commit}`,
    )).toBe(false);
    expect(git(
      second.repository.destination,
      "rev-list",
      "--parents",
      "-n",
      "1",
      "HEAD",
    ).split(" ")).toHaveLength(1);

    const existingSourceBundle = fetchCheckpoint(
      source.repo,
      actionDirectory,
      second.checkpoint,
      source.subject,
    );
    expect(git(source.repo, "rev-parse", `${first.checkpoint.output_subject}^`))
      .toBe(source.subject);
    expect(git(source.repo, "rev-parse", `${second.checkpoint.output_subject}^`))
      .toBe(first.checkpoint.output_subject);
    expect(() => git(
      source.repo,
      "merge-base",
      "--is-ancestor",
      source.ancestor,
      second.checkpoint.output_subject,
    )).not.toThrow();

    const verifier = mkdtempSync(join(tmpdir(), "ot-checkpoint-verifier-"));
    git(verifier, "init", "--quiet");
    shallowGit(
      verifier,
      source.subject,
      "fetch", "--quiet", existingSourceBundle, second.checkpoint.payload_artifact.ref,
    );
    expect(git(verifier, "rev-parse", `${second.checkpoint.output_subject}^`))
      .toBe(first.checkpoint.output_subject);
    expect(git(verifier, "rev-parse", `${first.checkpoint.output_subject}^`))
      .toBe(source.subject);
    expect(gitSucceeds(verifier, "cat-file", "-e", `${source.subject}^{commit}`)).toBe(true);
    expect(gitSucceeds(verifier, "cat-file", "-e", `${source.ancestor}^{commit}`)).toBe(false);
    expect(git(verifier, "rev-parse", `${second.checkpoint.output_subject}^{tree}`))
      .toBe(second.checkpoint.payload_artifact.tree);
  });

  it("preserves the exact input commit when an edit leaves the content tree unchanged", () => {
    const source = sourceRepository();
    const actionDirectory = mkdtempSync(join(tmpdir(), "ot-checkpoint-identity-"));
    const { repository, checkpoint } = editCheckpoint({
      sourceRepoDir: source.repo,
      inputSubject: source.subject,
      actionDirectory,
      attempt: "attempt-identity",
      requestHash: "f".repeat(64),
      edit() {},
    });

    expect(checkpoint.output_subject).toBe(source.subject);
    expect(checkpoint.payload_artifact).toMatchObject({
      commit: source.subject,
      tree: source.tree,
    });
    expect(gitSucceeds(repository.destination, "cat-file", "-e", `${source.subject}^{commit}`))
      .toBe(false);

    const verifier = mkdtempSync(join(tmpdir(), "ot-checkpoint-identity-verifier-"));
    git(verifier, "init", "--quiet");
    fetchCheckpoint(verifier, actionDirectory, checkpoint);
    expect(git(verifier, "rev-parse", "FETCH_HEAD")).toBe(source.subject);
    expect(git(verifier, "rev-parse", "FETCH_HEAD^{tree}")).toBe(source.tree);
  });

  it("carries three unpublished edits from the stable remotely-known run base", () => {
    const source = sourceRepository();
    const actionDirectory = mkdtempSync(join(tmpdir(), "ot-checkpoint-three-edits-"));
    let inputSubject = source.subject;
    const checkpoints = [];
    for (const [index, value] of ["one", "two", "three"].entries()) {
      const created = editCheckpoint({
        sourceRepoDir: source.repo,
        inputSubject,
        checkpointBaseSubject: source.subject,
        actionDirectory,
        attempt: `attempt-${value}`,
        requestHash: String(index + 1).repeat(64),
        edit(destination) {
          writeFileSync(join(destination, `${value}.txt`), `${value}\n`);
        },
      });
      checkpoints.push(created.checkpoint);
      inputSubject = created.checkpoint.output_subject;
      if (index < 2) fetchCheckpoint(
        source.repo,
        actionDirectory,
        created.checkpoint,
        source.subject,
      );
    }

    const final = checkpoints[2];
    const verifier = mkdtempSync(join(tmpdir(), "ot-checkpoint-three-edits-verifier-"));
    git(verifier, "init", "--quiet");
    fetchCheckpoint(verifier, actionDirectory, final, source.subject);
    expect(git(verifier, "rev-parse", `${final.output_subject}^`)).toBe(checkpoints[1].output_subject);
    expect(git(verifier, "rev-parse", `${checkpoints[1].output_subject}^`))
      .toBe(checkpoints[0].output_subject);
    expect(git(verifier, "rev-parse", `${checkpoints[0].output_subject}^`)).toBe(source.subject);
    expect(gitSucceeds(verifier, "cat-file", "-e", `${source.subject}^{commit}`)).toBe(true);
    expect(gitSucceeds(verifier, "cat-file", "-e", `${source.ancestor}^{commit}`)).toBe(false);
  }, 15_000);

  it("does not package a large blob reachable only through deleted history", () => {
    const source = sourceRepository();
    const historicalPath = join(source.repo, "deleted-history.bin");
    writeFileSync(historicalPath, randomBytes(2 * 1024 * 1024));
    git(source.repo, "add", "deleted-history.bin");
    git(source.repo, "commit", "--quiet", "-m", "large historical blob");
    const historicalBlob = git(source.repo, "rev-parse", "HEAD:deleted-history.bin");
    unlinkSync(historicalPath);
    git(source.repo, "add", "-u");
    git(source.repo, "commit", "--quiet", "-m", "delete historical blob");
    const inputSubject = git(source.repo, "rev-parse", "HEAD");
    const actionDirectory = mkdtempSync(join(tmpdir(), "ot-checkpoint-deleted-history-"));
    const { checkpoint } = editCheckpoint({
      sourceRepoDir: source.repo,
      inputSubject,
      actionDirectory,
      attempt: "attempt-deleted-history",
      requestHash: "9".repeat(64),
      edit(destination) {
        writeFileSync(join(destination, "value.txt"), "small edit\n");
      },
    });

    expect(checkpoint.payload_artifact.bytes).toBeLessThan(256 * 1024);
    const verifier = mkdtempSync(join(tmpdir(), "ot-checkpoint-deleted-history-verifier-"));
    git(verifier, "init", "--quiet");
    fetchCheckpoint(verifier, actionDirectory, checkpoint);
    expect(git(verifier, "rev-parse", `${checkpoint.output_subject}^`)).toBe(inputSubject);
    expect(gitSucceeds(verifier, "cat-file", "-e", historicalBlob)).toBe(false);
  });

  it("keeps inspect output null while emitting a verifiable synthetic tree-only descriptor", () => {
    const source = sourceRepository();
    const actionDirectory = mkdtempSync(join(tmpdir(), "ot-checkpoint-inspect-"));
    const repository = materializeActionRepository({
      sourceRepoDir: source.repo,
      inputSubject: source.subject,
      repositoryAuthority: "inspect",
      destination: join(actionDirectory, "repository"),
    });
    const verification = verifyActionRepository(repository);
    const checkpoint = createAttemptCheckpoint({
      request: request({
        attempt: "inspect-1",
        requestHash: "e".repeat(64),
        inputSubject: source.subject,
      }),
      repository,
      verification,
      outputSubject: null,
      nativeSessionId: "session-inspect-1",
      artifactDirectory: actionDirectory,
    });

    expect(checkpoint.output_subject).toBeNull();
    expect(checkpoint.payload_artifact.commit).toMatch(/^[a-f0-9]{40,64}$/);
    const verifier = mkdtempSync(join(tmpdir(), "ot-checkpoint-inspect-verifier-"));
    git(verifier, "init", "--quiet");
    fetchCheckpoint(verifier, actionDirectory, checkpoint);
    expect(git(verifier, "cat-file", "-t", checkpoint.payload_artifact.commit)).toBe("commit");
    expect(git(verifier, "rev-parse", `${checkpoint.payload_artifact.commit}^`))
      .toBe(repository.head_commit);
    expect(git(verifier, "rev-list", "--parents", "-n", "1", checkpoint.payload_artifact.commit)
      .split(" ")).toHaveLength(2);
    expect(git(verifier, "rev-parse", `${checkpoint.payload_artifact.commit}^{tree}`))
      .toBe(source.tree);
    expect(gitSucceeds(verifier, "cat-file", "-e", `${source.subject}^{commit}`)).toBe(false);
  });

  it("reuses byte-identical inspect bundle evidence across distinct attempts", () => {
    const source = sourceRepository();
    const actionDirectory = mkdtempSync(join(tmpdir(), "ot-checkpoint-inspect-dedupe-"));
    const repository = materializeActionRepository({
      sourceRepoDir: source.repo,
      inputSubject: source.subject,
      repositoryAuthority: "inspect",
      destination: join(actionDirectory, "repository"),
    });
    const verification = verifyActionRepository(repository);
    const create = ({ attempt, requestHash, nativeSessionId, capturedAt }) =>
      createAttemptCheckpoint({
        request: request({ attempt, requestHash, inputSubject: source.subject }),
        repository,
        verification,
        outputSubject: null,
        nativeSessionId,
        artifactDirectory: actionDirectory,
        capturedAt,
      });
    const first = create({
      attempt: "inspect-dedupe-1",
      requestHash: "1".repeat(64),
      nativeSessionId: "session-inspect-dedupe-1",
      capturedAt: "2026-08-20T00:00:00.000Z",
    });
    const second = create({
      attempt: "inspect-dedupe-2",
      requestHash: "2".repeat(64),
      nativeSessionId: "session-inspect-dedupe-2",
      capturedAt: "2026-08-21T00:00:00.000Z",
    });

    expect(first.id).not.toBe(second.id);
    expect(first.request_hash).not.toBe(second.request_hash);
    expect(first.attempt_id).not.toBe(second.attempt_id);
    expect(first.native_session_id).not.toBe(second.native_session_id);
    expect(first.captured_at).not.toBe(second.captured_at);
    expect(second.payload_artifact).toMatchObject({
      commit: first.payload_artifact.commit,
      tree: first.payload_artifact.tree,
      ref: first.payload_artifact.ref,
      sha256: first.payload_artifact.sha256,
      bytes: first.payload_artifact.bytes,
    });
    expect(readFileSync(join(actionDirectory, second.payload_artifact.file)))
      .toEqual(readFileSync(join(actionDirectory, first.payload_artifact.file)));
  });
});
