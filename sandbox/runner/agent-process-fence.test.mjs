import { describe, expect, it } from "vitest";
import { runWithAgentProcessFence } from "./agent-process-fence.mjs";

describe("agent process fence", () => {
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
});
