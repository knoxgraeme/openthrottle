#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "./capabilities.mjs";
import { digest } from "./artifacts.mjs";
import { writeJsonAtomic } from "./atomic-write.mjs";
import { computeWorkspaceTreeOid } from "./repository-control.mjs";
import { defaultExecuteCommand, resolveCommand } from "./execute-stage.mjs";
import { integrateCandidate } from "./integrate-unit.mjs";
import { deriveCandidateCommit, worktreePath } from "./worktrees.mjs";

function configPath() {
  return process.env.OT_STAGE_CONFIG_FILE ?? "/var/lib/openthrottle/stage-input/repository-config.json";
}
const INTEGRATION_REPO_DIR = "/home/agent/repo";
const WORKTREE_ROOT = "/var/lib/openthrottle/worktrees";
const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/;

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function childRequestHash(requestWithoutFence) {
  return digest(canonicalJson(requestWithoutFence));
}

function validateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("child executor request must be an object");
  const { requestHash, idempotencyKey, ...withoutFence } = value;
  const expectedHash = childRequestHash(withoutFence);
  if (requestHash !== expectedHash ||
      idempotencyKey !== `child-executor:${value.attemptId}:${value.actionId}:${expectedHash}`) {
    throw new Error("child executor request hash or idempotency key is stale");
  }
  if (value.protocol !== "child-executor-action@1") {
    throw new Error("child executor protocol is invalid");
  }
  if (!["command", "final_command", "candidate", "integrate"].includes(value.actionKind)) {
    throw new Error("child executor action kind is invalid");
  }
  if (value.actionKind === "command" &&
      (!value.unitId || !value.worktree?.id)) {
    throw new Error("child executor unit action requires a worktree");
  }
  if (value.actionKind === "candidate" && !value.worktree?.id) {
    throw new Error("child executor candidate action requires a worktree");
  }
  if (value.actionKind === "final_command" && value.unitId !== null) {
    throw new Error("child executor final command must be graph-scoped");
  }
  if ((value.actionKind === "command" || value.actionKind === "final_command") && !value.commandName) {
    throw new Error("child executor command action requires a command name");
  }
  if (value.actionKind === "integrate" && !value.candidateSubject) {
    throw new Error("child executor integration action requires a candidate subject");
  }
  return value;
}

function subject(value, label) {
  if (typeof value !== "string" || !GIT_OBJECT_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function repoDirFor(request) {
  if (request.worktree?.id) return worktreePath({ rootDir: WORKTREE_ROOT, handle: request.worktree.id });
  return INTEGRATION_REPO_DIR;
}

function producer(type, request) {
  return {
    worker_id: "executor",
    skill: `builtin://${type}@1`,
    capability_digest: request.capabilityDigest,
    skill_package_digest: null,
  };
}

function fence(request) {
  return {
    pipeline_instance_id: request.pipelineInstanceId,
    graph_digest: request.graphDigest,
    unit_id: request.unitId ?? "__final__",
    attempt_id: request.attemptId,
    parent_run_id: request.parentRunId,
    action_attempt_id: request.actionId,
    generation: request.generation,
    native_session_id: null,
    request_hash: request.requestHash,
  };
}

function receiptBase({ request, type, result, post, evidence = [], payload }) {
  return {
    schema: "openthrottle.receipt/v1",
    type,
    assurance: "executor_verified",
    result,
    producer: producer(type, request),
    subject: {
      base: subject(request.baseSubject, "baseSubject"),
      pre: subject(request.inputSubject, "inputSubject"),
      post: subject(post, "postSubject"),
    },
    fence: fence(request),
    evidence,
    payload,
    issued_at: new Date().toISOString(),
  };
}

function commandReceipt(request) {
  const commandName = request.commandName;
  const config = JSON.parse(readFileSync(configPath(), "utf8"));
  const command = resolveCommand(config, commandName);
  const repoDir = repoDirFor(request);
  const execution = defaultExecuteCommand({ command, repoDir, timeoutMs: 7_200_000 });
  const post = execution.notConfigured ? request.inputSubject : computeWorkspaceTreeOid(repoDir);
  const result = execution.notConfigured
    ? "not_configured"
    : execution.exitCode === 0 && !execution.timedOut && !execution.signal
      ? "success"
      : "failure";
  return receiptBase({
    request,
    type: "command_result",
    result,
    post,
    payload: {
      command: commandName,
      exit_code: execution.exitCode ?? 1,
      summary: command ? `Repository command ${commandName} exited with ${execution.exitCode}.` : `Repository command ${commandName} is not configured.`,
      stdout_digest: digest(execution.stdout ?? ""),
      stderr_digest: digest(execution.stderr ?? ""),
    },
  });
}

function candidateReceipt(request) {
  const candidate = deriveCandidateCommit({
    worktreeDir: repoDirFor(request),
    baseCommit: request.baseSubject.slice(0, 40),
    message: `OpenThrottle candidate ${request.actionId}`,
  });
  const candidateSubject = candidate.candidateCommit ?? request.baseSubject.slice(0, 40);
  return receiptBase({
    request,
    type: "candidate_evidence",
    result: "success",
    post: candidateSubject,
    payload: {
      tree: candidate.tree,
      diff_digest: digest(canonicalJson({
        base: request.baseSubject.slice(0, 40),
        tree: candidate.tree,
        changed_paths: candidate.changedPaths,
      })),
      changed_paths: candidate.changedPaths,
      clean: true,
    },
  });
}

function integrationReceipt(request) {
  const evidence = integrateCandidate({
    repoDir: INTEGRATION_REPO_DIR,
    expectedHead: request.inputSubject.slice(0, 40),
    candidateCommit: request.candidateSubject,
  });
  return receiptBase({
    request,
    type: "integration_evidence",
    result: "success",
    post: evidence.integrated_head,
    payload: {
      tree: evidence.tree,
      diff_digest: digest(canonicalJson(evidence)),
      changed_paths: [],
      clean: true,
    },
  });
}

export function executeChildAction({ request: rawRequest }) {
  const request = validateRequest(rawRequest);
  const receipt = request.actionKind === "command" || request.actionKind === "final_command"
    ? commandReceipt(request)
    : request.actionKind === "candidate"
      ? candidateReceipt(request)
      : integrationReceipt(request);
  return {
    version: 1,
    kind: "child_executor_action_result",
    action_id: request.actionId,
    attempt_id: request.attemptId,
    request_hash: request.requestHash,
    outcome: receipt.result === "success" || receipt.result === "not_configured" ? "success" : "failure",
    subject: receipt.subject.post,
    receipt: canonicalJson(receipt),
    created_at: receipt.issued_at,
  };
}

export function childActionFailureResult(rawRequest, error) {
  const message = error instanceof Error ? error.message : String(error);
  const actionId = typeof rawRequest?.actionId === "string" ? rawRequest.actionId : "unknown";
  const attemptId = typeof rawRequest?.attemptId === "string" ? rawRequest.attemptId : "unknown";
  const requestHash = typeof rawRequest?.requestHash === "string" ? rawRequest.requestHash : "";
  const subject = typeof rawRequest?.inputSubject === "string" && GIT_OBJECT_ID.test(rawRequest.inputSubject)
    ? rawRequest.inputSubject
    : null;
  return {
    version: 1,
    kind: "child_executor_action_result",
    action_id: actionId,
    attempt_id: attemptId,
    request_hash: requestHash,
    outcome: "retryable_infrastructure_failure",
    subject,
    receipt: message,
    created_at: new Date().toISOString(),
  };
}

function main() {
  const requestPath = resolve(arg("--request", process.env.OT_CHILD_EXECUTOR_REQUEST_FILE));
  const outputPath = resolve(arg("--output", process.env.OT_CHILD_EXECUTOR_RESULT_FILE));
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  try {
    writeJsonAtomic(outputPath, executeChildAction({ request }));
  } catch (error) {
    writeJsonAtomic(outputPath, childActionFailureResult(request, error));
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`execute-child-action: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
