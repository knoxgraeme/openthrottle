#!/usr/bin/env bash
# sandbox-guard.sh
# PreToolUse hook — fires before every Bash command.
# Enforces safety guardrails for autonomous agent execution.
#
# IMPORTANT: This guard fails CLOSED — if input cannot be parsed,
# the command is DENIED. A security guard must never fail open.
#
# Blocks:
#   1. Pushes to main/master
#   2. Force pushes to any branch
#   3. Settings.json / git config tampering
#   4. Git remote manipulation (prevents push to attacker-controlled remotes)
#   5. Secret exfiltration via curl/wget/nc/gh api (env var references in outbound calls)
#   6. /proc/self/environ reads in outbound contexts
#   7. Direct reads of .env files in outbound contexts

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""') || {
  echo "BLOCKED: Could not parse hook input — denying command for safety." >&2
  exit 2
}

if [[ -z "$COMMAND" ]]; then
  echo "BLOCKED: Empty command in hook input — denying for safety." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Git safety
# ---------------------------------------------------------------------------

# Block pushes to main/master via any syntax (including refspec HEAD:main)
if echo "$COMMAND" | grep -qE 'git\s+push\b.*\b(main|master)\b'; then
  echo "BLOCKED: Direct push to main/master is not allowed in the pipeline." >&2
  echo "Use: git push origin HEAD  (pushes the current feature branch)" >&2
  exit 2
fi

# Block force push to any branch — match flags anywhere in command
if echo "$COMMAND" | grep -qE 'git\s+push\b' && echo "$COMMAND" | grep -qE '(-f|--force|--force-with-lease)\b'; then
  echo "BLOCKED: Force push is not allowed in the pipeline." >&2
  exit 2
fi

# Block git remote manipulation (prevents adding attacker-controlled remotes)
if echo "$COMMAND" | grep -qE 'git\s+remote\s+(add|set-url)\b'; then
  echo "BLOCKED: Modifying git remotes is not allowed in the pipeline." >&2
  exit 2
fi

# Block git alias creation (prevents aliasing blocked commands)
if echo "$COMMAND" | grep -qE 'git\s+config\s+.*alias\.'; then
  echo "BLOCKED: Creating git aliases is not allowed in the pipeline." >&2
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
SECRET_VARS='GITHUB_TOKEN|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|SUPABASE_ACCESS_TOKEN|TELEGRAM_BOT_TOKEN|OPENAI_API_KEY'
OUTBOUND_TOOLS='curl|wget|nc|ncat|netcat|python.*http|node.*http|fetch|gh\s+api'

# Check if command uses an outbound tool AND references a secret env var
if echo "$COMMAND" | grep -qE "(${OUTBOUND_TOOLS})\b"; then
  if echo "$COMMAND" | grep -qE "\\\$(${SECRET_VARS})|\\$\{(${SECRET_VARS})"; then
    echo "BLOCKED: Outbound commands cannot reference secret environment variables." >&2
    exit 2
  fi
fi

# Block piping env/printenv/set output to outbound commands
if echo "$COMMAND" | grep -qE '(env|printenv|set)\s*\|.*(curl|wget|nc|netcat|gh)'; then
  echo "BLOCKED: Cannot pipe environment variables to outbound commands." >&2
  exit 2
fi

# Block specific printenv calls for known secrets piped to outbound commands
if echo "$COMMAND" | grep -qE "printenv\s+(${SECRET_VARS})"; then
  if echo "$COMMAND" | grep -qE "(${OUTBOUND_TOOLS})\b"; then
    echo "BLOCKED: Cannot read secret env vars in outbound command context." >&2
    exit 2
  fi
fi

# Block reading .env files and piping to outbound commands
if echo "$COMMAND" | grep -qE 'cat.*\.env.*\|.*(curl|wget|nc|gh)'; then
  echo "BLOCKED: Cannot pipe .env contents to outbound commands." >&2
  exit 2
fi

# Block /proc/self/environ reads in outbound contexts
if echo "$COMMAND" | grep -qE '/proc/(self|1)/environ'; then
  if echo "$COMMAND" | grep -qE "(${OUTBOUND_TOOLS}|base64)\b"; then
    echo "BLOCKED: Cannot read /proc/environ in outbound command context." >&2
    exit 2
  fi
fi

exit 0
