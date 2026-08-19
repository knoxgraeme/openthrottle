import { describe, expect, it } from "vitest";
import { admissionReentryBudgetCount, automaticAdmissionInputArtifacts } from "./admission-routing.js";
import type { AdmissionProjection } from "./store.js";
import type { StageRequestInputArtifact } from "./stage-request.js";

function artifact(kind: StageRequestInputArtifact["kind"], marker: string): StageRequestInputArtifact {
  return {
    kind,
    schemaVersion: 1,
    assurance: "semantic_attested",
    subject: null,
    payload: JSON.stringify({ marker }),
    hash: marker.repeat(64).slice(0, 64),
  };
}

describe("automatic admission artifact routing", () => {
  it.each([
    ["infrastructure then semantic", { infrastructure_retry_count: 1, semantic_repair_count: 0 }, 1, 0],
    ["semantic then infrastructure", { infrastructure_retry_count: 0, semantic_repair_count: 1 }, 0, 1],
  ] as const)("keeps persisted retry budgets separate after restart: %s", (_name, counts, infrastructure, semantic) => {
    const projection = counts as AdmissionProjection;
    expect(admissionReentryBudgetCount("retryable_infrastructure_failure", projection)).toBe(infrastructure);
    expect(admissionReentryBudgetCount("semantic_repair_required", projection)).toBe(semantic);
  });

  it("fails closed when automatic retry state has no durable projection", () => {
    expect(() => admissionReentryBudgetCount("semantic_repair_required", undefined))
      .toThrow(/durable admission projection/);
  });

  it("carries the original decision and exact plan through reviewer retry and correction", () => {
    const decision = artifact("stage_result", "a");
    const plan = artifact("execution_plan", "b");
    for (const sourceStageId of ["admission_reviewer", "admission_review_gate"]) {
      expect(automaticAdmissionInputArtifacts({
        sourceStageId,
        targetStageId: "admission_reviewer",
        priorArtifacts: [decision, plan],
        eventArtifacts: [artifact("stage_result", "c"), plan],
      })).toEqual([plan, decision]);
    }
  });

  it("preserves one plan from decision gate through review gate into structured execution", () => {
    const decision = artifact("stage_result", "a");
    const plan = artifact("execution_plan", "b");
    const reviewerInput = automaticAdmissionInputArtifacts({
      sourceStageId: "admission_decision_gate",
      targetStageId: "admission_reviewer",
      priorArtifacts: [],
      eventArtifacts: [decision, plan],
    })!;
    const reviewGateInput = automaticAdmissionInputArtifacts({
      sourceStageId: "admission_reviewer",
      targetStageId: "admission_review_gate",
      priorArtifacts: reviewerInput,
      eventArtifacts: [artifact("stage_result", "c"), artifact("standard_receipt", "d")],
    })!;
    const structuredInput = automaticAdmissionInputArtifacts({
      sourceStageId: "admission_review_gate",
      targetStageId: "structured_edit",
      priorArtifacts: reviewGateInput,
      eventArtifacts: [artifact("stage_result", "e"), plan],
    });
    expect(reviewGateInput.find((item) => item.kind === "stage_result")).toBe(decision);
    expect(reviewGateInput.find((item) => item.kind === "execution_plan")).toBe(plan);
    expect(structuredInput).toEqual([plan]);
  });

  it("rejects a reviewer correction that conflicts with the sealed plan", () => {
    expect(() => automaticAdmissionInputArtifacts({
      sourceStageId: "admission_review_gate",
      targetStageId: "admission_reviewer",
      priorArtifacts: [artifact("stage_result", "a"), artifact("execution_plan", "b")],
      eventArtifacts: [artifact("execution_plan", "c")],
    })).toThrow(/changed the sealed execution_plan/);
  });

  it("seals reviewer rejection evidence and the rejected plan into planner correction", () => {
    const rejection = artifact("stage_result", "d");
    const rejectedPlan = artifact("execution_plan", "e");
    expect(automaticAdmissionInputArtifacts({
      sourceStageId: "admission_review_gate",
      targetStageId: "admission_planner",
      priorArtifacts: [],
      eventArtifacts: [rejection, rejectedPlan],
    })).toEqual([rejectedPlan, rejection]);
  });
});
