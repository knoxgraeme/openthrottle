#!/usr/bin/env bash
# =============================================================================
# run-builder.sh — the Doer Sprite
#
# Polls GitHub for work that requires writing code:
#   Priority 1: PRs with changes_requested (review fixes)
#   Priority 2: Issues labeled "bug-queued" (bug fixes)
#   Priority 3: Issues labeled "prd-queued" (new features)
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
TIMEOUT="${TIMEOUT:-7200}"  # 2 hour default per session
AGENT_RUNTIME="${AGENT_RUNTIME:-claude}"  # "claude" or "codex"
AGENT_MODEL="${AGENT_MODEL:-}"  # optional model override (used by codex)

mkdir -p "$LOG_DIR"

# Source secrets
if [[ -f "${REPO}/.env" ]]; then
  set -a && source "${REPO}/.env" && set +a
fi

: "${GITHUB_REPO:?GITHUB_REPO is not set}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is not set}"

# Read config
BASE_BRANCH="main"
if [[ -f "${REPO}/.sodaprompts.yml" ]]; then
  BASE_BRANCH=$(grep '^base_branch:' "${REPO}/.sodaprompts.yml" | awk '{print $2}' 2>/dev/null || echo "main")
fi

ENV_RESET_SIGNAL="${SPRITE_HOME}/env-reset-request.json"

COMPLETIONS_DIR="${SPRITE_HOME}/completions"
SESSIONS_DIR="${SPRITE_HOME}/sessions"
mkdir -p "$COMPLETIONS_DIR" "$SESSIONS_DIR"

log() { echo "[builder $(date +%H:%M:%S)] $1" | tee -a "${LOG_DIR}/builder.log"; }
notify() {
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]] && [[ -n "${TELEGRAM_CHAT_ID:-}" ]]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHAT_ID}" \
      -d "text=$1" \
      > /dev/null 2>&1 || true
  fi
}

# ---------------------------------------------------------------------------
# Sanitize secrets from text before posting to GitHub or logs
# ---------------------------------------------------------------------------
sanitize_secrets() {
  local TEXT="$1"
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    TEXT="${TEXT//$GITHUB_TOKEN/[REDACTED]}"
  fi
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
    TEXT="${TEXT//$TELEGRAM_BOT_TOKEN/[REDACTED]}"
  fi
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    TEXT="${TEXT//$ANTHROPIC_API_KEY/[REDACTED]}"
  fi
  TEXT=$(echo "$TEXT" | sed \
    -e 's/ghp_[A-Za-z0-9_]\{36,\}/[REDACTED]/g' \
    -e 's/sk-[A-Za-z0-9_-]\{20,\}/[REDACTED]/g')
  echo "$TEXT"
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
  CMD_TOTAL=$(grep -c "\[${TASK_ID}\]" "${SPRITE_HOME}/logs/bash-commands.log" 2>/dev/null || echo "0")
  CMD_FAILED=$(grep "\[${TASK_ID}\]" "${SPRITE_HOME}/logs/bash-commands.log" 2>/dev/null \
    | grep -cv '\[exit:0\]' || echo "0")

  local LOG_TAIL
  LOG_TAIL=$(tail -50 "$SESSION_LOG" 2>/dev/null || echo "(no log)")
  LOG_TAIL=$(sanitize_secrets "$LOG_TAIL")

  gh pr comment "$PR_NUM" --repo "$GITHUB_REPO" --body "$(cat <<EOF
## Session Report

| Metric | Value |
|---|---|
| Duration | ${DURATION}m |
| Commits | ${COMMIT_COUNT} |
| Files changed | ${FILES_CHANGED} |
| Bash commands | ${CMD_TOTAL} total, ${CMD_FAILED} failed |

<details>
<summary>Command log (last 50 lines)</summary>

\`\`\`
${LOG_TAIL}
\`\`\`

</details>
EOF
)" 2>/dev/null || log "Failed to post session report"
}

# ---------------------------------------------------------------------------
# Cleanup repo — thorough git reset between tasks
# ---------------------------------------------------------------------------
cleanup_repo() {
  local TARGET_BRANCH="${1:-$BASE_BRANCH}"
  log "Cleaning repo (target: ${TARGET_BRANCH})"

  cd "$REPO"

  # Abort any in-progress operations
  git rebase --abort 2>/dev/null || true
  git merge --abort 2>/dev/null || true
  git cherry-pick --abort 2>/dev/null || true

  # Fetch and hard-reset to target branch
  git fetch origin "$TARGET_BRANCH" 2>/dev/null || true
  git checkout "$TARGET_BRANCH" 2>/dev/null || true
  git reset --hard "origin/${TARGET_BRANCH}" 2>/dev/null || true

  # Remove untracked files but preserve environment & deps
  git clean -fd \
    --exclude='.env' \
    --exclude='.env.*' \
    --exclude='.env.local' \
    --exclude='node_modules' \
    2>/dev/null || true

  # Prune stale worktrees and remote refs
  git worktree prune 2>/dev/null || true
  git remote prune origin 2>/dev/null || true

  # Delete local feature/fix branches from previous tasks
  git branch --list 'feat/*' 'fix/*' | while read -r branch; do
    git branch -D "$branch" 2>/dev/null || true
  done

  log "Repo clean"
}

# ---------------------------------------------------------------------------
# Repair environment — fix common issues without full checkpoint restore
# ---------------------------------------------------------------------------
repair_env() {
  log "Repairing environment..."

  cd "$REPO"

  # Reinstall dependencies (most common fix)
  if [[ -f "pnpm-lock.yaml" ]]; then
    rm -rf node_modules 2>/dev/null || true
    # Also clear workspace node_modules
    find . -name "node_modules" -maxdepth 3 -type d -exec rm -rf {} + 2>/dev/null || true
    pnpm install 2>&1 | tail -5 | tee -a "${LOG_DIR}/builder.log"
  fi

  # Clear build caches
  rm -rf .next .turbo dist 2>/dev/null || true
  find . -name ".next" -maxdepth 3 -type d -exec rm -rf {} + 2>/dev/null || true
  find . -name ".turbo" -maxdepth 3 -type d -exec rm -rf {} + 2>/dev/null || true

  log "Environment repair complete"
}

# ---------------------------------------------------------------------------
# Handle env reset signal — create continuation issue, repair, continue
# ---------------------------------------------------------------------------
handle_env_reset() {
  if [[ ! -f "$ENV_RESET_SIGNAL" ]]; then
    return 1
  fi

  log "Environment reset signal detected"

  # Read the signal file
  local ORIGINAL_ISSUE ORIGINAL_TYPE ORIGINAL_TITLE BRANCH ISSUE_BASE REASON REMAINING CONTEXT
  ORIGINAL_ISSUE=$(jq -r '.original_issue // ""' "$ENV_RESET_SIGNAL")
  ORIGINAL_TYPE=$(jq -r '.original_type // "prd"' "$ENV_RESET_SIGNAL")
  ORIGINAL_TITLE=$(jq -r '.title // "unknown"' "$ENV_RESET_SIGNAL")
  BRANCH=$(jq -r '.branch // ""' "$ENV_RESET_SIGNAL")
  ISSUE_BASE=$(jq -r '.base_branch // "main"' "$ENV_RESET_SIGNAL")
  REASON=$(jq -r '.reason // "environment issue detected"' "$ENV_RESET_SIGNAL")
  REMAINING=$(jq -r '.remaining_work // "see original issue"' "$ENV_RESET_SIGNAL")
  CONTEXT=$(jq -r '.context // ""' "$ENV_RESET_SIGNAL")

  # Pause the original issue (not failed — it's resumable)
  if [[ -n "$ORIGINAL_ISSUE" ]]; then
    gh issue edit "$ORIGINAL_ISSUE" --repo "$GITHUB_REPO" \
      --remove-label "${ORIGINAL_TYPE}-running" \
      --add-label "${ORIGINAL_TYPE}-paused" 2>/dev/null || true
    gh issue comment "$ORIGINAL_ISSUE" --repo "$GITHUB_REPO" \
      --body "Environment reset needed: ${REASON}. Creating continuation issue." \
      2>/dev/null || true
  fi

  # Create continuation issue
  local CONT_TITLE="Continue #${ORIGINAL_ISSUE} — ${ORIGINAL_TITLE} (env reset)"
  local CONT_LABELS="prd-queued"
  [[ "$ISSUE_BASE" != "main" ]] && CONT_LABELS="${CONT_LABELS},base:${ISSUE_BASE}"

  local CONT_BODY
  CONT_BODY=$(cat <<EOF
## Environment Reset — Continue #${ORIGINAL_ISSUE}

**Original task:** #${ORIGINAL_ISSUE} — ${ORIGINAL_TITLE}
**Branch:** \`${BRANCH}\` (work pushed before reset)
**Reset reason:** ${REASON}

### Remaining Work
${REMAINING}

### Context
${CONTEXT}

---

Pull the existing branch \`${BRANCH}\`, verify it builds and tests pass after
env repair, then complete the remaining work. When creating the PR, reference
both issues:

\`\`\`
Closes #${ORIGINAL_ISSUE}
\`\`\`

The continuation PR should close both this issue and the original.
EOF
)

  local CONT_URL
  CONT_URL=$(gh issue create --repo "$GITHUB_REPO" \
    --title "$CONT_TITLE" \
    --body "$CONT_BODY" \
    --label "$CONT_LABELS" 2>/dev/null || echo "")

  if [[ -n "$CONT_URL" ]]; then
    log "Continuation issue created: ${CONT_URL}"
    notify "Env reset — paused #${ORIGINAL_ISSUE}, continuation: ${CONT_URL}
Reason: ${REASON}
Repairing environment and continuing..."
  else
    log "Failed to create continuation issue"
    notify "Env reset signal detected but failed to create continuation issue. Check logs."
  fi

  # Remove signal file
  rm -f "$ENV_RESET_SIGNAL"

  # Repair environment
  cleanup_repo "$BASE_BRANCH"
  repair_env

  log "Environment reset complete — resuming poll loop"
  return 0
}

# ---------------------------------------------------------------------------
# Invoke the agent — runtime-specific command, same prompt
#
# Usage: invoke_agent PROMPT TIMEOUT SESSION_LOG [TASK_KEY]
#   TASK_KEY — unique key for session resume (e.g. "pr-42", "prd-17", "bug-5").
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
      # Claude Code loads skills from .claude/skills/ automatically
      timeout "${AGENT_TIMEOUT}" claude \
        "${SESSION_FLAGS[@]}" \
        --dangerously-skip-permissions \
        -p "$PROMPT" \
        2>&1 | tee -a "$SESSION_LOG"
      ;;
    codex)
      # Codex loads skills from .agents/skills/ automatically
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
# Fix handler — apply review fixes to an existing PR
# ---------------------------------------------------------------------------
handle_fixes() {
  local PR_URL="$1"
  local PR_NUMBER="$2"
  local BRANCH
  BRANCH=$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPO" --json headRefName --jq '.headRefName')
  local SESSION_LOG="${LOG_DIR}/fix-pr-${PR_NUMBER}.log"
  local START_EPOCH
  START_EPOCH=$(date +%s)

  log "Fixing PR #${PR_NUMBER} on branch ${BRANCH}"
  notify "Fixing review items — PR #${PR_NUMBER} (${BRANCH})"

  # Get the latest changes_requested review body
  local REVIEW
  REVIEW=$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPO" --json reviews \
    --jq '[.reviews[] | select(.state == "CHANGES_REQUESTED")] | last | .body')

  # Resolve task key — find linked issue to resume the original build session
  local TASK_KEY="pr-${PR_NUMBER}"
  local PR_BODY
  PR_BODY=$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPO" --json body --jq '.body' 2>/dev/null || echo "")
  local LINKED_ISSUE
  LINKED_ISSUE=$(echo "$PR_BODY" | grep -oiE '(fix(es)?|close[sd]?|resolve[sd]?) #[0-9]+' | grep -oE '[0-9]+' | head -1 || echo "")
  if [[ -n "$LINKED_ISSUE" ]]; then
    # Check for original prd or bug session to resume
    if [[ -f "${SESSIONS_DIR}/prd-${LINKED_ISSUE}.id" ]]; then
      TASK_KEY="prd-${LINKED_ISSUE}"
    elif [[ -f "${SESSIONS_DIR}/bug-${LINKED_ISSUE}.id" ]]; then
      TASK_KEY="bug-${LINKED_ISSUE}"
    else
      log "No original session found for issue #${LINKED_ISSUE}, starting fresh"
    fi
  else
    log "No linked issue in PR #${PR_NUMBER} body, starting fresh session"
  fi

  # Checkout the branch
  cd "$REPO"
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git pull origin "$BRANCH"

  # Run Claude to apply fixes (shorter timeout for fixes)
  local FIX_TIMEOUT=$(( TIMEOUT / 4 ))  # 30 min for fixes
  local PROMPT="Review fixes requested on PR #${PR_NUMBER}.

The reviewer submitted these changes:

${REVIEW}

Apply each fix. Commit with conventional commits (fix: ...). Push when done.
Do NOT create a new PR — push to the existing branch: ${BRANCH}

After fixing, run the project's test and lint commands to verify."

  invoke_agent "$PROMPT" "${FIX_TIMEOUT}" "$SESSION_LOG" "$TASK_KEY" || {
    local EXIT_CODE=$?
    if [[ $EXIT_CODE -eq 124 ]]; then
      log "Fix session timed out after ${FIX_TIMEOUT}s"
      notify "Fix session timed out — PR #${PR_NUMBER}. Continuing to next task."
      return 1
    fi
  }

  # Check for env reset signal before continuing
  handle_env_reset && return 0

  # Re-request review by adding needs-review label
  gh pr edit "$PR_NUMBER" --repo "$GITHUB_REPO" --add-label "needs-review" 2>/dev/null || true

  local END_EPOCH
  END_EPOCH=$(date +%s)
  local DURATION=$(( (END_EPOCH - START_EPOCH) / 60 ))

  log "Fixes applied to PR #${PR_NUMBER} in ${DURATION}m"
  notify "Fixes applied — PR #${PR_NUMBER} (${DURATION}m). Re-submitted for review."

  # Thorough cleanup before next task
  cleanup_repo
}

# ---------------------------------------------------------------------------
# Bug handler — fix a bug from a GitHub Issue
# ---------------------------------------------------------------------------
handle_bug() {
  local ISSUE_NUMBER="$1"
  local BUG_ID="bug-${ISSUE_NUMBER}"
  local SESSION_LOG="${LOG_DIR}/${BUG_ID}.log"
  local START_EPOCH
  START_EPOCH=$(date +%s)

  # Read issue details
  local ISSUE_JSON
  ISSUE_JSON=$(gh issue view "$ISSUE_NUMBER" --repo "$GITHUB_REPO" --json title,body,labels)
  local TITLE
  TITLE=$(echo "$ISSUE_JSON" | jq -r '.title')
  local BODY
  BODY=$(echo "$ISSUE_JSON" | jq -r '.body')

  # Extract base branch from labels (e.g., "base:develop")
  local ISSUE_BASE
  ISSUE_BASE=$(echo "$ISSUE_JSON" | jq -r '.labels[] | select(.name | startswith("base:")) | .name[5:]' | head -1)
  ISSUE_BASE="${ISSUE_BASE:-$BASE_BRANCH}"

  log "Starting bug fix #${ISSUE_NUMBER}: ${TITLE} (base: ${ISSUE_BASE})"
  notify "Bug fix started: #${ISSUE_NUMBER} — ${TITLE}"

  # Claim the issue
  gh issue edit "$ISSUE_NUMBER" --repo "$GITHUB_REPO" \
    --remove-label "bug-queued" --add-label "bug-running" 2>/dev/null || true

  # Check if the thinker sprite left an investigation report
  local INVESTIGATION=""
  INVESTIGATION=$(gh issue view "$ISSUE_NUMBER" --repo "$GITHUB_REPO" --json comments \
    --jq '[.comments[] | select(.body | contains("## Investigation Report"))] | last | .body' 2>/dev/null || echo "")

  # Prepare repo
  cd "$REPO"
  git fetch origin "$ISSUE_BASE"
  git checkout "$ISSUE_BASE"
  git pull origin "$ISSUE_BASE"

  local BUG_TIMEOUT=$(( TIMEOUT / 2 ))  # 1 hour for bug fixes
  local PROMPT="Fix the bug described in issue #${ISSUE_NUMBER} for ${GITHUB_REPO}.

Title: ${TITLE}

Description:
${BODY}"

  if [[ -n "$INVESTIGATION" ]] && [[ "$INVESTIGATION" != "null" ]]; then
    PROMPT="${PROMPT}

Investigation report from the thinker sprite:
${INVESTIGATION}"
  fi

  PROMPT="${PROMPT}

Create a branch named fix/${ISSUE_NUMBER}, fix the bug, write a test that reproduces it,
commit with conventional commits (fix: ...), push, and create a PR.
Reference the issue: Fixes #${ISSUE_NUMBER}
Run the project's test and lint commands to verify before creating the PR."

  invoke_agent "$PROMPT" "${BUG_TIMEOUT}" "$SESSION_LOG" "bug-${ISSUE_NUMBER}" || {
    local EXIT_CODE=$?
    if [[ $EXIT_CODE -eq 124 ]]; then
      log "Bug fix ${BUG_ID} timed out after ${BUG_TIMEOUT}s"
      notify "Bug fix #${ISSUE_NUMBER} timed out. Check logs."
    fi
  }

  # Check for env reset signal before continuing
  handle_env_reset && return 0

  # Check if a PR was created (look for it by branch name)
  local PR_URL=""
  PR_URL=$(gh pr list --repo "$GITHUB_REPO" --head "fix/${ISSUE_NUMBER}" \
    --json url --jq '.[0].url' 2>/dev/null || echo "")

  if [[ -n "$PR_URL" ]] && [[ "$PR_URL" != "null" ]]; then
    gh issue edit "$ISSUE_NUMBER" --repo "$GITHUB_REPO" \
      --remove-label "bug-running" --add-label "bug-complete" 2>/dev/null || true

    # Label the PR for review by the thinker sprite
    local PR_NUM
    PR_NUM=$(echo "$PR_URL" | grep -oE '[0-9]+$')
    gh pr edit "$PR_NUM" --repo "$GITHUB_REPO" --add-label "needs-review" 2>/dev/null || true
  else
    gh issue edit "$ISSUE_NUMBER" --repo "$GITHUB_REPO" \
      --remove-label "bug-running" --add-label "bug-failed" 2>/dev/null || true
    notify "Bug fix #${ISSUE_NUMBER} finished without creating a PR. Check logs."
  fi

  local END_EPOCH
  END_EPOCH=$(date +%s)
  local DURATION=$(( (END_EPOCH - START_EPOCH) / 60 ))
  log "Bug fix #${ISSUE_NUMBER} complete in ${DURATION}m"
  notify "Bug fix complete: #${ISSUE_NUMBER} — ${TITLE} (${DURATION}m)${PR_URL:+
PR: ${PR_URL}}"

  # Thorough cleanup before next task
  cleanup_repo
}

# ---------------------------------------------------------------------------
# PRD handler — process a new prompt from a GitHub Issue
# ---------------------------------------------------------------------------
handle_prd() {
  local ISSUE_NUMBER="$1"
  local PRD_ID="prd-${ISSUE_NUMBER}"
  local SESSION_LOG="${LOG_DIR}/${PRD_ID}.log"
  local START_EPOCH
  START_EPOCH=$(date +%s)

  # Read issue details
  local ISSUE_JSON
  ISSUE_JSON=$(gh issue view "$ISSUE_NUMBER" --repo "$GITHUB_REPO" --json title,body,labels)
  local TITLE
  TITLE=$(echo "$ISSUE_JSON" | jq -r '.title')
  local BODY
  BODY=$(echo "$ISSUE_JSON" | jq -r '.body')

  # Extract base branch from labels (e.g., "base:develop")
  local ISSUE_BASE
  ISSUE_BASE=$(echo "$ISSUE_JSON" | jq -r '.labels[] | select(.name | startswith("base:")) | .name[5:]' | head -1)
  ISSUE_BASE="${ISSUE_BASE:-$BASE_BRANCH}"

  log "Starting PRD #${ISSUE_NUMBER}: ${TITLE} (base: ${ISSUE_BASE})"
  notify "PRD started: #${ISSUE_NUMBER} — ${TITLE} (base: ${ISSUE_BASE})"

  # Claim the issue
  gh issue edit "$ISSUE_NUMBER" --repo "$GITHUB_REPO" \
    --remove-label "prd-queued" --add-label "prd-running" 2>/dev/null || true

  # Write prompt to local file for the skill
  mkdir -p "${SPRITE_HOME}/prd-inbox"
  echo "$BODY" > "${SPRITE_HOME}/prd-inbox/${PRD_ID}.md"

  # Prepare repo
  cd "$REPO"
  git fetch origin "$ISSUE_BASE"
  git checkout "$ISSUE_BASE"
  git pull origin "$ISSUE_BASE"

  # Write structured task context for the agent
  local BRANCH_NAME="feat/${PRD_ID}"
  cat > "/tmp/task-context-${PRD_ID}.json" <<CTXEOF
{
  "prd_id": "${PRD_ID}",
  "base_branch": "${ISSUE_BASE}",
  "branch": "${BRANCH_NAME}",
  "prompt_file": "${SPRITE_HOME}/prd-inbox/${PRD_ID}.md",
  "repo": "${REPO}",
  "github_repo": "${GITHUB_REPO}",
  "issue_number": ${ISSUE_NUMBER}
}
CTXEOF

  local PROMPT="New task. Context file: /tmp/task-context-${PRD_ID}.json — use the sodaprompts-builder skill for the full workflow."

  invoke_agent "$PROMPT" "${TIMEOUT}" "$SESSION_LOG" "prd-${ISSUE_NUMBER}" || {
    local EXIT_CODE=$?
    if [[ $EXIT_CODE -eq 124 ]]; then
      log "PRD ${PRD_ID} timed out after ${TIMEOUT}s"
      notify "PRD #${ISSUE_NUMBER} timed out after $((TIMEOUT / 60)) minutes. Check logs."
    fi
  }

  # Check for env reset signal before continuing
  handle_env_reset && return 0

  # Read structured completion artifact if the agent wrote one
  local COMPLETION_FILE="${COMPLETIONS_DIR}/${PRD_ID}.json"
  local PR_URL=""

  if [[ -f "$COMPLETION_FILE" ]]; then
    local COMP_STATUS
    COMP_STATUS=$(jq -r '.status // "unknown"' "$COMPLETION_FILE")
    PR_URL=$(jq -r '.pr_url // ""' "$COMPLETION_FILE")
    log "Completion artifact: status=${COMP_STATUS}, pr=${PR_URL:-none}"
  else
    # Fallback: detect PR by branch name (agent didn't write artifact)
    log "No completion artifact — falling back to branch name detection"
    PR_URL=$(gh pr list --repo "$GITHUB_REPO" --head "$BRANCH_NAME" \
      --json url --jq '.[0].url' 2>/dev/null || echo "")
  fi

  # Clean up context file
  rm -f "/tmp/task-context-${PRD_ID}.json"

  local END_EPOCH
  END_EPOCH=$(date +%s)
  local DURATION=$(( (END_EPOCH - START_EPOCH) / 60 ))

  # Update the issue and post session report
  if [[ -n "$PR_URL" ]] && [[ "$PR_URL" != "null" ]]; then
    gh issue comment "$ISSUE_NUMBER" --repo "$GITHUB_REPO" --body "PR created: ${PR_URL}" 2>/dev/null || true
    gh issue close "$ISSUE_NUMBER" --repo "$GITHUB_REPO" 2>/dev/null || true
    gh issue edit "$ISSUE_NUMBER" --repo "$GITHUB_REPO" \
      --remove-label "prd-running" --add-label "prd-complete" 2>/dev/null || true

    # Label the PR for review
    local PR_NUM
    PR_NUM=$(echo "$PR_URL" | grep -oE '[0-9]+$')
    gh pr edit "$PR_NUM" --repo "$GITHUB_REPO" --add-label "needs-review" 2>/dev/null || true

    # Post session report to the PR
    post_session_report "$PR_NUM" "$PRD_ID" "$DURATION" "$SESSION_LOG"
  else
    gh issue edit "$ISSUE_NUMBER" --repo "$GITHUB_REPO" \
      --remove-label "prd-running" --add-label "prd-failed" 2>/dev/null || true
    notify "PRD #${ISSUE_NUMBER} finished without creating a PR. Check logs."
  fi

  log "PRD #${ISSUE_NUMBER} complete in ${DURATION}m"
  notify "PRD complete: #${ISSUE_NUMBER} — ${TITLE} (${DURATION}m)${PR_URL:+
PR: ${PR_URL}}"

  # Thorough cleanup before next task
  cleanup_repo
}

# ---------------------------------------------------------------------------
# Main loop — poll until idle timeout, then exit (sprite suspends)
# ---------------------------------------------------------------------------
log "Builder sprite starting (poll: ${POLL_INTERVAL}s, idle timeout: ${IDLE_TIMEOUT}s, runtime: ${AGENT_RUNTIME})"
notify "Builder sprite online. Runtime: ${AGENT_RUNTIME}. Polling GitHub for work."

# Clean repo state on startup (in case previous session left debris)
cleanup_repo

# Prune session files older than 7 days
find "$SESSIONS_DIR" -name '*.id' -mtime +7 -delete 2>/dev/null || true

# Check if a previous session requested env reset
if handle_env_reset; then
  log "Processed env reset from previous session"
fi

LAST_WORK_EPOCH=$(date +%s)

while true; do
  FOUND_WORK=false

  # Priority 1: Check for PRs needing fixes (changes_requested)
  FIX_PR=$(gh pr list --repo "$GITHUB_REPO" --author "@me" \
    --search "review:changes_requested" \
    --json number,url --jq '.[0]' 2>/dev/null || echo "null")

  if [[ "$FIX_PR" != "null" ]] && [[ -n "$FIX_PR" ]]; then
    PR_NUMBER=$(echo "$FIX_PR" | jq -r '.number')
    PR_URL=$(echo "$FIX_PR" | jq -r '.url')

    if [[ -n "$PR_NUMBER" ]] && [[ "$PR_NUMBER" != "null" ]]; then
      handle_fixes "$PR_URL" "$PR_NUMBER" || true
      FOUND_WORK=true
    fi
  fi

  # Priority 2: Check for queued bugs
  if [[ "$FOUND_WORK" == false ]]; then
    BUG_NUMBER=$(gh issue list --repo "$GITHUB_REPO" \
      --label "bug-queued" --sort created --state open \
      --json number --jq '.[0].number' 2>/dev/null || echo "")

    if [[ -n "$BUG_NUMBER" ]] && [[ "$BUG_NUMBER" != "null" ]]; then
      handle_bug "$BUG_NUMBER" || true
      FOUND_WORK=true
    fi
  fi

  # Priority 3: Check for queued PRDs (new features)
  if [[ "$FOUND_WORK" == false ]]; then
    ISSUE_NUMBER=$(gh issue list --repo "$GITHUB_REPO" \
      --label "prd-queued" --sort created --state open \
      --json number --jq '.[0].number' 2>/dev/null || echo "")

    if [[ -n "$ISSUE_NUMBER" ]] && [[ "$ISSUE_NUMBER" != "null" ]]; then
      handle_prd "$ISSUE_NUMBER" || true
      FOUND_WORK=true
    fi
  fi

  # Reset idle timer when work was found
  if [[ "$FOUND_WORK" == true ]]; then
    LAST_WORK_EPOCH=$(date +%s)
    continue  # check for more work immediately
  fi

  # Check idle timeout
  NOW=$(date +%s)
  IDLE_SECS=$(( NOW - LAST_WORK_EPOCH ))
  if [[ $IDLE_SECS -ge $IDLE_TIMEOUT ]]; then
    log "Idle for ${IDLE_SECS}s (limit: ${IDLE_TIMEOUT}s). Exiting — sprite will suspend."
    notify "Builder sprite going to sleep (idle ${IDLE_TIMEOUT}s). Will wake on next shipment."
    exit 0
  fi

  sleep "$POLL_INTERVAL"
done
