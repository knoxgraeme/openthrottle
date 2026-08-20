import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CORE_SEMANTIC_RESULT_SCHEMAS,
  RESULT_CANDIDATE_SCHEMA,
  canonicalJson,
  digestCanonicalJson,
  providerJsonSchemaForResultCandidate,
  validateAndNormalizeResultCandidate,
  validateSemanticResultSchema,
} from "./index.js";

const contractsRoot = new URL("..", import.meta.url).pathname;
const generatedRoot = join(contractsRoot, "generated");

describe("generated runtime artifacts", () => {
  it("matches every source schema and its checksum manifest", () => {
    const manifest = JSON.parse(readFileSync(join(generatedRoot, "artifact-set.json"), "utf8"));
    const content = { schema: manifest.schema, artifacts: manifest.artifacts };
    expect(manifest.artifact_set_digest).toBe(digestCanonicalJson(content));
    for (const artifact of manifest.artifacts) {
      const bytes = readFileSync(join(generatedRoot, artifact.path));
      expect(bytes.length).toBe(artifact.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
    }
    for (const rawSchema of CORE_SEMANTIC_RESULT_SCHEMAS) {
      const semanticSchema = validateSemanticResultSchema(rawSchema).value;
      const generated = readFileSync(
        join(generatedRoot, "provider-schemas", `${semanticSchema.id.replaceAll("/", "--")}.schema.json`),
        "utf8",
      ).trim();
      expect(generated).toBe(canonicalJson(providerJsonSchemaForResultCandidate(semanticSchema)));
    }
  });

  it("runs the same normalizer from the sealed JavaScript artifact", async () => {
    const runtime = await import(pathToFileURL(join(generatedRoot, "runtime/index.js")).href);
    const semanticSchema = validateSemanticResultSchema(CORE_SEMANTIC_RESULT_SCHEMAS[1]).value;
    const candidate = {
      schema: RESULT_CANDIDATE_SCHEMA,
      outcome: "success",
      payload: {
        summary: ["implemented", "verified"],
        assumptions: [],
        decisions: [],
        issues: [],
        verification: ["contracts passed"],
        downstream_context: [],
        requested_human_input: [],
      },
    };
    expect(canonicalJson(runtime.validateAndNormalizeResultCandidate(candidate, semanticSchema)))
      .toBe(canonicalJson(validateAndNormalizeResultCandidate(candidate, semanticSchema)));
  });

  it("fails closed when checked-in artifacts drift", () => {
    expect(execFileSync(process.execPath, [
      join(contractsRoot, "scripts/build-runtime-artifacts.mjs"),
      "--check",
    ], { encoding: "utf8" })).toContain("verified 7 sealed runtime artifacts");
  });
});
