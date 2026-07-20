import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildHeartbeatEvent,
  collectEnvSecretValues,
  processLine,
  sanitize,
  shouldEmitHeartbeat,
  summarizeOpenCodeEvent,
  summarizeCodexItem,
  summarizeToolUse,
  truncate,
  writeRunResult,
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

  it("captures sanitized final responses from Claude and latest Codex agent messages", () => {
    processLine(JSON.stringify({ type: "result", result: "Claude result ghp_abcdefghijklmnop" }));
    processLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Codex final ghp_abcdefghijklmnop" } }));
    writeRunResult();
    const result = JSON.parse(readFileSync(`${process.env.HOME}/.ot/run-result.json`, "utf8"));
    expect(result.final_response).toBe("Codex final [REDACTED]");
  });
});

describe("progress heartbeat", () => {
  it("throttles by the configured interval", () => {
    expect(shouldEmitHeartbeat(0, 15_000, 15_000)).toBe(true);
    expect(shouldEmitHeartbeat(1_000, 10_000, 15_000)).toBe(false);
    expect(shouldEmitHeartbeat(1_000, 16_000, 15_000)).toBe(true);
  });

  it("summarizes tool_use into a short 'currently doing X' line", () => {
    expect(summarizeToolUse("Bash", { command: "pnpm test" })).toBe("running: pnpm test");
    expect(summarizeToolUse("Edit", { file_path: "/repo/src/app.ts" })).toBe("Edit app.ts");
    expect(summarizeToolUse("WebSearch", {})).toBe("running WebSearch");
  });

  it("builds an ephemeral thought event, sanitized and bounded", () => {
    const event = buildHeartbeatEvent({
      runId: "run-1",
      summary: "running: deploy --token ghp_abcdefghijklmnop",
      nowIso: "2026-07-18T00:00:00.000Z",
    });
    expect(event).toMatchObject({ kind: "activity", type: "thought", ephemeral: true, run_id: "run-1" });
    expect(event.body).toContain("[REDACTED]");
    expect(event.body).not.toContain("ghp_abcdefghijklmnop");
  });
});
