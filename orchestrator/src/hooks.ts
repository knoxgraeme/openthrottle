import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { sanitizeSecrets } from "./lib/sanitize.js";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

// ---------------------------------------------------------------------------
// PreToolUse: block-push-to-main (replaces hooks/block-push-to-main.sh)
// ---------------------------------------------------------------------------

const SECRET_VARS_PATTERN =
  /GITHUB_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|SUPABASE_ACCESS_TOKEN|TELEGRAM_BOT_TOKEN|OPENAI_API_KEY/;
const OUTBOUND_TOOLS_PATTERN =
  /\b(curl|wget|nc|ncat|netcat|python.*http|node.*http|fetch|gh\s+api)\b/;

export const guardHook: HookCallback = async (input) => {
  const command = (input as any).tool_input?.command ?? "";
  if (!command) return {};

  // Block pushes to main/master
  if (/git\s+push\b/.test(command) && /\b(main|master)\b/.test(command)) {
    return {
      decision: "block",
      reason:
        "Direct push to main/master is not allowed. Use: git push origin HEAD",
    };
  }

  // Block force push
  if (
    /git\s+push\b/.test(command) &&
    /(-f|--force|--force-with-lease)\b/.test(command)
  ) {
    return { decision: "block", reason: "Force push is not allowed." };
  }

  // Block git remote manipulation
  if (/git\s+remote\s+(add|set-url)\b/.test(command)) {
    return {
      decision: "block",
      reason: "Modifying git remotes is not allowed.",
    };
  }

  // Block git alias creation
  if (/git\s+config\s+.*alias\./.test(command)) {
    return {
      decision: "block",
      reason: "Creating git aliases is not allowed.",
    };
  }

  // Block settings.json tampering
  if (
    /(>|>>|tee|mv|cp|chmod|chattr|rm).*\.claude\/(settings|settings\.local)\.json/.test(
      command,
    )
  ) {
    return {
      decision: "block",
      reason: "Modifying Claude settings is not allowed.",
    };
  }

  // Block git hooks path changes
  if (/git\s+config.*(core\.hooksPath|hooks)/.test(command)) {
    return {
      decision: "block",
      reason: "Modifying git hooks configuration is not allowed.",
    };
  }

  // Secret exfiltration: outbound tool + secret env var reference
  if (OUTBOUND_TOOLS_PATTERN.test(command)) {
    if (
      /\$\(?/.test(command) &&
      SECRET_VARS_PATTERN.test(command)
    ) {
      return {
        decision: "block",
        reason:
          "Outbound commands cannot reference secret environment variables.",
      };
    }
  }

  // Block piping env to outbound commands
  if (/(env|printenv|set)\s*\|.*(curl|wget|nc|netcat|gh)/.test(command)) {
    return {
      decision: "block",
      reason: "Cannot pipe environment variables to outbound commands.",
    };
  }

  // Block .env piping to outbound
  if (/cat.*\.env.*\|.*(curl|wget|nc|gh)/.test(command)) {
    return {
      decision: "block",
      reason: "Cannot pipe .env contents to outbound commands.",
    };
  }

  // Block /proc/self/environ in outbound contexts
  if (/\/proc\/(self|1)\/environ/.test(command)) {
    if (OUTBOUND_TOOLS_PATTERN.test(command) || /\bbase64\b/.test(command)) {
      return {
        decision: "block",
        reason: "Cannot read /proc/environ in outbound command context.",
      };
    }
  }

  return {};
};

// ---------------------------------------------------------------------------
// PostToolUse: log-commands (replaces hooks/log-commands.sh)
// ---------------------------------------------------------------------------

export function createLogCommandsHook(
  logDir: string,
  taskId: string,
): HookCallback {
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "bash-commands.log");

  return async (input) => {
    const command = (input as any).tool_input?.command ?? "";
    const exitCode =
      (input as any).tool_response?.exit_code ?? "?";
    const sanitized = sanitizeSecrets(command);
    const timestamp = new Date().toISOString();
    appendFileSync(
      logPath,
      `[${timestamp}] [${taskId}] [exit:${exitCode}] ${sanitized}\n`,
    );
    return {};
  };
}

// ---------------------------------------------------------------------------
// PostToolUse: auto-format (replaces hooks/auto-format.sh)
// ---------------------------------------------------------------------------

export function createAutoFormatHook(repoDir: string): HookCallback {
  return async (input) => {
    const filePath: string =
      (input as any).tool_input?.file_path ?? "";
    if (!filePath) return {};

    const ext = extname(filePath).slice(1);
    try {
      switch (ext) {
        case "ts":
        case "tsx":
        case "js":
        case "jsx":
        case "mjs":
        case "cjs":
        case "json":
        case "css":
        case "scss":
        case "html":
        case "md":
        case "yaml":
        case "yml":
          try {
            execFileSync(
              join(repoDir, "node_modules/.bin/prettier"),
              ["--write", filePath, "--log-level", "silent"],
              { cwd: repoDir, timeout: 10_000 },
            );
          } catch {
            // prettier not available — skip
          }
          break;
        case "py":
          try {
            execFileSync("black", [filePath, "--quiet"], { timeout: 10_000 });
          } catch {
            try {
              execFileSync("ruff", ["format", filePath, "--quiet"], {
                timeout: 10_000,
              });
            } catch {
              // no formatter available
            }
          }
          break;
        case "go":
          try {
            execFileSync("gofmt", ["-w", filePath], { timeout: 10_000 });
          } catch {
            // gofmt not available
          }
          break;
        case "rb":
          try {
            execFileSync("rubocop", ["-a", filePath, "--no-color"], {
              timeout: 10_000,
            });
          } catch {
            // rubocop not available
          }
          break;
      }
    } catch {
      // Formatting is best-effort — never fail the hook
    }
    return {};
  };
}
