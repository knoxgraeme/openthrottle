import { describe, expect, it } from "vitest";
import {
  EXECUTION_RECORD_SCHEMA,
  RESULT_CANDIDATE_SCHEMA,
  digestCanonicalJson,
  type DecisionRecord,
  type ExecutionRecord,
  type JsonValue,
  type ResultRecord,
} from "@openthrottle/contracts";
import {
  COMMAND_RESULT_RECORD_PAYLOAD_SCHEMA,
  PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA,
  SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA,
} from "./evaluator-registry.js";
import {
  PUBLICATION_DRAFT_BODY_MAX_LENGTH,
  PUBLICATION_DRAFT_TITLE_MAX_LENGTH,
  sameSubjectGateEvidence,
  selectPublicationDraft,
} from "./publication-draft.js";

const RUN = "run-publication";
const BUNDLE = "b".repeat(64);
const SUBJECT = "c".repeat(40);
const NOW = "2026-08-24T12:00:00.000Z";

function result(title = "Restore authored publication copy", body = "Explains why and how this was verified."): ResultRecord {
  const attemptId = "attempt-draft-publication";
  const requestHash = "d".repeat(64);
  const candidate = { schema: RESULT_CANDIDATE_SCHEMA, outcome: "success", payload: { title, body } };
  const hash = digestCanonicalJson(candidate);
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: `result-${digestCanonicalJson({
      attempt_id: attemptId,
      request_hash: requestHash,
      normalized_candidate_hash: hash,
    }).slice(0, 48)}`,
    kind: "result",
    pipeline_run_id: RUN,
    attempt_id: attemptId,
    request_hash: requestHash,
    definition_bundle_hash: BUNDLE,
    input_subject: SUBJECT,
    output_subject: null,
    original_candidate_hash: hash,
    normalized_candidate_hash: hash,
    payload_schema: SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA,
    payload: { inline: {
      schema: SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA,
      semantic_schema_id: "core/publication-draft",
      outcome: "success",
      payload: { title, body },
      transformations: [],
    } },
    created_at: NOW,
  };
}

function acceptance(selected: ResultRecord, idSuffix = ""): DecisionRecord {
  const payload = {
    schema: PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA,
    stage_id: "draft_publication",
    evaluator: "core/action-outcome@1",
    outcome: "success",
    reason: "validated_semantic_result",
  };
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: idSuffix || `decision-${digestCanonicalJson({
      attempt_id: selected.attempt_id,
      input_record_ids: [selected.id],
      payload,
    }).slice(0, 48)}`,
    kind: "decision",
    pipeline_run_id: RUN,
    reducer: "core/action-outcome@1",
    input_record_ids: [selected.id],
    payload_schema: PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA,
    payload: { inline: payload },
    created_at: NOW,
  };
}

function select(records: readonly ExecutionRecord[]) {
  return selectPublicationDraft({
    records,
    pipeline_run_id: RUN,
    definition_bundle_hash: BUNDLE,
    input_subject: SUBJECT,
  });
}

function semanticInline(selected: ResultRecord): Record<string, unknown> {
  return (selected.payload as { inline: Record<string, unknown> }).inline;
}

describe("selectPublicationDraft", () => {
  it("selects one exact accepted maximum-bound copy without rewriting bytes", () => {
    const title = "t".repeat(PUBLICATION_DRAFT_TITLE_MAX_LENGTH);
    const body = "b".repeat(PUBLICATION_DRAFT_BODY_MAX_LENGTH);
    const selected = result(title, body);

    expect(select([selected, acceptance(selected)])).toEqual({
      result: selected,
      acceptance: acceptance(selected),
      title,
      body,
    });
  });

  it("rejects missing and duplicate publication results", () => {
    expect(() => select([])).toThrow(/exactly one publication draft ResultRecord/);
    const first = result();
    const secondBase = result("Another title", "Another body");
    const second = { ...secondBase, attempt_id: "attempt-other" };
    expect(() => select([
      first,
      acceptance(first),
      second,
      acceptance(second),
    ])).toThrow(/exactly one publication draft ResultRecord/);
  });

  it.each([
    ["foreign run", (value: ResultRecord) => ({ ...value, pipeline_run_id: "run-foreign" })],
    ["foreign bundle", (value: ResultRecord) => ({ ...value, definition_bundle_hash: "e".repeat(64) })],
    ["wrong subject", (value: ResultRecord) => ({ ...value, input_subject: "f".repeat(40) })],
    ["edit output", (value: ResultRecord) => ({ ...value, output_subject: "f".repeat(40) })],
  ])("rejects %s identity", (_label, mutate) => {
    const original = result();
    const changed = mutate(original);
    expect(() => select([changed, acceptance(changed)])).toThrow(/foreign or stale attempt identity/);
  });

  it.each([
    ["empty title", "", "body"],
    ["empty body", "title", ""],
    ["oversized title", "t".repeat(PUBLICATION_DRAFT_TITLE_MAX_LENGTH + 1), "body"],
    ["oversized body", "title", "b".repeat(PUBLICATION_DRAFT_BODY_MAX_LENGTH + 1)],
  ])("rejects %s", (_label, title, body) => {
    const malformed = result(title, body);
    expect(() => select([malformed, acceptance(malformed)])).toThrow(/empty, wrongly typed, or oversized/);
  });

  it("rejects missing, wrongly typed, and extra copy fields", () => {
    for (const payload of [
      { title: "title" },
      { title: "title", body: ["body"] },
      { title: "title", body: "body", provenance: "forged" },
    ]) {
      const malformed = result();
      semanticInline(malformed).payload = payload;
      expect(() => select([malformed, acceptance(malformed)])).toThrow(/publication draft copy/);
    }
  });

  it("rejects wrong semantic outcome, transformations, altered hashes, and duplicate acceptance", () => {
    const wrongOutcome = result();
    semanticInline(wrongOutcome).outcome = "failure";
    expect(() => select([wrongOutcome, acceptance(wrongOutcome)])).toThrow(/not an accepted/);

    const transformed = result();
    semanticInline(transformed).transformations = [{ id: "forged" }];
    expect(() => select([transformed, acceptance(transformed)])).toThrow(/not an accepted/);

    const altered = result();
    semanticInline(altered).payload = { title: "Altered", body: "body" };
    expect(() => select([altered, acceptance(altered)])).toThrow(/exact accepted bytes/);

    const duplicated = result();
    expect(() => select([
      duplicated,
      acceptance(duplicated),
      { ...acceptance(duplicated), id: "decision-duplicate" },
    ])).toThrow(/exactly one executor acceptance/);
  });

  it("rejects forged or widened executor acceptance", () => {
    const selected = result();
    const forged = acceptance(selected);
    (forged.payload as { inline: Record<string, JsonValue> }).inline.stage_id = "publish";
    expect(() => select([selected, forged])).toThrow(/not accepted by its sealed executor stage/);

    const widened = acceptance(selected);
    widened.input_record_ids.push("result-forged");
    expect(() => select([selected, widened])).toThrow(/foreign or widened authority/);
  });
});

describe("sameSubjectGateEvidence", () => {
  function gate(stage: string, subject = SUBJECT, outcome = "success"): [ResultRecord, DecisionRecord] {
    const attemptId = `attempt-${stage}`;
    const requestHash = digestCanonicalJson({ stage, subject, outcome });
    const resultPayload = {
      schema: COMMAND_RESULT_RECORD_PAYLOAD_SCHEMA,
      command_id: stage,
      outcome,
      exit_code: 0,
      summary: `${stage} passed`,
    };
    const hash = digestCanonicalJson(resultPayload);
    const gateResult: ResultRecord = {
      schema: EXECUTION_RECORD_SCHEMA,
      id: `result-${digestCanonicalJson({
        attempt_id: attemptId,
        request_hash: requestHash,
        normalized_candidate_hash: hash,
      }).slice(0, 48)}`,
      kind: "result",
      pipeline_run_id: RUN,
      attempt_id: attemptId,
      request_hash: requestHash,
      definition_bundle_hash: BUNDLE,
      input_subject: subject,
      output_subject: null,
      original_candidate_hash: hash,
      normalized_candidate_hash: hash,
      payload_schema: COMMAND_RESULT_RECORD_PAYLOAD_SCHEMA,
      payload: { inline: resultPayload },
      created_at: NOW,
    };
    const decisionPayload = {
      schema: PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA,
      stage_id: stage,
      evaluator: "core/command-outcome@1",
      outcome,
      reason: "executor_command_result",
    };
    const gateDecision: DecisionRecord = {
      schema: EXECUTION_RECORD_SCHEMA,
      id: `decision-${digestCanonicalJson({
        attempt_id: attemptId,
        input_record_ids: [gateResult.id],
        payload: decisionPayload,
      }).slice(0, 48)}`,
      kind: "decision",
      pipeline_run_id: RUN,
      reducer: "core/command-outcome@1",
      input_record_ids: [gateResult.id],
      payload_schema: PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA,
      payload: { inline: decisionPayload },
      created_at: NOW,
    };
    return [gateResult, gateDecision];
  }

  it("retains only successful executor command evidence for the exact subject", () => {
    const exact = gate("test");
    const noChange = gate("lint", SUBJECT, "no_change");
    const stale = gate("build", "f".repeat(40));
    const failed = gate("failed", SUBJECT, "failure");
    expect(sameSubjectGateEvidence({
      records: [...exact, ...noChange, ...stale, ...failed],
      pipeline_run_id: RUN,
      definition_bundle_hash: BUNDLE,
      input_subject: SUBJECT,
    }).map(({ id }) => id)).toEqual([
      ...exact,
      ...noChange,
    ].map(({ id }) => id).sort());
  });
});
