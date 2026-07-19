import { describe, expect, it } from "vitest";
import {
  collectEnvSecretValues,
  sanitize,
  summarizeOpenCodeEvent,
  summarizeCodexItem,
  truncate,
} from "./normalize.mjs";

describe("normalize", () => {
  it("redacts nested JSON credentials and token patterns", () => {
    const values = collectEnvSecretValues({
      CODEX_AUTH_JSON: JSON.stringify({ tokens: { access_token: "nested-access-token" } }),
      GITHUB_TOKEN: "direct-token-value",
      HARMLESS: "show-me",
    });
    const result = sanitize(
      "nested-access-token direct-token-value show-me ghp_abcdefghijklmnop Bearer opaque",
      values
    );
    expect(result).toBe("[REDACTED] [REDACTED] show-me [REDACTED] [REDACTED]");
  });

  it("summarizes current Codex JSONL items", () => {
    expect(summarizeCodexItem({ type: "agent_message", text: "done" })).toBe(
      "agent_message: done"
    );
    expect(
      summarizeCodexItem({ type: "command_execution", command: "npm test", status: "completed" })
    ).toContain("npm test");
  });

  it("truncates oversized output", () => {
    expect(truncate("abcdef", 3)).toBe("abc… [truncated 3 chars]");
  });

  it("summarizes OpenCode JSON events", () => {
    expect(
      summarizeOpenCodeEvent({
        type: "message",
        sessionID: "session-1",
        part: { type: "text", text: "done" },
      })
    ).toBe("done");
    expect(
      summarizeOpenCodeEvent({
        type: "message",
        part: { type: "tool", tool: "bash", state: "completed" },
      })
    ).toBe("tool: bash (completed)");
    expect(summarizeOpenCodeEvent({ type: "step_finish", part: { cost: 0.125 } })).toBe(
      "step finished (cost_usd=0.125)"
    );
  });

  it("does not classify Codex errors as OpenCode without a sessionID", () => {
    expect(summarizeCodexItem({ type: "agent_message", text: "still codex" })).toBe(
      "agent_message: still codex"
    );
    expect(summarizeOpenCodeEvent({ type: "error", sessionID: "oc", error: "failed" })).toBe(
      "error: \"failed\""
    );
  });
});
