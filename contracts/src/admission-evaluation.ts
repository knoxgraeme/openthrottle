import { digestCanonicalJson } from "./canonical.js";
import {
  validateAdmissionReview,
  type AdmissionReview,
  type AdmissionRoute,
} from "./admission-decision.js";
import { parseExecutionPlanContractV2 } from "./execution-plan-v2.js";
import {
  SHA256,
  arrayAt,
  booleanAt,
  enumAt,
  fail,
  integerAt,
  normalizedContract,
  nullable,
  objectAt,
  stringAt,
  timestampAt,
  unique,
  type ValidatedContract,
} from "./validation.js";

export const ADMISSION_EVALUATION_CASES_SCHEMA = "openthrottle.admission-evaluation-cases/v1" as const;
export const ADMISSION_EVALUATION_LABELS_SCHEMA = "openthrottle.admission-evaluation-labels/v1" as const;
export const ADMISSION_EVALUATION_CORPUS_MANIFEST_SCHEMA =
  "openthrottle.admission-evaluation-corpus-manifest/v1" as const;
export const ADMISSION_EVALUATION_CORPUS_SCHEMA = "openthrottle.admission-evaluation-corpus/v1" as const;
export const ADMISSION_ROLLOUT_EVIDENCE_SCHEMA = "openthrottle.admission-rollout-evidence/v1" as const;
export const ADMISSION_EVALUATION_MIN_CASES_PER_ROUTE = 15;
export const ADMISSION_EVALUATION_MIN_REPEATS = 3;
export const ADMISSION_EVALUATION_MIN_LIVE_DECISIONS = 270;
export const ADMISSION_EVALUATION_MIN_ROUTING_ACCURACY_BPS = 9_000;
export const ADMISSION_EVALUATION_MAX_UNAMBIGUOUS_NEEDS_HUMAN_BPS = 1_000;

const CASE_ID = /^case-[0-9]{3}$/;
const MODEL_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const SOURCE_OBLIGATION_ID = /^[A-Z][A-Z0-9]*(?:[._-][A-Z0-9]+)*$/;
const SENSITIVE_MATERIAL = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bOT_STATUS_TOKEN\s*=/,
];

export type AdmissionEvaluationRoute = AdmissionRoute;
export type AdmissionEvaluationModelFamily = "sol" | "opus";

export interface AdmissionEvaluationCase {
  case_id: string;
  ticket: string;
}

export interface AdmissionEvaluationLabel {
  case_id: string;
  expected_route: AdmissionEvaluationRoute;
  explicit_source_ids: string[];
}

export interface AdmissionEvaluationDistribution {
  simple: number;
  structured: number;
  needs_human: number;
}

export interface AdmissionEvaluationCorpus {
  schema: typeof ADMISSION_EVALUATION_CORPUS_SCHEMA;
  version: string;
  blinded: true;
  synthetic: true;
  cases: AdmissionEvaluationCase[];
  labels: AdmissionEvaluationLabel[];
  distribution: AdmissionEvaluationDistribution;
  cases_digest: string;
  labels_digest: string;
  digest: string;
}

export interface AdmissionRolloutGoverningDigests {
  runtime_digest: string;
  automatic_template_digest: string;
  compiler_digest: string;
  planner_package_digest: string;
  reviewer_package_digest: string;
  effective_manifest_digest: string;
}

export interface AdmissionEvaluationModel {
  model_id: string;
  family: AdmissionEvaluationModelFamily;
  model: string;
  reasoning_level: string;
}

export interface StructuredPlanReviewEvidence {
  reviewer_id: string;
  recorded_at: string;
  review: AdmissionReview;
}

export interface AdmissionSourceTrace {
  preserved_source_ids: string[];
  conflicting_source_ids: string[];
  semantic_coverage_repair_rounds: number;
}

export interface AdmissionEvaluationDecision {
  case_id: string;
  model_id: string;
  repeat: number;
  route: AdmissionEvaluationRoute;
  canonical_plan: string | null;
  generated_plan_digest: string | null;
  structured_plan_review: StructuredPlanReviewEvidence | null;
  source_trace: AdmissionSourceTrace | null;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd_micros: number;
}

export interface AdmissionRolloutEvidence {
  schema: typeof ADMISSION_ROLLOUT_EVIDENCE_SCHEMA;
  corpus_digest: string;
  governing_digests: AdmissionRolloutGoverningDigests;
  models: AdmissionEvaluationModel[];
  decisions: AdmissionEvaluationDecision[];
}

export interface AdmissionEvaluationModelScore {
  model_id: string;
  family: AdmissionEvaluationModelFamily;
  case_model_pairs: number;
  live_decisions: number;
  correct_worst_case_pairs: number;
  routing_accuracy_bps: number;
  unambiguous_needs_human_pairs: number;
  unambiguous_needs_human_rate_bps: number;
  unsafe_simple_decisions: number;
  ambiguous_executable_decisions: number;
  unapproved_structured_decisions: number;
  explicit_source_id_decisions: number;
  explicit_source_ids_expected: number;
  explicit_source_ids_preserved: number;
  explicit_source_id_coverage_bps: number;
  explicit_source_id_omissions: number;
  conflicting_source_ids: number;
  semantic_coverage_repair_decisions: number;
  semantic_coverage_repair_rounds: number;
  semantic_coverage_repair_rate_bps: number;
  free_form_structured_decisions: number;
  free_form_semantic_coverage_repair_decisions: number;
  free_form_semantic_coverage_repair_rate_bps: number;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd_micros: number;
}

export interface AdmissionEvaluationReport {
  schema: "openthrottle.admission-evaluation-report/v1";
  passed: true;
  corpus_digest: string;
  evidence_digest: string;
  total_decisions: number;
  models: AdmissionEvaluationModelScore[];
}

function assertNoSensitiveMaterial(value: unknown, path: string): void {
  const serialized = JSON.stringify(value);
  if (SENSITIVE_MATERIAL.some((pattern) => pattern.test(serialized))) {
    fail(path, "contains sensitive material");
  }
}

function digestAt(value: unknown, path: string): string {
  return stringAt(value, path, { pattern: SHA256 });
}

function sourceIdList(value: unknown, path: string): string[] {
  const ids = arrayAt(value, path, (entry, entryPath) =>
    stringAt(entry, entryPath, { max: 64, pattern: SOURCE_OBLIGATION_ID }), { max: 128 });
  return unique(ids, path).sort();
}

function canonicalPlanAt(value: unknown, path: string): { normalized: string; digest: string } {
  const raw = stringAt(value, path, { max: 256 * 1024 });
  const plan = parseExecutionPlanContractV2(raw, { source: path });
  if (raw !== plan.normalized) fail(path, "must contain canonical JSON bytes");
  if (plan.value.graph_id !== "structured") fail(`${path}.graph_id`, "must be structured");
  return plan;
}

function containsSourceId(canonicalPlan: string, sourceId: string): boolean {
  const sourceIds: string[] = canonicalPlan.match(/\b[A-Z][A-Z0-9]*(?:[._-][A-Z0-9]+)*\b/g) ?? [];
  return sourceIds.includes(sourceId);
}

function parseDistribution(value: unknown, path: string): AdmissionEvaluationDistribution {
  const input = objectAt(value, path, ["simple", "structured", "needs_human"]);
  return {
    simple: integerAt(input.simple, `${path}.simple`, 0, 10_000),
    structured: integerAt(input.structured, `${path}.structured`, 0, 10_000),
    needs_human: integerAt(input.needs_human, `${path}.needs_human`, 0, 10_000),
  };
}

function parseCases(value: unknown): {
  version: string;
  blinded: true;
  synthetic: true;
  cases: AdmissionEvaluationCase[];
  normalizedValue: unknown;
} {
  const input = objectAt(value, "admission_evaluation_cases", ["schema", "version", "blinded", "synthetic", "cases"]);
  if (input.schema !== ADMISSION_EVALUATION_CASES_SCHEMA) {
    fail("admission_evaluation_cases.schema", `must be ${ADMISSION_EVALUATION_CASES_SCHEMA}`);
  }
  const version = stringAt(input.version, "admission_evaluation_cases.version", { max: 64 });
  if (booleanAt(input.blinded, "admission_evaluation_cases.blinded") !== true) {
    fail("admission_evaluation_cases.blinded", "must be true");
  }
  if (booleanAt(input.synthetic, "admission_evaluation_cases.synthetic") !== true) {
    fail("admission_evaluation_cases.synthetic", "must be true");
  }
  const cases = arrayAt(input.cases, "admission_evaluation_cases.cases", (entry, path) => {
    const candidate = objectAt(entry, path, ["case_id", "ticket"]);
    return {
      case_id: stringAt(candidate.case_id, `${path}.case_id`, { pattern: CASE_ID }),
      ticket: stringAt(candidate.ticket, `${path}.ticket`, { max: 8_000 }),
    };
  }, { min: 45, max: 1_000 });
  if (new Set(cases.map((entry) => entry.case_id)).size !== cases.length) {
    fail("admission_evaluation_cases.cases", "must not contain duplicate case ids");
  }
  const normalizedValue = {
    schema: ADMISSION_EVALUATION_CASES_SCHEMA,
    version,
    blinded: true,
    synthetic: true,
    cases,
  };
  assertNoSensitiveMaterial(normalizedValue, "admission_evaluation_cases");
  return { version, blinded: true, synthetic: true, cases, normalizedValue };
}

function parseLabels(value: unknown): {
  version: string;
  labels: AdmissionEvaluationLabel[];
  normalizedValue: unknown;
} {
  const input = objectAt(value, "admission_evaluation_labels", ["schema", "version", "labels"]);
  if (input.schema !== ADMISSION_EVALUATION_LABELS_SCHEMA) {
    fail("admission_evaluation_labels.schema", `must be ${ADMISSION_EVALUATION_LABELS_SCHEMA}`);
  }
  const version = stringAt(input.version, "admission_evaluation_labels.version", { max: 64 });
  const labels = arrayAt(input.labels, "admission_evaluation_labels.labels", (entry, path) => {
    const label = objectAt(entry, path, ["case_id", "expected_route", "explicit_source_ids"]);
    return {
      case_id: stringAt(label.case_id, `${path}.case_id`, { pattern: CASE_ID }),
      expected_route: enumAt(label.expected_route, `${path}.expected_route`, ["simple", "structured", "needs_human"] as const),
      explicit_source_ids: label.explicit_source_ids === undefined
        ? []
        : sourceIdList(label.explicit_source_ids, `${path}.explicit_source_ids`),
    };
  }, { min: 45, max: 1_000 });
  if (new Set(labels.map((entry) => entry.case_id)).size !== labels.length) {
    fail("admission_evaluation_labels.labels", "must not contain duplicate case ids");
  }
  return {
    version,
    labels,
    normalizedValue: { schema: ADMISSION_EVALUATION_LABELS_SCHEMA, version, labels },
  };
}

export function validateAdmissionEvaluationCorpus(
  casesValue: unknown,
  labelsValue: unknown,
  manifestValue: unknown,
): ValidatedContract<AdmissionEvaluationCorpus> {
  const cases = parseCases(casesValue);
  const labels = parseLabels(labelsValue);
  if (cases.version !== labels.version) fail("admission_evaluation_labels.version", "must match the cases version");
  const caseIds = new Set(cases.cases.map((entry) => entry.case_id));
  const labelIds = new Set(labels.labels.map((entry) => entry.case_id));
  if (caseIds.size !== labelIds.size || [...caseIds].some((id) => !labelIds.has(id))) {
    fail("admission_evaluation_labels.labels", "must label every case exactly once and no other case");
  }

  const distribution: AdmissionEvaluationDistribution = { simple: 0, structured: 0, needs_human: 0 };
  for (const label of labels.labels) distribution[label.expected_route] += 1;
  for (const [route, count] of Object.entries(distribution)) {
    if (count < ADMISSION_EVALUATION_MIN_CASES_PER_ROUTE) {
      fail(`admission_evaluation_labels.labels.${route}`, `must contain at least ${ADMISSION_EVALUATION_MIN_CASES_PER_ROUTE} cases`);
    }
  }

  const casesDigest = digestCanonicalJson(cases.normalizedValue);
  const labelsDigest = digestCanonicalJson(labels.normalizedValue);
  const corpusDigest = digestCanonicalJson({
    schema: ADMISSION_EVALUATION_CORPUS_SCHEMA,
    version: cases.version,
    cases_digest: casesDigest,
    labels_digest: labelsDigest,
  });

  const manifest = objectAt(manifestValue, "admission_evaluation_manifest", [
    "schema", "version", "cases_digest", "labels_digest", "corpus_digest", "case_count", "distribution",
  ]);
  if (manifest.schema !== ADMISSION_EVALUATION_CORPUS_MANIFEST_SCHEMA) {
    fail("admission_evaluation_manifest.schema", `must be ${ADMISSION_EVALUATION_CORPUS_MANIFEST_SCHEMA}`);
  }
  if (stringAt(manifest.version, "admission_evaluation_manifest.version", { max: 64 }) !== cases.version) {
    fail("admission_evaluation_manifest.version", "must match the cases version");
  }
  if (digestAt(manifest.cases_digest, "admission_evaluation_manifest.cases_digest") !== casesDigest) {
    fail("admission_evaluation_manifest.cases_digest", "does not match the canonical blinded cases");
  }
  if (digestAt(manifest.labels_digest, "admission_evaluation_manifest.labels_digest") !== labelsDigest) {
    fail("admission_evaluation_manifest.labels_digest", "does not match the canonical sealed labels");
  }
  if (digestAt(manifest.corpus_digest, "admission_evaluation_manifest.corpus_digest") !== corpusDigest) {
    fail("admission_evaluation_manifest.corpus_digest", "does not match the canonical corpus identity");
  }
  if (integerAt(manifest.case_count, "admission_evaluation_manifest.case_count", 0, 10_000) !== cases.cases.length) {
    fail("admission_evaluation_manifest.case_count", "does not match the case count");
  }
  const manifestDistribution = parseDistribution(manifest.distribution, "admission_evaluation_manifest.distribution");
  if (JSON.stringify(manifestDistribution) !== JSON.stringify(distribution)) {
    fail("admission_evaluation_manifest.distribution", "does not match the sealed labels");
  }

  return normalizedContract({
    schema: ADMISSION_EVALUATION_CORPUS_SCHEMA,
    version: cases.version,
    blinded: cases.blinded,
    synthetic: cases.synthetic,
    cases: cases.cases,
    labels: labels.labels,
    distribution,
    cases_digest: casesDigest,
    labels_digest: labelsDigest,
    digest: corpusDigest,
  });
}

function parseGoverningDigests(value: unknown, path: string): AdmissionRolloutGoverningDigests {
  const input = objectAt(value, path, [
    "runtime_digest", "automatic_template_digest", "compiler_digest", "planner_package_digest",
    "reviewer_package_digest", "effective_manifest_digest",
  ]);
  return {
    runtime_digest: digestAt(input.runtime_digest, `${path}.runtime_digest`),
    automatic_template_digest: digestAt(input.automatic_template_digest, `${path}.automatic_template_digest`),
    compiler_digest: digestAt(input.compiler_digest, `${path}.compiler_digest`),
    planner_package_digest: digestAt(input.planner_package_digest, `${path}.planner_package_digest`),
    reviewer_package_digest: digestAt(input.reviewer_package_digest, `${path}.reviewer_package_digest`),
    effective_manifest_digest: digestAt(input.effective_manifest_digest, `${path}.effective_manifest_digest`),
  };
}

export function validateAdmissionRolloutEvidence(value: unknown): ValidatedContract<AdmissionRolloutEvidence> {
  const input = objectAt(value, "admission_rollout_evidence", [
    "schema", "corpus_digest", "governing_digests", "models", "decisions",
  ]);
  if (input.schema !== ADMISSION_ROLLOUT_EVIDENCE_SCHEMA) {
    fail("admission_rollout_evidence.schema", `must be ${ADMISSION_ROLLOUT_EVIDENCE_SCHEMA}`);
  }
  const models = arrayAt(input.models, "admission_rollout_evidence.models", (entry, path) => {
    const model = objectAt(entry, path, ["model_id", "family", "model", "reasoning_level"]);
    return {
      model_id: stringAt(model.model_id, `${path}.model_id`, { pattern: MODEL_ID }),
      family: enumAt(model.family, `${path}.family`, ["sol", "opus"] as const),
      model: stringAt(model.model, `${path}.model`, { max: 160 }),
      reasoning_level: stringAt(model.reasoning_level, `${path}.reasoning_level`, { max: 80 }),
    };
  }, { min: 2, max: 16 });
  if (new Set(models.map((entry) => entry.model_id)).size !== models.length) {
    fail("admission_rollout_evidence.models", "must not contain duplicate model ids");
  }
  for (const family of ["sol", "opus"] as const) {
    if (!models.some((entry) => entry.family === family)) {
      fail("admission_rollout_evidence.models", `must contain a configured ${family} model`);
    }
  }

  const governingDigests = parseGoverningDigests(
    input.governing_digests,
    "admission_rollout_evidence.governing_digests",
  );

  const decisions = arrayAt(input.decisions, "admission_rollout_evidence.decisions", (entry, path) => {
    const decision = objectAt(entry, path, [
      "case_id", "model_id", "repeat", "route", "canonical_plan", "generated_plan_digest", "structured_plan_review",
      "source_trace", "latency_ms", "input_tokens", "output_tokens", "cost_usd_micros",
    ]);
    const route = enumAt(decision.route, `${path}.route`, ["simple", "structured", "needs_human"] as const);
    const canonicalPlan = nullable(decision.canonical_plan, (candidate) => canonicalPlanAt(candidate, `${path}.canonical_plan`));
    const generatedPlanDigest = nullable(decision.generated_plan_digest, (candidate) =>
      digestAt(candidate, `${path}.generated_plan_digest`));
    const reviewEvidence = nullable(decision.structured_plan_review, (candidate): StructuredPlanReviewEvidence => {
      const reviewInput = objectAt(candidate, `${path}.structured_plan_review`, ["reviewer_id", "recorded_at", "review"]);
      return {
        reviewer_id: stringAt(reviewInput.reviewer_id, `${path}.structured_plan_review.reviewer_id`, { max: 160 }),
        recorded_at: timestampAt(reviewInput.recorded_at, `${path}.structured_plan_review.recorded_at`),
        review: validateAdmissionReview(reviewInput.review, {
          source: `${path}.structured_plan_review.review`,
        }).value,
      };
    });
    const sourceTrace: AdmissionSourceTrace | null = decision.source_trace === undefined || decision.source_trace === null
      ? null
      : (() => {
        const trace = objectAt(decision.source_trace, `${path}.source_trace`, [
          "preserved_source_ids", "conflicting_source_ids", "semantic_coverage_repair_rounds",
        ]);
        return {
          preserved_source_ids: sourceIdList(trace.preserved_source_ids, `${path}.source_trace.preserved_source_ids`),
          conflicting_source_ids: sourceIdList(trace.conflicting_source_ids, `${path}.source_trace.conflicting_source_ids`),
          semantic_coverage_repair_rounds: integerAt(
            trace.semantic_coverage_repair_rounds,
            `${path}.source_trace.semantic_coverage_repair_rounds`,
            0,
            100,
          ),
        };
      })();
    if (route === "structured" && (canonicalPlan === null || generatedPlanDigest === null)) {
      fail(path, "must carry canonical plan bytes and their digest for structured output");
    }
    if (route === "structured" && canonicalPlan!.digest !== generatedPlanDigest) {
      fail(`${path}.generated_plan_digest`, "does not match the canonical plan");
    }
    if (route === "structured" && reviewEvidence === null) {
      fail(`${path}.structured_plan_review`, "must carry a digest-bound review approval for structured output");
    }
    if (route === "structured" && reviewEvidence !== null) {
      if (reviewEvidence.review.generated_plan_digest !== generatedPlanDigest) {
        fail(`${path}.structured_plan_review.review.generated_plan_digest`, "does not match the canonical plan");
      }
      if (reviewEvidence.review.effective_manifest_digest !== governingDigests.effective_manifest_digest) {
        fail(`${path}.structured_plan_review.review.effective_manifest_digest`, "does not match the governing digest");
      }
    }
    if (route !== "structured" && (canonicalPlan !== null || generatedPlanDigest !== null || reviewEvidence !== null)) {
      fail(path, `must not carry a structured plan or review for ${route} output`);
    }
    if (route === "structured" && sourceTrace === null) {
      fail(`${path}.source_trace`, "must be present for structured output");
    }
    if (route !== "structured" && sourceTrace !== null) {
      fail(`${path}.source_trace`, `must be null for ${route} output`);
    }
    return {
      case_id: stringAt(decision.case_id, `${path}.case_id`, { pattern: CASE_ID }),
      model_id: stringAt(decision.model_id, `${path}.model_id`, { pattern: MODEL_ID }),
      repeat: integerAt(decision.repeat, `${path}.repeat`, 1, 100),
      route,
      canonical_plan: canonicalPlan?.normalized ?? null,
      generated_plan_digest: generatedPlanDigest,
      structured_plan_review: reviewEvidence,
      source_trace: sourceTrace,
      latency_ms: integerAt(decision.latency_ms, `${path}.latency_ms`, 0, 86_400_000),
      input_tokens: integerAt(decision.input_tokens, `${path}.input_tokens`, 0, 10_000_000),
      output_tokens: integerAt(decision.output_tokens, `${path}.output_tokens`, 0, 10_000_000),
      cost_usd_micros: integerAt(decision.cost_usd_micros, `${path}.cost_usd_micros`, 0, 1_000_000_000_000),
    };
  }, { min: 1, max: 100_000 });
  const keys = new Set<string>();
  for (const decision of decisions) {
    const key = `${decision.case_id}:${decision.model_id}:${decision.repeat}`;
    if (keys.has(key)) {
      fail("admission_rollout_evidence.decisions", "must not contain duplicate case, model, and repeat tuples");
    }
    keys.add(key);
  }

  const evidence: AdmissionRolloutEvidence = {
    schema: ADMISSION_ROLLOUT_EVIDENCE_SCHEMA,
    corpus_digest: digestAt(input.corpus_digest, "admission_rollout_evidence.corpus_digest"),
    governing_digests: governingDigests,
    models,
    decisions,
  };
  assertNoSensitiveMaterial(evidence, "admission_rollout_evidence");
  return normalizedContract(evidence);
}

function rateBasisPoints(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.floor((numerator * 10_000) / denominator);
}

export function scoreAdmissionRolloutEvidence(
  corpus: AdmissionEvaluationCorpus,
  evidenceValue: AdmissionRolloutEvidence,
  expectedGoverningDigests: AdmissionRolloutGoverningDigests,
): AdmissionEvaluationReport {
  const evidence = validateAdmissionRolloutEvidence(evidenceValue);
  if (evidence.value.corpus_digest !== corpus.digest) {
    fail("admission_rollout_evidence.corpus_digest", "does not match the held-out corpus");
  }
  for (const key of Object.keys(expectedGoverningDigests) as Array<keyof AdmissionRolloutGoverningDigests>) {
    if (evidence.value.governing_digests[key] !== expectedGoverningDigests[key]) {
      fail(`admission_rollout_evidence.governing_digests.${key}`, "changed since this evidence was recorded");
    }
  }
  if (evidence.value.decisions.length < ADMISSION_EVALUATION_MIN_LIVE_DECISIONS) {
    fail("admission_rollout_evidence.decisions", `must contain at least ${ADMISSION_EVALUATION_MIN_LIVE_DECISIONS} live decisions`);
  }

  const labels = new Map<string, AdmissionEvaluationLabel>();
  for (const label of corpus.labels) labels.set(label.case_id, label);
  const decisionsByModel = new Map<string, {
    cases: Map<string, { repeats: AdmissionEvaluationDecision[]; count: number }>;
    latency_ms: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd_micros: number;
    live_decisions: number;
  }>();
  for (const model of evidence.value.models) {
    decisionsByModel.set(model.model_id, {
      cases: new Map<string, { repeats: AdmissionEvaluationDecision[]; count: number }>(),
      latency_ms: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd_micros: 0,
      live_decisions: 0,
    });
  }
  for (const decision of evidence.value.decisions) {
    if (!labels.has(decision.case_id)) {
      fail("admission_rollout_evidence.decisions", `references unknown case ${decision.case_id}`);
    }
    const model = decisionsByModel.get(decision.model_id);
    if (!model) {
      fail("admission_rollout_evidence.decisions", `references unknown model ${decision.model_id}`);
    }
    let candidate = model.cases.get(decision.case_id);
    if (!candidate) {
      candidate = { repeats: [], count: 0 };
      model.cases.set(decision.case_id, candidate);
    }
    candidate.repeats[decision.repeat - 1] = decision;
    candidate.count += 1;
    model.live_decisions += 1;
    model.latency_ms += decision.latency_ms;
    model.input_tokens += decision.input_tokens;
    model.output_tokens += decision.output_tokens;
    model.cost_usd_micros += decision.cost_usd_micros;
  }

  const modelScores: AdmissionEvaluationModelScore[] = [];
  for (const model of evidence.value.models) {
    const indexed = decisionsByModel.get(model.model_id)!;
    let correctWorstCasePairs = 0;
    let unambiguousNeedsHumanPairs = 0;
    let unsafeSimpleDecisions = 0;
    let ambiguousExecutableDecisions = 0;
    let unapprovedStructuredDecisions = 0;
    let structuredDecisions = 0;
    let explicitSourceIdDecisions = 0;
    let explicitSourceIdsExpected = 0;
    let explicitSourceIdsPreserved = 0;
    let explicitSourceIdOmissions = 0;
    let conflictingSourceIds = 0;
    let semanticCoverageRepairDecisions = 0;
    let semanticCoverageRepairRounds = 0;
    let freeFormStructuredDecisions = 0;
    let freeFormSemanticCoverageRepairDecisions = 0;

    for (const label of corpus.labels) {
      const candidate = indexed.cases.get(label.case_id);
      if (!candidate || candidate.count < ADMISSION_EVALUATION_MIN_REPEATS) {
        fail("admission_rollout_evidence.decisions", `${model.model_id}/${label.case_id} must have at least ${ADMISSION_EVALUATION_MIN_REPEATS} repeats`);
      }
      const repeats = candidate.repeats;
      for (let index = 0; index < repeats.length; index += 1) {
        if (repeats[index]?.repeat !== index + 1) {
          fail("admission_rollout_evidence.decisions", `${model.model_id}/${label.case_id} repeats must be contiguous from 1`);
        }
      }
      const expectedIds = new Set(label.explicit_source_ids);
      let allRepeatsCorrect = true;
      let hasUnambiguousNeedsHuman = false;
      for (const entry of repeats) {
        if (entry.route !== label.expected_route) allRepeatsCorrect = false;
        if (label.expected_route !== "needs_human" && entry.route === "needs_human") {
          hasUnambiguousNeedsHuman = true;
        }
        if (label.expected_route !== "simple" && entry.route === "simple") unsafeSimpleDecisions += 1;
        if (label.expected_route === "needs_human" && entry.route !== "needs_human") {
          ambiguousExecutableDecisions += 1;
        }
        if (entry.route !== "structured") continue;
        if (entry.structured_plan_review?.review.verdict !== "approved") unapprovedStructuredDecisions += 1;

        structuredDecisions += 1;
        const trace = entry.source_trace!;
        const preservedIds = new Set(trace.preserved_source_ids);
        const missingIds = label.explicit_source_ids.filter((id) => !preservedIds.has(id));
        const unexpectedIds = trace.preserved_source_ids.filter((id) => !expectedIds.has(id));
        const planMissingIds = label.explicit_source_ids.filter((id) => !containsSourceId(entry.canonical_plan!, id));

        if (missingIds.length > 0) {
          fail(
            `admission_rollout_evidence.models.${model.model_id}.${label.case_id}`,
            `approved structured plan omits explicit source id ${missingIds.join(", ")}`,
          );
        }
        if (unexpectedIds.length > 0) {
          fail(
            `admission_rollout_evidence.models.${model.model_id}.${label.case_id}`,
            `source trace contains unexpected explicit source id ${unexpectedIds.join(", ")}`,
          );
        }
        if (planMissingIds.length > 0) {
          fail(
            `admission_rollout_evidence.models.${model.model_id}.${label.case_id}`,
            `canonical plan omits explicit source id ${planMissingIds.join(", ")}`,
          );
        }
        if (trace.conflicting_source_ids.length > 0) {
          fail(
            `admission_rollout_evidence.models.${model.model_id}.${label.case_id}`,
            `approved structured plan contains conflicting source id ${trace.conflicting_source_ids.join(", ")}`,
          );
        }

        if (label.explicit_source_ids.length > 0) {
          explicitSourceIdDecisions += 1;
          explicitSourceIdsExpected += label.explicit_source_ids.length;
          explicitSourceIdsPreserved += label.explicit_source_ids.length - planMissingIds.length;
          explicitSourceIdOmissions += missingIds.length;
          conflictingSourceIds += trace.conflicting_source_ids.length;
        } else {
          freeFormStructuredDecisions += 1;
          if (trace.semantic_coverage_repair_rounds > 0) {
            freeFormSemanticCoverageRepairDecisions += 1;
          }
        }
        if (trace.semantic_coverage_repair_rounds > 0) semanticCoverageRepairDecisions += 1;
        semanticCoverageRepairRounds += trace.semantic_coverage_repair_rounds;
      }
      if (allRepeatsCorrect) correctWorstCasePairs += 1;
      if (hasUnambiguousNeedsHuman) unambiguousNeedsHumanPairs += 1;
    }

    const routingAccuracyBps = rateBasisPoints(correctWorstCasePairs, corpus.labels.length);
    const unambiguousCases = corpus.distribution.simple + corpus.distribution.structured;
    const needsHumanRateBps = rateBasisPoints(unambiguousNeedsHumanPairs, unambiguousCases);
    if (routingAccuracyBps < ADMISSION_EVALUATION_MIN_ROUTING_ACCURACY_BPS) {
      fail(`admission_rollout_evidence.models.${model.model_id}`, "worst-repeat routing accuracy is below 90 percent");
    }
    if (needsHumanRateBps > ADMISSION_EVALUATION_MAX_UNAMBIGUOUS_NEEDS_HUMAN_BPS) {
      fail(`admission_rollout_evidence.models.${model.model_id}`, "unambiguous needs_human rate exceeds 10 percent");
    }
    if (unsafeSimpleDecisions > 0) {
      fail(`admission_rollout_evidence.models.${model.model_id}`, "contains an unsafe simple decision for a structured or ambiguous case");
    }
    if (ambiguousExecutableDecisions > 0) {
      fail(`admission_rollout_evidence.models.${model.model_id}`, "contains an ambiguous executable decision");
    }
    if (unapprovedStructuredDecisions > 0) {
      fail(`admission_rollout_evidence.models.${model.model_id}`, "every structured output requires operator approval");
    }

    modelScores.push({
      model_id: model.model_id,
      family: model.family,
      case_model_pairs: corpus.labels.length,
      live_decisions: indexed.live_decisions,
      correct_worst_case_pairs: correctWorstCasePairs,
      routing_accuracy_bps: routingAccuracyBps,
      unambiguous_needs_human_pairs: unambiguousNeedsHumanPairs,
      unambiguous_needs_human_rate_bps: needsHumanRateBps,
      unsafe_simple_decisions: unsafeSimpleDecisions,
      ambiguous_executable_decisions: ambiguousExecutableDecisions,
      unapproved_structured_decisions: unapprovedStructuredDecisions,
      explicit_source_id_decisions: explicitSourceIdDecisions,
      explicit_source_ids_expected: explicitSourceIdsExpected,
      explicit_source_ids_preserved: explicitSourceIdsPreserved,
      explicit_source_id_coverage_bps: rateBasisPoints(explicitSourceIdsPreserved, explicitSourceIdsExpected),
      explicit_source_id_omissions: explicitSourceIdOmissions,
      conflicting_source_ids: conflictingSourceIds,
      semantic_coverage_repair_decisions: semanticCoverageRepairDecisions,
      semantic_coverage_repair_rounds: semanticCoverageRepairRounds,
      semantic_coverage_repair_rate_bps: rateBasisPoints(semanticCoverageRepairDecisions, structuredDecisions),
      free_form_structured_decisions: freeFormStructuredDecisions,
      free_form_semantic_coverage_repair_decisions: freeFormSemanticCoverageRepairDecisions,
      free_form_semantic_coverage_repair_rate_bps: rateBasisPoints(
        freeFormSemanticCoverageRepairDecisions,
        freeFormStructuredDecisions,
      ),
      latency_ms: indexed.latency_ms,
      input_tokens: indexed.input_tokens,
      output_tokens: indexed.output_tokens,
      cost_usd_micros: indexed.cost_usd_micros,
    });
  }

  return {
    schema: "openthrottle.admission-evaluation-report/v1",
    passed: true,
    corpus_digest: corpus.digest,
    evidence_digest: evidence.digest,
    total_decisions: evidence.value.decisions.length,
    models: modelScores,
  };
}
