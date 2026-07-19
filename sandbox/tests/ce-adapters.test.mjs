import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function adapter(engine, task) {
  const path = engine === "claude"
    ? `skills/claude/${task}/SKILL.md`
    : `skills/${engine}/${task}.md`;
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("OpenThrottle Compound Engineering adapters", () => {
  const expected = {
    "implement-plan": ["ce-work", "ce-code-review", "ce-commit-push-pr", "ce-babysit-pr"],
    review: ["ce-code-review"],
    "review-fix": ["ce-resolve-pr-feedback", "ce-babysit-pr"],
    investigate: ["ce-debug", "ce-commit-push-pr", "ce-babysit-pr"],
  };

  for (const engine of ["claude", "codex", "opencode"]) {
    for (const [task, skills] of Object.entries(expected)) {
      it(`${engine} ${task} composes the declared native skills`, () => {
        const body = adapter(engine, task);
        for (const skill of skills) expect(body).toContain(skill);
        expect(body).toContain("ot-activity");
      });
    }
  }

  it("keeps the plan gate and makes investigation action-capable", () => {
    expect(adapter("claude", "implement-plan")).toContain("stop without changing code");
    expect(adapter("codex", "implement-plan")).toContain("stop without changing code");
    expect(adapter("opencode", "implement-plan")).toContain("stop without changing code");
    expect(adapter("claude", "investigate")).toContain("action-capable");
    expect(adapter("codex", "investigate")).toContain("may fix");
    expect(adapter("opencode", "investigate")).toContain("may fix");
    expect(adapter("claude", "investigate")).toContain("actual bug");
    expect(adapter("codex", "investigate")).toContain("actual bug");
    expect(adapter("claude", "investigate")).not.toContain("mode:pipeline ~/.ot/linear-context.md");
    expect(adapter("codex", "investigate")).not.toContain("mode:pipeline ~/.ot/linear-context.md");
    expect(adapter("opencode", "investigate")).not.toContain("mode:pipeline ~/.ot/linear-context.md");
  });

  it("keeps the decision gate, no-backlog rule, and assumptions ledger in every form", () => {
    for (const engine of ["claude", "codex", "opencode"]) {
      for (const task of ["implement-plan", "review-fix", "investigate"]) {
        const body = adapter(engine, task);
        expect(body).toContain("elicitation");
        expect(body).toContain("Assumptions & decisions");
      }
      const reviewFix = adapter(engine, "review-fix");
      expect(reviewFix).toContain("decision-required");
      expect(reviewFix).toContain("Never defer, backlog,");
      expect(adapter(engine, "review")).toContain("decision-required");
    }
  });

  it("passes the runtime PR number to Codex review", () => {
    expect(adapter("codex", "review")).toContain("mode:agent $PR_NUMBER");
    expect(adapter("codex", "review")).not.toContain("mode:agent PR_NUMBER");
  });

  it("runs configured gates before either engine creates a PR", () => {
    for (const engine of ["claude", "codex", "opencode"]) {
      const body = adapter(engine, "implement-plan");
      const testGate = body.indexOf("$OT_TEST_CMD");
      const lintGate = body.indexOf("$OT_LINT_CMD");
      const buildGate = body.indexOf("$OT_BUILD_CMD");
      const createPr = body.indexOf("ce-commit-push-pr");

      expect(testGate).toBeGreaterThan(-1);
      expect(lintGate).toBeGreaterThan(testGate);
      expect(buildGate).toBeGreaterThan(lintGate);
      expect(createPr).toBeGreaterThan(buildGate);
    }
  });
});
