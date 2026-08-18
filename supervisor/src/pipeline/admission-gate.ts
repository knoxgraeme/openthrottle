import {
  validateAdmissionDecision,
  validateAdmissionExecutionPlanArtifact,
  validateAdmissionReview,
  validateStandardReceipt,
  type AdmissionDecision,
  type AdmissionExecutionPlanArtifact,
  type AdmissionRoute,
} from "@openthrottle/contracts";
import type { StageOutcome } from "./manifest.js";

const REQUIRED_CAPABILITIES = [
  "admission/plan@1",
  "admission/review@1",
  "supervisor/admission-gate@1",
] as const;

export interface AdmissionGateSkillBinding {
  skill: string;
  packageDigest: string | null;
}

export interface AdmissionGateContext {
  admissionBasisDigest: string;
  effectiveManifestDigest: string;
  requestHash: string;
  planRequestHash?: string;
  subject: string;
  candidates: AdmissionRoute[];
  lock: AdmissionRoute | null;
  runtime: {
    release: string;
    capabilityDigest: string;
    capabilities: string[];
    credentialScopes: string[];
  };
  planner: AdmissionGateSkillBinding;
  reviewer: AdmissionGateSkillBinding;
}

export interface AdmissionDecisionGateResult {
  outcome: Extract<StageOutcome, "success" | "no_change" | "needs_human">;
  route: AdmissionRoute;
  decision: AdmissionDecision;
  executionPlan?: AdmissionExecutionPlanArtifact;
  generatedPlanDigest: string | null;
}

export interface AdmissionReviewGateResult {
  outcome: Extract<StageOutcome, "success" | "failure" | "needs_human">;
  route: "structured";
  decision: AdmissionDecision;
  executionPlan: AdmissionExecutionPlanArtifact;
  correctionOwner: "planner" | null;
}

function assertRuntime(context: AdmissionGateContext): void {
  for (const capability of REQUIRED_CAPABILITIES) {
    if (!context.runtime.capabilities.includes(capability)) {
      throw new Error(`automatic admission runtime capability ${capability} is missing`);
    }
  }
  const scopes = [...new Set(context.runtime.credentialScopes)].sort();
  if (scopes.join(",") !== "model.invoke,repo.read") {
    throw new Error("automatic admission planning credential scopes must be exactly model.invoke and repo.read");
  }
}

function assertDigestBindings(
  value: { admission_basis_digest: string; effective_manifest_digest: string },
  context: AdmissionGateContext,
  label: string
): void {
  if (value.admission_basis_digest !== context.admissionBasisDigest) {
    throw new Error(`${label} admission basis digest mismatch`);
  }
  if (value.effective_manifest_digest !== context.effectiveManifestDigest) {
    throw new Error(`${label} effective manifest digest mismatch`);
  }
}

function validateReceiptAuthority(
  value: unknown,
  context: AdmissionGateContext,
  expectedType: "admission_decision" | "admission_review",
  binding: AdmissionGateSkillBinding
) {
  const receipt = validateStandardReceipt(value, { source: `automatic.${expectedType}` }).value;
  if (receipt.type !== expectedType) throw new Error(`automatic admission requires ${expectedType} receipt`);
  if (receipt.assurance !== "semantic_attested") throw new Error(`${expectedType} receipt assurance mismatch`);
  if (receipt.producer.skill !== binding.skill || receipt.producer.skill_package_digest !== binding.packageDigest) {
    throw new Error(`${expectedType === "admission_decision" ? "planner" : "reviewer"} provenance mismatch`);
  }
  if (receipt.producer.capability_digest !== context.runtime.capabilityDigest) {
    throw new Error(`${expectedType} runtime capability digest mismatch`);
  }
  if (receipt.fence.graph_digest !== context.effectiveManifestDigest) {
    throw new Error(`${expectedType} effective manifest fence mismatch`);
  }
  if (receipt.fence.request_hash !== context.requestHash) {
    throw new Error(`${expectedType} request binding mismatch`);
  }
  if ([receipt.subject.base, receipt.subject.pre, receipt.subject.post].some((entry) => entry !== context.subject)) {
    throw new Error(`${expectedType} source subject mismatch`);
  }
  return receipt;
}

function validatedPlan(
  value: unknown,
  context: AdmissionGateContext,
  expectedDigest: string
): AdmissionExecutionPlanArtifact {
  const plan = validateAdmissionExecutionPlanArtifact(value, {
    source: "automatic.execution_plan",
  }).value;
  if (plan.assurance !== "semantic_attested") {
    throw new Error("automatic execution plan must carry semantic_attested assurance before review");
  }
  assertDigestBindings(plan.source, context, "execution plan");
  if (plan.source.request_hash !== (context.planRequestHash ?? context.requestHash)) {
    throw new Error("execution plan request binding mismatch");
  }
  if (plan.generated_plan_digest !== expectedDigest) throw new Error("generated plan digest mismatch");
  if (plan.producer.skill !== context.planner.skill ||
      plan.producer.skill_package_digest !== context.planner.packageDigest ||
      plan.producer.capability_digest !== context.runtime.capabilityDigest) {
    throw new Error("execution plan planner provenance mismatch");
  }
  return plan;
}

export function evaluateAdmissionDecisionGate(input: {
  context: AdmissionGateContext;
  receipt: unknown;
  executionPlan?: unknown;
}): AdmissionDecisionGateResult {
  assertRuntime(input.context);
  const receipt = validateReceiptAuthority(
    input.receipt,
    input.context,
    "admission_decision",
    input.context.planner,
  );
  if (receipt.type !== "admission_decision") throw new Error("automatic admission decision receipt type mismatch");
  const decision = validateAdmissionDecision(receipt.payload.decision, {
    source: "automatic.decision",
  }).value;
  assertDigestBindings(decision, input.context, "admission decision");
  if (decision.route !== "needs_human" && !input.context.candidates.includes(decision.route)) {
    throw new Error(`admission decision route ${decision.route} is not a candidate`);
  }
  if (input.context.lock !== null && decision.route !== "needs_human" && decision.route !== input.context.lock) {
    throw new Error(`admission decision violates explicit ${input.context.lock} lock`);
  }
  if (decision.route === "structured") {
    if (!input.executionPlan) throw new Error("structured admission decision is missing its execution plan");
    const executionPlan = validatedPlan(input.executionPlan, input.context, decision.generated_plan_digest!);
    return {
      outcome: "success",
      route: "structured",
      decision,
      executionPlan,
      generatedPlanDigest: decision.generated_plan_digest,
    };
  }
  if (input.executionPlan !== undefined) {
    throw new Error(`${decision.route} admission decision cannot carry an execution plan`);
  }
  return {
    outcome: decision.route === "simple" ? "no_change" : "needs_human",
    route: decision.route,
    decision,
    generatedPlanDigest: null,
  };
}

export function evaluateAdmissionReviewGate(input: {
  context: AdmissionGateContext;
  decision: unknown;
  executionPlan: unknown;
  receipt: unknown;
}): AdmissionReviewGateResult {
  assertRuntime(input.context);
  const decision = validateAdmissionDecision(input.decision, { source: "automatic.decision" }).value;
  if (decision.route !== "structured" || decision.generated_plan_digest === null) {
    throw new Error("admission reviewer requires one accepted structured decision");
  }
  assertDigestBindings(decision, input.context, "admission decision");
  const executionPlan = validatedPlan(input.executionPlan, input.context, decision.generated_plan_digest);
  const receipt = validateReceiptAuthority(
    input.receipt,
    input.context,
    "admission_review",
    input.context.reviewer,
  );
  if (receipt.type !== "admission_review") throw new Error("automatic admission review receipt type mismatch");
  const review = validateAdmissionReview(receipt.payload.review, { source: "automatic.review" }).value;
  assertDigestBindings(review, input.context, "admission review");
  if (review.generated_plan_digest !== executionPlan.generated_plan_digest) {
    throw new Error("admission review generated plan digest mismatch");
  }
  if (review.verdict === "approved") {
    return {
      outcome: "success",
      route: "structured",
      decision,
      executionPlan: { ...executionPlan, assurance: "executor_verified" },
      correctionOwner: null,
    };
  }
  return {
    outcome: review.verdict === "needs_human" ? "needs_human" : "failure",
    route: "structured",
    decision,
    executionPlan,
    correctionOwner: review.verdict === "rejected" ? "planner" : null,
  };
}
