import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLoopRequestHash,
  executeLoopAction,
  loopAgentCommand,
  parseLoopReceipt,
  loopPrompt,
  resolveLoopInvocation,
  validateLoopRequest,
} from "./execute-loop.mjs";
import { computeWorkspaceTreeOid } from "./repository-control.mjs";

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
    runId: "run-1",
    pipelineInstanceId: "instance-1",
    graphId: "graph-1",
    graphDigest: "a".repeat(64),
    unitId: "unit-1",
    role: "worker",
    loop: "implement",
    agent: "codex",
    skill: "implement-unit",
    worktree: { id: "unit-1", path: repository() },
    nativeSessionId: null,
    contextPolicy: "prefer_resume",
    timeoutMs: 30_000,
    transitionContext: "Implement the unit.",
    allowedMcpServers: ["github"],
    credentialScopes: ["model.invoke", "repo.read", "repo.write"],
    receiptSchema: "openthrottle.receipt/v1",
    ...overrides,
  };
  return { ...withoutFence, ...createLoopRequestHash(withoutFence) };
}

function standardReceipt(loopRequest, overrides = {}) {
  return {
    schema: "openthrottle.receipt/v1",
    type: "unit_completion",
    assurance: "semantic_attested",
    result: "success",
    producer: {
      worker_id: "worker-1",
      skill: "builtin://implement-unit@1",
      capability_digest: "c".repeat(64),
    },
    subject: {
      base: "1".repeat(40),
      pre: "1".repeat(40),
      post: computeWorkspaceTreeOid(loopRequest.worktree.path),
    },
    fence: {
      pipeline_instance_id: "instance-1",
      graph_digest: loopRequest.graphDigest,
      unit_id: loopRequest.unitId,
      attempt_id: loopRequest.attemptId,
      request_hash: loopRequest.requestHash,
    },
    evidence: ["implemented unit"],
    payload: {
      summary: "Implemented the unit.",
      assumptions: [],
      decisions: [],
      issues: [],
      verification: ["focused test passed"],
      downstream_context: [],
      requested_human_input: [],
    },
    issued_at: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
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

  it("shows the exact receipt fence to the child agent", () => {
    const valid = validateLoopRequest(request());
    const prompt = loopPrompt(valid);
    expect(prompt).toContain("\"pipeline_instance_id\":\"instance-1\"");
    expect(prompt).toContain(`"graph_digest":"${"a".repeat(64)}"`);
    expect(prompt).toContain("\"unit_id\":\"unit-1\"");
    expect(prompt).toContain("\"attempt_id\":\"attempt-1\"");
    expect(prompt).toContain(`"request_hash":"${valid.requestHash}"`);
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
    const receipt = standardReceipt(valid);
    const runLoopAgent = vi.fn(() => ({
      status: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify(receipt),
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
      created_at: "2026-07-29T00:00:00.000Z",
    });
    expect(JSON.parse(result.receipt)).toMatchObject({ type: "unit_completion", result: "success" });
    expect(result.subject).toMatch(/^[a-f0-9]{40}$/);
  });

  it("rejects successful loop exits without a valid standard receipt", () => {
    const result = executeLoopAction({
      request: request(),
      runLoopAgent: () => ({
        status: 0,
        signal: null,
        timedOut: false,
        stdout: "{\"receipt\":\"ok\"}",
        stderr: "",
        nativeSessionId: "thread-1",
      }),
      now: () => "2026-07-29T00:00:00.000Z",
    });

    expect(result.outcome).toBe("failure");
    expect(result.receipt).toMatch(/invalid standard receipt/);
  });

  it("extracts a standard receipt from JSONL agent output", () => {
    const valid = request();
    const receipt = standardReceipt(valid, { result: "needs_human" });
    expect(parseLoopReceipt([
      JSON.stringify({ type: "event", message: "working" }),
      JSON.stringify({ type: "result", receipt }),
    ].join("\n"), {})).toMatchObject({
      type: "unit_completion",
      result: "needs_human",
    });
  });
});
