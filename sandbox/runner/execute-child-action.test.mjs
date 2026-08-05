import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "./capabilities.mjs";
import { digest } from "./artifacts.mjs";
import { executeChildAction } from "./execute-child-action.mjs";

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

describe("child executor action", () => {
  it("binds unconfigured command receipts to the sealed input subject without reading the tree", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "ot-child-action-config-"));
    directories.push(configDir);
    const configPath = join(configDir, "repository-config.json");
    writeFileSync(configPath, JSON.stringify({ commands: {} }));
    process.env.OT_STAGE_CONFIG_FILE = configPath;

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
  });
});
