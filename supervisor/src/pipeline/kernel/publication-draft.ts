import {
  RESULT_CANDIDATE_SCHEMA,
  compareCodeUnits,
  digestCanonicalJson,
  type DecisionRecord,
  type ExecutionRecord,
  type ResultRecord,
} from "@openthrottle/contracts";
import {
  COMMAND_RESULT_RECORD_PAYLOAD_SCHEMA,
  PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA,
  SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA,
} from "./evaluator-registry.js";

export const PUBLICATION_DRAFT_SEMANTIC_SCHEMA_ID = "core/publication-draft" as const;
export const PUBLICATION_DRAFT_TITLE_MAX_LENGTH = 72;
export const PUBLICATION_DRAFT_BODY_MAX_LENGTH = 12_000;

const ACCEPTED_COMMAND_OUTCOMES = ["success", "no_change"];

export interface SelectedPublicationDraft {
  result: ResultRecord;
  acceptance: DecisionRecord;
  title: string;
  body: string;
}

function exactObject(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const actual = Object.keys(input).sort(compareCodeUnits);
  const expected = [...keys].sort(compareCodeUnits);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} must contain exactly ${expected.join(" and ")}`);
  }
  return input;
}

function hasOnlyInputRecord(decision: DecisionRecord, recordId: string): boolean {
  return decision.input_record_ids.length === 1 && decision.input_record_ids[0] === recordId;
}

function publicationCandidate(record: ExecutionRecord): record is ResultRecord {
  if (record.kind !== "result" || !("inline" in record.payload)) return false;
  const value = record.payload.inline;
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).semantic_schema_id === PUBLICATION_DRAFT_SEMANTIC_SCHEMA_ID);
}

function exactPublicationCopy(input: {
  record: ResultRecord;
  pipeline_run_id: string;
  definition_bundle_hash: string;
  input_subject: string;
}): { title: string; body: string } {
  const { record } = input;
  if (
    record.pipeline_run_id !== input.pipeline_run_id ||
    record.definition_bundle_hash !== input.definition_bundle_hash ||
    record.input_subject !== input.input_subject || record.output_subject !== null ||
    record.payload_schema !== SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA ||
    !("inline" in record.payload)
  ) throw new Error("publication draft ResultRecord has foreign or stale attempt identity");

  const semantic = exactObject(record.payload.inline, "publication draft semantic payload", [
    "schema", "semantic_schema_id", "outcome", "payload", "transformations",
  ]);
  if (
    semantic.schema !== SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA ||
    semantic.semantic_schema_id !== PUBLICATION_DRAFT_SEMANTIC_SCHEMA_ID ||
    semantic.outcome !== "success" || !Array.isArray(semantic.transformations) ||
    semantic.transformations.length !== 0
  ) throw new Error("publication draft ResultRecord is not an accepted untransformed result");
  const copy = exactObject(semantic.payload, "publication draft copy", ["title", "body"]);
  if (
    typeof copy.title !== "string" || copy.title.length < 1 ||
    copy.title.length > PUBLICATION_DRAFT_TITLE_MAX_LENGTH ||
    typeof copy.body !== "string" || copy.body.length < 1 ||
    copy.body.length > PUBLICATION_DRAFT_BODY_MAX_LENGTH
  ) throw new Error("publication draft copy is empty, wrongly typed, or oversized");

  const normalizedHash = digestCanonicalJson({
    schema: RESULT_CANDIDATE_SCHEMA,
    outcome: "success",
    payload: { title: copy.title, body: copy.body },
  });
  const expectedId = `result-${digestCanonicalJson({
    attempt_id: record.attempt_id,
    request_hash: record.request_hash,
    normalized_candidate_hash: normalizedHash,
  }).slice(0, 48)}`;
  if (
    record.original_candidate_hash !== normalizedHash ||
    record.normalized_candidate_hash !== normalizedHash || record.id !== expectedId
  ) throw new Error("publication draft ResultRecord does not bind its exact accepted bytes");
  return { title: copy.title, body: copy.body };
}

function exactAcceptanceDecision(
  records: readonly ExecutionRecord[],
  result: ResultRecord,
): DecisionRecord {
  const matches = records.filter((record): record is DecisionRecord =>
    record.kind === "decision" && record.input_record_ids.includes(result.id));
  if (matches.length !== 1) {
    throw new Error("publication draft requires exactly one executor acceptance DecisionRecord");
  }
  const decision = matches[0]!;
  if (
    decision.pipeline_run_id !== result.pipeline_run_id ||
    decision.reducer !== "core/action-outcome@1" ||
    decision.payload_schema !== PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA ||
    !hasOnlyInputRecord(decision, result.id) ||
    !("inline" in decision.payload)
  ) throw new Error("publication draft acceptance DecisionRecord has foreign or widened authority");
  const payload = exactObject(decision.payload.inline, "publication draft acceptance", [
    "schema", "stage_id", "evaluator", "outcome", "reason",
  ]);
  if (
    payload.schema !== PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA ||
    payload.stage_id !== "draft_publication" || payload.evaluator !== "core/action-outcome@1" ||
    payload.outcome !== "success" || payload.reason !== "validated_semantic_result"
  ) throw new Error("publication draft was not accepted by its sealed executor stage");
  const expectedId = `decision-${digestCanonicalJson({
    attempt_id: result.attempt_id,
    input_record_ids: [result.id],
    payload,
  }).slice(0, 48)}`;
  if (decision.id !== expectedId) {
    throw new Error("publication draft acceptance DecisionRecord has invalid deterministic identity");
  }
  return decision;
}

export function selectPublicationDraft(input: {
  records: Iterable<ExecutionRecord>;
  pipeline_run_id: string;
  definition_bundle_hash: string;
  input_subject: string;
}): SelectedPublicationDraft {
  const records = [...input.records];
  const candidates = records.filter(publicationCandidate);
  if (candidates.length !== 1) {
    throw new Error("publication requires exactly one publication draft ResultRecord");
  }
  const result = candidates[0]!;
  const copy = exactPublicationCopy({ ...input, record: result });
  return {
    result,
    acceptance: exactAcceptanceDecision(records, result),
    ...copy,
  };
}

function acceptedCommandResult(input: {
  record: ExecutionRecord;
  pipeline_run_id: string;
  definition_bundle_hash: string;
  input_subject: string;
}): input is typeof input & { record: ResultRecord } {
  const { record } = input;
  if (
    record.kind !== "result" || record.pipeline_run_id !== input.pipeline_run_id ||
    record.definition_bundle_hash !== input.definition_bundle_hash ||
    record.input_subject !== input.input_subject ||
    record.output_subject !== null || record.payload_schema !== COMMAND_RESULT_RECORD_PAYLOAD_SCHEMA ||
    !("inline" in record.payload)
  ) return false;
  const payload = record.payload.inline;
  return Boolean(payload && typeof payload === "object" && !Array.isArray(payload) &&
    ACCEPTED_COMMAND_OUTCOMES.includes(String((payload as Record<string, unknown>).outcome)));
}

/** Retains immutable executor gate evidence while it still describes the exact subject. */
export function sameSubjectGateEvidence(input: {
  records: Iterable<ExecutionRecord>;
  pipeline_run_id: string;
  definition_bundle_hash: string;
  input_subject: string;
}): ExecutionRecord[] {
  const records = [...input.records];
  const results = records.filter((record): record is ResultRecord => acceptedCommandResult({
    record,
    pipeline_run_id: input.pipeline_run_id,
    definition_bundle_hash: input.definition_bundle_hash,
    input_subject: input.input_subject,
  }));
  const decisions: DecisionRecord[] = [];
  for (const result of results) {
    const payload = exactObject(
      (result.payload as { inline: unknown }).inline,
      `verified gate result ${result.id}`,
      ["schema", "command_id", "outcome", "exit_code", "summary"],
    );
    if (
      payload.schema !== COMMAND_RESULT_RECORD_PAYLOAD_SCHEMA ||
      typeof payload.command_id !== "string" ||
      !ACCEPTED_COMMAND_OUTCOMES.includes(String(payload.outcome)) ||
      !Number.isSafeInteger(payload.exit_code) || typeof payload.summary !== "string" ||
      payload.summary.length > 4_000
    ) throw new Error(`verified gate result ${result.id} is malformed`);
    const hash = digestCanonicalJson(payload);
    const expectedResultId = `result-${digestCanonicalJson({
      attempt_id: result.attempt_id,
      request_hash: result.request_hash,
      normalized_candidate_hash: hash,
    }).slice(0, 48)}`;
    if (
      result.original_candidate_hash !== hash || result.normalized_candidate_hash !== hash ||
      result.id !== expectedResultId
    ) throw new Error(`verified gate result ${result.id} does not bind its executor bytes`);
    const matches = records.filter((record): record is DecisionRecord =>
      record.kind === "decision" && record.input_record_ids.includes(result.id));
    if (matches.length !== 1) {
      throw new Error(`verified gate result ${result.id} requires one exact DecisionRecord`);
    }
    const decision = matches[0]!;
    if (
      decision.pipeline_run_id !== input.pipeline_run_id ||
      decision.reducer !== "core/command-outcome@1" ||
      decision.payload_schema !== PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA ||
      !hasOnlyInputRecord(decision, result.id) ||
      !("inline" in decision.payload)
    ) throw new Error(`verified gate result ${result.id} has invalid executor authority`);
    const decisionPayload = exactObject(
      decision.payload.inline,
      `verified gate decision ${decision.id}`,
      ["schema", "stage_id", "evaluator", "outcome", "reason"],
    );
    if (
      decisionPayload.schema !== PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA ||
      typeof decisionPayload.stage_id !== "string" ||
      decisionPayload.evaluator !== "core/command-outcome@1" ||
      decisionPayload.outcome !== payload.outcome ||
      decisionPayload.reason !== "executor_command_result"
    ) throw new Error(`verified gate decision ${decision.id} is malformed`);
    const expectedDecisionId = `decision-${digestCanonicalJson({
      attempt_id: result.attempt_id,
      input_record_ids: [result.id],
      payload: decisionPayload,
    }).slice(0, 48)}`;
    if (decision.id !== expectedDecisionId) {
      throw new Error(`verified gate decision ${decision.id} has invalid deterministic identity`);
    }
    decisions.push(decision);
  }
  return [...results, ...decisions].sort((left, right) => compareCodeUnits(left.id, right.id));
}
