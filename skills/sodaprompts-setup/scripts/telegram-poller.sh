#!/usr/bin/env bash
# =============================================================================
# telegram-poller.sh — background daemon on the Sprite
# Polls Telegram for command messages and replies with status info.
# Runs independently of the Claude session.
#
# Supported commands:
#   /status  — what's running, queue, recent completions
#   /logs    — last 20 lines of the active run's log
#   /queue   — show queued PRDs
#   /kill    — stop the running Claude session
#   /help    — list commands
#
# Started during bootstrap, runs forever in the background.
# =============================================================================

set -euo pipefail

SPRITE_HOME="${SPRITE_HOME:-/home/sprite}"
INBOX="${SPRITE_HOME}/prd-inbox"
LOGS="${SPRITE_HOME}/logs"
QUEUE="${SPRITE_HOME}/queue/queue.jsonl"
POLL_INTERVAL=15
LAST_UPDATE_ID=0

# Source secrets
set -a
source "${SPRITE_HOME}/repo/.env" 2>/dev/null || true
set +a

: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN not set}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID not set}"

API="https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
send_reply() {
  local text="$1"
  curl -s -X POST "${API}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "text=${text}" \
    -d "parse_mode=Markdown" > /dev/null 2>&1 || true
}

get_running() {
  local running_file
  running_file=$(ls "${INBOX}"/*.running 2>/dev/null | head -1 || true)
  if [[ -n "$running_file" ]]; then
    basename "$running_file" .running
  fi
}

get_elapsed() {
  local prd_id="$1"
  local lock_file="${INBOX}/${prd_id}.running"
  if [[ -f "$lock_file" ]]; then
    local start_epoch
    start_epoch=$(stat -c %Y "$lock_file" 2>/dev/null || stat -f %m "$lock_file" 2>/dev/null || echo 0)
    local now_epoch
    now_epoch=$(date +%s)
    local elapsed=$(( (now_epoch - start_epoch) / 60 ))
    echo "${elapsed} min"
  else
    echo "unknown"
  fi
}

# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------
handle_status() {
  local running
  running=$(get_running)

  local msg=""

  if [[ -n "$running" ]]; then
    local elapsed
    elapsed=$(get_elapsed "$running")
    local title
    title=$(head -1 "${INBOX}/${running}.md" 2>/dev/null | sed 's/^#* *//' || echo "$running")
    local last_log
    last_log=$(tail -1 "${LOGS}/${running}.log" 2>/dev/null | head -c 200 || echo "(no log)")

    msg="*Running:* ${running}
${title}
Elapsed: ${elapsed}
Last: \`${last_log}\`"
  else
    msg="*Idle* — nothing running"
  fi

  # Queue
  if [[ -f "$QUEUE" ]] && [[ -s "$QUEUE" ]]; then
    local count
    count=$(wc -l < "$QUEUE" 2>/dev/null || echo 0)
    count="${count// /}"
    msg="${msg}

*Queue:* ${count} item(s)"
    local pos=1
    while IFS= read -r line; do
      local qid
      qid=$(echo "$line" | jq -r '.id // "?"' 2>/dev/null)
      msg="${msg}
  ${pos}. ${qid}"
      pos=$((pos + 1))
    done < "$QUEUE"
  else
    msg="${msg}

*Queue:* empty"
  fi

  # Recent completions
  local done_files
  done_files=$(ls -t "${INBOX}"/*.done 2>/dev/null | head -3 || true)
  if [[ -n "$done_files" ]]; then
    msg="${msg}

*Recent:*"
    for f in $done_files; do
      local did
      did=$(basename "$f" .done)
      local dtitle
      dtitle=$(head -1 "${INBOX}/${did}.md" 2>/dev/null | sed 's/^#* *//' || echo "$did")
      msg="${msg}
  done: ${did} — ${dtitle}"
    done
  fi

  send_reply "$msg"
}

handle_logs() {
  local running
  running=$(get_running)

  if [[ -z "$running" ]]; then
    send_reply "Nothing running. No active logs."
    return
  fi

  local log_tail
  log_tail=$(tail -20 "${LOGS}/${running}.log" 2>/dev/null || echo "(no log file)")
  # Truncate to fit Telegram's 4096 char limit
  log_tail="${log_tail:0:3800}"

  send_reply "*Logs:* ${running}

\`\`\`
${log_tail}
\`\`\`"
}

handle_queue() {
  if [[ ! -f "$QUEUE" ]] || [[ ! -s "$QUEUE" ]]; then
    send_reply "Queue is empty."
    return
  fi

  local count
  count=$(wc -l < "$QUEUE" 2>/dev/null || echo 0)
  count="${count// /}"
  local msg="*Queue:* ${count} item(s)"

  local pos=1
  while IFS= read -r line; do
    local qid qbase
    qid=$(echo "$line" | jq -r '.id // "?"' 2>/dev/null)
    qbase=$(echo "$line" | jq -r '.base // "main"' 2>/dev/null)
    msg="${msg}
${pos}. ${qid} (base: ${qbase})"
    pos=$((pos + 1))
  done < "$QUEUE"

  send_reply "$msg"
}

handle_kill() {
  local running
  running=$(get_running)

  if [[ -z "$running" ]]; then
    send_reply "Nothing is running."
    return
  fi

  pkill -f "claude --dangerously" 2>/dev/null || true
  pkill -f "run-builder.sh" 2>/dev/null || true
  sleep 2

  local still_running
  still_running=$(get_running)
  if [[ -z "$still_running" ]]; then
    send_reply "Stopped: ${running}. Cleanup ran automatically."
  else
    send_reply "Processes killed but lock still exists for ${running}. May need manual cleanup."
  fi
}

handle_drop() {
  local pos="$1"

  if [[ ! -f "$QUEUE" ]] || [[ ! -s "$QUEUE" ]]; then
    send_reply "Queue is empty."
    return
  fi

  local count
  count=$(wc -l < "$QUEUE" 2>/dev/null || echo 0)
  count="${count// /}"

  if [[ -z "$pos" ]] || ! [[ "$pos" =~ ^[0-9]+$ ]] || [[ "$pos" -lt 1 ]] || [[ "$pos" -gt "$count" ]]; then
    send_reply "Usage: /drop <position> (1-${count})"
    return
  fi

  local dropped
  dropped=$(sed -n "${pos}p" "$QUEUE" | jq -r '.id // "?"' 2>/dev/null)

  # Remove the line at position
  local tmpq
  tmpq=$(mktemp)
  sed "${pos}d" "$QUEUE" > "$tmpq" && mv "$tmpq" "$QUEUE"

  send_reply "Dropped #${pos}: ${dropped}"
}

handle_clear() {
  if [[ ! -f "$QUEUE" ]] || [[ ! -s "$QUEUE" ]]; then
    send_reply "Queue is already empty."
    return
  fi

  local count
  count=$(wc -l < "$QUEUE" 2>/dev/null || echo 0)
  count="${count// /}"

  > "$QUEUE"

  send_reply "Cleared ${count} item(s) from queue."
}

handle_help() {
  send_reply "*Commands:*
/status — what's running, queue, completions
/logs — last 20 lines of active log
/queue — show queued PRDs
/drop N — remove item N from queue
/clear — clear the entire queue
/kill — stop the running session
/help — this message"
}

# ---------------------------------------------------------------------------
# Main poll loop
# ---------------------------------------------------------------------------
echo "[telegram-poller] Started (interval: ${POLL_INTERVAL}s)"

# Get initial offset to skip old messages
INITIAL=$(curl -s "${API}/getUpdates?limit=1&offset=-1" 2>/dev/null || echo '{}')
LAST_UPDATE_ID=$(echo "$INITIAL" | jq -r '.result[-1].update_id // 0' 2>/dev/null || echo 0)

while true; do
  RESPONSE=$(curl -s "${API}/getUpdates?offset=$((LAST_UPDATE_ID + 1))&timeout=10" 2>/dev/null || echo '{}')

  UPDATES=$(echo "$RESPONSE" | jq -r '.result // [] | length' 2>/dev/null || echo 0)

  if [[ "$UPDATES" -gt 0 ]]; then
    echo "$RESPONSE" | jq -c '.result[]' 2>/dev/null | while IFS= read -r update; do
      UPDATE_ID=$(echo "$update" | jq -r '.update_id' 2>/dev/null)
      CHAT=$(echo "$update" | jq -r '.message.chat.id // 0' 2>/dev/null)
      TEXT=$(echo "$update" | jq -r '.message.text // ""' 2>/dev/null)

      # Only respond to our chat
      if [[ "$CHAT" == "$TELEGRAM_CHAT_ID" ]]; then
        case "$TEXT" in
          /status)  handle_status ;;
          /logs)    handle_logs ;;
          /queue)   handle_queue ;;
          /drop*)   handle_drop "$(echo "$TEXT" | awk '{print $2}')" ;;
          /clear)   handle_clear ;;
          /kill)    handle_kill ;;
          /help)    handle_help ;;
        esac
      fi

      # Update offset regardless — don't reprocess
      if [[ "$UPDATE_ID" -gt "$LAST_UPDATE_ID" ]]; then
        LAST_UPDATE_ID="$UPDATE_ID"
      fi
    done

    # Update LAST_UPDATE_ID outside the pipe (subshell issue)
    # Guard against resetting to 0 which would reprocess old messages
    NEW_LAST=$(echo "$RESPONSE" | jq -r '.result[-1].update_id // empty' 2>/dev/null || true)
    if [[ -n "$NEW_LAST" ]] && [[ "$NEW_LAST" -gt "$LAST_UPDATE_ID" ]]; then
      LAST_UPDATE_ID="$NEW_LAST"
    fi
  fi

  sleep "$POLL_INTERVAL"
done
