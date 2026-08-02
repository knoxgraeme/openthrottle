import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveCandidateEvidence, bindCommandReceipt } from "./unit-evidence.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository() {
  const directory = mkdtempSync(join(tmpdir(), "ot-unit-evidence-"));
  directories.push(directory);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  writeFileSync(join(directory, "file.txt"), "initial\n");
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: directory });
  return directory;
}

describe("unit evidence", () => {
  it("derives candidate tree facts from Git instead of worker claims", () => {
    const repoDir = repository();
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    writeFileSync(join(repoDir, "file.txt"), "changed\n");
    writeFileSync(join(repoDir, "new.txt"), "new\n");

    const evidence = deriveCandidateEvidence({ repoDir, baseCommit });

    expect(evidence).toMatchObject({
      schema: "openthrottle.candidate-evidence/v1",
      base: baseCommit,
      pre: baseCommit,
      clean: false,
      changed_paths: ["file.txt", "new.txt"],
    });
    expect(evidence.diff_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds command receipts to command name, subject, and request fence", () => {
    const subject = "1".repeat(40);
    const requestHash = "2".repeat(64);
    const expectedFence = {
      pipelineInstanceId: "pipeline-1",
      graphDigest: "a".repeat(64),
      unitId: "unit-1",
      attemptId: "attempt-1",
      parentRunId: "run-1",
      actionAttemptId: "action-1",
      generation: 1,
      nativeSessionId: null,
    };
    const receipt = {
      type: "command_result",
      result: "success",
      subject: { post: subject },
      fence: {
        pipeline_instance_id: "pipeline-1",
        graph_digest: "a".repeat(64),
        unit_id: "unit-1",
        attempt_id: "attempt-1",
        parent_run_id: "run-1",
        action_attempt_id: "action-1",
        generation: 1,
        native_session_id: null,
        request_hash: requestHash,
      },
      payload: { command: "test" },
    };

    expect(bindCommandReceipt({ receipt, commandName: "test", expectedSubject: subject, requestHash, expectedFence }))
      .toMatchObject({ command: "test", subject, result: "success" });
    expect(() => bindCommandReceipt({ receipt, commandName: "lint", expectedSubject: subject, requestHash, expectedFence }))
      .toThrow(/command mismatch/);
  });

  it("rejects a command receipt bound to the wrong graph, run, action, generation, or session", () => {
    const subject = "1".repeat(40);
    const requestHash = "2".repeat(64);
    const expectedFence = {
      pipelineInstanceId: "pipeline-1",
      graphDigest: "a".repeat(64),
      unitId: "unit-1",
      attemptId: "attempt-1",
      parentRunId: "run-1",
      actionAttemptId: "action-1",
      generation: 1,
      nativeSessionId: "session-1",
    };
    const baseFence = {
      pipeline_instance_id: "pipeline-1",
      graph_digest: "a".repeat(64),
      unit_id: "unit-1",
      attempt_id: "attempt-1",
      parent_run_id: "run-1",
      action_attempt_id: "action-1",
      generation: 1,
      native_session_id: "session-1",
      request_hash: requestHash,
    };
    const receiptWith = (fenceOverrides) => ({
      type: "command_result",
      result: "success",
      subject: { post: subject },
      fence: { ...baseFence, ...fenceOverrides },
      payload: { command: "test" },
    });

    const cases = [
      [{ graph_digest: "b".repeat(64) }, /graph fence mismatch/],
      [{ parent_run_id: "run-2" }, /run fence mismatch/],
      [{ action_attempt_id: "action-2" }, /action fence mismatch/],
      [{ generation: 2 }, /generation fence mismatch/],
      [{ native_session_id: "session-2" }, /session fence mismatch/],
      [{ unit_id: "unit-2" }, /unit fence mismatch/],
      [{ attempt_id: "attempt-2" }, /attempt fence mismatch/],
      [{ pipeline_instance_id: "pipeline-2" }, /pipeline fence mismatch/],
    ];
    for (const [fenceOverrides, message] of cases) {
      expect(() => bindCommandReceipt({
        receipt: receiptWith(fenceOverrides),
        commandName: "test",
        expectedSubject: subject,
        requestHash,
        expectedFence,
      })).toThrow(message);
    }
  });
});
