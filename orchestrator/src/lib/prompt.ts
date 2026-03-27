import { readFileSync } from "node:fs";
import { join } from "node:path";

// Only expand known variable names — matches the EXPAND_VARS allowlist in run-builder.sh.
// Prevents accidental expansion of ${} in code examples within prompt templates.
const ALLOWED_VARS = new Set([
  "GITHUB_REPO",
  "ISSUE_NUMBER",
  "PR_NUMBER",
  "TITLE",
  "BRANCH_NAME",
  "BASE_BRANCH",
  "TASK_FILE",
  "BUILDER_FILE",
  "TASK_ID",
  "INVESTIGATION_BLOCK",
  "SUPABASE_BLOCK",
  "TEST_CMD",
  "LINT_CMD",
  "BUILD_CMD",
  "FORMAT_CMD",
  "DEV_CMD",
  "REVIEW_ROUND",
  "MAX_REVIEW_ROUNDS",
  "RE_REVIEW_BLOCK",
]);

export function buildPrompt(
  promptsDir: string,
  templateName: string,
  vars: Record<string, string>,
): string {
  const raw = readFileSync(join(promptsDir, templateName), "utf-8");
  return raw.replace(/\$\{(\w+)\}|\$(\w+)/g, (match, braced, bare) => {
    const name = braced ?? bare;
    if (ALLOWED_VARS.has(name) && name in vars) {
      return vars[name];
    }
    return match;
  });
}
