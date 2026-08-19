import { canonicalJson, digestNormalized, validateAdmissionExecutionPlanArtifact } from "@openthrottle/contracts";
import { describe, expect, it } from "vitest";
import {
  evaluateAdmissionDecisionGate,
  evaluateAdmissionReviewGate,
  type AdmissionGateContext,
} from "./admission-gate.js";
import { validateExecutionPlanArtifact } from "./gates.js";

const basisDigest = "a".repeat(64);
const manifestDigest = "b".repeat(64);
const requestHash = "c".repeat(64);
const capabilityDigest = "d".repeat(64);
const subject = "e".repeat(40);

const plan = {
  schema: "openthrottle.execution-plan/v2" as const,
  graph_id: "structured" as const,
  plan_id: "automatic",
  units: [{
    id: "unit_a",
    title: "Unit A",
    depends_on: [],
    objective: "Implement the bounded behavior.",
    requirements: ["Preserve the contract."],
    files: ["src/unit-a.ts"],
    approach: ["Follow the existing pattern."],
    tests: ["Covers success."],
    acceptance: ["The behavior works."],
    verification: ["npm test"],
  }],
  commands: [{ name: "test" }],
};
const planDigest = digestNormalized(canonicalJson(plan));

const context: AdmissionGateContext = {
  admissionBasisDigest: basisDigest,
  effectiveManifestDigest: manifestDigest,
  requestHash,
  subject,
  candidates: ["simple", "structured"],
  lock: null,
  runtime: {
    release: "openthrottle-snapshot/v14",
    capabilityDigest,
    capabilities: ["admission/plan@1", "admission/review@1", "supervisor/admission-gate@1"],
    credentialScopes: ["model.invoke", "repo.read"],
  },
  planner: { skill: "builtin://admission-plan@1", packageDigest: null },
  reviewer: { skill: "builtin://review-admission-plan@1", packageDigest: null },
};

function receipt(type: "admission_decision" | "admission_review", result: string, payload: unknown, skill: string) {
  return {
    schema: "openthrottle.receipt/v1",
    type,
    assurance: "semantic_attested",
    result,
    producer: {
      worker_id: type === "admission_decision" ? "planner" : "reviewer",
      skill,
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
    evidence: ["sealed automatic admission evidence"],
    payload,
    issued_at: "2026-08-18T00:00:00.000Z",
  };
}

function decision(route: "simple" | "structured" | "needs_human") {
  return {
    schema: "openthrottle.admission-decision/v1",
    route,
    rationale: "Bounded route decision.",
    questions: route === "needs_human" ? ["Which acceptance behavior is required?"] : [],
    admission_basis_digest: basisDigest,
    effective_manifest_digest: manifestDigest,
    generated_plan_digest: route === "structured" ? planDigest : null,
  };
}

function planArtifact(assurance: "semantic_attested" | "executor_verified" = "semantic_attested") {
  return validateAdmissionExecutionPlanArtifact({
    schema: "openthrottle.admission-execution-plan-artifact/v1",
    execution_plan: plan,
    generated_plan_digest: planDigest,
    producer: {
      skill: "builtin://admission-plan@1",
      capability_digest: capabilityDigest,
      skill_package_digest: null,
    },
    assurance,
    source: {
      admission_basis_digest: basisDigest,
      effective_manifest_digest: manifestDigest,
      request_hash: requestHash,
    },
  }).value;
}

describe("automatic admission gates", () => {
  it("accepts the raw admission execution-plan artifact used by planner stage results", () => {
    const payload = canonicalJson(planArtifact());
    expect(() => validateExecutionPlanArtifact({
      kind: "execution_plan",
      schemaVersion: 1,
      assurance: "semantic_attested",
      subject,
      payload,
      hash: digestNormalized(payload),
    })).not.toThrow();
  });

  it("maps simple, structured, and needs_human only to their declared branches", () => {
    expect(evaluateAdmissionDecisionGate({
      context,
      receipt: receipt("admission_decision", "simple", { decision: decision("simple") }, context.planner.skill),
    })).toMatchObject({ outcome: "no_change", route: "simple" });
    expect(evaluateAdmissionDecisionGate({
      context,
      receipt: receipt("admission_decision", "structured", { decision: decision("structured") }, context.planner.skill),
      executionPlan: planArtifact(),
    })).toMatchObject({ outcome: "success", route: "structured", generatedPlanDigest: planDigest });
    expect(evaluateAdmissionDecisionGate({
      context,
      receipt: receipt("admission_decision", "needs_human", { decision: decision("needs_human") }, context.planner.skill),
    })).toMatchObject({ outcome: "needs_human", route: "needs_human" });
  });

  it("fails closed on locks, artifacts, provenance, request binding, capabilities, and credentials", () => {
    const structuredReceipt = receipt(
      "admission_decision",
      "structured",
      { decision: decision("structured") },
      context.planner.skill,
    );
    expect(() => evaluateAdmissionDecisionGate({
      context: { ...context, lock: "structured" },
      receipt: receipt("admission_decision", "simple", { decision: decision("simple") }, context.planner.skill),
    })).toThrow(/lock/);
    expect(() => evaluateAdmissionDecisionGate({ context, receipt: structuredReceipt })).toThrow(/execution plan/);
    expect(() => evaluateAdmissionDecisionGate({
      context,
      receipt: { ...structuredReceipt, producer: { ...structuredReceipt.producer, skill: "builtin://other@1" } },
      executionPlan: planArtifact(),
    })).toThrow(/planner provenance/);
    expect(() => evaluateAdmissionDecisionGate({
      context,
      receipt: { ...structuredReceipt, fence: { ...structuredReceipt.fence, request_hash: "f".repeat(64) } },
      executionPlan: planArtifact(),
    })).toThrow(/request/);
    expect(() => evaluateAdmissionDecisionGate({
      context: { ...context, runtime: { ...context.runtime, capabilities: ["admission/plan@1"] } },
      receipt: structuredReceipt,
      executionPlan: planArtifact(),
    })).toThrow(/runtime capability/);
    expect(() => evaluateAdmissionDecisionGate({
      context: { ...context, runtime: { ...context.runtime, credentialScopes: ["model.invoke", "repo.read", "repo.write"] } },
      receipt: structuredReceipt,
      executionPlan: planArtifact(),
    })).toThrow(/credential/);
  });

  it("approves only an exact fresh review and re-emits byte-identical executor-verified plan bytes", () => {
    const review = {
      schema: "openthrottle.admission-review/v1",
      verdict: "approved",
      summary: "Complete and bounded.",
      findings: [],
      questions: [],
      admission_basis_digest: basisDigest,
      effective_manifest_digest: manifestDigest,
      generated_plan_digest: planDigest,
    };
    const result = evaluateAdmissionReviewGate({
      context,
      decision: decision("structured"),
      executionPlan: planArtifact(),
      receipt: receipt("admission_review", "approved", { review }, context.reviewer.skill),
    });
    expect(result).toMatchObject({ outcome: "success", route: "structured" });
    expect(result.executionPlan.assurance).toBe("executor_verified");
    expect(canonicalJson(result.executionPlan.execution_plan)).toBe(canonicalJson(plan));
    expect(result.executionPlan.generated_plan_digest).toBe(planDigest);
  });

  it("returns validated rejection findings for a planner correction", () => {
    const review = {
      schema: "openthrottle.admission-review/v1",
      verdict: "rejected",
      summary: "Acceptance is incomplete.",
      findings: [{ severity: "P1", message: "Add the missing failure-path acceptance.", path: "unit_a" }],
      questions: [],
      admission_basis_digest: basisDigest,
      effective_manifest_digest: manifestDigest,
      generated_plan_digest: planDigest,
    };
    const result = evaluateAdmissionReviewGate({
      context,
      decision: decision("structured"),
      executionPlan: planArtifact(),
      receipt: receipt("admission_review", "rejected", { review }, context.reviewer.skill),
    });
    expect(result).toMatchObject({
      outcome: "failure",
      correctionOwner: "planner",
      review: { findings: review.findings, generated_plan_digest: planDigest },
    });
  });
});
