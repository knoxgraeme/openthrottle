import { describe, expect, it } from "vitest";
import {
  ContractValidationError,
  COMPILED_PIPELINE_MANIFEST_SCHEMA,
  DEFINITION_BUNDLE_SCHEMA,
  EFFECT_INTENT_SCHEMA,
  EXECUTION_PLAN_SCHEMA_V2,
  EXECUTION_KERNEL_DETERMINISM_FIXTURE,
  RESULT_CANDIDATE_SCHEMA,
  SEMANTIC_RESULT_SCHEMA,
  assertSameIdempotentEffect,
  canonicalJson,
  contractValidationIssue,
  digestCanonicalJson,
  providerJsonSchemaForResultCandidate,
  validateAttemptIdentity,
  validateAttemptCheckpoint,
  validateBlobPointer,
  validateCompiledPipelineManifest,
  validateDefinitionBundle,
  validateAndNormalizeResultCandidate,
  validateEffectIntent,
  validateExecutionRecord,
  validateFilesystemConfigContract,
  validatePipelineDefinition,
  validateSemanticResultSchema,
  type ExecutionRecordPayloadContract,
  type ExecutionRecordPayloadRegistry,
  type ExecutionPlanContractV2,
  type ReviewFindingV1,
} from "./index.js";
import { assertProviderSchemaCompatibility } from "./test-support/provider-schema.js";

const sha = (character: string): string => character.repeat(64);
const subject = (character: string): string => character.repeat(40);
const recordPayloadSchemas: ExecutionRecordPayloadRegistry = new Map<string, ExecutionRecordPayloadContract>([
  ["unit-result/v1", {
    kind: "result" as const,
    parseInline(value: unknown, path: string): unknown {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: must be an object`);
      const payload = value as Record<string, unknown>;
      if (payload.outcome !== "success" || typeof payload.summary !== "string") {
        throw new Error(`${path}: must contain a successful outcome and string summary`);
      }
      return value;
    },
  }],
  ["advance/v1", { kind: "decision" as const, parseInline: (value: unknown): unknown => value }],
  ["github-delivery/v1", { kind: "delivery" as const, parseInline: (value: unknown): unknown => value }],
]);

describe("execution-kernel determinism fixture", () => {
  it("validates every kernel contract and is insensitive to object key insertion order", () => {
    const fixture = EXECUTION_KERNEL_DETERMINISM_FIXTURE;
    validateFilesystemConfigContract(fixture.config);
    validatePipelineDefinition(fixture.pipeline);
    expect(fixture.compiled_manifest.schema).toBe(COMPILED_PIPELINE_MANIFEST_SCHEMA);
    validateCompiledPipelineManifest(fixture.compiled_manifest);
    expect(fixture.definition_bundle.schema).toBe(DEFINITION_BUNDLE_SCHEMA);
    validateDefinitionBundle(fixture.definition_bundle);
    const semanticSchema = validateSemanticResultSchema(fixture.semantic_result_schema).value;
    validateAndNormalizeResultCandidate(fixture.result_candidate, semanticSchema);
    validateAttemptIdentity(fixture.attempt_identity);
    validateAttemptCheckpoint(fixture.attempt_checkpoint);
    validateExecutionRecord(fixture.result_record, { payloadSchemas: recordPayloadSchemas });
    validateExecutionRecord(fixture.decision_record, { payloadSchemas: recordPayloadSchemas });
    validateExecutionRecord(fixture.delivery_record, { payloadSchemas: recordPayloadSchemas });
    validateBlobPointer(fixture.blob_pointer);
    validateEffectIntent(fixture.effect_intent);
    const reversed = Object.fromEntries(Object.entries(EXECUTION_KERNEL_DETERMINISM_FIXTURE).reverse());
    expect(canonicalJson(reversed)).toBe(canonicalJson(EXECUTION_KERNEL_DETERMINISM_FIXTURE));
    expect(digestCanonicalJson(reversed)).toBe(digestCanonicalJson(EXECUTION_KERNEL_DETERMINISM_FIXTURE));
  });
});

const unitResultSchema = validateSemanticResultSchema({
  schema: SEMANTIC_RESULT_SCHEMA,
  id: "unit-result",
  outcomes: ["success", "failure", "needs_human"],
  payload: {
    summary: {
      type: "string",
      max_length: 1_000,
      normalize: "string-array-to-newlines/v1",
    },
    evidence: {
      type: "string_list",
      max_items: 32,
      max_length: 1_000,
    },
  },
}).value;

const executionPlanResultSchema = validateSemanticResultSchema({
  schema: SEMANTIC_RESULT_SCHEMA,
  id: "admission-plan-result",
  outcomes: ["structured"],
  payload: {
    execution_plan: { type: "execution_plan_v2" },
  },
}).value;

const reviewResultSchema = validateSemanticResultSchema({
  schema: SEMANTIC_RESULT_SCHEMA,
  id: "review-result",
  outcomes: ["success", "needs_human"],
  payload: {
    summary: { type: "string", max_length: 4_000 },
    findings: { type: "review_finding_list_v1", max_items: 64 },
  },
}).value;

const concreteReviewFinding = {
  severity: "P1",
  path: "contracts/src/result-candidate.ts",
  anchor: "providerFieldSchema",
  title: "Provider schema leaves a payload field unconstrained",
  evidence: "The generated schema emits an empty object for the field.",
} satisfies ReviewFindingV1;

function naturalExecutionPlan(): ExecutionPlanContractV2 {
  return {
    schema: EXECUTION_PLAN_SCHEMA_V2,
    pipeline_id: "core/structured",
    plan_id: "admission-plan",
    units: [
      {
        id: "contract",
        title: "Define the contract",
        depends_on: [],
        objective: "Define the public contract before implementation.",
        requirements: ["Keep the boundary provider-neutral."],
        files: ["contracts/src/example.ts"],
        approach: ["Add the canonical shape first."],
        tests: ["Exercise validation through the public API."],
        acceptance: ["Consumers can validate the new shape."],
        verification: ["npm test --prefix contracts"],
      },
      {
        id: "implementation",
        title: "Implement the consumer",
        depends_on: ["contract"],
        objective: "Consume the sealed contract without widening it.",
        requirements: ["Preserve exact dependency identity."],
        files: ["supervisor/src/example.ts"],
        approach: ["Use the validated nested plan directly."],
        tests: ["Cover the dependent consumer."],
        acceptance: ["The consumer accepts only the sealed plan."],
        verification: ["npm test --prefix supervisor"],
      },
    ],
    commands: [{ name: "test", unit: "implementation" }],
  };
}

describe("semantic result candidates", () => {
  it("exposes stable structured validation diagnostics without changing messages", () => {
    let failure: unknown;
    try {
      validateAndNormalizeResultCandidate({
        schema: RESULT_CANDIDATE_SCHEMA,
        outcome: "unknown",
        payload: { summary: "done", evidence: [] },
      }, unitResultSchema);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ContractValidationError);
    expect(failure).toHaveProperty(
      "message",
      "result_candidate.outcome: must be one of: success, failure, needs_human",
    );
    expect(contractValidationIssue(failure)).toEqual({
      path: "result_candidate.outcome",
      detail: "must be one of: success, failure, needs_human",
    });
    expect(contractValidationIssue(new Error("not a contract failure"))).toBeUndefined();
  });

  it("normalizes the OPE-188 summary array without accepting authority fields", () => {
    const result = validateAndNormalizeResultCandidate({
      schema: RESULT_CANDIDATE_SCHEMA,
      outcome: "success",
      payload: {
        summary: ["Implemented the unit.", "Targeted tests pass."],
        evidence: ["contracts: 42 passed"],
      },
    }, unitResultSchema);

    expect(result.value.payload.summary).toBe("Implemented the unit.\nTargeted tests pass.");
    expect(result.transformations).toEqual([expect.objectContaining({
      id: "string-array-to-newlines/v1",
      path: "/payload/summary",
    })]);
    expect(result.original_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.normalized_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.original_hash).not.toBe(result.normalized_hash);

    const customSource = validateAndNormalizeResultCandidate({
      schema: RESULT_CANDIDATE_SCHEMA,
      outcome: "success",
      payload: { summary: ["done"], evidence: [] },
    }, unitResultSchema, { source: "action.result" });
    expect(customSource.transformations[0]?.path).toBe("/payload/summary");
  });

  it.each(["subject", "fence", "assurance", "producer", "hash", "issued_at"])(
    "rejects executor-owned %s",
    (field) => {
      expect(() => validateAndNormalizeResultCandidate({
        schema: RESULT_CANDIDATE_SCHEMA,
        outcome: "success",
        payload: { summary: "done", evidence: [] },
        [field]: "forged",
      }, unitResultSchema)).toThrow(new RegExp(`${field}: unknown field`));
    },
  );

  it("does not guess across ambiguous or invalid semantic values", () => {
    expect(() => validateAndNormalizeResultCandidate({
      schema: RESULT_CANDIDATE_SCHEMA,
      outcome: "success",
      payload: { summary: ["valid", 7], evidence: [] },
    }, unitResultSchema)).toThrow(/payload\.summary\[1\]: must be a non-empty string/);
    expect(() => validateAndNormalizeResultCandidate({
      schema: RESULT_CANDIDATE_SCHEMA,
      outcome: "unknown",
      payload: { summary: "done", evidence: [] },
    }, unitResultSchema)).toThrow(/outcome: must be one of/);
    expect(() => validateAndNormalizeResultCandidate({
      schema: RESULT_CANDIDATE_SCHEMA,
      outcome: "success",
      payload: { summary: "done", evidence: [], verdict: "approved" },
    }, unitResultSchema)).toThrow(/payload\.verdict: unknown field/);
    expect(() => validateAndNormalizeResultCandidate({
      schema: RESULT_CANDIDATE_SCHEMA,
      outcome: "success",
      payload: { summary: 1n, evidence: [] },
    }, unitResultSchema)).toThrow(/payload\.summary: must be a JSON value/);
    expect(() => validateAndNormalizeResultCandidate({
      schema: RESULT_CANDIDATE_SCHEMA,
      outcome: "success",
      payload: { summary: "x".repeat(70_000), evidence: [] },
    }, unitResultSchema)).toThrow(/must be at most 65536 canonical JSON bytes/);
  });

  it("emits a closed provider schema from the same semantic contract", () => {
    const providerSchema = providerJsonSchemaForResultCandidate(unitResultSchema);
    assertProviderSchemaCompatibility(providerSchema);
    expect(providerSchema).toMatchObject({
      additionalProperties: false,
      properties: {
        schema: { const: RESULT_CANDIDATE_SCHEMA },
        outcome: { enum: ["success", "failure", "needs_human"] },
        payload: {
          additionalProperties: false,
          required: ["evidence", "summary"],
        },
      },
      required: ["outcome", "payload", "schema"],
      type: "object",
    });
    const summarySchema = (providerSchema.properties as {
      payload: { properties: { summary: unknown } };
    }).payload.properties.summary;
    expect(summarySchema).toMatchObject({
      anyOf: [
        { type: "string", maxLength: 1_000 },
        { type: "array", minItems: 1, maxItems: 32 },
      ],
    });
  });

  it("validates a closed bounded review-finding list", () => {
    const result = validateAndNormalizeResultCandidate({
      schema: RESULT_CANDIDATE_SCHEMA,
      outcome: "success",
      payload: {
        summary: "One blocking finding.",
        findings: [concreteReviewFinding],
      },
    }, reviewResultSchema);

    expect(result.value.payload.findings).toEqual([concreteReviewFinding]);
    expect(() => validateAndNormalizeResultCandidate({
      schema: RESULT_CANDIDATE_SCHEMA,
      outcome: "success",
      payload: {
        summary: "Malformed finding.",
        findings: [{ ...concreteReviewFinding, blocking: true }],
      },
    }, reviewResultSchema)).toThrow(/payload\.findings\[0\]\.blocking: unknown field/);
    expect(() => validateAndNormalizeResultCandidate({
      schema: RESULT_CANDIDATE_SCHEMA,
      outcome: "success",
      payload: {
        summary: "Malformed finding.",
        findings: [{ ...concreteReviewFinding, severity: "critical" }],
      },
    }, reviewResultSchema)).toThrow(/severity: must be one of: P0, P1, P2, P3/);
  });

  it.each([
    ["path", 513, 512],
    ["anchor", 513, 512],
    ["title", 301, 300],
    ["evidence", 2_001, 2_000],
  ] as const)("bounds review finding %s", (field, length, maximum) => {
    expect(() => validateAndNormalizeResultCandidate({
      schema: RESULT_CANDIDATE_SCHEMA,
      outcome: "success",
      payload: {
        summary: "Oversized finding field.",
        findings: [{ ...concreteReviewFinding, [field]: "x".repeat(length) }],
      },
    }, reviewResultSchema)).toThrow(
      new RegExp(`payload\\.findings\\[0\\]\\.${field}: must be at most ${maximum} characters`),
    );
  });

  it("enforces the eval-declared review finding count", () => {
    expect(() => validateAndNormalizeResultCandidate({
      schema: RESULT_CANDIDATE_SCHEMA,
      outcome: "success",
      payload: {
        summary: "Too many findings.",
        findings: Array.from({ length: 65 }, () => concreteReviewFinding),
      },
    }, reviewResultSchema)).toThrow(/payload\.findings: must contain between 0 and 64 entries/);
  });

  it("emits a typed closed provider schema for review findings", () => {
    const providerSchema = providerJsonSchemaForResultCandidate(reviewResultSchema);
    assertProviderSchemaCompatibility(providerSchema);
    expect(providerSchema).toMatchObject({
      properties: {
        payload: {
          properties: {
            findings: {
              type: "array",
              maxItems: 64,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["anchor", "evidence", "path", "severity", "title"],
                properties: {
                  severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
                  path: { type: "string", maxLength: 512 },
                  anchor: { type: "string", maxLength: 512 },
                  title: { type: "string", maxLength: 300 },
                  evidence: { type: "string", maxLength: 2_000 },
                },
              },
            },
          },
        },
      },
    });
  });

  it("rejects field options that have no meaning for their semantic type", () => {
    expect(() => validateSemanticResultSchema({
      schema: SEMANTIC_RESULT_SCHEMA,
      id: "invalid",
      outcomes: ["success"],
      payload: { accepted: { type: "boolean", max_length: 20 } },
    })).toThrow(/max_length: is valid only for string fields/);
    expect(() => validateSemanticResultSchema({
      schema: SEMANTIC_RESULT_SCHEMA,
      id: "invalid",
      outcomes: ["success"],
      payload: { count: { type: "integer", max_items: 2 } },
    })).toThrow(/max_items: is valid only for string_list/);
    expect(() => validateSemanticResultSchema({
      schema: SEMANTIC_RESULT_SCHEMA,
      id: "invalid",
      outcomes: ["success"],
      payload: { summary: { type: "string", required: false, max_length: 100 } },
    })).toThrow(/payload\.summary\.required: unknown field/);
    expect(() => validateSemanticResultSchema({
      schema: SEMANTIC_RESULT_SCHEMA,
      id: "invalid",
      outcomes: ["success"],
      payload: { findings: { type: "review_finding_list_v1" } },
    })).toThrow(/payload\.findings\.max_items: must be an integer/);
    expect(() => validateSemanticResultSchema({
      schema: SEMANTIC_RESULT_SCHEMA,
      id: "invalid",
      outcomes: ["success"],
      payload: { data: { type: "json" } },
    })).toThrow(/payload\.data\.type: must be one of/);
  });
});

describe("execution_plan_v2 semantic result fields", () => {
  it("accepts a natural nested execution plan value", () => {
    const executionPlan = naturalExecutionPlan();
    const result = validateAndNormalizeResultCandidate({
      schema: RESULT_CANDIDATE_SCHEMA,
      outcome: "structured",
      payload: { execution_plan: executionPlan },
    }, executionPlanResultSchema);

    expect(result.value.payload.execution_plan).toEqual(executionPlan);
  });

  it("preserves a provider-null command unit without recording a transformation", () => {
    const executionPlan = naturalExecutionPlan() as unknown as Record<string, unknown>;
    executionPlan.commands = [{ name: "test", unit: null }];
    const result = validateAndNormalizeResultCandidate({
      schema: RESULT_CANDIDATE_SCHEMA,
      outcome: "structured",
      payload: { execution_plan: executionPlan },
    }, executionPlanResultSchema);

    expect(result.value.payload.execution_plan).toMatchObject({
      commands: [{ name: "test", unit: null }],
    });
    expect(result.original_hash).toBe(result.normalized_hash);
    expect(result.transformations).toEqual([]);
  });

  it("retains semantic duplicate dependency rejection outside the provider schema", () => {
    const executionPlan = naturalExecutionPlan();
    executionPlan.units[1]!.depends_on = ["contract", "contract"];

    expect(() => validateAndNormalizeResultCandidate({
      schema: RESULT_CANDIDATE_SCHEMA,
      outcome: "structured",
      payload: { execution_plan: executionPlan },
    }, executionPlanResultSchema)).toThrow(
      /payload\.execution_plan\.units\[1\]\.depends_on: must not contain duplicates/,
    );
  });

  it("reports the precise path for a malformed nested plan value", () => {
    const malformed = structuredClone(naturalExecutionPlan());
    (malformed.units[1]!.verification as unknown[])[0] = { command: "npm test" };

    let failure: unknown;
    try {
      validateAndNormalizeResultCandidate({
        schema: RESULT_CANDIDATE_SCHEMA,
        outcome: "structured",
        payload: { execution_plan: malformed },
      }, executionPlanResultSchema);
    } catch (error) {
      failure = error;
    }

    expect(contractValidationIssue(failure)).toEqual({
      path: "result_candidate.payload.execution_plan.units[1].verification[0]",
      detail: "must be a non-empty string",
    });
  });

  it("describes execution plans to providers as object or null", () => {
    const providerSchema = providerJsonSchemaForResultCandidate(executionPlanResultSchema) as {
      properties: {
        payload: {
          properties: {
            execution_plan: {
              anyOf: Array<Record<string, unknown>>;
            };
          };
        };
      };
    };
    const planSchema = providerSchema.properties.payload.properties.execution_plan;

    assertProviderSchemaCompatibility(providerSchema);

    expect(planSchema.anyOf.map(({ type }) => type)).toEqual(["null", "object"]);
    expect(planSchema.anyOf[1]).toMatchObject({
      additionalProperties: false,
      required: ["commands", "pipeline_id", "plan_id", "schema", "units"],
      properties: {
        schema: { const: EXECUTION_PLAN_SCHEMA_V2 },
        units: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
          },
        },
      },
    });
  });
});

describe("execution records", () => {
  it("binds checkpoints to the complete attempt identity and verified subjects", () => {
    const checkpoint = validateAttemptCheckpoint({
      schema: "openthrottle.attempt-checkpoint/v1",
      id: "checkpoint-1",
      pipeline_run_id: "run-1",
      attempt_id: "attempt-1",
      request_hash: sha("a"),
      definition_bundle_hash: sha("b"),
      input_subject: subject("c"),
      output_subject: subject("d"),
      native_session_id: "session-1",
      payload_schema: "checkpoint/v1",
      payload: { inline: { tree: subject("d") } },
      captured_at: "2026-08-20T00:00:00.000Z",
    }).value;

    expect(checkpoint.output_subject).toBe(subject("d"));
    expect(checkpoint.payload).toEqual({ inline: { tree: subject("d") } });
    expect(() => validateAttemptCheckpoint({
      ...checkpoint,
      payload: {
        blob: {
          algorithm: "sha256",
          digest: sha("e"),
          bytes: 70_000,
          encoding: "binary",
          media_type: "application/octet-stream",
          payload_schema: "different/v1",
        },
      },
    })).toThrow(/must match the checkpoint payload_schema/);
  });

  it("allows the explicit empty input set only at the base DecisionRecord boundary", () => {
    const record = validateExecutionRecord({
      schema: "openthrottle.record/v1",
      id: "decision-bootstrap",
      kind: "decision",
      pipeline_run_id: "run-1",
      reducer: "core/run-bootstrap@1",
      input_record_ids: [],
      payload_schema: "advance/v1",
      payload: { inline: { next: "implement" } },
      created_at: "2026-08-20T00:00:00.000Z",
    }, { payloadSchemas: recordPayloadSchemas }).value;

    expect(record.kind).toBe("decision");
    if (record.kind !== "decision") throw new Error("expected DecisionRecord");
    expect(record.input_record_ids).toEqual([]);
  });

  it("keeps authoritative attempt and output-subject identity on ResultRecord", () => {
    const record = validateExecutionRecord({
      schema: "openthrottle.record/v1",
      id: "record-1",
      kind: "result",
      pipeline_run_id: "run-1",
      attempt_id: "attempt-1",
      request_hash: sha("a"),
      definition_bundle_hash: sha("b"),
      input_subject: subject("c"),
      output_subject: subject("d"),
      payload_schema: "unit-result/v1",
      payload: { inline: { outcome: "success", summary: "done" } },
      original_candidate_hash: sha("e"),
      normalized_candidate_hash: sha("f"),
      created_at: "2026-08-20T00:00:00.000Z",
    }, { payloadSchemas: recordPayloadSchemas }).value;

    expect(record.kind).toBe("result");
    if (record.kind !== "result") throw new Error("expected ResultRecord");
    expect(record.output_subject).toBe(subject("d"));
  });

  it("accepts a content-addressed payload pointer instead of large inline bytes", () => {
    const record = validateExecutionRecord({
      schema: "openthrottle.record/v1",
      id: "record-2",
      kind: "decision",
      pipeline_run_id: "run-1",
      reducer: "core/advance@1",
      input_record_ids: ["record-1"],
      payload_schema: "advance/v1",
      payload: {
        blob: {
          algorithm: "sha256",
          digest: sha("a"),
          bytes: 70_000,
          encoding: "utf-8",
          media_type: "application/json",
          payload_schema: "advance/v1",
        },
      },
      created_at: "2026-08-20T00:00:01.000Z",
    }, { payloadSchemas: recordPayloadSchemas }).value;

    expect(record.payload).toEqual({ blob: expect.objectContaining({ digest: sha("a") }) });
  });

  it("rejects owner fields from a different record kind and oversized inline bytes", () => {
    expect(() => validateExecutionRecord({
      schema: "openthrottle.record/v1",
      id: "record-3",
      kind: "decision",
      pipeline_run_id: "run-1",
      reducer: "core/advance@1",
      input_record_ids: ["record-1"],
      effect_id: "forged-effect",
      payload_schema: "advance/v1",
      payload: { inline: {} },
      created_at: "2026-08-20T00:00:01.000Z",
    }, { payloadSchemas: recordPayloadSchemas })).toThrow(/effect_id: unknown field/);
    expect(() => validateExecutionRecord({
      schema: "openthrottle.record/v1",
      id: "record-4",
      kind: "decision",
      pipeline_run_id: "run-1",
      reducer: "core/advance@1",
      input_record_ids: ["record-1"],
      payload_schema: "advance/v1",
      payload: { inline: { evidence: "x".repeat(70_000) } },
      created_at: "2026-08-20T00:00:01.000Z",
    }, { payloadSchemas: recordPayloadSchemas })).toThrow(/inline: must be at most 65536 canonical JSON bytes/);
  });

  it("rejects unknown, wrong-kind, and malformed registered payload schemas", () => {
    const result = {
      schema: "openthrottle.record/v1",
      id: "record-5",
      kind: "result",
      pipeline_run_id: "run-1",
      attempt_id: "attempt-1",
      request_hash: sha("a"),
      definition_bundle_hash: sha("b"),
      input_subject: subject("c"),
      output_subject: subject("d"),
      payload_schema: "unknown/v1",
      payload: { inline: { outcome: "success", summary: "done" } },
      original_candidate_hash: sha("e"),
      normalized_candidate_hash: sha("f"),
      created_at: "2026-08-20T00:00:00.000Z",
    };
    expect(() => validateExecutionRecord(result, { payloadSchemas: recordPayloadSchemas }))
      .toThrow(/payload_schema: is not registered/);
    expect(() => validateExecutionRecord({ ...result, payload_schema: "advance/v1" }, {
      payloadSchemas: recordPayloadSchemas,
    })).toThrow(/payload_schema: is registered for decision records, not result/);
    expect(() => validateExecutionRecord({
      ...result,
      payload_schema: "unit-result/v1",
      payload: { inline: { outcome: "success", summary: ["wrong"] } },
    }, { payloadSchemas: recordPayloadSchemas })).toThrow(/must contain a successful outcome and string summary/);
  });
});

describe("effect intent identity", () => {
  function effect(payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
    return validateEffectIntent({
      schema: EFFECT_INTENT_SCHEMA,
      id: "effect-1",
      pipeline_run_id: "run-1",
      decision_record_id: "decision-1",
      kind: "github/publish-branch@1",
      idempotency_key: "run-1:publish",
      target: "github:owner/repo:refs/heads/ot/work",
      subject: subject("a"),
      payload,
      ...overrides,
    });
  }

  it("allows an exact replay and rejects conflicting idempotency reuse", () => {
    const first = effect({ branch: "ot/work" });
    expect(() => assertSameIdempotentEffect(first, effect({ branch: "ot/work" }))).not.toThrow();
    expect(() => assertSameIdempotentEffect(first, effect({ branch: "ot/other" })))
      .toThrow(/idempotency_key: conflicts with an existing immutable effect intent/);
    expect(() => assertSameIdempotentEffect(first, effect({ branch: "ot/work" }, {
      kind: "github/publish-pr@1",
    }))).toThrow(/idempotency_key: conflicts with an existing immutable effect intent/);
    expect(() => assertSameIdempotentEffect(first, effect({ branch: "ot/work" }, {
      subject: subject("b"),
    }))).toThrow(/idempotency_key: conflicts with an existing immutable effect intent/);
    expect(() => assertSameIdempotentEffect(first, effect({ branch: "ot/work" }, {
      target: "github:owner/other:refs/heads/ot/work",
    }))).toThrow(/idempotency_key: conflicts with an existing immutable effect intent/);

    const mutated = effect({ branch: "ot/work" });
    (mutated.value.payload as { branch: string }).branch = "ot/forged";
    expect(() => assertSameIdempotentEffect(first, mutated))
      .toThrow(/idempotency_key: references a mutated effect intent/);
  });
});
