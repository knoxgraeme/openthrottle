import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
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

  it("includes child action liveness when the sealed runner provides an action id", () => {
    expect(
      buildExecutorHeartbeat(
        "22222222-2222-4222-8222-222222222222",
        "2026-07-22T00:00:00.000Z",
        "run-1",
        "action-1"
      )
    ).toEqual({
      version: 1,
      kind: "heartbeat",
      event_id: "22222222-2222-4222-8222-222222222222",
      run_id: "run-1",
      created_at: "2026-07-22T00:00:00.000Z",
      child_action_id: "action-1",
    });
  });

  it("keeps runner-owned child action liveness available to the heartbeat process", () => {
    const heartbeatModule = fileURLToPath(new URL("./heartbeat.mjs", import.meta.url));
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { buildExecutorHeartbeat } from ${JSON.stringify(pathToFileURL(heartbeatModule).href)}; console.log(JSON.stringify(buildExecutorHeartbeat("33333333-3333-4333-8333-333333333333", "2026-07-22T00:00:00.000Z")));`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          RUN_ID: "run-from-heartbeat-env",
          OT_CHILD_ACTION_ID: "action-from-heartbeat-env",
        },
      },
    );

    expect(JSON.parse(output)).toEqual({
      version: 1,
      kind: "heartbeat",
      event_id: "33333333-3333-4333-8333-333333333333",
      run_id: "run-from-heartbeat-env",
      created_at: "2026-07-22T00:00:00.000Z",
      child_action_id: "action-from-heartbeat-env",
    });
  });
});
