import { describe, expect, it } from "vitest";
import { extractJsonBlock } from "./json-block.mjs";

describe("extractJsonBlock", () => {
  it("parses the JSON object immediately following the marker", () => {
    const text = `## Heading\n${JSON.stringify({ a: 1, b: [1, 2] })}`;
    expect(extractJsonBlock(text, "## Heading\n")).toEqual({ a: 1, b: [1, 2] });
  });

  it("returns null when the marker is not present", () => {
    expect(extractJsonBlock("no marker in this text", "## Missing\n")).toBeNull();
  });

  it("throws when the marker is present but no balanced JSON object follows", () => {
    expect(() => extractJsonBlock("## Heading\nnot json", "## Heading\n")).toThrow(
      /no balanced JSON object found/
    );
  });

  it("does not mistake a brace inside a JSON string value for structural nesting", () => {
    const payload = { acceptance: "Open the scope with { and close it with }" };
    const text = `## Heading\n${JSON.stringify(payload)}`;
    expect(extractJsonBlock(text, "## Heading\n")).toEqual(payload);
  });

  it("does not desynchronize on a stray closing brace before the target object opens", () => {
    // A '}' in surrounding prose before the real object must not be counted
    // as a structural close -- otherwise a later unrelated object could be
    // returned instead of the real one, silently.
    const text =
      "## Heading\n" +
      "prose mentioning a stray } character" +
      JSON.stringify({ schema: "real" }) +
      "trailing prose with a stray { character" +
      JSON.stringify({ schema: "wrong" });
    expect(extractJsonBlock(text, "## Heading\n")).toEqual({ schema: "real" });
  });

  it("honors escaped quotes when tracking string boundaries", () => {
    const payload = { note: 'a "quoted" word with a { brace' };
    const text = `## Heading\n${JSON.stringify(payload)}`;
    expect(extractJsonBlock(text, "## Heading\n")).toEqual(payload);
  });
});
