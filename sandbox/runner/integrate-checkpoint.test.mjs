import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { materializeActionRepository, verifyActionRepository } from "./action-repository.mjs";
import { createAttemptCheckpoint, MAX_CHECKPOINT_BUNDLE_BYTES } from "./checkpoint-bundle.mjs";
import { integrateCheckpoint } from "./integrate-checkpoint.mjs";

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

function shallowGitSucceeds(repo, boundary, ...args) {
  const shallowFile = join(repo, ".git", "openthrottle-test-shallow");
  writeFileSync(shallowFile, `${boundary}\n`);
  return spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_SHALLOW_FILE: shallowFile },
  }).status === 0;
}

function commitAll(repo, message) {
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", message);
}

function fixture({
  editCandidate = (destination) => writeFileSync(join(destination, "candidate.txt"), "candidate\n"),
  advanceCurrent = (repo) => {
    writeFileSync(join(repo, "current.txt"), "current\n");
    commitAll(repo, "advance current");
  },
} = {}) {
  const repo = mkdtempSync(join(tmpdir(), "ot-integrate-source-"));
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "base.txt"), "base\n");
  commitAll(repo, "base");
  const base = git(repo, "rev-parse", "HEAD");

  const action = mkdtempSync(join(tmpdir(), "ot-integrate-candidate-"));
  const view = materializeActionRepository({
    sourceRepoDir: repo,
    inputSubject: base,
    repositoryAuthority: "edit",
    destination: join(action, "repository"),
  });
  editCandidate(view.destination);
  const verification = verifyActionRepository(view);
  const checkpoint = createAttemptCheckpoint({
    request: {
      pipeline_run_id: "run-1", attempt_id: "attempt-1", lease_id: "lease-1",
      request_hash: "a".repeat(64), definition_bundle_hash: "b".repeat(64),
      checkpoint_base_subject: base, input_subject: base,
    },
    repository: view,
    verification,
    outputSubject: verification.output_subject,
    nativeSessionId: "session-1",
    artifactDirectory: action,
  });

  advanceCurrent?.(repo);
  return { repo, base, current: git(repo, "rev-parse", "HEAD"), action, checkpoint };
}

function integrationFixture(value, suffix = "1") {
  const transport = mkdtempSync(join(tmpdir(), "ot-integrate-transport-"));
  const artifact = value.checkpoint.payload_artifact;
  copyFileSync(join(value.action, artifact.file), join(transport, artifact.file));
  const idempotencyKey = [
    `run-${"a".repeat(48)}`,
    `attempt-${"b".repeat(48)}`,
    "publish-integrate",
    "c".repeat(40),
    `checkpoint:${"d".repeat(32)}`,
    suffix,
  ].join(":");
  const request = {
    schema: "openthrottle.kernel-integration-request/v1",
    pipeline_run_id: "run-1",
    effect_id: `effect-${suffix}`,
    idempotency_key: idempotencyKey,
    lease_id: `lease-integration-${suffix}`,
    worker_id: "worker-1",
    definition_bundle_hash: "b".repeat(64),
    checkpoint_base_subject: value.base,
    current_subject: value.current,
    candidate_checkpoint_id: value.checkpoint.id,
    candidate_input_subject: value.checkpoint.input_subject,
    candidate_output_subject: value.checkpoint.output_subject,
    candidate_artifact: artifact,
  };
  const resultPath = join(transport, "result.json");
  return { artifact, request, resultPath, transport };
}

function integrate(value, suffix = "1") {
  const setup = integrationFixture(value, suffix);
  const result = integrateCheckpoint({
    request: setup.request,
    requestDirectory: setup.transport,
    resultPath: setup.resultPath,
    sourceRepoDir: value.repo,
  });
  return { ...setup, result };
}

function restoreIntegrated({ request, result, transport }) {
  if (result.state !== "integrated") throw new Error(result.reason);
  const bundle = join(transport, result.payload_artifact.file);
  expect(statSync(bundle).size).toBe(result.payload_artifact.bytes);
  expect(result.payload_artifact.bytes).toBeLessThanOrEqual(MAX_CHECKPOINT_BUNDLE_BYTES);

  const restored = mkdtempSync(join(tmpdir(), "ot-integrated-restored-"));
  git(restored, "init", "--quiet");
  expect(() => shallowGit(restored, request.current_subject, "bundle", "verify", bundle))
    .not.toThrow();
  shallowGit(
    restored,
    request.current_subject,
    "fetch", "--quiet", bundle, result.payload_artifact.ref,
  );
  git(restored, "switch", "--quiet", "--detach", result.output_subject);
  expect(git(restored, "rev-parse", `${result.output_subject}^{tree}`))
    .toBe(result.payload_artifact.tree);
  return restored;
}

function expectLineage(repo, boundary, descendant, ancestors) {
  for (const ancestor of ancestors) {
    expect(shallowGitSucceeds(
      repo,
      boundary,
      "merge-base", "--is-ancestor", ancestor, descendant,
    )).toBe(true);
  }
}

describe("executor checkpoint integration", () => {
  it("three-way integrates a stale-tree candidate from the exact current subject", () => {
    const value = fixture();
    const execution = integrate(value);
    const { artifact, request, result } = execution;

    expect(request.idempotency_key.length).toBeGreaterThan(200);
    expect(request.idempotency_key.length).toBeLessThanOrEqual(500);
    expect(result.state, result.reason).toBe("integrated");
    expect(result).toMatchObject({
      schema: "openthrottle.kernel-integration-result/v1",
      state: "integrated",
      input_subject: value.current,
      candidate_checkpoint_id: value.checkpoint.id,
      output_subject: expect.stringMatching(/^[a-f0-9]{40,64}$/),
      payload_artifact: {
        ref: expect.stringMatching(/^refs\/openthrottle\/integrations\//),
        commit: expect.stringMatching(/^[a-f0-9]{40,64}$/),
        tree: expect.stringMatching(/^[a-f0-9]{40,64}$/),
      },
    });
    const restored = restoreIntegrated(execution);
    expect(git(restored, "rev-list", "--parents", "-n", "1", result.output_subject).split(" "))
      .toEqual([result.output_subject, request.current_subject]);
    expectLineage(restored, request.current_subject, result.output_subject, [request.current_subject]);
    expect(gitSucceeds(restored, "cat-file", "-e", `${artifact.commit}^{commit}`)).toBe(false);
    expect(readFileSync(join(restored, "candidate.txt"), "utf8")).toBe("candidate\n");
    expect(readFileSync(join(restored, "current.txt"), "utf8")).toBe("current\n");

    const replay = integrateCheckpoint({
      request,
      requestDirectory: execution.transport,
      resultPath: execution.resultPath,
      sourceRepoDir: value.repo,
    });
    expect(replay).toEqual(result);
    expect(() => integrateCheckpoint({
      request: { ...request, worker_id: "worker-2" },
      requestDirectory: execution.transport,
      resultPath: execution.resultPath,
      sourceRepoDir: value.repo,
    })).toThrow("integration replay worker_id mismatch");
  });

  it("executes at the exact idempotency-key length boundary", () => {
    const value = fixture();
    const maximum = integrationFixture(value, "maximum-idempotency-key");
    maximum.request.idempotency_key = "x".repeat(500);
    const result = integrateCheckpoint({
      request: maximum.request,
      requestDirectory: maximum.transport,
      resultPath: maximum.resultPath,
      sourceRepoDir: value.repo,
    });
    expect(result.state, result.reason).toBe("integrated");
    restoreIntegrated({ ...maximum, result });

    const overMaximum = integrationFixture(value, "over-maximum-idempotency-key");
    expect(() => integrateCheckpoint({
      request: { ...overMaximum.request, idempotency_key: "x".repeat(501) },
      requestDirectory: overMaximum.transport,
      resultPath: overMaximum.resultPath,
      sourceRepoDir: value.repo,
    })).toThrow("request.idempotency_key is invalid");
  });

  it("authors a merge descendant when current has the candidate input tree at a different commit", () => {
    const value = fixture({
      advanceCurrent(repo) {
        git(repo, "commit", "--quiet", "--allow-empty", "-m", "advance without changing the tree");
      },
    });
    expect(value.current).not.toBe(value.base);
    expect(git(value.repo, "rev-parse", `${value.current}^{tree}`))
      .toBe(git(value.repo, "rev-parse", `${value.base}^{tree}`));

    const execution = integrate(value, "same-tree");
    const restored = restoreIntegrated(execution);
    expect(execution.result.output_subject).not.toBe(execution.artifact.commit);
    expect(git(restored, "rev-list", "--parents", "-n", "1", execution.result.output_subject).split(" "))
      .toEqual([execution.result.output_subject, value.current]);
    expectLineage(restored, value.current, execution.result.output_subject, [value.current]);
    expect(execution.result.payload_artifact.tree).toBe(execution.artifact.tree);
    expect(readFileSync(join(restored, "candidate.txt"), "utf8")).toBe("candidate\n");
  });

  it("authors a fresh compact commit when the candidate directly descends from current", () => {
    const value = fixture({ advanceCurrent: null });
    const execution = integrate(value, "direct");
    const restored = restoreIntegrated(execution);
    expect(execution.result.output_subject).not.toBe(execution.artifact.commit);
    expect(git(restored, "rev-list", "--parents", "-n", "1", execution.result.output_subject).split(" "))
      .toEqual([execution.result.output_subject, value.current]);
    expectLineage(restored, value.current, execution.result.output_subject, [value.current]);
    expect(execution.result.payload_artifact.tree).toBe(execution.artifact.tree);
    expect(git(restored, "rev-parse", `${execution.result.output_subject}^{tree}`))
      .toBe(execution.artifact.tree);
    expect(gitSucceeds(restored, "cat-file", "-e", `${execution.artifact.commit}^{commit}`)).toBe(false);
  });

  it("squashes a cumulative A-to-B-to-C candidate tree onto current A", () => {
    const first = fixture({ advanceCurrent: null });
    shallowGit(
      first.repo,
      first.base,
      "fetch", "--quiet",
      join(first.action, first.checkpoint.payload_artifact.file),
      first.checkpoint.payload_artifact.ref,
    );
    const action = mkdtempSync(join(tmpdir(), "ot-integrate-cumulative-candidate-"));
    const view = materializeActionRepository({
      sourceRepoDir: first.repo,
      inputSubject: first.checkpoint.output_subject,
      repositoryAuthority: "edit",
      destination: join(action, "repository"),
    });
    writeFileSync(join(view.destination, "second.txt"), "second\n");
    const verification = verifyActionRepository(view);
    const checkpoint = createAttemptCheckpoint({
      request: {
        pipeline_run_id: "run-1", attempt_id: "attempt-cumulative", lease_id: "lease-cumulative",
        request_hash: "8".repeat(64), definition_bundle_hash: "b".repeat(64),
        checkpoint_base_subject: first.base,
        input_subject: first.checkpoint.output_subject,
      },
      repository: view,
      verification,
      outputSubject: verification.output_subject,
      nativeSessionId: "session-cumulative",
      artifactDirectory: action,
    });
    const value = { ...first, current: first.base, action, checkpoint };

    const execution = integrate(value, "cumulative");
    const restored = restoreIntegrated(execution);
    expect(execution.result.payload_artifact.tree).toBe(checkpoint.payload_artifact.tree);
    expect(shallowGit(
      restored,
      first.base,
      "rev-list", "--parents", "-n", "1", execution.result.output_subject,
    ).split(" ")).toEqual([execution.result.output_subject, first.base]);
    expect(readFileSync(join(restored, "candidate.txt"), "utf8")).toBe("candidate\n");
    expect(readFileSync(join(restored, "second.txt"), "utf8")).toBe("second\n");
  }, 15_000);

  it("compacts cumulative history without publishing deleted intermediate objects", () => {
    const secretPath = "intermediate-only-secret.bin";
    const secretMarker = Buffer.from("openthrottle-private-intermediate-v1\n");
    const secretBytes = Buffer.concat([secretMarker, randomBytes(2 * 1024 * 1024)]);
    const first = fixture({
      advanceCurrent: null,
      editCandidate(destination) {
        writeFileSync(join(destination, secretPath), secretBytes);
      },
    });
    shallowGit(
      first.repo,
      first.base,
      "fetch", "--quiet",
      join(first.action, first.checkpoint.payload_artifact.file),
      first.checkpoint.payload_artifact.ref,
    );
    const intermediateCommit = first.checkpoint.output_subject;
    const secretBlob = git(first.repo, "rev-parse", `${intermediateCommit}:${secretPath}`);
    expect(Number(git(first.repo, "cat-file", "-s", secretBlob))).toBe(secretBytes.length);

    const action = mkdtempSync(join(tmpdir(), "ot-integrate-compacted-candidate-"));
    const view = materializeActionRepository({
      sourceRepoDir: first.repo,
      inputSubject: intermediateCommit,
      repositoryAuthority: "edit",
      destination: join(action, "repository"),
    });
    rmSync(join(view.destination, secretPath));
    writeFileSync(join(view.destination, "final.txt"), "small final tree\n");
    const verification = verifyActionRepository(view);
    const checkpoint = createAttemptCheckpoint({
      request: {
        pipeline_run_id: "run-1", attempt_id: "attempt-compacted", lease_id: "lease-compacted",
        request_hash: "6".repeat(64), definition_bundle_hash: "b".repeat(64),
        checkpoint_base_subject: first.base,
        input_subject: intermediateCommit,
      },
      repository: view,
      verification,
      outputSubject: verification.output_subject,
      nativeSessionId: "session-compacted",
      artifactDirectory: action,
    });
    const execution = integrate(
      { ...first, current: first.base, action, checkpoint },
      "compacted",
    );
    expect(execution.result.state, execution.result.reason).toBe("integrated");
    expect(execution.result.payload_artifact.tree).toBe(checkpoint.payload_artifact.tree);
    expect(execution.result.payload_artifact.bytes).toBeLessThan(256 * 1024);

    const compactedBundle = join(
      execution.transport,
      execution.result.payload_artifact.file,
    );
    const verifier = mkdtempSync(join(tmpdir(), "ot-integrated-compaction-verifier-"));
    git(verifier, "init", "--quiet");
    git(
      verifier,
      "fetch", "--quiet", "--no-tags",
      first.repo,
      "refs/heads/main:refs/heads/base",
    );
    expect(git(verifier, "rev-parse", "refs/heads/base")).toBe(first.base);
    expect(spawnSync(
      "git",
      ["-C", verifier, "cat-file", "-e", `${intermediateCommit}^{commit}`],
      { encoding: "utf8" },
    ).status).not.toBe(0);
    expect(spawnSync(
      "git",
      ["-C", verifier, "cat-file", "-e", `${checkpoint.output_subject}^{commit}`],
      { encoding: "utf8" },
    ).status).not.toBe(0);
    expect(spawnSync(
      "git",
      ["-C", verifier, "cat-file", "-e", `${secretBlob}^{blob}`],
      { encoding: "utf8" },
    ).status).not.toBe(0);

    git(verifier, "bundle", "verify", compactedBundle);
    git(
      verifier,
      "fetch", "--quiet", compactedBundle,
      execution.result.payload_artifact.ref,
    );
    expect(git(
      verifier,
      "rev-list", "--parents", "-n", "1", execution.result.output_subject,
    ).split(" ")).toEqual([execution.result.output_subject, first.base]);
    expect(git(verifier, "rev-parse", `${execution.result.output_subject}^{tree}`))
      .toBe(checkpoint.payload_artifact.tree);
    expect(spawnSync(
      "git",
      ["-C", verifier, "cat-file", "-e", `${intermediateCommit}^{commit}`],
      { encoding: "utf8" },
    ).status).not.toBe(0);
    expect(spawnSync(
      "git",
      ["-C", verifier, "cat-file", "-e", `${checkpoint.output_subject}^{commit}`],
      { encoding: "utf8" },
    ).status).not.toBe(0);
    expect(spawnSync(
      "git",
      ["-C", verifier, "cat-file", "-e", `${secretBlob}^{blob}`],
      { encoding: "utf8" },
    ).status).not.toBe(0);
  }, 15_000);

  it("cuts a later publication bundle at its exact current parent", () => {
    const value = fixture({ advanceCurrent: null });
    const secretPath = join(value.repo, "prior-public-secret.bin");
    const secretBytes = Buffer.concat([
      Buffer.from("openthrottle-prior-public-secret-v1\n"),
      randomBytes(2 * 1024 * 1024),
    ]);
    writeFileSync(secretPath, secretBytes);
    commitAll(value.repo, "prior public secret");
    const intermediate = git(value.repo, "rev-parse", "HEAD");
    const secretBlob = git(value.repo, "rev-parse", `${intermediate}:prior-public-secret.bin`);
    rmSync(secretPath);
    commitAll(value.repo, "delete prior public secret");
    value.current = git(value.repo, "rev-parse", "HEAD");

    const execution = integrate(value, "later-publication");
    expect(execution.result.state, execution.result.reason).toBe("integrated");
    expect(execution.result.payload_artifact.bytes).toBeLessThan(256 * 1024);

    const verifier = mkdtempSync(join(tmpdir(), "ot-later-publication-verifier-"));
    const bundle = join(execution.transport, execution.result.payload_artifact.file);
    git(verifier, "init", "--quiet");
    shallowGit(verifier, value.current, "bundle", "verify", bundle);
    shallowGit(
      verifier,
      value.current,
      "fetch", "--quiet", bundle, execution.result.payload_artifact.ref,
    );
    expect(git(verifier, "rev-list", "--parents", "-n", "1", execution.result.output_subject).split(" "))
      .toEqual([execution.result.output_subject, value.current]);
    expect(gitSucceeds(verifier, "cat-file", "-e", `${intermediate}^{commit}`)).toBe(false);
    expect(gitSucceeds(verifier, "cat-file", "-e", `${secretBlob}^{blob}`)).toBe(false);
  });

  it("persists one integrated checkpoint for an immediate second integration", () => {
    const first = fixture({ advanceCurrent: null });
    const firstExecution = integrate(first, "back-to-back-first");
    expect(firstExecution.result.state, firstExecution.result.reason).toBe("integrated");
    expect(git(first.repo, "rev-parse", `${firstExecution.result.output_subject}^{commit}`))
      .toBe(firstExecution.result.output_subject);

    const action = mkdtempSync(join(tmpdir(), "ot-integrate-back-to-back-candidate-"));
    const view = materializeActionRepository({
      sourceRepoDir: first.repo,
      inputSubject: first.base,
      repositoryAuthority: "edit",
      destination: join(action, "repository"),
    });
    writeFileSync(join(view.destination, "second.txt"), "second candidate\n");
    const verification = verifyActionRepository(view);
    const checkpoint = createAttemptCheckpoint({
      request: {
        pipeline_run_id: "run-1", attempt_id: "attempt-back-to-back", lease_id: "lease-back-to-back",
        request_hash: "5".repeat(64), definition_bundle_hash: "b".repeat(64),
        checkpoint_base_subject: first.base, input_subject: first.base,
      },
      repository: view,
      verification,
      outputSubject: verification.output_subject,
      nativeSessionId: "session-back-to-back",
      artifactDirectory: action,
    });
    const second = integrate({
      ...first,
      current: firstExecution.result.output_subject,
      action,
      checkpoint,
    }, "back-to-back-second");
    expect(second.result.state, second.result.reason).toBe("integrated");
    expect(second.request.idempotency_key).not.toBe(firstExecution.request.idempotency_key);
    expect(second.result.payload_artifact.ref).not.toBe(firstExecution.result.payload_artifact.ref);
    const restored = restoreIntegrated(second);
    expect(git(restored, "rev-list", "--parents", "-n", "1", second.result.output_subject).split(" "))
      .toEqual([second.result.output_subject, firstExecution.result.output_subject]);
    expect(readFileSync(join(restored, "candidate.txt"), "utf8")).toBe("candidate\n");
    expect(readFileSync(join(restored, "second.txt"), "utf8")).toBe("second candidate\n");
  }, 15_000);

  it("authors a deterministic empty integration commit for a no-content unit", () => {
    const value = fixture({ editCandidate() {}, advanceCurrent: null });
    expect(value.checkpoint.output_subject).toBe(value.current);

    const execution = integrate(value, "identity");
    const restored = restoreIntegrated(execution);
    expect(execution.result.output_subject).not.toBe(value.current);
    expect(execution.result.payload_artifact.tree).toBe(value.checkpoint.payload_artifact.tree);
    expect(git(restored, "rev-list", "--parents", "-n", "1", execution.result.output_subject).split(" "))
      .toEqual([execution.result.output_subject, value.current]);
    expect(git(restored, "rev-parse", `${execution.result.output_subject}^{tree}`))
      .toBe(git(value.repo, "rev-parse", `${value.current}^{tree}`));
  });

  it("accepts a later-run identity candidate while retaining its real parent ancestry", () => {
    const first = fixture({ advanceCurrent: null });
    shallowGit(
      first.repo,
      first.base,
      "fetch", "--quiet",
      join(first.action, first.checkpoint.payload_artifact.file),
      first.checkpoint.payload_artifact.ref,
    );
    const action = mkdtempSync(join(tmpdir(), "ot-integrate-later-identity-"));
    const view = materializeActionRepository({
      sourceRepoDir: first.repo,
      inputSubject: first.checkpoint.output_subject,
      repositoryAuthority: "edit",
      destination: join(action, "repository"),
    });
    const verification = verifyActionRepository(view);
    const checkpoint = createAttemptCheckpoint({
      request: {
        pipeline_run_id: "run-1", attempt_id: "attempt-identity-later", lease_id: "lease-identity-later",
        request_hash: "7".repeat(64), definition_bundle_hash: "b".repeat(64),
        checkpoint_base_subject: first.base,
        input_subject: first.checkpoint.output_subject,
      },
      repository: view,
      verification,
      outputSubject: verification.output_subject,
      nativeSessionId: "session-identity-later",
      artifactDirectory: action,
    });
    const value = {
      ...first,
      current: first.checkpoint.output_subject,
      action,
      checkpoint,
    };

    const execution = integrate(value, "later-identity");
    const restored = restoreIntegrated(execution);
    expect(checkpoint.output_subject).toBe(value.current);
    expect(shallowGit(
      restored,
      first.base,
      "rev-list", "--parents", "-n", "1", execution.result.output_subject,
    ).split(" ")).toEqual([execution.result.output_subject, value.current]);
  });

  it("rejects candidate provenance relabeled to a tree-equivalent input commit", () => {
    const value = fixture({
      advanceCurrent(repo) {
        git(repo, "commit", "--quiet", "--allow-empty", "-m", "tree-equivalent input impostor");
      },
    });
    const setup = integrationFixture(value, "provenance");
    const result = integrateCheckpoint({
      request: { ...setup.request, candidate_input_subject: value.current },
      requestDirectory: setup.transport,
      resultPath: setup.resultPath,
      sourceRepoDir: value.repo,
    });
    expect(result).toMatchObject({
      state: "retryable_failure",
      output_subject: null,
      payload_schema: null,
      payload_artifact: null,
      reason: "candidate checkpoint parent does not match its exact input subject",
    });
  });

  it("fails closed when exact current and candidate changes conflict", () => {
    const value = fixture({
      editCandidate(destination) {
        writeFileSync(join(destination, "base.txt"), "candidate\n");
      },
      advanceCurrent(repo) {
        writeFileSync(join(repo, "base.txt"), "current\n");
        commitAll(repo, "conflicting current change");
      },
    });
    const { result } = integrate(value, "conflict");
    expect(result).toMatchObject({
      state: "needs_human",
      input_subject: value.current,
      output_subject: null,
      payload_schema: null,
      payload_artifact: null,
      reason: expect.stringContaining("checkpoint integration conflict"),
    });
  });

  it("rejects a current subject outside the sealed checkpoint-base ancestry", () => {
    const value = fixture({
      advanceCurrent(repo) {
        git(repo, "switch", "--quiet", "--orphan", "unrelated");
        writeFileSync(join(repo, "unrelated.txt"), "unrelated\n");
        commitAll(repo, "unrelated current");
      },
    });
    const { result } = integrate(value, "unrelated");
    expect(result).toMatchObject({
      state: "retryable_failure",
      input_subject: value.current,
      output_subject: null,
      payload_schema: null,
      payload_artifact: null,
      reason: expect.stringContaining("sealed checkpoint base"),
    });
  });
});
