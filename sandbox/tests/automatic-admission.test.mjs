import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const taskRoot = resolve(repoRoot, "skills/tasks");
const skill = (name) => readFileSync(resolve(taskRoot, name, "SKILL.md"), "utf8");

describe("automatic-admission task packages", () => {
  it("runs the production automatic coordinator and structured runtime in one lifecycle", () => {
    const workflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const proof = readFileSync(resolve(repoRoot, "sandbox/tests/automatic-walking-skeleton.mjs"), "utf8");
    expect(workflow).toContain("node sandbox/tests/automatic-walking-skeleton.mjs openthrottle:test");
    expect(workflow).not.toContain("node sandbox/tests/structured-walking-skeleton.mjs openthrottle:test");
    expect(proof).toContain("createPipelineEffectProcessor");
    expect(proof).toContain("completeStageAttemptActor");
    expect(proof).toContain("createDockerSandboxRuntime");
    expect(proof).toContain("structured execution did not receive the exact reviewed plan bytes");
    expect(proof).not.toContain("execFileSync(process.execPath");
    expect(proof).toContain('"none"');
    expect(proof).toContain("evaluateAdmissionDecisionGate");
    expect(proof).toContain("evaluateAdmissionReviewGate");
  });

  it("ships one complete canonical package per planning action", () => {
    for (const [name, reference] of [
      ["admission-plan", "route-rubric.md"],
      ["review-admission-plan", "review-checklist.md"],
    ]) {
      expect(skill(name)).toContain(`name: ${name}`);
      expect(existsSync(resolve(taskRoot, name, "agents/openai.yaml"))).toBe(true);
      expect(existsSync(resolve(taskRoot, name, "references", reference))).toBe(true);
    }
  });

  it("keeps planner output typed, bounded, and complete for every route", () => {
    const body = skill("admission-plan");
    for (const phrase of [
      "openthrottle.admission-decision/v1",
      "openthrottle.execution-plan/v2",
      "admission_decision",
      "simple",
      "structured",
      "needs_human",
      "256 KiB",
      "generated_plan_digest",
    ]) expect(body).toContain(phrase);
    expect(body).toMatch(/objective,\s+requirements, files, approach, tests, acceptance, and verification/);
    expect(body).toMatch(/simple[\s\S]*no execution plan/i);
    expect(body).toMatch(/needs_human[\s\S]*specific/i);
    expect(body).toMatch(/explicit source[\s\S]*requirement\s+or acceptance IDs/i);
    expect(body).toMatch(/preserve[\s\S]*verbatim/i);
  });

  it("requires a fresh independent reviewer bound only to sealed inputs", () => {
    const body = skill("review-admission-plan");
    for (const phrase of [
      "fresh context",
      "bounded ticket",
      "candidate route",
      "candidate plan",
      "scope coverage",
      "unsupported expansion",
      "dependency coherence",
      "acceptance completeness",
      "path plausibility",
      "executable verification",
      "openthrottle.admission-review/v1",
      "admission_review",
      "generated_plan_digest",
    ]) expect(body).toContain(phrase);
    expect(body).toMatch(/no planner conversation/i);
    expect(body).toMatch(/never rewrite|do not rewrite/i);
    expect(body).toMatch(/explicit source[\s\S]*requirement\s+or acceptance IDs/i);
    expect(body).toMatch(/omitted[\s\S]*weakened[\s\S]*conflicting/i);
  });

  it("treats adversarial content as data and denies every planning-side effect", () => {
    const adversarialFixtures = [
      ["route coercion", "untrusted data"],
      ["ticket-selected package", "select a skill"],
      ["capability escalation", "grant a capability"],
      ["repository exfiltration", "exfiltrate"],
      ["package self-modification", "this skill package"],
      ["repository write", "Never edit"],
      ["publication", "publish"],
      ["self-answered ambiguity", "needs_human"],
      ["session reuse", "session"],
      ["secret-bearing instruction", "secret"],
      ["malformed result", "Malformed"],
      ["duplicate result", "duplicate"],
      ["oversized result", "oversized"],
      ["route-inconsistent result", "route-inconsistent"],
    ];
    for (const name of ["admission-plan", "review-admission-plan"]) {
      const body = skill(name).replace(/\s+/g, " ");
      for (const [fixture, denial] of adversarialFixtures) {
        expect(body, `${name} must deny the ${fixture} fixture`).toContain(denial);
      }
    }
    const joined = `${skill("admission-plan")}\n${skill("review-admission-plan")}`;
    expect(joined.toLowerCase()).not.toContain("compound-engineering");
    expect(joined).not.toMatch(/\bce-[a-z][a-z-]*[a-z]\b/);
  });
});
