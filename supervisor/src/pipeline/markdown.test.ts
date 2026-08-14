import { describe, expect, it } from "vitest";
import { extractJsonBlocksAny } from "./markdown.js";

describe("markdown JSON block extraction", () => {
  it("binds the fence marker to the payload schema", () => {
    const schemas = ["openthrottle.execution-plan/v1", "openthrottle.execution-plan/v2"];

    expect(() => extractJsonBlocksAny(
      [
        "```json openthrottle.execution-plan/v1",
        JSON.stringify({ schema: "openthrottle.execution-plan/v2" }),
        "```",
      ].join("\n"),
      schemas
    )).toThrow(/payload schema must be openthrottle\.execution-plan\/v1/);

    expect(() => extractJsonBlocksAny(
      [
        "```json openthrottle.execution-plan/v1 openthrottle.execution-plan/v2",
        JSON.stringify({ schema: "openthrottle.execution-plan/v2" }),
        "```",
      ].join("\n"),
      schemas
    )).toThrow(/declares multiple schemas/);
  });
});
