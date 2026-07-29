import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLoopRequestHash,
  executeLoopAction,
  loopAgentCommand,
  loopPrompt,
  resolveLoopInvocation,
  validateLoopRequest,
} from "./execute-loop.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository() {
  const directory = mkdtempSync(join(tmpdir(), "ot-loop-repo-"));
  directories.push(directory);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  writeFileSync(join(directory, "file.txt"), "initial\n");
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: directory });
  return directory;
}

function request(overrides = {}) {
  const withoutFence = {
    protocol: "loop-action@1",
    actionId: "action-1",
    attemptId: "attempt-1",
    graphId: "graph-1",
    unitId: "unit-1",
    role: "worker",
    loop: "implement",
    agent: "codex",
    skill: "ce-work",
    worktree: { id: "unit-1", path: repository() },
    nativeSessionId: null,
    contextPolicy: "prefer_resume",
    timeoutMs: 30_000,
    transitionContext: "Implement the unit.",
    allowedMcpServers: ["github"],
    credentialScopes: ["model.invoke", "repo.read", "repo.write"],
    receiptSchema: "openthrottle.loop-receipt@1",
    ...overrides,
  };
  return { ...withoutFence, ...createLoopRequestHash(withoutFence) };
}

describe("loop action request validation", () => {
  it("validates a fenced worker request and rejects stale hashes", () => {
    const valid = request();
    expect(validateLoopRequest(valid)).toMatchObject({
      actionId: "action-1",
      worktree: { id: "unit-1" },
    });
    expect(() => validateLoopRequest({ ...valid, skill: "ce-code-review" })).toThrow(/stale/);
  });

  it("enforces role/worktree and session reuse rules", () => {
    expect(() => validateLoopRequest(request({ role: "lead", loop: "lead", worktree: null }))).not.toThrow();
    expect(() => validateLoopRequest(request({ role: "lead", loop: "lead" }))).toThrow(/non-worker/);
    expect(() => validateLoopRequest(request({ contextPolicy: "resume_required", nativeSessionId: null })))
      .toThrow(/missing its native session/);
    expect(() => validateLoopRequest(request({ transitionContext: undefined })))
      .toThrow(/transitionContext is invalid/);

    const resume = validateLoopRequest(request({
      nativeSessionId: "native-1",
      contextPolicy: "resume_required",
    }));
    expect(resolveLoopInvocation(resume)).toEqual({ mode: "resume", nativeSessionId: "native-1" });
  });

  it("enters only the sealed skill named by the loop request", () => {
    const valid = validateLoopRequest(request({ skill: "ce-simplify-code", loop: "simplify" }));
    expect(loopPrompt(valid).split("\n")[0]).toBe("$ce-simplify-code");
    expect(loopPrompt(valid)).not.toContain("$ce-work");
  });

  it("passes native session IDs to every resumable engine adapter", () => {
    for (const agent of ["claude", "opencode"]) {
      const valid = validateLoopRequest(request({
        agent,
        nativeSessionId: "native-1",
        contextPolicy: "resume_required",
      }));
      const built = loopAgentCommand({ request: valid, invocation: resolveLoopInvocation(valid) });
      expect(built.args).toContain(agent === "claude" ? "--resume" : "--session");
      expect(built.args).toContain("native-1");
    }
  });
});

describe("executeLoopAction", () => {
  it("writes a typed result with worker receipt, native session, and subject", () => {
    const valid = request();
    const runLoopAgent = vi.fn(() => ({
      status: 0,
      signal: null,
      timedOut: false,
      stdout: "{\"receipt\":\"ok\"}",
      stderr: "",
      nativeSessionId: "thread-1",
    }));

    const result = executeLoopAction({ request: valid, runLoopAgent, now: () => "2026-07-29T00:00:00.000Z" });

    expect(runLoopAgent).toHaveBeenCalledWith(expect.objectContaining({
      invocation: { mode: "fresh", nativeSessionId: null },
    }));
    expect(result).toMatchObject({
      kind: "loop_action_result",
      action_id: "action-1",
      outcome: "success",
      native_session_id: "thread-1",
      receipt: "{\"receipt\":\"ok\"}",
      created_at: "2026-07-29T00:00:00.000Z",
    });
    expect(result.subject).toMatch(/^[a-f0-9]{40}$/);
  });
});
