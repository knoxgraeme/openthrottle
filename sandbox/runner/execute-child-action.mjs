#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "./capabilities.mjs";
import { commandDiagnosticTail, digest } from "./artifacts.mjs";
import { writeJsonAtomic } from "./atomic-write.mjs";
import {
  computeWorkspaceTreeOidAsExecutor,
  readGitFileEntryAsExecutor,
  runGitAsExecutor,
} from "./repository-control.mjs";
import {
  defaultExecuteCommand,
  REPOSITORY_COMMAND_TIMEOUT_MS,
  resolveCommand,
} from "./execute-stage.mjs";
import { integrateCandidate } from "./integrate-unit.mjs";
import { restoreIntegrationCheckout } from "./filesystem-isolation.mjs";
import { deriveCandidateCommit, grantWorktreeToAgent, lockWorktree, removeWorktree, worktreePath } from "./worktrees.mjs";
import { ensureWorktreeBootstrap } from "./worktree-bootstrap.mjs";

function configPath() {
  return process.env.OT_STAGE_CONFIG_FILE ?? "/var/lib/openthrottle/stage-input/repository-config.json";
}
const INTEGRATION_REPO_DIR = "/home/agent/repo";
const WORKTREE_ROOT = "/var/lib/openthrottle/worktrees";
const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/;
const GIT_SHA1_OBJECT_ID = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TUNE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+$/;

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function childRequestHash(requestWithoutFence) {
  return digest(canonicalJson(requestWithoutFence));
}

export function validateRequest(value) {
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
  if (value.tuneAuthorization !== undefined) validateTuneAuthorization(value.tuneAuthorization);
  return value;
}

function validateTuneAuthorization(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tune edit authorization must be an object");
  }
  const allowed = new Set([
    "schema", "proposalDigest", "decisionDigest", "authorizationDigest", "baseSubject", "expiresAt", "changes",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)) ||
      value.schema !== "openthrottle.tune-edit-verification/v1" ||
      ![value.proposalDigest, value.decisionDigest, value.authorizationDigest].every((entry) =>
        typeof entry === "string" && SHA256.test(entry)) ||
      typeof value.baseSubject !== "string" || !GIT_SHA1_OBJECT_ID.test(value.baseSubject) ||
      typeof value.expiresAt !== "string" || Number.isNaN(Date.parse(value.expiresAt)) ||
      !Array.isArray(value.changes) || value.changes.length < 1 || value.changes.length > 64) {
    throw new Error("tune edit authorization is invalid");
  }
  const paths = new Set();
  let contentBytes = 0;
  for (const change of value.changes) {
    if (!change || typeof change !== "object" || Array.isArray(change) ||
        Object.keys(change).some((key) =>
          !["path", "operation", "before_digest", "after_digest", "after_content", "rationale"].includes(key)) ||
        typeof change.path !== "string" || !TUNE_PATH.test(change.path) || paths.has(change.path) ||
        !["add", "modify", "delete"].includes(change.operation) ||
        (change.before_digest !== null && (typeof change.before_digest !== "string" || !SHA256.test(change.before_digest))) ||
        (change.after_digest !== null && (typeof change.after_digest !== "string" || !SHA256.test(change.after_digest))) ||
        (change.after_content !== null && (typeof change.after_content !== "string" ||
          change.after_content.length < 1 || Buffer.byteLength(change.after_content, "utf8") > 128 * 1024)) ||
        typeof change.rationale !== "string" || change.rationale.length < 1 || change.rationale.length > 1_000) {
      throw new Error("tune edit authorization has an invalid change");
    }
    if ((change.operation === "add" && (change.before_digest !== null || change.after_digest === null || change.after_content === null)) ||
        (change.operation === "modify" && (change.before_digest === null || change.after_digest === null || change.after_content === null)) ||
        (change.operation === "delete" && (change.before_digest === null || change.after_digest !== null || change.after_content !== null)) ||
        (change.after_content !== null && digest(change.after_content) !== change.after_digest)) {
      throw new Error("tune edit authorization has inconsistent change digests");
    }
    contentBytes += change.after_content === null ? 0 : Buffer.byteLength(change.after_content, "utf8");
    paths.add(change.path);
  }
  if (contentBytes > 192 * 1024) throw new Error("tune edit authorization content exceeds the bounded change set");
  if (Buffer.byteLength(canonicalJson(value.changes), "utf8") > 160 * 1024) {
    throw new Error("tune edit authorization canonical JSON exceeds the bounded request material");
  }
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

function changedPathsBetween(repoDir, baseSubject, candidateSubject) {
  const output = runGitAsExecutor(repoDir, [
    "-c", "core.quotepath=false", "diff", "--name-only", "--no-renames", baseSubject, candidateSubject, "--",
  ]);
  return output.split("\n").filter(Boolean).sort();
}

export function verifyTuneCandidate(request, candidateSubject, repoDir = INTEGRATION_REPO_DIR) {
  const authorization = request.tuneAuthorization;
  if (!authorization) return changedPathsBetween(repoDir, request.baseSubject, candidateSubject);
  if (authorization.expiresAt < new Date().toISOString()) {
    throw new Error("tune edit authorization expired before integration");
  }
  const actualPaths = changedPathsBetween(repoDir, authorization.baseSubject, candidateSubject);
  const authorizedPaths = authorization.changes.map((change) => change.path).sort();
  if (canonicalJson(actualPaths) !== canonicalJson(authorizedPaths)) {
    throw new Error("tune candidate paths do not match the authorized change set");
  }
  for (const change of authorization.changes) {
    const beforeEntry = readGitFileEntryAsExecutor(repoDir, authorization.baseSubject, change.path);
    const afterEntry = readGitFileEntryAsExecutor(repoDir, candidateSubject, change.path);
    if ((change.operation === "add" && beforeEntry !== null) ||
        (change.operation === "modify" && (beforeEntry === null || afterEntry === null)) ||
        (change.operation === "delete" && afterEntry !== null)) {
      throw new Error(`tune candidate operation does not match ${change.path}`);
    }
    const regularModes = new Set(["100644", "100755"]);
    if ((beforeEntry && (beforeEntry.type !== "blob" || !regularModes.has(beforeEntry.mode))) ||
        (afterEntry && (afterEntry.type !== "blob" || !regularModes.has(afterEntry.mode))) ||
        (change.operation === "add" && afterEntry?.mode !== "100644") ||
        (change.operation === "modify" && beforeEntry?.mode !== afterEntry?.mode)) {
      throw new Error(`tune candidate file type or mode does not match ${change.path}`);
    }
    const before = beforeEntry?.content ?? null;
    const after = afterEntry?.content ?? null;
    if ((before === null ? null : digest(before)) !== change.before_digest ||
        (after === null ? null : digest(after)) !== change.after_digest) {
      throw new Error(`tune candidate content digest does not match ${change.path}`);
    }
    if (after !== change.after_content) {
      throw new Error(`tune candidate content does not match the authorized bytes for ${change.path}`);
    }
  }
  return actualPaths;
}

function tuneVerificationEvidence(request, result, error) {
  const reason = error instanceof Error ? error.message : String(error);
  return `executor:tune-authorization:${request.actionId}:${result}:${digest(reason)}`;
}

function commandReceipt(request, {
  executeCommand = defaultExecuteCommand,
  bootstrapWorktree = ensureWorktreeBootstrap,
  grantWorktree = grantWorktreeToAgent,
  lockWorktreeHandle = lockWorktree,
  computeSubject = computeWorkspaceTreeOidAsExecutor,
  commitSubject = currentHead,
  isClean = cleanCheckout,
  resetIntegration = resetIntegrationCheckout,
} = {}) {
  const commandName = request.commandName;
  const configRaw = readFileSync(configPath(), "utf8");
  const config = JSON.parse(configRaw);
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
    if (request.actionKind === "command") {
      // The unit worktree was created bare and carries none of the ignored
      // dependency state the bake-once bootstrap installed in the
      // integration checkout. Re-run the sealed post_bootstrap there, once
      // per worktree, before the first repository command; a bootstrap
      // failure throws (retryable infrastructure via
      // childActionFailureResult) rather than becoming a command receipt,
      // so it can never consume a semantic repair round.
      bootstrapWorktree({
        worktreeDir: repoDir,
        handle: request.worktree.id,
        config,
        configDigest: digest(configRaw),
        executeCommand,
        commandTimeoutMs: REPOSITORY_COMMAND_TIMEOUT_MS,
      });
    }
    execution = executeCommand({ command, repoDir, timeoutMs: REPOSITORY_COMMAND_TIMEOUT_MS });
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
  const stdoutTail = result === "failure" ? commandDiagnosticTail(execution.stdout) : undefined;
  const stderrTail = result === "failure" ? commandDiagnosticTail(execution.stderr) : undefined;
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
    ...(stdoutTail === undefined ? {} : { stdout_tail: stdoutTail }),
    ...(stderrTail === undefined ? {} : { stderr_tail: stderrTail }),
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
  let result = "success";
  let authorizationEvidence = [];
  if (request.tuneAuthorization) {
    try {
      verifyTuneCandidate(request, candidateSubject);
      authorizationEvidence = [tuneVerificationEvidence(request, "accepted", request.tuneAuthorization.authorizationDigest)];
    } catch (error) {
      result = "failure";
      authorizationEvidence = [tuneVerificationEvidence(request, "rejected", error)];
    }
  }
  return receiptBase({
    request,
    type: "candidate_evidence",
    result,
    post: candidateSubject,
    evidence: [...candidateEvidence(request, candidate), ...authorizationEvidence],
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
  let changedPaths;
  try {
    changedPaths = verifyTuneCandidate(request, candidateSubject);
  } catch (error) {
    const tree = runGitAsExecutor(INTEGRATION_REPO_DIR, ["rev-parse", `${inputSubject}^{tree}`]);
    return receiptBase({
      request,
      type: "integration_evidence",
      result: "failure",
      post: inputSubject,
      evidence: [tuneVerificationEvidence(request, "rejected", error)],
      payload: {
        tree,
        diff_digest: digest(canonicalJson({ inputSubject, candidateSubject })),
        changed_paths: [],
        clean: cleanCheckout(INTEGRATION_REPO_DIR),
      },
    });
  }
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
    evidence: [
      ...integrationEvidence(request, evidence),
      ...(request.tuneAuthorization
        ? [tuneVerificationEvidence(request, "accepted", request.tuneAuthorization.authorizationDigest)]
        : []),
    ],
    payload: {
      tree: evidence.tree,
      diff_digest: digest(canonicalJson(evidence)),
      changed_paths: changedPaths,
      clean: true,
    },
  });
}

export function executeChildAction({
  request: rawRequest,
  executeCommand = defaultExecuteCommand,
  bootstrapWorktree = ensureWorktreeBootstrap,
  grantWorktree = grantWorktreeToAgent,
  lockWorktreeHandle = lockWorktree,
  computeSubject = computeWorkspaceTreeOidAsExecutor,
  commitSubject = currentHead,
  isClean = cleanCheckout,
  resetIntegration = resetIntegrationCheckout,
} = {}) {
  const request = validateRequest(rawRequest);
  const receipt = request.actionKind === "command" || request.actionKind === "final_command"
    ? commandReceipt(request, {
        executeCommand,
        bootstrapWorktree,
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

export function finalizeChildActionRetention(request, result, {
  repoDir = INTEGRATION_REPO_DIR,
  rootDir = WORKTREE_ROOT,
  remove = removeWorktree,
} = {}) {
  // Candidate derivation is the commit point for a unit workspace: the
  // object is now durable in the integration repository's common object
  // store, so the transient linked checkout and its temporary packs are
  // reconstructible. Earlier command actions deliberately keep it for the
  // next semantic action, and failures keep it for diagnostics/retry.
  if (request.actionKind !== "candidate" || result.outcome !== "success" || !request.worktree?.id) {
    return { removed: false };
  }
  return remove({ repoDir, rootDir, handle: request.worktree.id });
}

export function replayChildActionResult(request, outputPath, retention = {}) {
  request = validateRequest(request);
  if (!existsSync(outputPath)) return null;
  const metadata = lstatSync(outputPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("child result replay path must be a real file");
  const replay = JSON.parse(readFileSync(outputPath, "utf8"));
  if (replay?.kind !== "child_executor_action_result" || replay.action_id !== request.actionId ||
      replay.attempt_id !== request.attemptId || replay.request_hash !== request.requestHash) {
    throw new Error("child result replay does not match the sealed request");
  }
  finalizeChildActionRetention(request, replay, retention);
  return replay;
}

export function commitChildActionResult(request, result, outputPath, retention = {}) {
  writeJsonAtomic(outputPath, result);
  return finalizeChildActionRetention(request, result, retention);
}

function main() {
  const requestPath = resolve(arg("--request", process.env.OT_CHILD_EXECUTOR_REQUEST_FILE));
  const outputPath = resolve(arg("--output", process.env.OT_CHILD_EXECUTOR_RESULT_FILE));
  const request = validateRequest(JSON.parse(readFileSync(requestPath, "utf8")));
  if (replayChildActionResult(request, outputPath)) return;
  try {
    const result = executeChildAction({ request });
    commitChildActionResult(request, result, outputPath);
  } catch (error) {
    // Candidate result persistence is the semantic commit point. A cleanup
    // failure is replayable and must not replace the committed candidate.
    if (!existsSync(outputPath)) {
      writeJsonAtomic(outputPath, childActionFailureResult(request, error));
    }
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
