#!/usr/bin/env node

import { sanitizeArtifactText } from "./kernel-json.mjs";

// Bounded launch diagnostics. Classification may inspect the complete in-memory
// engine transcript, but durable evidence receives only this allowlisted
// provider-metadata projection. Assistant text, tool output, final-result prose,
// and raw stdout/stderr are secret-bearing untrusted data and never cross into a
// persisted failure reason.
export const MAX_LAUNCH_DIAGNOSTIC_CHARS = 2_000;

// The single concrete credential each engine authenticates with. Only the
// variable NAME is ever surfaced; the value never leaves this process.
export const ENGINE_CREDENTIAL_ENV = Object.freeze({
  claude: "CLAUDE_CODE_OAUTH_TOKEN",
  codex: "CODEX_AUTH_JSON",
  opencode: "KIMI_CODE_API_KEY",
});

// OPE-104: an untraversable sandbox root let Claude launch without ever
// resolving its own skill discovery root, so it silently registered zero
// user skills, answered this exact prefix for the requested slash command,
// and exited 0 with no other symptom -- a clean-looking exit that is
// actually a launch failure. Matched against the engine's own final `result`
// text (see decisiveEngineFieldsFromFinalResultLine below), not the raw
// stdout stream, since that is where the engine's literal answer lives.
const UNREGISTERED_COMMAND_PREFIX = "Unknown command: /";

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

function jsonObjectFromLine(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// A real Claude rate-limit event is either explicitly named by type/subtype,
// or is a system/root event carrying the documented `rate_limit` object. Do
// not recursively inspect arbitrary event payloads: assistant and tool output
// are untrusted task content and may legitimately discuss the same vocabulary.
function rateLimitStatusFromEvent(event) {
  const type = typeof event.type === "string" ? event.type.trim().toLowerCase() : "";
  const subtype = typeof event.subtype === "string" ? event.subtype.trim().toLowerCase() : "";
  if (["assistant", "user", "tool", "item.completed", "item.updated", "item.started"].includes(type)) {
    return null;
  }
  const explicitlyRateLimit = /rate[ _-]?limit/.test(type) || /rate[ _-]?limit/.test(subtype);
  const nested = event.rate_limit && typeof event.rate_limit === "object" && !Array.isArray(event.rate_limit)
    ? event.rate_limit
    : null;
  const isRootOrSystemEvent = type === "" || type === "system";
  if (!explicitlyRateLimit && !(isRootOrSystemEvent && nested)) return null;
  const status = nested?.status ?? event.status;
  return typeof status === "string" ? status.trim().toLowerCase() : null;
}

export function hasRejectedRateLimitEvent(text) {
  const raw = String(text ?? "");
  if (!/rate[ _-]?limit/i.test(raw)) return false;
  for (const line of raw.split("\n")) {
    const event = jsonObjectFromLine(line);
    if (!event) continue;
    const status = rateLimitStatusFromEvent(event);
    if (status && !SERVED_RATE_LIMIT_STATUSES.has(status)) return true;
  }
  return false;
}

function claudeFinalResultFailureEvidence(stdout) {
  const fields = decisiveEngineFieldsFromFinalResultLine(stdout);
  if (!fields) return "";
  const status = Number(fields.api_error_status);
  const errorBearing = fields.is_error === true ||
    (Number.isFinite(status) && status >= 400) ||
    /(?:error|fail|refus|reject)/i.test(String(fields.subtype ?? ""));
  return errorBearing ? formatDecisiveEngineFields(fields) : "";
}

function codexFailureEvidence(event) {
  if (event.type === "turn.failed") {
    return typeof event.error === "string" ? event.error : JSON.stringify(event.error ?? {});
  }
  if (event.type !== "error") return "";
  const fields = {};
  for (const key of ["message", "error", "code", "status", "status_code"]) {
    if (event[key] !== undefined) fields[key] = event[key];
  }
  return JSON.stringify(fields);
}

// stdout is a provider JSONL transcript. Only provider-owned terminal error
// events are classification evidence; assistant/tool events are task content.
// Plain non-JSON stdout remains eligible because both CLIs can reject a launch
// before their structured event stream starts.
function stdoutFailureEvidence(agent, stdout) {
  const evidence = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const event = jsonObjectFromLine(trimmed);
    if (!event) {
      evidence.push(trimmed);
      continue;
    }
    if (agent === "codex") {
      const codexEvidence = codexFailureEvidence(event);
      if (codexEvidence) evidence.push(codexEvidence);
    }
  }
  if (agent === "claude") {
    const finalResult = claudeFinalResultFailureEvidence(stdout);
    if (finalResult) evidence.push(finalResult);
  }
  return evidence.join("\n");
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
  if (reason === "unregistered_command") {
    return `The ${agent} engine did not register its requested skill as a known command before answering; the sandbox skill discovery root may be untraversable or the skill package may be missing.`;
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
  const evidence = `${String(stderr ?? "")}\n${stdoutFailureEvidence(agent, stdout)}`;
  let reason = "engine_crash";
  if (isUnregisteredCommandResult(stdout)) {
    reason = "unregistered_command";
  } else if (credentialPresent === false) {
    reason = "credential_missing";
  } else if (hasRejectedRateLimitEvent(stdout) || matchesAny(RATE_LIMIT_PATTERNS, evidence)) {
    reason = "rate_limited";
  } else if (matchesAny(CREDENTIAL_REJECTED_PATTERNS, evidence)) {
    reason = "credential_rejected";
  } else if (matchesAny(CREDENTIAL_MISSING_PATTERNS, evidence)) {
    reason = "credential_missing";
  }
  return {
    reason,
    credentialFailure: reason === "credential_missing" || reason === "credential_rejected",
    // A rejected credential cannot change during a kernel work retry. Retrying
    // it would only seed the same supervisor-owned credential again and burn
    // the Attempt's full retry ladder. Other infrastructure-shaped failures
    // retain their existing retry policy; an engine crash keeps the caller's
    // own shape.
    retryable: reason !== "engine_crash" && reason !== "credential_rejected",
    remediation: remediationFor(reason, agent),
  };
}

// These fields are inspected in-memory to classify Claude's final stream-json
// `result` line. `result` is intentionally excluded from durable diagnostics;
// it is assistant-authored prose and may contain credential material.
const DECISIVE_ENGINE_RESULT_FIELDS = ["subtype", "is_error", "api_error_status", "result"];

// Extracted here only for in-memory classification. Callers must not persist
// the returned object or its `result` field.
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

// True when the engine's own final answer is an unregistered-command
// refusal -- a clean-looking (often exit 0) response that is nonetheless not
// a real completion: the requested skill was never discoverable, so nothing
// downstream (a result candidate or real work) was ever produced. Read from
// the engine's own final `result` text rather than scanning raw stdout: a
// legitimate transcript can otherwise quote or discuss that exact phrase
// without it being the engine's own terminal answer.
export function isUnregisteredCommandResult(stdout) {
  const fields = decisiveEngineFieldsFromFinalResultLine(stdout);
  const result = typeof fields?.result === "string" ? fields.result : "";
  return result.startsWith(UNREGISTERED_COMMAND_PREFIX);
}

function formatDecisiveEngineFields(fields) {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
}

const SAFE_PROVIDER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}$/;
const SAFE_SCHEMA_SEGMENT = /^[A-Za-z0-9_-]{1,80}$/;
const SAFE_RUNTIME_ERROR_CODES = [
  "EACCES", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "EIO", "EMFILE",
  "ENOENT", "ENOMEM", "ENOSPC", "ENOTFOUND", "EPIPE", "ETIMEDOUT",
];

function addMetadata(output, key, value) {
  let normalized;
  if (typeof value === "boolean") normalized = String(value);
  else if (typeof value === "number" && Number.isSafeInteger(value)) normalized = String(value);
  else if (typeof value === "string" && SAFE_PROVIDER_TOKEN.test(value.trim())) {
    normalized = value.trim();
  } else {
    return;
  }
  const entry = `${key}=${normalized}`;
  if (!output.includes(entry)) output.push(entry);
}

function addProviderStatus(output, value) {
  const normalized = typeof value === "string" && /^\d{3}$/.test(value.trim())
    ? Number(value.trim())
    : value;
  if (Number.isSafeInteger(normalized) && normalized >= 100 && normalized <= 599) {
    addMetadata(output, "provider_status", normalized);
  }
}

function schemaPathFromMessage(text) {
  const tuple = /\bIn context=\(([^)\r\n]{1,1024})\)/i.exec(text);
  if (tuple) {
    const values = [...tuple[1].matchAll(/["']([A-Za-z0-9_-]{1,80})["']/g)]
      .map((match) => match[1]);
    const residue = tuple[1].replace(/["'][A-Za-z0-9_-]{1,80}["']/g, "");
    if (values.length > 0 && values.length <= 24 && /^[,\s]*$/.test(residue)) {
      return values.join(".");
    }
  }
  const dotted = /\bproperties(?:\.[A-Za-z0-9_-]{1,80}){1,23}\b/.exec(text)?.[0];
  return dotted && dotted.split(".").every((segment) => SAFE_SCHEMA_SEGMENT.test(segment))
    ? dotted
    : null;
}

function addInvalidSchemaMetadata(output, text, allowDetails) {
  if (!/(?:invalid[ _-]json[ _-]schema|invalid schema for response_format)/i.test(text)) return;
  addMetadata(output, "provider_error", "invalid_json_schema");
  if (!allowDetails) return;
  const path = schemaPathFromMessage(text);
  if (path) addMetadata(output, "schema_path", path);
  if (/(?:must|does not) have (?:a )?["']?type\b|["']type["'] is required/i.test(text)) {
    addMetadata(output, "schema_issue", "missing_type");
  } else if (/["']required["'] is required to be supplied|array including every key in properties/i.test(text)) {
    addMetadata(output, "schema_issue", "incomplete_required_keys");
  } else if (/additionalProperties[^\r\n]{0,80}(?:false|required)/i.test(text)) {
    addMetadata(output, "schema_issue", "additional_properties_not_closed");
  }
  const missing = /\bMissing ["']([A-Za-z0-9_-]{1,80})["']/i.exec(text)?.[1];
  if (missing) addMetadata(output, "missing_key", missing);
  if (/\buniqueItems\b/.test(text)) addMetadata(output, "unsupported_keyword", "uniqueItems");
}

function addSafeTextMetadata(output, value, { allowSchemaDetails = false } = {}) {
  if (typeof value !== "string" || value.length === 0) return;
  addInvalidSchemaMetadata(output, value, allowSchemaDetails);
  if (matchesAny(RATE_LIMIT_PATTERNS, value)) {
    addMetadata(output, "provider_error", "rate_limited");
  }
  if (matchesAny(CREDENTIAL_REJECTED_PATTERNS, value)) {
    addMetadata(output, "provider_error", "credential_rejected");
  } else if (matchesAny(CREDENTIAL_MISSING_PATTERNS, value)) {
    addMetadata(output, "provider_error", "credential_missing");
  }
  if (/\b(?:Bus error|Segmentation fault|core dumped)\b/i.test(value)) {
    addMetadata(output, "runtime_error", "process_crash");
  }
  if (/\bspawn\b[^\r\n]{0,80}\b(?:fail(?:ed|ure)?|error)\b/i.test(value)) {
    addMetadata(output, "runtime_error", "spawn_failure");
  }
  if (/executor-sealed action profile|action profile seal/i.test(value)) {
    addMetadata(output, "runtime_error", "profile_seal_changed");
  }
  for (const code of SAFE_RUNTIME_ERROR_CODES) {
    if (new RegExp(`\\b${code}\\b`).test(value)) addMetadata(output, "runtime_error", code);
  }
  const status = /\b(?:http|status|api error)\D{0,16}([1-5]\d{2})\b/i.exec(value)?.[1];
  if (status) addProviderStatus(output, status);
}

function providerErrorObjects(event) {
  const result = [];
  let current = event?.error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) break;
    result.push(current);
    current = current.error;
  }
  return result;
}

function providerEventMetadata(event) {
  const type = typeof event?.type === "string" ? event.type.trim() : "";
  const output = [];
  if (type === "result") {
    addMetadata(output, "provider_event", type);
    addMetadata(output, "subtype", event.subtype);
    if (typeof event.is_error === "boolean") addMetadata(output, "is_error", event.is_error);
    addProviderStatus(output, event.api_error_status);
    return output;
  }
  const rateLimitStatus = rateLimitStatusFromEvent(event);
  if (rateLimitStatus !== null) {
    addMetadata(output, "provider_event", type || "rate_limit");
    addMetadata(output, "subtype", event.subtype);
    addMetadata(output, "rate_limit_status", rateLimitStatus);
    return output;
  }
  if (type !== "error" && type !== "turn.failed") return output;
  addMetadata(output, "provider_event", type);
  const errorObjects = providerErrorObjects(event);
  for (const error of errorObjects) {
    addMetadata(output, "error_type", error.type);
    addMetadata(output, "error_code", error.code);
    addProviderStatus(output, error.status ?? error.status_code);
    addMetadata(output, "error_param", error.param);
  }
  addMetadata(output, "error_code", event.code);
  addProviderStatus(output, event.status ?? event.status_code);
  addMetadata(output, "error_param", event.param);
  const messages = [
    event.message,
    typeof event.error === "string" ? event.error : null,
    ...errorObjects.flatMap((error) => [
      error.message,
      typeof error.error === "string" ? error.error : null,
    ]),
  ];
  for (const message of messages) {
    addSafeTextMetadata(output, message, { allowSchemaDetails: true });
  }
  return output;
}

function boundedMetadata(fields, budget, env) {
  const output = [];
  for (const field of fields) {
    const next = [...output, field].join(" ");
    if (next.length > budget) break;
    output.push(field);
  }
  return sanitizeArtifactText(output.join(" "), env);
}

/**
 * Project allowlisted provider-owned metadata from engine output. Full streams
 * remain available in-memory for classification only and are never returned.
 */
export function launchDiagnosticTail({
  stdout = "",
  stderr = "",
  env = process.env,
  max = MAX_LAUNCH_DIAGNOSTIC_CHARS,
} = {}) {
  const budget = Math.max(0, max);
  if (budget === 0) return "";
  const fields = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const event = jsonObjectFromLine(line);
    if (event) {
      for (const field of providerEventMetadata(event)) {
        if (!fields.includes(field)) fields.push(field);
      }
    } else {
      addSafeTextMetadata(fields, line);
    }
  }
  addSafeTextMetadata(fields, String(stderr ?? ""));
  return boundedMetadata(fields, budget, env);
}
