import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import {
  RESULT_CANDIDATE_SCHEMA,
  canonicalJson,
  digestCanonicalJson,
  providerJsonSchemaForResultCandidate,
  validateAndNormalizeResultCandidate,
  validateEvalDefinition,
  validateSemanticResultSchema,
} from "./index.js";
import { assertProviderSchemaCompatibility } from "./test-support/provider-schema.js";

const contractsRoot = new URL("..", import.meta.url).pathname;
const repositoryRoot = join(contractsRoot, "..");
const generatedRoot = join(contractsRoot, "generated");

function authoredSemanticSchemas() {
  const root = join(repositoryRoot, ".openthrottle/evals/core");
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, "eval.yml"))
    .map((path) => {
      const document = parseDocument(readFileSync(path, "utf8"), {
        schema: "core",
        strict: true,
        stringKeys: true,
        uniqueKeys: true,
        version: "1.2",
      });
      expect(document.errors).toEqual([]);
      expect(document.warnings).toEqual([]);
      return validateEvalDefinition(document.toJS({ maxAliasCount: 0 }), { source: path }).value.result;
    })
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

describe("generated runtime artifacts", () => {
  it("keeps evaluator-derived review repair outside the provider outcome schema", () => {
    const reviewSchema = authoredSemanticSchemas().find(({ id }) => id === "core/review-result");
    expect(reviewSchema).toBeDefined();
    expect(reviewSchema!.outcomes).not.toContain("semantic_repair_required");
    const providerSchema = providerJsonSchemaForResultCandidate(reviewSchema!) as {
      properties: { outcome: { enum: string[] } };
    };
    expect(providerSchema.properties.outcome.enum).not.toContain("semantic_repair_required");
  });

  it("matches every source schema and its checksum manifest", () => {
    const manifest = JSON.parse(readFileSync(join(generatedRoot, "artifact-set.json"), "utf8"));
    const content = { schema: manifest.schema, artifacts: manifest.artifacts };
    expect(manifest.artifact_set_digest).toBe(digestCanonicalJson(content));
    for (const artifact of manifest.artifacts) {
      const bytes = readFileSync(join(generatedRoot, artifact.path));
      expect(bytes.length).toBe(artifact.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
    }
    for (const rawSchema of authoredSemanticSchemas()) {
      const semanticSchema = validateSemanticResultSchema(rawSchema).value;
      assertProviderSchemaCompatibility(providerJsonSchemaForResultCandidate(semanticSchema));
      const generated = readFileSync(
        join(generatedRoot, "provider-schemas", `${semanticSchema.id.replaceAll("/", "--")}.schema.json`),
        "utf8",
      ).trim();
      expect(generated).toBe(canonicalJson(providerJsonSchemaForResultCandidate(semanticSchema)));
    }
  });

  it("runs the same normalizer from the sealed JavaScript artifact", async () => {
    const runtime = await import(pathToFileURL(join(generatedRoot, "runtime/index.js")).href);
    const semanticSchema = validateSemanticResultSchema(
      authoredSemanticSchemas().find(({ id }) => id === "core/unit-result"),
    ).value;
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
    ], { encoding: "utf8" })).toContain("verified 12 sealed runtime artifacts");
  });
});
