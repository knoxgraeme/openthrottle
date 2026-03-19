#!/usr/bin/env bash
# block-push-to-main.sh
# PreToolUse hook — fires before every Bash command.
# Blocks any git push that targets main or master directly.
# The pipeline should only ever push to feature branches.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

if echo "$COMMAND" | grep -qE 'git push.*(origin\s+(main|master)|origin\s+HEAD:(refs/heads/)?(main|master)|origin\s+[^ ]+:(refs/heads/)?(main|master))'; then
  echo "BLOCKED: Direct push to main/master is not allowed in the pipeline." >&2
  echo "Use: git push origin HEAD  (pushes the current feature branch)" >&2
  exit 2
fi

exit 0
