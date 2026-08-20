import {
  PRODUCER_SKILL_REFERENCE,
  SHA256,
  arrayAt,
  enumAt,
  fail,
  normalizedContract,
  nullable,
  objectAt,
  stringAt,
  type ValidatedContract,
} from "./validation.js";
import {
  validateExecutionPlanContractV2,
  type ExecutionPlanContractV2,
} from "./execution-plan-v2.js";

export const ADMISSION_DECISION_SCHEMA = "openthrottle.admission-decision/v1" as const;
export const ADMISSION_REVIEW_SCHEMA = "openthrottle.admission-review/v1" as const;
export const ADMISSION_EXECUTION_PLAN_ARTIFACT_SCHEMA =
  "openthrottle.admission-execution-plan-artifact/v1" as const;
export const ADMISSION_EXECUTION_PLAN_ARTIFACT_MAX_BYTES = 320 * 1024;

export type AdmissionRoute = "simple" | "structured" | "needs_human";
export type AdmissionReviewVerdict = "approved" | "rejected" | "needs_human";

export interface AdmissionDecision {
  schema: typeof ADMISSION_DECISION_SCHEMA;
  route: AdmissionRoute;
  rationale: string;
  questions: string[];
  admission_basis_digest: string;
  effective_manifest_digest: string;
  generated_plan_digest: string | null;
}

export interface AdmissionReviewFinding {
  severity: "P0" | "P1" | "P2" | "P3";
  message: string;
  path?: string;
}

export interface AdmissionReview {
  schema: typeof ADMISSION_REVIEW_SCHEMA;
  verdict: AdmissionReviewVerdict;
  summary: string;
  findings: AdmissionReviewFinding[];
  questions: string[];
  admission_basis_digest: string;
  effective_manifest_digest: string;
  generated_plan_digest: string;
}

export interface AdmissionArtifactProducer {
  skill: string;
  capability_digest: string;
  skill_package_digest: string | null;
}

export interface AdmissionExecutionPlanArtifact {
  schema: typeof ADMISSION_EXECUTION_PLAN_ARTIFACT_SCHEMA;
  execution_plan: ExecutionPlanContractV2;
  generated_plan_digest: string;
  producer: AdmissionArtifactProducer;
  assurance: "semantic_attested" | "executor_verified";
  source: {
    admission_basis_digest: string;
    effective_manifest_digest: string;
    request_hash: string;
  };
}

function digest(value: unknown, path: string): string {
  return stringAt(value, path, { pattern: SHA256 });
}

function boundedStrings(value: unknown, path: string, options: { min?: number; max: number }): string[] {
  return arrayAt(value, path, (entry, entryPath) => stringAt(entry, entryPath, { max: 1_000 }), options);
}

function assertDistinctDigests(
  value: { admission_basis_digest: string; effective_manifest_digest: string; generated_plan_digest: string | null },
  source: string
): void {
  if (value.effective_manifest_digest === value.admission_basis_digest) {
    fail(`${source}.effective_manifest_digest`, "must be distinct from admission_basis_digest");
  }
  if (value.generated_plan_digest !== null && (
    value.generated_plan_digest === value.admission_basis_digest ||
    value.generated_plan_digest === value.effective_manifest_digest
  )) {
    fail(`${source}.generated_plan_digest`, "must be distinct from admission_basis_digest and effective_manifest_digest");
  }
}

export function validateAdmissionDecision(
  value: unknown,
  options: { source?: string } = {}
): ValidatedContract<AdmissionDecision> {
  const source = options.source ?? "admission_decision";
  const input = objectAt(value, source, [
    "schema", "route", "rationale", "questions", "admission_basis_digest",
    "effective_manifest_digest", "generated_plan_digest",
  ]);
  if (input.schema !== ADMISSION_DECISION_SCHEMA) {
    fail(`${source}.schema`, `must be ${ADMISSION_DECISION_SCHEMA}`);
  }
  const decision: AdmissionDecision = {
    schema: ADMISSION_DECISION_SCHEMA,
    route: enumAt(input.route, `${source}.route`, ["simple", "structured", "needs_human"] as const),
    rationale: stringAt(input.rationale, `${source}.rationale`, { max: 4_000 }),
    questions: boundedStrings(input.questions, `${source}.questions`, { max: 16 }),
    admission_basis_digest: digest(input.admission_basis_digest, `${source}.admission_basis_digest`),
    effective_manifest_digest: digest(input.effective_manifest_digest, `${source}.effective_manifest_digest`),
    generated_plan_digest: nullable(input.generated_plan_digest, (entry) =>
      digest(entry, `${source}.generated_plan_digest`)),
  };
  assertDistinctDigests(decision, source);
  if (decision.route === "structured" && decision.generated_plan_digest === null) {
    fail(`${source}.generated_plan_digest`, "must be present for structured");
  }
  if (decision.route !== "structured" && decision.generated_plan_digest !== null) {
    fail(`${source}.generated_plan_digest`, `must be null for ${decision.route}`);
  }
  if (decision.route === "needs_human" && decision.questions.length === 0) {
    fail(`${source}.questions`, "must contain between 1 and 16 entries");
  }
  if (decision.route !== "needs_human" && decision.questions.length !== 0) {
    fail(`${source}.questions`, `must be empty for ${decision.route}`);
  }
  return normalizedContract(decision);
}

function reviewFindings(value: unknown, path: string): AdmissionReviewFinding[] {
  return arrayAt(value, path, (entry, entryPath) => {
    const input = objectAt(entry, entryPath, ["severity", "message", "path"]);
    return {
      severity: enumAt(input.severity, `${entryPath}.severity`, ["P0", "P1", "P2", "P3"] as const),
      message: stringAt(input.message, `${entryPath}.message`, { max: 2_000 }),
      ...(input.path === undefined ? {} : {
        path: stringAt(input.path, `${entryPath}.path`, { max: 300 }),
      }),
    };
  }, { max: 64 });
}

export function validateAdmissionReview(
  value: unknown,
  options: { source?: string } = {}
): ValidatedContract<AdmissionReview> {
  const source = options.source ?? "admission_review";
  const input = objectAt(value, source, [
    "schema", "verdict", "summary", "findings", "questions",
    "admission_basis_digest", "effective_manifest_digest", "generated_plan_digest",
  ]);
  if (input.schema !== ADMISSION_REVIEW_SCHEMA) {
    fail(`${source}.schema`, `must be ${ADMISSION_REVIEW_SCHEMA}`);
  }
  const review: AdmissionReview = {
    schema: ADMISSION_REVIEW_SCHEMA,
    verdict: enumAt(input.verdict, `${source}.verdict`, ["approved", "rejected", "needs_human"] as const),
    summary: stringAt(input.summary, `${source}.summary`, { max: 4_000 }),
    findings: reviewFindings(input.findings, `${source}.findings`),
    questions: boundedStrings(input.questions, `${source}.questions`, { max: 16 }),
    admission_basis_digest: digest(input.admission_basis_digest, `${source}.admission_basis_digest`),
    effective_manifest_digest: digest(input.effective_manifest_digest, `${source}.effective_manifest_digest`),
    generated_plan_digest: digest(input.generated_plan_digest, `${source}.generated_plan_digest`),
  };
  assertDistinctDigests(review, source);
  if (review.verdict === "approved" && (review.findings.length !== 0 || review.questions.length !== 0)) {
    fail(`${source}.verdict`, "approved reviews must have no findings or questions");
  }
  if (review.verdict === "rejected" && review.findings.length === 0) {
    fail(`${source}.findings`, "must contain between 1 and 64 entries for rejected");
  }
  if (review.verdict === "needs_human" && review.questions.length === 0) {
    fail(`${source}.questions`, "must contain between 1 and 16 entries");
  }
  if (review.verdict !== "needs_human" && review.questions.length !== 0) {
    fail(`${source}.questions`, `must be empty for ${review.verdict}`);
  }
  return normalizedContract(review);
}

function parseProducer(value: unknown, path: string): AdmissionArtifactProducer {
  const input = objectAt(value, path, ["skill", "capability_digest", "skill_package_digest"]);
  const producer: AdmissionArtifactProducer = {
    skill: stringAt(input.skill, `${path}.skill`, { max: 320, pattern: PRODUCER_SKILL_REFERENCE }),
    capability_digest: digest(input.capability_digest, `${path}.capability_digest`),
    skill_package_digest: nullable(input.skill_package_digest, (entry) =>
      digest(entry, `${path}.skill_package_digest`)),
  };
  if (producer.skill.startsWith("builtin://") && producer.skill_package_digest !== null) {
    fail(`${path}.skill_package_digest`, "must be null for builtin skills");
  }
  if (producer.skill.startsWith("repo://") && producer.skill_package_digest === null) {
    fail(`${path}.skill_package_digest`, "must be present for repository skills");
  }
  return producer;
}

export function validateAdmissionExecutionPlanArtifact(
  value: unknown,
  options: { source?: string } = {}
): ValidatedContract<AdmissionExecutionPlanArtifact> {
  const source = options.source ?? "admission_execution_plan_artifact";
  const input = objectAt(value, source, [
    "schema", "execution_plan", "generated_plan_digest", "producer", "assurance", "source",
  ]);
  if (input.schema !== ADMISSION_EXECUTION_PLAN_ARTIFACT_SCHEMA) {
    fail(`${source}.schema`, `must be ${ADMISSION_EXECUTION_PLAN_ARTIFACT_SCHEMA}`);
  }
  const plan = validateExecutionPlanContractV2(input.execution_plan, {
    source: `${source}.execution_plan`,
  });
  if (plan.value.pipeline_id !== "core/structured") {
    fail(`${source}.execution_plan.pipeline_id`, "must be core/structured");
  }
  const sourceInput = objectAt(input.source, `${source}.source`, [
    "admission_basis_digest", "effective_manifest_digest", "request_hash",
  ]);
  const artifact: AdmissionExecutionPlanArtifact = {
    schema: ADMISSION_EXECUTION_PLAN_ARTIFACT_SCHEMA,
    execution_plan: plan.value,
    generated_plan_digest: digest(input.generated_plan_digest, `${source}.generated_plan_digest`),
    producer: parseProducer(input.producer, `${source}.producer`),
    assurance: enumAt(input.assurance, `${source}.assurance`, ["semantic_attested", "executor_verified"] as const),
    source: {
      admission_basis_digest: digest(sourceInput.admission_basis_digest, `${source}.source.admission_basis_digest`),
      effective_manifest_digest: digest(sourceInput.effective_manifest_digest, `${source}.source.effective_manifest_digest`),
      request_hash: digest(sourceInput.request_hash, `${source}.source.request_hash`),
    },
  };
  if (artifact.generated_plan_digest !== plan.digest) {
    fail(`${source}.generated_plan_digest`, "does not match the canonical execution plan digest");
  }
  assertDistinctDigests({
    admission_basis_digest: artifact.source.admission_basis_digest,
    effective_manifest_digest: artifact.source.effective_manifest_digest,
    generated_plan_digest: artifact.generated_plan_digest,
  }, `${source}.source`);
  const validated = normalizedContract(artifact);
  if (Buffer.byteLength(validated.normalized, "utf8") > ADMISSION_EXECUTION_PLAN_ARTIFACT_MAX_BYTES) {
    fail(source, `canonical JSON must contain at most ${ADMISSION_EXECUTION_PLAN_ARTIFACT_MAX_BYTES} UTF-8 bytes`);
  }
  return validated;
}

export function parseAdmissionExecutionPlanArtifact(
  raw: string,
  options: { source?: string } = {}
): ValidatedContract<AdmissionExecutionPlanArtifact> {
  const source = options.source ?? "admission_execution_plan_artifact";
  if (Buffer.byteLength(raw, "utf8") > ADMISSION_EXECUTION_PLAN_ARTIFACT_MAX_BYTES) {
    fail(source, `JSON exceeds ${ADMISSION_EXECUTION_PLAN_ARTIFACT_MAX_BYTES} UTF-8 bytes`);
  }
  return validateAdmissionExecutionPlanArtifact(JSON.parse(raw) as unknown, options);
}
