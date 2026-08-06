#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "./capabilities.mjs";
import { digest } from "./artifacts.mjs";
import { writeJsonAtomic } from "./atomic-write.mjs";
import { computeWorkspaceTreeOid, runGitAsExecutor } from "./repository-control.mjs";
import { defaultExecuteCommand, resolveCommand } from "./execute-stage.mjs";
import { integrateCandidate } from "./integrate-unit.mjs";
import { restoreIntegrationCheckout } from "./execute-loop.mjs";
import { deriveCandidateCommit, grantWorktreeToAgent, lockWorktree, worktreePath } from "./worktrees.mjs";

function configPath() {
  return process.env.OT_STAGE_CONFIG_FILE ?? "/var/lib/openthrottle/stage-input/repository-config.json";
}
const INTEGRATION_REPO_DIR = "/home/agent/repo";
const WORKTREE_ROOT = "/var/lib/openthrottle/worktrees";
const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/;
const GIT_SHA1_OBJECT_ID = /^[a-f0-9]{40}$/;

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

function sha1Subject(value, label) {
  if (typeof value !== "string" || !GIT_SHA1_OBJECT_ID.test(value)) {
    throw new Error(`${label} must be a 40-character Git object ID`);
  }
  return value;
}

function repoDirFor(request) {
  if (request.worktree?.id) return worktreePath({ rootDir: WORKTREE_ROOT, handle: request.worktree.id });
  return INTEGRATION_REPO_DIR;
}

function currentHead(repoDir) {
  return sha1Subject(runGitAsExecutor(repoDir, ["rev-parse", "HEAD"]), "integration HEAD");
}

function cleanCheckout(repoDir) {
  return runGitAsExecutor(repoDir, ["status", "--porcelain=v1", "--untracked-files=all"]) === "";
}

function resetIntegrationCheckout({ repoDir, subject: expectedHead }) {
  const head = sha1Subject(expectedHead, "integration reset subject");
  runGitAsExecutor(repoDir, ["reset", "--hard", head]);
  runGitAsExecutor(repoDir, ["clean", "-fd"]);
  restoreIntegrationCheckout(repoDir);
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

function commandEvidence(request, result, payload) {
  return [
    `executor:command:${request.actionId}:${payload.command}:${result}:${payload.stdout_digest}:${payload.stderr_digest}`,
  ];
}

function candidateEvidence(request, candidate) {
  return [
    `executor:candidate:${request.actionId}:${candidate.candidateCommit ?? request.baseSubject}:${candidate.tree}:${digest(canonicalJson(candidate.changedPaths))}`,
  ];
}

function integrationEvidence(request, evidence) {
  return [
    `executor:integration:${request.actionId}:${evidence.integrated_head}:${evidence.tree}:${digest(canonicalJson(evidence.changed_paths ?? []))}`,
  ];
}

function commandReceipt(request, {
  executeCommand = defaultExecuteCommand,
  grantWorktree = grantWorktreeToAgent,
  lockWorktreeHandle = lockWorktree,
  computeSubject = computeWorkspaceTreeOid,
  commitSubject = currentHead,
  isClean = cleanCheckout,
  resetIntegration = resetIntegrationCheckout,
} = {}) {
  const commandName = request.commandName;
  const config = JSON.parse(readFileSync(configPath(), "utf8"));
  const command = resolveCommand(config, commandName);
  if (!command) {
    const payload = {
      command: commandName,
      exit_code: 1,
      summary: `Repository command ${commandName} is not configured.`,
      stdout_digest: digest(""),
      stderr_digest: digest(""),
    };
    return receiptBase({
      request,
      type: "command_result",
      result: "not_configured",
      post: request.inputSubject,
      evidence: commandEvidence(request, "not_configured", payload),
      payload,
    });
  }
  let repoDir = repoDirFor(request);
  let relockWorktree = null;
  if (request.actionKind === "command") {
    const granted = grantWorktree({ rootDir: WORKTREE_ROOT, handle: request.worktree.id });
    repoDir = granted.path;
    relockWorktree = () => lockWorktreeHandle({ rootDir: WORKTREE_ROOT, handle: request.worktree.id });
  }
  let execution;
  let post;
  let finalCommandMutated = false;
  let finalCommandHead = null;
  let finalCommandClean = null;
  try {
    execution = executeCommand({ command, repoDir, timeoutMs: 7_200_000 });
    if (request.actionKind === "final_command") {
      finalCommandHead = commitSubject(repoDir);
      finalCommandClean = isClean(repoDir);
      finalCommandMutated = finalCommandHead !== request.inputSubject || !finalCommandClean;
      post = finalCommandMutated ? request.inputSubject : finalCommandHead;
    } else {
      post = computeSubject(repoDir);
    }
  } finally {
    if (request.actionKind === "final_command") {
      const observedPost = finalCommandHead ?? commitSubject(repoDir);
      const observedClean = finalCommandClean ?? isClean(repoDir);
      if (observedPost !== request.inputSubject || !observedClean) {
        resetIntegration({ repoDir, subject: request.inputSubject });
      }
    }
    if (relockWorktree) relockWorktree();
  }
  const result = execution.notConfigured
    ? "not_configured"
    : finalCommandMutated
      ? "failure"
    : execution.exitCode === 0 && !execution.timedOut && !execution.signal
      ? "success"
      : "failure";
  const payload = {
    command: commandName,
    exit_code: finalCommandMutated
      ? 1
      : execution.exitCode ?? 1,
    summary: finalCommandMutated
      ? `Repository final command ${commandName} mutated the tracked integration subject.`
      : `Repository command ${commandName} exited with ${execution.exitCode}.`,
    stdout_digest: digest(execution.stdout ?? ""),
    stderr_digest: digest(execution.stderr ?? ""),
  };
  return receiptBase({
    request,
    type: "command_result",
    result,
    post,
    evidence: commandEvidence(request, result, payload),
    payload,
  });
}

function candidateReceipt(request) {
  const baseSubject = sha1Subject(request.baseSubject, "baseSubject");
  const candidate = deriveCandidateCommit({
    worktreeDir: repoDirFor(request),
    baseCommit: baseSubject,
    message: `OpenThrottle candidate ${request.actionId}`,
  });
  const candidateSubject = candidate.candidateCommit ?? baseSubject;
  return receiptBase({
    request,
    type: "candidate_evidence",
    result: "success",
    post: candidateSubject,
    evidence: candidateEvidence(request, candidate),
    payload: {
      tree: candidate.tree,
      diff_digest: digest(canonicalJson({
        base: baseSubject,
        tree: candidate.tree,
        changed_paths: candidate.changedPaths,
      })),
      changed_paths: candidate.changedPaths,
      clean: true,
    },
  });
}

function integrationReceipt(request) {
  const inputSubject = sha1Subject(request.inputSubject, "inputSubject");
  const candidateSubject = sha1Subject(request.candidateSubject, "candidateSubject");
  const evidence = integrateCandidate({
    repoDir: INTEGRATION_REPO_DIR,
    expectedHead: inputSubject,
    candidateCommit: candidateSubject,
  });
  return receiptBase({
    request,
    type: "integration_evidence",
    result: "success",
    post: evidence.integrated_head,
    evidence: integrationEvidence(request, evidence),
    payload: {
      tree: evidence.tree,
      diff_digest: digest(canonicalJson(evidence)),
      changed_paths: [],
      clean: true,
    },
  });
}

export function executeChildAction({
  request: rawRequest,
  executeCommand = defaultExecuteCommand,
  grantWorktree = grantWorktreeToAgent,
  lockWorktreeHandle = lockWorktree,
  computeSubject = computeWorkspaceTreeOid,
  commitSubject = currentHead,
  isClean = cleanCheckout,
  resetIntegration = resetIntegrationCheckout,
} = {}) {
  const request = validateRequest(rawRequest);
  const receipt = request.actionKind === "command" || request.actionKind === "final_command"
    ? commandReceipt(request, {
        executeCommand,
        grantWorktree,
        lockWorktreeHandle,
        computeSubject,
        commitSubject,
        isClean,
        resetIntegration,
      })
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
