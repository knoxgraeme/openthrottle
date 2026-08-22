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

function assertProviderSchemaCompatibility(value: unknown, path = "$"): void {
  expect(value, `${path} must be a schema object`).toBeTypeOf("object");
  expect(value, `${path} must be a schema object`).not.toBeNull();
  expect(Array.isArray(value), `${path} must be a schema object`).toBe(false);
  const schema = value as Record<string, unknown>;
  expect(
    typeof schema.type === "string" || Array.isArray(schema.anyOf) || typeof schema.$ref === "string",
    `${path} must declare type, anyOf, or $ref`,
  ).toBe(true);
  expect(schema, `${path} uses unsupported uniqueItems`).not.toHaveProperty("uniqueItems");
  if (Object.hasOwn(schema, "const")) {
    const expectedType = schema.const === null
      ? "null"
      : Array.isArray(schema.const)
        ? "array"
        : typeof schema.const;
    expect(schema.type, `${path}.type for const`).toBe(expectedType);
  }
  if (schema.type === "object") {
    expect(schema.additionalProperties, `${path}.additionalProperties`).toBe(false);
    expect(schema.properties, `${path}.properties`).toBeTypeOf("object");
    expect(schema.required, `${path}.required`).toEqual(
      Object.keys(schema.properties as Record<string, unknown>).sort(),
    );
  }
  if (Array.isArray(schema.anyOf)) {
    schema.anyOf.forEach((entry, index) => assertProviderSchemaCompatibility(entry, `${path}.anyOf[${index}]`));
  }
  if (schema.items !== undefined) {
    assertProviderSchemaCompatibility(schema.items, `${path}.items`);
  }
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    for (const [key, entry] of Object.entries(schema.properties)) {
      assertProviderSchemaCompatibility(entry, `${path}.properties.${key}`);
    }
  }
  if (schema.$defs && typeof schema.$defs === "object" && !Array.isArray(schema.$defs)) {
    for (const [key, entry] of Object.entries(schema.$defs)) {
      assertProviderSchemaCompatibility(entry, `${path}.$defs.${key}`);
    }
  }
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
    ], { encoding: "utf8" })).toContain("verified 11 sealed runtime artifacts");
  });
});
