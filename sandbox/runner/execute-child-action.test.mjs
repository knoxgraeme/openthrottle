import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "./capabilities.mjs";
import { digest } from "./artifacts.mjs";
import { childActionFailureResult, executeChildAction } from "./execute-child-action.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  delete process.env.OT_STAGE_CONFIG_FILE;
});

function childRequestHash(requestWithoutFence) {
  return digest(canonicalJson(requestWithoutFence));
}

function childExecutorRequest(overrides = {}) {
  const withoutFence = {
    protocol: "child-executor-action@1",
    actionId: "action-1",
    attemptId: "attempt-1",
    graphId: "graph-1",
    pipelineInstanceId: "pipeline-1",
    graphDigest: "a".repeat(64),
    parentRunId: "run-1",
    generation: 1,
    capabilityDigest: "c".repeat(64),
    unitId: "unit-1",
    actionKind: "command",
    commandName: "missing",
    worktree: { id: "worktree-1" },
    baseSubject: "1".repeat(40),
    inputSubject: "2".repeat(40),
    ...overrides,
  };
  const requestHash = childRequestHash(withoutFence);
  return {
    ...withoutFence,
    requestHash,
    idempotencyKey: `child-executor:${withoutFence.attemptId}:${withoutFence.actionId}:${requestHash}`,
  };
}

function useRepositoryConfig(commands) {
  const configDir = mkdtempSync(join(tmpdir(), "ot-child-action-config-"));
  directories.push(configDir);
  const configPath = join(configDir, "repository-config.json");
  writeFileSync(configPath, JSON.stringify({ commands }));
  process.env.OT_STAGE_CONFIG_FILE = configPath;
}

describe("child executor action", () => {
  it("binds unconfigured command receipts to the sealed input subject without reading the tree", async () => {
    useRepositoryConfig({});

    const request = childExecutorRequest();
    const result = executeChildAction({ request });
    const receipt = JSON.parse(result.receipt);

    expect(result).toMatchObject({
      kind: "child_executor_action_result",
      outcome: "success",
      subject: request.inputSubject,
    });
    expect(receipt).toMatchObject({
      type: "command_result",
      result: "not_configured",
      subject: {
        pre: request.inputSubject,
        post: request.inputSubject,
      },
      payload: {
        command: "missing",
        exit_code: 1,
      },
    });
  });

  it("rejects malformed child executor requests before selecting a repository", async () => {
    const staleProtocol = childExecutorRequest({ protocol: "stage-executor@1" });
    expect(() => executeChildAction({ request: staleProtocol })).toThrow(/protocol is invalid/);

    const missingWorktree = childExecutorRequest({
      actionId: "action-missing-worktree",
      worktree: null,
    });
    expect(() => executeChildAction({ request: missingWorktree })).toThrow(/requires a worktree/);

    const unitScopedFinalCommand = childExecutorRequest({
      actionId: "action-unit-final-command",
      actionKind: "final_command",
      commandName: "test",
      unitId: "unit-1",
      worktree: null,
    });
    expect(() => executeChildAction({ request: unitScopedFinalCommand })).toThrow(/final command must be graph-scoped/);

    const missingCandidateWorktree = childExecutorRequest({
      actionId: "action-candidate-missing-worktree",
      actionKind: "candidate",
      commandName: undefined,
      worktree: null,
    });
    expect(() => executeChildAction({ request: missingCandidateWorktree })).toThrow(/candidate action requires a worktree/);

    const missingIntegrationCandidate = childExecutorRequest({
      actionId: "action-integrate-missing-candidate",
      actionKind: "integrate",
      commandName: undefined,
      worktree: null,
    });
    expect(() => executeChildAction({ request: missingIntegrationCandidate })).toThrow(/integration action requires a candidate subject/);
  });

  it("fails closed instead of truncating unsupported child git operation subjects", () => {
    const candidate = childExecutorRequest({
      actionId: "action-candidate-sha256",
      actionKind: "candidate",
      commandName: undefined,
      baseSubject: "1".repeat(64),
      inputSubject: "2".repeat(64),
    });
    expect(() => executeChildAction({
      request: candidate,
      computeSubject: () => "3".repeat(64),
    })).toThrow(/baseSubject must be a 40-character Git object ID/);

    const integrate = childExecutorRequest({
      actionId: "action-integrate-sha256",
      actionKind: "integrate",
      commandName: undefined,
      worktree: null,
      baseSubject: "1".repeat(64),
      inputSubject: "2".repeat(64),
      candidateSubject: "3".repeat(64),
    });
    expect(() => executeChildAction({ request: integrate })).toThrow(/inputSubject must be a 40-character Git object ID/);

    const invalidCandidate = childExecutorRequest({
      actionId: "action-integrate-candidate-sha256",
      actionKind: "integrate",
      commandName: undefined,
      worktree: null,
      candidateSubject: "3".repeat(64),
    });
    expect(() => executeChildAction({ request: invalidCandidate })).toThrow(/candidateSubject must be a 40-character Git object ID/);
  });

  it("grants and relocks configured unit command worktrees around execution and subject collection", () => {
    useRepositoryConfig({ test: "npm test" });

    const events = [];
    const request = childExecutorRequest({ commandName: "test" });
    const result = executeChildAction({
      request,
      grantWorktree: ({ handle }) => {
        events.push(`grant:${handle}`);
        return { id: handle, path: `/tmp/${handle}`, writable: true };
      },
      executeCommand: ({ command, repoDir }) => {
        events.push(`command:${command}:${repoDir}`);
        return { exitCode: 0, signal: null, timedOut: false, stdout: "ok", stderr: "" };
      },
      computeSubject: (repoDir) => {
        events.push(`subject:${repoDir}`);
        return "3".repeat(40);
      },
      lockWorktreeHandle: ({ handle }) => {
        events.push(`lock:${handle}`);
      },
    });

    expect(events).toEqual([
      "grant:worktree-1",
      "command:npm test:/tmp/worktree-1",
      "subject:/tmp/worktree-1",
      "lock:worktree-1",
    ]);
    expect(result).toMatchObject({
      outcome: "success",
      subject: "3".repeat(40),
    });
  });

  it("relocks configured unit command worktrees when command execution throws", () => {
    useRepositoryConfig({ test: "npm test" });

    const lockWorktreeHandle = vi.fn();
    const request = childExecutorRequest({ commandName: "test" });

    expect(() => executeChildAction({
      request,
      grantWorktree: ({ handle }) => ({ id: handle, path: `/tmp/${handle}`, writable: true }),
      executeCommand: () => {
        throw new Error("command launch failed");
      },
      lockWorktreeHandle,
      computeSubject: () => "3".repeat(40),
    })).toThrow(/command launch failed/);
    expect(lockWorktreeHandle).toHaveBeenCalledWith({ rootDir: "/var/lib/openthrottle/worktrees", handle: "worktree-1" });
  });

  it("builds retryable failure envelopes that preserve child executor errors", () => {
    const request = childExecutorRequest({
      actionId: "action-failure",
      inputSubject: "3".repeat(40),
    });
    const result = childActionFailureResult(request, new Error("worktree is unavailable"));

    expect(result).toMatchObject({
      kind: "child_executor_action_result",
      action_id: "action-failure",
      attempt_id: "attempt-1",
      request_hash: request.requestHash,
      outcome: "retryable_infrastructure_failure",
      subject: request.inputSubject,
      receipt: "worktree is unavailable",
    });
  });
});
