#!/usr/bin/env node

import { existsSync, readFileSync, rmSync } from "node:fs";

// Mirrors the Daytona adapter's sandbox-eligible credential allowlist
// (supervisor/src/providers/daytona/adapter.ts). Kept as an independent,
// closed set here so a compromised or buggy credential materializer can
// never hand an operator-only secret (Daytona/Fly/webhook/install/Linear)
// to a loop action even if the adapter-side check were bypassed.
export const LOOP_CREDENTIAL_ENV_NAMES = new Set([
  "GITHUB_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_AUTH_JSON",
  "KIMI_CODE_API_KEY",
]);

const MAX_CREDENTIAL_ENVELOPE_BYTES = 64 * 1024;

function validateCredentialEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("loop action credential envelope must be an object");
  }
  const input = value;
  const unknownKey = Object.keys(input).find((key) => key !== "env");
  if (unknownKey) throw new Error(`loop action credential envelope has unknown field ${unknownKey}`);
  const env = input.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("loop action credential envelope env must be an object");
  }
  const result = {};
  for (const [name, envValue] of Object.entries(env)) {
    if (!LOOP_CREDENTIAL_ENV_NAMES.has(name)) {
      throw new Error(`loop action credential envelope names forbidden variable ${name}`);
    }
    if (typeof envValue !== "string" || envValue.length === 0 || envValue.length > 16_384) {
      throw new Error(`loop action credential envelope value for ${name} is invalid`);
    }
    result[name] = envValue;
  }
  return result;
}

// Reads, validates, and immediately deletes the sealed per-action credential
// envelope so its bytes cannot be observed by a later action, a retained
// failed worktree, or a subsequent read of this same action directory. Safe
// to call more than once (idempotent after a restart): a missing envelope
// yields `null` rather than an error, because a missing envelope is only
// ever legitimate for a role with no declared credential scopes (the caller,
// which knows the request's credentialScopes, is the one that can tell that
// apart from an engine invocation that needed a credential and never got
// one -- this function only reports presence, never adjudicates it).
export function readLoopActionCredentialEnv(path) {
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    // Best-effort delete on the failure path too, but never let a delete
    // error mask the real read failure -- the read failure is the one worth
    // diagnosing at this security-sensitive boundary.
    try {
      rmSync(path, { force: true });
    } catch {
      // Ignored: the read error above is the one that matters.
    }
    throw error;
  }
  rmSync(path, { force: true });
  if (Buffer.byteLength(raw, "utf8") > MAX_CREDENTIAL_ENVELOPE_BYTES) {
    throw new Error("loop action credential envelope exceeds 64 KiB");
  }
  return validateCredentialEnvelope(JSON.parse(raw));
}
