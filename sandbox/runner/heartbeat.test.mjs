import { describe, expect, it } from "vitest";
import { buildExecutorHeartbeat } from "./heartbeat.mjs";

describe("executor heartbeat", () => {
  it("builds a liveness-only event independent of semantic activity", () => {
    expect(
      buildExecutorHeartbeat(
        "11111111-1111-4111-8111-111111111111",
        "2026-07-22T00:00:00.000Z",
        "run-1"
      )
    ).toEqual({
      version: 1,
      kind: "heartbeat",
      event_id: "11111111-1111-4111-8111-111111111111",
      run_id: "run-1",
      created_at: "2026-07-22T00:00:00.000Z",
    });
  });
});
