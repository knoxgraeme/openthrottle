#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  lockActionRepository,
  materializeActionRepository,
  materializeInspectChangeArtifact,
  verifyActionRepository,
  verifyInspectChangeArtifact,
} from "./action-repository.mjs";
import {
  materializeActionContextArtifact,
  verifyActionContextArtifact,
} from "./action-context.mjs";
import {
  prepareAgentRuntime,
  removeProgressiveSkills,
  runPreparedAgent as runPreparedAgentRuntime,
  runResultCorrection,
} from "./agent-runtime.mjs";
import { createAttemptCheckpoint } from "./checkpoint-bundle.mjs";
import { prepareAgentOwnedDirectory } from "./filesystem-isolation.mjs";
import {
  classifyLaunchFailure,
  engineCredentialPresent,
  engineExitedCleanly,
  isUnregisteredCommandResult,
  launchDiagnosticTail,
} from "./launch-failure.mjs";
import { runCapturedProcess } from "./bounded-process.mjs";
import { repositoryGitEnvironment } from "./repository-authority.mjs";
import {
  inspectResultSubmissionChannel,
  materializeResultSubmissionChannel,
  submitProviderResultCandidate,
} from "./result-submission.mjs";
import { reclaimSettledAttemptScratch } from "./scratch-reclamation.mjs";

export const KERNEL_RUNTIME_RESULT_SCHEMA = "openthrottle.kernel-runtime-result/v1";
export const KERNEL_SESSION_EVENT_SCHEMA = "openthrottle.kernel-session-event/v1";
export const INVALID_RESULT_EVIDENCE_SCHEMA = "openthrottle.invalid-result-evidence/v1";

const SHA256 = /^[a-f0-9]{64}$/;
const SUBJECT = /^[a-f0-9]{40,64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const ENGINES = new Set(["claude", "codex", "opencode"]);
const DEFAULT_ACTION_ROOT = "/var/lib/openthrottle/actions";
const RESULT_CORRECTION_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRANSPORT_BYTES = 4 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 60 * 60 * 1_000;
const MAX_WORK_FAILURE_REASON_CHARS = 1_500;

function validateExecutionLimits(value, label, engine = null) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== "max_turns\0task_timeout_seconds") {
    throw new Error(`${label} is invalid`);
  }
  const { max_turns: maxTurns, task_timeout_seconds: taskTimeout } = value;
  if (maxTurns !== null && (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 10_000)) {
    throw new Error(`${label}.max_turns is invalid`);
  }
  if (taskTimeout !== null &&
      (!Number.isSafeInteger(taskTimeout) || taskTimeout < 1 || taskTimeout > 86_400)) {
    throw new Error(`${label}.task_timeout_seconds is invalid`);
  }
  if (maxTurns !== null && engine !== null && engine !== "claude") {
    throw new Error(`${label}.max_turns is not enforceable by ${engine}`);
  }
  return value;
}

function timeoutMilliseconds(limits) {
  return limits.task_timeout_seconds === null ? undefined : limits.task_timeout_seconds * 1_000;
}

function exactString(value, label, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function validateCommonRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("kernel request must be an object");
  for (const key of ["pipeline_run_id", "attempt_id", "stage_id", "lease_id", "worker_id"]) {
    exactString(request[key], `request.${key}`);
  }
  exactString(request.request_hash, "request.request_hash", SHA256);
  exactString(request.definition_bundle_hash, "request.definition_bundle_hash", SHA256);
  exactString(request.checkpoint_base_subject, "request.checkpoint_base_subject", SUBJECT);
  exactString(request.input_subject, "request.input_subject", SUBJECT);
  return request;
}

export function validateKernelRequest(request) {
  validateCommonRequest(request);
  if (request.schema === "openthrottle.kernel-action-request/v2" && request.phase === "work") {
    if (!request.action || typeof request.action !== "object" || Array.isArray(request.action)) {
      throw new Error("work request action is invalid");
    }
    if (request.action.kind === "agent") {
      if (!ENGINES.has(request.action.engine)) throw new Error("work request engine is invalid");
      if (request.action.engine === "opencode" && !request.action.model) {
        throw new Error("OpenCode action requires a sealed model");
      }
      validateExecutionLimits(
        request.action.execution_limits,
        "work request action.execution_limits",
        request.action.engine,
      );
      if (!request.action.semantic_result_schema) throw new Error("agent action semantic schema is missing");
      if (!Array.isArray(request.action.definition_entries)) throw new Error("agent definition entries are invalid");
    } else if (request.action.kind === "command") {
      if (typeof request.action.command_line !== "string" || !request.action.command_line.trim()) {
        throw new Error("command action is invalid");
      }
      if (!Array.isArray(request.action.post_bootstrap) || request.action.post_bootstrap.length > 32 ||
          request.action.post_bootstrap.some((command) =>
            typeof command !== "string" || !command.trim() || command.length > 1_000 || command.includes("\0"))) {
        throw new Error("command action post_bootstrap is invalid");
      }
      validateExecutionLimits(request.action.execution_limits, "command action.execution_limits");
    } else {
      throw new Error("work request action kind is unsupported");
    }
    if (!new Set(["inspect", "edit"]).has(request.repository_authority)) {
      throw new Error("work request repository authority is invalid");
    }
    if (request.executor_policy?.git_administration !== "executor_only" ||
        request.executor_policy?.commit !== false || request.executor_policy?.push !== false ||
        request.executor_policy?.publish !== false) {
      throw new Error("work request executor policy is invalid");
    }
    return request;
  }
  if (request.schema === "openthrottle.kernel-result-correction-request/v2" &&
      request.phase === "result_correction") {
    if (!ENGINES.has(request.engine)) throw new Error("correction engine is invalid");
    if (request.engine === "opencode" && !request.model) throw new Error("OpenCode correction requires a sealed model");
    exactString(request.locked_subject, "request.locked_subject", SUBJECT);
    exactString(request.checkpoint_id, "request.checkpoint_id");
    exactString(request.native_session_id, "request.native_session_id", /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
    validateExecutionLimits(request.execution_limits, "correction execution_limits", request.engine);
    if (request.repository_authority !== "inspect" || JSON.stringify(request.tools) !== '["ot-result"]' ||
        request.mcp !== false || request.provider_access !== false) {
      throw new Error("correction authority is invalid");
    }
    if (!Number.isFinite(Date.parse(request.correction_deadline))) throw new Error("correction deadline is invalid");
    return request;
  }
  throw new Error("kernel request schema or phase is unsupported");
}

function readJson(path, maxBytes = MAX_TRANSPORT_BYTES) {
  const metadata = statSync(path);
  if (!metadata.isFile() || metadata.size > maxBytes) throw new Error(`bounded JSON file is invalid: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function syncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeImmutableJson(path, value, label, mode = 0o400) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(value)}\n`;
  try {
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    try {
      writeFileSync(descriptor, serialized);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    syncDirectory(dirname(path));
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (readFileSync(path, "utf8") !== serialized) throw new Error(`${label} conflicts with immutable transport evidence`);
  }
  return value;
}

function requestIdentity(request) {
  return {
    pipeline_run_id: request.pipeline_run_id,
    attempt_id: request.attempt_id,
    request_hash: request.request_hash,
    definition_bundle_hash: request.definition_bundle_hash,
    input_subject: request.input_subject,
  };
}

function assertIdentity(actual, request, label, { includeLease = false, includeInput = true } = {}) {
  for (const [key, value] of Object.entries(requestIdentity(request))) {
    if (!includeInput && key === "input_subject") continue;
    if (actual?.[key] !== value) throw new Error(`${label} ${key} mismatch`);
  }
  if (includeLease && (actual.lease_id !== request.lease_id || actual.worker_id !== request.worker_id)) {
    throw new Error(`${label} lease identity mismatch`);
  }
}

function runtimeEnvelope(request, outcome) {
  return {
    schema: KERNEL_RUNTIME_RESULT_SCHEMA,
    pipeline_run_id: request.pipeline_run_id,
    attempt_id: request.attempt_id,
    request_hash: request.request_hash,
    definition_bundle_hash: request.definition_bundle_hash,
    lease_id: request.lease_id,
    worker_id: request.worker_id,
    outcome,
  };
}

function existingResult(path, request) {
  if (!existsSync(path)) return null;
  const result = readJson(path);
  if (result.schema !== KERNEL_RUNTIME_RESULT_SCHEMA) throw new Error("runtime result schema is invalid");
  assertIdentity(result, request, "runtime result", { includeLease: true, includeInput: false });
  return result;
}

function safeActionDirectory(actionRoot, attemptId) {
  exactString(attemptId, "attempt id");
  const root = resolve(actionRoot);
  const path = resolve(root, attemptId.replaceAll(":", "-"));
  if (root === "/" || !path.startsWith(`${root}/`)) throw new Error("attempt action directory escapes its root");
  return path;
}

function sessionEvent(request, nativeSessionId, observedAt) {
  return {
    schema: KERNEL_SESSION_EVENT_SCHEMA,
    pipeline_run_id: request.pipeline_run_id,
    attempt_id: request.attempt_id,
    request_hash: request.request_hash,
    definition_bundle_hash: request.definition_bundle_hash,
    lease_id: request.lease_id,
    worker_id: request.worker_id,
    native_session_id: nativeSessionId,
    observed_at: observedAt,
  };
}

function stageCheckpointArtifact(checkpoint, sourceDirectory, resultPath) {
  const targetDirectory = dirname(resultPath);
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  const source = join(sourceDirectory, checkpoint.payload_artifact.file);
  const target = join(targetDirectory, checkpoint.payload_artifact.file);
  if (resolve(source) !== resolve(target)) {
    if (!existsSync(target)) copyFileSync(source, target, constants.COPYFILE_EXCL);
    if (statSync(target).size !== checkpoint.payload_artifact.bytes) {
      throw new Error("transport checkpoint artifact size mismatch");
    }
  }
}

function correctionDeadline(now) {
  return new Date(now.getTime() + RESULT_CORRECTION_WINDOW_MS).toISOString();
}

function stageInvalidResultEvidence(candidate, resultPath) {
  const evidence = {
    schema: INVALID_RESULT_EVIDENCE_SCHEMA,
    candidate_hash: candidate.original_hash ?? null,
    rejected_candidate: candidate.rejected_candidate ?? null,
    diagnostics: candidate.diagnostics,
  };
  const file = "invalid-result-evidence.json";
  const path = join(dirname(resultPath), file);
  writeImmutableJson(path, evidence, "invalid result evidence");
  const bytes = readFileSync(path);
  return {
    file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
    media_type: "application/json",
    payload_schema: INVALID_RESULT_EVIDENCE_SCHEMA,
  };
}

function semanticOutcome({ candidate, checkpoint, deadline, resultPath }) {
  if (candidate.status === "valid") {
    return {
      state: "work_complete",
      checkpoint,
      result: { kind: "semantic", candidate: candidate.staged },
    };
  }
  return {
    state: "result_pending",
    checkpoint,
    candidate_hash: candidate.original_hash ?? null,
    diagnostics: candidate.diagnostics,
    evidence_artifact: stageInvalidResultEvidence(candidate, resultPath),
    correction_deadline: deadline,
  };
}

function boundedCommandSummary(execution) {
  const text = [execution.stdout, execution.stderr].filter(Boolean).join("\n").trim();
  return (text || `command exited ${execution.status ?? "without status"}`).slice(-4_000);
}

function boundedAgentFailureReason(prefix, { stdout = "", stderr = "", env }) {
  const diagnosticLabel = " Executor diagnostic: ";
  // Give the label-free key=value diagnostic all remaining failure-reason space.
  const diagnosticBudget = Math.max(
    0,
    MAX_WORK_FAILURE_REASON_CHARS - prefix.length - diagnosticLabel.length,
  );
  const diagnostic = launchDiagnosticTail({
    stdout,
    stderr,
    env,
    max: diagnosticBudget,
  });
  return `${prefix}${diagnostic ? `${diagnosticLabel}${diagnostic}` : ""}`
    .slice(0, MAX_WORK_FAILURE_REASON_CHARS);
}

function agentLaunchFailure(request, execution, env) {
  const classified = classifyLaunchFailure({
    agent: request.action.engine,
    stdout: execution.stdout,
    stderr: execution.stderr,
    credentialPresent: engineCredentialPresent(request.action.engine, env),
  });
  const termination = [
    `status=${execution.status ?? "none"}`,
    `signal=${execution.signal ?? "none"}`,
    `timed_out=${Boolean(execution.timedOut)}`,
  ].join(", ");
  const prefix = [
    `agent work failed (${termination}, reason=${classified.reason}).`,
    classified.remediation,
  ].filter(Boolean).join(" ");
  return {
    state: "work_failed",
    retryable: Boolean(
      classified.retryable || execution.timedOut || execution.signal || execution.error || execution.status === 137
    ),
    reason: boundedAgentFailureReason(prefix, {
      stdout: execution.stdout,
      stderr: [
        execution.stderr,
        execution.error instanceof Error ? execution.error.message : execution.error,
      ].filter(Boolean).join("\n"),
      env,
    }),
  };
}

function agentExecutorException(error, env, phase, retryable) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    state: "work_failed",
    retryable,
    reason: boundedAgentFailureReason(
      `agent work ${phase} failed (reason=executor_${phase}_failure).`,
      {
        stdout: typeof error?.engineStdout === "string" ? error.engineStdout : "",
        stderr: [
          typeof error?.engineStderr === "string" ? error.engineStderr : "",
          message,
        ].filter(Boolean).join("\n"),
        env,
      },
    ),
  };
}

function agentPreparationException(error, env) {
  return agentExecutorException(
    error,
    env,
    "preparation",
    Boolean(error?.retryableInfrastructureFailure),
  );
}

function agentLaunchException(error, env) {
  return agentExecutorException(error, env, "launch", true);
}

function agentPreparedRuntimeException(error, env) {
  const retryable = Boolean(error?.retryableInfrastructureFailure);
  return agentExecutorException(error, env, retryable ? "launch" : "runtime", retryable);
}

function defaultCommandRunner({ commandLine, repositoryPath, timeoutMs }) {
  const safeEnv = {
    ...Object.fromEntries(["PATH", "LANG", "LC_ALL", "TZ"].flatMap((name) =>
      process.env[name] ? [[name, process.env[name]]] : [])),
    ...repositoryGitEnvironment(repositoryPath),
  };
  if (typeof process.getuid === "function" && process.getuid() === 0 && existsSync("/usr/local/bin/gosu")) {
    return runCapturedProcess("/usr/local/bin/gosu", [
      "agent", "env", ...Object.entries(safeEnv).map(([key, value]) => `${key}=${value}`),
      "/bin/sh", "-lc", commandLine,
    ], { cwd: repositoryPath, env: safeEnv, timeout: timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS });
  }
  return runCapturedProcess("/bin/sh", ["-lc", commandLine], {
    cwd: repositoryPath,
    env: safeEnv,
    timeout: timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
  });
}

async function executeCommandWork(options, actionDirectory) {
  const { request, sourceRepoDir, resultPath } = options;
  rmSync(actionDirectory, { recursive: true, force: true });
  mkdirSync(actionDirectory, { recursive: true, mode: 0o711 });
  chmodSync(actionDirectory, 0o711);
  const repository = materializeActionRepository({
    sourceRepoDir,
    inputSubject: request.input_subject,
    repositoryAuthority: "edit",
    destination: join(actionDirectory, "repository"),
  });
  const taskTimeoutMs = timeoutMilliseconds(request.action.execution_limits);
  const deadline = taskTimeoutMs === undefined ? null : options.now().getTime() + taskTimeoutMs;
  const run = async (commandLine, phase, index = null) => {
    const remaining = deadline === null ? undefined : deadline - options.now().getTime();
    if (remaining !== undefined && remaining <= 0) {
      return {
        status: null,
        signal: null,
        timedOut: true,
        stdout: "",
        stderr: "sealed task timeout exhausted before command launch",
      };
    }
    return await (options.runCommand ?? defaultCommandRunner)({
      commandLine,
      repositoryPath: repository.destination,
      request,
      phase,
      postBootstrapIndex: index,
      timeoutMs: remaining,
    });
  };
  for (const [index, commandLine] of request.action.post_bootstrap.entries()) {
    const bootstrap = await run(commandLine, "post_bootstrap", index);
    if (bootstrap.error || bootstrap.timedOut || bootstrap.signal) {
      return runtimeEnvelope(request, {
        state: "work_failed",
        retryable: true,
        reason: `post_bootstrap[${index}] failed: ${boundedCommandSummary(bootstrap)}`,
      });
    }
    if (bootstrap.status !== 0) {
      return await completeCommandWork({
        options,
        actionDirectory,
        repository,
        execution: bootstrap,
        summary: `post_bootstrap[${index}] failed: ${boundedCommandSummary(bootstrap)}`,
      });
    }
    if (deadline !== null && options.now().getTime() >= deadline) {
      return runtimeEnvelope(request, {
        state: "work_failed",
        retryable: true,
        reason: "post_bootstrap exhausted the sealed task timeout",
      });
    }
  }
  const execution = await run(request.action.command_line, "command");
  if (execution.error || execution.timedOut || execution.signal) {
    return runtimeEnvelope(request, {
      state: "work_failed",
      retryable: true,
      reason: boundedCommandSummary(execution),
    });
  }
  return await completeCommandWork({ options, actionDirectory, repository, execution });
}

async function completeCommandWork({ options, actionDirectory, repository, execution, summary = null }) {
  const { request, resultPath } = options;
  const verification = verifyActionRepository(repository);
  const inputOnlyVerification = { ...verification, output_subject: repository.input_subject };
  const artifactDirectory = join(actionDirectory, "artifacts");
  const checkpoint = createAttemptCheckpoint({
    request,
    repository,
    verification: inputOnlyVerification,
    outputSubject: null,
    nativeSessionId: null,
    artifactDirectory,
    capturedAt: options.now().toISOString(),
  });
  lockActionRepository(repository);
  stageCheckpointArtifact(checkpoint, artifactDirectory, resultPath);
  return runtimeEnvelope(request, {
    state: "work_complete",
    checkpoint,
    result: {
      kind: "command",
      outcome: execution.status === 0 ? "success" : "failure",
      command_id: request.action.command_id,
      exit_code: execution.status ?? 1,
      summary: summary ?? boundedCommandSummary(execution),
    },
  });
}

async function executeAgentWork(options, actionDirectory) {
  const { request, sourceRepoDir, resultPath, sessionPath } = options;
  const engineStatePath = join(actionDirectory, "engine-complete.json");
  const repositoryViewPath = join(actionDirectory, "repository-view.json");
  const checkpointPath = join(actionDirectory, "checkpoint.json");
  const artifactDirectory = join(actionDirectory, "artifacts");
  let execution;
  let repository;
  let prepared = null;
  if (existsSync(engineStatePath)) {
    execution = readJson(engineStatePath);
    assertIdentity(execution, request, "completed engine state");
    repository = readJson(repositoryViewPath);
  } else {
    rmSync(actionDirectory, { recursive: true, force: true });
    mkdirSync(actionDirectory, { recursive: true, mode: 0o711 });
    chmodSync(actionDirectory, 0o711);
    repository = materializeActionRepository({
      sourceRepoDir,
      inputSubject: request.input_subject,
      repositoryAuthority: request.repository_authority,
      destination: join(actionDirectory, "repository"),
      changeBoundary: request.change_boundary,
    });
    const inspectChangeArtifact = request.repository_authority === "inspect" && request.change_boundary !== null
      ? materializeInspectChangeArtifact({
        view: repository,
        destination: join(actionDirectory, "inspect-context", "change.json"),
      })
      : null;
    let actionContextArtifact;
    try {
      actionContextArtifact = materializeActionContextArtifact({
        request,
        actionDirectory,
        destination: join(actionDirectory, "action-context", "context.json"),
      });
    } catch (error) {
      return runtimeEnvelope(request, {
        state: "needs_human",
        reason: "required semantic action context could not be materialized",
        checkpoint: null,
        candidate_hash: null,
        diagnostics: [{
          path: "context",
          detail: error instanceof Error ? error.message : String(error),
        }],
      });
    }
    repository.inspect_change_artifact = inspectChangeArtifact;
    repository.action_context_artifact = actionContextArtifact;
    writeImmutableJson(repositoryViewPath, repository, "repository view");
    const candidateDirectory = join(actionDirectory, "semantic-result");
    prepareAgentOwnedDirectory(candidateDirectory);
    const channel = materializeResultSubmissionChannel({
      actionDirectory,
      candidateDirectory,
      semanticSchema: request.action.semantic_result_schema,
    });
    const runtimeRequest = {
      ...request,
      repository_path: repository.destination,
      inspect_change_artifact: inspectChangeArtifact,
      action_context_artifact: actionContextArtifact,
    };
    const observedSessions = [];
    const onSession = async (nativeSessionId) => {
      if (observedSessions.length > 0 && observedSessions[0] !== nativeSessionId) {
        throw new Error("agent reported conflicting native session identities");
      }
      observedSessions.push(nativeSessionId);
      writeImmutableJson(
        sessionPath,
        sessionEvent(request, nativeSessionId, options.now().toISOString()),
        "native session event",
      );
      writeImmutableJson(
        join(actionDirectory, "session-fence.json"),
        sessionEvent(request, nativeSessionId, options.now().toISOString()),
        "action session fence",
        0o444,
      );
    };
    if (options.runAgent) {
      try {
        execution = await options.runAgent({
          request: runtimeRequest,
          phase: "work",
          repositoryPath: repository.destination,
          channel,
          onSession,
          timeoutMs: timeoutMilliseconds(request.action.execution_limits),
          env: options.env,
        });
      } catch (error) {
        return runtimeEnvelope(request, agentLaunchException(error, options.env));
      }
    } else {
      try {
        prepared = prepareAgentRuntime({ request: runtimeRequest, actionDirectory, channel, env: options.env });
      } catch (error) {
        return runtimeEnvelope(request, agentPreparationException(error, options.env));
      }
      try {
        execution = await options.runPreparedAgent({
          prepared,
          request: runtimeRequest,
          channel,
          onSession,
          timeoutMs: timeoutMilliseconds(request.action.execution_limits),
        });
      } catch (error) {
        return runtimeEnvelope(request, agentPreparedRuntimeException(error, options.env));
      }
    }
    if (execution.nativeSessionId && observedSessions.length === 0) await onSession(execution.nativeSessionId);
    if (inspectChangeArtifact !== null) verifyInspectChangeArtifact(inspectChangeArtifact);
    verifyActionContextArtifact(actionContextArtifact);
    if (!engineExitedCleanly(execution) || execution.error || isUnregisteredCommandResult(execution.stdout)) {
      return runtimeEnvelope(request, agentLaunchFailure(request, execution, options.env));
    }
    if (!observedSessions[0]) {
      return runtimeEnvelope(request, {
        state: "work_failed",
        retryable: true,
        reason: "agent completed without a native session binding",
      });
    }
    execution = {
      ...requestIdentity(request),
      status: execution.status,
      signal: execution.signal ?? null,
      timedOut: Boolean(execution.timedOut),
      stdout: String(execution.stdout ?? ""),
      stderr: String(execution.stderr ?? ""),
      nativeSessionId: observedSessions[0],
      home: prepared?.home ?? join(actionDirectory, "home"),
      profileRoot: prepared?.profileRoot ?? join(actionDirectory, "home", `.${request.action.engine}`),
    };
    writeImmutableJson(engineStatePath, execution, "completed engine state");
  }

  const candidateDirectory = join(actionDirectory, "semantic-result");
  if (repository.inspect_change_artifact !== null && repository.inspect_change_artifact !== undefined) {
    verifyInspectChangeArtifact(repository.inspect_change_artifact);
  }
  verifyActionContextArtifact(repository.action_context_artifact);
  const channel = materializeResultSubmissionChannel({
    actionDirectory,
    candidateDirectory,
    semanticSchema: request.action.semantic_result_schema,
  });
  const candidate = submitProviderResultCandidate({
    raw: execution.stdout,
    engine: request.action.engine,
    channel,
  });
  let checkpoint;
  if (existsSync(checkpointPath)) {
    checkpoint = readJson(checkpointPath);
    assertIdentity(checkpoint, request, "recovered checkpoint");
  } else {
    const verification = verifyActionRepository(repository);
    const outputSubject = request.repository_authority === "edit" ? verification.output_subject : null;
    checkpoint = createAttemptCheckpoint({
      request,
      repository,
      verification,
      outputSubject,
      nativeSessionId: execution.nativeSessionId,
      artifactDirectory,
      capturedAt: options.now().toISOString(),
    });
    writeImmutableJson(checkpointPath, checkpoint, "attempt checkpoint");
    lockActionRepository(repository);
  }
  if (prepared) removeProgressiveSkills(prepared);
  stageCheckpointArtifact(checkpoint, artifactDirectory, resultPath);
  return runtimeEnvelope(request, semanticOutcome({
    candidate,
    checkpoint,
    deadline: correctionDeadline(options.now()),
    resultPath,
  }));
}

function correctionPrompt(request) {
  return [
    "The assigned work is complete and its Git subject is locked.",
    "Do not repeat work, tests, review, or repository inspection.",
    "Return exactly one openthrottle.result-candidate/v1 JSON object fixing only the diagnosed fields.",
    `Locked subject: ${request.locked_subject}`,
    `Diagnostics: ${JSON.stringify(request.diagnostics)}`,
  ].join("\n\n");
}

async function executeCorrection(options, actionDirectory) {
  const { request, resultPath } = options;
  const checkpointPath = join(actionDirectory, "checkpoint.json");
  const engineStatePath = join(actionDirectory, "engine-complete.json");
  const repositoryViewPath = join(actionDirectory, "repository-view.json");
  const artifactDirectory = join(actionDirectory, "artifacts");
  if (!existsSync(checkpointPath) || !existsSync(engineStatePath) || !existsSync(repositoryViewPath)) {
    return runtimeEnvelope(request, {
      state: "needs_human",
      reason: "result correction checkpoint is unavailable",
      checkpoint: null,
      candidate_hash: null,
      diagnostics: request.diagnostics,
    });
  }
  const checkpoint = readJson(checkpointPath);
  const engineState = readJson(engineStatePath);
  const repository = readJson(repositoryViewPath);
  assertIdentity(checkpoint, request, "correction checkpoint");
  if (checkpoint.id !== request.checkpoint_id || checkpoint.native_session_id !== request.native_session_id ||
      (checkpoint.output_subject ?? checkpoint.input_subject) !== request.locked_subject) {
    throw new Error("correction request changed the locked checkpoint fence");
  }
  const deadline = Date.parse(request.correction_deadline);
  if (options.now().getTime() >= deadline) {
    stageCheckpointArtifact(checkpoint, artifactDirectory, resultPath);
    return runtimeEnvelope(request, {
      state: "needs_human",
      reason: "result correction deadline exhausted",
      checkpoint,
      candidate_hash: null,
      diagnostics: request.diagnostics,
    });
  }
  lockActionRepository(repository);
  const candidateDirectory = join(actionDirectory, "semantic-result");
  const channel = materializeResultSubmissionChannel({
    actionDirectory,
    candidateDirectory,
    semanticSchema: request.semantic_result_schema,
  });
  const remainingCorrectionMs = deadline - options.now().getTime();
  if (remainingCorrectionMs <= 0) {
    stageCheckpointArtifact(checkpoint, artifactDirectory, resultPath);
    return runtimeEnvelope(request, {
      state: "needs_human",
      reason: "result correction deadline exhausted",
      checkpoint,
      candidate_hash: null,
      diagnostics: request.diagnostics,
    });
  }
  const taskTimeoutMs = timeoutMilliseconds(request.execution_limits);
  const timeoutMs = Math.max(
    1,
    taskTimeoutMs === undefined
      ? remainingCorrectionMs
      : Math.min(remainingCorrectionMs, taskTimeoutMs),
  );
  let execution;
  if (options.runAgent) {
    execution = await options.runAgent({
      request,
      phase: "result_correction",
      repositoryPath: repository.destination,
      channel,
      onSession: async () => { throw new Error("result correction cannot rebind the native session"); },
      timeoutMs,
    });
  } else {
    const cwd = join(actionDirectory, "result-correction-cwd");
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd, { mode: 0o555 });
    execution = await runResultCorrection({
      request,
      actionDirectory,
      channel,
      profileRoot: engineState.profileRoot,
      home: engineState.home,
      cwd,
      prompt: correctionPrompt(request),
      timeoutMs,
    });
  }
  if (options.now().getTime() >= deadline) {
    stageCheckpointArtifact(checkpoint, artifactDirectory, resultPath);
    return runtimeEnvelope(request, {
      state: "needs_human",
      reason: "result correction deadline exhausted",
      checkpoint,
      candidate_hash: null,
      diagnostics: request.diagnostics,
    });
  }
  if (!engineExitedCleanly(execution)) {
    stageCheckpointArtifact(checkpoint, artifactDirectory, resultPath);
    return runtimeEnvelope(request, {
      state: "needs_human",
      reason: "result correction did not exit cleanly",
      checkpoint,
      candidate_hash: null,
      diagnostics: request.diagnostics,
    });
  }
  const candidate = submitProviderResultCandidate({
    raw: execution.stdout,
    engine: request.engine,
    channel,
  });
  stageCheckpointArtifact(checkpoint, artifactDirectory, resultPath);
  return runtimeEnvelope(request, semanticOutcome({
    candidate,
    checkpoint,
    deadline: request.correction_deadline,
    resultPath,
  }));
}

export async function executeAttempt({
  request,
  sourceRepoDir = "/var/lib/openthrottle/repository-source/repo",
  actionRoot = process.env.OT_ACTION_ROOT ?? DEFAULT_ACTION_ROOT,
  requestPath = null,
  resultPath,
  sessionPath,
  runAgent = null,
  runPreparedAgent: runPreparedAgentOverride = runPreparedAgentRuntime,
  runCommand = null,
  now = () => new Date(),
  env = process.env,
  reclamationLog = null,
}) {
  validateKernelRequest(request);
  if (typeof resultPath !== "string" || !resultPath.startsWith("/")) throw new Error("result path must be absolute");
  if (typeof sessionPath !== "string" || !sessionPath.startsWith("/")) throw new Error("session path must be absolute");
  const actionDirectory = safeActionDirectory(actionRoot, request.attempt_id);
  // Execution width is one: once this action starts, every differently named
  // attempt subtree in these executor-owned roots belongs to settled work.
  reclaimSettledAttemptScratch({
    attemptId: request.attempt_id,
    sourceRepoDir,
    actionRoot,
    actionDirectory,
    requestPath,
    resultPath,
    leaseGenerationFencePath: env.OT_LEASE_GENERATION_FENCE_FILE,
    log: reclamationLog,
  });
  const replay = existingResult(resultPath, request);
  if (replay) return replay;
  let envelope;
  try {
    envelope = request.phase === "result_correction"
      ? await executeCorrection({ request, sourceRepoDir, resultPath, sessionPath, runAgent, now }, actionDirectory)
      : request.action.kind === "command"
        ? await executeCommandWork({ request, sourceRepoDir, resultPath, sessionPath, runCommand, now }, actionDirectory)
        : await executeAgentWork({
          request,
          sourceRepoDir,
          resultPath,
          sessionPath,
          runAgent,
          runPreparedAgent: runPreparedAgentOverride,
          now,
          env,
        }, actionDirectory);
  } catch (error) {
    envelope = runtimeEnvelope(request, request.phase === "result_correction" ? {
      state: "needs_human",
      reason: error instanceof Error ? error.message : String(error),
      checkpoint: existsSync(join(actionDirectory, "checkpoint.json"))
        ? readJson(join(actionDirectory, "checkpoint.json"))
        : null,
      candidate_hash: null,
      diagnostics: request.diagnostics ?? [],
    } : {
      state: "work_failed",
      retryable: Boolean(error?.retryableInfrastructureFailure),
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  writeImmutableJson(resultPath, envelope, "kernel runtime result");
  return envelope;
}

function inputPath(argv, env) {
  const index = argv.indexOf("--request");
  return resolve(index >= 0 ? argv[index + 1] : env.OT_ACTION_REQUEST_FILE);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const requestPath = inputPath(process.argv.slice(2), process.env);
  const resultPath = resolve(process.env.OT_ACTION_RESULT_FILE);
  const sessionPath = resolve(process.env.OT_ACTION_SESSION_FILE);
  const request = validateKernelRequest(readJson(requestPath));
  await executeAttempt({
    request,
    requestPath,
    resultPath,
    sessionPath,
    reclamationLog: (summary) => process.stdout.write(`${summary}\n`),
  });
}
