import {
  canonicalJson,
  compareCodeUnits,
  type AttemptCheckpoint,
  type DecisionRecord,
  type DeliveryRecord,
  type ExecutionPlanContractV2,
  type ExecutionRecord,
  type ResultRecord,
} from "@openthrottle/contracts";
import type {
  KernelAttemptRequestInputs,
  KernelExternalSettlementPlanner,
  SettledStructuredPlanningAttempt,
} from "../pipeline/kernel/ports.js";
import { exactKernelRuntimeResourceDeliveries } from "../pipeline/kernel/runtime-resource.js";
import {
  parseStructuredExecutionPlan,
  type StructuredAcceptedUnitEvidence,
  type StructuredSettledAttemptEvidence,
} from "../pipeline/kernel/structured-coordinator.js";
import type { KernelAttempt } from "../pipeline/kernel/types.js";
import {
  ADMISSION_PROMOTION_RECORD_PAYLOAD_SCHEMA,
  ADMISSION_PROMOTION_REDUCER,
  parseAdmissionPromotionRecordPayload,
} from "./kernel-admission-promotion.js";

type ExternalInput = Parameters<KernelExternalSettlementPlanner["plan"]>[0];

export function exactStructuredDeliveries(input: ExternalInput): DeliveryRecord[] {
  return input.schedules.flatMap((schedule) => schedule.effects.map(({ delivery }) => {
    if (delivery === null) {
      throw new Error(`structured external schedule ${schedule.semantic_key} is incomplete`);
    }
    return delivery;
  })).sort((left, right) => compareCodeUnits(left.id, right.id));
}

export function exactStructuredRuntimeRecords(
  inputs: KernelAttemptRequestInputs,
): ExecutionRecord[] {
  const runtime = exactKernelRuntimeResourceDeliveries([...inputs.context.records.values()]);
  if (runtime === null) {
    throw new Error("structured continuation lost its exact Daytona runtime identity");
  }
  return [...runtime];
}

export function exactStructuredPromotionDecision(
  inputs: KernelAttemptRequestInputs,
  expectedPipelineId: string,
): DecisionRecord | null {
  const matches = [...inputs.context.records.values()].filter(
    (record) => record.payload_schema === ADMISSION_PROMOTION_RECORD_PAYLOAD_SCHEMA,
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1 || matches[0]!.kind !== "decision") {
    throw new Error("structured admission requires exactly one promotion DecisionRecord");
  }
  const record = matches[0]!;
  if (!("inline" in record.payload) || !record.payload.inline ||
      typeof record.payload.inline !== "object" || Array.isArray(record.payload.inline)) {
    throw new Error("structured admission promotion is not materialized inline");
  }
  if (record.reducer !== ADMISSION_PROMOTION_REDUCER) {
    throw new Error("structured admission promotion uses another reducer");
  }
  const payload = parseAdmissionPromotionRecordPayload(record.payload.inline);
  if (payload.selected_pipeline !== expectedPipelineId || payload.execution_plan === null) {
    throw new Error("structured admission promotion selected another execution plan");
  }
  return record;
}

function promotedExecutionPlan(record: DecisionRecord): ExecutionPlanContractV2 {
  if (!("inline" in record.payload)) {
    throw new Error("structured admission promotion is not materialized inline");
  }
  const payload = parseAdmissionPromotionRecordPayload(record.payload.inline);
  if (payload.execution_plan === null) {
    throw new Error("structured admission promotion omitted its execution plan");
  }
  return payload.execution_plan;
}

export function resolveStructuredExecutionPlan(
  inputs: KernelAttemptRequestInputs,
  expectedPipelineId: string,
): { plan: ExecutionPlanContractV2; promotion: DecisionRecord | null } {
  const promotion = exactStructuredPromotionDecision(inputs, expectedPipelineId);
  return {
    plan: promotion === null
      ? parseStructuredExecutionPlan(inputs.task_prompt, expectedPipelineId)
      : promotedExecutionPlan(promotion),
    promotion,
  };
}

export function structuredPromotionFromActionEvidence(
  evidence: StructuredAcceptedUnitEvidence,
  expectedPipelineId: string,
): DecisionRecord | null {
  return exactStructuredPromotionDecision({
    task_prompt: evidence.acceptance.action_inputs.task_prompt,
    context: {
      records: new Map(evidence.acceptance.action_inputs.context.records.map((record) => [record.id, record])),
      checkpoints: new Map(
        evidence.acceptance.action_inputs.context.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]),
      ),
    },
  }, expectedPipelineId);
}

export function exactStructuredBoundaryCheckpoint(
  inputs: KernelAttemptRequestInputs,
  subject: string,
  label: string,
): AttemptCheckpoint {
  const matches = [...inputs.context.checkpoints.values()].filter(
    (checkpoint) => checkpoint.output_subject === subject,
  );
  if (matches.length !== 1) {
    throw new Error(`${label} requires exactly one checkpoint boundary for ${subject}`);
  }
  return matches[0]!;
}

export function assertStructuredRequestContextExact(
  attempt: KernelAttempt,
  inputs: KernelAttemptRequestInputs,
): void {
  const recordIds = [...inputs.context.records.keys()].sort(compareCodeUnits);
  const checkpointIds = [...inputs.context.checkpoints.keys()].sort(compareCodeUnits);
  if (
    canonicalJson(recordIds) !== canonicalJson(attempt.context_record_ids) ||
    canonicalJson(checkpointIds) !== canonicalJson(attempt.context_checkpoint_ids)
  ) {
    throw new Error(`structured planning widened or narrowed request ${attempt.id}`);
  }
  if ([...inputs.context.records.values()].some(
    (record) => record.pipeline_run_id !== attempt.pipeline_run_id,
  )) throw new Error(`structured request ${attempt.id} contains another run's record`);
  if ([...inputs.context.checkpoints.values()].some(
    (checkpoint) => checkpoint.pipeline_run_id !== attempt.pipeline_run_id,
  )) throw new Error(`structured request ${attempt.id} contains another run's checkpoint`);
}

export function assertStructuredSettledEvidence(
  evidence: SettledStructuredPlanningAttempt,
): void {
  const { attempt, result, decision, checkpoint, request_inputs: requestInputs } = evidence;
  if (
    attempt.status !== "settled" || attempt.result_record_id !== result.id ||
    attempt.decision_record_id !== decision.id || attempt.checkpoint_id !== checkpoint.id ||
    result.pipeline_run_id !== attempt.pipeline_run_id || result.attempt_id !== attempt.id ||
    result.request_hash !== attempt.request_hash ||
    result.definition_bundle_hash !== attempt.definition_bundle_hash ||
    result.input_subject !== attempt.input_subject || result.output_subject !== attempt.output_subject ||
    decision.pipeline_run_id !== attempt.pipeline_run_id ||
    !decision.input_record_ids.includes(result.id) ||
    checkpoint.pipeline_run_id !== attempt.pipeline_run_id || checkpoint.attempt_id !== attempt.id ||
    checkpoint.request_hash !== attempt.request_hash ||
    checkpoint.definition_bundle_hash !== attempt.definition_bundle_hash ||
    checkpoint.input_subject !== attempt.input_subject ||
    checkpoint.output_subject !== attempt.output_subject
  ) throw new Error(`structured settled evidence for ${attempt.id} is not exact`);
  assertStructuredRequestContextExact(attempt, requestInputs);
}

export function projectCurrentStructuredEvidence(input: {
  attempt: KernelAttempt;
  result: ResultRecord;
  decision: DecisionRecord;
  checkpoint: AttemptCheckpoint;
  request_inputs: KernelAttemptRequestInputs;
}): SettledStructuredPlanningAttempt {
  const projected: SettledStructuredPlanningAttempt = {
    attempt: {
      ...input.attempt,
      status: "settled",
      version: input.attempt.version + 1,
      lease: null,
      decision_record_id: input.decision.id,
    },
    result: input.result,
    decision: input.decision,
    checkpoint: input.checkpoint,
    request_inputs: input.request_inputs,
  };
  assertStructuredSettledEvidence(projected);
  return projected;
}

export function settledStructuredActionEvidence(
  evidence: SettledStructuredPlanningAttempt,
): StructuredSettledAttemptEvidence {
  return {
    attempt: evidence.attempt,
    result: evidence.result,
    decision: evidence.decision,
    checkpoint: evidence.checkpoint,
    action_inputs: {
      task_prompt: evidence.request_inputs.task_prompt,
      context: {
        records: [...evidence.request_inputs.context.records.values()],
        checkpoints: [...evidence.request_inputs.context.checkpoints.values()],
      },
    },
  };
}
