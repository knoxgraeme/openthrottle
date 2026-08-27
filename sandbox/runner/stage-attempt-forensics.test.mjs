import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { stageAttemptForensics } from "./stage-attempt-forensics.mjs";

const OBSERVED_AT = "2026-08-20T12:00:00.000Z";

function git(repository, ...args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
}

describe("attempt forensics staging", () => {
  it("stages bounded content-addressed silent-exit evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "ot-attempt-forensics-"));
    try {
      const actionRoot = join(root, "actions");
      const repository = join(actionRoot, "attempt-1", "repository");
      mkdirSync(repository, { recursive: true });
      git(repository, "init", "--quiet", "--initial-branch=main");
      git(repository, "config", "user.name", "Test");
      git(repository, "config", "user.email", "test@example.com");
      writeFileSync(join(repository, "work.txt"), "base\n");
      git(repository, "add", "work.txt");
      git(repository, "commit", "--quiet", "-m", "base");
      writeFileSync(join(repository, "work.txt"), "changed\n");

      const transport = join(root, "results", "attempt-1", "work-lease-1");
      const requestPath = join(root, "request.json");
      const resultPath = join(transport, "result.json");
      const sessionPath = join(transport, "session.json");
      const descriptorPath = join(transport, "forensics.json");
      const stdoutPath = join(transport, "runner.stdout.log");
      const stderrPath = join(transport, "runner.stderr.log");
      mkdirSync(dirname(resultPath), { recursive: true });
      writeFileSync(requestPath, JSON.stringify({
        pipeline_run_id: "run-1",
        attempt_id: "attempt-1",
        request_hash: "a".repeat(64),
        definition_bundle_hash: "b".repeat(64),
        lease_id: "lease-1",
        worker_id: "worker-1",
      }));
      writeFileSync(resultPath, '{"schema":');
      writeFileSync(sessionPath, JSON.stringify({ native_session_id: "session-1" }));
      writeFileSync(stdoutPath, `${"x".repeat(20_000)}runner stdout tail`);
      writeFileSync(
        stderrPath,
        "[kernel-entrypoint 12:34:56] repository source component is not a physical directory\n",
      );

      const descriptor = stageAttemptForensics({
        exitCode: 17,
        now: () => new Date(OBSERVED_AT),
        env: {
          PATH: process.env.PATH,
          OT_ACTION_ROOT: actionRoot,
          OT_ACTION_REQUEST_FILE: requestPath,
          OT_ACTION_RESULT_FILE: resultPath,
          OT_ACTION_SESSION_FILE: sessionPath,
          OT_ACTION_FORENSICS_FILE: descriptorPath,
          OT_ACTION_RUNNER_STDOUT_FILE: stdoutPath,
          OT_ACTION_RUNNER_STDERR_FILE: stderrPath,
          OT_ACTION_WORK_RETRY_ORDINAL: "3",
        },
      });
      const persistedDescriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
      expect(persistedDescriptor).toEqual(descriptor);
      const artifactBytes = readFileSync(join(transport, descriptor.file));
      expect(createHash("sha256").update(artifactBytes).digest("hex")).toBe(descriptor.sha256);
      const artifact = JSON.parse(artifactBytes.toString("utf8"));
      expect(artifact).toMatchObject({
        schema: "openthrottle.attempt-forensics/v1",
        attempt_id: "attempt-1",
        work_retry_ordinal: 3,
        exit_code: 17,
        result_path_state: { state: "present", bytes: 10 },
        session_event_state: { state: "present" },
        workspace_git_status: { state: "present", summary: expect.stringContaining("work.txt") },
        runner_stdout_tail: expect.stringMatching(/runner stdout tail$/),
        runner_stderr_tail:
          "[kernel-entrypoint 12:34:56] repository source component is not a physical directory\n",
        operational_signature: expect.stringMatching(/^[a-f0-9]{64}$/),
        observed_at: OBSERVED_AT,
      });
      expect(Buffer.byteLength(artifact.runner_stdout_tail)).toBeLessThanOrEqual(16 * 1024);

      const repeatedTransport = join(root, "results", "attempt-1", "work-lease-repeated");
      const repeatedResultPath = join(repeatedTransport, "result.json");
      const repeatedSessionPath = join(repeatedTransport, "session.json");
      const repeatedDescriptorPath = join(repeatedTransport, "forensics.json");
      const repeatedStdoutPath = join(repeatedTransport, "runner.stdout.log");
      const repeatedStderrPath = join(repeatedTransport, "runner.stderr.log");
      mkdirSync(repeatedTransport, { recursive: true });
      writeFileSync(repeatedResultPath, '{"schema":"retry-specific-partial-result"');
      writeFileSync(repeatedSessionPath, JSON.stringify({ native_session_id: "session-repeated" }));
      writeFileSync(repeatedStdoutPath, `${"x".repeat(20_000)}runner stdout tail`);
      writeFileSync(
        repeatedStderrPath,
        "[kernel-entrypoint 12:35:41] repository source component is not a physical directory\n",
      );
      const repeatedDescriptor = stageAttemptForensics({
        exitCode: 17,
        now: () => new Date(OBSERVED_AT),
        env: {
          PATH: process.env.PATH,
          OT_ACTION_ROOT: actionRoot,
          OT_ACTION_REQUEST_FILE: requestPath,
          OT_ACTION_RESULT_FILE: repeatedResultPath,
          OT_ACTION_SESSION_FILE: repeatedSessionPath,
          OT_ACTION_FORENSICS_FILE: repeatedDescriptorPath,
          OT_ACTION_RUNNER_STDOUT_FILE: repeatedStdoutPath,
          OT_ACTION_RUNNER_STDERR_FILE: repeatedStderrPath,
          OT_ACTION_WORK_RETRY_ORDINAL: "3",
        },
      });
      const repeatedArtifact = JSON.parse(readFileSync(
        join(repeatedTransport, repeatedDescriptor.file),
        "utf8",
      ));
      expect(repeatedArtifact.result_path_state).not.toEqual(artifact.result_path_state);
      expect(repeatedArtifact.session_event_state).not.toEqual(artifact.session_event_state);
      expect(repeatedArtifact.operational_signature).toBe(artifact.operational_signature);

      const secondTransport = join(root, "results", "attempt-1", "work-lease-2");
      const secondResultPath = join(secondTransport, "result.json");
      const secondSessionPath = join(secondTransport, "session.json");
      const secondDescriptorPath = join(secondTransport, "forensics.json");
      const secondStdoutPath = join(secondTransport, "runner.stdout.log");
      const secondStderrPath = join(secondTransport, "runner.stderr.log");
      mkdirSync(secondTransport, { recursive: true });
      writeFileSync(secondResultPath, '{"schema":');
      writeFileSync(secondSessionPath, JSON.stringify({ native_session_id: "session-2" }));
      writeFileSync(secondStdoutPath, `${"x".repeat(20_000)}runner stdout tail`);
      writeFileSync(secondStderrPath, "different runner failure");
      const secondDescriptor = stageAttemptForensics({
        exitCode: 17,
        now: () => new Date(OBSERVED_AT),
        env: {
          PATH: process.env.PATH,
          OT_ACTION_ROOT: actionRoot,
          OT_ACTION_REQUEST_FILE: requestPath,
          OT_ACTION_RESULT_FILE: secondResultPath,
          OT_ACTION_SESSION_FILE: secondSessionPath,
          OT_ACTION_FORENSICS_FILE: secondDescriptorPath,
          OT_ACTION_RUNNER_STDOUT_FILE: secondStdoutPath,
          OT_ACTION_RUNNER_STDERR_FILE: secondStderrPath,
          OT_ACTION_WORK_RETRY_ORDINAL: "4",
        },
      });
      const secondArtifact = JSON.parse(readFileSync(
        join(secondTransport, secondDescriptor.file),
        "utf8",
      ));
      expect(secondArtifact.operational_signature).not.toBe(artifact.operational_signature);

      const sealedTransport = join(root, "results", "attempt-1", "work-lease-sealed");
      const sealedResultPath = join(sealedTransport, "result.json");
      const sealedDescriptorPath = join(sealedTransport, "forensics.json");
      mkdirSync(sealedTransport, { recursive: true });
      writeFileSync(sealedResultPath, JSON.stringify({
        schema: "openthrottle.kernel-runtime-result/v1",
        pipeline_run_id: "run-1",
        attempt_id: "attempt-1",
        request_hash: "a".repeat(64),
        definition_bundle_hash: "b".repeat(64),
        lease_id: "lease-1",
        worker_id: "worker-1",
        outcome: { state: "work_failed", retryable: true, reason: "sealed" },
      }));
      expect(stageAttemptForensics({
        exitCode: 0,
        env: {
          OT_ACTION_ROOT: actionRoot,
          OT_ACTION_REQUEST_FILE: requestPath,
          OT_ACTION_RESULT_FILE: sealedResultPath,
          OT_ACTION_SESSION_FILE: join(sealedTransport, "session.json"),
          OT_ACTION_FORENSICS_FILE: sealedDescriptorPath,
          OT_ACTION_RUNNER_STDOUT_FILE: join(sealedTransport, "runner.stdout.log"),
          OT_ACTION_RUNNER_STDERR_FILE: join(sealedTransport, "runner.stderr.log"),
          OT_ACTION_WORK_RETRY_ORDINAL: "3",
        },
      })).toBeNull();
      expect(existsSync(sealedDescriptorPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
