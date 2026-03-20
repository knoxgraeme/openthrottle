#!/usr/bin/env bash
# sandbox-guard.sh
# PreToolUse hook — fires before every Bash command.
# Enforces safety guardrails for autonomous agent execution.
#
# Blocks:
#   1. Pushes to main/master
#   2. Force pushes to any branch
#   3. Settings.json / git config tampering
#   4. Secret exfiltration via curl/wget/nc (env var references in outbound calls)
#   5. Direct reads of .env files in outbound contexts

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# ---------------------------------------------------------------------------
# Git safety
# ---------------------------------------------------------------------------

# Block pushes to main/master via any syntax
if echo "$COMMAND" | grep -qE 'git\s+push\b.*\b(main|master)\b'; then
  echo "BLOCKED: Direct push to main/master is not allowed in the pipeline." >&2
  echo "Use: git push origin HEAD  (pushes the current feature branch)" >&2
  exit 2
fi

# Block force push to any branch (could rewrite history)
if echo "$COMMAND" | grep -qE 'git\s+push\s+(-f|--force|--force-with-lease)'; then
  echo "BLOCKED: Force push is not allowed in the pipeline." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Settings / config tampering
# ---------------------------------------------------------------------------

# Block writes to settings.json (hooks, permissions, allowlists)
if echo "$COMMAND" | grep -qE '(>|>>|tee|mv|cp|chmod|chattr|rm).*\.claude/(settings|settings\.local)\.json'; then
  echo "BLOCKED: Modifying Claude settings is not allowed in the pipeline." >&2
  exit 2
fi

# Block git hooks path changes
if echo "$COMMAND" | grep -qE 'git\s+config.*(core\.hooksPath|hooks)'; then
  echo "BLOCKED: Modifying git hooks configuration is not allowed." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Secret exfiltration prevention
# ---------------------------------------------------------------------------
# Block outbound commands (curl, wget, nc, etc.) that reference secret env vars.
# This catches prompt injection attacks that try to exfiltrate credentials.
# Legitimate API calls (gh, npm) don't reference these vars directly.

SECRET_VARS='GITHUB_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|SUPABASE_ACCESS_TOKEN|TELEGRAM_BOT_TOKEN'

# Check if command uses an outbound tool AND references a secret env var
if echo "$COMMAND" | grep -qE '(curl|wget|nc|ncat|netcat|python.*http|node.*http|fetch)\b'; then
  if echo "$COMMAND" | grep -qE "\\\$(${SECRET_VARS})|\\$\{(${SECRET_VARS})"; then
    echo "BLOCKED: Outbound commands cannot reference secret environment variables." >&2
    exit 2
  fi
fi

# Block piping env/printenv/set output to outbound commands
if echo "$COMMAND" | grep -qE '(env|printenv|set)\s*\|.*(curl|wget|nc|netcat)'; then
  echo "BLOCKED: Cannot pipe environment variables to outbound commands." >&2
  exit 2
fi

# Block reading .env files and piping to outbound commands
if echo "$COMMAND" | grep -qE 'cat.*\.env.*\|.*(curl|wget|nc|gh)'; then
  echo "BLOCKED: Cannot pipe .env contents to outbound commands." >&2
  exit 2
fi

exit 0
