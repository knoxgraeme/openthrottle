import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function useRepositoryConfig(commands, extra = {}) {
  const configDir = mkdtempSync(join(tmpdir(), "ot-child-action-config-"));
  directories.push(configDir);
  const configPath = join(configDir, "repository-config.json");
  writeFileSync(configPath, JSON.stringify({ commands, ...extra }));
  process.env.OT_STAGE_CONFIG_FILE = configPath;
  return configPath;
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
      evidence: [expect.stringContaining("executor:command:action-1:missing:not_configured")],
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
    expect(JSON.parse(result.receipt).evidence).toEqual([
      expect.stringContaining("executor:command:action-1:test:success"),
    ]);
  });

  it("computes a command action's post-command subject on a worktree whose shared admin dir another action's cleanup already relocked", () => {
    useRepositoryConfig({ test: "npm test" });

    // A real linked worktree, mirroring what a structured command action
    // actually runs against: its .git is an indirection file pointing back at
    // repoDir/.git/worktrees/<handle> (the shared admin dir a prior loop
    // action's cleanup relocks to root:root -- see execute-loop.mjs
    // lockGitMetadata). computeSubject must not need agent-authority (gosu)
    // access to that shared metadata to read this worktree's tree.
    const repoDir = mkdtempSync(join(tmpdir(), "ot-child-action-repo-"));
    directories.push(repoDir);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    writeFileSync(join(repoDir, "file.txt"), "initial\n");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: repoDir });
    const worktreeParent = mkdtempSync(join(tmpdir(), "ot-child-action-wt-parent-"));
    directories.push(worktreeParent);
    const worktreeDir = join(worktreeParent, "worktree-1");
    execFileSync("git", ["worktree", "add", "--detach", worktreeDir, "HEAD"], { cwd: repoDir });

    const request = childExecutorRequest({ commandName: "test" });
    const expectedTree = execFileSync("git", ["-C", worktreeDir, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    // Real gosu refuses to drop privileges unless the process is genuinely
    // root (`gosu agent true` as non-root exits "operation not permitted").
    // Mocking process.getuid() to report 0 without the OS process actually
    // being root reproduces that same agent-authority denial here, standing
    // in for the relocked shared admin dir without requiring real root.
    const getuidSpy = vi.spyOn(process, "getuid").mockReturnValue(0);
    try {
      const result = executeChildAction({
        request,
        grantWorktree: () => ({ id: "worktree-1", path: worktreeDir, writable: true }),
        executeCommand: () => ({ exitCode: 0, signal: null, timedOut: false, stdout: "ok", stderr: "" }),
        lockWorktreeHandle: () => {},
        // computeSubject intentionally left at its real default
        // (computeWorkspaceTreeOidAsExecutor) -- this test exists to prove
        // that default works under this condition, not a stand-in for it.
      });

      expect(result.outcome).toBe("success");
      expect(result.subject).toBe(expectedTree);
    } finally {
      getuidSpy.mockRestore();
    }
  });

  it("fails final commands that mutate the tracked integration subject", () => {
    useRepositoryConfig({ test: "npm test" });

    const resetIntegration = vi.fn();
    const request = childExecutorRequest({
      actionKind: "final_command",
      unitId: null,
      worktree: null,
      commandName: "test",
      inputSubject: "4".repeat(40),
    });
    const result = executeChildAction({
      request,
      executeCommand: () => ({ exitCode: 0, signal: null, timedOut: false, stdout: "ok", stderr: "" }),
      commitSubject: () => "5".repeat(40),
      isClean: () => true,
      resetIntegration,
    });
    const receipt = JSON.parse(result.receipt);

    expect(result).toMatchObject({
      outcome: "failure",
      subject: request.inputSubject,
    });
    expect(resetIntegration).toHaveBeenCalledWith({ repoDir: "/home/agent/repo", subject: request.inputSubject });
    expect(receipt).toMatchObject({
      type: "command_result",
      result: "failure",
      subject: {
        pre: request.inputSubject,
        post: request.inputSubject,
      },
      payload: {
        command: "test",
        exit_code: 1,
        summary: expect.stringContaining("mutated the tracked integration subject"),
      },
    });
  });

  it("keeps final command subjects bound to the integration commit when the checkout stays clean", () => {
    useRepositoryConfig({ test: "npm test" });

    const resetIntegration = vi.fn();
    const request = childExecutorRequest({
      actionKind: "final_command",
      unitId: null,
      worktree: null,
      commandName: "test",
      inputSubject: "4".repeat(40),
    });
    const result = executeChildAction({
      request,
      executeCommand: () => ({ exitCode: 0, signal: null, timedOut: false, stdout: "ok", stderr: "" }),
      commitSubject: () => request.inputSubject,
      isClean: () => true,
      resetIntegration,
    });
    const receipt = JSON.parse(result.receipt);

    expect(result).toMatchObject({
      outcome: "success",
      subject: request.inputSubject,
    });
    expect(resetIntegration).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      type: "command_result",
      result: "success",
      subject: {
        pre: request.inputSubject,
        post: request.inputSubject,
      },
    });
  });

  it("fails and restores final commands that leave the integration checkout dirty", () => {
    useRepositoryConfig({ test: "npm test" });

    const resetIntegration = vi.fn();
    const request = childExecutorRequest({
      actionKind: "final_command",
      unitId: null,
      worktree: null,
      commandName: "test",
      inputSubject: "4".repeat(40),
    });
    const result = executeChildAction({
      request,
      executeCommand: () => ({ exitCode: 0, signal: null, timedOut: false, stdout: "ok", stderr: "" }),
      commitSubject: () => request.inputSubject,
      isClean: () => false,
      resetIntegration,
    });
    const receipt = JSON.parse(result.receipt);

    expect(result).toMatchObject({
      outcome: "failure",
      subject: request.inputSubject,
    });
    expect(resetIntegration).toHaveBeenCalledWith({ repoDir: "/home/agent/repo", subject: request.inputSubject });
    expect(receipt).toMatchObject({
      type: "command_result",
      result: "failure",
      subject: {
        pre: request.inputSubject,
        post: request.inputSubject,
      },
      payload: {
        command: "test",
        exit_code: 1,
        summary: expect.stringContaining("mutated the tracked integration subject"),
      },
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

  it("bootstraps a granted unit worktree from the sealed post_bootstrap before the repository command", () => {
    const configFile = useRepositoryConfig({ test: "npm test" }, { post_bootstrap: ["npm ci"] });

    const events = [];
    let bootstrapInput = null;
    const executeCommand = ({ command, repoDir }) => {
      events.push(`command:${command}:${repoDir}`);
      return { exitCode: 0, signal: null, timedOut: false, stdout: "ok", stderr: "" };
    };
    const request = childExecutorRequest({ commandName: "test" });
    const result = executeChildAction({
      request,
      grantWorktree: ({ handle }) => {
        events.push(`grant:${handle}`);
        return { id: handle, path: `/tmp/${handle}`, writable: true };
      },
      bootstrapWorktree: (input) => {
        events.push(`bootstrap:${input.worktreeDir}:${input.handle}`);
        bootstrapInput = input;
        return { bootstrapped: true, commands: 1 };
      },
      executeCommand,
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
      "bootstrap:/tmp/worktree-1:worktree-1",
      "command:npm test:/tmp/worktree-1",
      "subject:/tmp/worktree-1",
      "lock:worktree-1",
    ]);
    expect(result.outcome).toBe("success");
    // The bootstrap must run the sealed config's commands through the exact
    // same fenced executor as the repository command, under the sealed
    // config digest, so its execution surface can never drift.
    expect(bootstrapInput.executeCommand).toBe(executeCommand);
    expect(bootstrapInput.commandTimeoutMs).toBe(7_200_000);
    expect(bootstrapInput.config).toMatchObject({ post_bootstrap: ["npm ci"] });
    expect(bootstrapInput.configDigest).toBe(digest(readFileSync(configFile, "utf8")));
  });

  it("classifies a worktree bootstrap failure as retryable infrastructure and relocks without a command receipt", () => {
    useRepositoryConfig({ test: "npm test" }, { post_bootstrap: ["npm ci"] });

    const events = [];
    const request = childExecutorRequest({ commandName: "test" });
    let thrown = null;
    try {
      executeChildAction({
        request,
        grantWorktree: ({ handle }) => ({ id: handle, path: `/tmp/${handle}`, writable: true }),
        bootstrapWorktree: () => {
          throw new Error("worktree bootstrap command exited with 127: npm ci");
        },
        executeCommand: () => {
          events.push("command");
          return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
        },
        computeSubject: () => {
          events.push("subject");
          return "3".repeat(40);
        },
        lockWorktreeHandle: () => {
          events.push("lock");
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown?.message).toMatch(/worktree bootstrap command exited with 127/);
    // The repository command never ran and no receipt was produced, but the
    // worktree still converged back to its locked state.
    expect(events).toEqual(["lock"]);
    const failure = childActionFailureResult(request, thrown);
    expect(failure).toMatchObject({
      kind: "child_executor_action_result",
      outcome: "retryable_infrastructure_failure",
      subject: request.inputSubject,
      receipt: expect.stringContaining("worktree bootstrap command exited with 127"),
    });
  });

  it("does not bootstrap final commands, which run in the bake-once integration checkout", () => {
    useRepositoryConfig({ test: "npm test" }, { post_bootstrap: ["npm ci"] });

    const bootstrapWorktree = vi.fn();
    const request = childExecutorRequest({
      actionKind: "final_command",
      unitId: null,
      worktree: null,
      commandName: "test",
      inputSubject: "4".repeat(40),
    });
    const result = executeChildAction({
      request,
      bootstrapWorktree,
      executeCommand: () => ({ exitCode: 0, signal: null, timedOut: false, stdout: "ok", stderr: "" }),
      commitSubject: () => request.inputSubject,
      isClean: () => true,
      resetIntegration: vi.fn(),
    });

    expect(result.outcome).toBe("success");
    expect(bootstrapWorktree).not.toHaveBeenCalled();
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
