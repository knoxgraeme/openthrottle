import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  scoreAdmissionRolloutEvidence,
  validateAdmissionEvaluationCorpus,
  validateAdmissionRolloutEvidence,
  type AdmissionEvaluationCorpus,
  type AdmissionRolloutEvidence,
  type AdmissionRolloutGoverningDigests,
} from "./admission-evaluation.js";

const fixtureRoot = fileURLToPath(new URL("../fixtures/admission-corpus/v1/", import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(`${fixtureRoot}${name}`, "utf8")) as unknown;

const governingDigests: AdmissionRolloutGoverningDigests = {
  runtime_digest: "1".repeat(64),
  automatic_template_digest: "2".repeat(64),
  compiler_digest: "3".repeat(64),
  planner_package_digest: "4".repeat(64),
  reviewer_package_digest: "5".repeat(64),
  effective_manifest_digest: "6".repeat(64),
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildEvidence(corpus: AdmissionEvaluationCorpus): AdmissionRolloutEvidence {
  const decisions: AdmissionRolloutEvidence["decisions"] = [];
  for (const model of [
    { model_id: "sol", family: "sol" as const, model: "gpt-5.6-sol", reasoning_level: "high" },
    { model_id: "opus", family: "opus" as const, model: "claude-opus-4-6", reasoning_level: "high" },
  ]) {
    for (const label of corpus.labels) {
      for (let repeat = 1; repeat <= 3; repeat += 1) {
        const structured = label.expected_route === "structured";
        decisions.push({
          case_id: label.case_id,
          model_id: model.model_id,
          repeat,
          route: label.expected_route,
          generated_plan_digest: structured ? "7".repeat(64) : null,
          structured_plan_approval: structured ? {
            status: "approved",
            operator_id: "fixture-operator",
            recorded_at: "2026-08-18T00:00:00.000Z",
          } : null,
          latency_ms: 1_000,
          input_tokens: 1_500,
          output_tokens: 750,
          cost_usd_micros: 2_500,
        });
      }
    }
  }
  return {
    schema: "openthrottle.admission-rollout-evidence/v1",
    corpus_digest: corpus.digest,
    governing_digests: governingDigests,
    models: [
      { model_id: "sol", family: "sol", model: "gpt-5.6-sol", reasoning_level: "high" },
      { model_id: "opus", family: "opus", model: "claude-opus-4-6", reasoning_level: "high" },
    ],
    decisions,
  };
}

describe("automatic admission rollout evidence", () => {
  it("pins one blinded synthetic corpus with fifteen cases per route", () => {
    const corpus = validateAdmissionEvaluationCorpus(
      fixture("cases.json"),
      fixture("labels.json"),
      fixture("manifest.json"),
    ).value;
    expect(corpus.cases).toHaveLength(45);
    expect(corpus.blinded).toBe(true);
    expect(corpus.synthetic).toBe(true);
    expect(corpus.distribution).toEqual({ simple: 15, structured: 15, needs_human: 15 });
    expect(corpus.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("scores at least 270 decisions by each model's worst repeat", () => {
    const corpus = validateAdmissionEvaluationCorpus(
      fixture("cases.json"), fixture("labels.json"), fixture("manifest.json"),
    ).value;
    const evidence = validateAdmissionRolloutEvidence(buildEvidence(corpus)).value;
    const report = scoreAdmissionRolloutEvidence(corpus, evidence, governingDigests);

    expect(report.passed).toBe(true);
    expect(report.total_decisions).toBe(270);
    expect(report.models).toHaveLength(2);
    for (const model of report.models) {
      expect(model.case_model_pairs).toBe(45);
      expect(model.correct_worst_case_pairs).toBe(45);
      expect(model.routing_accuracy_bps).toBe(10_000);
      expect(model.unambiguous_needs_human_rate_bps).toBe(0);
      expect(model.unsafe_simple_decisions).toBe(0);
      expect(model.ambiguous_executable_decisions).toBe(0);
      expect(model.unapproved_structured_decisions).toBe(0);
      expect(model.cost_usd_micros).toBe(337_500);
    }
  });

  it("produces equivalent scores for a large decision set regardless of decision order", () => {
    const corpus = validateAdmissionEvaluationCorpus(
      fixture("cases.json"), fixture("labels.json"), fixture("manifest.json"),
    ).value;
    const ordered = buildEvidence(corpus);
    const firstRepeats = ordered.decisions.filter((decision) => decision.repeat === 1);
    for (let repeat = 4; repeat <= 100; repeat += 1) {
      for (const decision of firstRepeats) ordered.decisions.push({ ...decision, repeat });
    }
    const reversed = clone(ordered);
    reversed.decisions.reverse();

    const orderedReport = scoreAdmissionRolloutEvidence(corpus, ordered, governingDigests);
    const reversedReport = scoreAdmissionRolloutEvidence(corpus, reversed, governingDigests);

    expect(orderedReport.total_decisions).toBe(9_000);
    expect(reversedReport.models).toEqual(orderedReport.models);
    expect(orderedReport.models.map((model) => model.live_decisions)).toEqual([4_500, 4_500]);
  });

  it("rejects incomplete repeats and per-model threshold failures", () => {
    const corpus = validateAdmissionEvaluationCorpus(
      fixture("cases.json"), fixture("labels.json"), fixture("manifest.json"),
    ).value;
    const missingRepeat = buildEvidence(corpus);
    missingRepeat.decisions.pop();
    expect(() => scoreAdmissionRolloutEvidence(corpus, missingRepeat, governingDigests)).toThrow(/270|repeat/i);

    const belowThreshold = buildEvidence(corpus);
    for (const decision of belowThreshold.decisions) {
      if (decision.model_id === "sol" && ["case-001", "case-002", "case-003", "case-004", "case-005"].includes(decision.case_id)) {
        decision.route = "needs_human";
      }
    }
    expect(() => scoreAdmissionRolloutEvidence(corpus, belowThreshold, governingDigests)).toThrow(/sol.*90|90.*sol/i);
  });

  it("rejects four unambiguous needs_human pairs even when routing accuracy stays above 90 percent", () => {
    const corpus = validateAdmissionEvaluationCorpus(
      fixture("cases.json"), fixture("labels.json"), fixture("manifest.json"),
    ).value;
    const evidence = buildEvidence(corpus);
    const affectedCases = new Set(["case-001", "case-002", "case-003", "case-004"]);
    for (const decision of evidence.decisions) {
      if (decision.model_id === "sol" && affectedCases.has(decision.case_id)) {
        decision.route = "needs_human";
      }
    }

    expect(() => scoreAdmissionRolloutEvidence(corpus, evidence, governingDigests))
      .toThrow(/sol.*needs_human rate exceeds 10 percent/i);
  });

  it("rejects unsafe routes and any unapproved structured output", () => {
    const corpus = validateAdmissionEvaluationCorpus(
      fixture("cases.json"), fixture("labels.json"), fixture("manifest.json"),
    ).value;

    const unsafeSimple = buildEvidence(corpus);
    unsafeSimple.decisions.find((entry) => entry.case_id === "case-016")!.route = "simple";
    unsafeSimple.decisions.find((entry) => entry.case_id === "case-016")!.generated_plan_digest = null;
    unsafeSimple.decisions.find((entry) => entry.case_id === "case-016")!.structured_plan_approval = null;
    expect(() => scoreAdmissionRolloutEvidence(corpus, unsafeSimple, governingDigests)).toThrow(/unsafe simple/i);

    const ambiguousExecution = buildEvidence(corpus);
    const ambiguous = ambiguousExecution.decisions.find((entry) => entry.case_id === "case-031")!;
    ambiguous.route = "structured";
    ambiguous.generated_plan_digest = "8".repeat(64);
    ambiguous.structured_plan_approval = {
      status: "approved",
      operator_id: "fixture-operator",
      recorded_at: "2026-08-18T00:00:00.000Z",
    };
    expect(() => scoreAdmissionRolloutEvidence(corpus, ambiguousExecution, governingDigests)).toThrow(/ambiguous.*executable/i);

    const unapproved = buildEvidence(corpus);
    unapproved.decisions.find((entry) => entry.route === "structured")!.structured_plan_approval = null;
    expect(() => scoreAdmissionRolloutEvidence(corpus, unapproved, governingDigests)).toThrow(/approval/i);
  });

  it("invalidates evidence when a governing digest changes", () => {
    const corpus = validateAdmissionEvaluationCorpus(
      fixture("cases.json"), fixture("labels.json"), fixture("manifest.json"),
    ).value;
    const expected = clone(governingDigests);
    expected.runtime_digest = "9".repeat(64);
    expect(() => scoreAdmissionRolloutEvidence(corpus, buildEvidence(corpus), expected)).toThrow(/runtime_digest.*changed/i);
  });

  it("rejects sensitive fixture text before scoring", () => {
    const cases = fixture("cases.json") as { cases: Array<{ ticket: string }> };
    cases.cases[0]!.ticket = "Use github_pat_abcdefghijklmnopqrstuvwxyz1234567890 in the fixture.";
    expect(() => validateAdmissionEvaluationCorpus(cases, fixture("labels.json"), fixture("manifest.json"))).toThrow(/sensitive/i);
  });
});
