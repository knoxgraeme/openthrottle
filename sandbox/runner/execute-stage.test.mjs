import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_DESCRIPTOR, canonicalJson } from "./capabilities.mjs";
import { digest } from "./artifacts.mjs";
import {
  computeWorkspaceTreeOid,
  createStageRequestHash,
  executeStage,
  extractNativeSessionId,
  fallbackStageResultEvent,
  resolveContextInvocation,
  runCapturedProcess,
  runWithAgentProcessFence,
  runtimeCapabilityDigest,
  stagePrompt,
  validateStageRequest,
} from "./execute-stage.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
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

function fixture({
  capability = "agent/semantic@1",
  contextPolicy = "fresh",
  nativeSessionId = null,
  requiredArtifacts = ["stage_result"],
  credentialScopes = ["model.invoke", "repo.read"],
  liveSteering = true,
  commandName,
  configuredCommand = true,
} = {}) {
  const repoDir = repository();
  const config = commandName && configuredCommand ? { [commandName]: "test-command" } : {};
  const stage = {
    id: commandName ? "command" : "review",
    executor: { kind: commandName ? "command" : "agent", capability },
    evaluator: { required_artifacts: requiredArtifacts.filter((kind) => kind !== "stage_result") },
    context: contextPolicy,
    live_steering: liveSteering,
    credentials: credentialScopes,
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
    agent: "codex",
    contextRevision: 0,
    expectedSubject: computeWorkspaceTreeOid(repoDir),
    contextPolicy,
    nativeSessionId,
    capability,
    requiredArtifacts,
    credentialScopes,
    liveSteering,
    ...(commandName ? { commandName } : {}),
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

function repositoryRefs(repoDir) {
  return execFileSync("git", ["for-each-ref", "--format=%(refname) %(objectname)"], {
    cwd: repoDir,
    encoding: "utf8",
  });
}

function clock() {
  const values = ["2026-07-22T00:00:00.000Z", "2026-07-22T00:00:01.000Z"];
  return () => values.shift();
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

  it("implements fresh, required-resume, prefer-resume reconstruction, and fresh-review policies", () => {
    expect(resolveContextInvocation(fixture().request)).toMatchObject({ mode: "fresh", reconstructed: false });
    expect(() => resolveContextInvocation(fixture({ contextPolicy: "resume_required" }).request))
      .toThrow(/missing its native session/);
    expect(resolveContextInvocation(fixture({ contextPolicy: "resume_required", nativeSessionId: "native-1" }).request))
      .toMatchObject({ mode: "resume", nativeSessionId: "native-1" });
    expect(resolveContextInvocation(fixture({ contextPolicy: "prefer_resume" }).request))
      .toMatchObject({ mode: "fresh", reconstructed: true });
    expect(resolveContextInvocation(fixture({ contextPolicy: "fresh_review", liveSteering: false }).request))
      .toMatchObject({ mode: "fresh", readOnly: true });
  });

  it("captures provider-neutral native session identifiers from JSONL", () => {
    expect(extractNativeSessionId('{"type":"system","session_id":"claude-1"}\n', "claude")).toBe("claude-1");
    expect(extractNativeSessionId('{"type":"thread.started","thread_id":"codex-1"}\n', "codex")).toBe("codex-1");
    expect(extractNativeSessionId('{"type":"step_start","sessionID":"opencode-1"}\n', "opencode")).toBe("opencode-1");
    expect(extractNativeSessionId("not-json\n", "codex")).toBeNull();
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

  it("invalidates a fresh-review success when the workspace mutates", () => {
    const input = fixture({ contextPolicy: "fresh_review", liveSteering: false, requiredArtifacts: ["stage_result", "review"] });
    const result = executeStage({
      ...input,
      now: clock(),
      runAgent: ({ repoDir }) => {
        writeFileSync(join(repoDir, "file.txt"), "mutated\n");
        writeFileSync(join(repoDir, "review-output.txt"), "must not escape the review stage\n");
        return { exitCode: 0, proposal: successProposal(), nativeSessionId: "review-session" };
      },
    });
    expect(result.outcome).toBe("semantic_repair_required");
    const payload = JSON.parse(result.artifacts[0].payload);
    expect(payload.findings[0].code).toBe("review-mutated-workspace");
    expect(payload.repository.subject).toBe(payload.repository.pre_subject);
    expect(payload.repository.post_subject).toBe(payload.repository.pre_subject);
    expect(computeWorkspaceTreeOid(input.repoDir)).toBe(payload.repository.subject);
    expect(readFileSync(join(input.repoDir, "file.txt"), "utf8")).toBe("initial\n");
    expect(existsSync(join(input.repoDir, "review-output.txt"))).toBe(false);
  });

  it("restores fresh-review HEAD, symbolic ref, real index, and tree after a commit then throw", () => {
    const input = fixture({ contextPolicy: "fresh_review", liveSteering: false, requiredArtifacts: ["stage_result", "review"] });
    const beforeHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: input.repoDir, encoding: "utf8" }).trim();
    const beforeRef = execFileSync("git", ["symbolic-ref", "HEAD"], { cwd: input.repoDir, encoding: "utf8" }).trim();
    const indexPath = join(input.repoDir, ".git", "index");
    const beforeIndex = readFileSync(indexPath);
    const result = executeStage({
      ...input,
      now: clock(),
      runAgent: ({ repoDir }) => {
        writeFileSync(join(repoDir, "file.txt"), "mutated before invalid proposal\n");
        writeFileSync(join(repoDir, "invalid-review-output.txt"), "must be rolled back\n");
        execFileSync("git", ["add", "-A"], { cwd: repoDir });
        execFileSync("git", ["commit", "-qm", "review must not commit"], { cwd: repoDir });
        throw new Error("invalid stage proposal JSON");
      },
    });

    expect(result.outcome).toBe("semantic_repair_required");
    const payload = JSON.parse(result.artifacts[0].payload);
    expect(payload.findings[0].code).toBe("review-mutated-workspace");
    expect(computeWorkspaceTreeOid(input.repoDir)).toBe(payload.repository.pre_subject);
    expect(readFileSync(join(input.repoDir, "file.txt"), "utf8")).toBe("initial\n");
    expect(existsSync(join(input.repoDir, "invalid-review-output.txt"))).toBe(false);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: input.repoDir, encoding: "utf8" }).trim()).toBe(beforeHead);
    expect(execFileSync("git", ["symbolic-ref", "HEAD"], { cwd: input.repoDir, encoding: "utf8" }).trim()).toBe(beforeRef);
    expect(readFileSync(indexPath).equals(beforeIndex)).toBe(true);
  });

  it.each(["HEAD", "index"])(
    "never follows a fresh-review %s symlink substitution into an external target",
    (controlName) => {
      const input = fixture({ contextPolicy: "fresh_review", liveSteering: false, requiredArtifacts: ["stage_result", "review"] });
      const controlPath = join(input.repoDir, ".git", controlName);
      const beforeControl = readFileSync(controlPath);
      const external = mkdtempSync(join(tmpdir(), "ot-stage-external-control-"));
      directories.push(external);
      const externalTarget = join(external, "sentinel");
      writeFileSync(externalTarget, "external target must remain untouched\n");

      let result;
      let failure;
      try {
        result = executeStage({
          ...input,
          now: clock(),
          runAgent: () => {
            unlinkSync(controlPath);
            symlinkSync(externalTarget, controlPath);
            return { exitCode: 0, proposal: successProposal(), nativeSessionId: "review-session" };
          },
        });
      } catch (error) {
        failure = error;
      }

      expect(readFileSync(externalTarget, "utf8")).toBe("external target must remain untouched\n");
      expect(result ?? failure).toBeDefined();
      if (result) {
        expect(result.outcome).not.toBe("success");
        if (existsSync(controlPath) && !lstatSync(controlPath).isSymbolicLink()) {
          expect(readFileSync(controlPath).equals(beforeControl)).toBe(true);
        }
      }
    },
  );

  it("detects branch/tag-only fresh-review mutations and restores the exact ref namespace", () => {
    const input = fixture({ contextPolicy: "fresh_review", liveSteering: false, requiredArtifacts: ["stage_result", "review"] });
    const initialHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: input.repoDir, encoding: "utf8" }).trim();
    const initialTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: input.repoDir, encoding: "utf8" }).trim();
    const alternateCommit = execFileSync("git", ["commit-tree", initialTree, "-m", "alternate ref target"], {
      cwd: input.repoDir,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["update-ref", "refs/heads/side", initialHead], { cwd: input.repoDir });
    execFileSync("git", ["update-ref", "refs/tags/stable", initialHead], { cwd: input.repoDir });
    const beforeRefs = repositoryRefs(input.repoDir);

    const result = executeStage({
      ...input,
      now: clock(),
      runAgent: ({ repoDir }) => {
        execFileSync("git", ["update-ref", "refs/heads/side", alternateCommit], { cwd: repoDir });
        execFileSync("git", ["update-ref", "-d", "refs/tags/stable"], { cwd: repoDir });
        execFileSync("git", ["update-ref", "refs/tags/intruder", alternateCommit], { cwd: repoDir });
        return { exitCode: 0, proposal: successProposal(), nativeSessionId: "review-session" };
      },
    });

    expect(result.outcome).toBe("semantic_repair_required");
    expect(JSON.parse(result.artifacts[0].payload).findings[0].code).toBe("review-mutated-workspace");
    expect(repositoryRefs(input.repoDir)).toBe(beforeRefs);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: input.repoDir, encoding: "utf8" }).trim()).toBe(initialHead);
  });

  it("detects and removes fresh-review merge and sequencer state", () => {
    const input = fixture({ contextPolicy: "fresh_review", liveSteering: false, requiredArtifacts: ["stage_result", "review"] });
    const gitDir = join(input.repoDir, ".git");
    const mergeHead = join(gitDir, "MERGE_HEAD");
    const sequencer = join(gitDir, "sequencer");
    const initialHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: input.repoDir, encoding: "utf8" }).trim();

    const result = executeStage({
      ...input,
      now: clock(),
      runAgent: () => {
        writeFileSync(mergeHead, `${initialHead}\n`);
        mkdirSync(sequencer);
        writeFileSync(join(sequencer, "todo"), `pick ${initialHead} review-state\n`);
        return { exitCode: 0, proposal: successProposal(), nativeSessionId: "review-session" };
      },
    });

    expect(result.outcome).toBe("semantic_repair_required");
    expect(JSON.parse(result.artifacts[0].payload).findings[0].code).toBe("review-mutated-workspace");
    expect(existsSync(mergeHead)).toBe(false);
    expect(existsSync(sequencer)).toBe(false);
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
    expect(events).toEqual(["agent-returned", "descendants-terminated", "repository-observed"]);
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
    expect(payload.repository.pre_subject).toBe(input.request.expectedSubject);
    expect(payload.repository.post_subject).toBe(computeWorkspaceTreeOid(input.repoDir));
    expect(event.subject).toBe(payload.repository.post_subject);
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
