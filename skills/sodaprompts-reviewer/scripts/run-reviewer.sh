#!/usr/bin/env bash
# =============================================================================
# run-reviewer.sh — the Thinker Sprite
#
# Polls GitHub for work that requires reading and analyzing:
#   Priority 1: PRs labeled "needs-review" (code review)
#   Priority 2: Issues labeled "needs-investigation" (bug investigation)
#
# Supports both Claude Code and Codex as the agent runtime.
# Set AGENT_RUNTIME=claude (default) or AGENT_RUNTIME=codex.
#
# All state lives on GitHub — checkpoint restore loses nothing.
# Sprite sleeps when idle (scale to zero) — no cost when no work.
# =============================================================================

set -euo pipefail

SPRITE_HOME="${SPRITE_HOME:-/home/sprite}"
REPO="${SPRITE_HOME}/repo"
LOG_DIR="${SPRITE_HOME}/logs"
POLL_INTERVAL="${POLL_INTERVAL:-60}"
IDLE_TIMEOUT="${IDLE_TIMEOUT:-300}"  # 5 min idle → exit (webhook wakes on new work)
MAX_REVIEW_ROUNDS="${MAX_REVIEW_ROUNDS:-3}"
TASK_TIMEOUT="${TASK_TIMEOUT:-1800}"  # 30 min per task
AGENT_RUNTIME="${AGENT_RUNTIME:-claude}"  # "claude" or "codex"
AGENT_MODEL="${AGENT_MODEL:-}"  # optional model override

SESSIONS_DIR="${SPRITE_HOME}/sessions"
mkdir -p "$LOG_DIR" "$SESSIONS_DIR"

# Source secrets
if [[ -f "${REPO}/.env" ]]; then
  set -a && source "${REPO}/.env" && set +a
fi

: "${GITHUB_REPO:?GITHUB_REPO is not set}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is not set}"

# Source task management adapter (abstracts GitHub issue operations)
if [[ -f "/opt/sodaprompts/task-adapter.sh" ]]; then
  source "/opt/sodaprompts/task-adapter.sh"
elif [[ -f "${REPO}/scripts/task-adapter.sh" ]]; then
  source "${REPO}/scripts/task-adapter.sh"
else
  echo "FATAL: task-adapter.sh not found" >&2
  exit 1
fi

# Read config
BASE_BRANCH="main"
if [[ -f "${REPO}/.sodaprompts.yml" ]]; then
  BASE_BRANCH=$(grep '^base_branch:' "${REPO}/.sodaprompts.yml" | awk '{print $2}' 2>/dev/null || echo "main")
fi

log() { echo "[thinker $(date +%H:%M:%S)] $1" | tee -a "${LOG_DIR}/thinker.log"; }
notify() {
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]] && [[ -n "${TELEGRAM_CHAT_ID:-}" ]]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHAT_ID}" \
      -d "text=$1" \
      > /dev/null 2>&1 || true
  fi
}

# ---------------------------------------------------------------------------
# Cleanup repo — reset to base branch between tasks
# ---------------------------------------------------------------------------
cleanup_repo() {
  cd "$REPO"
  git rebase --abort 2>/dev/null || true
  git merge --abort 2>/dev/null || true
  git checkout "$BASE_BRANCH" 2>/dev/null || true
  git reset --hard "origin/${BASE_BRANCH}" 2>/dev/null || true
  git clean -fd \
    --exclude='.env' \
    --exclude='.env.*' \
    --exclude='.env.local' \
    --exclude='node_modules' \
    2>/dev/null || true
  # Delete local branches from previous reviews
  git branch --list 'feat/*' 'fix/*' | while read -r branch; do
    git branch -D "$branch" 2>/dev/null || true
  done
}

# ---------------------------------------------------------------------------
# Invoke the agent — runtime-specific command, both load skills
#
# Usage: invoke_agent PROMPT TIMEOUT SESSION_LOG [TASK_KEY]
#   TASK_KEY — unique key for session resume (e.g. "review-42").
#              If a session file exists for this key, the agent resumes it.
#              If omitted, starts a fresh session with no resume support.
# ---------------------------------------------------------------------------
invoke_agent() {
  local PROMPT="$1"
  local AGENT_TIMEOUT="$2"
  local SESSION_LOG="$3"
  local TASK_KEY="${4:-}"

  # Resolve session flags for Claude (--session-id or --resume)
  local -a SESSION_FLAGS=()
  if [[ -n "$TASK_KEY" ]]; then
    local SESSION_FILE="${SESSIONS_DIR}/${TASK_KEY}.id"
    if [[ -f "$SESSION_FILE" ]]; then
      local EXISTING_ID
      EXISTING_ID=$(<"$SESSION_FILE")
      if [[ -n "$EXISTING_ID" ]]; then
        touch "$SESSION_FILE"  # refresh mtime to prevent pruning
        SESSION_FLAGS=(--resume "$EXISTING_ID")
        log "Resuming session for ${TASK_KEY}"
      else
        log "WARNING: empty session file for ${TASK_KEY}, starting fresh"
        rm -f "$SESSION_FILE"
        local SESSION_ID
        SESSION_ID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)
        echo "$SESSION_ID" > "$SESSION_FILE"
        SESSION_FLAGS=(--session-id "$SESSION_ID")
        log "New session for ${TASK_KEY}: ${SESSION_ID}"
      fi
    else
      local SESSION_ID
      SESSION_ID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)
      echo "$SESSION_ID" > "$SESSION_FILE"
      SESSION_FLAGS=(--session-id "$SESSION_ID")
      log "New session for ${TASK_KEY}: ${SESSION_ID}"
    fi
  fi

  case "$AGENT_RUNTIME" in
    claude)
      timeout "${AGENT_TIMEOUT}" claude \
        "${SESSION_FLAGS[@]}" \
        --dangerously-skip-permissions \
        -p "$PROMPT" \
        2>&1 | tee -a "$SESSION_LOG"
      ;;
    codex)
      local MODEL_FLAG=""
      if [[ -n "$AGENT_MODEL" ]]; then
        MODEL_FLAG="--model ${AGENT_MODEL}"
      fi
      timeout "${AGENT_TIMEOUT}" codex \
        $MODEL_FLAG \
        --approval-mode full-auto \
        --quiet \
        "$PROMPT" \
        2>&1 | tee -a "$SESSION_LOG"
      ;;
    *)
      log "Unknown AGENT_RUNTIME: ${AGENT_RUNTIME}. Use 'claude' or 'codex'."
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Gather review context — linked issue, builder's review, PR metadata
# ---------------------------------------------------------------------------
gather_review_context() {
  local PR_NUMBER="$1"

  # Get PR metadata including body and linked issues
  local PR_JSON
  PR_JSON=$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPO" \
    --json body,title,headRefName,state 2>/dev/null || echo "{}")

  local PR_BODY
  PR_BODY=$(echo "$PR_JSON" | jq -r '.body // ""')
  local PR_BRANCH
  PR_BRANCH=$(echo "$PR_JSON" | jq -r '.headRefName // ""')

  # Extract linked issue number from PR body (Fixes #N, Closes #N)
  local LINKED_ISSUE=""
  LINKED_ISSUE=$(echo "$PR_BODY" | grep -oiE '(fix(es)?|close[sd]?|resolve[sd]?) #[0-9]+' \
    | grep -oE '[0-9]+' | head -1 || echo "")

  # Fetch the original task (PRD or bug report)
  local ORIGINAL_TASK=""
  if [[ -n "$LINKED_ISSUE" ]]; then
    ORIGINAL_TASK=$(task_view "$LINKED_ISSUE" --json body --jq '.body' 2>/dev/null || echo "")
    log "Found linked issue #${LINKED_ISSUE}"
  else
    log "No linked issue found in PR body"
  fi

  # Fetch the builder's decision log and review comments from PR
  local BUILDER_REVIEW=""
  BUILDER_REVIEW=$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPO" --json comments \
    --jq '[.comments[] | select(.body | test("Decision Log|Review Notes|Session Report"; "i"))] | [.[].body] | join("\n\n---\n\n")' \
    2>/dev/null || echo "")

  # Export for use in prompt construction
  echo "$PR_BRANCH"
  # Write context to temp files for the prompt
  echo "$ORIGINAL_TASK" > "/tmp/review-context-task-${PR_NUMBER}.txt"
  echo "$BUILDER_REVIEW" > "/tmp/review-context-builder-${PR_NUMBER}.txt"
}

# ---------------------------------------------------------------------------
# PR Review — gather context, checkout branch, run task-aware review
# ---------------------------------------------------------------------------
review_pr() {
  local PR_NUMBER="$1"
  local SESSION_LOG="${LOG_DIR}/review-pr-${PR_NUMBER}.log"

  # Check review round count before claiming
  local REVIEW_COUNT
  REVIEW_COUNT=$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPO" --json reviews \
    --jq '[.reviews[] | select(.state == "CHANGES_REQUESTED")] | length' 2>/dev/null || echo "0")

  if [[ "$REVIEW_COUNT" -ge "$MAX_REVIEW_ROUNDS" ]]; then
    log "PR #${PR_NUMBER} hit max rounds (${MAX_REVIEW_ROUNDS}). Auto-approving."
    gh pr edit "$PR_NUMBER" --repo "$GITHUB_REPO" --remove-label "needs-review" 2>/dev/null || true
    gh pr review "$PR_NUMBER" --repo "$GITHUB_REPO" --approve \
      --body "Auto-approved after ${MAX_REVIEW_ROUNDS} review rounds. Please review manually." 2>/dev/null || true
    notify "PR #${PR_NUMBER} auto-approved after ${MAX_REVIEW_ROUNDS} rounds."
    return 0
  fi

  local REVIEW_ROUND=$((REVIEW_COUNT + 1))

  # Claim — note: needs-review/reviewing are PR labels, but they follow the same
  # state machine pattern. We use gh pr edit directly since PRs are always GitHub.
  gh pr edit "$PR_NUMBER" --repo "$GITHUB_REPO" \
    --remove-label "needs-review" --add-label "reviewing" 2>/dev/null || true

  log "Reviewing PR #${PR_NUMBER} (round ${REVIEW_ROUND}/${MAX_REVIEW_ROUNDS})"
  notify "Reviewing PR #${PR_NUMBER} (round ${REVIEW_ROUND})"

  # Gather context (linked issue, builder review)
  local PR_BRANCH
  PR_BRANCH=$(gather_review_context "$PR_NUMBER")

  # Checkout the PR branch so the agent can read/modify source files
  cd "$REPO"
  git fetch origin "$PR_BRANCH" 2>/dev/null || true
  git checkout "$PR_BRANCH" 2>/dev/null || true
  git pull origin "$PR_BRANCH" 2>/dev/null || true

  # Read context files
  local ORIGINAL_TASK=""
  if [[ -f "/tmp/review-context-task-${PR_NUMBER}.txt" ]]; then
    ORIGINAL_TASK=$(cat "/tmp/review-context-task-${PR_NUMBER}.txt")
  fi
  local BUILDER_REVIEW=""
  if [[ -f "/tmp/review-context-builder-${PR_NUMBER}.txt" ]]; then
    BUILDER_REVIEW=$(cat "/tmp/review-context-builder-${PR_NUMBER}.txt")
  fi

  # Build the prompt with full context
  local RE_REVIEW_NOTE=""
  if [[ "$REVIEW_ROUND" -gt 1 ]]; then
    RE_REVIEW_NOTE="
RE_REVIEW: This is re-review round ${REVIEW_ROUND}. Focus on whether your previous requested changes were addressed."
  fi

  local PROMPT="Review PR #${PR_NUMBER} in ${GITHUB_REPO}. Use the sodaprompts-reviewer skill.

The PR branch is checked out locally — you can read source files, run commands,
and commit trivial fixes directly. Push to the branch when done.

ORIGINAL_TASK:
${ORIGINAL_TASK:-No linked issue found. Skip task alignment pass.}

BUILDER_REVIEW:
${BUILDER_REVIEW:-No builder review comments found.}
${RE_REVIEW_NOTE}"

  invoke_agent "$PROMPT" "$TASK_TIMEOUT" "$SESSION_LOG" "review-${PR_NUMBER}" || {
    local EXIT_CODE=$?
    if [[ $EXIT_CODE -eq 124 ]]; then
      log "Review timed out for PR #${PR_NUMBER}"
      notify "Review timed out — PR #${PR_NUMBER}"
    else
      log "Agent exited with ${EXIT_CODE} for PR #${PR_NUMBER}"
    fi
  }

  # Cleanup temp files
  rm -f "/tmp/review-context-task-${PR_NUMBER}.txt" \
        "/tmp/review-context-builder-${PR_NUMBER}.txt"

  # Safety: ensure label removed
  gh pr edit "$PR_NUMBER" --repo "$GITHUB_REPO" --remove-label "reviewing" 2>/dev/null || true
  log "Review complete for PR #${PR_NUMBER}"

  # Reset to base branch for next task
  cleanup_repo
}

# ---------------------------------------------------------------------------
# Bug Investigation — read issue, analyze codebase, post findings
# ---------------------------------------------------------------------------
investigate_bug() {
  local ISSUE_NUMBER="$1"
  local SESSION_LOG="${LOG_DIR}/investigate-${ISSUE_NUMBER}.log"

  # Read issue details
  local ISSUE_JSON
  ISSUE_JSON=$(task_view "$ISSUE_NUMBER" --json title,body)
  local TITLE
  TITLE=$(echo "$ISSUE_JSON" | jq -r '.title')

  # Claim
  task_transition "$ISSUE_NUMBER" "needs-investigation" "investigating"

  log "Investigating issue #${ISSUE_NUMBER}: ${TITLE}"
  notify "Investigating: #${ISSUE_NUMBER} — ${TITLE}"

  # Make sure repo is up to date
  cd "$REPO"
  git pull origin "$BASE_BRANCH" 2>/dev/null || true

  local PROMPT="Investigate issue #${ISSUE_NUMBER} in ${GITHUB_REPO}. Use the sodaprompts-investigator skill."

  invoke_agent "$PROMPT" "$TASK_TIMEOUT" "$SESSION_LOG" "investigate-${ISSUE_NUMBER}" || {
    local EXIT_CODE=$?
    if [[ $EXIT_CODE -eq 124 ]]; then
      log "Investigation timed out for issue #${ISSUE_NUMBER}"
      notify "Investigation timed out — issue #${ISSUE_NUMBER}"
    else
      log "Agent exited with ${EXIT_CODE} for issue #${ISSUE_NUMBER}"
    fi
  }

  # Safety: ensure investigating label removed
  # Note: the investigator skill handles the transition to bug-queued when posting findings.
  # This is just a safety net in case the agent didn't clean up.
  gh issue edit "$ISSUE_NUMBER" --repo "$GITHUB_REPO" --remove-label "investigating" 2>/dev/null || true
  log "Investigation complete for issue #${ISSUE_NUMBER}"

  # Reset to base branch for next task
  cleanup_repo
}

# ---------------------------------------------------------------------------
# Main loop — poll until idle timeout, then exit (sprite suspends)
# ---------------------------------------------------------------------------
log "Thinker sprite starting (poll: ${POLL_INTERVAL}s, idle timeout: ${IDLE_TIMEOUT}s, runtime: ${AGENT_RUNTIME}, max review rounds: ${MAX_REVIEW_ROUNDS})"
notify "Thinker sprite online. Runtime: ${AGENT_RUNTIME}. Polling for reviews & investigations."

# Clean repo state on startup
cleanup_repo

# Prune session files older than 7 days
find "$SESSIONS_DIR" -name '*.id' -mtime +7 -delete 2>/dev/null || true

LAST_WORK_EPOCH=$(date +%s)

while true; do
  FOUND_WORK=false

  # Priority 1: PRs needing review
  PR_NUMBER=$(gh pr list --repo "$GITHUB_REPO" \
    --label "needs-review" --sort created \
    --json number --jq '.[0].number' 2>/dev/null || echo "")

  if [[ -n "$PR_NUMBER" ]] && [[ "$PR_NUMBER" != "null" ]]; then
    review_pr "$PR_NUMBER" || {
      log "Review failed for PR #${PR_NUMBER}"
      gh pr edit "$PR_NUMBER" --repo "$GITHUB_REPO" \
        --remove-label "reviewing" --add-label "needs-review" 2>/dev/null || true
    }
    FOUND_WORK=true
  fi

  # Priority 2: Issues needing investigation
  if [[ "$FOUND_WORK" == false ]]; then
    ISSUE_NUMBER=$(task_first_by_status "needs-investigation")

    if [[ -n "$ISSUE_NUMBER" ]] && [[ "$ISSUE_NUMBER" != "null" ]]; then
      investigate_bug "$ISSUE_NUMBER" || {
        log "Investigation failed for issue #${ISSUE_NUMBER}"
        task_transition "$ISSUE_NUMBER" "investigating" "needs-investigation"
      }
      FOUND_WORK=true
    fi
  fi

  # Reset idle timer when work was found
  if [[ "$FOUND_WORK" == true ]]; then
    LAST_WORK_EPOCH=$(date +%s)
    continue
  fi

  # Check idle timeout
  NOW=$(date +%s)
  IDLE_SECS=$(( NOW - LAST_WORK_EPOCH ))
  if [[ $IDLE_SECS -ge $IDLE_TIMEOUT ]]; then
    log "Idle for ${IDLE_SECS}s (limit: ${IDLE_TIMEOUT}s). Exiting — sprite will suspend."
    notify "Thinker sprite going to sleep (idle ${IDLE_TIMEOUT}s). Will wake on next review."
    exit 0
  fi

  sleep "$POLL_INTERVAL"
done
