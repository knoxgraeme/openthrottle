#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "./capabilities.mjs";
import { digest, sanitizeArtifactText } from "./artifacts.mjs";
import { computeWorkspaceTreeOid } from "./repository-control.mjs";
import { runCapturedProcess } from "./bounded-process.mjs";
import { worktreePath } from "./worktrees.mjs";

export const LOOP_ACTION_PROTOCOL = "loop-action@1";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const AGENTS = new Set(["claude", "codex", "opencode"]);
const ROLES = new Set(["worker", "lead", "reviewer", "publisher"]);
const LOOPS = new Set(["implement", "simplify", "command", "repair", "lead", "review", "publish"]);
const SKILLS = new Set([
  "implement-plan",
  "investigate",
  "implement-unit",
  "simplify-unit",
  "repair-unit",
  "accept-unit",
  "final-review",
  "final-repair",
  "publish",
  "ce-work",
  "ce-simplify-code",
  "ce-code-review",
  "ce-commit-push-pr",
]);
const CONTEXTS = new Set(["fresh", "resume_required", "prefer_resume"]);

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function string(value, label, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function nullableString(value, label, pattern = ID) {
  return value === null ? null : string(value, label, pattern);
}

function boundedText(value, label, maxLength) {
  if (typeof value !== "string" || value.length > maxLength) throw new Error(`${label} is invalid`);
  return value;
}

function boundedArray(value, label, max = 32) {
  if (!Array.isArray(value) || value.length > max || new Set(value).size !== value.length ||
      value.some((entry) => typeof entry !== "string" || entry.length > 160)) {
    throw new Error(`${label} must be a bounded unique string array`);
  }
  return [...value].sort();
}

export function createLoopRequestHash(requestWithoutFence) {
  const requestHash = digest(canonicalJson(requestWithoutFence));
  return {
    requestHash,
    idempotencyKey: `loop:${requestWithoutFence.attemptId}:${requestWithoutFence.actionId}:${requestHash}`,
  };
}

export function validateLoopRequest(value) {
  const input = record(value, "loop request");
  const allowed = new Set([
    "protocol", "actionId", "attemptId", "graphId", "unitId", "role", "loop",
    "agent", "skill", "worktree", "nativeSessionId", "contextPolicy", "timeoutMs",
    "transitionContext", "allowedMcpServers", "credentialScopes", "receiptSchema",
    "requestHash", "idempotencyKey",
  ]);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`loop request has unknown field ${unknown}`);
  if (input.protocol !== LOOP_ACTION_PROTOCOL) throw new Error("loop request protocol is unsupported");
  const worktree = input.worktree === null ? null : record(input.worktree, "worktree");
  const request = {
    protocol: LOOP_ACTION_PROTOCOL,
    actionId: string(input.actionId, "actionId"),
    attemptId: string(input.attemptId, "attemptId"),
    graphId: string(input.graphId, "graphId"),
    unitId: nullableString(input.unitId, "unitId"),
    role: string(input.role, "role"),
    loop: string(input.loop, "loop"),
    agent: string(input.agent, "agent"),
    skill: string(input.skill, "skill", /^[a-z][a-z0-9-]{0,79}$/),
    worktree: worktree === null ? null : {
      id: string(worktree.id, "worktree.id", /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
      ...(worktree.path === undefined ? {} : { path: string(worktree.path, "worktree.path", /^\/[^\u0000]{1,500}$/) }),
    },
    nativeSessionId: nullableString(input.nativeSessionId, "nativeSessionId"),
    contextPolicy: string(input.contextPolicy, "contextPolicy"),
    timeoutMs: input.timeoutMs,
    transitionContext: boundedText(input.transitionContext, "transitionContext", 64_000),
    allowedMcpServers: boundedArray(input.allowedMcpServers, "allowedMcpServers"),
    credentialScopes: boundedArray(input.credentialScopes, "credentialScopes"),
    receiptSchema: string(input.receiptSchema, "receiptSchema", /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/),
  };
  if (!ROLES.has(request.role)) throw new Error("role is invalid");
  if (!LOOPS.has(request.loop)) throw new Error("loop is invalid");
  if (!AGENTS.has(request.agent)) throw new Error("agent is invalid");
  if (!SKILLS.has(request.skill)) throw new Error("skill is not installed for loop dispatch");
  if (!CONTEXTS.has(request.contextPolicy)) throw new Error("contextPolicy is invalid");
  if (request.contextPolicy === "resume_required" && !request.nativeSessionId) {
    throw new Error("resume-required loop request is missing its native session");
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1_000 || request.timeoutMs > 86_400_000) {
    throw new Error("timeoutMs is invalid");
  }
  if (request.role === "worker" && !request.worktree) throw new Error("worker loop requires a worktree");
  if (request.role !== "worker" && request.worktree) throw new Error("non-worker loop cannot receive a writable worktree");
  const expected = createLoopRequestHash(request);
  if (input.requestHash !== expected.requestHash || input.idempotencyKey !== expected.idempotencyKey) {
    throw new Error("loop request hash or idempotency key is stale");
  }
  return { ...request, ...expected };
}

export function loopWorktreeDirectory(request) {
  if (!request.worktree) return null;
  return request.worktree.path ?? worktreePath({ handle: request.worktree.id });
}

export function resolveLoopInvocation(request) {
  if (request.contextPolicy === "fresh") return { mode: "fresh", nativeSessionId: null };
  if (request.contextPolicy === "resume_required") return { mode: "resume", nativeSessionId: request.nativeSessionId };
  return request.nativeSessionId
    ? { mode: "resume", nativeSessionId: request.nativeSessionId }
    : { mode: "fresh", nativeSessionId: null };
}

export function loopPrompt(request) {
  const prefix = request.agent === "claude" ? "/" : "$";
  return `${prefix}${request.skill}\n\n` +
    `This is one fenced OpenThrottle loop action (${request.actionId}) for ${request.role}/${request.loop}. ` +
    `Edit only the provided worktree when one is present. Do not commit, push, or alter executor state. ` +
    `Return one receipt matching ${request.receiptSchema}.\n\n${request.transitionContext}`;
}

export function loopAgentCommand({ request, invocation }) {
  const repoDir = loopWorktreeDirectory(request) ?? "/home/agent/repo";
  const prompt = loopPrompt(request);
  const command = request.agent === "codex" ? "codex" : request.agent;
  const args = request.agent === "codex"
    ? ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-C", repoDir, ...(invocation.mode === "resume" ? ["resume", invocation.nativeSessionId, prompt] : ["-"])]
    : request.agent === "claude"
      ? ["-p", ...(invocation.mode === "resume" ? ["--resume", invocation.nativeSessionId] : []), prompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"]
      : ["run", "--format", "json", "--dir", repoDir, "--auto", ...(invocation.mode === "resume" ? ["--session", invocation.nativeSessionId] : []), prompt];
  return {
    repoDir,
    command,
    args,
    input: request.agent === "codex" && invocation.mode !== "resume" ? prompt : undefined,
  };
}

function defaultRunLoopAgent({ request, invocation }) {
  const built = loopAgentCommand({ request, invocation });
  return runCapturedProcess("gosu", ["agent", "env", "HOME=/home/agent", "USER=agent", built.command, ...built.args], {
    cwd: built.repoDir,
    input: built.input,
    timeout: request.timeoutMs,
  });
}

export function executeLoopAction({
  request: rawRequest,
  runLoopAgent = defaultRunLoopAgent,
  now = () => new Date().toISOString(),
}) {
  const request = validateLoopRequest(rawRequest);
  const invocation = resolveLoopInvocation(request);
  let execution;
  try {
    execution = runLoopAgent({ request, invocation });
  } catch (error) {
    execution = { status: null, signal: null, timedOut: false, stdout: "", stderr: String(error), nativeSessionId: request.nativeSessionId };
  }
  const failed = execution.timedOut || execution.signal || execution.status !== 0;
  const worktreeDir = loopWorktreeDirectory(request);
  const subject = worktreeDir ? computeWorkspaceTreeOid(worktreeDir) : null;
  return {
    version: 1,
    kind: "loop_action_result",
    event_id: randomUUID(),
    action_id: request.actionId,
    attempt_id: request.attemptId,
    request_hash: request.requestHash,
    outcome: failed ? "failure" : "success",
    native_session_id: execution.nativeSessionId ?? request.nativeSessionId ?? null,
    subject,
    receipt: sanitizeArtifactText(execution.stdout || execution.stderr || (failed ? "loop action failed" : "loop action completed")).slice(0, 128_000),
    created_at: now(),
  };
}

function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function main() {
  const requestPath = resolve(arg("--request", process.env.OT_LOOP_REQUEST_FILE));
  const rawRequest = JSON.parse(readFileSync(requestPath, "utf8"));
  const request = validateLoopRequest(rawRequest);
  if (process.argv.includes("--validate-request")) {
    writeFileSync(1, `${canonicalJson(request)}\n`);
    return;
  }
  const outputPath = resolve(arg("--output", process.env.OT_LOOP_RESULT_FILE ?? `/var/lib/openthrottle/loop-results/${request.actionId}.json`));
  writeAtomic(outputPath, executeLoopAction({ request }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`execute-loop: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
