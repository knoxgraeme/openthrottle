#!/usr/bin/env node

import { sanitizeArtifactText } from "./artifacts.mjs";

// Bounded launch diagnostics. Every agent-launch failure used to reach the
// operator as one indistinguishable line with an empty `Executor diagnostic:`
// because only stderr was captured and the engines report launch refusals on
// stdout (Claude writes stream-json to stdout; Codex prints its refusal there
// too). The tail below is the operator-visible evidence, so it stays small and
// always passes through the artifact sanitizer.
export const MAX_LAUNCH_DIAGNOSTIC_CHARS = 2_000;

// The single concrete credential each engine authenticates with. Only the
// variable NAME is ever surfaced; the value never leaves this process.
export const ENGINE_CREDENTIAL_ENV = Object.freeze({
  claude: "CLAUDE_CODE_OAUTH_TOKEN",
  codex: "CODEX_AUTH_JSON",
  opencode: "KIMI_CODE_API_KEY",
});

export const LAUNCH_FAILURE_REASONS = Object.freeze([
  "credential_missing",
  "credential_rejected",
  "rate_limited",
  "engine_crash",
]);

// Claude's stream-json carries a `rate_limit_event`; only these statuses mean
// the request was actually served. `allowed_warning` is the high-utilization
// warning that healthy runs emit, so it must not be read as a refusal.
const SERVED_RATE_LIMIT_STATUSES = new Set(["allowed", "allowed_warning"]);

const RATE_LIMIT_PATTERNS = [
  /rate[ _-]?limit/i,
  /\b429\b/,
  /too many requests/i,
  /usage limit/i,
  /quota (?:exceeded|exhausted|reached)/i,
  /out of credits/i,
  /insufficient (?:credits|quota|balance|funds)/i,
  /credit balance is too low/i,
  /(?:hit|reached|exceeded) your .{0,40}limit/i,
  /overloaded/i,
];

const CREDENTIAL_REJECTED_PATTERNS = [
  /\b401\b/,
  /unauthorized/i,
  /invalid[ _-](?:api[ _-]key|oauth[ _-]token|token|credentials?)/i,
  /(?:api[ _-]key|oauth[ _-]token|token|credential)s? (?:is |are |was |has )?(?:invalid|expired|revoked|rejected)/i,
  // `authentication_error` is the engine/API error type. A bare "Authentication
  // failed" is what git prints for a repository token, which is a different
  // credential and must not be attributed to the engine.
  /authentication[_-]error/i,
  /refresh_token_invalidated/i,
  /your session has ended/i,
  /invalid_grant/i,
  /please run [`"']?\/?login/i,
];

const CREDENTIAL_MISSING_PATTERNS = [
  /not logged ?in/i,
  /no (?:api[ _-]key|credentials?|auth(?:entication)?[ _-]token|oauth[ _-]token)\b/i,
  /missing (?:api[ _-]key|credentials?|auth(?:entication)?[ _-]token|oauth[ _-]token)/i,
  /(?:CLAUDE_CODE_OAUTH_TOKEN|CODEX_AUTH_JSON|KIMI_CODE_API_KEY)[^\n]{0,60}(?:not set|unset|empty|missing|required)/i,
  /credentials? (?:are|is) (?:not set|unset|missing|empty)/i,
  /(?:run|use) `?(?:claude|codex|opencode) login`?/i,
];

function matchesAny(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

// A rate-limit refusal can appear either as `{"rate_limit":{"status":...}}` or
// as a flat `{"subtype":"rate_limit_event","status":...}` line, so the scan
// walks bounded JSON looking for a status reached under a rate-limit key.
function rejectedRateLimitStatus(node, underRateLimit, depth) {
  if (!node || typeof node !== "object" || depth > 8) return false;
  if (Array.isArray(node)) {
    return node.some((child) => rejectedRateLimitStatus(child, underRateLimit, depth + 1));
  }
  const selfIsRateLimit = underRateLimit ||
    /rate[ _-]?limit/i.test(String(node.type ?? "")) ||
    /rate[ _-]?limit/i.test(String(node.subtype ?? ""));
  if (selfIsRateLimit && typeof node.status === "string" &&
      !SERVED_RATE_LIMIT_STATUSES.has(node.status.trim().toLowerCase())) {
    return true;
  }
  return Object.entries(node).some(([key, value]) =>
    rejectedRateLimitStatus(value, selfIsRateLimit || /rate[ _-]?limit/i.test(key), depth + 1));
}

export function hasRejectedRateLimitEvent(text) {
  const raw = String(text ?? "");
  if (!/rate[ _-]?limit/i.test(raw)) return false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !/rate[ _-]?limit/i.test(trimmed)) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (rejectedRateLimitStatus(parsed, false, 0)) return true;
  }
  return false;
}

// Claude emits a `rate_limit_event` line on healthy runs too (including the
// high-utilization `allowed_warning`). Those lines must not make the generic
// rate-limit text patterns fire, so they are dropped before pattern matching;
// a genuinely rejected event is detected structurally above instead.
function withoutServedRateLimitLines(text) {
  return text.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !/rate[ _-]?limit/i.test(trimmed)) return true;
    try {
      JSON.parse(trimmed);
    } catch {
      return true;
    }
    return false;
  }).join("\n");
}

export function engineCredentialVariable(agent) {
  return ENGINE_CREDENTIAL_ENV[agent];
}

// `undefined` means "unknown" (no environment was supplied); callers that know
// the exact environment handed to the engine pass it so an absent or empty
// credential becomes positive evidence instead of a guess from output text.
export function engineCredentialPresent(agent, env, extraEvidence = false) {
  const variable = engineCredentialVariable(agent);
  if (!variable || !env) return undefined;
  if (extraEvidence) return true;
  return String(env[variable] ?? "").trim().length > 0;
}

function remediationFor(reason, agent) {
  const variable = engineCredentialVariable(agent) ?? "the engine credential";
  if (reason === "credential_missing") {
    return `The ${agent} engine credential ${variable} was empty or absent when the engine launched; configure it on the supervisor.`;
  }
  if (reason === "credential_rejected") {
    return `The ${agent} engine rejected its credential ${variable}; it is invalid, expired, or revoked.`;
  }
  if (reason === "rate_limited") {
    return `The ${agent} engine refused the request with a usage, quota, or rate limit.`;
  }
  return "";
}

// A timed-out, signaled, or non-zero-exit engine process has no complete
// transcript to seal -- sealing predictably fails for a reason that is only
// a symptom of the exit itself, so callers gate sealing (never classification)
// on this before attempting it.
export function engineExitedCleanly({ timedOut, signal, status }) {
  return !timedOut && !signal && status === 0;
}

/**
 * Classifies why an agent process died before producing terminal evidence.
 * `credentialPresent` is the authoritative signal when it is known; text
 * patterns only ever narrow an otherwise generic engine crash.
 */
export function classifyLaunchFailure({
  agent,
  stdout = "",
  stderr = "",
  credentialPresent,
}) {
  const text = `${String(stderr ?? "")}\n${String(stdout ?? "")}`;
  const prose = withoutServedRateLimitLines(text);
  let reason = "engine_crash";
  if (credentialPresent === false) {
    reason = "credential_missing";
  } else if (hasRejectedRateLimitEvent(text) || matchesAny(RATE_LIMIT_PATTERNS, prose)) {
    reason = "rate_limited";
  } else if (matchesAny(CREDENTIAL_REJECTED_PATTERNS, prose)) {
    reason = "credential_rejected";
  } else if (matchesAny(CREDENTIAL_MISSING_PATTERNS, prose)) {
    reason = "credential_missing";
  }
  return {
    reason,
    credentialFailure: reason === "credential_missing" || reason === "credential_rejected",
    // Neither a missing/rejected credential nor a provider usage limit is the
    // agent's fault, so they stay infrastructure-shaped and must not consume a
    // semantic repair round. An engine crash keeps the caller's own shape.
    retryable: reason !== "engine_crash",
    remediation: remediationFor(reason, agent),
  };
}

// The fields that ARE the diagnosis on Claude's final stream-json `result`
// line. They sit at the head of that line, ahead of the (often long)
// `result` text itself, so a byte-level tail of the whole stdout stream
// reliably keeps only the trailing fragment of `result` and drops the rest --
// on a long transcript that is every bit of information that matters.
const DECISIVE_ENGINE_RESULT_FIELDS = ["subtype", "is_error", "api_error_status", "result"];

// Extracted here unsanitized and untruncated -- launchDiagnosticTail sanitizes
// the formatted prefix before ever slicing it, so a credential value never
// gets cut in half ahead of the substring-match redaction that would
// otherwise fail to recognize the truncated fragment.
function decisiveEngineFieldsFromFinalResultLine(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index].trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || parsed.type !== "result") continue;
    const fields = {};
    for (const key of DECISIVE_ENGINE_RESULT_FIELDS) {
      if (parsed[key] === undefined) continue;
      fields[key] = parsed[key];
    }
    return Object.keys(fields).length > 0 ? fields : null;
  }
  return null;
}

function formatDecisiveEngineFields(fields) {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
}

/**
 * Bounded, sanitized tail of both engine streams. stderr leads (it is where a
 * crash lands) but stdout always keeps at least half the budget, because that
 * is where every engine writes its launch refusal. The decisive fields from
 * Claude's final stream-json `result` line (subtype, is_error,
 * api_error_status, result) are extracted and prepended first, so they
 * survive even when the tail budget alone would cut them off.
 */
export function launchDiagnosticTail({
  stdout = "",
  stderr = "",
  env = process.env,
  max = MAX_LAUNCH_DIAGNOSTIC_CHARS,
} = {}) {
  const budget = Math.max(0, max);
  const cleanStderr = sanitizeArtifactText(stderr ?? "", env).trim();
  const cleanStdout = sanitizeArtifactText(stdout ?? "", env).trim();
  if (!cleanStderr && !cleanStdout) return "";
  const decisiveFields = decisiveEngineFieldsFromFinalResultLine(stdout);
  // Sanitize the whole formatted prefix before ever slicing it (never
  // truncate a raw field first -- that can cut a credential value in half
  // and defeat the sanitizer's exact substring match), then cap it to at
  // most half the budget so an oversized/malformed engine field can never
  // exhaust the remaining budget down to zero.
  const decisivePrefix = decisiveFields
    ? sanitizeArtifactText(formatDecisiveEngineFields(decisiveFields), env).trim().slice(0, Math.floor(budget / 2))
    : "";
  const separator = " | ";
  const remainingBudget = Math.max(0, budget - decisivePrefix.length - (decisivePrefix ? separator.length : 0));
  const stderrBudget = cleanStdout
    ? Math.max(Math.floor(remainingBudget / 2), remainingBudget - cleanStdout.length - separator.length)
    : remainingBudget;
  // A zero-or-negative budget must yield an empty tail: `slice(-0)` is
  // equivalent to `slice(0)` in JavaScript and returns the entire string,
  // not an empty one, so `-Math.max(0, n)` cannot be used to represent "no
  // characters" -- it must short-circuit instead.
  const stderrTail = stderrBudget > 0 ? cleanStderr.slice(-stderrBudget) : "";
  const stdoutBudget = remainingBudget - stderrTail.length - (stderrTail && cleanStdout ? separator.length : 0);
  const stdoutTail = stdoutBudget > 0 ? cleanStdout.slice(-stdoutBudget) : "";
  return [
    decisivePrefix,
    stderrTail ? `stderr: ${stderrTail}` : "",
    stdoutTail ? `stdout: ${stdoutTail}` : "",
  ].filter(Boolean).join(separator);
}
