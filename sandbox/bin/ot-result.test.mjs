import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { submitResult } from "./ot-result.mjs";

const schema = {
  schema: "openthrottle.semantic-result-schema/v1",
  id: "core/action-result",
  outcomes: ["success"],
  payload: {
    summary: {
      type: "string",
      max_length: 1_000,
      normalize: "string-array-to-newlines/v1",
    },
  },
};

describe("ot-result", () => {
  it("submits through the same staged candidate channel", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ot-result-bin-"));
    const schemaPath = join(directory, "schema.json");
    const candidatePath = join(directory, "input.json");
    const outputPath = join(directory, "staged.json");
    await writeFile(schemaPath, JSON.stringify(schema));
    await writeFile(candidatePath, JSON.stringify({
      schema: "openthrottle.result-candidate/v1",
      outcome: "success",
      payload: { summary: ["done", "verified"] },
    }));

    const result = await submitResult(["submit", "--file", candidatePath], {
      OT_RESULT_SCHEMA_FILE: schemaPath,
      OT_RESULT_CANDIDATE_FILE: outputPath,
    });
    expect(result).toMatchObject({
      accepted: true,
      replayed: false,
      transformations: [expect.objectContaining({ path: "/payload/summary" })],
    });
    expect(JSON.parse(await readFile(outputPath, "utf8")).candidate.payload.summary)
      .toBe("done\nverified");
  });

  it("does not let the caller choose the scoped output channel", async () => {
    await expect(submitResult(["submit", "--file", "candidate.json", "--output", "elsewhere"] , {}))
      .rejects.toThrow(/unknown argument --output/);
  });

  it("persists generated rejection evidence for executor recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ot-result-rejected-"));
    const schemaPath = join(directory, "schema.json");
    const candidatePath = join(directory, "input.json");
    const outputPath = join(directory, "staged.json");
    const rejectionPath = join(directory, "rejected.json");
    await writeFile(schemaPath, JSON.stringify(schema));
    await writeFile(candidatePath, JSON.stringify({
      schema: "openthrottle.result-candidate/v1",
      outcome: "success",
      payload: { summary: ["valid", 7] },
    }));

    await expect(submitResult(["submit", "--file", candidatePath], {
      OT_RESULT_SCHEMA_FILE: schemaPath,
      OT_RESULT_CANDIDATE_FILE: outputPath,
      OT_RESULT_REJECTION_FILE: rejectionPath,
    })).rejects.toMatchObject({
      diagnostics: [{
        path: "result_candidate.payload.summary[1]",
        detail: "must be a non-empty string",
      }],
    });
    expect(JSON.parse(await readFile(rejectionPath, "utf8"))).toMatchObject({
      schema: "openthrottle.rejected-result-candidate/v1",
      raw_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      original_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});
