import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import type { TaskContext } from "../types.js";
import { invokeAgent } from "../agent.js";
import { buildPrompt } from "../lib/prompt.js";
import { log, notify } from "../lib/logger.js";
import {
  taskTransition,
  taskView,
  prEdit,
  prView,
} from "../lib/github.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf-8",
    timeout: 60_000,
  }).trim();
}

function buildVars(ctx: TaskContext, extra: Record<string, string> = {}): Record<string, string> {
  return {
    GITHUB_REPO: ctx.githubRepo,
    BASE_BRANCH: ctx.baseBranch,
    TEST_CMD: ctx.config.test,
    LINT_CMD: ctx.config.lint,
    BUILD_CMD: ctx.config.build,
    FORMAT_CMD: ctx.config.format,
    DEV_CMD: ctx.config.dev,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// review_pr — automated PR review
// ---------------------------------------------------------------------------
export async function reviewPr(ctx: TaskContext): Promise<void> {
  const prNumber = ctx.workItem;
  const maxRounds = ctx.config.review.max_rounds;

  // Count existing change-requested reviews
  let reviewCount = 0;
  try {
    reviewCount = parseInt(
      execFileSync(
        "gh",
        [
          "pr", "view", prNumber, "--repo", ctx.githubRepo,
          "--json", "reviews",
          "--jq", '[.reviews[] | select(.state == "CHANGES_REQUESTED")] | length',
        ],
        { encoding: "utf-8", timeout: 30_000 },
      ).trim() || "0",
      10,
    );
  } catch {
    // proceed with 0
  }

  // Auto-approve if max rounds hit
  if (reviewCount >= maxRounds) {
    log(`PR #${prNumber} hit max rounds (${maxRounds}). Auto-approving.`);
    prEdit(prNumber, { removeLabel: "needs-review" });
    try {
      execFileSync(
        "gh",
        [
          "pr", "review", prNumber, "--repo", ctx.githubRepo,
          "--approve", "--body",
          `Auto-approved after ${maxRounds} review rounds. Please review manually.`,
        ],
        { encoding: "utf-8", timeout: 30_000 },
      );
    } catch {
      log(`WARNING: Auto-approval failed for PR #${prNumber}`);
    }
    await notify(`PR #${prNumber} auto-approved after ${maxRounds} rounds.`);
    return;
  }

  const reviewRound = String(reviewCount + 1);

  prEdit(prNumber, { removeLabel: "needs-review", addLabel: "reviewing" });
  log(`Reviewing PR #${prNumber} (round ${reviewRound}/${maxRounds})`);
  await notify(`Reviewing PR #${prNumber} (round ${reviewRound})`);

  // Fetch PR metadata
  let prJson: any;
  try {
    prJson = JSON.parse(
      prView(prNumber, "--json", "body,title,headRefName,state"),
    );
  } catch {
    log(`FATAL: Could not fetch PR #${prNumber} from GitHub API`);
    await notify(`Review failed — could not fetch PR #${prNumber}`);
    return;
  }

  const prBody = prJson.body ?? "";
  const branchName = prJson.headRefName ?? "";
  if (!branchName) {
    log(`FATAL: PR #${prNumber} has no head branch`);
    return;
  }

  // Extract linked issue
  const linkedIssueMatch = prBody.match(
    /(fix(es)?|close[sd]?|resolve[sd]?)\s+#(\d+)/i,
  );
  const linkedIssue = linkedIssueMatch?.[3] ?? "";

  // Write original task to file
  const taskFile = `/tmp/review-task-${prNumber}.md`;
  if (linkedIssue) {
    try {
      const issueBody = taskView(linkedIssue, "--json", "body", "--jq", ".body");
      writeFileSync(taskFile, issueBody || "No linked issue content found.");
      log(`Found linked issue #${linkedIssue}`);
    } catch {
      writeFileSync(taskFile, "No linked issue content found.");
    }
  } else {
    writeFileSync(taskFile, "No linked issue found. Skip task alignment phase.");
  }

  // Write builder review notes to file
  const builderFile = `/tmp/review-builder-${prNumber}.md`;
  try {
    const builderReview = execFileSync(
      "gh",
      [
        "pr", "view", prNumber, "--repo", ctx.githubRepo,
        "--json", "comments",
        "--jq", '[.comments[] | select(.body | test("Decision Log|Review Notes|Session Report"; "i"))] | [.[].body] | join("\\n\\n---\\n\\n")',
      ],
      { encoding: "utf-8", timeout: 30_000 },
    ).trim();
    writeFileSync(builderFile, builderReview || "No builder review comments found.");
  } catch {
    writeFileSync(builderFile, "No builder review comments found.");
  }

  // Build re-review block
  let reReviewBlock = "";
  if (reviewCount > 0) {
    reReviewBlock = `### Re-review (round ${reviewRound})

This is a follow-up round. Focus on whether previous requested changes were addressed.

- Check if each prior blocking item was resolved
- **Approve if prior blockers are fixed**, even if you'd nitpick
- New non-blocking findings: note them but approve anyway
- Only request changes for regressions or genuinely missed P1+ issues
- Do NOT hold up the PR for P2/P3 items discovered on re-review`;
  }

  // Checkout PR branch
  try {
    git(ctx.repo, "fetch", "origin", branchName);
    git(ctx.repo, "checkout", branchName);
    git(ctx.repo, "pull", "origin", branchName);
  } catch (err) {
    log(`FATAL: Could not checkout branch '${branchName}' for PR #${prNumber}`);
    await notify(`Review failed — could not fetch branch for PR #${prNumber}`);
    return;
  }

  const prompt = buildPrompt(ctx.promptsDir, "review.md", buildVars(ctx, {
    PR_NUMBER: prNumber,
    BRANCH_NAME: branchName,
    REVIEW_ROUND: reviewRound,
    MAX_REVIEW_ROUNDS: String(maxRounds),
    TASK_FILE: taskFile,
    BUILDER_FILE: builderFile,
    RE_REVIEW_BLOCK: reReviewBlock,
  }));

  await invokeAgent({
    prompt,
    taskKey: `review-${prNumber}`,
    taskId: `review-${prNumber}`,
    ctx,
    timeoutMs: ctx.config.limits.task_timeout * 1000,
  });

  try { unlinkSync(taskFile); } catch { /* ignore */ }
  try { unlinkSync(builderFile); } catch { /* ignore */ }

  prEdit(prNumber, { removeLabel: "reviewing" });
  log(`Review complete for PR #${prNumber}`);
  await notify(`Review complete — PR #${prNumber}`);
}

// ---------------------------------------------------------------------------
// investigate_bug — read-only investigation, posts report as comment
// ---------------------------------------------------------------------------
export async function investigateBug(ctx: TaskContext): Promise<void> {
  const issueNumber = ctx.workItem;

  let issueJson: any;
  try {
    issueJson = JSON.parse(
      taskView(issueNumber, "--json", "title,body"),
    );
  } catch {
    log(`FATAL: Could not fetch issue #${issueNumber}`);
    await notify(`Investigation failed — could not fetch issue #${issueNumber}`);
    return;
  }

  const title = issueJson.title;
  taskTransition(issueNumber, "needs-investigation", "investigating");
  log(`Investigating issue #${issueNumber}: ${title}`);
  await notify(`Investigating: #${issueNumber} — ${title}`);

  try {
    git(ctx.repo, "pull", "origin", ctx.baseBranch);
  } catch {
    log(`WARNING: Could not pull latest ${ctx.baseBranch}`);
  }

  const prompt = buildPrompt(ctx.promptsDir, "investigation.md", buildVars(ctx, {
    ISSUE_NUMBER: issueNumber,
    TITLE: title,
  }));

  await invokeAgent({
    prompt,
    taskKey: `investigate-${issueNumber}`,
    taskId: `investigate-${issueNumber}`,
    ctx,
    timeoutMs: ctx.config.limits.task_timeout * 1000,
  });

  try {
    execFileSync(
      "gh",
      ["issue", "edit", issueNumber, "--repo", ctx.githubRepo, "--remove-label", "investigating"],
      { encoding: "utf-8", timeout: 30_000 },
    );
  } catch { /* ignore */ }

  log(`Investigation complete for issue #${issueNumber}`);
  await notify(`Investigation complete: #${issueNumber} — ${title}`);
}
