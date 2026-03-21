#!/usr/bin/env bash
# kill.sh — kill the running Claude Code session on the Sprite

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"
load_config

RUNNING=$(sprite exec -s "$SPRITE" -- \
  bash -c "ls /home/sprite/prd-inbox/*.running 2>/dev/null | head -1 | xargs basename | sed 's/.running//'" \
  2>/dev/null || true)

if [[ -z "$RUNNING" ]]; then
  echo "Nothing is currently running."
  exit 0
fi

echo "Stopping: $RUNNING"
sprite exec -s "$SPRITE" -- \
  bash -c "pkill -f 'claude --dangerously' 2>/dev/null; pkill -f 'run-builder.sh' 2>/dev/null || true"

# Wait briefly and confirm
sleep 2
STILL_RUNNING=$(sprite exec -s "$SPRITE" -- \
  bash -c "ls /home/sprite/prd-inbox/*.running 2>/dev/null | wc -l" || echo "0")

if [[ "${STILL_RUNNING// /}" == "0" ]]; then
  echo "Session stopped. Cleanup (git reset, queue check) ran automatically."
else
  echo "Processes stopped but .running lock still exists."
  echo "  Clean up:"
  echo "    sprite exec -s $SPRITE -- rm /home/sprite/prd-inbox/${RUNNING}.running"
fi

# Clean up orphaned Supabase branches (best-effort)
# The builder skill creates branches named openthrottle-* for isolated DB work.
# If a session was killed mid-run, the branch may not have been deleted.
echo ""
echo "Checking for orphaned Supabase branches..."
ORPHANS=$(sprite exec -s "$SPRITE" -- \
  claude -p "List Supabase branches. Delete any with the openthrottle- prefix. Reply with what you deleted or 'none found'." \
  --dangerously-skip-permissions --output-format text 2>/dev/null || echo "skip")

if [[ "$ORPHANS" == "skip" ]]; then
  echo "  Could not check for orphaned branches (Supabase MCP may not be configured)"
else
  echo "  $ORPHANS"
fi
