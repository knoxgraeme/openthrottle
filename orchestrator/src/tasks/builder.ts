import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import type { TaskContext } from "../types.js";
import { invokeAgent } from "../agent.js";
import { buildPrompt } from "../lib/prompt.js";
import { log, notify } from "../lib/logger.js";
import { postSessionReport } from "../lib/report.js";
import {
  taskTransition,
  taskClose,
  taskComment,
  taskView,
  taskReadComments,
  prList,
  prEdit,
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

function buildSupabaseBlock(ctx: TaskContext, taskId: string): string {
  if (!ctx.supabaseAccessToken) return "";
  return `---

## Supabase Branching

A Supabase MCP is available for isolated DB work.

- **Create lazily** — write code first, only create \`openthrottle-\${TASK_ID}\`
  when you need to test against a real DB.
- **Delete eagerly** — delete immediately after tests pass.
- **Orphan cleanup** — at session start, list and delete any \`openthrottle-*\`
  branches left from crashed sessions.
- **No migrations** — write migration files for the PR. Don't run them.`;
}

// ---------------------------------------------------------------------------
// handle_prd — new feature implementation
// ---------------------------------------------------------------------------
export async function handlePrd(ctx: TaskContext): Promise<void> {
  const issueNumber = ctx.workItem;
  const taskId = `prd-${issueNumber}`;
  const startEpoch = Date.now();

  let issueJson: any;
  try {
    issueJson = JSON.parse(
      taskView(issueNumber, "--json", "title,body,labels"),
    );
  } catch {
    log(`FATAL: Could not fetch issue #${issueNumber}`);
    await notify(`PRD failed — could not fetch issue #${issueNumber}`);
    return;
  }

  const title = issueJson.title;
  const body = issueJson.body ?? "";

  // Detect base branch from label (base:branchname)
  const issueBase =
    issueJson.labels
      ?.find((l: any) => l.name?.startsWith("base:"))
      ?.name?.slice(5) ?? ctx.baseBranch;

  log(`Starting PRD #${issueNumber}: ${title} (base: ${issueBase})`);
  await notify(`PRD started: #${issueNumber} — ${title} (base: ${issueBase})`);
  taskTransition(issueNumber, "prd-queued", "prd-running");

  // Git setup
  git(ctx.repo, "fetch", "origin", issueBase);
  git(ctx.repo, "checkout", issueBase);
  git(ctx.repo, "pull", "origin", issueBase);
  const branchName = `feat/${taskId}`;
  git(ctx.repo, "checkout", "-b", branchName);
  log(`Created branch ${branchName} from ${issueBase}`);

  // Write untrusted content to file
  const taskFile = `/tmp/task-${taskId}.md`;
  writeFileSync(taskFile, body);

  const prompt = buildPrompt(ctx.promptsDir, "prd.md", buildVars(ctx, {
    ISSUE_NUMBER: issueNumber,
    TITLE: title,
    BRANCH_NAME: branchName,
    TASK_FILE: taskFile,
    TASK_ID: taskId,
    SUPABASE_BLOCK: buildSupabaseBlock(ctx, taskId),
    INVESTIGATION_BLOCK: "",
  }));

  const result = await invokeAgent({
    prompt,
    taskKey: taskId,
    taskId,
    ctx: { ...ctx, baseBranch: issueBase },
    timeoutMs: ctx.config.limits.task_timeout * 1000,
  });

  try { unlinkSync(taskFile); } catch { /* ignore */ }

  // Check if a PR was created
  const prUrl = prList(branchName, "--json", "url", "--jq", ".[0].url");
  const durationMinutes = Math.floor((Date.now() - startEpoch) / 60_000);

  if (prUrl) {
    taskComment(issueNumber, `PR created: ${prUrl}`);
    taskClose(issueNumber);
    taskTransition(issueNumber, "prd-running", "prd-complete");

    const prNum = prUrl.match(/\d+$/)?.[0] ?? "";
    if (prNum) {
      prEdit(prNum, { addLabel: "needs-review" });
      postSessionReport(ctx, prNum, taskId, durationMinutes, result);
    }
  } else {
    taskTransition(issueNumber, "prd-running", "prd-failed");
    await notify(`PRD #${issueNumber} finished without creating a PR`);
  }

  log(`PRD #${issueNumber} complete in ${durationMinutes}m`);
  await notify(
    `PRD complete: #${issueNumber} — ${title} (${durationMinutes}m)${prUrl ? `\nPR: ${prUrl}` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// handle_bug — bug fix
// ---------------------------------------------------------------------------
export async function handleBug(ctx: TaskContext): Promise<void> {
  const issueNumber = ctx.workItem;
  const taskId = `bug-${issueNumber}`;
  const startEpoch = Date.now();

  let issueJson: any;
  try {
    issueJson = JSON.parse(
      taskView(issueNumber, "--json", "title,body,labels"),
    );
  } catch {
    log(`FATAL: Could not fetch issue #${issueNumber}`);
    await notify(`Bug fix failed — could not fetch issue #${issueNumber}`);
    return;
  }

  const title = issueJson.title;
  const body = issueJson.body ?? "";

  const issueBase =
    issueJson.labels
      ?.find((l: any) => l.name?.startsWith("base:"))
      ?.name?.slice(5) ?? ctx.baseBranch;

  log(`Starting bug fix #${issueNumber}: ${title} (base: ${issueBase})`);
  await notify(`Bug fix started: #${issueNumber} — ${title}`);
  taskTransition(issueNumber, "bug-queued", "bug-running");

  // Check for investigation report
  const investigation = taskReadComments(issueNumber, "## Investigation Report");
  let investigationBlock = "";
  if (investigation && investigation !== "null") {
    const investigationFile = `/tmp/investigation-${issueNumber}.md`;
    writeFileSync(investigationFile, investigation);
    investigationBlock = `### Investigation Report

An investigation report is available from a prior analysis session. Read it
before starting — it already traced the root cause. Re-investigating wastes
a full session.

Read the report at \`${investigationFile}\`.`;
  }

  // Git setup
  git(ctx.repo, "fetch", "origin", issueBase);
  git(ctx.repo, "checkout", issueBase);
  git(ctx.repo, "pull", "origin", issueBase);
  const branchName = `fix/${issueNumber}`;
  git(ctx.repo, "checkout", "-b", branchName);
  log(`Created branch ${branchName} from ${issueBase}`);

  const taskFile = `/tmp/task-${taskId}.md`;
  writeFileSync(taskFile, body);

  const bugTimeout = Math.floor(ctx.config.limits.task_timeout / 2);
  const prompt = buildPrompt(ctx.promptsDir, "bug.md", buildVars(ctx, {
    ISSUE_NUMBER: issueNumber,
    TITLE: title,
    BRANCH_NAME: branchName,
    TASK_FILE: taskFile,
    TASK_ID: taskId,
    INVESTIGATION_BLOCK: investigationBlock,
    SUPABASE_BLOCK: buildSupabaseBlock(ctx, taskId),
  }));

  const result = await invokeAgent({
    prompt,
    taskKey: taskId,
    taskId,
    ctx: { ...ctx, baseBranch: issueBase },
    timeoutMs: bugTimeout * 1000,
  });

  try { unlinkSync(taskFile); } catch { /* ignore */ }
  try { unlinkSync(`/tmp/investigation-${issueNumber}.md`); } catch { /* ignore */ }

  const prUrl = prList(branchName, "--json", "url", "--jq", ".[0].url");
  const durationMinutes = Math.floor((Date.now() - startEpoch) / 60_000);

  if (prUrl) {
    taskTransition(issueNumber, "bug-running", "bug-complete");
    const prNum = prUrl.match(/\d+$/)?.[0] ?? "";
    if (prNum) {
      prEdit(prNum, { addLabel: "needs-review" });
      postSessionReport(ctx, prNum, taskId, durationMinutes, result);
    }
  } else {
    taskTransition(issueNumber, "bug-running", "bug-failed");
    await notify(`Bug fix #${issueNumber} finished without creating a PR`);
  }

  log(`Bug fix #${issueNumber} complete in ${durationMinutes}m`);
  await notify(
    `Bug fix complete: #${issueNumber} — ${title} (${durationMinutes}m)${prUrl ? `\nPR: ${prUrl}` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// handle_fixes — apply review changes to existing PR
// ---------------------------------------------------------------------------
export async function handleFixes(ctx: TaskContext): Promise<void> {
  const prNumber = ctx.workItem;
  const startEpoch = Date.now();

  let branchName: string;
  try {
    // gh --jq returns a plain string, not JSON-quoted
    branchName = execFileSync(
      "gh",
      ["pr", "view", prNumber, "--repo", ctx.githubRepo, "--json", "headRefName", "--jq", ".headRefName"],
      { encoding: "utf-8", timeout: 30_000 },
    ).trim();
  } catch {
    log(`FATAL: Could not fetch PR #${prNumber} metadata`);
    await notify(`Fix failed — could not fetch PR #${prNumber}`);
    return;
  }

  log(`Fixing PR #${prNumber} on branch ${branchName}`);
  await notify(`Fixing review items — PR #${prNumber} (${branchName})`);

  // Get latest review with changes_requested
  let review = "";
  try {
    review = execFileSync(
      "gh",
      [
        "pr", "view", prNumber, "--repo", ctx.githubRepo,
        "--json", "reviews",
        "--jq", '[.reviews[] | select(.state == "CHANGES_REQUESTED")] | last | .body',
      ],
      { encoding: "utf-8", timeout: 30_000 },
    ).trim();
  } catch {
    // proceed with empty review
  }

  git(ctx.repo, "fetch", "origin", branchName);
  git(ctx.repo, "checkout", branchName);
  git(ctx.repo, "pull", "origin", branchName);

  const headBefore = git(ctx.repo, "rev-parse", "HEAD");

  const taskFile = `/tmp/task-fix-${prNumber}.md`;
  writeFileSync(taskFile, review);

  const fixTimeout = Math.floor(ctx.config.limits.task_timeout / 4);
  const prompt = buildPrompt(ctx.promptsDir, "review-fix.md", buildVars(ctx, {
    PR_NUMBER: prNumber,
    BRANCH_NAME: branchName,
    TASK_FILE: taskFile,
  }));

  const result = await invokeAgent({
    prompt,
    taskKey: `fix-${prNumber}`,
    taskId: `fix-${prNumber}`,
    ctx,
    timeoutMs: fixTimeout * 1000,
  });

  try { unlinkSync(taskFile); } catch { /* ignore */ }

  // Only re-request review if new commits were pushed
  let headAfter: string;
  try {
    headAfter = git(ctx.repo, "rev-parse", "HEAD");
  } catch {
    headAfter = headBefore;
  }

  if (headAfter !== headBefore) {
    if (!prEdit(prNumber, { addLabel: "needs-review" })) {
      log(`WARNING: Failed to add 'needs-review' label to PR #${prNumber}`);
    }
  } else {
    log("No new commits pushed — skipping re-review label");
    try {
      execFileSync(
        "gh",
        ["pr", "comment", prNumber, "--repo", ctx.githubRepo, "--body",
          "Fix attempt completed but no new commits were pushed. Manual intervention may be needed."],
        { encoding: "utf-8", timeout: 30_000 },
      );
    } catch { /* ignore */ }
    await notify(`Fix attempt for PR #${prNumber} produced no new commits — manual review needed`);
  }

  const durationMinutes = Math.floor((Date.now() - startEpoch) / 60_000);
  log(`Fixes applied to PR #${prNumber} in ${durationMinutes}m`);
  await notify(`Fixes applied — PR #${prNumber} (${durationMinutes}m)`);
  postSessionReport(ctx, prNumber, `fix-${prNumber}`, durationMinutes, result);
}
