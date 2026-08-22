import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

function sourceRepository() {
  const repo = mkdtempSync(join(tmpdir(), "ot-checkpoint-source-"));
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "value.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "base");
  return { repo, subject: git(repo, "rev-parse", "HEAD^{tree}") };
}

describe("attempt checkpoint bundle", () => {
  it("authors a bounded exact bundle and identity-bound wire checkpoint", () => {
    const source = sourceRepository();
    const actionDirectory = mkdtempSync(join(tmpdir(), "ot-checkpoint-action-"));
    const repository = materializeActionRepository({
      sourceRepoDir: source.repo,
      inputSubject: source.subject,
      repositoryAuthority: "edit",
      destination: join(actionDirectory, "repository"),
    });
    writeFileSync(join(repository.destination, "value.txt"), "implemented\n");
    writeFileSync(join(repository.destination, "new.txt"), "proof\n");
    const verification = verifyActionRepository(repository);
    const checkpoint = createAttemptCheckpoint({
      request: {
        pipeline_run_id: "run-1",
        attempt_id: "attempt-1",
        request_hash: "a".repeat(64),
        definition_bundle_hash: "b".repeat(64),
        input_subject: source.subject,
      },
      repository,
      verification,
      outputSubject: verification.output_subject,
      nativeSessionId: "session-1",
      artifactDirectory: actionDirectory,
      capturedAt: "2026-08-20T00:00:00.000Z",
    });

    expect(checkpoint).toMatchObject({
      schema: "openthrottle.attempt-checkpoint-wire/v1",
      pipeline_run_id: "run-1",
      attempt_id: "attempt-1",
      request_hash: "a".repeat(64),
      definition_bundle_hash: "b".repeat(64),
      input_subject: source.subject,
      output_subject: expect.stringMatching(/^[a-f0-9]{40,64}$/),
      native_session_id: "session-1",
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      payload_artifact: {
        file: expect.stringMatching(/\.checkpoint\.bundle$/),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        bytes: expect.any(Number),
        media_type: "application/x-git-bundle",
        payload_schema: "openthrottle.git-checkpoint-bundle/v1",
        ref: `refs/openthrottle/checkpoints/${"a".repeat(64)}`,
        commit: expect.stringMatching(/^[a-f0-9]{40,64}$/),
        tree: verification.output_subject,
      },
      captured_at: "2026-08-20T00:00:00.000Z",
    });
    const bundlePath = join(actionDirectory, checkpoint.payload_artifact.file);
    expect(statSync(bundlePath).size).toBe(checkpoint.payload_artifact.bytes);
    expect(() => git(source.repo, "bundle", "verify", bundlePath)).not.toThrow();

    expect(checkpoint.output_subject).toBe(checkpoint.payload_artifact.commit);
    const restored = mkdtempSync(join(tmpdir(), "ot-checkpoint-restored-"));
    git(restored, "init", "--quiet");
    git(restored, "fetch", "--quiet", bundlePath, checkpoint.payload_artifact.ref);
    git(restored, "switch", "--quiet", "--detach", checkpoint.payload_artifact.commit);
    expect(git(restored, "rev-parse", `${checkpoint.payload_artifact.commit}^{tree}`))
      .toBe(checkpoint.payload_artifact.tree);
    expect(readFileSync(join(restored, "value.txt"), "utf8")).toBe("implemented\n");
    expect(readFileSync(join(restored, "new.txt"), "utf8")).toBe("proof\n");
    expect(basename(bundlePath)).toBe(checkpoint.payload_artifact.file);
  });

  it("imports a checkpoint commit as the exact successor action subject", () => {
    const source = sourceRepository();
    const actionDirectory = mkdtempSync(join(tmpdir(), "ot-checkpoint-successor-"));
    const repository = materializeActionRepository({
      sourceRepoDir: source.repo,
      inputSubject: source.subject,
      repositoryAuthority: "edit",
      destination: join(actionDirectory, "repository"),
    });
    writeFileSync(join(repository.destination, "value.txt"), "successor input\n");
    const verification = verifyActionRepository(repository);
    const checkpoint = createAttemptCheckpoint({
      request: {
        pipeline_run_id: "run-1",
        attempt_id: "attempt-1",
        lease_id: "lease-1",
        request_hash: "c".repeat(64),
        definition_bundle_hash: "d".repeat(64),
        input_subject: source.subject,
      },
      repository,
      verification,
      outputSubject: verification.output_subject,
      nativeSessionId: "session-1",
      artifactDirectory: actionDirectory,
    });
    const bundlePath = join(actionDirectory, checkpoint.payload_artifact.file);
    git(source.repo, "fetch", "--quiet", bundlePath, checkpoint.payload_artifact.ref);
    expect(git(source.repo, "rev-parse", `${checkpoint.output_subject}^{tree}`))
      .toBe(checkpoint.payload_artifact.tree);

    const successor = materializeActionRepository({
      sourceRepoDir: source.repo,
      inputSubject: checkpoint.output_subject,
      repositoryAuthority: "inspect",
      destination: join(actionDirectory, "successor-repository"),
    });
    expect(readFileSync(join(successor.destination, "value.txt"), "utf8")).toBe("successor input\n");
    expect(verifyActionRepository(successor).output_subject).toBe(checkpoint.payload_artifact.tree);
  });
});
