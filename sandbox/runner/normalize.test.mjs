import { describe, expect, it } from "vitest";
import {
  collectEnvSecretValues,
  sanitize,
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
});
