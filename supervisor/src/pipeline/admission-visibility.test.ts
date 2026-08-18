import { canonicalJson, digestNormalized } from "@openthrottle/contracts";
import { describe, expect, it } from "vitest";
import { projectAdmissionTransition } from "./admission-visibility.js";
import type {
  AdmissionProjection,
  CoordinatorTransitionWrite,
  PipelineStageAttempt,
} from "./store.js";
import type { PipelineCoordinatorEvent } from "./coordinator.js";

const basisDigest = "a".repeat(64);
const manifestDigest = "b".repeat(64);
const capabilityDigest = "c".repeat(64);
const requestHash = "d".repeat(64);
const subject = "e".repeat(40);

function projection(): AdmissionProjection {
  return {
    pipeline_instance_id: "pipeline-1",
    proposed_route: null,
    final_route: null,
    semantic_repair_count: 0,
    infrastructure_retry_count: 0,
    terminal_state: null,
    questions: [],
    reviewer_verdict: null,
    planner: { reference: "builtin://admission-plan@1", package_digest: null },
    reviewer: { reference: "builtin://review-admission-plan@1", package_digest: null },
    admission_basis_digest: basisDigest,
    effective_manifest_digest: manifestDigest,
    generated_plan_digest: null,
    checkpoint_digest: null,
    accepted_plan_artifact_hash: null,
    reviewer_receipt_artifact_hash: null,
    created_at: "2026-08-18T00:00:00.000Z",
    updated_at: "2026-08-18T00:00:00.000Z",
  };
}

function attempt(stageId: string): PipelineStageAttempt {
  return {
    id: `attempt-${stageId}`,
    pipeline_instance_id: "pipeline-1",
    stage_id: stageId,
    attempt_ordinal: 1,
    reentry_ordinal: 0,
    run_id: "run-1",
    planned_run_id: "run-1",
    expected_subject: subject,
    native_session_id: null,
    request_payload: null,
    request_hash: requestHash,
    idempotency_key: `key-${stageId}`,
    context_revision: 0,
    native_context_policy: "fresh",
    status: "running",
    outcome: null,
    result_hash: null,
    started_at: null,
    completed_at: null,
    created_at: "2026-08-18T00:00:00.000Z",
    updated_at: "2026-08-18T00:00:00.000Z",
  };
}

function receipt(type: "admission_decision" | "admission_review", result: string, payload: unknown) {
  return {
    schema: "openthrottle.receipt/v1",
    type,
    assurance: "semantic_attested",
    result,
    producer: {
      worker_id: type === "admission_decision" ? "planner" : "reviewer",
      skill: type === "admission_decision"
        ? "builtin://admission-plan@1"
        : "builtin://review-admission-plan@1",
      capability_digest: capabilityDigest,
      skill_package_digest: null,
    },
    subject: { base: subject, pre: subject, post: subject },
    fence: {
      pipeline_instance_id: "pipeline-1",
      graph_digest: manifestDigest,
      unit_id: type === "admission_decision" ? "admission_planner" : "admission_reviewer",
      attempt_id: "attempt-1",
      parent_run_id: "run-1",
      action_attempt_id: "attempt-1",
      generation: 1,
      native_session_id: null,
      request_hash: requestHash,
    },
    evidence: ["sealed evidence"],
    payload,
    issued_at: "2026-08-18T00:00:00.000Z",
  };
}

function event(stageId: string, outcome: PipelineCoordinatorEvent["outcome"], artifact?: {
  kind: "standard_receipt" | "execution_plan";
  assurance: "semantic_attested" | "executor_verified";
  value: unknown;
}): PipelineCoordinatorEvent {
  const payload = artifact ? canonicalJson(artifact.value) : canonicalJson({ outcome });
  return {
    id: `event-${stageId}-${outcome}`,
    kind: "stage_result",
    instanceId: "pipeline-1",
    generation: 1,
    attemptId: `attempt-${stageId}`,
    requestHash,
    outcome,
    resultHash: digestNormalized(payload),
    subject,
    artifacts: artifact ? [{
      kind: artifact.kind,
      schemaVersion: 1,
      assurance: artifact.assurance,
      subject,
      payload,
      hash: digestNormalized(payload),
    }] : [],
  };
}

function write(stageId: string, outcome: CoordinatorTransitionWrite["outcome"], extras: Partial<CoordinatorTransitionWrite> = {}): CoordinatorTransitionWrite {
  return {
    instanceId: "pipeline-1",
    eventId: `event-${stageId}-${outcome}`,
    eventPayloadHash: "f".repeat(64),
    expectedVersion: 1,
    expectedStatus: "running",
    attemptId: `attempt-${stageId}`,
    outcome,
    resultHash: "1".repeat(64),
    nextStatus: "dispatchable",
    effects: [],
    ...extras,
  };
}

describe("automatic admission visibility projection", () => {
  it("keeps accepted admission stable when later execution gates run", () => {
    const decision = {
      schema: "openthrottle.admission-decision/v1",
      route: "simple",
      rationale: "One cohesive change.",
      questions: [],
      admission_basis_digest: basisDigest,
      effective_manifest_digest: manifestDigest,
      generated_plan_digest: null,
    };
    const wrapper = { details: { receipt: receipt("admission_decision", "simple", { decision }) } };
    const proposed = projectAdmissionTransition({
      current: projection(),
      attempt: attempt("admission_planner"),
      event: event("admission_planner", "no_change", {
        kind: "standard_receipt", assurance: "semantic_attested", value: wrapper,
      }),
      write: write("admission_planner", "no_change"),
    })!;
    const accepted = projectAdmissionTransition({
      current: proposed,
      attempt: attempt("admission_decision_gate"),
      event: event("admission_decision_gate", "no_change"),
      write: write("admission_decision_gate", "no_change"),
    })!;
    const afterExecutionGate = projectAdmissionTransition({
      current: accepted,
      attempt: attempt("semantic_review"),
      event: event("semantic_review", "success"),
      write: write("semantic_review", "success"),
    });

    expect(afterExecutionGate).toEqual(expect.objectContaining({
      proposed_route: "simple",
      final_route: "simple",
      terminal_state: "accepted",
    }));
  });

  it("records semantic and infrastructure retry counts and the exact accepted plan artifact reference", () => {
    const base = { ...projection(), proposed_route: "structured" as const, generated_plan_digest: "9".repeat(64) };
    const repaired = projectAdmissionTransition({
      current: base,
      attempt: attempt("admission_decision_gate"),
      event: event("admission_decision_gate", "semantic_repair_required"),
      write: write("admission_decision_gate", "semantic_repair_required", { reentryIncrement: 1 }),
    })!;
    const retried = projectAdmissionTransition({
      current: repaired,
      attempt: attempt("admission_reviewer"),
      event: event("admission_reviewer", "retryable_infrastructure_failure"),
      write: write("admission_reviewer", "retryable_infrastructure_failure", { reentryIncrement: 1 }),
    })!;
    const acceptedPlan = { schema: "openthrottle.admission-execution-plan-artifact/v1", execution_plan: {} };
    const acceptedEvent = event("admission_review_gate", "success", {
      kind: "execution_plan", assurance: "executor_verified", value: acceptedPlan,
    });
    const accepted = projectAdmissionTransition({
      current: retried,
      attempt: attempt("admission_review_gate"),
      event: acceptedEvent,
      write: write("admission_review_gate", "success"),
    })!;

    expect(accepted).toMatchObject({
      final_route: "structured",
      terminal_state: "accepted",
      semantic_repair_count: 1,
      infrastructure_retry_count: 1,
      accepted_plan_artifact_hash: acceptedEvent.artifacts![0]!.hash,
    });
  });
});
