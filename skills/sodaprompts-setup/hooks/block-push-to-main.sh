#!/usr/bin/env bash
# block-push-to-main.sh
# PreToolUse hook — fires before every Bash command.
# Blocks any git push that targets main or master directly.
# The pipeline should only ever push to feature branches.
#
# Also blocks attempts to tamper with hooks, settings, or git config
# that could weaken safety.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Block pushes to main/master via any syntax:
#   git push origin main
#   git push origin HEAD:main
#   git push origin HEAD:refs/heads/main
#   git push origin abc123:main
#   git push --force origin main
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

# Block attempts to tamper with settings.json (hooks, permissions, allowlists)
if echo "$COMMAND" | grep -qE '(>|>>|tee|mv|cp|chmod|chattr|rm).*\.claude/(settings|settings\.local)\.json'; then
  echo "BLOCKED: Modifying Claude settings is not allowed in the pipeline." >&2
  exit 2
fi

# Block attempts to change git hooks path (could bypass block-push-to-main)
if echo "$COMMAND" | grep -qE 'git\s+config.*(core\.hooksPath|hooks)'; then
  echo "BLOCKED: Modifying git hooks configuration is not allowed." >&2
  exit 2
fi

exit 0
