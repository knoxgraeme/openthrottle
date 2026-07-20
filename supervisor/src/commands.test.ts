import { describe, expect, it } from "vitest";
import { parseCommand } from "./commands.js";

describe("parseCommand", () => {
  it("recognizes /stop exactly", () => {
    expect(parseCommand("/stop", { investigateLabel: false })).toEqual({ kind: "stop" });
    expect(parseCommand(" /stop ", { investigateLabel: false })).toEqual({ kind: "stop" });
    expect(parseCommand("please /stop", { investigateLabel: false })).toEqual({ kind: "reply" });
  });

  it("recognizes /merge and merge it case-insensitively", () => {
    expect(parseCommand("/merge", { investigateLabel: false })).toEqual({ kind: "merge" });
    expect(parseCommand("Merge It", { investigateLabel: false })).toEqual({ kind: "merge" });
    expect(parseCommand("please merge it now", { investigateLabel: false })).toEqual({ kind: "reply" });
  });

  it("recognizes /implement exactly", () => {
    expect(parseCommand("/implement", { investigateLabel: false })).toEqual({ kind: "implement" });
    expect(parseCommand("/implement please", { investigateLabel: false })).toEqual({ kind: "reply" });
  });

  it("promotes an investigate ticket via the legacy fix-it/implement/go-ahead phrase, flagged as legacy", () => {
    expect(parseCommand("ok go ahead and ship it", { investigateLabel: true })).toEqual({
      kind: "implement",
      legacy: true,
    });
    expect(parseCommand("please fix it", { investigateLabel: true })).toEqual({
      kind: "implement",
      legacy: true,
    });
    // The legacy heuristic only applies to investigate-labeled tickets.
    expect(parseCommand("please fix it", { investigateLabel: false })).toEqual({ kind: "reply" });
  });

  it("falls back to reply for anything else", () => {
    expect(parseCommand("looks good, thanks!", { investigateLabel: false })).toEqual({ kind: "reply" });
    expect(parseCommand("", { investigateLabel: true })).toEqual({ kind: "reply" });
  });
});
