import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTION_CONTEXT_ARTIFACT_MAX_BYTES,
  ACTION_CONTEXT_SCHEMA,
  materializeActionContextArtifact,
  verifyActionContextArtifact,
} from "./action-context.mjs";

const directories = [];
const SUBJECT_A = "a".repeat(40);
const SUBJECT_B = "b".repeat(40);

afterEach(() => {
  for (const directory of directories.splice(0)) {
    const contextDirectory = join(directory, "action-context");
    if (existsSync(contextDirectory)) chmodSync(contextDirectory, 0o755);
    rmSync(directory, { recursive: true, force: true });
  }
});

function actionDirectory(label = "context") {
  const directory = mkdtempSync(join(tmpdir(), `ot-action-${label}-`));
  directories.push(directory);
  return directory;
}

function semanticRecord(id, payload = { summary: "Completed upstream work." }) {
  return {
    schema: "openthrottle.record/v1",
    id,
    kind: "result",
    pipeline_run_id: "run-private",
    attempt_id: "attempt-private",
    request_hash: "1".repeat(64),
    definition_bundle_hash: "2".repeat(64),
    input_subject: SUBJECT_A,
    output_subject: SUBJECT_B,
    original_candidate_hash: "3".repeat(64),
    normalized_candidate_hash: "4".repeat(64),
    payload_schema: "openthrottle.semantic-result-record/v1",
    payload: {
      inline: {
        schema: "openthrottle.semantic-result-record/v1",
        semantic_schema_id: "core/unit-result",
        outcome: "success",
        payload,
        transformations: [{
          id: "string-array-to-newlines/v1",
          path: "payload.summary",
          input_hash: "5".repeat(64),
          output_hash: "6".repeat(64),
        }],
      },
    },
    created_at: "2026-08-22T00:00:00.000Z",
  };
}

function externalIntegrationRecord(id = "record-integration") {
  return {
    schema: "openthrottle.record/v1",
    id,
    kind: "result",
    pipeline_run_id: "run-private",
    attempt_id: "attempt-integration-private",
    request_hash: "1".repeat(64),
    definition_bundle_hash: "2".repeat(64),
    input_subject: SUBJECT_A,
    output_subject: SUBJECT_B,
    original_candidate_hash: "3".repeat(64),
    normalized_candidate_hash: "3".repeat(64),
    payload_schema: "openthrottle.external-result-record/v1",
    payload: { inline: {
      schema: "openthrottle.external-result-record/v1",
      external_kind: "core/integrate-unit@1",
      outcome: "all_integrated",
      summary: "unit checkpoint integrated and durably pushed",
      delivery_record_ids: ["delivery-integrate-private", "delivery-push-private"],
    } },
    created_at: "2026-08-22T00:00:00.000Z",
  };
}

function request(overrides = {}) {
  return {
    stage_id: "repair_unit",
    scope: {
      kind: "loop_item",
      stage_id: "repair_unit",
      parent_attempt_id: "attempt-parent-private",
      loop_id: "execution_plan.units",
      item_id: "unit-b",
      item_index: 1,
    },
    context: {
      records: [],
      checkpoints: [],
    },
    ...overrides,
  };
}

function materialize(input, label = "context") {
  const root = actionDirectory(label);
  return {
    root,
    descriptor: materializeActionContextArtifact({
      request: input,
      actionDirectory: root,
      destination: join(root, "action-context", "context.json"),
    }),
  };
}

describe("executor action context", () => {
  it("projects exact semantic evidence and scope without executor-owned identities", () => {
    const records = [
      {
        schema: "openthrottle.record/v1",
        id: "record-z-delivery",
        kind: "delivery",
        pipeline_run_id: "run-private",
        effect_id: "effect-private",
        idempotency_key: "idempotency-private",
        external_identity: "sandbox-private",
        status: "confirmed",
        payload_schema: "openthrottle.effect-delivery/v1",
        payload: { inline: { provider_resource_id: "resource-private" } },
        created_at: "2026-08-22T00:00:00.000Z",
      },
      {
        schema: "openthrottle.record/v1",
        id: "record-d-decision",
        kind: "decision",
        pipeline_run_id: "run-private",
        reducer: "core/review-outcome@1",
        input_record_ids: ["record-a-result"],
        payload_schema: "openthrottle.pipeline-decision-record/v1",
        payload: { inline: {
          schema: "openthrottle.pipeline-decision-record/v1",
          stage_id: "accept_unit",
          evaluator: "core/review-outcome@1",
          outcome: "semantic_repair_required",
          reason: "blocking_review_finding",
        } },
        created_at: "2026-08-22T00:00:00.000Z",
      },
      {
        schema: "openthrottle.record/v1",
        id: "record-c-promotion",
        kind: "decision",
        pipeline_run_id: "run-private",
        reducer: "kernel/promote-admission@1",
        input_record_ids: [],
        payload_schema: "openthrottle.admission-promotion/v1",
        payload: { inline: {
          schema: "openthrottle.admission-promotion/v1",
          source_run_id: "run-private",
          source_attempt_id: "attempt-private",
          selected_pipeline: "core/structured",
          source_commit: SUBJECT_A,
          execution_plan: {
            schema: "openthrottle.execution-plan/v2",
            pipeline_id: "core/structured",
            summary: "Implement two units.",
            units: [],
          },
          planner_result_id: "planner-private",
          planner_result_hash: "7".repeat(64),
          reviewer_result_id: "reviewer-private",
          reviewer_result_hash: "8".repeat(64),
        } },
        created_at: "2026-08-22T00:00:00.000Z",
      },
      {
        schema: "openthrottle.record/v1",
        id: "record-b-command",
        kind: "result",
        pipeline_run_id: "run-private",
        attempt_id: "attempt-private",
        request_hash: "1".repeat(64),
        definition_bundle_hash: "2".repeat(64),
        input_subject: SUBJECT_A,
        output_subject: SUBJECT_B,
        original_candidate_hash: "3".repeat(64),
        normalized_candidate_hash: "4".repeat(64),
        payload_schema: "openthrottle.command-result-record/v1",
        payload: { inline: {
          schema: "openthrottle.command-result-record/v1",
          command_id: "test",
          outcome: "failure",
          exit_code: 1,
          summary: "One focused test failed.",
        } },
        created_at: "2026-08-22T00:00:00.000Z",
      },
      semanticRecord("record-a-result", {
        summary: "Review found a real defect.",
        findings: [{ title: "Lost update", severity: "P1" }],
        downstream_context: ["Preserve the transaction boundary."],
      }),
    ];
    const checkpoints = [{
      schema: "openthrottle.attempt-checkpoint/v1",
      id: "checkpoint-a",
      pipeline_run_id: "run-private",
      attempt_id: "attempt-private",
      request_hash: "1".repeat(64),
      definition_bundle_hash: "2".repeat(64),
      input_subject: SUBJECT_A,
      output_subject: SUBJECT_B,
      native_session_id: "session-private",
      payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      payload: { blob: {
        algorithm: "sha256",
        digest: "9".repeat(64),
        bytes: 123,
        encoding: "binary",
        media_type: "application/x-git-bundle",
        payload_schema: "openthrottle.git-checkpoint-bundle/v1",
      } },
      captured_at: "2026-08-22T00:00:00.000Z",
    }];

    const { descriptor } = materialize(request({ context: { records, checkpoints } }));
    const artifact = JSON.parse(readFileSync(descriptor.path, "utf8"));

    expect(artifact).toEqual({
      schema: ACTION_CONTEXT_SCHEMA,
      stage_id: "repair_unit",
      scope: {
        kind: "loop_item",
        loop_id: "execution_plan.units",
        item_id: "unit-b",
        item_index: 1,
      },
      records: [
        {
          record_id: "record-a-result",
          kind: "semantic_result",
          semantic_schema_id: "core/unit-result",
          outcome: "success",
          payload: {
            summary: "Review found a real defect.",
            findings: [{ title: "Lost update", severity: "P1" }],
            downstream_context: ["Preserve the transaction boundary."],
          },
        },
        {
          record_id: "record-b-command",
          kind: "command_result",
          command_id: "test",
          outcome: "failure",
          exit_code: 1,
          summary: "One focused test failed.",
        },
        {
          record_id: "record-c-promotion",
          kind: "admission_promotion",
          selected_pipeline: "core/structured",
          source_commit: SUBJECT_A,
          execution_plan: {
            schema: "openthrottle.execution-plan/v2",
            pipeline_id: "core/structured",
            summary: "Implement two units.",
            units: [],
          },
        },
        {
          record_id: "record-d-decision",
          kind: "pipeline_decision",
          stage_id: "accept_unit",
          evaluator: "core/review-outcome@1",
          outcome: "semantic_repair_required",
          reason: "blocking_review_finding",
        },
      ],
      checkpoints: [{
        checkpoint_id: "checkpoint-a",
        input_subject: SUBJECT_A,
        output_subject: SUBJECT_B,
      }],
      omitted: {
        delivery_records: 1,
        checkpoint_payloads: 1,
      },
    });
    const serialized = readFileSync(descriptor.path, "utf8");
    for (const privateValue of [
      "run-private", "attempt-private", "session-private", "effect-private",
      "idempotency-private", "sandbox-private", "resource-private", "planner-private",
      "reviewer-private", "9".repeat(64),
    ]) expect(serialized).not.toContain(privateValue);
    expect(statSync(descriptor.path).mode & 0o777).toBe(0o444);
    expect(descriptor.bytes).toBeLessThanOrEqual(ACTION_CONTEXT_ARTIFACT_MAX_BYTES);
    expect(verifyActionContextArtifact(descriptor)).toEqual(descriptor);
  });

  it("is canonical and deterministic while preserving fanout identity", () => {
    const firstRequest = request({
      stage_id: "persona_review",
      scope: {
        kind: "fanout_member",
        stage_id: "persona_review",
        parent_attempt_id: "attempt-private",
        fanout_id: "selection.personas",
        member_id: "core/security",
        member_index: 2,
      },
      context: {
        records: [semanticRecord("record-b"), semanticRecord("record-a")],
        checkpoints: [],
      },
    });
    const secondRequest = {
      ...firstRequest,
      context: { ...firstRequest.context, records: [...firstRequest.context.records].reverse() },
    };

    const first = materialize(firstRequest, "canonical-a").descriptor;
    const second = materialize(secondRequest, "canonical-b").descriptor;
    expect(readFileSync(first.path, "utf8")).toBe(readFileSync(second.path, "utf8"));
    expect(first.sha256).toBe(second.sha256);
    expect(JSON.parse(readFileSync(first.path, "utf8")).scope).toEqual({
      kind: "fanout_member",
      fanout_id: "selection.personas",
      member_id: "core/security",
      member_index: 2,
    });
  });

  it("projects exact external integration evidence without executor-owned delivery identities", () => {
    const { descriptor } = materialize(request({
      context: { records: [externalIntegrationRecord()], checkpoints: [] },
    }), "external-integration");
    const serialized = readFileSync(descriptor.path, "utf8");

    expect(JSON.parse(serialized).records).toEqual([{
      record_id: "record-integration",
      kind: "external_result",
      external_kind: "core/integrate-unit@1",
      outcome: "all_integrated",
      summary: "unit checkpoint integrated and durably pushed",
    }]);
    expect(serialized).not.toContain("delivery-integrate-private");
    expect(serialized).not.toContain("delivery-push-private");
    expect(serialized).not.toContain("attempt-integration-private");
  });

  it("rejects malformed or unbounded external integration evidence", () => {
    const missingDeliveries = externalIntegrationRecord("record-missing-deliveries");
    delete missingDeliveries.payload.inline.delivery_record_ids;
    expect(() => materialize(request({
      context: { records: [missingDeliveries], checkpoints: [] },
    }), "external-missing-deliveries")).toThrow(
      "external result record record-missing-deliveries has an invalid payload",
    );

    const repeatedDelivery = externalIntegrationRecord("record-repeated-delivery");
    repeatedDelivery.payload.inline.delivery_record_ids = ["delivery-a", "delivery-a"];
    expect(() => materialize(request({
      context: { records: [repeatedDelivery], checkpoints: [] },
    }), "external-repeated-delivery")).toThrow(
      "external result record record-repeated-delivery repeats a delivery record ID",
    );

    const overlongSummary = externalIntegrationRecord("record-overlong-summary");
    overlongSummary.payload.inline.summary = "x".repeat(4_001);
    expect(() => materialize(request({
      context: { records: [overlongSummary], checkpoints: [] },
    }), "external-overlong-summary")).toThrow(
      "external result record record-overlong-summary has an invalid payload",
    );
  });

  it("requires the index belonging to the exact scope kind", () => {
    expect(() => materialize(request({
      scope: {
        kind: "loop_item",
        stage_id: "repair_unit",
        parent_attempt_id: "attempt-parent-private",
        loop_id: "execution_plan.units",
        item_id: "unit-b",
        member_index: 1,
      },
    }), "loop-wrong-index")).toThrow("action context loop item index must be a non-negative integer");

    expect(() => materialize(request({
      stage_id: "persona_review",
      scope: {
        kind: "fanout_member",
        stage_id: "persona_review",
        parent_attempt_id: "attempt-parent-private",
        fanout_id: "selection.personas",
        member_id: "core/security",
        item_index: 2,
      },
    }), "fanout-wrong-index")).toThrow("action context fanout member index must be a non-negative integer");
  });

  it("fails closed for blob-backed or unsupported semantic evidence", () => {
    const blob = semanticRecord("record-blob");
    blob.payload = { blob: {
      algorithm: "sha256",
      digest: "9".repeat(64),
      bytes: 100,
      encoding: "utf-8",
      media_type: "application/json",
      payload_schema: "openthrottle.semantic-result-record/v1",
    } };
    expect(() => materialize(request({ context: { records: [blob], checkpoints: [] } }), "blob"))
      .toThrow("required semantic record record-blob is blob-backed");

    const unsupported = semanticRecord("record-unsupported");
    unsupported.payload_schema = "custom.unprojected-result/v1";
    expect(() => materialize(request({
      context: { records: [unsupported], checkpoints: [] },
    }), "unsupported")).toThrow("required result record record-unsupported uses unsupported payload schema");
  });

  it("rejects an oversized projection without truncating required evidence", () => {
    const records = Array.from({ length: 10 }, (_, index) => semanticRecord(
      `record-${String(index).padStart(2, "0")}`,
      { summary: `${index}:${"x".repeat(60 * 1024)}` },
    ));
    const root = actionDirectory("oversized");
    const destination = join(root, "action-context", "context.json");
    expect(() => materializeActionContextArtifact({
      request: request({ context: { records, checkpoints: [] } }),
      actionDirectory: root,
      destination,
    })).toThrow(`action context artifact exceeds ${ACTION_CONTEXT_ARTIFACT_MAX_BYTES} bytes`);
    expect(() => readFileSync(destination)).toThrow();
  });

  it("detects content and permission changes after materialization", () => {
    const { descriptor } = materialize(request(), "tamper");
    chmodSync(descriptor.path, 0o644);
    expect(() => verifyActionContextArtifact(descriptor)).toThrow("lost its executor-owned read-only seal");
    chmodSync(descriptor.path, 0o644);
    writeFileSync(descriptor.path, "{}\n");
    chmodSync(descriptor.path, 0o444);
    expect(() => verifyActionContextArtifact(descriptor)).toThrow(/seal|content changed/);
  });
});
