#!/usr/bin/env bash
# log-commands.sh
# PostToolUse hook — fires after every Bash command.
# Appends a timestamped log of every command the agent ran.
# Sanitizes known secrets to prevent accidental leakage.
#
# Logs go to the Daytona volume at ~/.claude/logs/ so they persist
# across ephemeral sandboxes for debugging and audit.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
EXIT_CODE=$(echo "$INPUT" | jq -r '.tool_response.exit_code // "?"')
PRD_ID="${PRD_ID:-unknown}"

SANDBOX_HOME="${SANDBOX_HOME:-/home/daytona}"
mkdir -p "${SANDBOX_HOME}/.claude/logs"

# Sanitize secrets before logging — redact known env vars and common patterns
SANITIZED="$COMMAND"
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  SANITIZED="${SANITIZED//$GITHUB_TOKEN/[REDACTED]}"
fi
if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  SANITIZED="${SANITIZED//$TELEGRAM_BOT_TOKEN/[REDACTED]}"
fi
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  SANITIZED="${SANITIZED//$ANTHROPIC_API_KEY/[REDACTED]}"
fi
if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  SANITIZED="${SANITIZED//$CLAUDE_CODE_OAUTH_TOKEN/[REDACTED]}"
fi
if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  SANITIZED="${SANITIZED//$SUPABASE_ACCESS_TOKEN/[REDACTED]}"
fi
if [[ -n "${OPENAI_API_KEY:-}" ]]; then
  SANITIZED="${SANITIZED//$OPENAI_API_KEY/[REDACTED]}"
fi
# Catch common token patterns that might not be in env vars
SANITIZED=$(echo "$SANITIZED" | sed \
  -e 's/ghp_[A-Za-z0-9_]\{36,\}/[REDACTED]/g' \
  -e 's/ghs_[A-Za-z0-9_]\{36,\}/[REDACTED]/g' \
  -e 's/Bearer [^ ]*/Bearer [REDACTED]/g' \
  -e 's/sk-[A-Za-z0-9_-]\{20,\}/[REDACTED]/g')

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [${PRD_ID}] [exit:${EXIT_CODE}] ${SANITIZED}" \
  >> "${SANDBOX_HOME}/.claude/logs/bash-commands.log"

exit 0
