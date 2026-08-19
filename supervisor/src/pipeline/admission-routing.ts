import { AUTOMATIC_ADMISSION_STAGE_IDS } from "./manifest.js";
import type { StageRequestInputArtifact } from "./stage-request.js";
import type { AdmissionProjection } from "./store.js";
import type { StageOutcome } from "./manifest.js";

function select(
  artifacts: readonly StageRequestInputArtifact[],
  kinds: readonly StageRequestInputArtifact["kind"][]
): StageRequestInputArtifact[] {
  return artifacts.filter((artifact) => kinds.includes(artifact.kind));
}

function requireUnique(
  artifacts: readonly StageRequestInputArtifact[],
  kind: StageRequestInputArtifact["kind"],
  source: string
): StageRequestInputArtifact {
  const matches = artifacts.filter((artifact) => artifact.kind === kind);
  if (matches.length !== 1) throw new Error(`${source} must contain exactly one ${kind} artifact`);
  return matches[0]!;
}

function sameArtifact(left: StageRequestInputArtifact, right: StageRequestInputArtifact): boolean {
  return left.hash === right.hash && left.payload === right.payload &&
    left.schemaVersion === right.schemaVersion && left.assurance === right.assurance &&
    left.subject === right.subject;
}

export function automaticAdmissionInputArtifacts(input: {
  sourceStageId: string;
  targetStageId: string;
  eventArtifacts: readonly StageRequestInputArtifact[];
  priorArtifacts: readonly StageRequestInputArtifact[];
}): StageRequestInputArtifact[] | undefined {
  const { sourceStageId, targetStageId, eventArtifacts, priorArtifacts } = input;
  if (targetStageId === AUTOMATIC_ADMISSION_STAGE_IDS.decisionGate) {
    return select(eventArtifacts, ["standard_receipt", "execution_plan"]);
  }
  if (targetStageId === AUTOMATIC_ADMISSION_STAGE_IDS.reviewer) {
    const source = sourceStageId === AUTOMATIC_ADMISSION_STAGE_IDS.decisionGate
      ? eventArtifacts
      : priorArtifacts;
    const decision = requireUnique(source, "stage_result", "admission reviewer input");
    const plan = requireUnique(source, "execution_plan", "admission reviewer input");
    const competingPlan = eventArtifacts.find((artifact) => artifact.kind === "execution_plan");
    if (source !== eventArtifacts && competingPlan && !sameArtifact(plan, competingPlan)) {
      throw new Error("admission reviewer correction changed the sealed execution_plan artifact");
    }
    return [plan, decision].sort((left, right) => left.kind.localeCompare(right.kind));
  }
  if (targetStageId === AUTOMATIC_ADMISSION_STAGE_IDS.reviewGate) {
    return [
      ...select(priorArtifacts, ["stage_result", "execution_plan"]),
      ...select(eventArtifacts, ["standard_receipt"]),
    ].sort((left, right) => left.kind.localeCompare(right.kind));
  }
  if (targetStageId === "structured_edit") {
    return select(eventArtifacts, ["execution_plan"]);
  }
  return undefined;
}

export function isAutomaticAdmissionCorrection(sourceStageId: string, targetStageId: string): boolean {
  return (sourceStageId === AUTOMATIC_ADMISSION_STAGE_IDS.decisionGate && targetStageId === AUTOMATIC_ADMISSION_STAGE_IDS.planner) ||
    (sourceStageId === AUTOMATIC_ADMISSION_STAGE_IDS.reviewGate && (
      targetStageId === AUTOMATIC_ADMISSION_STAGE_IDS.planner ||
      targetStageId === AUTOMATIC_ADMISSION_STAGE_IDS.reviewer
    )) ||
    (sourceStageId === AUTOMATIC_ADMISSION_STAGE_IDS.planner && targetStageId === AUTOMATIC_ADMISSION_STAGE_IDS.planner) ||
    (sourceStageId === AUTOMATIC_ADMISSION_STAGE_IDS.reviewer && targetStageId === AUTOMATIC_ADMISSION_STAGE_IDS.reviewer);
}

export function admissionReentryBudgetCount(
  outcome: StageOutcome,
  projection: AdmissionProjection | undefined
): number {
  if (!projection) throw new Error("automatic admission retry requires its durable admission projection");
  return outcome === "retryable_infrastructure_failure"
    ? projection.infrastructure_retry_count
    : projection.semantic_repair_count;
}
