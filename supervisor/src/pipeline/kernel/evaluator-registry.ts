import {
  ATTEMPT_FORENSICS_PAYLOAD_CONTRACT,
  ATTEMPT_FORENSICS_PAYLOAD_SCHEMA,
  EXECUTION_RECORD_SCHEMA,
  INVALID_RESULT_EVIDENCE_PAYLOAD_CONTRACT,
  INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA,
  REVIEW_FINDING_SEVERITIES,
  canonicalJson,
  compareCodeUnits,
  digestCanonicalJson,
  jsonValueAt,
  validateAndNormalizeResultCandidate,
  type CompiledPipelineStage,
  type DecisionRecord,
  type EvalDefinition,
  type ExecutionRecord,
  type ExecutionRecordPayloadContract,
  type ExecutionRecordPayloadRegistry,
  type JsonValue,
  type ReviewFindingV1,
  type ResultRecord,
} from "@openthrottle/contracts";
import type {
  KernelCommandResult,
  StagedSemanticCandidate,
} from "../../runtime/kernel-contracts.js";
import type { KernelAttempt } from "./types.js";
import {
  SESSION_EVIDENCE_RECORD_PAYLOAD_CONTRACT,
  SESSION_EVIDENCE_RECORD_PAYLOAD_SCHEMA,
} from "./session-evidence.js";

export const SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA =
  "openthrottle.semantic-result-record/v1" as const;
export const COMMAND_RESULT_RECORD_PAYLOAD_SCHEMA =
  "openthrottle.command-result-record/v1" as const;
export const PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA =
  "openthrottle.pipeline-decision-record/v1" as const;
const BLOCKING_REVIEW_FINDING_SEVERITIES = new Set(REVIEW_FINDING_SEVERITIES.slice(0, 2));

export interface SemanticResultRecordPayload {
  schema: typeof SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA;
  semantic_schema_id: string;
  outcome: string;
  payload: JsonValue;
  transformations: readonly {
    id: string;
    path: string;
    input_hash: string;
    output_hash: string;
  }[];
}

export interface CommandResultRecordPayload {
  schema: typeof COMMAND_RESULT_RECORD_PAYLOAD_SCHEMA;
  command_id: string;
  outcome: KernelCommandResult["outcome"];
  exit_code: number;
  summary: string;
}

export interface PipelineDecisionRecordPayload {
  schema: typeof PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA;
  stage_id: string;
  evaluator: string;
  outcome: string;
  reason: string;
}

export interface EvaluatedKernelResult {
  evaluator: string;
  outcome: string;
  reason: string;
}

function exactObject(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!keys.includes(key)) throw new Error(`${label}.${key} is unknown`);
  }
  return input;
}

function semanticPayload(value: unknown): SemanticResultRecordPayload {
  const input = exactObject(value, "semantic result payload", [
    "schema", "semantic_schema_id", "outcome", "payload", "transformations",
  ]);
  if (input.schema !== SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA) {
    throw new Error("semantic result payload schema is unsupported");
  }
  if (typeof input.semantic_schema_id !== "string" || typeof input.outcome !== "string") {
    throw new Error("semantic result payload identity is invalid");
  }
  const transformations = jsonValueAt(input.transformations, "semantic_result.transformations");
  if (!Array.isArray(transformations)) throw new Error("semantic result transformations must be an array");
  return {
    schema: SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA,
    semantic_schema_id: input.semantic_schema_id,
    outcome: input.outcome,
    payload: jsonValueAt(input.payload, "semantic_result.payload"),
    transformations: transformations as unknown as SemanticResultRecordPayload["transformations"],
  };
}

function commandPayload(value: unknown): CommandResultRecordPayload {
  const input = exactObject(value, "command result payload", [
    "schema", "command_id", "outcome", "exit_code", "summary",
  ]);
  if (
    input.schema !== COMMAND_RESULT_RECORD_PAYLOAD_SCHEMA ||
    typeof input.command_id !== "string" ||
    !["success", "no_change", "retryable_infrastructure_failure", "failure"].includes(
      String(input.outcome),
    ) ||
    !Number.isSafeInteger(input.exit_code) ||
    typeof input.summary !== "string"
  ) {
    throw new Error("command result payload is invalid");
  }
  return input as unknown as CommandResultRecordPayload;
}

function decisionPayload(value: unknown): PipelineDecisionRecordPayload {
  const input = exactObject(value, "pipeline decision payload", [
    "schema", "stage_id", "evaluator", "outcome", "reason",
  ]);
  if (
    input.schema !== PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA ||
    typeof input.stage_id !== "string" || typeof input.evaluator !== "string" ||
    typeof input.outcome !== "string" || typeof input.reason !== "string"
  ) {
    throw new Error("pipeline decision payload is invalid");
  }
  return input as unknown as PipelineDecisionRecordPayload;
}

const payloadContracts: readonly [string, ExecutionRecordPayloadContract][] = [
  [SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA, {
    kind: "result",
    parseInline: semanticPayload,
  }],
  [COMMAND_RESULT_RECORD_PAYLOAD_SCHEMA, {
    kind: "result",
    parseInline: commandPayload,
  }],
  [PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA, {
    kind: "decision",
    parseInline: decisionPayload,
  }],
  [ATTEMPT_FORENSICS_PAYLOAD_SCHEMA, ATTEMPT_FORENSICS_PAYLOAD_CONTRACT],
  [INVALID_RESULT_EVIDENCE_PAYLOAD_SCHEMA, INVALID_RESULT_EVIDENCE_PAYLOAD_CONTRACT],
  [SESSION_EVIDENCE_RECORD_PAYLOAD_SCHEMA, SESSION_EVIDENCE_RECORD_PAYLOAD_CONTRACT],
];

export function ordinaryKernelPayloadSchemas(): ExecutionRecordPayloadRegistry {
  return new Map(payloadContracts);
}

function recordId(kind: "result" | "decision", identity: unknown): string {
  return `${kind}-${digestCanonicalJson(identity).slice(0, 48)}`;
}

function assertCandidateReplay(
  staged: StagedSemanticCandidate,
  evaluation: EvalDefinition,
): SemanticResultRecordPayload {
  if (
    staged.schema !== "openthrottle.staged-result-candidate/v1" ||
    staged.semantic_schema_id !== evaluation.result.id
  ) {
    throw new Error("staged candidate does not use the action's sealed eval schema");
  }
  const normalized = validateAndNormalizeResultCandidate(staged.original, evaluation.result, {
    source: "staged_candidate.original",
  });
  if (
    staged.original_hash !== normalized.original_hash ||
    staged.normalized_hash !== normalized.normalized_hash ||
    canonicalJson(staged.candidate) !== canonicalJson(normalized.value) ||
    canonicalJson(staged.transformations) !== canonicalJson(normalized.transformations)
  ) {
    throw new Error("staged candidate does not match deterministic validation and normalization");
  }
  return {
    schema: SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA,
    semantic_schema_id: evaluation.result.id,
    outcome: normalized.value.outcome,
    payload: jsonValueAt(normalized.value.payload, "normalized_candidate.payload"),
    transformations: normalized.transformations,
  };
}

function resultRecordBase(input: {
  attempt: KernelAttempt;
  original_hash: string;
  normalized_hash: string;
  payload_schema: string;
  payload: JsonValue;
  created_at: string;
}): ResultRecord {
  const identity = {
    attempt_id: input.attempt.id,
    request_hash: input.attempt.request_hash,
    normalized_candidate_hash: input.normalized_hash,
  };
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: recordId("result", identity),
    kind: "result",
    pipeline_run_id: input.attempt.pipeline_run_id,
    attempt_id: input.attempt.id,
    request_hash: input.attempt.request_hash,
    definition_bundle_hash: input.attempt.definition_bundle_hash,
    input_subject: input.attempt.input_subject,
    output_subject: input.attempt.output_subject,
    original_candidate_hash: input.original_hash,
    normalized_candidate_hash: input.normalized_hash,
    payload_schema: input.payload_schema,
    payload: { inline: input.payload },
    created_at: input.created_at,
  };
}

export function createSemanticResultRecord(input: {
  attempt: KernelAttempt;
  staged: StagedSemanticCandidate;
  evaluation: EvalDefinition;
  created_at: string;
}): ResultRecord {
  if (input.attempt.status !== "work_complete" && input.attempt.status !== "result_pending") {
    throw new Error(`attempt ${input.attempt.id} is not ready for an authoritative ResultRecord`);
  }
  const payload = assertCandidateReplay(input.staged, input.evaluation);
  return resultRecordBase({
    attempt: input.attempt,
    original_hash: input.staged.original_hash,
    normalized_hash: input.staged.normalized_hash,
    payload_schema: SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA,
    payload: payload as unknown as JsonValue,
    created_at: input.created_at,
  });
}

export function createCommandResultRecord(input: {
  attempt: KernelAttempt;
  result: KernelCommandResult;
  expected_command_id: string;
  created_at: string;
}): ResultRecord {
  if (input.result.command_id !== input.expected_command_id) {
    throw new Error("command result does not match the sealed command identity");
  }
  if (!Number.isSafeInteger(input.result.exit_code) || input.result.summary.length > 4_000) {
    throw new Error("command result is outside its executor-owned bounds");
  }
  const payload: CommandResultRecordPayload = {
    schema: COMMAND_RESULT_RECORD_PAYLOAD_SCHEMA,
    command_id: input.result.command_id,
    outcome: input.result.outcome,
    exit_code: input.result.exit_code,
    summary: input.result.summary,
  };
  const digest = digestCanonicalJson(payload);
  return resultRecordBase({
    attempt: input.attempt,
    original_hash: digest,
    normalized_hash: digest,
    payload_schema: COMMAND_RESULT_RECORD_PAYLOAD_SCHEMA,
    payload: payload as unknown as JsonValue,
    created_at: input.created_at,
  });
}

function hasBlockingReviewFinding(findings: readonly ReviewFindingV1[]): boolean {
  return findings.some(({ severity }) => BLOCKING_REVIEW_FINDING_SEVERITIES.has(severity));
}

function semanticObject(value: JsonValue, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, JsonValue>;
}

function admissionOutcome(payload: SemanticResultRecordPayload): EvaluatedKernelResult {
  const value = semanticObject(payload.payload, "admission result payload");
  const plan = value.execution_plan;
  const questions = value.questions;
  const exact = (
    (payload.outcome === "simple" && plan === null && Array.isArray(questions) && questions.length === 0) ||
    (payload.outcome === "structured" && plan !== null && typeof plan === "object" &&
      !Array.isArray(plan) && plan.pipeline_id === "core/structured" &&
      Array.isArray(questions) && questions.length === 0) ||
    (payload.outcome === "needs_human" && plan === null &&
      Array.isArray(questions) && questions.length > 0)
  );
  return {
    evaluator: "core/admission-outcome@1",
    outcome: exact ? payload.outcome : "semantic_repair_required",
    reason: exact ? "validated_admission_route" : "admission_route_payload_mismatch",
  };
}

function admissionReviewOutcome(payload: SemanticResultRecordPayload): EvaluatedKernelResult {
  const value = semanticObject(payload.payload, "admission review result payload");
  const findings = value.findings;
  const questions = value.questions;
  const exact = (
    (payload.outcome === "approved" && Array.isArray(findings) && findings.length === 0 &&
      Array.isArray(questions) && questions.length === 0) ||
    (payload.outcome === "rejected" && Array.isArray(findings) && findings.length > 0 &&
      Array.isArray(questions) && questions.length === 0) ||
    (payload.outcome === "needs_human" && Array.isArray(questions) && questions.length > 0)
  );
  return {
    evaluator: "core/admission-review-outcome@1",
    outcome: exact ? payload.outcome : "semantic_repair_required",
    reason: exact ? "validated_admission_review" : "admission_review_payload_mismatch",
  };
}

function inlineResultPayload(record: ResultRecord): SemanticResultRecordPayload | CommandResultRecordPayload {
  if (!("inline" in record.payload)) {
    throw new Error(`result ${record.id} must be materialized before live evaluation`);
  }
  if (record.payload_schema === SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA) {
    return semanticPayload(record.payload.inline);
  }
  if (record.payload_schema === COMMAND_RESULT_RECORD_PAYLOAD_SCHEMA) {
    return commandPayload(record.payload.inline);
  }
  throw new Error(`result ${record.id} has no live evaluator payload contract`);
}

export class KernelEvaluatorRegistry {
  evaluateSemantic(input: {
    stage: Extract<CompiledPipelineStage, { kind: "agent" }>;
    evaluation: EvalDefinition;
    result: ResultRecord;
  }): EvaluatedKernelResult {
    if (input.stage.eval !== input.evaluation.id) {
      throw new Error(`stage ${input.stage.id} is not bound to eval ${input.evaluation.id}`);
    }
    const payload = inlineResultPayload(input.result);
    if (payload.schema !== SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA) {
      throw new Error(`agent stage ${input.stage.id} did not produce a semantic result`);
    }
    if (
      payload.semantic_schema_id !== input.evaluation.result.id ||
      !input.evaluation.result.outcomes.includes(payload.outcome)
    ) {
      throw new Error(`result ${input.result.id} does not satisfy eval ${input.evaluation.id}`);
    }
    if (!["core/action-outcome@1", "core/admission-outcome@1", "core/admission-review-outcome@1", "core/review-outcome@1", "core/unit-outcome@1"].includes(
      input.evaluation.evaluator,
    )) {
      throw new Error(`evaluator primitive ${input.evaluation.evaluator} is not registered`);
    }
    if (input.evaluation.evaluator === "core/admission-outcome@1") {
      return admissionOutcome(payload);
    }
    if (input.evaluation.evaluator === "core/admission-review-outcome@1") {
      return admissionReviewOutcome(payload);
    }
    const reviewFindings = input.evaluation.evaluator === "core/review-outcome@1"
      ? semanticObject(payload.payload, "review result payload").findings
      : null;
    if (reviewFindings !== null && !Array.isArray(reviewFindings)) {
      throw new Error("review result payload findings must be an array");
    }
    const blocking = reviewFindings !== null && hasBlockingReviewFinding(
      reviewFindings as unknown as readonly ReviewFindingV1[],
    );
    return {
      evaluator: input.evaluation.evaluator,
      outcome: blocking ? "semantic_repair_required" : payload.outcome,
      reason: blocking ? "blocking_review_finding" : "validated_semantic_result",
    };
  }

  evaluateCommand(input: {
    stage: Extract<CompiledPipelineStage, { kind: "command" }>;
    result: ResultRecord;
  }): EvaluatedKernelResult {
    const payload = inlineResultPayload(input.result);
    if (
      payload.schema !== COMMAND_RESULT_RECORD_PAYLOAD_SCHEMA ||
      payload.command_id !== input.stage.command
    ) {
      throw new Error(`command stage ${input.stage.id} received another command's result`);
    }
    return {
      evaluator: "core/command-outcome@1",
      outcome: payload.outcome,
      reason: "executor_command_result",
    };
  }
}

export function createPipelineDecisionRecord(input: {
  attempt: KernelAttempt;
  result: ResultRecord | null;
  additional_input_records?: readonly ExecutionRecord[];
  evaluated: EvaluatedKernelResult;
  created_at: string;
}): DecisionRecord {
  const payload: PipelineDecisionRecordPayload = {
    schema: PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA,
    stage_id: input.attempt.scope.stage_id,
    evaluator: input.evaluated.evaluator,
    outcome: input.evaluated.outcome,
    reason: input.evaluated.reason,
  };
  const inputRecordIds = [...new Set([
    ...(input.result === null ? [] : [input.result.id]),
    ...(input.additional_input_records ?? []).map(({ id }) => id),
  ])].sort(compareCodeUnits);
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: recordId("decision", {
      attempt_id: input.attempt.id,
      input_record_ids: inputRecordIds,
      payload,
    }),
    kind: "decision",
    pipeline_run_id: input.attempt.pipeline_run_id,
    reducer: input.evaluated.evaluator,
    input_record_ids: inputRecordIds,
    payload_schema: PIPELINE_DECISION_RECORD_PAYLOAD_SCHEMA,
    payload: { inline: payload as unknown as JsonValue },
    created_at: input.created_at,
  };
}
