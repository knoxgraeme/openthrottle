import { describe, expect, it } from "vitest";
import { parseCommand } from "./commands.js";

describe("parseCommand", () => {
  it("recognizes /stop exactly", () => {
    expect(parseCommand("/stop")).toEqual({ kind: "stop" });
    expect(parseCommand(" /stop ")).toEqual({ kind: "stop" });
    expect(parseCommand("please /stop")).toEqual({ kind: "reply" });
  });

  it("recognizes /merge and merge it case-insensitively", () => {
    expect(parseCommand("/merge")).toEqual({ kind: "merge" });
    expect(parseCommand("Merge It")).toEqual({ kind: "merge" });
    expect(parseCommand("please merge it now")).toEqual({ kind: "reply" });
  });

  it("does not promote free text or /implement into a new execution", () => {
    expect(parseCommand("ok go ahead and ship it")).toEqual({ kind: "reply" });
    expect(parseCommand("please fix it")).toEqual({ kind: "reply" });
    expect(parseCommand("/implement")).toEqual({ kind: "reply" });
  });

  it("falls back to reply for anything else", () => {
    expect(parseCommand("looks good, thanks!")).toEqual({ kind: "reply" });
    expect(parseCommand("")).toEqual({ kind: "reply" });
  });
});
