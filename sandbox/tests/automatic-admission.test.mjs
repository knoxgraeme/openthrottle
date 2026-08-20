import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const taskRoot = resolve(repoRoot, "skills/tasks");
const skill = (name) => readFileSync(resolve(taskRoot, name, "SKILL.md"), "utf8");
const reference = (name, file) => readFileSync(resolve(taskRoot, name, "references", file), "utf8");

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
    for (const [name, references] of [
      ["admission-plan", ["route-rubric.md", "semantic-output.md"]],
      ["review-admission-plan", ["review-checklist.md", "semantic-output.md"]],
    ]) {
      expect(skill(name)).toContain(`name: ${name}`);
      expect(existsSync(resolve(taskRoot, name, "agents/openai.yaml"))).toBe(true);
      for (const file of references) {
        expect(existsSync(resolve(taskRoot, name, "references", file))).toBe(true);
      }
    }
  });

  it("keeps both admission actors on compact semantic output", () => {
    for (const name of ["admission-plan", "review-admission-plan"]) {
      const body = skill(name);
      const shape = reference(name, "semantic-output.md");
      expect(body).toContain("references/semantic-output.md");
      expect(body).toMatch(/Do not emit a receipt/);
      expect(shape).toMatch(/Return exactly these four keys and no wrapper/);
      expect(shape).not.toContain('"producer"');
      expect(shape).not.toContain('"fence"');
      expect(shape).not.toContain('"issued_at"');
    }
  });

  it("keeps planner output typed, bounded, and complete for every route", () => {
    const body = skill("admission-plan");
    for (const phrase of [
      "openthrottle.execution-plan/v2",
      "simple",
      "structured",
      "needs_human",
      "256 KiB",
      "canonical plan digest",
    ]) expect(body).toContain(phrase);
    expect(body).toMatch(/objective,\s+requirements, files, approach, tests, acceptance, and verification/);
    expect(body).toMatch(/simple[\s\S]*no execution plan/i);
    expect(body).toMatch(/needs_human[\s\S]*specific/i);
    expect(body).toMatch(/explicit source[\s\S]*requirement\s+or acceptance IDs/i);
    expect(body).toMatch(/preserve[\s\S]*verbatim/i);
  });

  it("requires a fresh independent reviewer bound only to sealed inputs", () => {
    const body = skill("review-admission-plan");
    const shape = reference("review-admission-plan", "semantic-output.md");
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
      "candidate plan digest",
    ]) expect(body).toContain(phrase);
    expect(body).toMatch(/no planner conversation/i);
    expect(body).toMatch(/never rewrite|do not rewrite/i);
    expect(body).toMatch(/explicit source[\s\S]*requirement\s+or acceptance IDs/i);
    expect(body).toMatch(/omitted[\s\S]*weakened[\s\S]*conflicting/i);
    expect(body).not.toMatch(/engine\/model|request-fence|producer-package/i);
    expect(shape).toContain('"severity": "P0 | P1 | P2 | P3"');
    expect(shape).toContain('"message": "specific correctable defect"');
    expect(shape).toContain('"path": "optional repository path"');
    expect(shape).toMatch(/"verdict": "rejected"[\s\S]*"findings": \[[\s\S]*"severity": "P1"/);
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
      ["route-inconsistent result", "inconsistent"],
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
