import { describe, expect, it } from "vitest";
import {
  MAX_LAUNCH_DIAGNOSTIC_CHARS,
  classifyLaunchFailure,
  engineCredentialPresent,
  hasRejectedRateLimitEvent,
  launchDiagnosticTail,
} from "./launch-failure.mjs";
import { classifyAgentExecutionFailure } from "./execute-stage.mjs";

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
      retryable: true,
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
      retryable: true,
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
      retryable: false,
      remediation: "",
    });
  });

  it("classifies a login prompt with no environment evidence as a missing credential", () => {
    expect(classifyLaunchFailure({
      agent: "claude",
      stdout: "Not logged in. Run `claude login` to authenticate.",
      stderr: "",
    })).toMatchObject({ reason: "credential_missing", credentialFailure: true });
  });
});

describe("launch diagnostic tail", () => {
  it("captures stdout when the engine wrote nothing to stderr", () => {
    const tail = launchDiagnosticTail({
      stdout: "Invalid API key - please run /login",
      stderr: "",
      env: {},
    });
    expect(tail).toBe("stdout: Invalid API key - please run /login");
  });

  it("keeps both streams and stays inside the bound", () => {
    const tail = launchDiagnosticTail({
      stdout: "o".repeat(10_000),
      stderr: "e".repeat(10_000),
      env: {},
    });
    expect(tail).toContain("stderr: ");
    expect(tail).toContain("stdout: ");
    expect(tail.length).toBeLessThanOrEqual(MAX_LAUNCH_DIAGNOSTIC_CHARS + 32);
  });

  it("redacts credential material through the artifact sanitizer", () => {
    const tail = launchDiagnosticTail({
      stdout: "sent Authorization: Bearer sk-ant-oat01-supersecret-value",
      stderr: "token=sk-ant-oat01-supersecret-value rejected",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-supersecret-value" },
    });
    expect(tail).not.toContain("supersecret");
    expect(tail).toContain("[REDACTED]");
  });

  it("returns an empty tail when both streams are empty", () => {
    expect(launchDiagnosticTail({ stdout: "", stderr: "   ", env: {} })).toBe("");
  });
});

describe("agent stage failure summaries", () => {
  it("names the reason, the remediation, and the sanitized diagnostic", () => {
    const classified = classifyAgentExecutionFailure({
      agent: "claude",
      termination: "exit=1",
      diagnostic: launchDiagnosticTail({
        stdout: "Invalid API key · Please run /login (token sk-ant-oat01-leaked)",
        stderr: "",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-leaked" },
      }),
      terminated: false,
      missingProposal: true,
      stdout: "Invalid API key · Please run /login",
      stderr: "",
      credentialPresent: true,
    });
    expect(classified.reason).toBe("credential_rejected");
    expect(classified.credentialFailure).toBe(true);
    expect(classified.suggestedOutcome).toBe("retryable_infrastructure_failure");
    expect(classified.summary).toContain("Agent exited without the required terminal stage proposal");
    expect(classified.summary).toContain("reason=credential_rejected");
    expect(classified.summary).toContain("Executor diagnostic: stdout: Invalid API key");
    expect(classified.summary).not.toContain("sk-ant-oat01-leaked");
  });

  it("keeps an unclassified crash a plain failure and a terminated one retryable", () => {
    const crash = {
      agent: "claude",
      termination: "exit=1",
      diagnostic: "stderr: bus error",
      stdout: "",
      stderr: "bus error",
      credentialPresent: true,
    };
    expect(classifyAgentExecutionFailure({ ...crash, terminated: false })).toMatchObject({
      reason: "engine_crash",
      credentialFailure: false,
      suggestedOutcome: "failure",
    });
    expect(classifyAgentExecutionFailure({ ...crash, terminated: true }).suggestedOutcome)
      .toBe("retryable_infrastructure_failure");
  });

  it("keeps a rate-limited stage out of the semantic repair budget", () => {
    const classified = classifyAgentExecutionFailure({
      agent: "claude",
      termination: "exit=1",
      diagnostic: `stdout: ${claudeRateLimitLine("rejected")}`,
      terminated: false,
      missingProposal: true,
      stdout: claudeRateLimitLine("rejected"),
      stderr: "",
      credentialPresent: true,
    });
    expect(classified).toMatchObject({
      reason: "rate_limited",
      credentialFailure: false,
      suggestedOutcome: "retryable_infrastructure_failure",
    });
  });

  it("still reports the Codex refresh-token remediation for an expired seed", () => {
    const classified = classifyAgentExecutionFailure({
      agent: "codex",
      termination: "exit=1",
      diagnostic: "stderr: 401 Unauthorized refresh_token_invalidated on /backend-api/codex/responses",
      terminated: false,
      missingProposal: true,
      credentialPresent: true,
    });
    expect(classified.reason).toBe("credential_rejected");
    expect(classified.credentialFailure).toBe(true);
    expect(classified.summary).toContain("Model credential expired - refresh CODEX_AUTH_JSON");
  });
});
