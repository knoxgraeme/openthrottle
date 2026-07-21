import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillsRoot = resolve(repoRoot, "skills");

const tasks = ["implement-plan", "investigate"];

function skillBody(task) {
  return readFileSync(resolve(skillsRoot, "tasks", task, "SKILL.md"), "utf8");
}

function agentsYaml(task) {
  return readFileSync(
    resolve(skillsRoot, "tasks", task, "agents", "openai.yaml"),
    "utf8",
  );
}

// Every regular file anywhere under skills/, used to assert a phrase never
// appears again in the tree (not just in the two canonical files).
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function allSkillsText() {
  return walk(skillsRoot)
    .filter((f) => statSync(f).isFile())
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
}

describe("OpenThrottle canonical task skills", () => {
  it("both canonical skill files exist with YAML frontmatter", () => {
    for (const task of tasks) {
      const body = skillBody(task);
      expect(body.startsWith("---\n")).toBe(true);
      expect(body).toContain(`name: ${task}`);
      expect(body).toMatch(/\ndescription: .+\n---\n/);
    }
  });

  it("never mentions ce-babysit-pr anywhere under skills/", () => {
    expect(allSkillsText()).not.toContain("ce-babysit-pr");
  });

  it("implement-plan keeps the plan gate, decision gate, and assumptions ledger", () => {
    const body = skillBody("implement-plan");
    expect(body).toContain("stop without changing code");
    expect(body).toContain("elicitation");
    expect(body).toContain("Assumptions & decisions");
    expect(body).toContain(
      "critical, foundational, or risky",
    );
  });

  it("implement-plan invokes the CE pipeline in order: ce-work, ce-code-review, ce-commit-push-pr", () => {
    const body = skillBody("implement-plan");
    const workIdx = body.indexOf("ce-work");
    const reviewIdx = body.indexOf("ce-code-review");
    const prIdx = body.indexOf("ce-commit-push-pr");
    expect(workIdx).toBeGreaterThan(-1);
    expect(reviewIdx).toBeGreaterThan(workIdx);
    expect(prIdx).toBeGreaterThan(reviewIdx);
  });

  it("implement-plan runs configured gates before ce-commit-push-pr", () => {
    const body = skillBody("implement-plan");
    const testGate = body.indexOf("$OT_TEST_CMD");
    const lintGate = body.indexOf("$OT_LINT_CMD");
    const buildGate = body.indexOf("$OT_BUILD_CMD");
    const createPr = body.indexOf("ce-commit-push-pr");

    expect(testGate).toBeGreaterThan(-1);
    expect(lintGate).toBeGreaterThan(testGate);
    expect(buildGate).toBeGreaterThan(lintGate);
    expect(createPr).toBeGreaterThan(buildGate);
  });

  it("implement-plan retargets the PR to the task base branch", () => {
    expect(skillBody("implement-plan")).toContain('--base "$BASE_BRANCH"');
  });

  it("investigate is action-capable and invokes ce-debug", () => {
    const body = skillBody("investigate");
    expect(body).toContain("action-capable");
    expect(body).toContain("ce-debug");
    expect(body).toContain("actual bug");
    expect(body).not.toContain("mode:pipeline ~/.ot/linear-context.md");
  });

  it("investigate keeps the decision gate and assumptions ledger", () => {
    const body = skillBody("investigate");
    expect(body).toContain("elicitation");
    expect(body).toContain("Assumptions & decisions");
  });

  it("investigate retargets the PR to the task base branch", () => {
    expect(skillBody("investigate")).toContain('--base "$BASE_BRANCH"');
  });

  it("both skills reference ot-activity and the resume-carries-feedback contract", () => {
    for (const task of tasks) {
      const body = skillBody(task);
      expect(body).toContain("ot-activity");
      expect(body).toContain("resume");
    }
  });

  it("both skills hand remote CI to the supervisor, reply on every feedback item, and keep a PR gate checklist", () => {
    for (const task of tasks) {
      const body = skillBody(task);
      // Remote CI is the supervisor's to watch: the run pushes and ends, and a
      // CI failure returns as a follow-up resume. The adapter takes a
      // non-blocking `gh pr checks` snapshot but never blocks in `--watch`.
      expect(body).toContain("gh pr checks");
      expect(body).not.toContain("--watch");
      expect(body).toContain("resume");
      // A visible, auditable gate checklist lives in the PR description.
      expect(body).toContain("## OpenThrottle gates");
      // Every feedback item gets a visible reply — not just non-actionable
      // ones — so it is always clear what was actioned.
      expect(body).toContain("EVERY item");
    }
  });

  it("each skill declares an openai.yaml with implicit invocation disabled", () => {
    for (const task of tasks) {
      const yaml = agentsYaml(task);
      expect(yaml).toContain("allow_implicit_invocation: false");
    }
  });

  it("deletes the old per-agent adapter variants", () => {
    expect(existsSync(resolve(skillsRoot, "claude"))).toBe(false);
    expect(existsSync(resolve(skillsRoot, "codex", "implement-plan.md"))).toBe(
      false,
    );
    expect(existsSync(resolve(skillsRoot, "codex", "review.md"))).toBe(false);
    expect(existsSync(resolve(skillsRoot, "codex", "review-fix.md"))).toBe(
      false,
    );
    expect(existsSync(resolve(skillsRoot, "codex", "investigate.md"))).toBe(
      false,
    );
    expect(existsSync(resolve(skillsRoot, "opencode"))).toBe(false);
  });

  it("keeps the Codex AGENTS fragment", () => {
    expect(existsSync(resolve(skillsRoot, "codex", "AGENTS-fragment.md"))).toBe(
      true,
    );
  });
});

// Guard against an accidental re-introduction of a path-segment separator
// bug in walk(); exercised implicitly above but kept explicit for clarity.
describe("walk() sanity", () => {
  it("finds files nested under skills/tasks", () => {
    const files = walk(skillsRoot).filter((f) => f.includes(`${sep}tasks${sep}`));
    expect(files.length).toBeGreaterThanOrEqual(4);
  });
});
