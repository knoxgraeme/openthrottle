import { describe, expect, it } from "vitest";
import {
  MAX_LAUNCH_DIAGNOSTIC_CHARS,
  classifyLaunchFailure,
  engineCredentialPresent,
  hasRejectedRateLimitEvent,
  isUnregisteredCommandResult,
  launchDiagnosticTail,
} from "./launch-failure.mjs";

// Shaped like a real Claude Code stream-json line. The status is what decides
// the classification: `allowed` and `allowed_warning` are served requests.
function claudeRateLimitLine(status) {
  return JSON.stringify({
    type: "system",
    subtype: "rate_limit_event",
    rate_limit: {
      status,
      unified_rate_limit_fallback_available: false,
      resets_at: 1_754_006_400,
    },
    session_id: "0199a1de-0000-7000-8000-000000000000",
  });
}

describe("launch failure classification", () => {
  it("reports a missing engine credential from the environment handed to the engine", () => {
    const classified = classifyLaunchFailure({
      agent: "claude",
      stdout: "",
      stderr: "",
      credentialPresent: engineCredentialPresent("claude", { CLAUDE_CODE_OAUTH_TOKEN: "" }),
    });
    expect(classified).toMatchObject({
      reason: "credential_missing",
      credentialFailure: true,
      credentialFailureProvenance: "environment",
      retryable: false,
    });
    expect(classified.remediation).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("treats an absent credential variable as missing and a populated one as present", () => {
    expect(engineCredentialPresent("codex", {})).toBe(false);
    expect(engineCredentialPresent("codex", { CODEX_AUTH_JSON: "{\"tokens\":{}}" })).toBe(true);
    // A readable ~/.codex/auth.json counts even without the seed variable.
    expect(engineCredentialPresent("codex", {}, true)).toBe(true);
    // No environment supplied means "unknown", never "missing".
    expect(engineCredentialPresent("codex", undefined)).toBeUndefined();
  });

  it("reports a rejected credential from engine output", () => {
    const classified = classifyLaunchFailure({
      agent: "claude",
      stdout: "",
      stderr: "API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid oauth token\"}}",
      credentialPresent: true,
    });
    expect(classified).toMatchObject({
      reason: "credential_rejected",
      credentialFailure: true,
      credentialFailureProvenance: "heuristic",
      retryable: true,
    });
  });

  it("ignores authentication language in a Claude assistant message", () => {
    const event = {
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: "The endpoint correctly returns 401 Unauthorized for missing credentials.",
        }],
        rate_limit: { status: "rejected" },
      },
    };
    const stdout = JSON.stringify(event);
    expect(hasRejectedRateLimitEvent(stdout)).toBe(false);
    expect(classifyLaunchFailure({
      agent: "claude",
      stdout,
      stderr: "Bus error: 10",
      credentialPresent: true,
    })).toMatchObject({
      reason: "engine_crash",
      credentialFailure: false,
      credentialFailureProvenance: null,
      retryable: false,
    });
  });

  it("ignores authentication language in a Codex agent message", () => {
    const stdout = JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_1",
        type: "agent_message",
        text: "The endpoint correctly returns 401 Unauthorized for missing credentials.",
      },
    });
    expect(classifyLaunchFailure({
      agent: "codex",
      stdout,
      stderr: "Bus error: 10",
      credentialPresent: true,
    })).toMatchObject({
      reason: "engine_crash",
      credentialFailure: false,
      credentialFailureProvenance: null,
      retryable: false,
    });
  });

  it("ignores provider-like language in structured tool output", () => {
    const stdout = JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_2",
        type: "command_execution",
        command: "npm test",
        aggregated_output: "fixture response: 429 Too Many Requests; invalid API key",
        exit_code: 1,
      },
    });
    expect(classifyLaunchFailure({
      agent: "codex",
      stdout,
      stderr: "Segmentation fault",
      credentialPresent: true,
    }).reason).toBe("engine_crash");
  });

  it("reports a rejected credential from Claude's error-bearing final result", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      api_error_status: 401,
      result: "API Error: authentication_error: invalid oauth token",
    });
    expect(classifyLaunchFailure({ agent: "claude", stdout, stderr: "", credentialPresent: true }))
      .toMatchObject({
        reason: "credential_rejected",
        credentialFailure: true,
        credentialFailureProvenance: "provider_event",
        retryable: true,
      });
  });

  it("does not treat Claude's assistant-authored final result prose as credential evidence", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      api_error_status: 500,
      result: "API Error: 401 authentication_error: invalid oauth token",
    });
    expect(classifyLaunchFailure({ agent: "claude", stdout, stderr: "", credentialPresent: true }))
      .toMatchObject({
        reason: "engine_crash",
        credentialFailure: false,
        credentialFailureProvenance: null,
        retryable: false,
      });
  });

  it("reports a rate limit from a rejected Claude rate_limit_event", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
      claudeRateLimitLine("rejected"),
    ].join("\n");
    expect(hasRejectedRateLimitEvent(stdout)).toBe(true);
    expect(classifyLaunchFailure({ agent: "claude", stdout, stderr: "", credentialPresent: true }))
      .toMatchObject({ reason: "rate_limited", credentialFailure: false, retryable: true });
  });

  it("does not read a served rate_limit_event as a refusal", () => {
    for (const status of ["allowed", "allowed_warning"]) {
      expect(hasRejectedRateLimitEvent(claudeRateLimitLine(status))).toBe(false);
      expect(classifyLaunchFailure({
        agent: "claude",
        stdout: `${claudeRateLimitLine(status)}\nSegmentation fault`,
        stderr: "",
        credentialPresent: true,
      }).reason).toBe("engine_crash");
    }
  });

  it("reports exhausted credits and quota refusals as rate limits", () => {
    for (const output of [
      "You've run out of credits. Add credits to continue using Codex.",
      "stream error: 429 Too Many Requests",
      "You have hit your weekly usage limit; it resets on Monday.",
    ]) {
      expect(classifyLaunchFailure({ agent: "codex", stdout: output, stderr: "", credentialPresent: true }))
        .toMatchObject({ reason: "rate_limited", credentialFailure: false, retryable: true });
    }
  });

  it("reports Codex error and turn.failed provider refusals", () => {
    for (const stdout of [
      JSON.stringify({ type: "error", message: "stream error: 429 Too Many Requests" }),
      JSON.stringify({ type: "turn.failed", error: { message: "You've run out of credits." } }),
    ]) {
      expect(classifyLaunchFailure({ agent: "codex", stdout, stderr: "", credentialPresent: true }))
        .toMatchObject({ reason: "rate_limited", credentialFailure: false, retryable: true });
    }
  });

  it("reports a Codex turn.failed authentication refusal", () => {
    const stdout = JSON.stringify({
      type: "turn.failed",
      error: { message: "401 Unauthorized: token is invalid" },
    });
    expect(classifyLaunchFailure({ agent: "codex", stdout, stderr: "", credentialPresent: true }))
      .toMatchObject({
        reason: "credential_rejected",
        credentialFailure: true,
        credentialFailureProvenance: "provider_event",
        retryable: true,
      });
  });

  it("falls back to an engine crash for anything else", () => {
    const classified = classifyLaunchFailure({
      agent: "opencode",
      stdout: "",
      stderr: "node:internal/errors: TypeError: cannot read properties of undefined",
      credentialPresent: true,
    });
    expect(classified).toMatchObject({
      reason: "engine_crash",
      credentialFailure: false,
      credentialFailureProvenance: null,
      retryable: false,
      remediation: "",
    });
  });

  it("classifies a login prompt with no environment evidence as a missing credential", () => {
    expect(classifyLaunchFailure({
      agent: "claude",
      stdout: "Not logged in. Run `claude login` to authenticate.",
      stderr: "",
    })).toMatchObject({
      reason: "credential_missing",
      credentialFailure: true,
      credentialFailureProvenance: "heuristic",
      retryable: true,
    });
  });

  it("classifies an unregistered-command answer as a retryable, non-credential launch failure", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Unknown command: /implement-unit" }),
    ].join("\n");
    const classified = classifyLaunchFailure({ agent: "claude", stdout, stderr: "", credentialPresent: true });
    expect(classified).toMatchObject({
      reason: "unregistered_command",
      credentialFailure: false,
      credentialFailureProvenance: null,
      retryable: true,
    });
    expect(classified.remediation).toContain("did not register its requested skill");
  });

  it("classifies an unregistered-command answer even without a known credential state", () => {
    const stdout = JSON.stringify({ type: "result", subtype: "success", result: "Unknown command: /ot-nonexistent-probe" });
    expect(classifyLaunchFailure({ agent: "claude", stdout, stderr: "" }).reason).toBe("unregistered_command");
  });

  it("keeps an authoritatively missing environment credential terminal despite assistant result prose", () => {
    const stdout = JSON.stringify({ type: "result", subtype: "success", result: "Unknown command: /implement-unit" });
    expect(classifyLaunchFailure({ agent: "claude", stdout, stderr: "", credentialPresent: false }))
      .toMatchObject({
        reason: "credential_missing",
        credentialFailure: true,
        credentialFailureProvenance: "environment",
        retryable: false,
      });
  });
});

describe("isUnregisteredCommandResult", () => {
  it("reads the engine's own final result field, not raw stdout", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Unknown command: /implement-unit" }),
    ].join("\n");
    expect(isUnregisteredCommandResult(stdout)).toBe(true);
  });

  it("is false for a normal completion", () => {
    const stdout = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" });
    expect(isUnregisteredCommandResult(stdout)).toBe(false);
  });

  it("is false when the phrase appears only outside the engine's final result text", () => {
    // A transcript that merely discusses or quotes the phrase mid-conversation
    // (not as the engine's own terminal answer) must not misfire.
    const stdout = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "I saw Unknown command: /foo earlier" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }),
    ].join("\n");
    expect(isUnregisteredCommandResult(stdout)).toBe(false);
  });

  it("is false for empty or malformed stdout", () => {
    expect(isUnregisteredCommandResult("")).toBe(false);
    expect(isUnregisteredCommandResult("not json")).toBe(false);
    expect(isUnregisteredCommandResult(undefined)).toBe(false);
  });
});

describe("launch diagnostic tail", () => {
  it("reduces plain launch refusals to static categories without persisting prose", () => {
    const tail = launchDiagnosticTail({
      stdout: "Invalid API key - please run /login",
      stderr: "",
      env: {},
    });
    expect(tail).toBe("provider_error=credential_rejected");
    expect(tail).not.toContain("Invalid API key");
    expect(tail).not.toContain("/login");
  });

  it("drops arbitrary stdout and stderr instead of persisting transcript tails", () => {
    const tail = launchDiagnosticTail({
      stdout: "o".repeat(10_000),
      stderr: "e".repeat(10_000),
      env: {},
    });
    expect(tail).toBe("");
  });

  it("never persists literal or transformed credential material from agent-controlled text", () => {
    const secret = "sk-ant-oat01-supersecret-value";
    const transformed = [...secret].join("-");
    const tail = launchDiagnosticTail({
      stdout: JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        api_error_status: 500,
        result: `credential=${secret}; transformed=${transformed}`,
      }),
      stderr: `tool emitted ${secret} and ${transformed}`,
      env: { CLAUDE_CODE_OAUTH_TOKEN: secret },
    });
    expect(tail).toBe(
      "provider_event=result subtype=error_during_execution is_error=true provider_status=500",
    );
    expect(tail).not.toContain(secret);
    expect(tail).not.toContain(transformed);
    expect(tail).not.toContain("credential=");
  });

  it("returns an empty tail when both streams are empty", () => {
    expect(launchDiagnosticTail({ stdout: "", stderr: "   ", env: {} })).toBe("");
  });

  it("preserves only allowlisted Claude terminal metadata", () => {
    const finalLine = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      api_error_status: 529,
      result: "the assistant's long trailing text",
      session_id: "0199a1de-0000-7000-8000-000000000000",
    });
    // Padding after the final line pushes a plain byte tail past it, so a
    // naive `.slice(-N)` would keep none of `finalLine`'s decisive fields.
    const stdout = [
      `{"type":"system","subtype":"init"}`,
      finalLine,
      "o".repeat(10_000),
    ].join("\n");

    const tail = launchDiagnosticTail({ stdout, stderr: "", env: {} });

    expect(tail).toContain("subtype=error_during_execution");
    expect(tail).toContain("is_error=true");
    expect(tail).toContain("provider_status=529");
    expect(tail).not.toContain("assistant's long trailing text");
    expect(tail).not.toContain("session_id");
    expect(tail.length).toBeLessThanOrEqual(MAX_LAUNCH_DIAGNOSTIC_CHARS);
  });

  it("drops an overlong result field and arbitrary stderr", () => {
    const finalLine = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "r".repeat(5_000),
    });
    const tail = launchDiagnosticTail({ stdout: finalLine, stderr: "s".repeat(500), env: {} });

    expect(tail).toBe("provider_event=result subtype=error_during_execution is_error=true");
    expect(tail).not.toContain("r".repeat(100));
    expect(tail).not.toContain("s".repeat(100));
  });

  it("stays bounded even when an uncapped decisive field (subtype) alone exceeds the budget", () => {
    const finalLine = JSON.stringify({
      type: "result",
      subtype: "s".repeat(2_500),
      is_error: true,
    });
    const tail = launchDiagnosticTail({ stdout: finalLine, stderr: "e".repeat(5_000), env: {} });

    // A decisive field large enough to exhaust the whole budget must not
    // fall back to returning the entire (unbounded) stderr/stdout -- that
    // was a `slice(-0)` bug: a zero-or-negative remaining budget slices to
    // "no characters", not "the whole string".
    expect(tail).toBe("provider_event=result is_error=true");
    expect(tail.length).toBeLessThanOrEqual(MAX_LAUNCH_DIAGNOSTIC_CHARS);
  });

  it("does not rely on literal redaction for secret-bearing result text", () => {
    const secret = "sk-ant-oat01-" + "s".repeat(600);
    const finalLine = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      result: `leaked token: ${secret}`,
    });
    const tail = launchDiagnosticTail({
      stdout: finalLine,
      stderr: "",
      env: { CLAUDE_CODE_OAUTH_TOKEN: secret },
    });

    expect(tail).not.toContain(secret);
    expect(tail).not.toContain("sk-ant-oat01-");
    expect(tail).toBe("provider_event=result subtype=error_during_execution");
  });

  it("ignores arbitrary non-error stream events and plain stderr", () => {
    const tail = launchDiagnosticTail({
      stdout: `{"type":"system","subtype":"init","session_id":"x"}`,
      stderr: "engine crashed",
      env: {},
    });
    expect(tail).toBe("");
  });

  it("retains bounded provider-owned invalid-schema metadata without the raw message", () => {
    const message = [
      "Invalid schema for response_format 'openthrottle':",
      "In context=('properties', 'payload', 'properties', 'findings'),",
      "schema node must have a type.",
    ].join(" ");
    const tail = launchDiagnosticTail({
      stdout: JSON.stringify({
        type: "turn.failed",
        error: {
          type: "invalid_request_error",
          code: "invalid_json_schema",
          status: 400,
          message,
        },
      }),
      stderr: "",
      env: {},
    });

    expect(tail).toBe([
      "provider_event=turn.failed",
      "error_type=invalid_request_error",
      "error_code=invalid_json_schema",
      "provider_status=400",
      "provider_error=invalid_json_schema",
      "schema_path=properties.payload.properties.findings",
      "schema_issue=missing_type",
    ].join(" "));
    expect(tail).not.toContain("response_format");
    expect(tail).not.toContain("schema node must have a type");
  });
});
