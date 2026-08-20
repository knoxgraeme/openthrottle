import { digestCanonicalJson } from "./canonical.js";

export const CANONICAL_DETERMINISM_FIXTURE = {
  zeta: [
    { nested: { beta: true, alpha: false }, id: "second" },
    { id: "first", nested: { delta: null, gamma: [3, 1, 2] } },
  ],
  alpha: {
    empty: {},
    unicode: "plain-ascii-fixture",
    number: 123.45,
  },
  unicode_order: {
    "ä": "after-ascii-by-code-unit",
    z: "ascii",
  },
  middle: [
    "value",
    0,
    false,
    null,
  ],
};

/**
 * Representative values for every first-release execution-kernel contract.
 * Consumers use this closed fixture to prove canonical byte and digest parity
 * without importing supervisor or sandbox implementation code.
 */
export const EXECUTION_KERNEL_DETERMINISM_FIXTURE = {
  config: {
    schema: "openthrottle.config/v2",
    pipeline: "structured",
    engine: "codex",
  },
  pipeline: {
    schema: "openthrottle.pipeline-definition/v1",
    id: "structured",
    version: 1,
    entry: "implement",
    stages: [{
      id: "implement",
      kind: "agent",
      agent_id: "implementer",
      repository_authority: "edit",
      skills: ["implement-unit"],
      entry_skill: "implement-unit",
      eval: "unit-result",
      on: { success: { terminal: "completed" } },
    }],
  },
  compiled_manifest: {
    schema: "openthrottle.compiled-pipeline-manifest/v1",
    pipeline_id: "structured",
    pipeline_version: 1,
    entry_stage: "implement",
    definition_bundle_hash: "b".repeat(64),
    compiler_version: "definition-compiler/v1",
    runtime_capability_digest: "9".repeat(64),
    stages: [{
      id: "implement",
      kind: "agent",
      engine: "codex",
      agent_id: "implementer",
      repository_authority: "edit",
      skills: ["implement-unit"],
      entry_skill: "implement-unit",
      eval: "unit-result",
      on: { success: { terminal: "completed" } },
    }],
  },
  definition_bundle: {
    schema: "openthrottle.definition-bundle/v1",
    compiler_version: "definition-compiler/v1",
    runtime_capability_digest: "9".repeat(64),
    source_commit: "c".repeat(40),
    pipeline_id: "structured",
    entries: [
      {
        definition_kind: "config",
        definition_id: "repository",
        origin: { kind: "repository", source_commit: "c".repeat(40) },
        path: ".openthrottle/config.yml",
        content_hash: digestCanonicalJson({ engine: "codex", pipeline: "structured" }),
        normalized_payload: { engine: "codex", pipeline: "structured" },
      },
      {
        definition_kind: "pipeline",
        definition_id: "structured",
        origin: { kind: "repository", source_commit: "c".repeat(40) },
        path: ".openthrottle/pipelines/structured/pipeline.yml",
        content_hash: digestCanonicalJson({ entry: "implement" }),
        normalized_payload: { entry: "implement" },
      },
    ],
  },
  semantic_result_schema: {
    schema: "openthrottle.semantic-result-schema/v1",
    id: "unit-result",
    outcomes: ["success", "needs_human"],
    payload: {
      summary: {
        type: "string",
        required: true,
        max_length: 4_000,
        normalize: "string-array-to-newlines/v1",
      },
    },
  },
  result_candidate: {
    schema: "openthrottle.result-candidate/v1",
    outcome: "success",
    payload: { summary: "Implemented and verified." },
  },
  attempt_identity: {
    schema: "openthrottle.attempt-identity/v1",
    pipeline_run_id: "run-1",
    attempt_id: "attempt-1",
    request_hash: "a".repeat(64),
    definition_bundle_hash: "b".repeat(64),
    input_subject: "c".repeat(40),
    native_session_id: null,
  },
  attempt_checkpoint: {
    schema: "openthrottle.attempt-checkpoint/v1",
    id: "checkpoint-1",
    pipeline_run_id: "run-1",
    attempt_id: "attempt-1",
    request_hash: "a".repeat(64),
    definition_bundle_hash: "b".repeat(64),
    input_subject: "c".repeat(40),
    output_subject: "d".repeat(40),
    native_session_id: null,
    payload_schema: "checkpoint/v1",
    payload: {
      blob: {
        algorithm: "sha256",
        digest: "7".repeat(64),
        bytes: 70_000,
        encoding: "binary",
        media_type: "application/octet-stream",
        payload_schema: "checkpoint/v1",
      },
    },
    captured_at: "2026-08-20T00:00:00.000Z",
  },
  result_record: {
    schema: "openthrottle.record/v1",
    id: "record-1",
    kind: "result",
    pipeline_run_id: "run-1",
    attempt_id: "attempt-1",
    request_hash: "a".repeat(64),
    definition_bundle_hash: "b".repeat(64),
    input_subject: "c".repeat(40),
    output_subject: "d".repeat(40),
    payload_schema: "unit-result/v1",
    payload: { inline: { outcome: "success", summary: "Implemented and verified." } },
    original_candidate_hash: "e".repeat(64),
    normalized_candidate_hash: "f".repeat(64),
    created_at: "2026-08-20T00:00:00.000Z",
  },
  decision_record: {
    schema: "openthrottle.record/v1",
    id: "decision-1",
    kind: "decision",
    pipeline_run_id: "run-1",
    reducer: "core/advance@1",
    input_record_ids: ["record-1"],
    payload_schema: "advance/v1",
    payload: { inline: { next: "publish" } },
    created_at: "2026-08-20T00:00:01.000Z",
  },
  delivery_record: {
    schema: "openthrottle.record/v1",
    id: "delivery-1",
    kind: "delivery",
    pipeline_run_id: "run-1",
    effect_id: "effect-1",
    idempotency_key: "run-1:publish",
    external_identity: "github:owner/repo:refs/heads/ot/work",
    status: "confirmed",
    payload_schema: "github-delivery/v1",
    payload: { inline: { accepted: true } },
    created_at: "2026-08-20T00:00:02.000Z",
  },
  blob_pointer: {
    algorithm: "sha256",
    digest: "8".repeat(64),
    bytes: 70_000,
    encoding: "utf-8",
    media_type: "application/json",
    payload_schema: "evidence/v1",
  },
  effect_intent: {
    schema: "openthrottle.effect-intent/v1",
    id: "effect-1",
    pipeline_run_id: "run-1",
    decision_record_id: "decision-1",
    kind: "github/publish-branch@1",
    idempotency_key: "run-1:publish",
    target: "github:owner/repo:refs/heads/ot/work",
    subject: "d".repeat(40),
    payload: { branch: "ot/work" },
  },
} as const;

export interface CanonicalDigestFixtureResult {
  environment: string;
  canonicalJson: string;
  digest: string;
}
