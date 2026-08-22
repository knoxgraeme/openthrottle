import { Buffer } from "node:buffer";
import { canonicalJson, digestCanonicalJson } from "./canonical.js";
import { validateExecutionPlanContractV2 } from "./execution-plan-v2.js";
import {
  IDENTIFIER,
  arrayAt,
  booleanAt,
  enumAt,
  fail,
  integerAt,
  jsonValueAt,
  normalizedContract,
  objectAt,
  recordAt,
  stringAt,
  unique,
  type ValidatedContract,
} from "./validation.js";

export const RESULT_CANDIDATE_SCHEMA = "openthrottle.result-candidate/v1" as const;
export const SEMANTIC_RESULT_SCHEMA = "openthrottle.semantic-result-schema/v1" as const;
export const RESULT_NORMALIZATIONS = ["string-array-to-newlines/v1"] as const;
export const RESULT_CANDIDATE_MAX_BYTES = 64 * 1024;
export const SEMANTIC_EXECUTION_PLAN_MAX_BYTES = 56 * 1024;

const SEMANTIC_FIELD_TYPES = [
  "string", "string_list", "review_finding_list_v1", "boolean", "integer", "execution_plan_v2",
] as const;
export const REVIEW_FINDING_SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
const OUTCOME = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
const FIELD_NAME = /^[a-z][a-z0-9_]*$/;
const MAX_PAYLOAD_FIELDS = 64;
const MAX_NORMALIZED_STRING_ITEMS = 32;
const REVIEW_FINDING_FIELDS = ["anchor", "evidence", "path", "severity", "title"] as const;
const REVIEW_FINDING_PATH_MAX_LENGTH = 512;
const REVIEW_FINDING_ANCHOR_MAX_LENGTH = 512;
const REVIEW_FINDING_TITLE_MAX_LENGTH = 300;
const REVIEW_FINDING_EVIDENCE_MAX_LENGTH = 2_000;

export type ResultNormalizationId = (typeof RESULT_NORMALIZATIONS)[number];
export type SemanticFieldType = (typeof SEMANTIC_FIELD_TYPES)[number];
export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];

export interface ReviewFindingV1 {
  severity: ReviewFindingSeverity;
  path: string;
  anchor: string;
  title: string;
  evidence: string;
}

export type SemanticFieldContract =
  | {
    type: "string";
    max_length: number;
    normalize?: ResultNormalizationId;
  }
  | {
    type: "string_list";
    max_length: number;
    max_items: number;
  }
  | {
    type: "review_finding_list_v1";
    max_items: number;
  }
  | { type: "boolean" | "integer" | "execution_plan_v2" };

type StringSemanticFieldContract = Extract<SemanticFieldContract, { type: "string" }>;

export interface SemanticResultSchemaContract {
  schema: typeof SEMANTIC_RESULT_SCHEMA;
  id: string;
  outcomes: string[];
  payload: Record<string, SemanticFieldContract>;
}

export interface ResultCandidate {
  schema: typeof RESULT_CANDIDATE_SCHEMA;
  outcome: string;
  payload: Record<string, unknown>;
}

export interface ResultNormalizationDiagnostic {
  id: ResultNormalizationId;
  path: string;
  input_hash: string;
  output_hash: string;
}

export interface NormalizedResultCandidate extends ValidatedContract<ResultCandidate> {
  original_hash: string;
  normalized_hash: string;
  transformations: ResultNormalizationDiagnostic[];
}

function parseSemanticField(value: unknown, path: string): SemanticFieldContract {
  const input = objectAt(value, path, ["type", "max_length", "max_items", "normalize"]);
  const type = enumAt(input.type, `${path}.type`, SEMANTIC_FIELD_TYPES);
  if (type === "string") {
    if (input.max_items !== undefined) {
      fail(`${path}.max_items`, "is valid only for string_list or review_finding_list_v1");
    }
    return {
      type,
      max_length: integerAt(input.max_length, `${path}.max_length`, 1, 64 * 1024),
      ...(input.normalize === undefined ? {} : {
        normalize: enumAt(input.normalize, `${path}.normalize`, RESULT_NORMALIZATIONS),
      }),
    };
  }
  if (type === "string_list") {
    if (input.normalize !== undefined) fail(`${path}.normalize`, "is valid only for string fields");
    return {
      type,
      max_length: integerAt(input.max_length, `${path}.max_length`, 1, 64 * 1024),
      max_items: integerAt(input.max_items, `${path}.max_items`, 0, 1_024),
    };
  }
  if (type === "review_finding_list_v1") {
    if (input.max_length !== undefined) fail(`${path}.max_length`, "is valid only for string fields");
    if (input.normalize !== undefined) fail(`${path}.normalize`, "is valid only for string fields");
    return {
      type,
      max_items: integerAt(input.max_items, `${path}.max_items`, 0, 1_024),
    };
  }
  if (input.max_length !== undefined) fail(`${path}.max_length`, "is valid only for string fields");
  if (input.max_items !== undefined) {
    fail(`${path}.max_items`, "is valid only for string_list or review_finding_list_v1");
  }
  if (input.normalize !== undefined) fail(`${path}.normalize`, "is valid only for string fields");
  return { type };
}

function parseReviewFinding(value: unknown, path: string): ReviewFindingV1 {
  const input = objectAt(value, path, REVIEW_FINDING_FIELDS);
  return {
    severity: enumAt(input.severity, `${path}.severity`, REVIEW_FINDING_SEVERITIES),
    path: stringAt(input.path, `${path}.path`, { max: REVIEW_FINDING_PATH_MAX_LENGTH }),
    anchor: stringAt(input.anchor, `${path}.anchor`, { max: REVIEW_FINDING_ANCHOR_MAX_LENGTH }),
    title: stringAt(input.title, `${path}.title`, { max: REVIEW_FINDING_TITLE_MAX_LENGTH }),
    evidence: stringAt(input.evidence, `${path}.evidence`, { max: REVIEW_FINDING_EVIDENCE_MAX_LENGTH }),
  };
}

export function validateSemanticResultSchema(
  value: unknown,
  options: { source?: string } = {},
): ValidatedContract<SemanticResultSchemaContract> {
  const source = options.source ?? "semantic_result_schema";
  const input = objectAt(value, source, ["schema", "id", "outcomes", "payload"]);
  if (input.schema !== SEMANTIC_RESULT_SCHEMA) {
    fail(`${source}.schema`, `must be ${SEMANTIC_RESULT_SCHEMA}`);
  }
  const contract: SemanticResultSchemaContract = {
    schema: SEMANTIC_RESULT_SCHEMA,
    id: stringAt(input.id, `${source}.id`, { pattern: IDENTIFIER }),
    outcomes: unique(arrayAt(
      input.outcomes,
      `${source}.outcomes`,
      (entry, path) => stringAt(entry, path, { max: 80, pattern: OUTCOME }),
      { min: 1, max: 32 },
    ), `${source}.outcomes`),
    payload: recordAt(input.payload, `${source}.payload`, parseSemanticField, {
      max: MAX_PAYLOAD_FIELDS,
      keyMax: 80,
      keyPattern: FIELD_NAME,
    }),
  };
  if (Object.keys(contract.payload).length === 0) fail(`${source}.payload`, "must contain at least one field");
  return normalizedContract(contract);
}

function normalizeString(
  value: unknown,
  field: StringSemanticFieldContract,
  path: string,
  diagnosticPath: string,
  transformations: ResultNormalizationDiagnostic[],
): string {
  const maxLength = field.max_length;
  if (typeof value === "string") return stringAt(value, path, { max: maxLength });
  if (field.normalize !== "string-array-to-newlines/v1" || !Array.isArray(value)) {
    return stringAt(value, path, { max: maxLength });
  }
  const items = arrayAt(
    value,
    path,
    (entry, itemPath) => stringAt(entry, itemPath, { max: maxLength }),
    { min: 1, max: MAX_NORMALIZED_STRING_ITEMS },
  );
  const normalized = items.join("\n");
  if (normalized.length > maxLength) fail(path, `normalized value must be at most ${maxLength} characters`);
  transformations.push({
    id: field.normalize,
    path: diagnosticPath,
    input_hash: digestCanonicalJson(value),
    output_hash: digestCanonicalJson(normalized),
  });
  return normalized;
}

function validateSemanticValue(
  value: unknown,
  field: SemanticFieldContract,
  path: string,
  diagnosticPath: string,
  transformations: ResultNormalizationDiagnostic[],
): unknown {
  switch (field.type) {
    case "string":
      return normalizeString(value, field, path, diagnosticPath, transformations);
    case "string_list":
      return arrayAt(
        value,
        path,
        (entry, itemPath) => stringAt(entry, itemPath, { max: field.max_length }),
        { max: field.max_items },
      );
    case "review_finding_list_v1":
      return arrayAt(value, path, parseReviewFinding, { max: field.max_items });
    case "boolean":
      return booleanAt(value, path);
    case "integer":
      return integerAt(value, path, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    case "execution_plan_v2": {
      if (value === null) return null;
      const plan = validateExecutionPlanContractV2(value, { source: path }).value;
      if (Buffer.byteLength(canonicalJson(plan), "utf8") > SEMANTIC_EXECUTION_PLAN_MAX_BYTES) {
        fail(path, `must be at most ${SEMANTIC_EXECUTION_PLAN_MAX_BYTES} canonical JSON bytes`);
      }
      return plan;
    }
  }
}

export function validateAndNormalizeResultCandidate(
  value: unknown,
  semanticSchema: SemanticResultSchemaContract,
  options: { source?: string } = {},
): NormalizedResultCandidate {
  const source = options.source ?? "result_candidate";
  const input = objectAt(value, source, ["schema", "outcome", "payload"]);
  const originalValue = jsonValueAt(value, source);
  const originalBytes = Buffer.byteLength(canonicalJson(originalValue), "utf8");
  if (originalBytes > RESULT_CANDIDATE_MAX_BYTES) {
    fail(source, `must be at most ${RESULT_CANDIDATE_MAX_BYTES} canonical JSON bytes`);
  }
  const originalHash = digestCanonicalJson(originalValue);
  if (input.schema !== RESULT_CANDIDATE_SCHEMA) {
    fail(`${source}.schema`, `must be ${RESULT_CANDIDATE_SCHEMA}`);
  }
  const schema = validateSemanticResultSchema(semanticSchema, { source: "semantic_schema" }).value;
  const outcome = stringAt(input.outcome, `${source}.outcome`, { max: 80, pattern: OUTCOME });
  if (!schema.outcomes.includes(outcome)) {
    fail(`${source}.outcome`, `must be one of: ${schema.outcomes.join(", ")}`);
  }
  const payloadInput = objectAt(input.payload, `${source}.payload`, Object.keys(schema.payload));
  const transformations: ResultNormalizationDiagnostic[] = [];
  const payload: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema.payload)) {
    const raw = payloadInput[name];
    if (raw === undefined) {
      fail(`${source}.payload.${name}`, "is required");
    }
    payload[name] = validateSemanticValue(
      raw,
      field,
      `${source}.payload.${name}`,
      `/payload/${name}`,
      transformations,
    );
  }
  const candidate: ResultCandidate = {
    schema: RESULT_CANDIDATE_SCHEMA,
    outcome,
    payload,
  };
  const validated = normalizedContract(candidate);
  return {
    ...validated,
    original_hash: originalHash,
    normalized_hash: validated.digest,
    transformations,
  };
}

interface JsonSchema {
  [key: string]: unknown;
}

function stringArraySchema(minItems: number, maxItems: number, maxLength: number): JsonSchema {
  return {
    type: "array",
    minItems,
    maxItems,
    items: { type: "string", minLength: 1, maxLength },
  };
}

function providerFieldSchema(field: SemanticFieldContract): JsonSchema {
  switch (field.type) {
    case "string": {
      const stringSchema = {
        type: "string",
        minLength: 1,
        maxLength: field.max_length,
      };
      return field.normalize === "string-array-to-newlines/v1"
        ? {
          anyOf: [
            stringSchema,
            {
              type: "array",
              minItems: 1,
              maxItems: MAX_NORMALIZED_STRING_ITEMS,
              items: stringSchema,
            },
          ],
        }
        : stringSchema;
    }
    case "string_list":
      return {
        type: "array",
        maxItems: field.max_items,
        items: { type: "string", minLength: 1, maxLength: field.max_length },
      };
    case "review_finding_list_v1":
      return {
        type: "array",
        maxItems: field.max_items,
        items: {
          type: "object",
          additionalProperties: false,
          required: [...REVIEW_FINDING_FIELDS],
          properties: {
            severity: { type: "string", enum: REVIEW_FINDING_SEVERITIES },
            path: { type: "string", minLength: 1, maxLength: REVIEW_FINDING_PATH_MAX_LENGTH },
            anchor: { type: "string", minLength: 1, maxLength: REVIEW_FINDING_ANCHOR_MAX_LENGTH },
            title: { type: "string", minLength: 1, maxLength: REVIEW_FINDING_TITLE_MAX_LENGTH },
            evidence: { type: "string", minLength: 1, maxLength: REVIEW_FINDING_EVIDENCE_MAX_LENGTH },
          },
        },
      };
    case "boolean":
      return { type: "boolean" };
    case "integer":
      return { type: "integer" };
    case "execution_plan_v2":
      return {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["commands", "pipeline_id", "plan_id", "schema", "units"],
            properties: {
              schema: { type: "string", const: "openthrottle.execution-plan/v2" },
              pipeline_id: { type: "string", minLength: 1, maxLength: 160 },
              plan_id: { type: "string", minLength: 1, maxLength: 160 },
              units: {
                type: "array",
                minItems: 1,
                maxItems: 64,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "acceptance", "approach", "depends_on", "files", "id", "objective",
                    "requirements", "tests", "title", "verification",
                  ],
                  properties: {
                    id: { type: "string", minLength: 1, maxLength: 160 },
                    title: { type: "string", minLength: 1, maxLength: 160 },
                    depends_on: {
                      type: "array", maxItems: 32,
                      items: { type: "string", minLength: 1, maxLength: 160 },
                    },
                    objective: { type: "string", minLength: 1, maxLength: 2_000 },
                    requirements: stringArraySchema(1, 32, 2_000),
                    files: stringArraySchema(1, 64, 512),
                    approach: stringArraySchema(1, 32, 2_000),
                    tests: stringArraySchema(1, 32, 2_000),
                    acceptance: stringArraySchema(1, 32, 2_000),
                    verification: stringArraySchema(1, 32, 2_000),
                  },
                },
              },
              commands: {
                type: "array",
                maxItems: 16,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["name", "unit"],
                  properties: {
                    name: { type: "string", minLength: 1, maxLength: 160 },
                    unit: {
                      anyOf: [
                        { type: "null" },
                        { type: "string", minLength: 1, maxLength: 160 },
                      ],
                    },
                  },
                },
              },
            },
          },
        ],
      };
  }
}

export function providerJsonSchemaForResultCandidate(
  semanticSchema: SemanticResultSchemaContract,
): JsonSchema {
  const schema = validateSemanticResultSchema(semanticSchema, { source: "semantic_schema" }).value;
  const names = Object.keys(schema.payload).sort();
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["outcome", "payload", "schema"],
    properties: {
      schema: { type: "string", const: RESULT_CANDIDATE_SCHEMA },
      outcome: { type: "string", enum: schema.outcomes },
      payload: {
        type: "object",
        additionalProperties: false,
        required: names,
        properties: Object.fromEntries(names.map((name) => [name, providerFieldSchema(schema.payload[name]!)])),
      },
    },
  };
}
