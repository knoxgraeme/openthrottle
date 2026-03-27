import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentResult, TaskContext } from "../types.js";
import { sanitizeSecrets } from "./sanitize.js";
import { prComment } from "./github.js";
import { log } from "./logger.js";

export function postSessionReport(
  ctx: TaskContext,
  prNum: string,
  taskId: string,
  durationMinutes: number,
  result: AgentResult,
): void {
  let commitCount = "0";
  let filesChanged = "0";
  try {
    commitCount = execFileSync(
      "git",
      ["-C", ctx.repo, "rev-list", "--count", `${ctx.baseBranch}..HEAD`],
      { encoding: "utf-8" },
    ).trim();
  } catch {
    // ignore
  }
  try {
    const diff = execFileSync(
      "git",
      ["-C", ctx.repo, "diff", "--name-only", `${ctx.baseBranch}..HEAD`],
      { encoding: "utf-8" },
    );
    filesChanged = String(diff.split("\n").filter(Boolean).length);
  } catch {
    // ignore
  }

  // Count bash commands from log
  const bashLogPath = join(ctx.logDir, "bash-commands.log");
  let cmdTotal = 0;
  let cmdFailed = 0;
  try {
    const bashLog = readFileSync(bashLogPath, "utf-8");
    const lines = bashLog.split("\n").filter((l) => l.includes(`[${taskId}]`));
    cmdTotal = lines.length;
    cmdFailed = lines.filter((l) => !l.includes("[exit:0]")).length;
  } catch {
    // ignore
  }

  const sessionMarker = result.sessionId
    ? `\n<!-- session-id: ${result.sessionId} -->`
    : "";

  // Log tail — use result text from SDK
  const logTail = sanitizeSecrets(
    (result.resultText || "(no output)").slice(-3000),
  );

  const body = `## Session Report
${sessionMarker}

| Metric | Value |
|---|---|
| Duration | ${durationMinutes}m |
| API duration | ${result.durationApiMs ?? "n/a"}ms |
| Cost | $${result.costUsd ?? "n/a"} |
| Tokens | ${result.inputTokens ?? "n/a"} in / ${result.outputTokens ?? "n/a"} out |
| Turns | ${result.numTurns ?? "n/a"} |
| Commits | ${commitCount} |
| Files changed | ${filesChanged} |
| Bash commands | ${cmdTotal} total, ${cmdFailed} failed |

<details>
<summary>Agent output (last ~3000 chars)</summary>

\`\`\`
${logTail}
\`\`\`

</details>`;

  prComment(prNum, body);
  log(`Session report posted to PR #${prNum}`);
}
