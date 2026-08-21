import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { materializeActionRepository, verifyActionRepository } from "./action-repository.mjs";
import { createAttemptCheckpoint } from "./checkpoint-bundle.mjs";
import { integrateCheckpoint } from "./integrate-checkpoint.mjs";

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "ot-integrate-source-"));
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");

  const action = mkdtempSync(join(tmpdir(), "ot-integrate-candidate-"));
  const view = materializeActionRepository({
    sourceRepoDir: repo,
    inputSubject: base,
    repositoryAuthority: "edit",
    destination: join(action, "repository"),
  });
  writeFileSync(join(view.destination, "candidate.txt"), "candidate\n");
  const verification = verifyActionRepository(view);
  const checkpoint = createAttemptCheckpoint({
    request: {
      pipeline_run_id: "run-1", attempt_id: "attempt-1", lease_id: "lease-1",
      request_hash: "a".repeat(64), definition_bundle_hash: "b".repeat(64), input_subject: base,
    },
    repository: view,
    verification,
    outputSubject: verification.output_subject,
    nativeSessionId: "session-1",
    artifactDirectory: action,
  });

  writeFileSync(join(repo, "current.txt"), "current\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "advance current");
  return { repo, base, current: git(repo, "rev-parse", "HEAD"), action, checkpoint };
}

describe("executor checkpoint integration", () => {
  it("three-way integrates a candidate and emits an exact pushable bundle", () => {
    const value = fixture();
    const transport = mkdtempSync(join(tmpdir(), "ot-integrate-transport-"));
    const artifact = value.checkpoint.payload_artifact;
    copyFileSync(join(value.action, artifact.file), join(transport, artifact.file));
    const request = {
      schema: "openthrottle.kernel-integration-request/v1",
      pipeline_run_id: "run-1",
      effect_id: "effect-1",
      idempotency_key: "integrate:run-1:attempt-1",
      lease_id: "lease-integration",
      worker_id: "worker-1",
      definition_bundle_hash: "b".repeat(64),
      current_subject: value.current,
      candidate_checkpoint_id: value.checkpoint.id,
      candidate_input_subject: value.checkpoint.input_subject,
      candidate_output_subject: value.checkpoint.output_subject,
      candidate_artifact: artifact,
    };
    const result = integrateCheckpoint({
      request,
      requestDirectory: transport,
      resultPath: join(transport, "result.json"),
      sourceRepoDir: value.repo,
    });
    if (result.state !== "integrated") throw new Error(result.reason);
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
    const restored = mkdtempSync(join(tmpdir(), "ot-integrated-restored-"));
    git(restored, "init", "--quiet");
    git(restored, "fetch", "--quiet", join(transport, result.payload_artifact.file), result.payload_artifact.ref);
    git(restored, "switch", "--quiet", "--detach", result.output_subject);
    expect(readFileSync(join(restored, "candidate.txt"), "utf8")).toBe("candidate\n");
    expect(readFileSync(join(restored, "current.txt"), "utf8")).toBe("current\n");
  });
});
