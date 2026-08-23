import { describe, expect, it } from "vitest";
import {
  EFFECT_INTENT_SCHEMA,
  digestCanonicalJson,
  type EffectIntent,
} from "@openthrottle/contracts";
import {
  OPERATOR_EFFECT_REJECTION_RESULT_SCHEMA,
  OPERATOR_EFFECT_REJECTION_RUNTIME_SNAPSHOT,
  createOperatorEffectRejectionDelivery,
} from "./operator-effect-rejection.js";
import { effectIntentContentHash } from "./effect-intent.js";
import type { KernelOperatorEffectRejectionRequest } from "./ports.js";

const NOW = "2026-08-23T08:00:00.000Z";
const IDEMPOTENCY_KEY = `run-operator-rejection:integration:${"a".repeat(201)}`;
const RUNTIME_IDENTITY = "f".repeat(64);

const runtimeCreateIntent: EffectIntent = {
  schema: EFFECT_INTENT_SCHEMA,
  id: "effect-runtime-create",
  pipeline_run_id: "run-operator-rejection",
  decision_record_id: "decision-runtime-create",
  kind: "daytona/create-sandbox@1",
  idempotency_key: `run-operator-rejection:runtime:create:${RUNTIME_IDENTITY}`,
  target: `daytona:${RUNTIME_IDENTITY}`,
  subject: null,
  payload: {
    schema: "openthrottle.daytona-create/v1",
    identity: RUNTIME_IDENTITY,
    pipeline_run_id: "run-operator-rejection",
    repository: "owner/repo",
    base_branch: "main",
    base_commit: "a".repeat(40),
    snapshot: OPERATOR_EFFECT_REJECTION_RUNTIME_SNAPSHOT,
  },
};

const intent: EffectIntent = {
  schema: EFFECT_INTENT_SCHEMA,
  id: "effect-integration",
  pipeline_run_id: "run-operator-rejection",
  decision_record_id: "decision-publish",
  kind: "daytona/integrate-checkpoint@1",
  idempotency_key: IDEMPOTENCY_KEY,
  target: "daytona:sandbox-operator-rejection:integration",
  subject: "a".repeat(40),
  payload: {
    schema: "openthrottle.daytona-integration/v1",
    identity: RUNTIME_IDENTITY,
    pipeline_run_id: "run-operator-rejection",
    attempt_id: "attempt-publish",
    definition_bundle_hash: "b".repeat(64),
    checkpoint_base_subject: "a".repeat(40),
    current_subject: "a".repeat(40),
    candidate_checkpoint_id: "checkpoint-204",
    candidate_input_subject: "a".repeat(40),
    candidate_output_subject: "c".repeat(40),
    candidate_blob: { digest: "d".repeat(64) },
    candidate_artifact: { commit: "c".repeat(40) },
    current_ancestry: [],
  },
};

const request: KernelOperatorEffectRejectionRequest = {
  pipeline_run_id: intent.pipeline_run_id,
  effect_id: intent.id,
  expected_maintenance_version: 3,
  resolution_id: "resolution-sandbox-rejection",
  reason_code: "legacy_integration_idempotency_key_rejected_before_mutation",
  reason: "The sealed sandbox request failed validation before repository mutation.",
};

describe("operator Effect rejection evidence", () => {
  it("authors one deterministic rejected DeliveryRecord from executor-owned identity", () => {
    const intentHash = effectIntentContentHash(intent);
    const delivery = createOperatorEffectRejectionDelivery({
      request,
      intent,
      captured_run_version: 12,
      captured_effect_version: 7,
      intent_hash: intentHash,
      dispatch_fence: { lease_id: "effect-lease-204", worker_id: "worker-204" },
      reconciliation_ordinal: 4,
      prior_unknown_detail: "sandbox request exited before it could author an integration result",
      runtime_create_intent: runtimeCreateIntent,
      created_at: NOW,
    });

    expect(delivery).toMatchObject({
      kind: "delivery",
      pipeline_run_id: intent.pipeline_run_id,
      effect_id: intent.id,
      idempotency_key: intent.idempotency_key,
      external_identity: intent.target,
      status: "rejected",
      payload_schema: "openthrottle.effect-delivery/v1",
      payload: {
        inline: {
          effect_kind: intent.kind,
          provider: "operator",
          observed_via: "operator_resolution",
          result: {
            schema: OPERATOR_EFFECT_REJECTION_RESULT_SCHEMA,
            resolution_id: request.resolution_id,
            reason_code: request.reason_code,
            reason: request.reason,
            authorized_via: "deploy_token",
            maintenance_version: request.expected_maintenance_version,
            captured_run_version: 12,
            captured_effect_version: 7,
            intent_hash: intentHash,
            dispatch_fence: { lease_id: "effect-lease-204", worker_id: "worker-204" },
            reconciliation_ordinal: 4,
            prior_unknown_detail: "sandbox request exited before it could author an integration result",
            prior_unknown_detail_hash: digestCanonicalJson(
              "sandbox request exited before it could author an integration result",
            ),
            runtime_snapshot: OPERATOR_EFFECT_REJECTION_RUNTIME_SNAPSHOT,
            runtime_identity: RUNTIME_IDENTITY,
            runtime_create_effect_id: runtimeCreateIntent.id,
            idempotency_key_length: IDEMPOTENCY_KEY.length,
          },
        },
      },
      created_at: NOW,
    });
    expect((delivery.payload as { inline: { result: { resolution_digest: string } } })
      .inline.result.resolution_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(createOperatorEffectRejectionDelivery({
      request,
      intent,
      captured_run_version: 12,
      captured_effect_version: 7,
      intent_hash: intentHash,
      dispatch_fence: { lease_id: "effect-lease-204", worker_id: "worker-204" },
      reconciliation_ordinal: 4,
      prior_unknown_detail: "sandbox request exited before it could author an integration result",
      runtime_create_intent: runtimeCreateIntent,
      created_at: NOW,
    })).toEqual(delivery);
  });

  it("rejects widened reasons and mismatched executor identity", () => {
    const base = {
      request,
      intent,
      captured_run_version: 12,
      captured_effect_version: 7,
      intent_hash: effectIntentContentHash(intent),
      dispatch_fence: { lease_id: "effect-lease-204", worker_id: "worker-204" },
      reconciliation_ordinal: 4,
      prior_unknown_detail: "provider outcome unknown",
      runtime_create_intent: runtimeCreateIntent,
      created_at: NOW,
    };
    expect(() => createOperatorEffectRejectionDelivery({
      ...base,
      request: { ...request, reason: "x".repeat(1_501) },
    })).toThrow(/reason/);
    expect(() => createOperatorEffectRejectionDelivery({
      ...base,
      request: { ...request, pipeline_run_id: "another-run" },
    })).toThrow(/pipeline run/);
    expect(() => createOperatorEffectRejectionDelivery({
      ...base,
      intent_hash: "f".repeat(64),
    })).toThrow(/intent hash/);
    expect(() => createOperatorEffectRejectionDelivery({
      ...base,
      runtime_create_intent: {
        ...runtimeCreateIntent,
        payload: {
          ...(runtimeCreateIntent.payload as Record<string, unknown>),
          snapshot: "openthrottle-newer-snapshot",
        },
      },
    })).toThrow(/runtime snapshot/);
    expect(() => createOperatorEffectRejectionDelivery({
      ...base,
      intent: { ...intent, idempotency_key: "run-operator-rejection:integration:short" },
      intent_hash: effectIntentContentHash({
        ...intent,
        idempotency_key: "run-operator-rejection:integration:short",
      }),
    })).toThrow(/legacy integration idempotency-key failure/);
  });
});
