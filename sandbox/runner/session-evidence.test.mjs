import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPOSED_PROMPT_PAYLOAD_SCHEMA,
  OTEL_SESSION_TRANSCRIPT_PAYLOAD_SCHEMA,
  captureComposedPrompt,
  captureNativeSessionLog,
  stageSessionEvidence,
} from "./session-evidence.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("session evidence", () => {
  it("retains exact composed prompt bytes and projects native turns and tools into one OTLP trace", () => {
    const root = mkdtempSync(join(tmpdir(), "ot-session-evidence-"));
    directories.push(root);
    const actionDirectory = join(root, "action");
    const artifactDirectory = join(root, "artifacts");
    const resultPath = join(root, "transport", "result.json");
    const prompt = Buffer.from("platform fence\r\n🙂 exact prompt\n", "utf8");
    const workLog = Buffer.from([
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { type: "command_execution" } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read" }] },
      }),
      "unstructured native output",
      "",
    ].join("\n"), "utf8");
    const correctionLog = Buffer.from(`${JSON.stringify({ type: "result" })}\n`, "utf8");

    captureComposedPrompt(actionDirectory, prompt);
    captureNativeSessionLog(actionDirectory, "work", "lease-work", workLog);
    captureNativeSessionLog(
      actionDirectory,
      "result_correction",
      "lease-correction",
      correctionLog,
    );
    const evidence = stageSessionEvidence({
      request: {
        pipeline_run_id: "run-1",
        attempt_id: "attempt-1",
        stage_id: "implement",
        request_hash: "a".repeat(64),
        definition_bundle_hash: "b".repeat(64),
        action: { engine: "codex" },
      },
      nativeSessionId: "session-1",
      actionDirectory,
      artifactDirectory,
      resultPath,
      capturedAt: "2026-09-06T12:00:00.000Z",
    });

    const promptArtifact = readFileSync(join(root, "transport", evidence.prompt_context.file));
    const transcriptArtifact = readFileSync(join(root, "transport", evidence.transcript.file));
    expect(promptArtifact.equals(prompt)).toBe(true);
    expect(evidence.prompt_context).toMatchObject({
      sha256: sha256(prompt),
      bytes: prompt.byteLength,
      media_type: "text/plain",
      payload_schema: COMPOSED_PROMPT_PAYLOAD_SCHEMA,
    });
    expect(evidence.transcript).toMatchObject({
      sha256: sha256(transcriptArtifact),
      bytes: transcriptArtifact.byteLength,
      media_type: "application/json",
      payload_schema: OTEL_SESSION_TRANSCRIPT_PAYLOAD_SCHEMA,
    });

    const transcript = JSON.parse(transcriptArtifact.toString("utf8"));
    expect(transcript.resourceSpans).toHaveLength(1);
    const spans = transcript.resourceSpans[0].scopeSpans[0].spans;
    expect(spans.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "openthrottle.attempt.implement",
      "codex.turn.turn.started",
      "codex.tool.command_execution",
      "codex.turn.assistant",
      "codex.tool.tool_use",
      "codex.turn.result",
    ]));
    const rawEvents = spans[0].events;
    expect(rawEvents).toHaveLength(2);
    expect(rawEvents[0].attributes).toContainEqual({
      key: "openthrottle.native_log.content",
      value: { bytesValue: workLog.toString("base64") },
    });
    expect(rawEvents[1].attributes).toContainEqual({
      key: "openthrottle.native_log.content",
      value: { bytesValue: correctionLog.toString("base64") },
    });
  });

  it("refuses to replace immutable launch prompt capture with reconstructed bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "ot-session-evidence-conflict-"));
    directories.push(root);
    captureComposedPrompt(root, Buffer.from("exact launch bytes", "utf8"));
    expect(() => captureComposedPrompt(root, Buffer.from("reconstructed bytes", "utf8")))
      .toThrow(/conflicts with immutable session evidence/);
  });
});
