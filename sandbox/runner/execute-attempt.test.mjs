import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, digestCanonicalJson } from "./generated-result-contracts.mjs";
import { executeAttempt, validateKernelRequest } from "./execute-attempt.mjs";

const semanticSchema = {
  schema: "openthrottle.semantic-result-schema/v1",
  id: "core/unit-result",
  outcomes: ["success", "failure", "needs_human"],
  payload: {
    summary: {
      type: "string",
      required: true,
      max_length: 4_000,
      normalize: "string-array-to-newlines/v1",
    },
    verification: {
      type: "string_list",
      required: true,
      max_length: 1_000,
      max_items: 32,
    },
  },
};

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function sourceRepository() {
  const repo = mkdtempSync(join(tmpdir(), "ot-attempt-source-"));
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "work.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "base");
  return { repo, subject: git(repo, "rev-parse", "HEAD^{tree}") };
}

function skillEntry() {
  const normalized_payload = {
    frontmatter: { name: "implement-plan", description: "Implement the task" },
    instructions: "Implement carefully.",
    files: [],
  };
  return {
    definition_kind: "skill",
    definition_id: "core/implement-plan",
    content_hash: digestCanonicalJson(normalized_payload),
    normalized_payload,
  };
}

function workRequest(subject, overrides = {}) {
  return {
    schema: "openthrottle.kernel-action-request/v2",
    phase: "work",
    pipeline_run_id: "run-1",
    attempt_id: "attempt-1",
    stage_id: "implement",
    scope: { kind: "stage", stage_id: "implement" },
    request_hash: "a".repeat(64),
    definition_bundle_hash: "b".repeat(64),
    input_subject: subject,
    repository_authority: "edit",
    lease_id: "lease-work",
    worker_id: "worker-1",
    task_prompt: "Implement the approved plan.",
    context: { records: [], checkpoints: [] },
    runtime_resource: null,
    change_boundary: null,
    action: {
      kind: "agent",
      engine: "claude",
      model: null,
      reasoning_effort: null,
      agent_id: "core/implementer",
      skill_ids: ["core/implement-plan"],
      entry_skill: "core/implement-plan",
      eval_id: "core/unit-result",
      semantic_result_schema: semanticSchema,
      execution_limits: { max_turns: 12, task_timeout_seconds: 600 },
      definition_entries: [
        {
          definition_kind: "agent",
          definition_id: "core/implementer",
          content_hash: digestCanonicalJson("You implement an approved task."),
          normalized_payload: "You implement an approved task.",
        },
        skillEntry(),
      ],
    },
    executor_policy: {
      git_administration: "executor_only",
      commit: false,
      push: false,
      publish: false,
    },
    ...overrides,
  };
}

function claudeOutput(sessionId, candidate) {
  return [
    JSON.stringify({ type: "system", session_id: sessionId }),
    JSON.stringify({ type: "result", structured_output: candidate }),
  ].join("\n");
}

describe("kernel attempt executor", () => {
  it("rejects legacy v1 work and correction envelopes before execution", () => {
    const request = workRequest("a".repeat(40));

    expect(() => validateKernelRequest({
      ...request,
      schema: "openthrottle.kernel-action-request/v1",
    })).toThrow(/schema or phase is unsupported/);
    expect(() => validateKernelRequest({
      ...request,
      schema: "openthrottle.kernel-result-correction-request/v1",
      phase: "result_correction",
    })).toThrow(/schema or phase is unsupported/);
  });

  it("normalizes OPE-188 and replays the immutable result without redispatch", async () => {
    const source = sourceRepository();
    const root = mkdtempSync(join(tmpdir(), "ot-attempt-"));
    const resultPath = join(root, "transport", "work.json");
    const sessionPath = join(root, "transport", "session.json");
    let launches = 0;
    const request = workRequest(source.subject);
    const runAgent = async ({ repositoryPath, onSession, timeoutMs }) => {
      launches += 1;
      expect(timeoutMs).toBe(600_000);
      writeFileSync(join(repositoryPath, "work.txt"), "implemented\n");
      await onSession("session-1");
      expect(existsSync(sessionPath)).toBe(true);
      return {
        status: 0,
        signal: null,
        timedOut: false,
        nativeSessionId: "session-1",
        stderr: "",
        stdout: claudeOutput("session-1", {
          schema: "openthrottle.result-candidate/v1",
          outcome: "success",
          payload: {
            summary: ["Implemented the unit.", "Targeted tests pass."],
            verification: ["targeted tests pass"],
          },
        }),
      };
    };
    const first = await executeAttempt({
      request,
      sourceRepoDir: source.repo,
      actionRoot: join(root, "actions"),
      resultPath,
      sessionPath,
      runAgent,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    const replay = await executeAttempt({
      request,
      sourceRepoDir: source.repo,
      actionRoot: join(root, "actions"),
      resultPath,
      sessionPath,
      runAgent,
      now: () => new Date("2026-08-20T00:00:01.000Z"),
    });

    expect(launches).toBe(1);
    expect(replay).toEqual(first);
    expect(first.outcome).toMatchObject({
      state: "work_complete",
      result: {
        kind: "semantic",
        candidate: {
          candidate: { payload: { summary: "Implemented the unit.\nTargeted tests pass." } },
          transformations: [{ id: "string-array-to-newlines/v1" }],
        },
      },
    });
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual(first);
  });

  it("supplies inspect agents the bounded exact-boundary artifact without repository mutation", async () => {
    const source = sourceRepository();
    const before = source.subject;
    writeFileSync(join(source.repo, "work.txt"), "accepted edit\n");
    writeFileSync(join(source.repo, "added.txt"), "added\n");
    git(source.repo, "add", ".");
    const after = git(source.repo, "write-tree");
    const root = mkdtempSync(join(tmpdir(), "ot-attempt-inspect-"));
    const request = workRequest(after, {
      repository_authority: "inspect",
      change_boundary: {
        checkpoint_id: "checkpoint-accepted",
        input_subject: before,
        output_subject: after,
      },
    });
    const runAgent = async ({ request: runtimeRequest, repositoryPath, onSession }) => {
      expect(readFileSync(join(repositoryPath, "work.txt"), "utf8")).toBe("accepted edit\n");
      const descriptor = runtimeRequest.inspect_change_artifact;
      const artifact = JSON.parse(readFileSync(descriptor.path, "utf8"));
      expect(artifact).toMatchObject({
        schema: "openthrottle.inspect-change-context/v1",
        checkpoint_id: "checkpoint-accepted",
        base_subject: before,
        input_subject: after,
        changed_paths: ["added.txt", "work.txt"],
        omissions: [],
      });
      expect(artifact.textual_diff).toContain("+accepted edit");
      await onSession("session-inspect");
      return {
        status: 0,
        signal: null,
        timedOut: false,
        nativeSessionId: "session-inspect",
        stderr: "",
        stdout: claudeOutput("session-inspect", {
          schema: "openthrottle.result-candidate/v1",
          outcome: "success",
          payload: {
            summary: "Reviewed the accepted edit.",
            verification: ["executor change artifact inspected"],
          },
        }),
      };
    };
    const result = await executeAttempt({
      request,
      sourceRepoDir: source.repo,
      actionRoot: join(root, "actions"),
      resultPath: join(root, "transport", "work.json"),
      sessionPath: join(root, "transport", "session.json"),
      runAgent,
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(result.outcome).toMatchObject({
      state: "work_complete",
      checkpoint: { input_subject: after, output_subject: null },
    });
    expect(readFileSync(join(source.repo, "work.txt"), "utf8")).toBe("accepted edit\n");
  });

  it("repairs only the result against the locked checkpoint without rerunning work", async () => {
    const source = sourceRepository();
    const root = mkdtempSync(join(tmpdir(), "ot-attempt-repair-"));
    const request = workRequest(source.subject);
    let workLaunches = 0;
    const pending = await executeAttempt({
      request,
      sourceRepoDir: source.repo,
      actionRoot: join(root, "actions"),
      resultPath: join(root, "transport", "work.json"),
      sessionPath: join(root, "transport", "session.json"),
      runAgent: async ({ repositoryPath, onSession }) => {
        workLaunches += 1;
        writeFileSync(join(repositoryPath, "work.txt"), "implemented\n");
        await onSession("session-2");
        return {
          status: 0, signal: null, timedOut: false, nativeSessionId: "session-2", stderr: "",
          stdout: claudeOutput("session-2", {
            schema: "openthrottle.result-candidate/v1",
            outcome: "success",
            payload: { summary: ["valid", 7], verification: ["tests pass"] },
          }),
        };
      },
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    expect(pending.outcome.state).toBe("result_pending");
    expect(workLaunches).toBe(1);
    const checkpoint = pending.outcome.checkpoint;
    const correction = {
      schema: "openthrottle.kernel-result-correction-request/v2",
      phase: "result_correction",
      engine: "claude",
      model: null,
      reasoning_effort: null,
      pipeline_run_id: request.pipeline_run_id,
      attempt_id: request.attempt_id,
      stage_id: request.stage_id,
      scope: request.scope,
      request_hash: request.request_hash,
      definition_bundle_hash: request.definition_bundle_hash,
      input_subject: request.input_subject,
      locked_subject: checkpoint.output_subject,
      checkpoint_id: checkpoint.id,
      native_session_id: "session-2",
      lease_id: "lease-correction",
      worker_id: "worker-1",
      correction_deadline: "2026-08-20T00:15:00.000Z",
      diagnostics: pending.outcome.diagnostics,
      semantic_result_schema: semanticSchema,
      execution_limits: { max_turns: 12, task_timeout_seconds: 600 },
      repository_authority: "inspect",
      tools: ["ot-result"],
      mcp: false,
      provider_access: false,
    };
    const corrected = await executeAttempt({
      request: correction,
      sourceRepoDir: source.repo,
      actionRoot: join(root, "actions"),
      resultPath: join(root, "transport-correction", "result.json"),
      sessionPath: join(root, "transport-correction", "session.json"),
      runAgent: async ({ repositoryPath, phase, timeoutMs }) => {
        expect(phase).toBe("result_correction");
        expect(timeoutMs).toBe(600_000);
        expect(() => writeFileSync(join(repositoryPath, "work.txt"), "rerun\n")).toThrow();
        return {
          status: 0, signal: null, timedOut: false, nativeSessionId: "session-2", stderr: "",
          stdout: claudeOutput("session-2", {
            schema: "openthrottle.result-candidate/v1",
            outcome: "success",
            payload: { summary: "Implemented and verified.", verification: ["tests pass"] },
          }),
        };
      },
      now: () => new Date("2026-08-20T00:01:00.000Z"),
    });
    expect(workLaunches).toBe(1);
    expect(corrected.outcome).toMatchObject({
      state: "work_complete",
      checkpoint: { id: checkpoint.id, output_subject: checkpoint.output_subject },
      result: {
        kind: "semantic",
        candidate: { candidate: { payload: { summary: "Implemented and verified." } } },
      },
    });
    expect(canonicalJson(corrected.outcome.checkpoint)).toBe(canonicalJson(checkpoint));
  });

  it("runs sealed post_bootstrap commands serially before the command within its task timeout", async () => {
    const source = sourceRepository();
    const root = mkdtempSync(join(tmpdir(), "ot-attempt-command-"));
    const request = workRequest(source.subject, {
      action: {
        kind: "command",
        command_id: "test",
        command_line: "npm test",
        post_bootstrap: ["npm ci", "npm run prepare"],
        execution_limits: { max_turns: null, task_timeout_seconds: 120 },
      },
    });
    const calls = [];
    const result = await executeAttempt({
      request,
      sourceRepoDir: source.repo,
      actionRoot: join(root, "actions"),
      resultPath: join(root, "transport", "result.json"),
      sessionPath: join(root, "transport", "session.json"),
      runCommand: async (input) => {
        calls.push(input);
        return { status: 0, signal: null, timedOut: false, stdout: `${input.phase} ok`, stderr: "" };
      },
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(calls.map(({ commandLine, phase, postBootstrapIndex }) => ({
      commandLine, phase, postBootstrapIndex,
    }))).toEqual([
      { commandLine: "npm ci", phase: "post_bootstrap", postBootstrapIndex: 0 },
      { commandLine: "npm run prepare", phase: "post_bootstrap", postBootstrapIndex: 1 },
      { commandLine: "npm test", phase: "command", postBootstrapIndex: null },
    ]);
    expect(calls.every(({ timeoutMs }) => timeoutMs === 120_000)).toBe(true);
    expect(result.outcome).toMatchObject({
      state: "work_complete",
      result: { kind: "command", outcome: "success", command_id: "test" },
    });
  });

  it("rejects a correction result returned after its sealed deadline", async () => {
    const source = sourceRepository();
    const root = mkdtempSync(join(tmpdir(), "ot-attempt-correction-deadline-"));
    const request = workRequest(source.subject);
    const pending = await executeAttempt({
      request,
      sourceRepoDir: source.repo,
      actionRoot: join(root, "actions"),
      resultPath: join(root, "transport-work", "result.json"),
      sessionPath: join(root, "transport-work", "session.json"),
      runAgent: async ({ onSession }) => {
        await onSession("session-deadline");
        return {
          status: 0, signal: null, timedOut: false, nativeSessionId: "session-deadline", stderr: "",
          stdout: claudeOutput("session-deadline", {
            schema: "openthrottle.result-candidate/v1",
            outcome: "success",
            payload: { summary: ["invalid", 7], verification: ["tests pass"] },
          }),
        };
      },
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });
    const checkpoint = pending.outcome.checkpoint;
    const deadline = "2026-08-20T00:15:00.000Z";
    const correction = {
      schema: "openthrottle.kernel-result-correction-request/v2",
      phase: "result_correction",
      engine: "claude",
      model: null,
      reasoning_effort: null,
      pipeline_run_id: request.pipeline_run_id,
      attempt_id: request.attempt_id,
      stage_id: request.stage_id,
      scope: request.scope,
      request_hash: request.request_hash,
      definition_bundle_hash: request.definition_bundle_hash,
      input_subject: request.input_subject,
      locked_subject: checkpoint.output_subject,
      completed_work_authority: "edit",
      checkpoint_id: checkpoint.id,
      native_session_id: "session-deadline",
      lease_id: "lease-correction",
      worker_id: "worker-1",
      correction_deadline: deadline,
      diagnostics: pending.outcome.diagnostics,
      semantic_result_schema: semanticSchema,
      execution_limits: { max_turns: 12, task_timeout_seconds: 900 },
      repository_authority: "inspect",
      tools: ["ot-result"],
      mcp: false,
      provider_access: false,
    };
    const times = [
      new Date("2026-08-20T00:01:00.000Z"),
      new Date("2026-08-20T00:01:00.000Z"),
      new Date(deadline),
    ];
    const corrected = await executeAttempt({
      request: correction,
      sourceRepoDir: source.repo,
      actionRoot: join(root, "actions"),
      resultPath: join(root, "transport-correction", "result.json"),
      sessionPath: join(root, "transport-correction", "session.json"),
      runAgent: async ({ timeoutMs }) => {
        expect(timeoutMs).toBe(840_000);
        return {
          status: 0, signal: null, timedOut: false, nativeSessionId: "session-deadline", stderr: "",
          stdout: claudeOutput("session-deadline", {
            schema: "openthrottle.result-candidate/v1",
            outcome: "success",
            payload: { summary: "too late", verification: ["tests pass"] },
          }),
        };
      },
      now: () => times.shift() ?? new Date(deadline),
    });

    expect(corrected.outcome).toMatchObject({
      state: "needs_human",
      reason: "result correction deadline exhausted",
      checkpoint: { id: checkpoint.id },
    });
  });
});
