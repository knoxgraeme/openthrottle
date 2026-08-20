import {
  inspectResultSubmissionChannel,
  submitProviderResultCandidate,
} from "./result-submission.mjs";

export const RESULT_REPAIR_PHASES = Object.freeze(["work", "result_correction"]);
export const RESULT_SETTLEMENT_STATES = Object.freeze([
  "work_complete",
  "result_pending",
  "needs_human",
  "work_failed",
]);

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SUBJECT = /^[a-f0-9]{40,64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const NATIVE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function exactString(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function nullableGitSubject(value, label) {
  return value === null ? null : exactString(value, label, GIT_SUBJECT);
}

export function assertVerifiedResultCheckpoint({
  checkpoint,
  attemptId,
  requestHash,
  definitionBundleHash,
  inputSubject,
  outputSubject,
}) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw new Error("verified result checkpoint is missing");
  }
  const expected = {
    attempt_id: exactString(attemptId, "attemptId", ID),
    request_hash: exactString(requestHash, "requestHash", SHA256),
    definition_bundle_hash: exactString(definitionBundleHash, "definitionBundleHash", SHA256),
    input_subject: exactString(inputSubject, "inputSubject", GIT_SUBJECT),
    output_subject: nullableGitSubject(outputSubject, "outputSubject"),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (checkpoint[key] !== value) throw new Error(`verified result checkpoint ${key} mismatch`);
  }
  if (typeof checkpoint.id !== "string" || !ID.test(checkpoint.id)) {
    throw new Error("verified result checkpoint id is invalid");
  }
  if (checkpoint.native_session_id !== null &&
      (typeof checkpoint.native_session_id !== "string" || !NATIVE_SESSION_ID.test(checkpoint.native_session_id))) {
    throw new Error("verified result checkpoint native_session_id is invalid");
  }
  return checkpoint;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function boundedDiagnostics(value) {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("candidate diagnostics must contain at most 32 items");
  }
  return value.map((diagnostic, index) => {
    if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) {
      throw new Error(`candidate diagnostics[${index}] must be an object`);
    }
    const keys = Object.keys(diagnostic);
    if (keys.some((key) => key !== "path" && key !== "detail")) {
      throw new Error(`candidate diagnostics[${index}] has unknown fields`);
    }
    if (typeof diagnostic.path !== "string" || !diagnostic.path || diagnostic.path.length > 500) {
      throw new Error(`candidate diagnostics[${index}].path is invalid`);
    }
    if (typeof diagnostic.detail !== "string" || !diagnostic.detail || diagnostic.detail.length > 2_000) {
      throw new Error(`candidate diagnostics[${index}].detail is invalid`);
    }
    return { path: diagnostic.path, detail: diagnostic.detail };
  });
}

function candidateEvidence(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("candidate evidence must be an object");
  }
  if (!['valid', 'invalid', 'missing'].includes(candidate.status)) {
    throw new Error("candidate status must be valid, invalid, or missing");
  }
  if (candidate.status === "valid") {
    if (!candidate.staged || typeof candidate.staged !== "object" || Array.isArray(candidate.staged)) {
      throw new Error("a valid candidate requires its staged envelope");
    }
    return { status: "valid", staged: candidate.staged };
  }
  return {
    status: candidate.status,
    diagnostics: boundedDiagnostics(candidate.diagnostics ?? [{
      path: "result_candidate",
      detail: candidate.status === "missing" ? "no result candidate was submitted" : "candidate is invalid",
    }]),
    ...(candidate.original_hash ? { original_hash: candidate.original_hash } : {}),
  };
}

function correctionAvailable({ nativeSessionId, correction, nowMs }) {
  return Boolean(nativeSessionId) && correction.round < correction.maxRounds && nowMs < correction.deadlineMs;
}

export function resultCorrectionProfile({
  attemptId,
  requestHash,
  definitionBundleHash,
  inputSubject,
  outputSubject,
  nativeSessionId,
  round,
  deadlineMs,
  diagnostics,
}) {
  if (!nativeSessionId) throw new Error("result correction requires the sealed native session");
  return {
    schema: "openthrottle.result-correction-profile/v1",
    phase: "result_correction",
    attempt_id: attemptId,
    request_hash: requestHash,
    definition_bundle_hash: definitionBundleHash,
    input_subject: inputSubject,
    output_subject: outputSubject,
    native_session_id: nativeSessionId,
    correction_round: round,
    deadline_ms: deadlineMs,
    repository_authority: "inspect",
    repository_subject_locked: true,
    allowed_tools: ["ot-result"],
    mcp_access: false,
    provider_access: false,
    publication_access: false,
    diagnostics: boundedDiagnostics(diagnostics),
  };
}

export function resultCorrectionTaskPrompt(profile) {
  if (profile?.schema !== "openthrottle.result-correction-profile/v1" ||
      profile.phase !== "result_correction") {
    throw new Error("result correction profile is invalid");
  }
  return [
    "The assigned work is already complete and its output subject is locked.",
    "Do not repeat implementation, review, tests, or repository inspection.",
    "Return exactly one openthrottle.result-candidate/v1 JSON object that fixes only the diagnosed semantic fields.",
    "The executor will submit provider-native structured output through the same ot-result validator and compare-and-set channel.",
    `Locked input subject: ${profile.input_subject}`,
    `Locked output subject: ${profile.output_subject ?? "(none; inspect action remains bound to its input subject)"}`,
    `Diagnostics: ${JSON.stringify(profile.diagnostics)}`,
  ].join("\n\n");
}

export function resultCorrectionLaunchContract({
  profile,
  engine,
  repositoryView,
  providerSchemaPath,
  resultEnvironment,
}) {
  resultCorrectionTaskPrompt(profile);
  if (!["claude", "codex", "opencode"].includes(engine)) {
    throw new Error("result correction engine is invalid");
  }
  if (typeof repositoryView !== "string" || !repositoryView.startsWith("/")) {
    throw new Error("result correction repository view is invalid");
  }
  if (typeof providerSchemaPath !== "string" || !providerSchemaPath.startsWith("/")) {
    throw new Error("result correction provider schema path is invalid");
  }
  if (!Array.isArray(resultEnvironment) || resultEnvironment.some((entry) =>
    typeof entry !== "string" || !/^OT_RESULT_(?:SCHEMA|CANDIDATE|REJECTION)_FILE=\//.test(entry))) {
    throw new Error("result correction environment is invalid");
  }
  return {
    schema: "openthrottle.result-correction-launch/v1",
    phase: "result_correction",
    engine,
    native_session_id: profile.native_session_id,
    repository_authority: "inspect",
    repository_view: repositoryView,
    locked_output_subject: profile.output_subject,
    provider_schema_path: providerSchemaPath,
    result_environment: [...resultEnvironment],
    allowed_tools: ["ot-result"],
    allowed_repository_commands: [],
    skill_ids: [],
    mcp_servers: [],
    external_provider_credentials: [],
    publication_credentials: [],
  };
}

export function settleResultSubmission({
  phase,
  engineExitedCleanly,
  checkpoint,
  checkpointFence,
  channel,
  engine,
  providerOutput,
  correction,
  nowMs,
}) {
  const verifiedCheckpoint = checkpoint === null || checkpoint === undefined
    ? null
    : assertVerifiedResultCheckpoint({ checkpoint, ...checkpointFence });
  // A non-clean provider stream is never promoted into the CAS. A candidate
  // explicitly submitted through ot-result before the crash remains visible
  // as recovery evidence, but settleActionResult still reports a genuine work
  // failure below.
  const candidate = engineExitedCleanly && providerOutput !== undefined
    ? submitProviderResultCandidate({ raw: providerOutput, engine, channel })
    : inspectResultSubmissionChannel(channel);
  return settleActionResult({
    phase,
    engineExitedCleanly,
    checkpoint: verifiedCheckpoint,
    candidate,
    correction,
    nowMs,
  });
}

export function settleActionResult({
  phase,
  engineExitedCleanly,
  checkpoint,
  candidate,
  correction = { round: 0, maxRounds: 2, deadlineMs: Number.MAX_SAFE_INTEGER },
  nowMs = Date.now(),
}) {
  if (!RESULT_REPAIR_PHASES.includes(phase)) throw new Error(`unsupported result phase ${phase}`);
  const evidence = candidateEvidence(candidate);
  const round = nonNegativeInteger(correction.round, "correction.round");
  const maxRounds = nonNegativeInteger(correction.maxRounds, "correction.maxRounds");
  const deadlineMs = nonNegativeInteger(correction.deadlineMs, "correction.deadlineMs");
  if (round > maxRounds) throw new Error("correction.round must not exceed correction.maxRounds");

  if (!engineExitedCleanly) {
    return {
      state: phase === "work" ? "work_failed" : "needs_human",
      reason: phase === "work" ? "non_clean_work_exit" : "non_clean_result_correction_exit",
      candidate: evidence,
      checkpoint: checkpoint ?? null,
    };
  }
  if (!checkpoint) {
    return {
      state: phase === "work" ? "work_failed" : "needs_human",
      reason: "missing_verified_checkpoint",
      candidate: evidence,
      checkpoint: null,
    };
  }
  if (evidence.status === "valid") {
    return {
      state: "work_complete",
      phase,
      checkpoint,
      candidate: evidence.staged,
      correction_rounds_used: round,
    };
  }

  const nextRound = phase === "work" ? 1 : round + 1;
  const availability = {
    nativeSessionId: checkpoint.native_session_id,
    correction: { round: nextRound - 1, maxRounds, deadlineMs },
    nowMs,
  };
  if (correctionAvailable(availability) && nextRound <= maxRounds) {
    return {
      state: "result_pending",
      reason: evidence.status === "missing" ? "missing_candidate" : "invalid_candidate",
      checkpoint,
      candidate: evidence,
      correction: resultCorrectionProfile({
        attemptId: checkpoint.attempt_id,
        requestHash: checkpoint.request_hash,
        definitionBundleHash: checkpoint.definition_bundle_hash,
        inputSubject: checkpoint.input_subject,
        outputSubject: checkpoint.output_subject,
        nativeSessionId: checkpoint.native_session_id,
        round: nextRound,
        deadlineMs,
        diagnostics: evidence.diagnostics,
      }),
    };
  }
  return {
    state: "needs_human",
    reason: checkpoint.native_session_id
      ? nowMs >= deadlineMs ? "result_correction_deadline_exhausted" : "result_correction_budget_exhausted"
      : "result_correction_session_unavailable",
    checkpoint,
    candidate: evidence,
    correction_rounds_used: round,
  };
}
