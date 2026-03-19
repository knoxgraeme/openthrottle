#!/usr/bin/env bash
# logs.sh — view agent logs
# Usage: logs.sh [prd-id]
#   No arg → tail the currently running prompt's log
#   With id → show that run's log

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"
load_config
PRD_ID="${1:-}"

if [[ -z "$PRD_ID" ]]; then
  # Find currently running
  PRD_ID=$(sprite exec -s "$SPRITE" -- \
    bash -c "ls /home/sprite/prd-inbox/*.running 2>/dev/null | head -1 | xargs basename | sed 's/.running//'" \
    2>/dev/null || true)

  if [[ -z "$PRD_ID" ]]; then
    echo "Nothing currently running."
    echo ""
    echo "Recent logs:"
    sprite exec -s "$SPRITE" -- \
      bash -c "ls -t /home/sprite/logs/prd-*.log 2>/dev/null | head -5" || true
    echo ""
    echo "To view a specific log: logs.sh <prd-id>"
    exit 0
  fi

  echo "Tailing live log for $PRD_ID (ctrl+c to stop)..."
  echo ""
  sprite exec -s "$SPRITE" -- tail -f "/home/sprite/logs/${PRD_ID}.log"
else
  echo "Log for $PRD_ID:"
  echo ""
  sprite exec -s "$SPRITE" -- cat "/home/sprite/logs/${PRD_ID}.log" 2>/dev/null || {
    echo "Log not found for $PRD_ID"
    echo "Available logs:"
    sprite exec -s "$SPRITE" -- bash -c "ls /home/sprite/logs/prd-*.log 2>/dev/null" || true
  }
fi
