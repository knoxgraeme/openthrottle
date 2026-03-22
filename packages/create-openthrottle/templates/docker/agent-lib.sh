#!/usr/bin/env bash
# =============================================================================
# agent-lib.sh — Shared library for Daytona sandbox runners
#
# Sourced by run-builder.sh and run-reviewer.sh. Contains:
#   - log / notify — logging and Telegram notifications
#   - sanitize_secrets — redact secrets from text
#   - invoke_agent — runtime-specific agent invocation with session management
#
# Requires: SANDBOX_HOME, LOG_DIR, SESSIONS_DIR, AGENT_RUNTIME, GITHUB_REPO
# =============================================================================

# ---------------------------------------------------------------------------
# Logging and notifications
# ---------------------------------------------------------------------------
RUNNER_NAME="${RUNNER_NAME:-agent}"

log() { echo "[${RUNNER_NAME} $(date +%H:%M:%S)] $1" | tee -a "${LOG_DIR}/${RUNNER_NAME}.log"; }

notify() {
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]] && [[ -n "${TELEGRAM_CHAT_ID:-}" ]]; then
    local HTTP_CODE
    HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
      -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHAT_ID}" \
      -d "text=$1") || true
    if [[ "$HTTP_CODE" != "200" ]] && [[ "${_NOTIFY_WARNED:-}" != "1" ]]; then
      log "WARNING: Telegram notification failed (HTTP ${HTTP_CODE}). Check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID."
      _NOTIFY_WARNED=1
    fi
  fi
}

# ---------------------------------------------------------------------------
# Sanitize secrets from text before posting to GitHub or logs
# ---------------------------------------------------------------------------
sanitize_secrets() {
  local TEXT="$1"
  [[ -n "${GITHUB_TOKEN:-}" ]]             && TEXT="${TEXT//$GITHUB_TOKEN/[REDACTED]}"
  [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]       && TEXT="${TEXT//$TELEGRAM_BOT_TOKEN/[REDACTED]}"
  [[ -n "${ANTHROPIC_API_KEY:-}" ]]        && TEXT="${TEXT//$ANTHROPIC_API_KEY/[REDACTED]}"
  [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]  && TEXT="${TEXT//$CLAUDE_CODE_OAUTH_TOKEN/[REDACTED]}"
  [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]    && TEXT="${TEXT//$SUPABASE_ACCESS_TOKEN/[REDACTED]}"
  [[ -n "${OPENAI_API_KEY:-}" ]]           && TEXT="${TEXT//$OPENAI_API_KEY/[REDACTED]}"
  TEXT=$(echo "$TEXT" | sed \
    -e 's/ghp_[A-Za-z0-9_]\{36,\}/[REDACTED]/g' \
    -e 's/ghs_[A-Za-z0-9_]\{36,\}/[REDACTED]/g' \
    -e 's/sk-[A-Za-z0-9_-]\{20,\}/[REDACTED]/g' \
    -e 's/Bearer [^ ]*/Bearer [REDACTED]/g')
  echo "$TEXT"
}

# ---------------------------------------------------------------------------
# Invoke the agent — runtime-specific command with session management
#
# Usage: invoke_agent PROMPT TIMEOUT SESSION_LOG [TASK_KEY]
#   TASK_KEY — unique key for session persistence (e.g. "prd-42", "review-7").
#              Session files are stored on the volume at SESSIONS_DIR.
#              If RESUME_SESSION env var is set, it takes precedence (review-fix flow).
# ---------------------------------------------------------------------------
invoke_agent() {
  local PROMPT="$1"
  local AGENT_TIMEOUT="$2"
  local SESSION_LOG="$3"
  local TASK_KEY="${4:-}"

  local -a SESSION_FLAGS=()
  local ACTIVE_SESSION_ID=""

  # Priority 1: RESUME_SESSION env var (set by GitHub Action for review-fix flow)
  if [[ -n "${RESUME_SESSION:-}" ]]; then
    SESSION_FLAGS=(--resume "$RESUME_SESSION")
    ACTIVE_SESSION_ID="$RESUME_SESSION"
    log "Resuming session from workflow: ${RESUME_SESSION}"

  # Priority 2: Session file on volume (cross-sandbox resume)
  elif [[ -n "$TASK_KEY" ]]; then
    local SESSION_FILE="${SESSIONS_DIR}/${TASK_KEY}.id"
    if [[ -f "$SESSION_FILE" ]]; then
      local EXISTING_ID
      EXISTING_ID=$(<"$SESSION_FILE")
      if [[ -n "$EXISTING_ID" ]]; then
        touch "$SESSION_FILE"  # refresh mtime to prevent 7-day pruning
        SESSION_FLAGS=(--resume "$EXISTING_ID")
        ACTIVE_SESSION_ID="$EXISTING_ID"
        log "Resuming session from volume: ${EXISTING_ID}"
      else
        log "WARNING: Empty session file for ${TASK_KEY} — starting fresh"
        rm -f "$SESSION_FILE"
      fi
    fi

    # Create new session if not resuming
    if [[ ${#SESSION_FLAGS[@]} -eq 0 ]]; then
      local NEW_ID
      NEW_ID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)
      echo "$NEW_ID" > "${SESSIONS_DIR}/${TASK_KEY}.id"
      SESSION_FLAGS=(--session-id "$NEW_ID")
      ACTIVE_SESSION_ID="$NEW_ID"
      log "New session: ${NEW_ID}"
    fi
  fi

  # Export session ID for post_session_report
  export LAST_SESSION_ID="$ACTIVE_SESSION_ID"

  case "$AGENT_RUNTIME" in
    claude)
      local -a LIMIT_FLAGS=()
      [[ -n "${MAX_TURNS:-}" ]] && LIMIT_FLAGS+=(--max-turns "$MAX_TURNS")
      [[ -n "${MAX_BUDGET_USD:-}" ]] && LIMIT_FLAGS+=(--max-budget-usd "$MAX_BUDGET_USD")

      local RAW_OUTPUT
      RAW_OUTPUT=$(timeout "${AGENT_TIMEOUT}" claude \
        "${SESSION_FLAGS[@]}" \
        "${LIMIT_FLAGS[@]}" \
        --dangerously-skip-permissions \
        --output-format json \
        -p "$PROMPT" 2>&1)
      local AGENT_EXIT=$?

      # Write raw JSON to session log (structured metadata for post_session_report)
      echo "$RAW_OUTPUT" >> "$SESSION_LOG"

      # Extract text result for human-readable companion log
      local RESULT_TEXT
      RESULT_TEXT=$(echo "$RAW_OUTPUT" | jq -r '.result // empty' 2>/dev/null || echo "$RAW_OUTPUT")
      echo "$RESULT_TEXT" >> "${SESSION_LOG%.log}.txt"

      return $AGENT_EXIT
      ;;
    codex)
      local -a MODEL_FLAGS=()
      [[ -n "${AGENT_MODEL:-}" ]] && MODEL_FLAGS=(--model "$AGENT_MODEL")
      timeout "${AGENT_TIMEOUT}" codex \
        "${MODEL_FLAGS[@]}" \
        --approval-mode full-auto \
        --quiet \
        "$PROMPT" \
        2>&1 | tee -a "$SESSION_LOG"
      ;;
    aider)
      local -a MODEL_FLAGS=()
      [[ -n "${AGENT_MODEL:-}" ]] && MODEL_FLAGS=(--model "$AGENT_MODEL")
      timeout "${AGENT_TIMEOUT}" aider \
        "${MODEL_FLAGS[@]}" \
        --yes \
        --no-auto-commits \
        --message "$PROMPT" \
        2>&1 | tee -a "$SESSION_LOG"
      ;;
    *)
      log "Unknown AGENT_RUNTIME: ${AGENT_RUNTIME}"
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Handle agent invocation result — common exit code handling
# ---------------------------------------------------------------------------
handle_agent_result() {
  local EXIT_CODE=$1
  local TASK_LABEL="$2"
  local TIMEOUT_VAL="$3"

  case $EXIT_CODE in
    0) return 0 ;;
    124)
      log "${TASK_LABEL} timed out after ${TIMEOUT_VAL}s"
      notify "${TASK_LABEL} timed out"
      ;;
    127)
      log "FATAL: Agent binary '${AGENT_RUNTIME}' not found"
      notify "${TASK_LABEL} failed — agent binary not found"
      return 1
      ;;
    137)
      log "Agent was OOM-killed during ${TASK_LABEL}"
      notify "${TASK_LABEL} failed — out of memory"
      ;;
    *)
      log "Agent failed with exit code ${EXIT_CODE} during ${TASK_LABEL}"
      notify "${TASK_LABEL} — agent failed (exit ${EXIT_CODE})"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Post session report as a PR comment
# ---------------------------------------------------------------------------
post_session_report() {
  local PR_NUM="$1"
  local TASK_ID="$2"
  local DURATION="$3"
  local SESSION_LOG="$4"

  local COMMIT_COUNT FILES_CHANGED
  COMMIT_COUNT=$(git -C "$REPO" rev-list --count "${BASE_BRANCH}..HEAD" 2>/dev/null || echo "0")
  FILES_CHANGED=$(git -C "$REPO" diff --name-only "${BASE_BRANCH}..HEAD" 2>/dev/null | wc -l | tr -d ' ')

  local CMD_TOTAL CMD_FAILED
  CMD_TOTAL=$(grep -c "\[${TASK_ID}\]" "${LOG_DIR}/bash-commands.log" 2>/dev/null || echo "0")
  CMD_FAILED=$(grep "\[${TASK_ID}\]" "${LOG_DIR}/bash-commands.log" 2>/dev/null \
    | grep -cv '\[exit:0\]' || echo "0")

  # Extract structured metadata from JSON output (Claude runtime)
  local COST_USD NUM_TURNS INPUT_TOKENS OUTPUT_TOKENS API_DURATION_MS LOG_TAIL
  if jq -e '.type == "result"' "$SESSION_LOG" > /dev/null 2>&1; then
    COST_USD=$(jq -r '.total_cost_usd // "n/a"' "$SESSION_LOG")
    NUM_TURNS=$(jq -r '.num_turns // "n/a"' "$SESSION_LOG")
    INPUT_TOKENS=$(jq -r '.usage.input_tokens // "n/a"' "$SESSION_LOG")
    OUTPUT_TOKENS=$(jq -r '.usage.output_tokens // "n/a"' "$SESSION_LOG")
    API_DURATION_MS=$(jq -r '.duration_api_ms // "n/a"' "$SESSION_LOG")
    # Use human-readable text for the log tail
    LOG_TAIL=$(tail -50 "${SESSION_LOG%.log}.txt" 2>/dev/null || echo "(no log)")
  else
    # Fallback for codex/aider — plain text log, no structured metadata
    COST_USD="n/a"
    NUM_TURNS="n/a"
    INPUT_TOKENS="n/a"
    OUTPUT_TOKENS="n/a"
    API_DURATION_MS="n/a"
    LOG_TAIL=$(tail -50 "$SESSION_LOG" 2>/dev/null || echo "(no log)")
  fi
  LOG_TAIL=$(sanitize_secrets "$LOG_TAIL")

  # Include session-id for review-fix resume
  local SESSION_MARKER=""
  if [[ -n "${LAST_SESSION_ID:-}" ]]; then
    SESSION_MARKER="
<!-- session-id: ${LAST_SESSION_ID} -->"
  fi

  local COMMENT_ERR
  COMMENT_ERR=$(gh pr comment "$PR_NUM" --repo "$GITHUB_REPO" --body "$(cat <<EOF
## Session Report
${SESSION_MARKER}

| Metric | Value |
|---|---|
| Duration | ${DURATION}m |
| API duration | ${API_DURATION_MS}ms |
| Cost | \$${COST_USD} |
| Tokens | ${INPUT_TOKENS} in / ${OUTPUT_TOKENS} out |
| Turns | ${NUM_TURNS} |
| Commits | ${COMMIT_COUNT} |
| Files changed | ${FILES_CHANGED} |
| Bash commands | ${CMD_TOTAL} total, ${CMD_FAILED} failed |

<details>
<summary>Agent output (last 50 lines)</summary>

\`\`\`
${LOG_TAIL}
\`\`\`

</details>
EOF
)" 2>&1) || log "WARNING: Failed to post session report to PR #${PR_NUM}: ${COMMENT_ERR}"
}
