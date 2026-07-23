import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "./capabilities.mjs";
import { digest } from "./artifacts.mjs";
import {
  computeWorkspaceTreeOid,
  createStageRequestHash,
  executeStage,
  extractNativeSessionId,
  resolveContextInvocation,
  runCapturedProcess,
  runtimeCapabilityDigest,
  stagePrompt,
  validateStageRequest,
} from "./execute-stage.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

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
    runtimeRelease: "openthrottle-snapshot/v1",
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

  it("seals the exact pushed commit after publication reconciles its tree", () => {
    const input = fixture({
      capability: "ce/publish@1",
      contextPolicy: "prefer_resume",
      requiredArtifacts: ["stage_result", "publish_subject"],
      credentialScopes: ["model.invoke", "provider.read", "repo.read", "repo.write"],
      liveSteering: false,
    });
    const remote = mkdtempSync(join(tmpdir(), "ot-stage-remote-"));
    directories.push(remote);
    execFileSync("git", ["init", "--bare", "-q"], { cwd: remote });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: input.repoDir });
    execFileSync("git", ["push", "-q", "origin", `HEAD:refs/heads/${input.request.branch}`], {
      cwd: input.repoDir,
    });

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
