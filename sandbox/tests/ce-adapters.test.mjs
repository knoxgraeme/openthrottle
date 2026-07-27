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
  it("has no task registry or direct task scheduler", () => {
    expect(existsSync(resolve(skillsRoot, "task-adapters-v1.json"))).toBe(false);
    const runtime = readFileSync(resolve(repoRoot, "sandbox/lib/runtime.sh"), "utf8");
    const entrypoint = readFileSync(resolve(repoRoot, "sandbox/entrypoint.sh"), "utf8");
    expect(`${runtime}\n${entrypoint}`).not.toMatch(
      /task_adapter_value|task-adapters-v1|RUN_CALLBACK_TOKEN|RESUME_MESSAGE/
    );
    expect(existsSync(resolve(repoRoot, "supervisor/src/scheduler.ts"))).toBe(false);
  });

  it("keeps CE v2 execution policies aligned with installed stage contracts", () => {
    const implement = readFileSync(resolve(repoRoot, "supervisor/pipelines/ce-implement-v2.yaml"), "utf8");
    const investigate = readFileSync(resolve(repoRoot, "supervisor/pipelines/ce-investigate-v2.yaml"), "utf8");
    expect(implement).toMatch(
      /id: planning[\s\S]*?executor: \{ kind: agent, capability: ce\/plan@1 \}[\s\S]*?context: fresh_review/
    );
    expect(implement).toMatch(
      /id: implementation[\s\S]*?credentials: \[model\.invoke, provider\.read, repo\.read, repo\.write\]/
    );
    expect(investigate).toMatch(
      /id: investigate[\s\S]*?credentials: \[model\.invoke, repo\.read, repo\.write, provider\.read\]/
    );
  });

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

  it("names the pinned ce-simplify-code skill, never the nonexistent ce-simplify (finding #2)", () => {
    // The conditional simplification stage must name the CE skill that is
    // actually installed in the snapshot: `ce-simplify-code`. A bare
    // `ce-simplify` resolves to nothing, so the stage silently no-ops.
    expect(allSkillsText()).not.toMatch(/ce-simplify(?!-code)/);
    expect(skillBody("implement-plan")).toContain("ce-simplify-code");
  });

  it("keeps the repo-root guidance docs free of the nonexistent ce-simplify (finding #2)", () => {
    // The CE pipeline composition is also spelled out in the repo-root agent
    // guidance (AGENTS.md, imported by CLAUDE.md). The skills-tree scan above
    // does not cover those, so guard them explicitly — a bare `ce-simplify`
    // there is the same silent-no-op regression, just outside skills/.
    for (const rel of ["AGENTS.md", "CLAUDE.md"]) {
      const p = resolve(repoRoot, rel);
      if (!existsSync(p)) continue;
      expect(readFileSync(p, "utf8")).not.toMatch(/ce-simplify(?!-code)/);
    }
  });

  it("references only compound-engineering skills that the pinned plugin ships (finding #2)", () => {
    // Every `ce-*` token the adapters compose must resolve to a real skill in
    // the installed CE plugin. This catches renamed/removed/typo'd skill names
    // (e.g. the historical `ce-simplify` → `ce-simplify-code` drift) in source
    // before the snapshot build. Snapshot-level resolution against the built
    // image remains a separate infra-gated check (audit findings #2, #20).
    const CE_PLUGIN_SKILLS = new Set([
      "ce-brainstorm",
      "ce-code-review",
      "ce-commit",
      "ce-commit-push-pr",
      "ce-compound",
      "ce-compound-refresh",
      "ce-debug",
      "ce-doc-review",
      "ce-ideate",
      "ce-optimize",
      "ce-plan",
      "ce-proof",
      "ce-resolve-pr-feedback",
      "ce-riffrec-feedback-analysis",
      "ce-simplify-code",
      "ce-strategy",
      "ce-test-browser",
      "ce-work",
      "ce-worktree",
    ]);
    const referenced = new Set(
      [...allSkillsText().matchAll(/\bce-[a-z][a-z-]*[a-z]\b/g)].map(
        (m) => m[0],
      ),
    );
    const unknown = [...referenced].filter((s) => !CE_PLUGIN_SKILLS.has(s));
    expect(unknown).toEqual([]);
  });

  it("implement-plan keeps the plan gate, decision gate, and assumptions ledger", () => {
    const body = skillBody("implement-plan");
    expect(body).toContain("Missing or materially ambiguous acceptance criteria");
    expect(body).toContain("needs_human");
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

  it("documents every CE manifest stage and the sealed command/provider boundaries", () => {
    const body = skillBody("implement-plan");
    for (const stage of ["planning", "implementation", "semantic_review", "simplification", "post_simplify_review", "publish"]) {
      expect(body).toContain(stage);
    }
    expect(body).toMatch(/separate sealed command\s+stages/);
    expect(body).toContain("supervisor-owned stage");
  });

  it("keeps configured commands and provider evidence outside agent stages", () => {
    const body = skillBody("implement-plan");
    expect(body).toMatch(/`test`, `lint`, and `build` commands are separate sealed command\s+stages/);
    expect(body).toContain("Provider evidence is a supervisor-owned stage");
    expect(body).not.toContain("$OT_TEST_CMD");
  });

  it("implement-plan retargets the PR to the task base branch", () => {
    expect(skillBody("implement-plan")).toContain("targets `$BASE_BRANCH`");
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
    expect(body).toContain("needs_human");
    expect(body).toContain("Assumptions & decisions");
  });

  it("investigate retargets the PR to the task base branch", () => {
    expect(skillBody("investigate")).toContain("targets `$BASE_BRANCH`");
  });

  it("both skills reference activity and remain single-stage adapters", () => {
    for (const task of tasks) {
      const body = skillBody(task);
      expect(body).toContain("ot-activity");
      expect(body).toContain("Execute only");
      expect(body).not.toContain("follow-up `resume`");
    }
  });

  it("both skills leave remote CI to the provider stage and keep a PR gate checklist", () => {
    for (const task of tasks) {
      const body = skillBody(task);
      expect(body).toContain("Do not poll or wait");
      expect(body).not.toContain("--watch");
      expect(body).toContain("## OpenThrottle gates");
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
