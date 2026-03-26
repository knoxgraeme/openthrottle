import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TaskContext, TaskType } from "./types.js";
import { loadConfig } from "./lib/config.js";
import { initLogger, log, notify } from "./lib/logger.js";
import { handlePrd, handleBug, handleFixes } from "./tasks/builder.js";
import { reviewPr, investigateBug } from "./tasks/reviewer.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`FATAL: ${name} is required`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const sandboxHome = process.env.SANDBOX_HOME ?? "/home/daytona";
  const repo = process.env.REPO ?? join(sandboxHome, "repo");
  const logDir = join(sandboxHome, ".claude/logs");
  const sessionsDir = join(sandboxHome, ".claude/sessions");
  const promptsDir = process.env.PROMPTS_DIR ?? "/opt/openthrottle/prompts";

  const taskType = requireEnv("TASK_TYPE") as TaskType;
  const workItem = requireEnv("WORK_ITEM");
  const githubRepo = requireEnv("GITHUB_REPO");
  const githubToken = requireEnv("GITHUB_TOKEN");

  mkdirSync(logDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  // Determine runner name from task type
  const runnerName =
    taskType === "review" || taskType === "investigation"
      ? "reviewer"
      : "builder";

  initLogger(logDir, runnerName);

  // Load config
  const configPath = join(repo, ".openthrottle.yml");
  const config = loadConfig(configPath);

  const ctx: TaskContext = {
    githubRepo,
    githubToken,
    taskType,
    workItem,
    fromPr: process.env.FROM_PR ?? "",
    sandboxHome,
    repo,
    logDir,
    sessionsDir,
    promptsDir,
    baseBranch: process.env.BASE_BRANCH ?? config.base_branch,
    config,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",
    supabaseAccessToken: process.env.SUPABASE_ACCESS_TOKEN ?? "",
  };

  log(
    `Orchestrator starting (task: ${taskType} #${workItem}, sdk: agent-sdk)`,
  );
  await notify(`Orchestrator online: ${taskType} #${workItem} (agent-sdk)`);

  // Prune session files older than 7 days
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("find", [sessionsDir, "-name", "*.id", "-mtime", "+7", "-delete"], {
      timeout: 10_000,
    });
  } catch {
    // ignore
  }

  // Dispatch task
  try {
    switch (taskType) {
      case "prd":
        await handlePrd(ctx);
        break;
      case "bug":
        await handleBug(ctx);
        break;
      case "review-fix":
        await handleFixes(ctx);
        break;
      case "review":
        await reviewPr(ctx);
        break;
      case "investigation":
        await investigateBug(ctx);
        break;
      default:
        log(`Unknown task type: ${taskType}`);
        process.exit(1);
    }
  } catch (err: any) {
    log(`FATAL: Unhandled error — ${err?.message ?? err}`);
    await notify(`Orchestrator failed: ${taskType} #${workItem} — ${err?.message ?? err}`);

    // Attempt to transition back to failed state
    try {
      const { taskTransition } = await import("./lib/github.js");
      switch (taskType) {
        case "prd":
          taskTransition(workItem, "prd-running", "prd-failed");
          break;
        case "bug":
          taskTransition(workItem, "bug-running", "bug-failed");
          break;
      }
    } catch {
      // ignore
    }

    process.exit(1);
  }

  log("Orchestrator finished");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
