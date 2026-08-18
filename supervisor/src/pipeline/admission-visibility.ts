import { validateStandardReceipt } from "@openthrottle/contracts";
import type {
  AdmissionProjection,
  CoordinatorTransitionWrite,
  PipelineStageAttempt,
} from "./store.js";
import type { PipelineCoordinatorEvent } from "./coordinator.js";

const ADMISSION_STAGES = new Set([
  "admission_planner",
  "admission_decision_gate",
  "admission_reviewer",
  "admission_review_gate",
]);

function artifactPayload(event: PipelineCoordinatorEvent, kind: string): { hash: string; value: unknown } | undefined {
  const artifact = event.artifacts?.find((candidate) => candidate.kind === kind);
  if (!artifact) return undefined;
  return { hash: artifact.hash, value: JSON.parse(artifact.payload) as unknown };
}

function standardReceipt(event: PipelineCoordinatorEvent): { hash: string; receipt: ReturnType<typeof validateStandardReceipt>["value"] } | undefined {
  const artifact = artifactPayload(event, "standard_receipt");
  if (!artifact || !artifact.value || typeof artifact.value !== "object") return undefined;
  const wrapper = artifact.value as { details?: { receipt?: unknown } };
  if (wrapper.details?.receipt === undefined) return undefined;
  return {
    hash: artifact.hash,
    receipt: validateStandardReceipt(wrapper.details.receipt, { source: "admission.visibility.receipt" }).value,
  };
}

export function projectAdmissionTransition(input: {
  current: AdmissionProjection | undefined;
  attempt: PipelineStageAttempt;
  event: PipelineCoordinatorEvent;
  write: CoordinatorTransitionWrite;
}): AdmissionProjection | undefined {
  const { current, attempt, event, write } = input;
  if (!current || !ADMISSION_STAGES.has(attempt.stage_id)) return current;
  const next: AdmissionProjection = { ...current, questions: [...current.questions] };
  const receipt = standardReceipt(event);

  if (attempt.stage_id === "admission_planner" && receipt?.receipt.type === "admission_decision") {
    const decision = receipt.receipt.payload.decision;
    next.proposed_route = decision.route;
    next.questions = [...decision.questions];
    next.generated_plan_digest = decision.generated_plan_digest;
  }

  if (attempt.stage_id === "admission_reviewer" && receipt?.receipt.type === "admission_review") {
    const review = receipt.receipt.payload.review;
    next.reviewer_verdict = review.verdict;
    next.reviewer_receipt_artifact_hash = receipt.hash;
    next.questions = [...review.questions];
  }

  if (attempt.stage_id === "admission_decision_gate") {
    if (write.outcome === "no_change") {
      next.final_route = "simple";
      next.terminal_state = "accepted";
    } else if (write.outcome === "needs_human") {
      next.terminal_state = "needs_human";
    }
  }

  if (attempt.stage_id === "admission_review_gate") {
    if (write.outcome === "success") {
      const acceptedPlan = event.artifacts?.find((artifact) =>
        artifact.kind === "execution_plan" && artifact.assurance === "executor_verified"
      );
      if (!acceptedPlan) throw new Error("accepted automatic admission review is missing its executor-verified plan");
      next.final_route = "structured";
      next.terminal_state = "accepted";
      next.accepted_plan_artifact_hash = acceptedPlan.hash;
    } else if (write.outcome === "needs_human") {
      next.terminal_state = "needs_human";
    }
  }

  if (write.outcome === "retryable_infrastructure_failure") {
    next.infrastructure_retry_count += 1;
  } else if ((write.reentryIncrement ?? 0) > 0) {
    next.semantic_repair_count += 1;
  }
  if (write.terminalOutcome && next.terminal_state !== "accepted") {
    next.terminal_state = write.terminalOutcome;
  }
  return next;
}
