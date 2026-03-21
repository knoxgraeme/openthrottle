#!/usr/bin/env bash
# auto-format.sh
# PostToolUse hook — fires after Write or Edit tool calls.
# Runs the project's formatter on any changed file if one is configured.

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')

[[ -z "$FILE" ]] && exit 0
[[ ! -f "$FILE" ]] && exit 0

SANDBOX_HOME="${SANDBOX_HOME:-/home/daytona}"
cd "${SANDBOX_HOME}/repo" 2>/dev/null || exit 0

EXT="${FILE##*.}"

case "$EXT" in
  ts|tsx|js|jsx|mjs|cjs|json|css|scss|html|md|yaml|yml)
    if [[ -f "node_modules/.bin/prettier" ]]; then
      node_modules/.bin/prettier --write "$FILE" --log-level silent 2>/dev/null
    elif command -v prettier &>/dev/null; then
      prettier --write "$FILE" --log-level silent 2>/dev/null
    fi
    ;;
  py)
    if command -v black &>/dev/null; then
      black "$FILE" --quiet 2>/dev/null
    elif command -v ruff &>/dev/null; then
      ruff format "$FILE" --quiet 2>/dev/null
    fi
    ;;
  go)
    if command -v gofmt &>/dev/null; then
      gofmt -w "$FILE" 2>/dev/null
    fi
    ;;
  rb)
    if command -v rubocop &>/dev/null; then
      rubocop -a "$FILE" --no-color 2>/dev/null
    fi
    ;;
esac

exit 0
