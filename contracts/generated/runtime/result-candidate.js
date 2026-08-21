import { Buffer } from "node:buffer";
import { canonicalJson, digestCanonicalJson } from "./canonical.js";
import { validateExecutionPlanContractV2 } from "./execution-plan-v2.js";
import { IDENTIFIER, arrayAt, booleanAt, enumAt, fail, integerAt, jsonValueAt, normalizedContract, objectAt, recordAt, stringAt, unique, } from "./validation.js";
export const RESULT_CANDIDATE_SCHEMA = "openthrottle.result-candidate/v1";
export const SEMANTIC_RESULT_SCHEMA = "openthrottle.semantic-result-schema/v1";
export const RESULT_NORMALIZATIONS = ["string-array-to-newlines/v1"];
export const RESULT_CANDIDATE_MAX_BYTES = 64 * 1024;
export const SEMANTIC_EXECUTION_PLAN_MAX_BYTES = 56 * 1024;
const SEMANTIC_FIELD_TYPES = [
    "string", "string_list", "boolean", "integer", "json", "execution_plan_v2",
];
const OUTCOME = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
const FIELD_NAME = /^[a-z][a-z0-9_]*$/;
const MAX_PAYLOAD_FIELDS = 64;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_NORMALIZED_STRING_ITEMS = 32;
function parseSemanticField(value, path) {
    const input = objectAt(value, path, ["type", "required", "max_length", "max_items", "normalize"]);
    const type = enumAt(input.type, `${path}.type`, SEMANTIC_FIELD_TYPES);
    const required = input.required === undefined ? true : booleanAt(input.required, `${path}.required`);
    if (type === "string") {
        if (input.max_items !== undefined)
            fail(`${path}.max_items`, "is valid only for string_list");
        return {
            type,
            required,
            max_length: integerAt(input.max_length, `${path}.max_length`, 1, 64 * 1024),
            ...(input.normalize === undefined ? {} : {
                normalize: enumAt(input.normalize, `${path}.normalize`, RESULT_NORMALIZATIONS),
            }),
        };
    }
    if (type === "string_list") {
        if (input.normalize !== undefined)
            fail(`${path}.normalize`, "is valid only for string fields");
        return {
            type,
            required,
            max_length: integerAt(input.max_length, `${path}.max_length`, 1, 64 * 1024),
            max_items: integerAt(input.max_items, `${path}.max_items`, 0, 1_024),
        };
    }
    if (input.max_length !== undefined)
        fail(`${path}.max_length`, "is valid only for string fields");
    if (input.max_items !== undefined)
        fail(`${path}.max_items`, "is valid only for string_list");
    if (input.normalize !== undefined)
        fail(`${path}.normalize`, "is valid only for string fields");
    return { type, required };
}
export function validateSemanticResultSchema(value, options = {}) {
    const source = options.source ?? "semantic_result_schema";
    const input = objectAt(value, source, ["schema", "id", "outcomes", "payload"]);
    if (input.schema !== SEMANTIC_RESULT_SCHEMA) {
        fail(`${source}.schema`, `must be ${SEMANTIC_RESULT_SCHEMA}`);
    }
    const contract = {
        schema: SEMANTIC_RESULT_SCHEMA,
        id: stringAt(input.id, `${source}.id`, { pattern: IDENTIFIER }),
        outcomes: unique(arrayAt(input.outcomes, `${source}.outcomes`, (entry, path) => stringAt(entry, path, { max: 80, pattern: OUTCOME }), { min: 1, max: 32 }), `${source}.outcomes`),
        payload: recordAt(input.payload, `${source}.payload`, parseSemanticField, {
            max: MAX_PAYLOAD_FIELDS,
            keyMax: 80,
            keyPattern: FIELD_NAME,
        }),
    };
    if (Object.keys(contract.payload).length === 0)
        fail(`${source}.payload`, "must contain at least one field");
    return normalizedContract(contract);
}
function normalizeString(value, field, path, diagnosticPath, transformations) {
    const maxLength = field.max_length;
    if (typeof value === "string")
        return stringAt(value, path, { max: maxLength });
    if (field.normalize !== "string-array-to-newlines/v1" || !Array.isArray(value)) {
        return stringAt(value, path, { max: maxLength });
    }
    const items = arrayAt(value, path, (entry, itemPath) => stringAt(entry, itemPath, { max: maxLength }), { min: 1, max: MAX_NORMALIZED_STRING_ITEMS });
    const normalized = items.join("\n");
    if (normalized.length > maxLength)
        fail(path, `normalized value must be at most ${maxLength} characters`);
    transformations.push({
        id: field.normalize,
        path: diagnosticPath,
        input_hash: digestCanonicalJson(value),
        output_hash: digestCanonicalJson(normalized),
    });
    return normalized;
}
function validateSemanticValue(value, field, path, diagnosticPath, transformations) {
    switch (field.type) {
        case "string":
            return normalizeString(value, field, path, diagnosticPath, transformations);
        case "string_list":
            return arrayAt(value, path, (entry, itemPath) => stringAt(entry, itemPath, { max: field.max_length }), { max: field.max_items });
        case "boolean":
            return booleanAt(value, path);
        case "integer":
            return integerAt(value, path, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
        case "json": {
            const parsed = jsonValueAt(value, path);
            if (Buffer.byteLength(canonicalJson(parsed), "utf8") > MAX_JSON_BYTES) {
                fail(path, `must be at most ${MAX_JSON_BYTES} canonical JSON bytes`);
            }
            return parsed;
        }
        case "execution_plan_v2": {
            if (value === null)
                return null;
            const plan = validateExecutionPlanContractV2(value, { source: path }).value;
            if (Buffer.byteLength(canonicalJson(plan), "utf8") > SEMANTIC_EXECUTION_PLAN_MAX_BYTES) {
                fail(path, `must be at most ${SEMANTIC_EXECUTION_PLAN_MAX_BYTES} canonical JSON bytes`);
            }
            return plan;
        }
    }
}
export function validateAndNormalizeResultCandidate(value, semanticSchema, options = {}) {
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
    const transformations = [];
    const payload = {};
    for (const [name, field] of Object.entries(schema.payload)) {
        const raw = payloadInput[name];
        if (raw === undefined) {
            if (field.required)
                fail(`${source}.payload.${name}`, "is required");
            continue;
        }
        payload[name] = validateSemanticValue(raw, field, `${source}.payload.${name}`, `/payload/${name}`, transformations);
    }
    const candidate = {
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
function stringArraySchema(minItems, maxItems, maxLength) {
    return {
        type: "array",
        minItems,
        maxItems,
        items: { type: "string", minLength: 1, maxLength },
    };
}
function providerFieldSchema(field) {
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
        case "boolean":
            return { type: "boolean" };
        case "integer":
            return { type: "integer" };
        case "json":
            return {};
        case "execution_plan_v2":
            return {
                anyOf: [
                    { type: "null" },
                    {
                        type: "object",
                        additionalProperties: false,
                        required: ["commands", "pipeline_id", "plan_id", "schema", "units"],
                        properties: {
                            schema: { const: "openthrottle.execution-plan/v2" },
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
                                            type: "array", maxItems: 32, uniqueItems: true,
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
                                    required: ["name"],
                                    properties: {
                                        name: { type: "string", minLength: 1, maxLength: 160 },
                                        unit: { type: "string", minLength: 1, maxLength: 160 },
                                    },
                                },
                            },
                        },
                    },
                ],
            };
    }
}
export function providerJsonSchemaForResultCandidate(semanticSchema) {
    const schema = validateSemanticResultSchema(semanticSchema, { source: "semantic_schema" }).value;
    const names = Object.keys(schema.payload).sort();
    return {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["outcome", "payload", "schema"],
        properties: {
            schema: { const: RESULT_CANDIDATE_SCHEMA },
            outcome: { type: "string", enum: schema.outcomes },
            payload: {
                type: "object",
                additionalProperties: false,
                required: names.filter((name) => schema.payload[name].required),
                properties: Object.fromEntries(names.map((name) => [name, providerFieldSchema(schema.payload[name])])),
            },
        },
    };
}
