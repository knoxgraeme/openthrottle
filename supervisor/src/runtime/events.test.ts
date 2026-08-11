import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSandboxEvent, toProgressActivity } from "./events.js";

describe("runtime event contracts", () => {
  it("parses bounded runtime events without leaking provider dependencies", () => {
    const event = parseSandboxEvent(JSON.stringify({
      version: 1,
      kind: "activity",
      event_id: "11111111-1111-4111-8111-111111111111",
      run_id: "run-1",
      created_at: "2026-07-18T00:00:00.000Z",
      type: "action",
      body: "running",
      action: "Run",
      parameter: "npm test",
      result: "passed",
      ephemeral: true,
      ignored_provider_field: "@daytona/sdk",
    }));

    expect(event).toMatchObject({
      kind: "activity",
      type: "action",
      body: "running",
      action: "Run",
      parameter: "npm test",
      result: "passed",
      ephemeral: true,
    });
    expect(event).not.toHaveProperty("ignored_provider_field");
    if (event.kind !== "activity") throw new Error("expected activity event");
    expect(toProgressActivity(event, "session-1")).toEqual({
      sessionId: "session-1",
      type: "action",
      action: "Run",
      parameter: "npm test",
      result: "passed",
      ephemeral: true,
    });

    const source = readFileSync(fileURLToPath(new URL("./events.ts", import.meta.url)), "utf8");
    expect(source).not.toContain("@daytona/sdk");
  });

  it("accepts dotted path-safe child action heartbeats without widening run identifiers", () => {
    const selector = "execution-work-ae57a59455a2ff9c73af69b9d6266328.review.selector";
    const persona = "execution-work-ae57a59455a2ff9c73af69b9d6266328.review.correctness-dataflow";

    for (const [eventId, childActionId] of [
      ["44444444-4444-4444-8444-444444444444", selector],
      ["55555555-5555-4555-8555-555555555555", persona],
    ] as const) {
      expect(parseSandboxEvent(JSON.stringify({
        version: 1,
        kind: "heartbeat",
        event_id: eventId,
        run_id: "run-1",
        created_at: "2026-07-18T00:00:00.000Z",
        child_action_id: childActionId,
      }))).toMatchObject({
        kind: "heartbeat",
        run_id: "run-1",
        child_action_id: childActionId,
      });
    }

    expect(() => parseSandboxEvent(JSON.stringify({
      version: 1,
      kind: "heartbeat",
      event_id: "66666666-6666-4666-8666-666666666666",
      run_id: "run.1",
      created_at: "2026-07-18T00:00:00.000Z",
      child_action_id: selector,
    }))).toThrow(/run_id/);
  });

  it("rejects invalid heartbeat, plan, and stage-result envelopes", () => {
    expect(() => parseSandboxEvent(JSON.stringify({
      version: 1,
      kind: "heartbeat",
      event_id: "../bad",
      run_id: "run-1",
      created_at: "2026-07-18T00:00:00.000Z",
    }))).toThrow(/event_id/);

    expect(parseSandboxEvent(JSON.stringify({
      version: 1,
      kind: "heartbeat",
      event_id: "44444444-4444-4444-8444-444444444444",
      run_id: "run-1",
      created_at: "2026-07-18T00:00:00.000Z",
      child_action_id: "action-1",
      ignored: "dropped",
    }))).toEqual({
      version: 1,
      kind: "heartbeat",
      event_id: "44444444-4444-4444-8444-444444444444",
      run_id: "run-1",
      created_at: "2026-07-18T00:00:00.000Z",
      child_action_id: "action-1",
    });

    for (const child_action_id of [
      "../bad",
      "action/../bad",
      ".leading-punctuation",
      " action-1",
      "action 1",
      `a${"b".repeat(128)}`,
    ]) {
      expect(() => parseSandboxEvent(JSON.stringify({
        version: 1,
        kind: "heartbeat",
        event_id: "44444444-4444-4444-8444-444444444444",
        run_id: "run-1",
        created_at: "2026-07-18T00:00:00.000Z",
        child_action_id,
      }))).toThrow(/child_action_id/);
    }

    expect(() => parseSandboxEvent(JSON.stringify({
      version: 1,
      kind: "plan",
      event_id: "22222222-2222-4222-8222-222222222222",
      run_id: "run-1",
      created_at: "2026-07-18T00:00:00.000Z",
      plan: [{ content: "", status: "completed" }],
    }))).toThrow(/plan/);

    expect(() => parseSandboxEvent(JSON.stringify({
      version: 1,
      kind: "stage_result",
      event_id: "33333333-3333-4333-8333-333333333333",
      run_id: "run-1",
      created_at: "2026-07-18T00:00:00.000Z",
      pipeline_instance_id: "pipeline-1",
      generation: 1,
      stage_id: "implementation",
      attempt_id: "attempt-1",
      request_hash: "x",
      outcome: "success",
      result_hash: "2".repeat(64),
      native_session_id: null,
      subject: "c".repeat(40),
      artifacts: [{
        kind: "stage_result",
        schema_version: 1,
        assurance: "semantic_attested",
        subject: "c".repeat(40),
        payload: "{}",
        hash: "2".repeat(64),
      }],
    }))).toThrow(/request_hash/);
  });

  it("parses an optional fault_reason on stage_result and rejects an unrecognized value", () => {
    const validStageResult = {
      version: 1,
      kind: "stage_result",
      event_id: "33333333-3333-4333-8333-333333333333",
      run_id: "run-1",
      created_at: "2026-07-18T00:00:00.000Z",
      pipeline_instance_id: "pipeline-1",
      generation: 1,
      stage_id: "implementation",
      attempt_id: "attempt-1",
      request_hash: "1".repeat(64),
      outcome: "retryable_infrastructure_failure",
      result_hash: "2".repeat(64),
      native_session_id: null,
      subject: "c".repeat(40),
      artifacts: [{
        kind: "stage_result",
        schema_version: 1,
        assurance: "semantic_attested",
        subject: "c".repeat(40),
        payload: "{}",
        hash: "2".repeat(64),
      }],
    };

    const withoutReason = parseSandboxEvent(JSON.stringify(validStageResult));
    expect(withoutReason).not.toHaveProperty("fault_reason");

    const withReason = parseSandboxEvent(JSON.stringify({ ...validStageResult, fault_reason: "rate_limited" }));
    if (withReason.kind !== "stage_result") throw new Error("expected stage_result event");
    expect(withReason.fault_reason).toBe("rate_limited");

    expect(() => parseSandboxEvent(JSON.stringify({ ...validStageResult, fault_reason: "not_a_real_reason" })))
      .toThrow(/fault_reason/);
  });
});
