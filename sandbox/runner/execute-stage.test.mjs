import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_DESCRIPTOR, canonicalJson } from "./capabilities.mjs";
import { digest } from "./artifacts.mjs";
import {
  computeWorkspaceTreeOid,
  classifyAgentExecutionFailure,
  createStageRequestHash,
  defaultRunAgent,
  executeStage,
  extractNativeSessionId,
  fallbackStageResultEvent,
  lockRepositorySkillStageHome,
  lockRepositorySkillStagePersistentProfiles,
  materializeRepositorySkill,
  repositorySkillStageEnvironment,
  resolveContextInvocation,
  runCapturedProcess,
  runWithAgentProcessFence,
  runtimeCapabilityDigest,
  stagePrompt,
  validateStageRequest,
} from "./execute-stage.mjs";
import { nativeSessionStoragePath, sealNativeSessionPackage } from "./native-session-package.mjs";

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
    if (existsSync(directory)) execFileSync("chmod", ["-R", "u+w", directory]);
    rmSync(directory, { recursive: true, force: true });
  }
  delete process.env.OT_ACTION_HOME_BASELINE_ROOT;
  delete process.env.OT_REPOSITORY_SKILL_DISCOVERY_ROOT;
  delete process.env.OT_STAGE_ACTION_ROOT;
  delete process.env.OT_NATIVE_SESSION_SOURCE_ROOT;
});

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // macOS can report EPERM briefly while the killed orphan is awaiting
    // reaping; it still means the group has not disappeared yet.
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function expectProcessGroupGone(pid) {
  const reapedBy = Date.now() + 1_000;
  while (processGroupExists(pid) && Date.now() < reapedBy) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  try {
    expect(processGroupExists(pid)).toBe(false);
  } finally {
    if (processGroupExists(pid)) process.kill(-pid, "SIGKILL");
  }
}

function repository() {
  const directory = mkdtempSync(join(tmpdir(), "ot-stage-repo-"));
  directories.push(directory);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
  writeFileSync(join(directory, ".gitignore"), "generated/\n");
  writeFileSync(join(directory, "file.txt"), "initial\n");
  mkdirSync(join(directory, "generated"));
  writeFileSync(join(directory, "generated", "ignored.txt"), "ignored\n");
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: directory });
  return directory;
}

function sealedRepositorySkillPackage(repoDir, {
  skillDir = ".agents/skills/implement-unit",
  invocation = "implement_unit",
  skillName = "implement_unit",
  body = "# Skill\n",
} = {}) {
  mkdirSync(join(repoDir, skillDir), { recursive: true });
  writeFileSync(join(repoDir, skillDir, "SKILL.md"), `---\nname: ${skillName}\n---\n${body}`);
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-qm", "skill"], { cwd: repoDir });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  const skillPath = `${skillDir}/SKILL.md`;
  const file = {
    path: skillPath,
    blobSha: execFileSync("git", ["rev-parse", `${commit}:${skillPath}`], { cwd: repoDir, encoding: "utf8" }).trim(),
    digest: digest(readFileSync(join(repoDir, skillPath))),
  };
  const unsignedPackage = {
    schema: "openthrottle.repository-skill-package/v1",
    reference: `repo://owner/repo@${commit}#${skillDir}`,
    invocation,
    directory: skillDir,
    commit,
    files: [file],
  };
  return {
    repositorySkill: { ...unsignedPackage, packageDigest: digest(canonicalJson(unsignedPackage)) },
    skillDir,
    skillPath,
  };
}

function fixture({
  agent = "codex",
  capability = "agent/semantic@1",
  contextPolicy = "fresh",
  nativeSessionId = null,
  requiredArtifacts = ["stage_result"],
  credentialScopes = ["model.invoke", "repo.read"],
  liveSteering = true,
  commandName,
  configuredCommand = true,
  repositorySkill,
} = {}) {
  const repoDir = repository();
  let sealedRepositorySkill = repositorySkill;
  if (repositorySkill === "fixture") {
    sealedRepositorySkill = sealedRepositorySkillPackage(repoDir, { body: "# Fixture Skill\n" }).repositorySkill;
  }
  const config = commandName && configuredCommand ? { commands: { [commandName]: "test-command" } } : {};
  const stage = {
    id: commandName ? "command" : "review",
    executor: { kind: commandName ? "command" : "agent", capability },
    evaluator: { required_artifacts: requiredArtifacts.filter((kind) => kind !== "stage_result") },
    context: contextPolicy,
    live_steering: liveSteering,
    credentials: credentialScopes,
    ...(commandName ? { commandName } : {}),
    ...(sealedRepositorySkill ? { repositorySkill: sealedRepositorySkill } : {}),
  };
  const manifest = { id: "fixture/test", version: 1, stages: [stage] };
  const configRaw = canonicalJson(config);
  const manifestRaw = canonicalJson(manifest);
  const base = {
    protocol: "stage-executor@1",
    pipelineInstanceId: "pipeline-1",
    manifestDigest: digest(manifestRaw),
    runtimeRelease: RUNTIME_DESCRIPTOR.release,
    capabilityDigest: runtimeCapabilityDigest(),
    repositoryConfigDigest: digest(configRaw),
    stageId: stage.id,
    attemptId: "attempt-1",
    runId: "run-1",
    issueId: "issue-1",
    sessionId: "session-1",
    generation: 1,
    taskType: "implement",
    taskContext: "Implement the approved fixture change.",
    transitionContext: "",
    repository: "owner/repo",
    baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim(),
    baseBranch: "main",
    branch: "ot/issue-1",
    agent,
    contextRevision: 0,
    expectedSubject: computeWorkspaceTreeOid(repoDir),
    contextPolicy,
    nativeSessionId,
    capability,
    requiredArtifacts,
    credentialScopes,
    liveSteering,
    ...(commandName ? { commandName } : {}),
    ...(sealedRepositorySkill ? { repositorySkill: sealedRepositorySkill } : {}),
  };
  const request = { ...base, ...createStageRequestHash(base) };
  return { repoDir, configRaw, manifestRaw, request };
}

function successProposal() {
  return {
    schema: "openthrottle.stage-proposal/v1",
    suggested_outcome: "success",
    summary: "Stage completed",
    evidence: ["Inspected the change"],
    findings: [],
    actions: [],
    uncertainty: [],
  };
}

function publishFixture() {
  return fixture({
    capability: "ce/publish@1",
    contextPolicy: "prefer_resume",
    requiredArtifacts: ["stage_result", "publish_subject"],
    credentialScopes: ["model.invoke", "provider.read", "repo.read", "repo.write"],
    liveSteering: false,
  });
}

function addBareOrigin(input, { push = false } = {}) {
  const remote = mkdtempSync(join(tmpdir(), "ot-stage-remote-"));
  directories.push(remote);
  execFileSync("git", ["init", "--bare", "-q"], { cwd: remote });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: input.repoDir });
  if (push) {
    execFileSync("git", ["push", "-q", "origin", `HEAD:refs/heads/${input.request.branch}`], {
      cwd: input.repoDir,
    });
  }
  return remote;
}

function clock() {
  const values = ["2026-07-22T00:00:00.000Z", "2026-07-22T00:00:01.000Z"];
  return () => values.shift();
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function installFakeGosu(binDir) {
  writeExecutable(join(binDir, "gosu"), `#!/usr/bin/env bash
set -euo pipefail
shift
exec "$@"
`);
}

function withPrependedPath(binDir, run) {
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    return run();
  } finally {
    process.env.PATH = previousPath;
  }
}

function codexSessionStorageRecord(nativeSessionId) {
  return `{"type":"session_meta","payload":{"id":"${nativeSessionId}"}}\n`;
}

describe("one-stage executor", () => {
  it("validates the complete immutable request fence", () => {
    const { request } = fixture();
    expect(validateStageRequest(request)).toEqual(request);
    expect(() => validateStageRequest({ ...request, requestHash: "0".repeat(64) })).toThrow(/stale/);
    expect(() => validateStageRequest({ ...request, capabilityDigest: "0".repeat(64) }))
      .toThrow(/installed runtime/);
    expect(() => validateStageRequest({ ...request, authority: "agent" })).toThrow(/unknown field/);
    expect(validateStageRequest({ ...request })).toMatchObject({
      taskContext: "Implement the approved fixture change.",
      transitionContext: "",
    });
    const { requestHash: _requestHash, idempotencyKey: _idempotencyKey, ...withoutFence } = request;
    const childRequest = { ...withoutFence, childActionId: "action-1" };
    const sealedChildRequest = { ...childRequest, ...createStageRequestHash(childRequest) };
    expect(validateStageRequest(sealedChildRequest)).toMatchObject({ childActionId: "action-1" });
    expect(() => validateStageRequest({ ...sealedChildRequest, childActionId: "../bad" }))
      .toThrow(/childActionId/);
    const { requestHash, idempotencyKey, ...unsealedRequest } = request;
    const slashAttemptRequest = { ...unsealedRequest, attemptId: "parent/child" };
    expect(() => validateStageRequest({ ...slashAttemptRequest, ...createStageRequestHash(slashAttemptRequest) }))
      .toThrow(/attemptId/);
    const slashNativeSessionRequest = { ...unsealedRequest, nativeSessionId: "native/../sibling" };
    expect(() => validateStageRequest({ ...slashNativeSessionRequest, ...createStageRequestHash(slashNativeSessionRequest) }))
      .toThrow(/nativeSessionId/);
    expect(stagePrompt(request, "/tmp/proposal.json")).toContain("Implement the approved fixture change.");
    expect(stagePrompt({ ...request, taskType: "investigate", capability: "ce/publish@1" }, "/tmp/proposal.json"))
      .toMatch(/^\$investigate/);
    expect(stagePrompt(
      { ...request, agent: "claude", capability: "ce/implement@1" },
      "/tmp/proposal.json",
      { agent: "claude" }
    )).toMatch(/^\/implement-plan/);
  });

  it("renders the canonical adapter body for OpenCode fenced stages", () => {
    const skillRoot = mkdtempSync(join(tmpdir(), "ot-stage-skills-"));
    directories.push(skillRoot);
    mkdirSync(join(skillRoot, "implement-plan"), { recursive: true });
    writeFileSync(
      join(skillRoot, "implement-plan", "SKILL.md"),
      "---\nname: implement-plan\n---\nUse $ce-work mode:return-to-caller for this fenced stage.\n"
    );
    const prompt = stagePrompt(
      { ...fixture().request, capability: "ce/implement@1" },
      "/tmp/proposal.json",
      {
      agent: "opencode",
      skillRoot,
      }
    );
    expect(prompt).toContain("$implement-plan");
    expect(prompt).toContain("Use $ce-work mode:return-to-caller");
    expect(prompt).not.toContain("name: implement-plan");
  });

  it("rejects wrong sealed config/manifest digests before invocation", () => {
    const input = fixture();
    const runAgent = vi.fn();
    expect(() => executeStage({ ...input, configRaw: '{"test":"wrong"}', runAgent })).toThrow(/repository config digest mismatch/);
    expect(() => executeStage({ ...input, manifestRaw: "{}", runAgent })).toThrow(/pipeline manifest digest mismatch/);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("implements fresh, required-resume, and prefer-resume reconstruction policies", () => {
    expect(resolveContextInvocation(fixture().request)).toMatchObject({ mode: "fresh", reconstructed: false });
    expect(() => resolveContextInvocation(fixture({ contextPolicy: "resume_required" }).request))
      .toThrow(/missing its native session/);
    expect(resolveContextInvocation(fixture({ contextPolicy: "resume_required", nativeSessionId: "native-1" }).request))
      .toMatchObject({ mode: "resume", nativeSessionId: "native-1" });
    expect(resolveContextInvocation(fixture({ contextPolicy: "prefer_resume" }).request))
      .toMatchObject({ mode: "fresh", reconstructed: true });
    expect(resolveContextInvocation(fixture({ contextPolicy: "fresh", liveSteering: false }).request))
      .toMatchObject({ mode: "fresh", readOnly: false });
  });

  it("captures provider-neutral native session identifiers from JSONL", () => {
    expect(extractNativeSessionId('{"type":"system","session_id":"claude-1"}\n', "claude")).toBe("claude-1");
    expect(extractNativeSessionId('{"type":"thread.started","thread_id":"codex-1"}\n', "codex")).toBe("codex-1");
    expect(extractNativeSessionId('{"type":"step_start","sessionID":"opencode-1"}\n', "opencode")).toBe("opencode-1");
    expect(extractNativeSessionId("not-json\n", "codex")).toBeNull();
    expect(extractNativeSessionId('{"type":"session_meta","payload":{"id":"codex-storage"}}\n', "codex")).toBeNull();
    expect(extractNativeSessionId('{"type":"tool_result","session_id":"claude-forged"}\n', "claude")).toBeNull();
    expect(extractNativeSessionId('{"type":"tool_result","sessionID":"opencode-forged"}\n', "opencode")).toBeNull();
  });

  it("takes engine selection from the sealed request", () => {
    const input = fixture();
    const runAgent = vi.fn(() => ({ exitCode: 0, proposal: successProposal(), nativeSessionId: "native-1" }));
    executeStage({ ...input, agent: "claude", runAgent, now: clock() });
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ agent: "codex" }));
  });

  it("records a missing required native session as explicit failed evidence", () => {
    const input = fixture({ contextPolicy: "resume_required" });
    const result = executeStage({ ...input, runAgent: vi.fn(), now: clock() });
    expect(result.outcome).toBe("failure");
    expect(JSON.parse(result.artifacts[0].payload).summary).toMatch(/missing its native session/);
  });

  it("streams agent output beyond the old spawn buffer while retaining bounded diagnostics", () => {
    const result = runCapturedProcess(process.execPath, [
      "-e",
      'process.stdout.write("head-marker\\n"); process.stdout.write("x".repeat(9 * 1024 * 1024)); process.stdout.write("\\ntail-marker\\n")',
    ], { timeout: 10_000 });

    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain("head-marker");
    expect(result.stdout).toContain("output bytes omitted");
    expect(result.stdout).toContain("tail-marker");
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(2.1 * 1024 * 1024);
  });

  it("retains bounded stderr diagnostics beyond the old spawn buffer", () => {
    const result = runCapturedProcess(process.execPath, [
      "-e",
      'process.stderr.write("stderr-head\\n"); process.stderr.write("x".repeat(9 * 1024 * 1024)); process.stderr.write("\\nstderr-tail\\n")',
    ], { timeout: 10_000 });

    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain("stderr-head");
    expect(result.stderr).toContain("output bytes omitted");
    expect(result.stderr).toContain("stderr-tail");
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(2.1 * 1024 * 1024);
  });

  it("escalates a timed-out process that ignores SIGTERM", () => {
    const startedAt = Date.now();
    const result = runCapturedProcess(process.execPath, [
      "-e",
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000)',
    ], { timeout: 500, killAfterMs: 50 });

    expect(result.timedOut).toBe(true);
    expect(result.error?.code).toBe("ETIMEDOUT");
    expect(result.signal).toBe("SIGKILL");
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it("returns after a direct child exits even when a detached descendant holds its output pipes", () => {
    const startedAt = Date.now();
    const result = runCapturedProcess(process.execPath, [
      "-e",
      `
        const { spawn } = require("node:child_process");
        const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3500)"], {
          detached: true,
          stdio: ["ignore", "inherit", "inherit"],
        });
        descendant.unref();
        process.stdout.write("direct-stdout\\n");
        process.stderr.write("direct-stderr\\n");
        process.exit(23);
      `,
    ], { timeout: 5_000, killAfterMs: 50 });

    expect(result.status).toBe(23);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain("direct-stdout");
    expect(result.stderr).toContain("direct-stderr");
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  });

  it("kills the command process group when the outer helper deadline fires", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ot-bounded-helper-"));
    directories.push(stateDir);
    const commandPidPath = join(stateDir, "command.pid");
    const startedAt = Date.now();
    let failure;

    try {
      runCapturedProcess(process.execPath, [
        "-e",
        `
          const { writeFileSync } = require("node:fs");
          writeFileSync(${JSON.stringify(commandPidPath)}, String(process.pid));
          process.stdin.resume();
          process.stdin.once("end", () => process.kill(process.ppid, "SIGSTOP"));
          setInterval(() => {}, 1000);
        `,
      ], { timeout: 100, killAfterMs: 50 });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure.code).toBe("ETIMEDOUT");
    expect(failure.message).toContain("timed out after 1400ms");
    expect(Date.now() - startedAt).toBeLessThan(3_000);

    const commandPidText = readFileSync(commandPidPath, "utf8");
    expect(commandPidText).toMatch(/^[1-9][0-9]*$/);
    const commandPid = Number(commandPidText);
    expectProcessGroupGone(commandPid);
  });

  it("kills the command process group when the PID handoff cannot be written", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ot-bounded-handoff-"));
    directories.push(stateDir);
    const helperPath = fileURLToPath(new URL("./bounded-process-helper.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [helperPath], {
      input: JSON.stringify({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: null,
        env: null,
        input: null,
        timeoutMs: 5_000,
        killAfterMs: 50,
        exitDrainMs: 250,
        captureBytes: 1024,
        stdoutPath: join(stateDir, "stdout.log"),
        stderrPath: join(stateDir, "stderr.log"),
        childPidPath: stateDir,
      }),
      encoding: "utf8",
      timeout: 3_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("failed to record command process group");
    const commandPid = Number(result.stderr.match(/command process group ([1-9][0-9]*)/)?.[1]);
    expect(Number.isSafeInteger(commandPid)).toBe(true);
    expectProcessGroupGone(commandPid);
  });

  it("terminates agent descendants before repository observation can continue", () => {
    const events = [];
    const result = runWithAgentProcessFence(
      () => {
        events.push("agent-returned");
        return "execution";
      },
      () => events.push("descendants-terminated"),
    );
    events.push("repository-observed");

    expect(result).toBe("execution");
    expect(events).toEqual(["descendants-terminated", "agent-returned", "descendants-terminated", "repository-observed"]);
  });

  it("treats exit zero without a proposal as a non-recoverable failure", () => {
    const input = fixture();
    const result = executeStage({
      ...input,
      now: clock(),
      runAgent: () => ({ exitCode: 0, nativeSessionId: "native-1" }),
    });
    expect(result.outcome).toBe("failure");
    expect(JSON.parse(result.artifacts[0].payload).summary).toMatch(/without the required terminal/);
  });

  it("turns an invalid terminal proposal into typed failure evidence", () => {
    const input = fixture();
    const result = executeStage({
      ...input,
      now: clock(),
      runAgent: () => ({
        exitCode: 0,
        nativeSessionId: "native-1",
        proposal: { ...successProposal(), suggested_outcome: "canceled" },
      }),
    });
    expect(result.outcome).toBe("failure");
    expect(JSON.parse(result.artifacts[0].payload).summary).toMatch(/proposal was rejected/);
  });

  it("redacts a Codex token rotated during execution from semantic artifacts", () => {
    const input = fixture();
    const rotated = "rotated-codex-secret-123456789";
    const result = executeStage({
      ...input,
      now: clock(),
      runAgent: () => ({
        exitCode: 0,
        nativeSessionId: "native-1",
        authSnapshot: JSON.stringify({ tokens: { access_token: rotated } }),
        proposal: { ...successProposal(), summary: `Stage completed with ${rotated}` },
      }),
    });
    expect(result.artifacts[0].payload).not.toContain(rotated);
    expect(result.artifacts[0].payload).toContain("[REDACTED]");
  });

  it("accepts repository skill identity when it matches the sealed manifest", () => {
    const repositorySkill = {
      schema: "openthrottle.repository-skill-package/v1",
      reference: `repo://owner/repo@${"a".repeat(40)}#.agents/skills/implement-unit`,
      invocation: "implement_unit",
      directory: ".agents/skills/implement-unit",
      commit: "a".repeat(40),
      packageDigest: "d".repeat(64),
      files: [{
        path: ".agents/skills/implement-unit/SKILL.md",
        blobSha: "b".repeat(40),
        digest: "c".repeat(64),
      }],
    };
    const input = fixture({ repositorySkill });
    const result = executeStage({
      ...input,
      now: clock(),
      runAgent: () => ({
        exitCode: 0,
        nativeSessionId: "native-1",
        proposal: successProposal(),
      }),
    });

    expect(validateStageRequest(input.request).repositorySkill).toEqual(repositorySkill);
    expect(result.outcome).toBe("success");
  });

  it("materializes only the sealed repository skill package into engine discovery", () => {
    const repoDir = repository();
    const skillDir = ".agents/skills/implement-unit";
    mkdirSync(join(repoDir, ".agents", "skills", "implement-unit"), { recursive: true });
    mkdirSync(join(repoDir, ".agents", "skills", "other-skill"), { recursive: true });
    writeFileSync(join(repoDir, skillDir, "SKILL.md"), "---\nname: implement_unit\n---\n# Skill\n");
    writeFileSync(join(repoDir, skillDir, "helper.txt"), "helper\n");
    writeFileSync(join(repoDir, skillDir, "run.sh"), "#!/usr/bin/env sh\nexit 0\n");
    writeFileSync(join(repoDir, ".agents", "skills", "other-skill", "SKILL.md"), "---\nname: other\n---\n");
    execFileSync("git", ["add", "."], { cwd: repoDir });
    execFileSync("git", ["update-index", "--chmod=+x", `${skillDir}/run.sh`], { cwd: repoDir });
    execFileSync("git", ["commit", "-qm", "skill"], { cwd: repoDir });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    const files = ["SKILL.md", "helper.txt", "run.sh"].map((name) => {
      const path = `${skillDir}/${name}`;
      const bytes = readFileSync(join(repoDir, path));
      return {
        path,
        blobSha: execFileSync("git", ["rev-parse", `${commit}:${path}`], { cwd: repoDir, encoding: "utf8" }).trim(),
        digest: digest(bytes),
      };
    });
    const unsignedPackage = {
      schema: "openthrottle.repository-skill-package/v1",
      reference: `repo://owner/repo@${commit}#${skillDir}`,
      invocation: "implement_unit",
      directory: skillDir,
      commit,
      files,
    };
    const repositorySkill = { ...unsignedPackage, packageDigest: digest(canonicalJson(unsignedPackage)) };
    const signedPackage = (overrides = {}) => {
      const unsigned = { ...unsignedPackage, ...overrides };
      return { ...unsigned, packageDigest: digest(canonicalJson(unsigned)) };
    };
    const discoveryRoot = mkdtempSync(join(tmpdir(), "ot-stage-skills-"));
    directories.push(discoveryRoot);
    process.env.OT_REPOSITORY_SKILL_DISCOVERY_ROOT = discoveryRoot;
    const unlockDiscoveryRoot = () => {
      if (existsSync(discoveryRoot)) execFileSync("chmod", ["-R", "u+w", discoveryRoot]);
    };
    const expectMaterializeToThrow = (repositorySkillFixture, pattern) => {
      unlockDiscoveryRoot();
      expect(() => materializeRepositorySkill({
        request: { ...request, repositorySkill: repositorySkillFixture },
        repoDir,
      })).toThrow(pattern);
    };
    const withoutFence = {
      protocol: "stage-executor@1",
      pipelineInstanceId: "pipeline-1",
      manifestDigest: "a".repeat(64),
      runtimeRelease: RUNTIME_DESCRIPTOR.release,
      capabilityDigest: runtimeCapabilityDigest(),
      repositoryConfigDigest: "b".repeat(64),
      stageId: "repo-skill",
      attemptId: "attempt-1",
      runId: "run-1",
      issueId: "issue-1",
      sessionId: "session-1",
      generation: 1,
      taskType: "implement",
      taskContext: "",
      transitionContext: "",
      repository: "owner/repo",
      baseCommit: commit,
      baseBranch: "main",
      branch: "ot/issue-1",
      agent: "codex",
      contextRevision: 0,
      expectedSubject: null,
      contextPolicy: "fresh",
      nativeSessionId: null,
      capability: "agent/repository-skill@1",
      requiredArtifacts: ["stage_result"],
      credentialScopes: ["model.invoke", "repo.read"],
      liveSteering: false,
      repositorySkill,
    };
    const request = { ...withoutFence, ...createStageRequestHash(withoutFence) };

    const materialized = materializeRepositorySkill({ request, repoDir });

    expect(readFileSync(join(materialized, "SKILL.md"), "utf8")).toContain("name: implement_unit");
    expect(readFileSync(join(materialized, "helper.txt"), "utf8")).toBe("helper\n");
    expect(statSync(join(materialized, "SKILL.md")).mode & 0o777).toBe(0o444);
    expect(statSync(join(materialized, "run.sh")).mode & 0o777).toBe(0o555);
    expect(existsSync(join(discoveryRoot, "other-skill"))).toBe(false);
    unlockDiscoveryRoot();
    writeFileSync(join(repoDir, skillDir, "helper.txt"), "mutated worktree bytes\n");
    const rematerialized = materializeRepositorySkill({ request, repoDir });
    expect(readFileSync(join(rematerialized, "helper.txt"), "utf8")).toBe("helper\n");
    expectMaterializeToThrow({ ...repositorySkill, packageDigest: "0".repeat(64) }, /package digest mismatch/);
    const outsidePath = ".agents/skills/other-skill/SKILL.md";
    const outsideBytes = readFileSync(join(repoDir, outsidePath));
    const outsideFile = {
      path: outsidePath,
      blobSha: execFileSync("git", ["rev-parse", `${commit}:${outsidePath}`], { cwd: repoDir, encoding: "utf8" }).trim(),
      digest: digest(outsideBytes),
    };
    expectMaterializeToThrow(signedPackage({ files: [outsideFile] }), /outside the sealed package/);
    symlinkSync("helper.txt", join(repoDir, skillDir, "link.txt"));
    expectMaterializeToThrow(signedPackage({
      files: [{ path: `${skillDir}/link.txt`, blobSha: "0".repeat(40), digest: "0".repeat(64) }],
    }), /not a regular file/);
    expectMaterializeToThrow(signedPackage({
      files: [{ ...files[0], blobSha: "0".repeat(40) }],
    }), /blob fence mismatch/);
    expectMaterializeToThrow(signedPackage({
      files: [{ ...files[0], digest: "0".repeat(64) }],
    }), /file digest mismatch/);

    const stageActionRoot = mkdtempSync(join(tmpdir(), "ot-stage-actions-"));
    const globalDiscoveryRoot = mkdtempSync(join(tmpdir(), "ot-global-stage-skills-"));
    directories.push(stageActionRoot, globalDiscoveryRoot);
    process.env.OT_STAGE_ACTION_ROOT = stageActionRoot;
    process.env.OT_REPOSITORY_SKILL_DISCOVERY_ROOT = globalDiscoveryRoot;
    const scoped = repositorySkillStageEnvironment(request);
    const scopedMaterialized = materializeRepositorySkill({
      request,
      repoDir,
      discoveryRoot: scoped.repositorySkillDiscoveryRoot,
    });

    expect(scoped.env).toContain(`HOME=${join(stageActionRoot, "attempt-1", "home")}`);
    expect(scoped.env).toContain(`CODEX_HOME=${join(stageActionRoot, "attempt-1", "codex")}`);
    expect(statSync(stageActionRoot).mode & 0o777).toBe(0o711);
    expect(statSync(join(stageActionRoot, "attempt-1")).mode & 0o777).toBe(0o711);
    expect(scopedMaterialized).toBe(join(stageActionRoot, "attempt-1", "codex", "skills", "implement_unit"));
    expect(readFileSync(join(scopedMaterialized, "SKILL.md"), "utf8")).toContain("name: implement_unit");
    expect(existsSync(join(globalDiscoveryRoot, "implement_unit"))).toBe(false);
    expect(existsSync(join(stageActionRoot, "attempt-1", "codex", "auth.json"))).toBe(false);
    expect(lockRepositorySkillStageHome(request)).toBe(true);
    expect(statSync(join(stageActionRoot, "attempt-1")).mode & 0o777).toBe(0o700);
    expect(statSync(join(stageActionRoot, "attempt-1", "codex")).mode & 0o777).toBe(0o700);
  });

  it("locks persistent agent profiles for repository-skill stages only", () => {
    const repositorySkill = {
      schema: "openthrottle.repository-skill-package/v1",
      reference: `repo://owner/repo@${"a".repeat(40)}#.agents/skills/implement-unit`,
      invocation: "implement_unit",
      directory: ".agents/skills/implement-unit",
      commit: "a".repeat(40),
      packageDigest: "d".repeat(64),
      files: [{
        path: ".agents/skills/implement-unit/SKILL.md",
        blobSha: "b".repeat(40),
        digest: "c".repeat(64),
      }],
    };
    const repositorySkillRequest = fixture({
      capability: "agent/repository-skill@1",
      repositorySkill,
    }).request;
    const semanticRequest = fixture().request;
    const lock = vi.fn(() => ["/home/agent/.codex"]);

    expect(lockRepositorySkillStagePersistentProfiles(repositorySkillRequest, lock)).toEqual(["/home/agent/.codex"]);
    expect(lock).toHaveBeenCalledOnce();
    expect(lockRepositorySkillStagePersistentProfiles(semanticRequest, lock)).toEqual([]);
    expect(lock).toHaveBeenCalledOnce();
  });

  it("materializes repository-skill stages under each engine discovery root", () => {
    const repoDir = repository();
    const { repositorySkill } = sealedRepositorySkillPackage(repoDir, { body: "# Pinned repository package\n" });

    for (const agent of ["claude", "codex", "opencode"]) {
      const input = fixture({
        agent,
        capability: "agent/repository-skill@1",
        repositorySkill,
      });
      const actionRoot = mkdtempSync(join(tmpdir(), `ot-stage-actions-${agent}-`));
      directories.push(actionRoot);
      process.env.OT_STAGE_ACTION_ROOT = actionRoot;
      const environment = repositorySkillStageEnvironment(input.request);
      const materialized = materializeRepositorySkill({
        request: input.request,
        repoDir,
        discoveryRoot: environment.repositorySkillDiscoveryRoot,
      });
      const actionDirectory = join(actionRoot, "attempt-1");
      const expectedRoot = agent === "claude"
        ? join(actionDirectory, "home", ".claude", "skills", "implement_unit")
        : agent === "codex"
          ? join(actionDirectory, "codex", "skills", "implement_unit")
          : join(actionDirectory, "opencode-skills", "implement_unit");

      expect(materialized).toBe(expectedRoot);
      expect(readFileSync(join(materialized, "SKILL.md"), "utf8")).toContain("Pinned repository package");
      expect(existsSync(join(actionDirectory, "codex", "auth.json"))).toBe(false);
      if (agent === "opencode") {
        expect(stagePrompt(input.request, join(actionDirectory, "home", "proposal.json"), { agent, repositorySkillRoot: materialized }))
          .toContain("Pinned repository package");
      }
    }
  });

  it("locks repository-skill stage homes when setup fails before agent launch", () => {
    const repoDir = repository();
    const { repositorySkill } = sealedRepositorySkillPackage(repoDir);
    const input = fixture({
      capability: "agent/repository-skill@1",
      contextPolicy: "resume_required",
      nativeSessionId: "missing-session",
      repositorySkill,
    });
    input.repoDir = repoDir;
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-stage-actions-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "ot-stage-native-sessions-"));
    directories.push(actionRoot, sourceRoot);
    process.env.OT_STAGE_ACTION_ROOT = actionRoot;
    process.env.OT_NATIVE_SESSION_SOURCE_ROOT = sourceRoot;

    expect(() => defaultRunAgent({
      request: input.request,
      invocation: resolveContextInvocation(input.request),
      repoDir,
      proposalPath: join(actionRoot, "proposal.json"),
      timeoutMs: 1000,
    })).toThrow(/authorized native session state is unavailable/);

    expect(statSync(join(actionRoot, "attempt-1")).mode & 0o777).toBe(0o700);
    expect(statSync(join(actionRoot, "attempt-1", "codex")).mode & 0o777).toBe(0o700);
  });

  it("materializes sealed native session packages before repository-skill resume", () => {
    const repoDir = repository();
    const { repositorySkill } = sealedRepositorySkillPackage(repoDir);
    const input = fixture({
      capability: "agent/repository-skill@1",
      contextPolicy: "resume_required",
      nativeSessionId: "native-1",
      repositorySkill,
    });
    input.repoDir = repoDir;
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-stage-actions-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "ot-stage-native-sessions-"));
    const sourceProfile = mkdtempSync(join(tmpdir(), "ot-source-profile-"));
    const binDir = mkdtempSync(join(tmpdir(), "ot-fake-bin-"));
    directories.push(actionRoot, sourceRoot, sourceProfile, binDir);
    const sourceSessionStore = nativeSessionStoragePath("codex", sourceProfile);
    mkdirSync(sourceSessionStore, { recursive: true });
    writeFileSync(join(sourceSessionStore, "native-1.json"), codexSessionStorageRecord("native-1"));
    sealNativeSessionPackage({
      agent: "codex",
      nativeSessionId: "native-1",
      profileRoot: sourceProfile,
      sourceRoot,
    });
    process.env.OT_STAGE_ACTION_ROOT = actionRoot;
    process.env.OT_NATIVE_SESSION_SOURCE_ROOT = sourceRoot;

    installFakeGosu(binDir);
    writeExecutable(join(binDir, "codex"), `#!/usr/bin/env bash
set -euo pipefail
test -f "$CODEX_HOME/sessions/native-1.json"
test "$OT_STAGE_PROPOSAL_FILE" = "$OT_STAGE_ACTION_ROOT/attempt-1/home/proposal.json"
cat > "$OT_STAGE_PROPOSAL_FILE" <<'JSON'
{"schema":"openthrottle.stage-proposal/v1","suggested_outcome":"success","summary":"ok","evidence":["session materialized"],"findings":[],"actions":[],"uncertainty":[]}
JSON
printf '{"type":"thread.started","thread_id":"native-1"}\\n'
`);
    withPrependedPath(binDir, () => {
      const result = defaultRunAgent({
        request: input.request,
        invocation: resolveContextInvocation(input.request),
        repoDir: input.repoDir,
        proposalPath: join(actionRoot, "persistent", "proposal.json"),
        timeoutMs: 5_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.proposal).toMatchObject({ suggested_outcome: "success" });
    });
  });

  it("removes stale action-local repository-skill proposals before invocation", () => {
    const repoDir = repository();
    const { repositorySkill } = sealedRepositorySkillPackage(repoDir);
    const input = fixture({
      capability: "agent/repository-skill@1",
      repositorySkill,
    });
    input.repoDir = repoDir;
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-stage-actions-"));
    const binDir = mkdtempSync(join(tmpdir(), "ot-fake-bin-"));
    directories.push(actionRoot, binDir);
    process.env.OT_STAGE_ACTION_ROOT = actionRoot;
    mkdirSync(join(actionRoot, "attempt-1", "home"), { recursive: true });
    writeFileSync(join(actionRoot, "attempt-1", "home", "proposal.json"), JSON.stringify({
      schema: "openthrottle.stage-proposal/v1",
      suggested_outcome: "success",
      summary: "stale",
      evidence: ["stale"],
      findings: [],
      actions: [],
      uncertainty: [],
    }));

    installFakeGosu(binDir);
    writeExecutable(join(binDir, "codex"), `#!/usr/bin/env bash
set -euo pipefail
if [ -e "$OT_STAGE_PROPOSAL_FILE" ]; then
  echo "stale proposal was not removed" >&2
  exit 44
fi
cat > "$OT_STAGE_PROPOSAL_FILE" <<'JSON'
{"schema":"openthrottle.stage-proposal/v1","suggested_outcome":"success","summary":"fresh","evidence":["fresh"],"findings":[],"actions":[],"uncertainty":[]}
JSON
`);
    withPrependedPath(binDir, () => {
      const result = defaultRunAgent({
        request: input.request,
        invocation: resolveContextInvocation(input.request),
        repoDir: input.repoDir,
        proposalPath: join(actionRoot, "persistent", "proposal.json"),
        timeoutMs: 5_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.proposal).toMatchObject({ summary: "fresh" });
    });
  });

  it("seals Claude native session packages when the stub writes canonical continuation state", () => {
    const repoDir = repository();
    const { repositorySkill } = sealedRepositorySkillPackage(repoDir);
    const input = fixture({
      agent: "claude",
      capability: "agent/repository-skill@1",
      repositorySkill,
    });
    input.repoDir = repoDir;
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-stage-actions-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "ot-stage-native-sessions-"));
    const binDir = mkdtempSync(join(tmpdir(), "ot-fake-bin-"));
    directories.push(actionRoot, sourceRoot, binDir);
    process.env.OT_STAGE_ACTION_ROOT = actionRoot;
    process.env.OT_NATIVE_SESSION_SOURCE_ROOT = sourceRoot;

    installFakeGosu(binDir);
    writeExecutable(join(binDir, "claude"), `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME/.claude/projects"
printf '{"type":"user","sessionId":"smoke-claude-session","message":{"role":"user","content":"x"}}\\n' > "$HOME/.claude/projects/smoke-claude-session.jsonl"
cat > "$OT_STAGE_PROPOSAL_FILE" <<'JSON'
{"schema":"openthrottle.stage-proposal/v1","suggested_outcome":"success","summary":"ok","evidence":["session sealed"],"findings":[],"actions":[],"uncertainty":[]}
JSON
printf '{"type":"system","subtype":"init","session_id":"smoke-claude-session","model":"stub"}\\n'
`);
    withPrependedPath(binDir, () => {
      const result = defaultRunAgent({
        request: input.request,
        invocation: resolveContextInvocation(input.request),
        repoDir: input.repoDir,
        proposalPath: join(actionRoot, "proposal.json"),
        timeoutMs: 1000,
      });

      expect(result.nativeSessionId).toBe("smoke-claude-session");
      expect(readFileSync(
        join(sourceRoot, "claude", "smoke-claude-session", "projects", "smoke-claude-session.jsonl"),
        "utf8",
      )).toContain('"sessionId":"smoke-claude-session"');
    });
  });

  it("refuses Claude stage native session ids when the sealed package lacks the reported id", () => {
    const input = fixture({
      agent: "claude",
      capability: "agent/repository-skill@1",
      repositorySkill: "fixture",
    });
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-stage-actions-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "ot-stage-native-sessions-"));
    const binDir = mkdtempSync(join(tmpdir(), "ot-fake-bin-"));
    directories.push(actionRoot, sourceRoot, binDir);
    process.env.OT_STAGE_ACTION_ROOT = actionRoot;
    process.env.OT_NATIVE_SESSION_SOURCE_ROOT = sourceRoot;
    const unrelatedProfileRoot = mkdtempSync(join(tmpdir(), "ot-stage-unrelated-claude-profile-"));
    directories.push(unrelatedProfileRoot);
    const unrelatedSessionStore = nativeSessionStoragePath("claude", unrelatedProfileRoot);
    mkdirSync(unrelatedSessionStore, { recursive: true });
    writeFileSync(
      join(unrelatedSessionStore, "unrelated-claude-session.jsonl"),
      '{"type":"user","sessionId":"unrelated-claude-session","message":{"role":"user","content":"x"}}\n',
    );
    sealNativeSessionPackage({
      agent: "claude",
      nativeSessionId: "unrelated-claude-session",
      profileRoot: unrelatedProfileRoot,
      sourceRoot,
    });

    installFakeGosu(binDir);
    const emissionMarker = join(actionRoot, "reported-but-unsealed-claude-session.emitted");
    writeExecutable(join(binDir, "claude"), `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME/.claude/projects"
printf '{"type":"user","sessionId":"unrelated-claude-session","message":{"role":"user","content":"x"}}\\n' > "$HOME/.claude/projects/unrelated-claude-session.jsonl"
cat > "$OT_STAGE_PROPOSAL_FILE" <<'JSON'
{"schema":"openthrottle.stage-proposal/v1","suggested_outcome":"success","summary":"ok","evidence":["session reported"],"findings":[],"actions":[],"uncertainty":[]}
JSON
printf '{"type":"system","subtype":"init","session_id":"reported-but-unsealed-claude-session","model":"stub"}\\n'
: > "${emissionMarker}"
`);
    withPrependedPath(binDir, () => {
      expect(() => defaultRunAgent({
        request: input.request,
        invocation: resolveContextInvocation(input.request),
        repoDir: input.repoDir,
        proposalPath: join(actionRoot, "proposal.json"),
        timeoutMs: 1000,
      })).toThrow(/native session package does not contain the reported native session id/);
    });
    expect(existsSync(emissionMarker)).toBe(true);
  });

  it("rejects resumed stage output that reports a different native session id", () => {
    const input = fixture({
      agent: "claude",
      contextPolicy: "resume_required",
      nativeSessionId: "requested-claude-session",
    });
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-stage-actions-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "ot-stage-native-sessions-"));
    const binDir = mkdtempSync(join(tmpdir(), "ot-fake-bin-"));
    directories.push(actionRoot, sourceRoot, binDir);
    process.env.OT_STAGE_ACTION_ROOT = actionRoot;
    process.env.OT_NATIVE_SESSION_SOURCE_ROOT = sourceRoot;

    installFakeGosu(binDir);
    writeExecutable(join(binDir, "claude"), `#!/usr/bin/env bash
set -euo pipefail
cat > "$OT_STAGE_PROPOSAL_FILE" <<'JSON'
{"schema":"openthrottle.stage-proposal/v1","suggested_outcome":"success","summary":"ok","evidence":["session reported"],"findings":[],"actions":[],"uncertainty":[]}
JSON
printf '{"type":"system","subtype":"init","session_id":"different-claude-session","model":"stub"}\\n'
`);
    withPrependedPath(binDir, () => {
      expect(() => defaultRunAgent({
        request: input.request,
        invocation: resolveContextInvocation(input.request),
        repoDir: input.repoDir,
        proposalPath: join(actionRoot, "proposal.json"),
        timeoutMs: 1000,
      })).toThrow(/reported native session id does not match the sealed stage request/);
    });
  });

  it("refuses reported stage native session ids when sealing cannot produce a package and surfaces cleanup failures", () => {
    const repoDir = repository();
    const { repositorySkill } = sealedRepositorySkillPackage(repoDir);
    const input = fixture({
      capability: "agent/repository-skill@1",
      repositorySkill,
    });
    input.repoDir = repoDir;
    const actionRoot = mkdtempSync(join(tmpdir(), "ot-stage-actions-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "ot-stage-native-sessions-"));
    const binDir = mkdtempSync(join(tmpdir(), "ot-fake-bin-"));
    directories.push(actionRoot, sourceRoot, binDir);
    process.env.OT_STAGE_ACTION_ROOT = actionRoot;
    process.env.OT_NATIVE_SESSION_SOURCE_ROOT = sourceRoot;

    installFakeGosu(binDir);
    writeExecutable(join(binDir, "codex"), `#!/usr/bin/env bash
set -euo pipefail
cat > "$OT_STAGE_PROPOSAL_FILE" <<'JSON'
{"schema":"openthrottle.stage-proposal/v1","suggested_outcome":"success","summary":"ok","evidence":["session reported"],"findings":[],"actions":[],"uncertainty":[]}
JSON
printf '{"type":"thread.started","thread_id":"native-1"}\\n'
`);
    withPrependedPath(binDir, () => {
      expect(() => defaultRunAgent({
        request: input.request,
        invocation: resolveContextInvocation(input.request),
        repoDir: input.repoDir,
        proposalPath: join(actionRoot, "proposal.json"),
        timeoutMs: 1000,
        lockPersistentProfiles: () => ["locked-profile"],
        restorePersistentProfiles: () => {
          throw new Error("profile restore failed");
        },
        lockStageHome: () => true,
      })).toThrow(/native session package does not contain the reported native session id.*profile restore failed/s);
    });
  });

  it("executes only the sealed allowlisted command and records tree mutation", () => {
    const input = fixture({
      capability: "command/run@1",
      contextPolicy: "none",
      requiredArtifacts: ["stage_result", "command_result"],
      credentialScopes: ["repo.read"],
      liveSteering: false,
      commandName: "test",
    });
    const executeCommand = vi.fn(({ command, repoDir }) => {
      writeFileSync(join(repoDir, "new.txt"), "new\n");
      return { exitCode: 0, signal: null, timedOut: false, stdout: "ok", stderr: "" };
    });
    const result = executeStage({ ...input, executeCommand, now: clock() });
    expect(executeCommand).toHaveBeenCalledWith(expect.objectContaining({ command: "test-command" }));
    expect(result.outcome).toBe("success");
    const payload = JSON.parse(result.artifacts[0].payload);
    expect(payload.repository.post_subject).not.toBe(payload.repository.pre_subject);
    expect(payload.details.command_name).toBe("test");
  });

  it("executes repository-defined command names from the sealed command inventory", () => {
    const input = fixture({
      capability: "command/run@1",
      contextPolicy: "none",
      requiredArtifacts: ["stage_result", "command_result"],
      credentialScopes: ["repo.read"],
      liveSteering: false,
      commandName: "docs-check",
    });
    const executeCommand = vi.fn(() => ({ exitCode: 0, signal: null, timedOut: false, stdout: "ok", stderr: "" }));
    const result = executeStage({ ...input, executeCommand, now: clock() });

    expect(executeCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: "test-command",
      commandName: "docs-check",
    }));
    expect(result.outcome).toBe("success");
    expect(JSON.parse(result.artifacts[0].payload).details.command_name).toBe("docs-check");
  });

  it("normalizes an unconfigured command to a valid no-change event outcome", () => {
    const input = fixture({
      capability: "command/run@1",
      contextPolicy: "none",
      requiredArtifacts: ["stage_result", "command_result"],
      credentialScopes: ["repo.read"],
      liveSteering: false,
      commandName: "test",
      configuredCommand: false,
    });
    const result = executeStage({ ...input, now: clock() });
    expect(result.outcome).toBe("no_change");
    expect(JSON.parse(result.artifacts[0].payload).result).toBe("not_configured");
  });

  it("seals a typed retryable result when the command executor throws", () => {
    const input = fixture({
      capability: "command/run@1",
      contextPolicy: "none",
      requiredArtifacts: ["stage_result", "command_result"],
      credentialScopes: ["repo.read"],
      liveSteering: false,
      commandName: "test",
    });
    const result = executeStage({
      ...input,
      now: clock(),
      executeCommand: () => {
        throw new Error("bounded process helper failed: terminated by SIGKILL");
      },
    });
    expect(result.outcome).toBe("retryable_infrastructure_failure");
    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual(["stage_result", "command_result"]);
    const payload = JSON.parse(result.artifacts[0].payload);
    expect(payload.result).toBe("retryable_infrastructure_failure");
    expect(payload.details.executor_failure).toBe(true);
    expect(payload.details.exit_code).toBeNull();
    expect(payload.details.stderr).toMatch(/bounded process helper failed/);
    expect(payload.repository.post_subject).toBe(payload.repository.pre_subject);
  });

  it("writes a sealed typed result when the expected-subject fence rejects the workspace", () => {
    const input = fixture({
      capability: "command/run@1",
      contextPolicy: "none",
      requiredArtifacts: ["stage_result", "command_result"],
      credentialScopes: ["repo.read"],
      liveSteering: false,
      commandName: "test",
    });
    writeFileSync(join(input.repoDir, "drift.txt"), "workspace drifted after sealing\n");
    const stateDir = mkdtempSync(join(tmpdir(), "ot-stage-fallback-"));
    directories.push(stateDir);
    writeFileSync(join(stateDir, "request.json"), JSON.stringify(input.request));
    writeFileSync(join(stateDir, "config.json"), input.configRaw);
    writeFileSync(join(stateDir, "manifest.json"), input.manifestRaw);
    const outputPath = join(stateDir, "results", `${input.request.attemptId}.json`);

    const executed = spawnSync(process.execPath, [
      fileURLToPath(new URL("./execute-stage.mjs", import.meta.url)),
      "--request", join(stateDir, "request.json"),
      "--config", join(stateDir, "config.json"),
      "--manifest", join(stateDir, "manifest.json"),
      "--repo", input.repoDir,
      "--output", outputPath,
    ], { encoding: "utf8", timeout: 30_000 });

    expect(executed.status).toBe(1);
    expect(executed.stderr).toContain("workspace subject does not match the fenced expected subject");
    const event = JSON.parse(readFileSync(outputPath, "utf8"));
    expect(event.kind).toBe("stage_result");
    expect(event.outcome).toBe("retryable_infrastructure_failure");
    expect(event.attempt_id).toBe(input.request.attemptId);
    expect(event.request_hash).toBe(input.request.requestHash);
    const stageResult = event.artifacts.find((artifact) => artifact.kind === "stage_result");
    expect(event.result_hash).toBe(stageResult.hash);
    expect(event.artifacts.map((artifact) => artifact.kind)).toEqual(["stage_result", "command_result"]);
    const payload = JSON.parse(stageResult.payload);
    expect(payload.result).toBe("retryable_infrastructure_failure");
    expect(payload.details.executor_failure).toBe(true);
    expect(payload.details.stderr).toMatch(/fenced expected subject/);
    // The fallback must not launder the drifted tree into the fence chain:
    // every subject field reports the fenced expected subject.
    expect(payload.repository.pre_subject).toBe(input.request.expectedSubject);
    expect(payload.repository.post_subject).toBe(input.request.expectedSubject);
    expect(event.subject).toBe(input.request.expectedSubject);
    expect(computeWorkspaceTreeOid(input.repoDir)).not.toBe(input.request.expectedSubject);
  });

  it("builds a semantic fallback result for agent stages that crash before evidence", () => {
    const input = fixture();
    const event = fallbackStageResultEvent({
      request: input.request,
      repoDir: input.repoDir,
      error: new Error("agent process cleanup timed out"),
    });
    expect(event.kind).toBe("stage_result");
    expect(event.outcome).toBe("retryable_infrastructure_failure");
    expect(event.request_hash).toBe(input.request.requestHash);
    const payload = JSON.parse(event.artifacts[0].payload);
    expect(payload.summary).toMatch(/agent process cleanup timed out/);
    expect(payload.repository.pre_subject).toBe(input.request.expectedSubject);
  });

  it("seals the exact pushed commit after publication reconciles its tree", () => {
    const input = publishFixture();
    addBareOrigin(input, { push: true });

    const result = executeStage({
      ...input,
      runAgent: () => ({ exitCode: 0, proposal: successProposal(), nativeSessionId: "publish-session" }),
      now: clock(),
    });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: input.repoDir, encoding: "utf8" }).trim();
    const publish = result.artifacts.find((artifact) => artifact.kind === "publish_subject");

    expect(result.outcome).toBe("success");
    expect(JSON.parse(publish.payload).details.published_commit).toBe(head);
  });

  it("makes a malformed publish-success proposal retryable even when the exact branch exists", () => {
    const input = publishFixture();
    addBareOrigin(input, { push: true });

    const result = executeStage({
      ...input,
      runAgent: () => ({
        exitCode: 0,
        proposal: { ...successProposal(), findings: "not-an-array" },
        nativeSessionId: "publish-session",
      }),
      now: clock(),
    });
    const payload = JSON.parse(result.artifacts[0].payload);

    expect(result.outcome).toBe("retryable_infrastructure_failure");
    expect(payload.findings).toContainEqual(expect.objectContaining({
      severity: "P2",
      code: "publish-reconciliation-incomplete",
    }));
  });

  it("retains blocking findings from a valid publish-success proposal", () => {
    const input = publishFixture();
    addBareOrigin(input, { push: true });
    const blockingFinding = {
      severity: "P1",
      code: "publish-pr-evidence-gap",
      summary: "The pull request evidence needs follow-up.",
    };

    const result = executeStage({
      ...input,
      runAgent: () => ({
        exitCode: 0,
        proposal: { ...successProposal(), findings: [blockingFinding] },
        nativeSessionId: "publish-session",
      }),
      now: clock(),
    });
    const payload = JSON.parse(result.artifacts[0].payload);

    expect(result.outcome).toBe("success");
    expect(payload.findings).toContainEqual(blockingFinding);
  });

  it("requires semantic repair when publish reports success without a matching remote subject", () => {
    const input = publishFixture();
    addBareOrigin(input);

    const result = executeStage({
      ...input,
      runAgent: () => ({ exitCode: 0, proposal: successProposal(), nativeSessionId: "publish-session" }),
      now: clock(),
    });
    const payload = JSON.parse(result.artifacts[0].payload);

    expect(result.outcome).toBe("semantic_repair_required");
    expect(payload.findings).toContainEqual(expect.objectContaining({
      severity: "P1",
      code: "publish-subject-mismatch",
    }));
  });

  it("makes an uncertain remote inspection retryable with advisory diagnostics", () => {
    const input = publishFixture();
    const remoteParent = mkdtempSync(join(tmpdir(), "ot-stage-missing-remote-"));
    directories.push(remoteParent);
    const missingRemote = join(remoteParent, "not-present.git");
    execFileSync("git", ["remote", "add", "origin", missingRemote], { cwd: input.repoDir });

    const result = executeStage({
      ...input,
      runAgent: () => ({ exitCode: 0, proposal: successProposal(), nativeSessionId: "publish-session" }),
      now: clock(),
    });
    const payload = JSON.parse(result.artifacts[0].payload);

    expect(result.outcome).toBe("retryable_infrastructure_failure");
    expect(payload.findings).toContainEqual(expect.objectContaining({
      severity: "P2",
      code: "publish-reconciliation-uncertain",
    }));
  });

  it("retries publication when the exact branch push succeeds before terminal PR evidence", () => {
    const input = publishFixture();
    const remote = addBareOrigin(input);

    const result = executeStage({
      ...input,
      runAgent: ({ repoDir, request }) => {
        execFileSync("git", ["push", "-q", "origin", `HEAD:refs/heads/${request.branch}`], { cwd: repoDir });
        throw new Error("transport ended after the remote accepted the push");
      },
      now: clock(),
    });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: input.repoDir, encoding: "utf8" }).trim();
    const remoteHead = execFileSync("git", ["rev-parse", `refs/heads/${input.request.branch}`], {
      cwd: remote,
      encoding: "utf8",
    }).trim();

    expect(remoteHead).toBe(head);
    expect(result.outcome).toBe("retryable_infrastructure_failure");
    expect(JSON.parse(result.artifacts[0].payload).findings[0]).toMatchObject({
      severity: "P2",
      code: "publish-reconciliation-incomplete",
    });
  });

  it("makes an unconfirmed failed publication retryable", () => {
    const input = publishFixture();
    addBareOrigin(input);

    const result = executeStage({
      ...input,
      runAgent: () => {
        throw new Error("transport failed before push");
      },
      now: clock(),
    });

    expect(result.outcome).toBe("retryable_infrastructure_failure");
    expect(JSON.parse(result.artifacts[0].payload).findings[0]).toMatchObject({
      severity: "P2",
      code: "publish-reconciliation-incomplete",
    });
  });

  it("classifies publish-stage Codex model-auth 401 before publication reconciliation", () => {
    const input = publishFixture();
    addBareOrigin(input);
    const diagnostic = "401 Unauthorized on wss://example.com/backend-api/codex/responses: " +
      "refresh_token_invalidated - Your session has ended";

    const result = executeStage({
      ...input,
      runAgent: () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stderr: diagnostic,
        proposal: undefined,
        nativeSessionId: "publish-session",
      }),
      now: clock(),
    });
    const payload = JSON.parse(result.artifacts[0].payload);

    expect(result.outcome).toBe("retryable_infrastructure_failure");
    expect(payload.summary).toContain("Model credential expired - refresh CODEX_AUTH_JSON");
    expect(payload.summary).toContain("refresh_token_invalidated");
    expect(payload.findings).toEqual([]);
  });

  it("retries publication when a valid failure follows an exact branch push", () => {
    const input = publishFixture();
    addBareOrigin(input, { push: true });

    const result = executeStage({
      ...input,
      runAgent: () => ({
        exitCode: 0,
        proposal: { ...successProposal(), suggested_outcome: "failure", summary: "PR creation failed" },
        nativeSessionId: "publish-session",
      }),
      now: clock(),
    });

    expect(result.outcome).toBe("retryable_infrastructure_failure");
    expect(JSON.parse(result.artifacts[0].payload).findings[0]).toMatchObject({
      severity: "P2",
      code: "publish-reconciliation-incomplete",
    });
  });

  it("retries publication when a timed-out publisher left an exact branch push", () => {
    const input = publishFixture();
    addBareOrigin(input, { push: true });

    const result = executeStage({
      ...input,
      runAgent: () => ({
        exitCode: 0,
        signal: null,
        timedOut: true,
        proposal: successProposal(),
        nativeSessionId: "publish-session",
      }),
      now: clock(),
    });

    expect(result.outcome).toBe("retryable_infrastructure_failure");
    expect(JSON.parse(result.artifacts[0].payload).findings[0]).toMatchObject({
      severity: "P2",
      code: "publish-reconciliation-incomplete",
    });
  });

  it("classifies agent runner and cleanup exceptions as retryable infrastructure failures", () => {
    const input = fixture();
    const result = executeStage({
      ...input,
      runAgent: () => {
        throw new Error("agent cleanup failed");
      },
      now: clock(),
    });

    expect(result.outcome).toBe("retryable_infrastructure_failure");
    expect(JSON.parse(result.artifacts[0].payload).summary).toMatch(/agent cleanup failed/);
  });

  it("classifies Codex model-auth 401 exits as credential infrastructure failures", () => {
    const diagnostic = "401 Unauthorized on wss://example.com/backend-api/codex/responses: " +
      "refresh_token_invalidated - Your session has ended";
    const classified = classifyAgentExecutionFailure({
      agent: "codex",
      termination: "exit=1",
      diagnostic,
      terminated: false,
      missingProposal: true,
    });

    expect(classified.suggestedOutcome).toBe("retryable_infrastructure_failure");
    expect(classified.summary).toContain("Model credential expired - refresh CODEX_AUTH_JSON");
    expect(classifyAgentExecutionFailure({
      agent: "claude",
      termination: "exit=1",
      diagnostic,
      terminated: false,
      missingProposal: true,
    }).suggestedOutcome).toBe("failure");
    expect(classifyAgentExecutionFailure({
      agent: "codex",
      termination: "exit=1",
      diagnostic: "401 Unauthorized on an unrelated endpoint",
      terminated: false,
      missingProposal: true,
    }).summary).toContain("Agent exited without the required terminal stage proposal");
    expect(classifyAgentExecutionFailure({
      agent: "codex",
      termination: "exit=1",
      diagnostic: "refresh_token_invalidated - Your session has ended",
      terminated: false,
      missingProposal: true,
    }).suggestedOutcome).toBe("failure");

    const input = fixture();
    const result = executeStage({
      ...input,
      runAgent: () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stderr: diagnostic,
        proposal: undefined,
        nativeSessionId: "native-1",
      }),
      now: clock(),
    });
    const payload = JSON.parse(result.artifacts[0].payload);

    expect(result.outcome).toBe("retryable_infrastructure_failure");
    expect(payload.result).toBe("retryable_infrastructure_failure");
    expect(payload.summary).toContain("Model credential expired - refresh CODEX_AUTH_JSON");
    expect(payload.summary).toContain("refresh_token_invalidated");
  });

  it("rejects a valid proposal when agent execution exceeded its timeout", () => {
    const input = fixture();
    const result = executeStage({
      ...input,
      runAgent: () => ({
        exitCode: 0,
        signal: null,
        timedOut: true,
        proposal: successProposal(),
        nativeSessionId: "native-1",
      }),
      now: clock(),
    });

    expect(result.outcome).toBe("retryable_infrastructure_failure");
    expect(JSON.parse(result.artifacts[0].payload).summary).toMatch(/timed_out=true/);
  });

  it("preserves a valid publish needs-human proposal without remote reconciliation", () => {
    const input = publishFixture();
    const result = executeStage({
      ...input,
      runAgent: () => ({
        exitCode: 0,
        proposal: { ...successProposal(), suggested_outcome: "needs_human", summary: "PR target needs a decision" },
      }),
      now: clock(),
    });

    expect(result.outcome).toBe("needs_human");
    expect(JSON.parse(result.artifacts[0].payload).summary).toBe("PR target needs a decision");
  });

  it("computes subjects from a private index and excludes ignored generated files", () => {
    const repoDir = repository();
    const before = computeWorkspaceTreeOid(repoDir);
    writeFileSync(join(repoDir, "generated", "ignored.txt"), "changed ignored\n");
    expect(computeWorkspaceTreeOid(repoDir)).toBe(before);
    writeFileSync(join(repoDir, "untracked.txt"), "included\n");
    const after = computeWorkspaceTreeOid(repoDir);
    expect(after).not.toBe(before);
    execFileSync("git", ["reset", "--hard", "-q"], { cwd: repoDir });
    expect(computeWorkspaceTreeOid(repoDir)).toBe(after);
  });
});
