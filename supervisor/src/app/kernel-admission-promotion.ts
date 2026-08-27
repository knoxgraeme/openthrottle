import {
  EXECUTION_RECORD_SCHEMA,
  compareCodeUnits,
  digestCanonicalJson,
  validateExecutionPlanContractV2,
  type DecisionRecord,
  type ExecutionPlanContractV2,
  type ExecutionRecord,
  type ExecutionRecordPayloadContract,
  type JsonValue,
  type ResultRecord,
} from "@openthrottle/contracts";
import type {
  OrdinaryKernelSettlementPlan,
  OrdinaryKernelSettlementPlanner,
} from "../pipeline/kernel/ordinary-coordinator.js";
import type { KernelAttemptRequestPort } from "../pipeline/kernel/ports.js";
import {
  createPipelineDecisionRecord,
  SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA,
} from "../pipeline/kernel/evaluator-registry.js";
import {
  deriveKernelSuccessorAttempt,
  kernelSuccessorStageId,
} from "../pipeline/kernel/successor-attempt.js";

export const ADMISSION_PROMOTION_RECORD_PAYLOAD_SCHEMA =
  "openthrottle.admission-promotion/v1" as const;
export const ADMISSION_PROMOTION_REDUCER = "kernel/promote-admission@1" as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SUBJECT = /^[a-f0-9]{40,64}$/;

export interface AdmissionPlannerEvidence {
  record: ResultRecord;
  route: "simple" | "structured";
  execution_plan: ExecutionPlanContractV2 | null;
}

export interface AdmissionPromotionRecordPayload {
  schema: typeof ADMISSION_PROMOTION_RECORD_PAYLOAD_SCHEMA;
  source_run_id: string;
  source_attempt_id: string;
  selected_pipeline: "core/implement" | "core/structured";
  source_commit: string;
  execution_plan: ExecutionPlanContractV2 | null;
  planner_result_id: string;
  planner_result_hash: string;
  reviewer_result_id: string;
  reviewer_result_hash: string;
}

function exactObject(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: must be an object`);
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).find((key) => !keys.includes(key));
  if (unknown) throw new Error(`${path}.${unknown}: unknown field`);
  return input;
}

function exactString(value: unknown, path: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${path}: has an invalid value`);
  }
  return value;
}

export function parseAdmissionPromotionRecordPayload(
  value: unknown,
  path = "admission_promotion",
): AdmissionPromotionRecordPayload {
  const input = exactObject(value, path, [
    "schema", "source_run_id", "source_attempt_id", "selected_pipeline", "source_commit",
    "execution_plan", "planner_result_id", "planner_result_hash", "reviewer_result_id",
    "reviewer_result_hash",
  ]);
  if (input.schema !== ADMISSION_PROMOTION_RECORD_PAYLOAD_SCHEMA) {
    throw new Error(`${path}.schema: must be ${ADMISSION_PROMOTION_RECORD_PAYLOAD_SCHEMA}`);
  }
  if (input.selected_pipeline !== "core/implement" && input.selected_pipeline !== "core/structured") {
    throw new Error(`${path}.selected_pipeline: is unsupported`);
  }
  const executionPlan = input.execution_plan === null
    ? null
    : validateExecutionPlanContractV2(input.execution_plan, {
      source: `${path}.execution_plan`,
    }).value;
  if (
    (input.selected_pipeline === "core/structured" && executionPlan?.pipeline_id !== "core/structured") ||
    (input.selected_pipeline === "core/implement" && executionPlan !== null)
  ) throw new Error(`${path}.execution_plan: does not match selected_pipeline`);
  return {
    schema: ADMISSION_PROMOTION_RECORD_PAYLOAD_SCHEMA,
    source_run_id: exactString(input.source_run_id, `${path}.source_run_id`, ID),
    source_attempt_id: exactString(input.source_attempt_id, `${path}.source_attempt_id`, ID),
    selected_pipeline: input.selected_pipeline,
    source_commit: exactString(input.source_commit, `${path}.source_commit`, SUBJECT),
    execution_plan: executionPlan,
    planner_result_id: exactString(input.planner_result_id, `${path}.planner_result_id`, ID),
    planner_result_hash: exactString(input.planner_result_hash, `${path}.planner_result_hash`, SHA256),
    reviewer_result_id: exactString(input.reviewer_result_id, `${path}.reviewer_result_id`, ID),
    reviewer_result_hash: exactString(input.reviewer_result_hash, `${path}.reviewer_result_hash`, SHA256),
  };
}

export const ADMISSION_PROMOTION_RECORD_PAYLOAD_CONTRACT: ExecutionRecordPayloadContract =
  Object.freeze({
    kind: "decision" as const,
    parseInline(value: unknown, path: string): unknown {
      return parseAdmissionPromotionRecordPayload(value, path) as unknown as JsonValue;
    },
  });

function semanticResult(record: ExecutionRecord, schemaId: string): {
  record: ResultRecord;
  outcome: string;
  payload: Record<string, unknown>;
} | null {
  if (
    record.kind !== "result" || record.payload_schema !== SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA ||
    !("inline" in record.payload)
  ) return null;
  const outer = exactObject(record.payload.inline, `record ${record.id}`, [
    "schema", "semantic_schema_id", "outcome", "payload", "transformations",
  ]);
  if (
    outer.schema !== SEMANTIC_RESULT_RECORD_PAYLOAD_SCHEMA ||
    outer.semantic_schema_id !== schemaId || typeof outer.outcome !== "string"
  ) return null;
  return {
    record,
    outcome: outer.outcome,
    payload: exactObject(outer.payload, `record ${record.id}.payload`,
      schemaId === "core/admission-result"
        ? ["summary", "execution_plan", "questions"]
        : ["summary", "findings", "questions"]),
  };
}

export function admissionPlannerEvidence(record: ExecutionRecord): AdmissionPlannerEvidence | null {
  const semantic = semanticResult(record, "core/admission-result");
  if (!semantic || (semantic.outcome !== "simple" && semantic.outcome !== "structured")) return null;
  const plan = semantic.payload.execution_plan === null
    ? null
    : validateExecutionPlanContractV2(semantic.payload.execution_plan, {
      source: `record ${record.id}.payload.execution_plan`,
    }).value;
  const questions = semantic.payload.questions;
  if (
    !Array.isArray(questions) || questions.length !== 0 ||
    (semantic.outcome === "simple" && plan !== null) ||
    (semantic.outcome === "structured" && plan?.pipeline_id !== "core/structured")
  ) throw new Error(`admission planner ResultRecord ${record.id} has inconsistent route semantics`);
  return { record: semantic.record, route: semantic.outcome, execution_plan: plan };
}

export function approvedAdmissionReviewEvidence(record: ExecutionRecord): ResultRecord | null {
  const semantic = semanticResult(record, "core/admission-review-result");
  if (!semantic || semantic.outcome !== "approved") return null;
  const findings = semantic.payload.findings;
  const questions = semantic.payload.questions;
  if (
    !Array.isArray(findings) || findings.length !== 0 ||
    !Array.isArray(questions) || questions.length !== 0
  ) throw new Error(`admission reviewer ResultRecord ${record.id} is not an exact approval`);
  return semantic.record;
}

export function createAdmissionPromotionRecord(input: {
  target_run_id: string;
  source_run_id: string;
  source_attempt_id: string;
  source_commit: string;
  planner: AdmissionPlannerEvidence;
  reviewer: ResultRecord;
  created_at: string;
}): DecisionRecord {
  const payload = parseAdmissionPromotionRecordPayload({
    schema: ADMISSION_PROMOTION_RECORD_PAYLOAD_SCHEMA,
    source_run_id: input.source_run_id,
    source_attempt_id: input.source_attempt_id,
    selected_pipeline: input.planner.route === "structured" ? "core/structured" : "core/implement",
    source_commit: input.source_commit,
    execution_plan: input.planner.execution_plan,
    planner_result_id: input.planner.record.id,
    planner_result_hash: digestCanonicalJson(input.planner.record),
    reviewer_result_id: input.reviewer.id,
    reviewer_result_hash: digestCanonicalJson(input.reviewer),
  });
  return {
    schema: EXECUTION_RECORD_SCHEMA,
    id: `decision-${digestCanonicalJson({ target_run_id: input.target_run_id, payload }).slice(0, 48)}`,
    kind: "decision",
    pipeline_run_id: input.target_run_id,
    reducer: ADMISSION_PROMOTION_REDUCER,
    input_record_ids: [],
    payload_schema: ADMISSION_PROMOTION_RECORD_PAYLOAD_SCHEMA,
    payload: { inline: payload as unknown as JsonValue },
    created_at: input.created_at,
  };
}

export class KernelAdmissionSettlementPlanner implements OrdinaryKernelSettlementPlanner {
  readonly #store: KernelAttemptRequestPort;
  readonly #now: () => string;

  constructor(input: { store: KernelAttemptRequestPort; now?: () => string }) {
    this.#store = input.store;
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  async plan(
    input: Parameters<OrdinaryKernelSettlementPlanner["plan"]>[0],
  ): Promise<OrdinaryKernelSettlementPlan> {
    if (
      input.view.run.pipeline_id !== "core/admission" || input.stage.id !== "review" ||
      input.evaluated.outcome !== "approved"
    ) return input.default_plan();
    const reviewer = approvedAdmissionReviewEvidence(input.result);
    if (reviewer === null) throw new Error("approved admission transition lacks its reviewer ResultRecord");
    const request = await this.#store.loadAttemptRequestInputs({
      pipeline_run_id: input.view.run.id,
      attempt_id: input.attempt.id,
    });
    const planners = [...request.context.records.values()]
      .map(admissionPlannerEvidence)
      .filter((candidate): candidate is AdmissionPlannerEvidence => candidate !== null);
    if (planners.length !== 1) {
      throw new Error("admission review must bind exactly one executable planner ResultRecord");
    }
    const planner = planners[0]!;
    const additionalInputs = input.additional_input_records ?? [];
    const decision = createPipelineDecisionRecord({
      attempt: input.attempt,
      result: reviewer,
      additional_input_records: [planner.record, ...additionalInputs],
      evaluated: input.evaluated,
      created_at: this.#now(),
    });
    const targetStageId = kernelSuccessorStageId({
      manifest: input.view.manifest,
      run: input.view.run,
      stage: input.stage,
      outcome: input.evaluated.outcome,
    });
    const target = input.view.manifest.stages.find(({ id }) => id === targetStageId);
    if (target?.kind !== "effect" || target.effect !== ADMISSION_PROMOTION_REDUCER) {
      throw new Error("approved admission review does not target executor promotion");
    }
    const successor = deriveKernelSuccessorAttempt({
      view: input.view,
      current: input.attempt,
      result: reviewer,
      decision,
      bundle: input.bundle,
      target_scope: { kind: "stage", stage_id: target.id },
      request_inputs: request,
      checkpoint_override: [],
      additional_context_records: [planner.record, ...additionalInputs],
    });
    return {
      decision,
      outcome: input.evaluated.outcome,
      input_records: [planner.record, reviewer, ...additionalInputs]
        .sort((left, right) => compareCodeUnits(left.id, right.id)),
      checkpoints: [],
      next_attempts: [successor],
    };
  }
}
