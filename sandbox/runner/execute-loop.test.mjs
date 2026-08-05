import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLoopRequestHash,
  executeLoopAction,
  gitSafeDirectoryConfigArgs,
  lockPersistentAgentPrivateRoots,
  loopAgentCommand,
  loopCredentialsPath,
  loopRequestPath,
  loopResultPath,
  loopWorktreeDirectory,
  parseLoopReceipt,
  restorePersistentAgentPrivateRoots,
  loopPrompt,
  runLoopAgentInPreparedRepository,
  resolveLoopInvocation,
  validateLoopRequest,
} from "./execute-loop.mjs";
import {
  MAX_NATIVE_SESSION_BYTES,
  MAX_NATIVE_SESSION_FILES,
  materializeNativeSessionState,
  nativeSessionStoragePath,
  sealNativeSessionPackage,
} from "./native-session-package.mjs";
import { computeWorkspaceTreeOid } from "./repository-control.mjs";
import { canonicalJson } from "./capabilities.mjs";
import { digest } from "./artifacts.mjs";

const directories = [];

beforeEach(() => {
  // The sandbox image bakes a root-owned trusted baseline at the default root,
  // which an unprivileged in-image test run cannot copy from; point tests at an
  // empty hermetic root so the suite behaves identically on CI hosts, macOS,
  // and inside the built image.
  const baselineRoot = mkdtempSync(join(tmpdir(), "ot-baseline-root-"));
  directories.push(baselineRoot);
  process.env.OT_ACTION_HOME_BASELINE_ROOT = baselineRoot;
});

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
  delete process.env.OT_ACTION_HOME_BASELINE_ROOT;
  delete process.env.OT_LOOP_ACTION_ROOT;
  delete process.env.OT_WORKTREE_ROOT;
  delete process.env.OT_INTEGRATION_REPO_DIR;
  delete process.env.OT_NATIVE_SESSION_SOURCE_ROOT;
  delete process.env.OT_STAGE_CONFIG_FILE;
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
    protocol: "loop-action@2",
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

function leadRequest(overrides = {}) {
  return request({
    role: "lead",
    loop: "lead",
    worktree: null,
    candidateSubject: "a".repeat(40),
    credentialScopes: ["model.invoke", "repo.read"],
    ...overrides,
  });
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
    protocol: "loop-action@2",
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
    receiptSchema: "openthrottle.receipt/v1",
    repositorySkill,
  };
  return { ...withoutFence, ...createLoopRequestHash(withoutFence) };
}

function withFreshLoopFence(loopRequest, overrides = {}) {
  const { requestHash: _requestHash, idempotencyKey: _idempotencyKey, ...withoutFence } = {
    ...loopRequest,
    ...overrides,
  };
  return validateLoopRequest({ ...withoutFence, ...createLoopRequestHash(withoutFence) });
}

function sessionEventFixture(agent, nativeSessionId) {
  if (agent === "claude") return `{"type":"system","session_id":"${nativeSessionId}"}\n`;
  if (agent === "codex") return `{"type":"thread.started","thread_id":"${nativeSessionId}"}\n`;
  return `{"type":"step_start","sessionID":"${nativeSessionId}"}\n`;
}

function sessionStorageFixture(agent, nativeSessionId) {
  if (agent === "claude") return `{"type":"user","sessionId":"${nativeSessionId}","message":{"role":"user","content":"x"}}\n`;
  if (agent === "codex") return `{"type":"session_meta","payload":{"id":"${nativeSessionId}"}}\n`;
  return `{"type":"step_start","sessionID":"${nativeSessionId}"}\n`;
}

function sealSessionFixture({ agent, nativeSessionId = "native-1", sourceRoot, fileName = `${nativeSessionId}.jsonl`, contents = sessionStorageFixture(agent, nativeSessionId) }) {
  const profileRoot = mkdtempSync(join(tmpdir(), `ot-loop-profile-${agent}-`));
  directories.push(profileRoot);
  const sessionStore = nativeSessionStoragePath(agent, profileRoot);
  mkdirSync(sessionStore, { recursive: true });
  writeFileSync(join(sessionStore, fileName), contents);
  return sealNativeSessionPackage({ agent, nativeSessionId, profileRoot, sourceRoot });
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
      skill_package_digest: null,
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
      parent_run_id: "run-1",
      action_attempt_id: "action-1",
      generation: 1,
      native_session_id: loopRequest.nativeSessionId,
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

function executeLoopActionWithIntegration(options) {
  return executeLoopAction({
    integrationRepoDir: repository(),
    ...options,
  });
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
      protocol: "loop-action@2",
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
    expect(loopCredentialsPath({ attemptId: "attempt-2", actionId: "action-2", rootDir: "/var/ot" }))
      .toBe("/var/ot/attempt-2/action-2/credentials.json");
  });

  it("rejects slash-bearing action IDs before deriving action paths", () => {
    expect(() => validateLoopRequest(request({ actionId: "unit/1" }))).toThrow(/actionId is invalid/);
    expect(() => validateLoopRequest(request({ attemptId: "attempt/1" }))).toThrow(/attemptId is invalid/);
    expect(() => validateLoopRequest(request({ nativeSessionId: "native/../sibling" }))).toThrow(/nativeSessionId is invalid/);
    expect(() => loopResultPath({ attemptId: "attempt/1", actionId: "action", rootDir: "/var/ot" }))
      .toThrow(/attemptId is invalid/);
    expect(() => loopRequestPath({ attemptId: "attempt", actionId: "action/1", rootDir: "/var/ot" }))
      .toThrow(/actionId is invalid/);
    expect(() => loopCredentialsPath({ attemptId: "attempt/1", actionId: "action", rootDir: "/var/ot" }))
      .toThrow(/attemptId is invalid/);
  });

  it.each([
    "probe/no-receipt@1",
    "openthrottle.loop-receipt@1",
    "vendor.example.receipt/v1",
  ])("rejects unsupported receipt schema %s before loop execution", (receiptSchema) => {
    expect(() => validateLoopRequest(request({ receiptSchema })))
      .toThrow(/loop receipt schema is unsupported/);
  });

  it("does not invoke the loop agent for unsupported receipt schemas", () => {
    const runLoopAgent = vi.fn(() => ({
      status: 0,
      signal: null,
      timedOut: false,
      stdout: "opaque success",
      stderr: "",
      nativeSessionId: "thread-1",
    }));

    expect(() => executeLoopActionWithIntegration({
      request: request({ receiptSchema: "vendor.example.receipt/v1" }),
      runLoopAgent,
    })).toThrow(/loop receipt schema is unsupported/);
    expect(runLoopAgent).not.toHaveBeenCalled();
  });

  it("enforces role/worktree and session reuse rules", () => {
    expect(() => validateLoopRequest(leadRequest())).not.toThrow();
    expect(() => validateLoopRequest(leadRequest({ candidateSubject: undefined }))).toThrow(/candidate subject/);
    expect(() => validateLoopRequest(request({ candidateSubject: "a".repeat(40) }))).toThrow(/candidate subject/);
    expect(() => validateLoopRequest(leadRequest({ worktree: { id: "unit-1" } }))).toThrow(/non-worker/);
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
    const longReference = {
      ...valid,
      repositorySkill: {
        ...valid.repositorySkill,
        reference: `repo://${"o".repeat(140)}/${"r".repeat(140)}@${valid.repositorySkill.commit}#skills/implement-unit`,
      },
    };
    const { requestHash: _longReferenceHash, idempotencyKey: _longReferenceKey, ...longReferenceWithoutFence } = longReference;
    expect(() => validateLoopRequest({
      ...longReferenceWithoutFence,
      ...createLoopRequestHash(longReferenceWithoutFence),
    })).toThrow(/repositorySkill\.reference is invalid/);
  });

  it("passes native session IDs to every resumable engine adapter", () => {
    for (const agent of ["claude", "codex"]) {
      const valid = validateLoopRequest(request({
        agent,
        nativeSessionId: "native-1",
        contextPolicy: "resume_required",
      }));
      const built = loopAgentCommand({ request: valid, invocation: resolveLoopInvocation(valid) });
      expect(built.args).toContain(agent === "claude" ? "--resume" : "resume");
      expect(built.args).toContain("native-1");
      if (agent === "codex") {
        expect(built.args.at(-1)).toBe(loopPrompt(valid));
        expect(built.input).toBeUndefined();
      }
    }
  });

  it("rejects opencode loop actions until their session-store contract lands", () => {
    expect(() => validateLoopRequest(request({ agent: "opencode" })))
      .toThrow(/opencode loop actions are not supported/);
  });

  it("rejects a loop request declaring a credential scope outside the closed logical set", () => {
    expect(() => validateLoopRequest(request({ credentialScopes: ["daytona.admin"] })))
      .toThrow(/credential scope daytona\.admin is not a recognized logical credential/);
  });

  it("rejects lead loop requests carrying write credentials while preserving worker writes", () => {
    expect(() => validateLoopRequest(leadRequest({
      credentialScopes: ["model.invoke", "repo.read", "repo.write"],
    }))).toThrow(/lead loop cannot request repo\.write/);

    expect(() => validateLoopRequest(request({
      role: "worker",
      loop: "implement",
      credentialScopes: ["model.invoke", "repo.read", "repo.write"],
    }))).not.toThrow();
  });

  it("accepts every closed logical credential scope, including mcp", () => {
    expect(() => validateLoopRequest(request({
      credentialScopes: ["mcp", "model.invoke", "provider.read", "repo.read", "repo.write"],
    }))).not.toThrow();
  });

  it("keeps the sandbox-side logical credential scope set aligned with contracts' LOGICAL_CREDENTIALS", () => {
    // execute-loop.mjs cannot import @openthrottle/contracts (sandbox is a
    // separate deployable with no TS build step), so its LOGICAL_CREDENTIAL_SCOPES
    // is a hand-mirrored copy of contracts/src/graph.ts's LOGICAL_CREDENTIALS.
    // Cross-check the two source texts so a future change to one is caught
    // if the other isn't updated to match.
    const sandboxSource = readFileSync(new URL("./execute-loop.mjs", import.meta.url), "utf8");
    const sandboxMatch = sandboxSource.match(/const LOGICAL_CREDENTIAL_SCOPES = new Set\(\[([^\]]+)\]\);/);
    expect(sandboxMatch).not.toBeNull();
    const sandboxScopes = JSON.parse(`[${sandboxMatch[1]}]`).sort();

    const contractsSource = readFileSync(new URL("../../contracts/src/graph.ts", import.meta.url), "utf8");
    const contractsMatch = contractsSource.match(/export const LOGICAL_CREDENTIALS = \[([^\]]+)\] as const;/);
    expect(contractsMatch).not.toBeNull();
    const contractsScopes = JSON.parse(`[${contractsMatch[1]}]`).sort();

    expect(sandboxScopes).toEqual(contractsScopes);
  });

  it("always closes Claude MCP discovery with --strict-mcp-config, adding --mcp-config only when a path is supplied", () => {
    const valid = validateLoopRequest(request({ agent: "claude" }));
    const withoutMcp = loopAgentCommand({ request: valid, invocation: resolveLoopInvocation(valid) });
    expect(withoutMcp.args).not.toContain("--mcp-config");
    // Even with zero declared MCP servers, --strict-mcp-config must still be
    // present so this action cannot fall back to a repo-committed .mcp.json
    // or other ambient MCP discovery outside its declared scope.
    expect(withoutMcp.args).toContain("--strict-mcp-config");

    const withMcp = loopAgentCommand({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      mcpConfigPath: "/tmp/action/mcp/mcp-config.json",
    });
    const index = withMcp.args.indexOf("--mcp-config");
    expect(index).toBeGreaterThan(-1);
    expect(withMcp.args[index + 1]).toBe("/tmp/action/mcp/mcp-config.json");
    expect(withMcp.args).toContain("--strict-mcp-config");
  });

  it("delivers the pinned Compound Engineering plugin to Claude loop actions", () => {
    const fresh = validateLoopRequest(request({ agent: "claude" }));
    const resumed = validateLoopRequest(request({
      agent: "claude",
      nativeSessionId: "native-1",
      contextPolicy: "resume_required",
    }));
    for (const valid of [fresh, resumed]) {
      const built = loopAgentCommand({ request: valid, invocation: resolveLoopInvocation(valid) });
      const args = built.args.join("\n");
      expect(args).toContain("--plugin-dir\n/opt/openthrottle/compound-engineering-marketplace");
      expect(args).toContain("--setting-sources\nuser");
    }
  });

  it("passes fresh Codex prompts over stdin", () => {
    const valid = validateLoopRequest(request({ agent: "codex" }));
    const built = loopAgentCommand({ request: valid, invocation: resolveLoopInvocation(valid) });
    expect(built.args.at(-1)).toBe("-");
    expect(built.input).toBe(loopPrompt(valid));
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
      processFence: (execute) => {
        events.push("process-fence");
        return execute();
      },
      lockIntegration: (path) => {
        events.push(`lock-integration:${path}`);
        return true;
      },
      lockPersistentProfiles: () => {
        events.push("lock-persistent-profiles");
        return ["/home/agent/.codex"];
      },
      restorePersistentProfiles: (paths) => {
        events.push(`restore-persistent-profiles:${paths.join(",")}`);
      },
      runProcess: (command, args, options) => {
        events.push(`run:${command}:${options.cwd}`);
        const actionDirectory = join(actionRoot, valid.attemptId, valid.actionId);
        expect(statSync(actionRoot).mode & 0o777).toBe(0o711);
        expect(statSync(join(actionRoot, valid.attemptId)).mode & 0o777).toBe(0o711);
        expect(statSync(actionDirectory).mode & 0o777).toBe(0o711);
        expect(args).toContain("GIT_OPTIONAL_LOCKS=0");
        expect(args).toContain(`HOME=${join(actionDirectory, "home")}`);
        expect(args).toContain(`CODEX_HOME=${join(actionDirectory, "codex")}`);
        expect(args.find((entry) => entry.startsWith("GIT_DIR="))).toMatch(/git-admin$/);
        expect(args.find((entry) => entry.startsWith("GIT_INDEX_FILE="))).toMatch(/git-admin\/index$/);
        expect(args).toContain(`GIT_WORK_TREE=${loopWorktreeDirectory(valid)}`);
        expect(args.find((entry) => entry.startsWith("GIT_OBJECT_DIRECTORY="))).toMatch(/git-objects\/write$/);
        expect(args.find((entry) => entry.startsWith("GIT_ALTERNATE_OBJECT_DIRECTORIES="))).toMatch(/git-objects\/base$/);
        expect(options.cwd).toBe(loopWorktreeDirectory(valid));
        return { status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" };
      },
    });

    expect(result.status).toBe(0);
    expect(result.gitObjectEnv).toEqual(expect.objectContaining({
      GIT_DIR: expect.stringMatching(/git-admin$/),
      GIT_WORK_TREE: loopWorktreeDirectory(valid),
      GIT_INDEX_FILE: expect.stringMatching(/git-admin\/index$/),
      GIT_OBJECT_DIRECTORY: expect.stringMatching(/git-objects\/write$/),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: expect.stringMatching(/git-objects\/base$/),
    }));
    expect(events).toEqual([
      `lock-integration:${integrationRepoDir}`,
      "lock-persistent-profiles",
      "process-fence",
      `run:gosu:${loopWorktreeDirectory(valid)}`,
      `lock-integration:${integrationRepoDir}`,
      "restore-persistent-profiles:/home/agent/.codex",
    ]);
  });

  it("materializes a clean, action-scoped environment: credentials never ride as argv, only in an explicit replacing child env", () => {
    const valid = validateLoopRequest(request({
      agent: "claude",
      allowedMcpServers: [],
      credentialScopes: ["model.invoke", "repo.read", "repo.write"],
    }));
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    const integrationRepoDir = mkdtempSync(join(tmpdir(), "ot-loop-integration-"));
    directories.push(actionRoot, integrationRepoDir);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;
    // A sentinel outside the safe passthrough set (PATH/LANG/LC_ALL/TZ):
    // proves the child env is built from a closed baseline rather than
    // merged with whatever this process's own env happens to carry, which
    // expect.objectContaining alone cannot catch (it only checks presence,
    // not absence).
    process.env.OT_TEST_SHOULD_NOT_LEAK = "leak-marker-should-not-appear";

    let capturedArgs;
    let capturedOptions;
    try {
      runLoopAgentInPreparedRepository({
        request: valid,
        invocation: resolveLoopInvocation(valid),
        integrationRepoDir,
        lockIntegration: () => true,
        lockPersistentProfiles: () => [],
        restorePersistentProfiles: () => {},
        processFence: (execute) => execute(),
        credentialEnv: { GITHUB_TOKEN: "gh-secret", CODEX_AUTH_JSON: '{"token":"codex-secret"}' },
        runProcess: (command, args, options) => {
          capturedArgs = args;
          capturedOptions = options;
          return { status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" };
        },
      });
    } finally {
      delete process.env.OT_TEST_SHOULD_NOT_LEAK;
    }

    expect(capturedArgs[0]).toBe("agent");
    expect(capturedArgs[1]).toBe("env");
    // Credentials never appear as argv strings: an execve() argument vector
    // is visible to any co-resident process via /proc/<pid>/cmdline, unlike
    // the explicit child-process env below.
    expect(capturedArgs.join(" ")).not.toContain("gh-secret");
    expect(capturedArgs.join(" ")).not.toContain("codex-secret");
    expect(capturedOptions.env).toEqual(expect.objectContaining({
      PATH: process.env.PATH,
      GITHUB_TOKEN: "gh-secret",
    }));
    // CODEX_AUTH_JSON never appears as a raw env var either — it is only
    // ever materialized to a file, so its bytes never touch the child
    // process environment (visible via /proc/<pid>/environ) unnecessarily.
    expect(capturedOptions.env).not.toHaveProperty("CODEX_AUTH_JSON");
    // The env is a replacing closed baseline, not process.env merged with
    // extras: a sentinel this process's own env carries must not leak in.
    expect(capturedOptions.env).not.toHaveProperty("OT_TEST_SHOULD_NOT_LEAK");
  });

  it("builds a filtered, read-only Claude MCP config from the sealed repository config and passes --mcp-config", () => {
    const configDir = mkdtempSync(join(tmpdir(), "ot-loop-config-"));
    directories.push(configDir);
    const repositoryConfigPath = join(configDir, "repository-config.json");
    writeFileSync(repositoryConfigPath, JSON.stringify({
      mcp_servers: {
        github: { command: "mcp-github", args: ["--stdio"] },
        unused: { command: "mcp-unused" },
      },
    }));
    process.env.OT_STAGE_CONFIG_FILE = repositoryConfigPath;

    const valid = validateLoopRequest(request({
      agent: "claude",
      allowedMcpServers: ["github"],
      credentialScopes: ["mcp", "model.invoke", "repo.read", "repo.write"],
    }));
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    const integrationRepoDir = mkdtempSync(join(tmpdir(), "ot-loop-integration-"));
    directories.push(actionRoot, integrationRepoDir);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;

    let capturedArgs;
    runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir,
      lockIntegration: () => true,
      lockPersistentProfiles: () => [],
      restorePersistentProfiles: () => {},
      processFence: (execute) => execute(),
      runProcess: (command, args) => {
        capturedArgs = args;
        return { status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" };
      },
    });

    const mcpConfigIndex = capturedArgs.indexOf("--mcp-config");
    expect(mcpConfigIndex).toBeGreaterThan(-1);
    const mcpConfigPath = capturedArgs[mcpConfigIndex + 1];
    expect(mcpConfigPath).toMatch(/\/mcp\/mcp-config\.json$/);
    expect(capturedArgs).toContain("--strict-mcp-config");
    const written = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
    expect(written).toEqual({ mcpServers: { github: { type: "stdio", command: "mcp-github", args: ["--stdio"], env: {} } } });
    expect(statSync(mcpConfigPath).mode & 0o777).toBe(0o444);
  });

  it("resets stale replayed action surfaces before the agent runs", () => {
    const valid = validateLoopRequest(request());
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    directories.push(actionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;
    const actionDirectory = join(actionRoot, valid.attemptId, valid.actionId);
    const staleOutboxFile = join(actionDirectory, "outbox", "stale-receipt.json");
    const staleHomeFile = join(actionDirectory, "home", "stale-profile.txt");
    mkdirSync(join(actionDirectory, "outbox"), { recursive: true });
    mkdirSync(join(actionDirectory, "home"), { recursive: true });
    writeFileSync(staleOutboxFile, "stale\n");
    writeFileSync(staleHomeFile, "stale\n");

    runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir: "/tmp/integration",
      lockIntegration: () => true,
      processFence: (execute) => execute(),
      runProcess: () => {
        expect(existsSync(staleOutboxFile)).toBe(false);
        expect(existsSync(staleHomeFile)).toBe(false);
        return { status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" };
      },
    });
  });

  it("keeps executor locks in place while agent process termination is unconfirmed", () => {
    const valid = validateLoopRequest(request());
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    directories.push(actionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;
    const events = [];

    const result = executeLoopAction({
      request: valid,
      integrationRepoDir: "/tmp/integration",
      runLoopAgent: () => {
        const error = new Error("agent process cleanup did not converge to empty");
        error.retryableInfrastructureFailure = true;
        error.processTerminationUnconfirmed = true;
        throw error;
      },
      lockWorkerWorktree: () => events.push("lock-worktree"),
      lockActionDirectory: () => events.push("lock-action"),
      restoreIntegration: () => events.push("restore-integration"),
    });

    expect(result.outcome).toBe("retryable_infrastructure_failure");
    expect(events).toEqual(["lock-worktree", "lock-action"]);
  });

  it("does not restore persistent profiles while agent termination is unconfirmed", () => {
    const valid = validateLoopRequest(request());
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    directories.push(actionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;
    const events = [];

    expect(() => runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir: "/tmp/integration",
      lockIntegration: () => events.push("lock-integration"),
      lockPersistentProfiles: () => {
        events.push("lock-profiles");
        return ["/home/agent/.codex"];
      },
      restorePersistentProfiles: () => events.push("restore-profiles"),
      processFence: () => {
        const error = new Error("agent process cleanup did not converge to empty");
        error.retryableInfrastructureFailure = true;
        error.processTerminationUnconfirmed = true;
        throw error;
      },
      runProcess: () => ({ status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" }),
    })).toThrow(/did not converge/);

    expect(events).toEqual(["lock-integration", "lock-profiles", "lock-integration"]);
  });

  it("keeps unconfirmed termination marked when cleanup also fails", () => {
    const valid = validateLoopRequest(request());
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    directories.push(actionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;
    let lockCalls = 0;
    let error;

    try {
      runLoopAgentInPreparedRepository({
        request: valid,
        invocation: resolveLoopInvocation(valid),
        integrationRepoDir: "/tmp/integration",
        lockIntegration: () => {
          lockCalls += 1;
          if (lockCalls > 1) throw new Error("relock failed");
          return true;
        },
        processFence: () => {
          const fenceError = new Error("agent process cleanup did not converge to empty");
          fenceError.retryableInfrastructureFailure = true;
          fenceError.processTerminationUnconfirmed = true;
          throw fenceError;
        },
        runProcess: () => ({ status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" }),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error?.message).toMatch(/did not converge.*relock failed/s);
    expect(error?.retryableInfrastructureFailure).toBe(true);
    expect(error?.processTerminationUnconfirmed).toBe(true);
  });

  it("rejects sealing when the native session profile root was replaced during the action", () => {
    const valid = validateLoopRequest(request({ agent: "claude" }));
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    directories.push(actionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;
    const profileRoot = join(actionRoot, valid.attemptId, valid.actionId, "home", ".claude");

    expect(() => runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir: "/tmp/integration",
      lockIntegration: () => true,
      processFence: (execute) => execute(),
      runProcess: () => {
        rmSync(profileRoot, { recursive: true, force: true });
        mkdirSync(profileRoot, { recursive: true });
        return { status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" };
      },
    })).toThrow(/profile root was replaced/);
  });

  it("preserves tracked executable bits in read-only repository views", () => {
    const integrationRepoDir = repository();
    writeFileSync(join(integrationRepoDir, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(join(integrationRepoDir, "run.sh"), 0o755);
    execFileSync("git", ["add", "run.sh"], { cwd: integrationRepoDir });
    execFileSync("git", ["commit", "-qm", "executable"], { cwd: integrationRepoDir });
    const candidateSubject = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: integrationRepoDir,
      encoding: "utf8",
    }).trim();
    const valid = validateLoopRequest(request({
      role: "lead",
      loop: "lead",
      worktree: null,
      candidateSubject,
      credentialScopes: ["repo.read"],
    }));
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    directories.push(actionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;

    runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir,
      lockIntegration: () => true,
      processFence: (execute) => execute(),
      runProcess: (command, args, options) => {
        const view = options.cwd;
        expect(statSync(join(view, "run.sh")).mode & 0o111).not.toBe(0);
        expect(statSync(join(view, "file.txt")).mode & 0o777).toBe(0o444);
        const status = execFileSync("git", ["-c", `safe.directory=${view}`, "-C", view, "status", "--porcelain"], { encoding: "utf8" });
        expect(status.trim()).toBe("");
        return { status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" };
      },
    });
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
      processFence: (execute) => execute(),
      runProcess: () => ({ status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" }),
    });

    expect(statSync(siblingDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(siblingSecret).mode & 0o777).toBe(0o600);
  });

  it("runs non-worker loops in an action-scoped read-only repository view", () => {
    const integrationRepoDir = repository();
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: integrationRepoDir,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(integrationRepoDir, "candidate.txt"), "candidate\n");
    execFileSync("git", ["add", "candidate.txt"], { cwd: integrationRepoDir });
    execFileSync("git", ["commit", "-qm", "candidate"], { cwd: integrationRepoDir });
    const candidateSubject = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: integrationRepoDir,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["checkout", "--quiet", "--detach", baseCommit], { cwd: integrationRepoDir });
    const unreachableBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: integrationRepoDir,
      input: "unreachable object\n",
      encoding: "utf8",
    }).trim();
    const valid = validateLoopRequest(request({
      role: "lead",
      loop: "lead",
      worktree: null,
      candidateSubject,
      credentialScopes: ["repo.read"],
    }));
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    directories.push(actionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;
    const expectedView = join(actionRoot, valid.attemptId, valid.actionId, "repo-view");

    const result = runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir,
      lockIntegration: () => true,
      processFence: (execute) => execute(),
      runProcess: (command, args, options) => {
        expect(command).toBe("gosu");
        expect(options.cwd).toBe(expectedView);
        const actionDirectory = join(actionRoot, valid.attemptId, valid.actionId);
        expect(statSync(actionRoot).mode & 0o777).toBe(0o711);
        expect(statSync(join(actionRoot, valid.attemptId)).mode & 0o777).toBe(0o711);
        expect(args).toContain(`OT_OUTBOX_DIR=${join(actionDirectory, "outbox")}`);
        expect(args).toContain(`OT_INBOX_DIR=${join(actionDirectory, "inbox")}`);
        expect(args).toContain(`OT_INBOX_PROCESSED_DIR=${join(actionDirectory, "inbox-processed")}`);
        expect(args).toContain(`OT_NATIVE_SESSION_DIR=${join(actionDirectory, "native-session")}`);
        for (const directory of ["outbox", "inbox", "inbox-processed", "native-session"]) {
          expect(statSync(join(actionDirectory, directory)).mode & 0o777).toBe(0o700);
        }
        expect(args).toContain("GIT_CONFIG_COUNT=1");
        expect(args).toContain("GIT_CONFIG_KEY_0=safe.directory");
        expect(args).toContain(`GIT_CONFIG_VALUE_0=${expectedView}`);
        expect(readFileSync(join(expectedView, "candidate.txt"), "utf8")).toBe("candidate\n");
        expect(() => execFileSync("git", ["-c", `safe.directory=${expectedView}`, "-C", expectedView, "cat-file", "-p", unreachableBlob], { encoding: "utf8" }))
          .toThrow();
        expect(execFileSync("git", ["-c", `safe.directory=${expectedView}`, "-C", expectedView, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim())
          .toBe("DISABLED_BY_OPENTHROTTLE_READONLY_VIEW");
        expect(execFileSync("git", ["-c", `safe.directory=${expectedView}`, "-C", expectedView, "config", "--get", "remote.origin.pushurl"], { encoding: "utf8" }).trim())
          .toBe("DISABLED_BY_OPENTHROTTLE_READONLY_VIEW");
        expect(statSync(expectedView).mode & 0o777).toBe(0o555);
        return { status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" };
      },
    });

    expect(result.status).toBe(0);
  });

  it("runs reviewer loops from the source repository HEAD in a detached read-only view", () => {
    const integrationRepoDir = repository();
    writeFileSync(join(integrationRepoDir, "review-subject.txt"), "review subject\n");
    execFileSync("git", ["add", "review-subject.txt"], { cwd: integrationRepoDir });
    execFileSync("git", ["commit", "-qm", "review subject"], { cwd: integrationRepoDir });
    const valid = validateLoopRequest(request({
      role: "reviewer",
      loop: "review",
      skill: "final-review",
      worktree: null,
      credentialScopes: ["repo.read"],
    }));
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    directories.push(actionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;
    const expectedView = join(actionRoot, valid.attemptId, valid.actionId, "repo-view");

    const result = runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir,
      lockIntegration: () => true,
      processFence: (execute) => execute(),
      runProcess: (_command, _args, options) => {
        expect(options.cwd).toBe(expectedView);
        expect(execFileSync("git", ["-c", `safe.directory=${expectedView}`, "-C", expectedView, "rev-parse", "HEAD"], { encoding: "utf8" }).trim())
          .toMatch(/^[a-f0-9]{40}$/);
        expect(readFileSync(join(expectedView, "review-subject.txt"), "utf8")).toBe("review subject\n");
        expect(statSync(expectedView).mode & 0o777).toBe(0o555);
        return { status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" };
      },
    });

    expect(result.status).toBe(0);
  });

  it("rejects unsafe configured action roots before locking directories", () => {
    const valid = validateLoopRequest(request());
    process.env.OT_LOOP_ACTION_ROOT = "/";

    expect(() => runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir: "/tmp/integration",
      lockIntegration: () => true,
      processFence: (execute) => execute(),
      runProcess: () => ({ status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" }),
    })).toThrow(/unsafe system directory/);
  });

  it("materializes only the current sealed repository skill under the action discovery root", () => {
    for (const agent of ["claude", "codex"]) {
      const baseRequest = repositorySkillRequest();
      const valid = withFreshLoopFence(baseRequest, { agent });
      const actionRoot = mkdtempSync(join(tmpdir(), `ot-loop-actions-${agent}-`));
      directories.push(actionRoot);
      process.env.OT_LOOP_ACTION_ROOT = actionRoot;

      runLoopAgentInPreparedRepository({
        request: valid,
        invocation: resolveLoopInvocation(valid),
        integrationRepoDir: "/tmp/integration",
        lockIntegration: () => true,
        processFence: (execute) => execute(),
        runProcess: (command, args) => {
          expect(command).toBe("gosu");
          const actionDirectory = join(actionRoot, valid.attemptId, valid.actionId);
          const home = join(actionDirectory, "home");
          const codexHome = join(actionDirectory, "codex");
          expect(args).toContain(`OT_OUTBOX_DIR=${join(actionDirectory, "outbox")}`);
          expect(args).toContain(`OT_INBOX_DIR=${join(actionDirectory, "inbox")}`);
          expect(args).toContain(`OT_INBOX_PROCESSED_DIR=${join(actionDirectory, "inbox-processed")}`);
          expect(args).toContain(`OT_NATIVE_SESSION_DIR=${join(actionDirectory, "native-session")}`);
          expect(args).toContain(`HOME=${home}`);
          const skillRoot = agent === "claude"
            ? join(home, ".claude", "skills", valid.repositorySkill.invocation)
            : join(codexHome, "skills", valid.repositorySkill.invocation);
          if (agent === "codex") expect(args).toContain(`CODEX_HOME=${codexHome}`);
          if (agent !== "codex") expect(args.some((entry) => entry.startsWith("CODEX_HOME="))).toBe(false);
          expect(readFileSync(join(skillRoot, "SKILL.md"), "utf8")).toContain("pinned repository package");
          expect(statSync(skillRoot).mode & 0o777).toBe(0o555);
          expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
          return { status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" };
        },
      });
    }
  });

  it("rejects repository skill packages whose frontmatter name does not bind the invocation", () => {
    const baseRequest = repositorySkillRequest();
    const invalidPackage = repositorySkillPackage(join(process.env.OT_WORKTREE_ROOT, "unit-1"), "different_invocation");
    const valid = withFreshLoopFence(baseRequest, {
      skill: "different_invocation",
      repositorySkill: invalidPackage,
    });
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-frontmatter-"));
    directories.push(actionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;

    expect(() => runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir: "/tmp/integration",
      lockIntegration: () => true,
      processFence: (execute) => execute(),
      runProcess: () => ({ status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" }),
    })).toThrow(/frontmatter name/);
  });

  it("rejects repository skill aliases that do not exactly match the frontmatter name", () => {
    const baseRequest = repositorySkillRequest();
    const valid = withFreshLoopFence(baseRequest, {
      skill: "implement-unit",
      repositorySkill: repositorySkillPackage(join(process.env.OT_WORKTREE_ROOT, "unit-1"), "implement-unit"),
    });
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-alias-"));
    directories.push(actionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;

    expect(() => runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir: "/tmp/integration",
      lockIntegration: () => true,
      processFence: (execute) => execute(),
      runProcess: () => ({ status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" }),
    })).toThrow(/frontmatter name/);
  });

  it("materializes only the authorized native session package into each isolated profile", () => {
    for (const agent of ["claude", "codex"]) {
      const valid = validateLoopRequest(request({
        agent,
        nativeSessionId: "native-1",
        contextPolicy: "resume_required",
      }));
      const actionRoot = mkdtempSync(join(tmpdir(), `ot-loop-actions-${agent}-`));
      const sessionRoot = mkdtempSync(join(tmpdir(), `ot-loop-sessions-${agent}-`));
      directories.push(actionRoot, sessionRoot);
      process.env.OT_LOOP_ACTION_ROOT = actionRoot;
      process.env.OT_NATIVE_SESSION_SOURCE_ROOT = sessionRoot;
      sealSessionFixture({ agent, nativeSessionId: "native-1", sourceRoot: sessionRoot });
      sealSessionFixture({ agent, nativeSessionId: "native-sibling", sourceRoot: sessionRoot });

      runLoopAgentInPreparedRepository({
        request: valid,
        invocation: resolveLoopInvocation(valid),
        integrationRepoDir: "/tmp/integration",
        lockIntegration: () => true,
        lockPersistentProfiles: () => [],
        restorePersistentProfiles: () => {},
        processFence: (execute) => execute(),
        runProcess: (command, args) => {
          expect(command).toBe("gosu");
          const actionDirectory = join(actionRoot, valid.attemptId, valid.actionId);
          const profileRoot = agent === "codex"
            ? join(actionDirectory, "codex")
            : agent === "claude"
              ? join(actionDirectory, "home", ".claude")
              : join(actionDirectory, "home");
          const sessionStore = nativeSessionStoragePath(agent, profileRoot);
          expect(readFileSync(join(sessionStore, `${valid.nativeSessionId}.jsonl`), "utf8"))
            .toBe(sessionStorageFixture(agent, valid.nativeSessionId));
          expect(existsSync(join(sessionStore, "secret.jsonl"))).toBe(false);
          return { status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" };
        },
      });
    }
  });

  it("seals fresh loop native sessions for later action resume", () => {
    const valid = validateLoopRequest(request());
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    const sessionRoot = mkdtempSync(join(tmpdir(), "ot-loop-sessions-"));
    directories.push(actionRoot, sessionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;
    process.env.OT_NATIVE_SESSION_SOURCE_ROOT = sessionRoot;

    const result = runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir: "/tmp/integration",
      lockIntegration: () => true,
      lockPersistentProfiles: () => [],
      restorePersistentProfiles: () => {},
      processFence: (execute) => execute(),
      runProcess: (command, args) => {
        const codexHome = args.find((arg) => arg.startsWith("CODEX_HOME=")).slice("CODEX_HOME=".length);
        const sessionStore = nativeSessionStoragePath("codex", codexHome);
        mkdirSync(sessionStore, { recursive: true });
        writeFileSync(join(sessionStore, "thread-1.jsonl"), sessionStorageFixture("codex", "thread-1"));
        return {
          status: 0,
          signal: null,
          timedOut: false,
          stdout: "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}\n",
          stderr: "",
        };
      },
    });

    expect(result.nativeSessionId).toBe("thread-1");
    const sealed = join(sessionRoot, "codex", "thread-1");
    expect(readFileSync(join(sealed, "sessions", "thread-1.jsonl"), "utf8")).toBe(sessionStorageFixture("codex", "thread-1"));
    expect(statSync(sealed).mode & 0o777).toBe(0o500);
  });

  it("rejects resume output that reports a different native session id", () => {
    const valid = validateLoopRequest(request({
      nativeSessionId: "thread-1",
      contextPolicy: "resume_required",
    }));
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    const sessionRoot = mkdtempSync(join(tmpdir(), "ot-loop-sessions-"));
    directories.push(actionRoot, sessionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;
    process.env.OT_NATIVE_SESSION_SOURCE_ROOT = sessionRoot;
    sealSessionFixture({ agent: "codex", nativeSessionId: "thread-1", sourceRoot: sessionRoot });

    expect(() => runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir: "/tmp/integration",
      lockIntegration: () => true,
      lockPersistentProfiles: () => [],
      restorePersistentProfiles: () => {},
      processFence: (execute) => execute(),
      runProcess: () => ({
        status: 0,
        signal: null,
        timedOut: false,
        stdout: "{\"type\":\"thread.started\",\"thread_id\":\"thread-2\"}\n",
        stderr: "",
      }),
    })).toThrow(/reported native session id/);
  });

  it("refuses reported loop native session ids when sealing cannot produce a package and surfaces cleanup failures", () => {
    const valid = validateLoopRequest(request());
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    const sessionRoot = mkdtempSync(join(tmpdir(), "ot-loop-sessions-"));
    directories.push(actionRoot, sessionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;
    process.env.OT_NATIVE_SESSION_SOURCE_ROOT = sessionRoot;

    expect(() => runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir: "/tmp/integration",
      lockIntegration: () => true,
      lockPersistentProfiles: () => ["/home/agent/.codex"],
      restorePersistentProfiles: () => {
        throw new Error("profile restore failed");
      },
      processFence: (execute) => execute(),
      runProcess: () => ({
        status: 0,
        signal: null,
        timedOut: false,
        stdout: "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}\n",
        stderr: "",
      }),
    })).toThrow(/native session package does not contain the reported native session id.*profile restore failed/s);
  });

  it("rejects path-like native session ids before package storage can collapse", () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "ot-loop-sessions-"));
    const profileRoot = mkdtempSync(join(tmpdir(), "ot-loop-profile-"));
    directories.push(sessionRoot, profileRoot);
    const sessionStore = nativeSessionStoragePath("codex", profileRoot);
    mkdirSync(sessionStore, { recursive: true });
    writeFileSync(join(sessionStore, "sibling.jsonl"), "current sibling\n");
    sealSessionFixture({ agent: "codex", nativeSessionId: "sibling", sourceRoot: sessionRoot });

    expect(() => sealNativeSessionPackage({
      agent: "codex",
      nativeSessionId: "sibling/..",
      profileRoot,
      sourceRoot: sessionRoot,
    })).toThrow(/nativeSessionId is invalid/);
    expect(existsSync(join(sessionRoot, "codex", "sibling", "openthrottle-native-session.json"))).toBe(true);
  });

  it("bounds native session package sources before copying into executor state", () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "ot-loop-sessions-"));
    const profileRoot = mkdtempSync(join(tmpdir(), "ot-loop-profile-"));
    directories.push(sessionRoot, profileRoot);
    const sessionStore = nativeSessionStoragePath("codex", profileRoot);
    mkdirSync(sessionStore, { recursive: true });
    for (let index = 0; index < MAX_NATIVE_SESSION_FILES + 1; index += 1) {
      writeFileSync(join(sessionStore, `${index}.jsonl`), "x\n");
    }

    expect(() => sealNativeSessionPackage({
      agent: "codex",
      nativeSessionId: "too-many",
      profileRoot,
      sourceRoot: sessionRoot,
    })).toThrow(/too many files/);
    expect(existsSync(join(sessionRoot, "codex", "too-many"))).toBe(false);
  });

  it("bounds native session package bytes before copying into executor state", () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "ot-loop-sessions-"));
    const profileRoot = mkdtempSync(join(tmpdir(), "ot-loop-profile-"));
    directories.push(sessionRoot, profileRoot);
    const sessionStore = nativeSessionStoragePath("codex", profileRoot);
    mkdirSync(sessionStore, { recursive: true });
    const oversized = join(sessionStore, "oversized.jsonl");
    writeFileSync(oversized, "");
    // Sparse extension: the per-file lstat size check trips before any read.
    truncateSync(oversized, MAX_NATIVE_SESSION_BYTES + 1);

    expect(() => sealNativeSessionPackage({
      agent: "codex",
      nativeSessionId: "too-large",
      profileRoot,
      sourceRoot: sessionRoot,
    })).toThrow(/file is too large/);
    expect(existsSync(join(sessionRoot, "codex", "too-large"))).toBe(false);
  });

  it("rejects empty and unrelated native session packages", () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "ot-loop-sessions-"));
    const emptyProfile = mkdtempSync(join(tmpdir(), "ot-loop-empty-profile-"));
    const unrelatedProfile = mkdtempSync(join(tmpdir(), "ot-loop-unrelated-profile-"));
    directories.push(sessionRoot, emptyProfile, unrelatedProfile);
    mkdirSync(nativeSessionStoragePath("codex", emptyProfile), { recursive: true });
    const unrelatedSessionStore = nativeSessionStoragePath("codex", unrelatedProfile);
    mkdirSync(unrelatedSessionStore, { recursive: true });
    writeFileSync(join(unrelatedSessionStore, "other.jsonl"), "thread state for some-other-session\n");

    expect(() => sealNativeSessionPackage({
      agent: "codex",
      nativeSessionId: "native-empty",
      profileRoot: emptyProfile,
      sourceRoot: sessionRoot,
    })).toThrow(/does not contain the reported native session id/);
    expect(() => sealNativeSessionPackage({
      agent: "codex",
      nativeSessionId: "native-1",
      profileRoot: unrelatedProfile,
      sourceRoot: sessionRoot,
    })).toThrow(/does not contain the reported native session id/);
  });

  it("does not accept prose-only native session id mentions as ownership evidence", () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "ot-loop-sessions-"));
    const profileRoot = mkdtempSync(join(tmpdir(), "ot-loop-prose-profile-"));
    directories.push(sessionRoot, profileRoot);
    const sessionStore = nativeSessionStoragePath("codex", profileRoot);
    mkdirSync(sessionStore, { recursive: true });
    writeFileSync(join(sessionStore, "current.jsonl"), "plain text mentions native-prose but is not engine evidence\n");

    expect(() => sealNativeSessionPackage({
      agent: "codex",
      nativeSessionId: "native-prose",
      profileRoot,
      sourceRoot: sessionRoot,
    })).toThrow(/does not contain the reported native session id/);
  });

  it("does not accept unrelated JSON fields as native session ownership evidence", () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "ot-loop-sessions-"));
    const claudeProfile = mkdtempSync(join(tmpdir(), "ot-loop-claude-profile-"));
    const opencodeProfile = mkdtempSync(join(tmpdir(), "ot-loop-opencode-profile-"));
    directories.push(sessionRoot, claudeProfile, opencodeProfile);
    const claudeStore = nativeSessionStoragePath("claude", claudeProfile);
    const opencodeStore = nativeSessionStoragePath("opencode", opencodeProfile);
    mkdirSync(claudeStore, { recursive: true });
    mkdirSync(opencodeStore, { recursive: true });
    writeFileSync(join(claudeStore, "current.jsonl"), "{\"type\":\"tool_result\",\"details\":{\"sessionId\":\"native-claude\"}}\n");
    writeFileSync(join(opencodeStore, "current.jsonl"), "{\"type\":\"tool_result\",\"sessionID\":\"native-opencode\"}\n");

    expect(() => sealNativeSessionPackage({
      agent: "claude",
      nativeSessionId: "native-claude",
      profileRoot: claudeProfile,
      sourceRoot: sessionRoot,
    })).toThrow(/does not contain the reported native session id/);
    expect(() => sealNativeSessionPackage({
      agent: "opencode",
      nativeSessionId: "native-opencode",
      profileRoot: opencodeProfile,
      sourceRoot: sessionRoot,
    })).toThrow(/does not contain the reported native session id/);
  });

  it("rejects exact-path native session files without engine-native ownership events", () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "ot-loop-sessions-"));
    const pathOnlyProfile = mkdtempSync(join(tmpdir(), "ot-loop-path-profile-"));
    directories.push(sessionRoot, pathOnlyProfile);
    const pathOnlyStore = nativeSessionStoragePath("codex", pathOnlyProfile);
    mkdirSync(pathOnlyStore, { recursive: true });
    writeFileSync(join(pathOnlyStore, "native-path-only.jsonl"), "thread state without identifier\n");

    expect(() => sealNativeSessionPackage({
      agent: "codex",
      nativeSessionId: "native-path-only",
      profileRoot: pathOnlyProfile,
      sourceRoot: sessionRoot,
    })).toThrow(/does not contain the reported native session id/);
  });

  it("rejects Codex output events stored as durable native session records", () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "ot-loop-sessions-"));
    const profileRoot = mkdtempSync(join(tmpdir(), "ot-loop-codex-output-profile-"));
    directories.push(sessionRoot, profileRoot);
    const sessionStore = nativeSessionStoragePath("codex", profileRoot);
    mkdirSync(sessionStore, { recursive: true });
    writeFileSync(join(sessionStore, "native-codex.jsonl"), sessionEventFixture("codex", "native-codex"));

    expect(() => sealNativeSessionPackage({
      agent: "codex",
      nativeSessionId: "native-codex",
      profileRoot,
      sourceRoot: sessionRoot,
    })).toThrow(/does not contain the reported native session id/);
  });

  it("accepts engine-native session ownership events for every supported agent", () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "ot-loop-sessions-"));
    directories.push(sessionRoot);
    const fixtures = [
      {
        agent: "claude",
        nativeSessionId: "native-claude",
        event: "{\"type\":\"user\",\"sessionId\":\"native-claude\",\"message\":{\"role\":\"user\",\"content\":\"x\"}}\n",
      },
      {
        agent: "codex",
        nativeSessionId: "native-codex",
        event: "{\"type\":\"session_meta\",\"payload\":{\"id\":\"native-codex\"}}\n",
      },
      {
        agent: "opencode",
        nativeSessionId: "native-opencode",
        event: "{\"type\":\"step_start\",\"sessionID\":\"native-opencode\"}\n",
      },
    ];

    for (const fixture of fixtures) {
      const profileRoot = mkdtempSync(join(tmpdir(), `ot-loop-${fixture.agent}-profile-`));
      directories.push(profileRoot);
      const sessionStore = nativeSessionStoragePath(fixture.agent, profileRoot);
      mkdirSync(sessionStore, { recursive: true });
      writeFileSync(join(sessionStore, "current.jsonl"), fixture.event);

      expect(sealNativeSessionPackage({
        agent: fixture.agent,
        nativeSessionId: fixture.nativeSessionId,
        profileRoot,
        sourceRoot: sessionRoot,
      })).toBe(join(sessionRoot, fixture.agent, fixture.nativeSessionId));
    }
  });

  it("seals real Claude durable transcripts that carry sessionId without any system records", () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "ot-loop-sessions-"));
    const profileRoot = mkdtempSync(join(tmpdir(), "ot-loop-claude-real-profile-"));
    directories.push(sessionRoot, profileRoot);
    const sessionStore = nativeSessionStoragePath("claude", profileRoot);
    const projectDir = join(sessionStore, "-home-agent-repo");
    mkdirSync(projectDir, { recursive: true });
    // Observed Claude CLI 2.1.201 durable transcript shape: no type:"system"
    // lines; every record carries a top-level camelCase sessionId.
    writeFileSync(join(projectDir, "native-claude-real.jsonl"), [
      "{\"type\":\"user\",\"sessionId\":\"native-claude-real\",\"message\":{\"role\":\"user\",\"content\":\"x\"}}",
      "{\"type\":\"assistant\",\"sessionId\":\"native-claude-real\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}",
      "{\"type\":\"attachment\",\"sessionId\":\"native-claude-real\",\"attachment\":{\"name\":\"a.txt\"}}",
      "{\"type\":\"skill_listing\",\"sessionId\":\"native-claude-real\",\"skills\":[]}",
      "",
    ].join("\n"));

    const sealed = sealNativeSessionPackage({
      agent: "claude",
      nativeSessionId: "native-claude-real",
      profileRoot,
      sourceRoot: sessionRoot,
    });

    expect(sealed).toBe(join(sessionRoot, "claude", "native-claude-real"));
    const manifest = JSON.parse(readFileSync(join(sealed, "openthrottle-native-session.json"), "utf8"));
    expect(manifest.agent).toBe("claude");
    expect(manifest.nativeSessionId).toBe("native-claude-real");
  });

  it("rejects real-shaped Claude transcripts that carry only a different sessionId", () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "ot-loop-sessions-"));
    const profileRoot = mkdtempSync(join(tmpdir(), "ot-loop-claude-other-profile-"));
    directories.push(sessionRoot, profileRoot);
    const sessionStore = nativeSessionStoragePath("claude", profileRoot);
    mkdirSync(sessionStore, { recursive: true });
    writeFileSync(join(sessionStore, "native-claude-other.jsonl"), [
      "{\"type\":\"user\",\"sessionId\":\"native-claude-other\",\"message\":{\"role\":\"user\",\"content\":\"x\"}}",
      "{\"type\":\"assistant\",\"sessionId\":\"native-claude-other\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}",
      "",
    ].join("\n"));

    expect(() => sealNativeSessionPackage({
      agent: "claude",
      nativeSessionId: "native-claude-expected",
      profileRoot,
      sourceRoot: sessionRoot,
    })).toThrow(/does not contain the reported native session id/);
  });

  it("fails closed when resume is requested without sealed native session state", () => {
    const valid = validateLoopRequest(request({
      nativeSessionId: "native-missing",
      contextPolicy: "resume_required",
    }));
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    const sessionRoot = mkdtempSync(join(tmpdir(), "ot-loop-sessions-"));
    directories.push(actionRoot, sessionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;
    process.env.OT_NATIVE_SESSION_SOURCE_ROOT = sessionRoot;

    expect(() => runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir: "/tmp/integration",
      lockIntegration: () => true,
      lockPersistentProfiles: () => [],
      restorePersistentProfiles: () => {},
      processFence: (execute) => execute(),
      runProcess: () => ({ status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" }),
    })).toThrow(/authorized native session state is unavailable/);
  });

  it("does not restore native sessions through stale profile symlinks", () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "ot-loop-sessions-"));
    const sourceProfile = mkdtempSync(join(tmpdir(), "ot-source-profile-"));
    const destinationProfile = mkdtempSync(join(tmpdir(), "ot-destination-profile-"));
    const leakedTarget = mkdtempSync(join(tmpdir(), "ot-leaked-session-target-"));
    directories.push(sessionRoot, sourceProfile, destinationProfile, leakedTarget);
    process.env.OT_NATIVE_SESSION_SOURCE_ROOT = sessionRoot;
    const sourceSessionStore = nativeSessionStoragePath("codex", sourceProfile);
    mkdirSync(sourceSessionStore, { recursive: true });
    writeFileSync(join(sourceSessionStore, "native-1.jsonl"), sessionStorageFixture("codex", "native-1"));
    sealNativeSessionPackage({
      agent: "codex",
      nativeSessionId: "native-1",
      profileRoot: sourceProfile,
      sourceRoot: sessionRoot,
    });
    symlinkSync(leakedTarget, nativeSessionStoragePath("codex", destinationProfile));

    materializeNativeSessionState({
      request: {
        agent: "codex",
        nativeSessionId: "native-1",
        contextPolicy: "resume_required",
      },
      profileRoot: destinationProfile,
    });

    expect(readFileSync(join(nativeSessionStoragePath("codex", destinationProfile), "native-1.jsonl"), "utf8"))
      .toBe(sessionStorageFixture("codex", "native-1"));
    expect(existsSync(join(leakedTarget, "native-1.jsonl"))).toBe(false);
  });

  it("preserves the last sealed native session package when replacement sealing fails", () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "ot-loop-sessions-"));
    const validProfile = mkdtempSync(join(tmpdir(), "ot-valid-profile-"));
    const invalidProfile = mkdtempSync(join(tmpdir(), "ot-invalid-profile-"));
    directories.push(sessionRoot, validProfile, invalidProfile);
    const validSessionStore = nativeSessionStoragePath("codex", validProfile);
    const invalidSessionStore = nativeSessionStoragePath("codex", invalidProfile);
    mkdirSync(validSessionStore, { recursive: true });
    mkdirSync(invalidSessionStore, { recursive: true });
    writeFileSync(join(validSessionStore, "native-1.jsonl"), sessionStorageFixture("codex", "native-1"));
    writeFileSync(join(invalidSessionStore, "native-1.jsonl"), "unrelated durable record\n");
    const packageRoot = sealNativeSessionPackage({
      agent: "codex",
      nativeSessionId: "native-1",
      profileRoot: validProfile,
      sourceRoot: sessionRoot,
    });

    expect(() => sealNativeSessionPackage({
      agent: "codex",
      nativeSessionId: "native-1",
      profileRoot: invalidProfile,
      sourceRoot: sessionRoot,
    })).toThrow(/does not contain the reported native session id/);

    expect(existsSync(packageRoot)).toBe(true);
    const destinationProfile = mkdtempSync(join(tmpdir(), "ot-destination-profile-"));
    directories.push(destinationProfile);
    process.env.OT_NATIVE_SESSION_SOURCE_ROOT = sessionRoot;
    materializeNativeSessionState({
      request: {
        agent: "codex",
        nativeSessionId: "native-1",
        contextPolicy: "resume_required",
      },
      profileRoot: destinationProfile,
    });
    expect(readFileSync(join(nativeSessionStoragePath("codex", destinationProfile), "native-1.jsonl"), "utf8"))
      .toBe(sessionStorageFixture("codex", "native-1"));
  });

  it("rejects forged or writable sealed native session packages", () => {
    const valid = validateLoopRequest(request({
      nativeSessionId: "native-1",
      contextPolicy: "resume_required",
    }));
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    const sessionRoot = mkdtempSync(join(tmpdir(), "ot-loop-sessions-"));
    directories.push(actionRoot, sessionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;
    process.env.OT_NATIVE_SESSION_SOURCE_ROOT = sessionRoot;
    const packageRoot = sealSessionFixture({ agent: "codex", nativeSessionId: "native-1", sourceRoot: sessionRoot });
    chmodSync(packageRoot, 0o777);

    expect(() => runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir: "/tmp/integration",
      lockIntegration: () => true,
      lockPersistentProfiles: () => [],
      restorePersistentProfiles: () => {},
      processFence: (execute) => execute(),
      runProcess: () => ({ status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" }),
    })).toThrow(/must not be group or world writable/);

    chmodSync(packageRoot, 0o500);
    execFileSync("chmod", ["-R", "u+rwX", actionRoot]);
    chmodSync(join(packageRoot, "sessions"), 0o700);
    chmodSync(join(packageRoot, "sessions", "native-1.jsonl"), 0o600);
    writeFileSync(join(packageRoot, "sessions", "native-1.jsonl"), "forged session native-1\n");
    chmodSync(join(packageRoot, "sessions"), 0o500);
    chmodSync(join(packageRoot, "sessions", "native-1.jsonl"), 0o400);
    expect(() => runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir: "/tmp/integration",
      lockIntegration: () => true,
      lockPersistentProfiles: () => [],
      restorePersistentProfiles: () => {},
      processFence: (execute) => execute(),
      runProcess: () => ({ status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" }),
    })).toThrow(/file digest mismatch/);
  });

  it("restores partially locked persistent profiles even when later cleanup fails", () => {
    const valid = validateLoopRequest(request());
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    directories.push(actionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;
    const restored = [];
    let lockCalls = 0;
    const partial = new Error("profile lock failed");
    partial.lockedPersistentProfiles = ["/home/agent/.codex"];

    expect(() => runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir: "/tmp/integration",
      lockIntegration: () => {
        lockCalls += 1;
        if (lockCalls > 1) throw new Error("integration relock failed");
        return true;
      },
      lockPersistentProfiles: () => {
        throw partial;
      },
      restorePersistentProfiles: (paths) => {
        restored.push(...paths);
      },
      processFence: (execute) => execute(),
      runProcess: () => ({ status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" }),
    })).toThrow(/profile lock failed/);

    expect(restored).toEqual(["/home/agent/.codex"]);
  });

  it("restores the current profile when locking fails after partial mutation", () => {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
    const valid = validateLoopRequest(request());
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-loop-actions-"));
    directories.push(actionRoot);
    process.env.OT_LOOP_ACTION_ROOT = actionRoot;
    const profileRoot = mkdtempSync(join(tmpdir(), "ot-partial-profile-"));
    directories.push(profileRoot);
    writeFileSync(join(profileRoot, "state.txt"), "state\n");
    const originalMode = statSync(join(profileRoot, "state.txt")).mode & 0o777;
    const restored = [];

    expect(() => runLoopAgentInPreparedRepository({
      request: valid,
      invocation: resolveLoopInvocation(valid),
      integrationRepoDir: "/tmp/integration",
      lockIntegration: () => true,
      lockPersistentProfiles: () => {
        const snapshot = [[{
          path: join(profileRoot, "state.txt"),
          uid: statSync(join(profileRoot, "state.txt")).uid,
          gid: statSync(join(profileRoot, "state.txt")).gid,
          mode: originalMode,
          symbolicLink: false,
          directory: false,
        }]];
        chmodSync(join(profileRoot, "state.txt"), 0o000);
        const error = new Error("profile lock failed");
        error.lockedPersistentProfiles = snapshot;
        throw error;
      },
      restorePersistentProfiles: (snapshots) => {
        restored.push(...snapshots);
        restorePersistentAgentPrivateRoots(snapshots);
      },
      processFence: (execute) => execute(),
      runProcess: () => ({ status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" }),
    })).toThrow(/profile lock failed/);

    expect(restored).toHaveLength(1);
    expect(statSync(join(profileRoot, "state.txt")).mode & 0o777).toBe(originalMode);
  });

  it("restores persistent profile ownership and modes from the pre-lock snapshot", () => {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
    const profileRoot = mkdtempSync(join(tmpdir(), "ot-profile-"));
    directories.push(profileRoot);
    mkdirSync(join(profileRoot, "root-owned"), { recursive: true, mode: 0o555 });
    writeFileSync(join(profileRoot, "root-owned", "SKILL.md"), "# skill\n", { mode: 0o444 });
    chownSync(join(profileRoot, "root-owned"), 0, 0);
    chownSync(join(profileRoot, "root-owned", "SKILL.md"), 0, 0);

    const locked = runLoopAgentInPreparedRepository({
      request: validateLoopRequest(request()),
      invocation: { mode: "fresh", nativeSessionId: null },
      integrationRepoDir: "/tmp/integration",
      lockIntegration: () => true,
      lockPersistentProfiles: () => lockPersistentAgentPrivateRoots([profileRoot]),
      restorePersistentProfiles: restorePersistentAgentPrivateRoots,
      processFence: (execute) => execute(),
      runProcess: () => ({ status: 0, signal: null, timedOut: false, stdout: "{}", stderr: "" }),
    });

    expect(locked.status).toBe(0);
    expect(statSync(join(profileRoot, "root-owned")).uid).toBe(0);
    expect(statSync(join(profileRoot, "root-owned")).mode & 0o777).toBe(0o555);
    expect(statSync(join(profileRoot, "root-owned", "SKILL.md")).uid).toBe(0);
    expect(statSync(join(profileRoot, "root-owned", "SKILL.md")).mode & 0o777).toBe(0o444);
  });

  it("does not restore through a profile path replaced with a symlink", () => {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
    const parent = mkdtempSync(join(tmpdir(), "ot-profile-parent-"));
    const profileRoot = join(parent, ".codex");
    const replacementTarget = mkdtempSync(join(tmpdir(), "ot-profile-replacement-target-"));
    directories.push(parent, replacementTarget);
    mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(profileRoot, "state.txt"), "state\n", { mode: 0o600 });
    writeFileSync(join(replacementTarget, "target.txt"), "target\n", { mode: 0o666 });
    const targetMode = statSync(join(replacementTarget, "target.txt")).mode & 0o777;

    const snapshots = lockPersistentAgentPrivateRoots([profileRoot]);
    chmodSync(parent, 0o700);
    rmSync(profileRoot, { recursive: true, force: true });
    symlinkSync(replacementTarget, profileRoot);

    restorePersistentAgentPrivateRoots(snapshots);

    expect(lstatSync(profileRoot).isSymbolicLink()).toBe(true);
    expect(statSync(join(replacementTarget, "target.txt")).mode & 0o777).toBe(targetMode);
  });

  it("rejects persistent profile roots that are symlinks before locking", () => {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
    const parent = mkdtempSync(join(tmpdir(), "ot-profile-parent-"));
    const profileRoot = join(parent, ".codex");
    const replacementTarget = mkdtempSync(join(tmpdir(), "ot-profile-replacement-target-"));
    directories.push(parent, replacementTarget);
    writeFileSync(join(replacementTarget, "target.txt"), "target\n", { mode: 0o666 });
    const targetMode = statSync(join(replacementTarget, "target.txt")).mode & 0o777;
    symlinkSync(replacementTarget, profileRoot);

    expect(() => lockPersistentAgentPrivateRoots([profileRoot])).toThrow(/persistent profile root must be a directory/);

    expect(lstatSync(profileRoot).isSymbolicLink()).toBe(true);
    expect(statSync(join(replacementTarget, "target.txt")).mode & 0o777).toBe(targetMode);
  });

  it("restores earlier locked profiles when a later profile root is a symlink", () => {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
    const parent = mkdtempSync(join(tmpdir(), "ot-profile-parent-"));
    const validProfile = join(parent, ".claude");
    const symlinkProfile = join(parent, ".codex");
    const replacementTarget = mkdtempSync(join(tmpdir(), "ot-profile-replacement-target-"));
    directories.push(parent, replacementTarget);
    mkdirSync(validProfile, { recursive: true, mode: 0o700 });
    writeFileSync(join(validProfile, "state.txt"), "state\n", { mode: 0o600 });
    symlinkSync(replacementTarget, symlinkProfile);
    const originalMode = statSync(join(validProfile, "state.txt")).mode & 0o777;

    let error;
    try {
      lockPersistentAgentPrivateRoots([validProfile, symlinkProfile]);
    } catch (caught) {
      error = caught;
    }

    expect(error?.lockedPersistentProfiles).toHaveLength(1);
    restorePersistentAgentPrivateRoots(error.lockedPersistentProfiles);
    expect(statSync(join(validProfile, "state.txt")).mode & 0o777).toBe(originalMode);
    expect(lstatSync(symlinkProfile).isSymbolicLink()).toBe(true);
  });

  it("deduplicates and restores nested profile boundary snapshots once", () => {
    if (typeof process.getuid !== "function" || process.getuid() !== 0) return;
    const parent = "/home/agent";
    const local = join(parent, `.local-ot-opencode-${process.pid}-${Date.now()}`);
    const share = join(local, "share");
    const profileRoot = join(share, "opencode");
    const replacementTarget = mkdtempSync(join(tmpdir(), "ot-opencode-replacement-"));
    directories.push(local, replacementTarget);
    mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(profileRoot, "state.txt"), "state\n", { mode: 0o600 });
    chmodSync(local, 0o700);
    chmodSync(share, 0o700);
    chmodSync(profileRoot, 0o700);
    const originalParentMode = statSync(parent).mode & 0o777;
    const originalLocalMode = statSync(local).mode & 0o777;
    const originalShareMode = statSync(share).mode & 0o777;

    const snapshots = lockPersistentAgentPrivateRoots([profileRoot, profileRoot]);
    const snapshotPaths = snapshots.flat().map((entry) => entry.path);
    expect(snapshotPaths.filter((path) => path === parent)).toHaveLength(1);
    expect(snapshotPaths.filter((path) => path === local)).toHaveLength(1);
    expect(snapshotPaths.filter((path) => path === share)).toHaveLength(1);
    expect(statSync(parent).mode & 0o777).toBe(0o711);
    expect(statSync(local).mode & 0o777).toBe(0o711);
    expect(statSync(share).mode & 0o777).toBe(0o711);
    rmSync(profileRoot, { recursive: true, force: true });
    symlinkSync(replacementTarget, profileRoot);

    restorePersistentAgentPrivateRoots(snapshots);

    expect(statSync(parent).mode & 0o777).toBe(originalParentMode);
    expect(statSync(local).mode & 0o777).toBe(originalLocalMode);
    expect(statSync(share).mode & 0o777).toBe(originalShareMode);
    expect(lstatSync(profileRoot).isSymbolicLink()).toBe(true);
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
      processFence: (execute) => execute(),
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
    const lockActionDirectory = vi.fn();
    const restoreIntegration = vi.fn();
    const runLoopAgent = vi.fn(() => ({
      status: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify(receipt),
      stderr: "",
      nativeSessionId: "thread-1",
      integrationRepoDir: "/tmp/integration-current",
    }));

    const result = executeLoopActionWithIntegration({
      request: valid,
      runLoopAgent,
      lockWorkerWorktree,
      lockActionDirectory,
      restoreIntegration,
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
    expect(lockActionDirectory).toHaveBeenCalledWith(expect.objectContaining({ actionId: "action-1" }));
    expect(restoreIntegration).toHaveBeenCalledWith("/tmp/integration-current");
  });

  it("redacts a materialized credential from the failure receipt even when it never touched this process's own env", () => {
    const lockWorkerWorktree = vi.fn();
    const lockActionDirectory = vi.fn();
    const result = executeLoopActionWithIntegration({
      request: request(),
      credentialEnv: {
        GITHUB_TOKEN: "gh-leaked-secret-value",
        // A model.invoke action always receives its engine credential; an
        // empty one is classified as a missing credential instead of a crash.
        CODEX_AUTH_JSON: "{\"tokens\":{\"access_token\":\"fixture-codex-credential\"}}",
      },
      lockWorkerWorktree,
      lockActionDirectory,
      runLoopAgent: () => ({
        status: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "fatal: authentication failed with token gh-leaked-secret-value",
        nativeSessionId: null,
        integrationRepoDir: "/tmp/integration-current",
      }),
    });
    expect(result.outcome).toBe("failure");
    expect(result.receipt).not.toContain("gh-leaked-secret-value");
    expect(result.receipt).toContain("[REDACTED]");
  });

  it("classifies a loop action that launched without its engine credential", () => {
    const result = executeLoopActionWithIntegration({
      request: request(),
      credentialEnv: { GITHUB_TOKEN: "gh-token" },
      lockWorkerWorktree: vi.fn(),
      lockActionDirectory: vi.fn(),
      runLoopAgent: () => ({
        status: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        nativeSessionId: null,
        integrationRepoDir: "/tmp/integration-current",
      }),
      now: () => "2026-07-29T00:00:00.000Z",
    });

    // Not the agent's fault: it must not consume a semantic repair round.
    expect(result.outcome).toBe("retryable_infrastructure_failure");
    expect(result.receipt).toContain("reason=credential_missing");
    expect(result.receipt).toContain("CODEX_AUTH_JSON");
  });

  it("classifies a rate-limited loop action and carries a sanitized stdout tail", () => {
    const rateLimited = JSON.stringify({
      type: "system",
      subtype: "rate_limit_event",
      rate_limit: { status: "rejected", resets_at: 1_754_006_400 },
    });
    const result = executeLoopActionWithIntegration({
      request: request({ agent: "claude" }),
      credentialEnv: { CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-secret-value" },
      lockWorkerWorktree: vi.fn(),
      lockActionDirectory: vi.fn(),
      runLoopAgent: () => ({
        status: 1,
        signal: null,
        timedOut: false,
        stdout: `${rateLimited}\nrefused: token claude-oauth-secret-value`,
        stderr: "",
        nativeSessionId: null,
        integrationRepoDir: "/tmp/integration-current",
      }),
      now: () => "2026-07-29T00:00:00.000Z",
    });

    expect(result.outcome).toBe("retryable_infrastructure_failure");
    expect(result.receipt).toContain("reason=rate_limited");
    expect(result.receipt).toContain("stdout: ");
    expect(result.receipt).not.toContain("claude-oauth-secret-value");
    expect(result.receipt).toContain("[REDACTED]");
  });

  it("rejects successful loop exits without a valid standard receipt", () => {
    const lockWorkerWorktree = vi.fn();
    const lockActionDirectory = vi.fn();
    const result = executeLoopActionWithIntegration({
      request: request(),
      lockWorkerWorktree,
      lockActionDirectory,
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
    expect(lockActionDirectory).toHaveBeenCalledOnce();
  });

  it("relocks the worker worktree when the loop agent throws before evidence", () => {
    const lockWorkerWorktree = vi.fn();
    const lockActionDirectory = vi.fn();
    const result = executeLoopActionWithIntegration({
      request: request(),
      lockWorkerWorktree,
      lockActionDirectory,
      runLoopAgent: () => {
        throw new Error("agent launch failed");
      },
      now: () => "2026-07-29T00:00:00.000Z",
    });

    expect(result.outcome).toBe("failure");
    expect(result.receipt).toMatch(/agent launch failed/);
    expect(lockWorkerWorktree).toHaveBeenCalledOnce();
    expect(lockActionDirectory).toHaveBeenCalledOnce();
  });

  it("returns retryable infrastructure failure when loop cleanup fails", () => {
    const lockWorkerWorktree = vi.fn();
    const lockActionDirectory = vi.fn();
    const error = new Error("loop action failed (agent launch failed) and cleanup failed: integration relock failed");
    error.retryableInfrastructureFailure = true;
    const result = executeLoopActionWithIntegration({
      request: request(),
      lockWorkerWorktree,
      lockActionDirectory,
      runLoopAgent: () => {
        throw error;
      },
      now: () => "2026-07-29T00:00:00.000Z",
    });

    expect(result.outcome).toBe("retryable_infrastructure_failure");
    expect(result.receipt).toMatch(/cleanup failed/);
    expect(lockWorkerWorktree).toHaveBeenCalledOnce();
    expect(lockActionDirectory).toHaveBeenCalledOnce();
  });

  it("restores the configured integration checkout when the default loop launch throws", () => {
    const configuredIntegration = mkdtempSync(join(tmpdir(), "ot-loop-integration-"));
    directories.push(configuredIntegration);
    process.env.OT_INTEGRATION_REPO_DIR = configuredIntegration;
    const lockWorkerWorktree = vi.fn();
    const lockActionDirectory = vi.fn();
    const restoreIntegration = vi.fn();
    const result = executeLoopAction({
      request: request(),
      lockWorkerWorktree,
      lockActionDirectory,
      restoreIntegration,
      runLoopAgent: ({ integrationRepoDir }) => {
        expect(integrationRepoDir).toBe(configuredIntegration);
        throw new Error("agent launch failed");
      },
      now: () => "2026-07-29T00:00:00.000Z",
    });

    expect(result.outcome).toBe("failure");
    expect(result.receipt).toMatch(/agent launch failed/);
    expect(restoreIntegration).toHaveBeenCalledWith(configuredIntegration);
  });

  it("returns a typed failure when launch failure leaves subject attestation unavailable", () => {
    const lockWorkerWorktree = vi.fn();
    const lockActionDirectory = vi.fn();
    const valid = request();
    chmodSync(join(loopWorktreeDirectory(valid), ".git"), 0o000);

    const result = executeLoopActionWithIntegration({
      request: valid,
      lockWorkerWorktree,
      lockActionDirectory,
      runLoopAgent: () => {
        throw new Error("agent launch failed");
      },
      now: () => "2026-07-29T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      kind: "loop_action_result",
      action_id: "action-1",
      outcome: "failure",
      subject: null,
      created_at: "2026-07-29T00:00:00.000Z",
    });
    expect(result.receipt).toMatch(/workspace subject attestation failed/);
    expect(lockWorkerWorktree).toHaveBeenCalledOnce();
    expect(lockActionDirectory).toHaveBeenCalledOnce();
  });

  it("returns a typed infrastructure failure when relocking fails", () => {
    const valid = request();
    const receipt = standardReceipt(valid);
    const lockWorkerWorktree = vi.fn(() => {
      throw new Error("worktree relock failed");
    });
    const lockActionDirectory = vi.fn(() => {
      throw new Error("action relock failed with token gh-leaked-secret-value");
    });

    const result = executeLoopActionWithIntegration({
      request: valid,
      credentialEnv: { GITHUB_TOKEN: "gh-leaked-secret-value" },
      lockWorkerWorktree,
      lockActionDirectory,
      runLoopAgent: () => ({
        status: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify(receipt),
        stderr: "",
        nativeSessionId: "thread-1",
      }),
      now: () => "2026-07-29T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      kind: "loop_action_result",
      action_id: "action-1",
      outcome: "retryable_infrastructure_failure",
      native_session_id: "thread-1",
      created_at: "2026-07-29T00:00:00.000Z",
    });
    expect(result.receipt).toContain("worktree relock failed");
    expect(result.receipt).toContain("action relock failed");
    // The cleanup-failure receipt path redacts materialized credentials the
    // same way the main receipt path does, even though they never touch
    // this process's own env.
    expect(result.receipt).not.toContain("gh-leaked-secret-value");
    expect(result.receipt).toContain("[REDACTED]");
    expect(lockWorkerWorktree).toHaveBeenCalledOnce();
    expect(lockActionDirectory).toHaveBeenCalledOnce();
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

  it("keeps integration checkout validation fail-closed on the concrete default path", () => {
    process.env.OT_INTEGRATION_REPO_DIR = join(tmpdir(), "ot-missing-integration-repo");

    expect(() => executeLoopAction({
      request: request(),
      runLoopAgent: () => {
        throw new Error("should not run without a real integration checkout");
      },
    })).toThrow(/integration repository path must be a real directory/);
  });

  it("scopes Git safe.directory to the sealed integration worktree and git dir for read-only clones", () => {
    const repoDir = "/tmp/ot-loop-integration-safe";

    expect(gitSafeDirectoryConfigArgs(repoDir, [join(repoDir, ".git")])).toEqual([
      "-c",
      `safe.directory=${repoDir}`,
      "-c",
      `safe.directory=${join(repoDir, ".git")}`,
    ]);
  });
});
