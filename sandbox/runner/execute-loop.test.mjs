import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLoopRequestHash,
  executeLoopAction,
  loopAgentCommand,
  loopResultPath,
  loopWorktreeDirectory,
  parseLoopReceipt,
  loopPrompt,
  runLoopAgentInPreparedRepository,
  resolveLoopInvocation,
  validateLoopRequest,
} from "./execute-loop.mjs";
import { computeWorkspaceTreeOid } from "./repository-control.mjs";
import { canonicalJson } from "./capabilities.mjs";
import { digest } from "./artifacts.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    try {
      if (existsSync(directory)) execFileSync("chmod", ["-R", "u+rwX", directory]);
    } catch {
      // Some tests deliberately create root-owned paths in the image; best-effort
      // cleanup keeps host Vitest from depending on those permissions.
    }
    rmSync(directory, { recursive: true, force: true });
  }
  delete process.env.OT_LOOP_ACTION_ROOT;
  delete process.env.OT_WORKTREE_ROOT;
});

function repository() {
  const directory = mkdtempSync(join(tmpdir(), "ot-loop-repo-"));
  directories.push(directory);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  writeFileSync(join(directory, "file.txt"), "initial\n");
  mkdirSync(join(directory, "skills/implement-unit"), { recursive: true });
  writeFileSync(join(directory, "skills/implement-unit/SKILL.md"), [
    "---",
    "name: implement_unit",
    "description: Test repository skill",
    "---",
    "",
    "Implement the unit from the pinned repository package.",
    "",
  ].join("\n"));
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: directory });
  return directory;
}

function request(overrides = {}) {
  const repoDir = repository();
  const rootDir = mkdtempSync(join(tmpdir(), "ot-loop-worktrees-"));
  directories.push(rootDir);
  const handle = "unit-1";
  renameSync(repoDir, join(rootDir, handle));
  process.env.OT_WORKTREE_ROOT = rootDir;
  const withoutFence = {
    protocol: "loop-action@1",
    actionId: "action-1",
    attemptId: "attempt-1",
    graphId: "graph-1",
    unitId: "unit-1",
    role: "worker",
    loop: "implement",
    agent: "codex",
    skill: "implement-unit",
    worktree: { id: handle },
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

function repositorySkillPackage(repoDir, invocation = "implement_unit") {
  const skillPath = "skills/implement-unit/SKILL.md";
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  const blobSha = execFileSync("git", ["rev-parse", `${head}:${skillPath}`], { cwd: repoDir, encoding: "utf8" }).trim();
  const unsigned = {
    schema: "openthrottle.repository-skill-package/v1",
    reference: `repo://owner/repo@${head}#skills/implement-unit`,
    invocation,
    directory: "skills/implement-unit",
    commit: head,
    files: [{
      path: skillPath,
      blobSha,
      digest: digest(readFileSync(join(repoDir, skillPath))),
    }],
  };
  return { ...unsigned, packageDigest: digest(canonicalJson(unsigned)) };
}

function repositorySkillRequest() {
  const repoDir = repository();
  const rootDir = mkdtempSync(join(tmpdir(), "ot-loop-worktrees-"));
  directories.push(rootDir);
  const handle = "unit-1";
  renameSync(repoDir, join(rootDir, handle));
  const worktreeDir = join(rootDir, handle);
  process.env.OT_WORKTREE_ROOT = rootDir;
  const repositorySkill = repositorySkillPackage(worktreeDir);
  const withoutFence = {
    protocol: "loop-action@1",
    actionId: "action-repo-skill",
    attemptId: "attempt-repo-skill",
    graphId: "graph-1",
    unitId: "unit-1",
    role: "worker",
    loop: "implement",
    agent: "codex",
    skill: repositorySkill.invocation,
    worktree: { id: handle },
    nativeSessionId: null,
    contextPolicy: "fresh",
    timeoutMs: 30_000,
    transitionContext: "Implement the unit.",
    allowedMcpServers: [],
    credentialScopes: ["model.invoke", "repo.read", "repo.write"],
    receiptSchema: "probe/no-receipt@1",
    repositorySkill,
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
      post: computeWorkspaceTreeOid(loopWorktreeDirectory(loopRequest)),
    },
    fence: {
      pipeline_instance_id: "instance-1",
      graph_digest: "a".repeat(64),
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

  it("rejects absolute worktree paths and writes action-attempt scoped result paths", () => {
    const withPath = {
      protocol: "loop-action@1",
      actionId: "action-2",
      attemptId: "attempt-2",
      graphId: "graph-1",
      unitId: "unit-1",
      role: "worker",
      loop: "implement",
      agent: "codex",
      skill: "implement-unit",
      worktree: { id: "unit-1", path: "/tmp/escape" },
      nativeSessionId: null,
      contextPolicy: "prefer_resume",
      timeoutMs: 30_000,
      transitionContext: "Implement the unit.",
      allowedMcpServers: [],
      credentialScopes: ["model.invoke", "repo.read"],
      receiptSchema: "openthrottle.receipt/v1",
    };
    expect(() => validateLoopRequest({ ...withPath, ...createLoopRequestHash(withPath) }))
      .toThrow(/absolute worktree path/);
    const withUnknown = { ...withPath, worktree: { id: "unit-1", hidden: "/tmp/escape" } };
    expect(() => validateLoopRequest({ ...withUnknown, ...createLoopRequestHash(withUnknown) }))
      .toThrow(/worktree has unknown field/);
    expect(loopResultPath({ attemptId: "attempt-2", actionId: "action-2", rootDir: "/var/ot" }))
      .toBe("/var/ot/attempt-2/action-2/result.json");
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

  it("validates repository skill packages as sealed loop input", () => {
    const valid = validateLoopRequest(repositorySkillRequest());
    expect(valid.skill).toBe("implement_unit");
    expect(valid.repositorySkill?.invocation).toBe("implement_unit");
    expect(loopPrompt(valid).split("\n")[0]).toBe("$implement_unit");
    const mismatched = {
      ...valid,
      skill: "other_skill",
    };
    const { requestHash: _requestHash, idempotencyKey: _idempotencyKey, ...withoutFence } = mismatched;
    const refencedRequest = { ...withoutFence, ...createLoopRequestHash(withoutFence) };
    expect(() => validateLoopRequest(refencedRequest)).toThrow(/repository skill invocation mismatch/);
    const wrongCommit = {
      ...valid,
      repositorySkill: {
        ...valid.repositorySkill,
        reference: valid.repositorySkill.reference.replace(valid.repositorySkill.commit, "0".repeat(40)),
      },
    };
    const { requestHash: _wrongCommitHash, idempotencyKey: _wrongCommitKey, ...wrongCommitWithoutFence } = wrongCommit;
    expect(() => validateLoopRequest({
      ...wrongCommitWithoutFence,
      ...createLoopRequestHash(wrongCommitWithoutFence),
    })).toThrow(/reference must match/);
    const wrongDirectory = {
      ...valid,
      repositorySkill: {
        ...valid.repositorySkill,
        reference: valid.repositorySkill.reference.replace("#skills/implement-unit", "#skills/other"),
      },
    };
    const { requestHash: _wrongDirectoryHash, idempotencyKey: _wrongDirectoryKey, ...wrongDirectoryWithoutFence } = wrongDirectory;
    expect(() => validateLoopRequest({
      ...wrongDirectoryWithoutFence,
      ...createLoopRequestHash(wrongDirectoryWithoutFence),
    })).toThrow(/reference must match/);
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

  it("keeps the integration checkout locked around worker execution", () => {
    const valid = validateLoopRequest(request());
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    const integrationRepoDir = mkdtempSync(join(tmpdir(), "ot-loop-integration-"));
    directories.push(actionRoot, integrationRepoDir);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;
    const events = [];

    const result = runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir,
      lockIntegration: (path, options) => {
        events.push(`lock-integration:${path}:${"preservedLinkedGitDir" in options}`);
        return true;
      },
      runProcess: (command, args, options) => {
        events.push(`run:${command}:${options.cwd}`);
        expect(args).toContain("GIT_OPTIONAL_LOCKS=0");
        expect(args.find((entry) => entry.startsWith("GIT_OBJECT_DIRECTORY="))).toMatch(/git-objects\/write$/);
        expect(args.find((entry) => entry.startsWith("GIT_ALTERNATE_OBJECT_DIRECTORIES="))).toMatch(/git-objects\/base$/);
        expect(options.cwd).toBe(loopWorktreeDirectory(valid));
        return { status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" };
      },
    });

    expect(result.status).toBe(0);
    expect(events).toEqual([
      `lock-integration:${integrationRepoDir}:true`,
      `run:gosu:${loopWorktreeDirectory(valid)}`,
      `lock-integration:${integrationRepoDir}:true`,
    ]);
  });

  it("locks sibling action directories under the configured action root", () => {
    const valid = validateLoopRequest(request());
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    const siblingDirectory = join(actionRoot, valid.attemptId, "sibling-action");
    const siblingSecret = join(siblingDirectory, "secret.txt");
    directories.push(actionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;
    mkdirSync(siblingDirectory, { recursive: true, mode: 0o755 });
    chmodSync(siblingDirectory, 0o755);
    writeFileSync(siblingSecret, "sibling\n", { mode: 0o644 });
    chmodSync(siblingSecret, 0o644);

    runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir: "/tmp/integration",
      lockIntegration: () => true,
      runProcess: () => ({ status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" }),
    });

    expect(statSync(siblingDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(siblingSecret).mode & 0o777).toBe(0o600);
  });

  it("materializes only the current sealed repository skill under the action discovery root", () => {
    const valid = validateLoopRequest(repositorySkillRequest());
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    directories.push(actionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;

    runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir: "/tmp/integration",
      lockIntegration: () => true,
      runProcess: (command, args) => {
        expect(command).toBe("gosu");
        const codexHome = join(actionRoot, valid.attemptId, valid.actionId, "codex");
        expect(args).toContain(`HOME=${join(actionRoot, valid.attemptId, valid.actionId, "home")}`);
        expect(args).toContain(`CODEX_HOME=${codexHome}`);
        const skillRoot = join(codexHome, "skills", valid.repositorySkill.invocation);
        expect(readFileSync(join(skillRoot, "SKILL.md"), "utf8")).toContain("pinned repository package");
        expect(statSync(skillRoot).mode & 0o777).toBe(0o555);
        return { status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" };
      },
    });
  });

  it("leaves the integration checkout locked when agent launch throws", () => {
    const valid = validateLoopRequest(request());
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    directories.push(actionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;
    const events = [];

    expect(() => runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir: "/tmp/integration",
      lockIntegration: () => {
        events.push("lock-integration");
        return true;
      },
      runProcess: () => {
        events.push("run");
        throw new Error("agent launch failed");
      },
    })).toThrow(/agent launch failed/);

    expect(events).toEqual(["lock-integration", "run", "lock-integration"]);
  });
});

describe("executeLoopAction", () => {
  it("writes a typed result with worker receipt, native session, and subject", () => {
    const valid = request();
    const receipt = standardReceipt(valid);
    const lockWorkerWorktree = vi.fn();
    const runLoopAgent = vi.fn(() => ({
      status: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify(receipt),
      stderr: "",
      nativeSessionId: "thread-1",
    }));

    const result = executeLoopAction({
      request: valid,
      runLoopAgent,
      lockWorkerWorktree,
      now: () => "2026-07-29T00:00:00.000Z",
    });

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
    expect(lockWorkerWorktree).toHaveBeenCalledWith(expect.objectContaining({ worktree: { id: "unit-1" } }));
  });

  it("rejects successful loop exits without a valid standard receipt", () => {
    const lockWorkerWorktree = vi.fn();
    const result = executeLoopAction({
      request: request(),
      lockWorkerWorktree,
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
    expect(lockWorkerWorktree).toHaveBeenCalledOnce();
  });

  it("relocks the worker worktree when the loop agent throws before evidence", () => {
    const lockWorkerWorktree = vi.fn();
    const result = executeLoopAction({
      request: request(),
      lockWorkerWorktree,
      runLoopAgent: () => {
        throw new Error("agent launch failed");
      },
      now: () => "2026-07-29T00:00:00.000Z",
    });

    expect(result.outcome).toBe("failure");
    expect(result.receipt).toMatch(/agent launch failed/);
    expect(lockWorkerWorktree).toHaveBeenCalledOnce();
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
