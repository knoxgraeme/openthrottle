import { describe, expect, it } from "vitest";
import { isSandboxFatalEnospc } from "./sandbox-recovery.js";

describe("sandbox-fatal failure classification", () => {
  it.each([
    ["node code", Object.assign(new Error("write failed"), { code: "ENOSPC" })],
    ["linux errno", Object.assign(new Error("write failed"), { errno: -28 })],
    ["provider message", new Error("No space left on device")],
    [
      "recovery fence publication",
      new Error("/var/lib/openthrottle/action-fences/attempt/work.part: create: open /var/lib/openthrottle/action-fences/attempt/work.part"),
    ],
  ])("classifies %s as poisoning the sandbox", (_label, error) => {
    expect(isSandboxFatalEnospc(error)).toBe(true);
  });

  it("does not widen ordinary infrastructure failures", () => {
    expect(isSandboxFatalEnospc(new Error("provider timeout after session termination"))).toBe(false);
  });
});
