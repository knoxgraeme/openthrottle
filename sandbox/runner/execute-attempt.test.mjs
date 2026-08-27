import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  digestCanonicalJson,
  RESULT_CANDIDATE_MAX_BYTES,
} from "./generated-result-contracts.mjs";
import { runPreparedAgent as runPreparedAgentRuntime } from "./agent-runtime.mjs";
import { executeAttempt, validateKernelRequest } from "./execute-attempt.mjs";
import { extractProviderResultCandidate } from "./result-submission.mjs";

const semanticSchema = {
  schema: "openthrottle.semantic-result-schema/v1",
  id: "core/unit-result",
  outcomes: ["success", "failure", "needs_human"],
  payload: {
    summary: {
      type: "string",
      max_length: 4_000,
      normalize: "string-array-to-newlines/v1",
    },
    verification: {
      type: "string_list",
      max_length: 1_000,
      max_items: 32,
    },
  },
};

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function makeTreeOwnerWritable(path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) return;
  chmodSync(path, metadata.mode | (metadata.isDirectory() ? 0o700 : 0o600));
  if (metadata.isDirectory()) {
    for (const entry of readdirSync(path)) makeTreeOwnerWritable(join(path, entry));
  }
}

function sourceRepository() {
  const repo = mkdtempSync(join(tmpdir(), "ot-attempt-source-"));
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(join(repo, "work.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "base");
  return { repo, subject: git(repo, "rev-parse", "HEAD") };
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
    checkpoint_base_subject: subject,
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

async function executeAgentResult({ execution, env, runAgent, runPreparedAgent, engine = "claude" }) {
  const source = sourceRepository();
  const root = mkdtempSync(join(tmpdir(), "ot-attempt-agent-result-"));
  const resultPath = join(root, "transport", "result.json");
  const request = workRequest(source.subject);
  request.action = {
    ...request.action,
    engine,
    execution_limits: {
      ...request.action.execution_limits,
      max_turns: engine === "claude" ? request.action.execution_limits.max_turns : null,
    },
  };
  const result = await executeAttempt({
    request,
    sourceRepoDir: source.repo,
    actionRoot: join(root, "actions"),
    resultPath,
    sessionPath: join(root, "transport", "session.json"),
    runAgent: runAgent ?? (execution === undefined ? null : async () => execution),
    runPreparedAgent,
    env,
    now: () => new Date("2026-08-20T00:00:00.000Z"),
  });
  return { result, persisted: readFileSync(resultPath, "utf8") };
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

  it("persists bounded provider metadata without raw launch transcript content", async () => {
    const secret = "fixture-claude-oauth-secret";
    const rateLimit = JSON.stringify({
      type: "system",
      subtype: "rate_limit_event",
      rate_limit: { status: "rejected" },
    });
    const { result, persisted } = await executeAgentResult({
      env: { CLAUDE_CODE_OAUTH_TOKEN: secret },
      execution: {
        status: 1,
        signal: null,
        timedOut: false,
        nativeSessionId: null,
        stdout: `${"x".repeat(4_000)}\n${rateLimit}\nusage limit reached for ${secret}`,
        stderr: "",
      },
    });

    expect(result.outcome).toMatchObject({ state: "work_failed", retryable: true });
    expect(result.outcome.reason).toContain("reason=rate_limited");
    expect(result.outcome.reason).toContain("status=1, signal=none, timed_out=false");
    expect(result.outcome.reason).toContain("provider_event=system");
    expect(result.outcome.reason).toContain("rate_limit_status=rejected");
    expect(result.outcome.reason).not.toContain("stdout:");
    expect(result.outcome.reason).not.toContain("usage limit reached");
    expect(result.outcome.reason.length).toBeLessThanOrEqual(1_500);
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain("[REDACTED]");
  });

  it("persists a bounded sanitized retryable failure when agent launch throws", async () => {
    const secret = "fixture-thrown-launch-secret";
    const { result, persisted } = await executeAgentResult({
      env: { CLAUDE_CODE_OAUTH_TOKEN: secret },
      runAgent: async () => {
        throw new Error(`spawn failed ${"x".repeat(3_000)} executor launch tail ${secret}`);
      },
    });

    expect(result.outcome).toMatchObject({ state: "work_failed", retryable: true });
    expect(result.outcome.reason).toContain("agent work launch failed");
    expect(result.outcome.reason).toContain("reason=executor_launch_failure");
    expect(result.outcome.reason).toContain("Executor diagnostic: runtime_error=spawn_failure");
    expect(result.outcome.reason).not.toContain("executor launch tail");
    expect(result.outcome.reason.length).toBeLessThanOrEqual(1_500);
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain("[REDACTED]");
  });

  it("keeps deterministic prepared-runtime failures non-retryable", async () => {
    const secret = "fixture-profile-seal-secret";
    const { result, persisted } = await executeAgentResult({
      env: {
        PATH: process.env.PATH,
        CLAUDE_CODE_OAUTH_TOKEN: secret,
        OT_LEASE_GENERATION_FENCE_FILE: "/tmp/fixture-lease-generation.json",
        OT_LEASE_GENERATION_LOCK_FILE: "/tmp/fixture-lease-generation.lock",
      },
      runPreparedAgent: async () => {
        throw new Error(`agent changed the executor-sealed action profile: ${secret}`);
      },
    });

    expect(result.outcome).toMatchObject({ state: "work_failed", retryable: false });
    expect(result.outcome.reason).toContain("reason=executor_runtime_failure");
    expect(result.outcome.reason.length).toBeLessThanOrEqual(1_500);
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain("[REDACTED]");
  });

  it("retries only marked prepared-runtime launch failures", async () => {
    const launchFailure = new Error("child process transport failed");
    Object.defineProperty(launchFailure, "retryableInfrastructureFailure", { value: true });
    const { result } = await executeAgentResult({
      env: {
        PATH: process.env.PATH,
        CLAUDE_CODE_OAUTH_TOKEN: "fixture-present-token",
        OT_LEASE_GENERATION_FENCE_FILE: "/tmp/fixture-lease-generation.json",
        OT_LEASE_GENERATION_LOCK_FILE: "/tmp/fixture-lease-generation.lock",
      },
      runPreparedAgent: async () => {
        throw launchFailure;
      },
    });

    expect(result.outcome).toMatchObject({ state: "work_failed", retryable: true });
    expect(result.outcome.reason).toContain("reason=executor_launch_failure");
  });

  it("redacts nested Codex tokens when agent launch throws", async () => {
    const accessToken = "nested-codex-access-token";
    const idToken = "nested-codex-id-token";
    const authJson = JSON.stringify({ tokens: { access_token: accessToken, id_token: idToken } });
    const { result, persisted } = await executeAgentResult({
      engine: "codex",
      env: { CODEX_AUTH_JSON: authJson },
      runAgent: async () => {
        throw new Error(`child launch exposed ${accessToken} and ${idToken}`);
      },
    });

    expect(result.outcome).toMatchObject({ state: "work_failed", retryable: true });
    expect(result.outcome.reason).toContain("reason=executor_launch_failure");
    expect(persisted).not.toContain(accessToken);
    expect(persisted).not.toContain(idToken);
    expect(persisted).not.toContain("[REDACTED]");
  });

  it("keeps deterministic Codex preparation errors non-retryable", async () => {
    const { result } = await executeAgentResult({
      engine: "codex",
      env: { CODEX_AUTH_JSON: "{malformed-json" },
    });

    expect(result.outcome).toMatchObject({ state: "work_failed", retryable: false });
    expect(result.outcome.reason).toContain("reason=executor_preparation_failure");
    expect(result.outcome.reason.length).toBeLessThanOrEqual(1_500);
  });

  it("classifies a missing engine credential by variable name only", async () => {
    const { result } = await executeAgentResult({
      env: {},
      execution: {
        status: 1,
        signal: null,
        timedOut: false,
        nativeSessionId: null,
        stdout: "",
        stderr: "",
      },
    });

    expect(result.outcome).toMatchObject({ state: "work_failed", retryable: true });
    expect(result.outcome.reason).toContain("reason=credential_missing");
    expect(result.outcome.reason).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(result.outcome.reason).toContain("status=1, signal=none, timed_out=false");
  });

  it("keeps an ordinary engine crash diagnostic non-retryable", async () => {
    const { result } = await executeAgentResult({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-present-token" },
      execution: {
        status: 1,
        signal: null,
        timedOut: false,
        nativeSessionId: null,
        stdout: "",
        stderr: "Bus error: 10",
      },
    });

    expect(result.outcome).toMatchObject({ state: "work_failed", retryable: false });
    expect(result.outcome.reason).toContain("reason=engine_crash");
    expect(result.outcome.reason).toContain("status=1, signal=none, timed_out=false");
    expect(result.outcome.reason).toContain("runtime_error=process_crash");
    expect(result.outcome.reason).not.toContain("Bus error: 10");
  });

  it("treats a clean unregistered-command answer as retryable failed work", async () => {
    const { result } = await executeAgentResult({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-present-token" },
      execution: {
        status: 0,
        signal: null,
        timedOut: false,
        nativeSessionId: "session-unregistered",
        stdout: JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Unknown command: /implement-plan",
        }),
        stderr: "",
      },
    });

    expect(result.outcome).toMatchObject({ state: "work_failed", retryable: true });
    expect(result.outcome.reason).toContain("reason=unregistered_command");
    expect(result.outcome.reason).toContain("status=0, signal=none, timed_out=false");
  });

  it("keeps a clean exit without a native session retryable", async () => {
    const { result } = await executeAgentResult({
      env: { CLAUDE_CODE_OAUTH_TOKEN: "fixture-present-token" },
      execution: {
        status: 0,
        signal: null,
        timedOut: false,
        nativeSessionId: null,
        stdout: "completed without a session event",
        stderr: "",
      },
    });

    expect(result.outcome).toEqual({
      state: "work_failed",
      retryable: true,
      reason: "agent completed without a native session binding",
    });
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

  it("seals only each Codex action's final-message channel across sequential sandbox actions", async () => {
    const source = sourceRepository();
    const root = mkdtempSync(join(tmpdir(), "ot-attempt-sequential-results-"));
    const actionRoot = join(root, "actions");
    const candidates = [
      {
        schema: "openthrottle.result-candidate/v1",
        outcome: "success",
        payload: { summary: "first action", verification: ["first proof"] },
      },
      {
        schema: "openthrottle.result-candidate/v1",
        outcome: "success",
        payload: { summary: "second action", verification: ["second proof"] },
      },
    ];
    const agentMessage = (value) => JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(value) },
    });
    const contaminatedSecondTranscript = [agentMessage(candidates[0]), agentMessage(candidates[1])].join("\n");
    const codexAction = {
      ...workRequest(source.subject).action,
      engine: "codex",
      execution_limits: { max_turns: null, task_timeout_seconds: 600 },
    };

    // This is the live failure shape: the JSONL event stream contains two
    // genuinely different schema-valid messages and is therefore ambiguous.
    expect(extractProviderResultCandidate(contaminatedSecondTranscript, "codex")).toMatchObject({
      status: "invalid",
      diagnostics: [{ detail: "provider emitted conflicting final result candidates" }],
    });

    const results = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const attemptId = `attempt-${index + 1}`;
      const request = workRequest(source.subject, {
        attempt_id: attemptId,
        request_hash: String(index + 1).repeat(64),
        lease_id: `lease-${index + 1}`,
        action: codexAction,
      });
      const resultDirectory = join(root, "action-results", attemptId, request.lease_id);
      const transcript = index === 0 ? agentMessage(candidates[0]) : contaminatedSecondTranscript;
      results.push(await executeAttempt({
        request,
        sourceRepoDir: source.repo,
        actionRoot,
        resultPath: join(resultDirectory, "result.json"),
        sessionPath: join(resultDirectory, "session.json"),
        env: {
          OT_LEASE_GENERATION_FENCE_FILE: join(root, "lease-generation.json"),
          OT_LEASE_GENERATION_LOCK_FILE: join(root, "lease-generation.lock"),
        },
        runPreparedAgent: async (runtime) => runPreparedAgentRuntime({
          ...runtime,
          runStreaming: async ({ onSession }) => {
            expect(existsSync(runtime.prepared.providerFinalPath)).toBe(false);
            if (index === 0) {
              writeFileSync(runtime.prepared.providerFinalPath, canonicalJson(candidates[index]));
            }
            await onSession(`session-${index + 1}`);
            return {
              status: 0,
              signal: null,
              timedOut: false,
              nativeSessionId: `session-${index + 1}`,
              stderr: "",
              stdout: transcript,
            };
          },
        }),
        now: () => new Date(`2026-08-20T00:00:0${index}.000Z`),
      }));
      if (index === 0 && typeof process.getuid === "function" && process.getuid() !== 0) {
        // Production reclamation runs in the root executor. Let this
        // unprivileged host test model that capability before action two.
        makeTreeOwnerWritable(join(actionRoot, attemptId));
      }
    }

    expect(results.map((result) => result.outcome)).toEqual([
      expect.objectContaining({
        state: "work_complete",
        result: expect.objectContaining({
          candidate: expect.objectContaining({
            candidate: expect.objectContaining({ payload: expect.objectContaining({ summary: "first action" }) }),
          }),
        }),
      }),
      expect.objectContaining({
        state: "work_complete",
        result: expect.objectContaining({
          candidate: expect.objectContaining({
            candidate: expect.objectContaining({ payload: expect.objectContaining({ summary: "second action" }) }),
          }),
        }),
      }),
    ]);
  });

  it.each(["oversized", "non-regular"])(
    "preserves completed Codex work when its provider-final file is %s",
    async (unsafeFile) => {
      const source = sourceRepository();
      const root = mkdtempSync(join(tmpdir(), "ot-attempt-unsafe-provider-final-"));
      const candidate = {
        schema: "openthrottle.result-candidate/v1",
        outcome: "success",
        payload: { summary: "completed work", verification: ["focused proof"] },
      };
      const request = workRequest(source.subject, {
        action: {
          ...workRequest(source.subject).action,
          engine: "codex",
          execution_limits: { max_turns: null, task_timeout_seconds: 600 },
        },
      });
      const result = await executeAttempt({
        request,
        sourceRepoDir: source.repo,
        actionRoot: join(root, "actions"),
        resultPath: join(root, "action-results", "result.json"),
        sessionPath: join(root, "action-results", "session.json"),
        env: {
          OT_LEASE_GENERATION_FENCE_FILE: join(root, "lease-generation.json"),
          OT_LEASE_GENERATION_LOCK_FILE: join(root, "lease-generation.lock"),
        },
        runPreparedAgent: async (runtime) => runPreparedAgentRuntime({
          ...runtime,
          runStreaming: async ({ onSession }) => {
            if (unsafeFile === "oversized") {
              writeFileSync(
                runtime.prepared.providerFinalPath,
                Buffer.alloc(RESULT_CANDIDATE_MAX_BYTES + 1, "x"),
              );
            } else {
              mkdirSync(runtime.prepared.providerFinalPath);
            }
            await onSession("session-unsafe-provider-final");
            return {
              status: 0,
              signal: null,
              timedOut: false,
              nativeSessionId: "session-unsafe-provider-final",
              stderr: "",
              stdout: JSON.stringify({
                type: "item.completed",
                item: { type: "agent_message", text: canonicalJson(candidate) },
              }),
              providerFinalOutputFallback: canonicalJson(candidate),
            };
          },
        }),
        now: () => new Date("2026-08-20T00:00:00.000Z"),
      });

      expect(result.outcome).toMatchObject({
        state: "result_pending",
        checkpoint: expect.objectContaining({ native_session_id: "session-unsafe-provider-final" }),
        candidate_hash: null,
        diagnostics: [{ detail: "provider did not emit a final result candidate" }],
      });
    },
  );

  it("reclaims settled sibling scratch before dispatching the next action", async () => {
    const source = sourceRepository();
    const root = mkdtempSync(join(tmpdir(), "ot-attempt-reclaim-start-"));
    const request = workRequest(source.subject, {
      attempt_id: "attempt-current",
      request_hash: "c".repeat(64),
    });
    const actionRoot = join(root, "actions");
    const requestPath = join(root, "action-input", request.attempt_id, "work-lease", "request.json");
    const resultPath = join(root, "action-results", request.attempt_id, "work-lease", "result.json");
    const sessionPath = join(root, "action-results", request.attempt_id, "work-lease", "session.json");
    const fencePath = join(root, "action-fences", request.attempt_id, "lease-generation.json");
    const priorPaths = [
      join(actionRoot, "attempt-prior", "home", ".npm", "cache.bin"),
      join(root, "action-input", "attempt-prior", "work-lease", "request.json"),
      join(root, "action-results", "attempt-prior", "work-lease", "result.json"),
      join(root, "action-fences", "attempt-prior", "lease-generation.json"),
    ];
    for (const path of [...priorPaths, requestPath, fencePath]) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "scratch");
    }
    const summaries = [];

    await executeAttempt({
      request,
      sourceRepoDir: source.repo,
      actionRoot,
      requestPath,
      resultPath,
      sessionPath,
      env: { OT_LEASE_GENERATION_FENCE_FILE: fencePath },
      reclamationLog: (summary) => summaries.push(summary),
      runAgent: async ({ onSession }) => {
        expect(priorPaths.every((path) => !existsSync(path))).toBe(true);
        expect(readFileSync(requestPath, "utf8")).toBe("scratch");
        expect(readFileSync(fencePath, "utf8")).toBe("scratch");
        expect(readFileSync(join(source.repo, "work.txt"), "utf8")).toBe("base\n");
        await onSession("session-reclaimed");
        return {
          status: 0,
          signal: null,
          timedOut: false,
          nativeSessionId: "session-reclaimed",
          stderr: "",
          stdout: claudeOutput("session-reclaimed", {
            schema: "openthrottle.result-candidate/v1",
            outcome: "success",
            payload: { summary: "Reclaimed prior scratch.", verification: ["scratch bounded"] },
          }),
        };
      },
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatch(/from 4 settled-attempt directories$/);
    expect(readFileSync(requestPath, "utf8")).toBe("scratch");
    expect(readFileSync(fencePath, "utf8")).toBe("scratch");
    expect(existsSync(resultPath)).toBe(true);
    expect(existsSync(sessionPath)).toBe(true);
  });

  it("supplies inspect agents the bounded exact-boundary artifact without repository mutation", async () => {
    const source = sourceRepository();
    const before = source.subject;
    writeFileSync(join(source.repo, "work.txt"), "accepted edit\n");
    writeFileSync(join(source.repo, "added.txt"), "added\n");
    git(source.repo, "add", ".");
    git(source.repo, "commit", "--quiet", "-m", "accepted edit");
    const after = git(source.repo, "rev-parse", "HEAD");
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

  it("launches a dependent structured unit with exact integration evidence", async () => {
    const source = sourceRepository();
    const root = mkdtempSync(join(tmpdir(), "ot-attempt-action-context-"));
    const request = workRequest(source.subject, {
      stage_id: "implement_unit",
      scope: {
        kind: "loop_item",
        stage_id: "implement_unit",
        parent_attempt_id: "attempt-parent-private",
        loop_id: "execution_plan.units",
        item_id: "unit-b",
        item_index: 1,
      },
      context: {
        records: [{
          schema: "openthrottle.record/v1",
          id: "result-integration-unit-a",
          kind: "result",
          pipeline_run_id: "run-1",
          attempt_id: "attempt-integration-private",
          request_hash: "c".repeat(64),
          definition_bundle_hash: "b".repeat(64),
          input_subject: "a".repeat(40),
          output_subject: source.subject,
          original_candidate_hash: "d".repeat(64),
          normalized_candidate_hash: "d".repeat(64),
          payload_schema: "openthrottle.external-result-record/v1",
          payload: { inline: {
            schema: "openthrottle.external-result-record/v1",
            external_kind: "core/integrate-unit@1",
            outcome: "all_integrated",
            summary: "unit checkpoint integrated and durably pushed",
            delivery_record_ids: [
              "delivery-integrate-private",
              "delivery-push-private",
            ],
          } },
          created_at: "2026-08-20T00:00:00.000Z",
        }, {
          schema: "openthrottle.record/v1",
          id: "decision-integration-unit-a",
          kind: "decision",
          pipeline_run_id: "run-1",
          reducer: "external/core/integrate-unit@1",
          input_record_ids: [
            "delivery-integrate-private",
            "delivery-push-private",
            "result-integration-unit-a",
          ],
          payload_schema: "openthrottle.pipeline-decision-record/v1",
          payload: { inline: {
            schema: "openthrottle.pipeline-decision-record/v1",
            stage_id: "integrate_unit",
            evaluator: "external/core/integrate-unit@1",
            outcome: "all_integrated",
            reason: "unit checkpoint integrated and durably pushed",
          } },
          created_at: "2026-08-20T00:00:00.000Z",
        }],
        checkpoints: [{
          schema: "openthrottle.attempt-checkpoint/v1",
          id: "checkpoint-integration-unit-a",
          pipeline_run_id: "run-1",
          attempt_id: "attempt-integration-private",
          request_hash: "c".repeat(64),
          definition_bundle_hash: "b".repeat(64),
          input_subject: "a".repeat(40),
          output_subject: source.subject,
          native_session_id: null,
          payload_schema: "openthrottle.git-checkpoint-bundle/v1",
          payload: { blob: {
            algorithm: "sha256",
            digest: "e".repeat(64),
            bytes: 123,
            encoding: "binary",
            media_type: "application/x-git-bundle",
            payload_schema: "openthrottle.git-checkpoint-bundle/v1",
          } },
          captured_at: "2026-08-20T00:00:00.000Z",
        }],
      },
    });
    let descriptor;
    const result = await executeAttempt({
      request,
      sourceRepoDir: source.repo,
      actionRoot: join(root, "actions"),
      resultPath: join(root, "transport", "result.json"),
      sessionPath: join(root, "transport", "session.json"),
      runAgent: async ({ request: runtimeRequest, onSession }) => {
        descriptor = runtimeRequest.action_context_artifact;
        const artifact = JSON.parse(readFileSync(descriptor.path, "utf8"));
        expect(artifact.scope).toEqual({
          kind: "loop_item",
          loop_id: "execution_plan.units",
          item_id: "unit-b",
          item_index: 1,
        });
        expect(artifact.records).toContainEqual({
          record_id: "result-integration-unit-a",
          kind: "external_result",
          external_kind: "core/integrate-unit@1",
          outcome: "all_integrated",
          summary: "unit checkpoint integrated and durably pushed",
        });
        expect(artifact.records).toContainEqual({
          record_id: "decision-integration-unit-a",
          kind: "pipeline_decision",
          stage_id: "integrate_unit",
          evaluator: "external/core/integrate-unit@1",
          outcome: "all_integrated",
          reason: "unit checkpoint integrated and durably pushed",
        });
        expect(artifact.checkpoints).toEqual([{
          checkpoint_id: "checkpoint-integration-unit-a",
          input_subject: "a".repeat(40),
          output_subject: source.subject,
        }]);
        const serialized = readFileSync(descriptor.path, "utf8");
        expect(serialized).not.toContain("attempt-parent-private");
        expect(serialized).not.toContain("attempt-integration-private");
        expect(serialized).not.toContain("delivery-integrate-private");
        expect(serialized).not.toContain("delivery-push-private");
        expect(serialized).not.toContain("e".repeat(64));
        await onSession("session-action-context");
        return {
          status: 0,
          signal: null,
          timedOut: false,
          nativeSessionId: "session-action-context",
          stderr: "",
          stdout: claudeOutput("session-action-context", {
            schema: "openthrottle.result-candidate/v1",
            outcome: "success",
            payload: {
              summary: "Used the supplied dependency context.",
              verification: ["action context inspected"],
            },
          }),
        };
      },
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(result.outcome.state).toBe("work_complete");
    expect(descriptor).toMatchObject({
      schema: "openthrottle.agent-action-context/v1",
      bytes: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("stops for human review instead of launching with silently truncated semantic context", async () => {
    const source = sourceRepository();
    const root = mkdtempSync(join(tmpdir(), "ot-attempt-oversized-context-"));
    const records = Array.from({ length: 10 }, (_, index) => ({
      schema: "openthrottle.record/v1",
      id: `result-upstream-${index}`,
      kind: "result",
      pipeline_run_id: "run-1",
      attempt_id: `attempt-upstream-${index}`,
      request_hash: "c".repeat(64),
      definition_bundle_hash: "b".repeat(64),
      input_subject: source.subject,
      output_subject: source.subject,
      original_candidate_hash: "d".repeat(64),
      normalized_candidate_hash: "d".repeat(64),
      payload_schema: "openthrottle.semantic-result-record/v1",
      payload: { inline: {
        schema: "openthrottle.semantic-result-record/v1",
        semantic_schema_id: "core/unit-result",
        outcome: "success",
        payload: { summary: `${index}:${"x".repeat(60 * 1024)}` },
        transformations: [],
      } },
      created_at: "2026-08-20T00:00:00.000Z",
    }));
    let launches = 0;

    const result = await executeAttempt({
      request: workRequest(source.subject, {
        context: { records, checkpoints: [] },
      }),
      sourceRepoDir: source.repo,
      actionRoot: join(root, "actions"),
      resultPath: join(root, "transport", "result.json"),
      sessionPath: join(root, "transport", "session.json"),
      runAgent: async () => { launches += 1; },
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(launches).toBe(0);
    expect(result.outcome).toMatchObject({
      state: "needs_human",
      reason: "required semantic action context could not be materialized",
      checkpoint: null,
      diagnostics: [{
        path: "context",
        detail: expect.stringContaining("action context artifact exceeds 524288 bytes"),
      }],
    });
  });

  it("reverifies the action context seal when recovering completed engine state", async () => {
    const source = sourceRepository();
    const root = mkdtempSync(join(tmpdir(), "ot-attempt-context-recovery-"));
    const resultPath = join(root, "transport", "result.json");
    const options = {
      request: workRequest(source.subject),
      sourceRepoDir: source.repo,
      actionRoot: join(root, "actions"),
      resultPath,
      sessionPath: join(root, "transport", "session.json"),
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    };
    let launches = 0;
    let descriptor;
    const runAgent = async ({ request: runtimeRequest, onSession }) => {
      launches += 1;
      descriptor = runtimeRequest.action_context_artifact;
      await onSession("session-context-recovery");
      return {
        status: 0,
        signal: null,
        timedOut: false,
        nativeSessionId: "session-context-recovery",
        stderr: "",
        stdout: claudeOutput("session-context-recovery", {
          schema: "openthrottle.result-candidate/v1",
          outcome: "success",
          payload: {
            summary: "Completed before transport interruption.",
            verification: ["focused proof passed"],
          },
        }),
      };
    };
    expect((await executeAttempt({ ...options, runAgent })).outcome.state).toBe("work_complete");
    rmSync(resultPath);
    chmodSync(descriptor.path, 0o644);
    writeFileSync(descriptor.path, "{}\n");
    chmodSync(descriptor.path, 0o444);

    const recovered = await executeAttempt({
      ...options,
      runAgent: async () => { launches += 1; throw new Error("must not relaunch"); },
    });

    expect(launches).toBe(1);
    expect(recovered.outcome).toMatchObject({
      state: "work_failed",
      retryable: false,
      reason: expect.stringMatching(/action context artifact (lost its executor-owned read-only seal|content changed)/),
    });
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
      checkpoint_base_subject: request.checkpoint_base_subject,
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

  it("lets a sealed command read Git metadata from only its exact action repository", async () => {
    const source = sourceRepository();
    const root = mkdtempSync(join(tmpdir(), "ot-attempt-command-git-"));
    const request = workRequest(source.subject, {
      action: {
        kind: "command",
        command_id: "git-metadata",
        command_line: [
          'test "$GIT_CONFIG_COUNT" = 1',
          'test "$GIT_CONFIG_KEY_0" = safe.directory',
          'test -n "$GIT_CONFIG_VALUE_0"',
          'test "$GIT_CONFIG_NOSYSTEM" = 1',
          'test "$GIT_CONFIG_GLOBAL" = /dev/null',
          'test "$GIT_OPTIONAL_LOCKS" = 0',
          'test "$GIT_TERMINAL_PROMPT" = 0',
          'test "$(git config --get-all safe.directory)" = "$GIT_CONFIG_VALUE_0"',
          'git rev-parse --verify HEAD >/dev/null',
        ].join(" && "),
        post_bootstrap: [],
        execution_limits: { max_turns: null, task_timeout_seconds: 120 },
      },
    });

    const result = await executeAttempt({
      request,
      sourceRepoDir: source.repo,
      actionRoot: join(root, "actions"),
      resultPath: join(root, "transport", "result.json"),
      sessionPath: join(root, "transport", "session.json"),
      now: () => new Date("2026-08-20T00:00:00.000Z"),
    });

    expect(result.outcome).toMatchObject({
      state: "work_complete",
      result: {
        kind: "command",
        outcome: "success",
        command_id: "git-metadata",
        exit_code: 0,
      },
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
      checkpoint_base_subject: request.checkpoint_base_subject,
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
