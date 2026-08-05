import { describe, expect, it } from "vitest";
import { liveAgentPidsFromPs, runWithAgentProcessFence } from "./agent-process-fence.mjs";

describe("agent process fence", () => {
  it("ignores zombie agent processes during convergence", () => {
    expect(liveAgentPidsFromPs(`
        11 S
        12 Z
        13 Z+
        14 Sl
    `)).toEqual(["11", "14"]);
  });

  it("converges before and after action execution", () => {
    const events = [];
    const result = runWithAgentProcessFence(
      () => {
        events.push("execute");
        return "ok";
      },
      () => events.push("converge")
    );

    expect(result).toBe("ok");
    expect(events).toEqual(["converge", "execute", "converge"]);
  });

  it("still requires post-action convergence when execution throws", () => {
    const events = [];

    expect(() => runWithAgentProcessFence(
      () => {
        events.push("execute");
        throw new Error("body failed");
      },
      () => events.push("converge")
    )).toThrow(/body failed/);

    expect(events).toEqual(["converge", "execute", "converge"]);
  });

  it("marks pre-action convergence failures as retryable with unconfirmed termination", () => {
    let error;
    try {
      runWithAgentProcessFence(() => "ok", () => {
        throw new Error("convergence failed");
      });
    } catch (caught) {
      error = caught;
    }

    expect(error?.message).toMatch(/convergence failed/);
    expect(error?.retryableInfrastructureFailure).toBe(true);
    expect(error?.processTerminationUnconfirmed).toBe(true);
  });

  it("marks post-action convergence failures even when the body succeeded", () => {
    let calls = 0;
    let error;
    try {
      runWithAgentProcessFence(() => "ok", () => {
        calls += 1;
        if (calls > 1) throw new Error("post convergence failed");
      });
    } catch (caught) {
      error = caught;
    }

    expect(calls).toBe(2);
    expect(error?.message).toMatch(/post convergence failed/);
    expect(error?.retryableInfrastructureFailure).toBe(true);
    expect(error?.processTerminationUnconfirmed).toBe(true);
  });
});
