#!/usr/bin/env bash
# =============================================================================
# run-builder.sh — Daytona sandbox builder
#
# Handles a single task and exits. No polling, no idle timeout.
# Task type and work item are passed as env vars from the GitHub Action.
#
# Supports both Claude Code and Codex as the agent runtime.
# =============================================================================

set -euo pipefail

SANDBOX_HOME="${SANDBOX_HOME:-/home/daytona}"
REPO="${REPO:-${SANDBOX_HOME}/repo}"
LOG_DIR="${SANDBOX_HOME}/.claude/logs"
SESSIONS_DIR="${SANDBOX_HOME}/.claude/sessions"
TASK_TIMEOUT="${TASK_TIMEOUT:-7200}"  # 2 hour default per session
AGENT_RUNTIME="${AGENT_RUNTIME:-claude}"
RUNNER_NAME="builder"
PROMPTS_DIR="${PROMPTS_DIR:-/opt/openthrottle/prompts}"

: "${GITHUB_REPO:?GITHUB_REPO is required}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${TASK_TYPE:?TASK_TYPE is required}"
: "${WORK_ITEM:?WORK_ITEM is required}"

mkdir -p "$LOG_DIR" "$SESSIONS_DIR"

# Source shared libraries
source /opt/openthrottle/agent-lib.sh
source /opt/openthrottle/task-adapter.sh

# Read config
BASE_BRANCH="${BASE_BRANCH:-main}"
CONFIG="${REPO}/.openthrottle.yml"

read_config() {
  yq -r "$1 // \"$2\"" "$CONFIG" 2>/dev/null || echo "$2"
}

# Read project commands from config
export TEST_CMD=$(read_config '.test' '')
export LINT_CMD=$(read_config '.lint' '')
export BUILD_CMD=$(read_config '.build' '')
export FORMAT_CMD=$(read_config '.format' '')
export DEV_CMD=$(read_config '.dev' '')

# ---------------------------------------------------------------------------
# Supabase block — injected into prompt only if Supabase MCP is configured
# ---------------------------------------------------------------------------
SUPABASE_BLOCK=""
if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  SUPABASE_BLOCK="---

## Supabase Branching

A Supabase MCP is available for isolated DB work.

- **Create lazily** — write code first, only create \`openthrottle-\${TASK_ID}\`
  when you need to test against a real DB.
- **Delete eagerly** — delete immediately after tests pass.
- **Orphan cleanup** — at session start, list and delete any \`openthrottle-*\`
  branches left from crashed sessions.
- **No migrations** — write migration files for the PR. Don't run them."
fi
export SUPABASE_BLOCK

# ---------------------------------------------------------------------------
# build_prompt — expand a template file with environment variables
#
# Uses envsubst with an explicit variable list to avoid expanding template
# examples or code snippets that contain ${} references.
# ---------------------------------------------------------------------------
EXPAND_VARS='$GITHUB_REPO $ISSUE_NUMBER $PR_NUMBER $TITLE $BRANCH_NAME $BASE_BRANCH $TASK_FILE $TASK_ID $INVESTIGATION_BLOCK $SUPABASE_BLOCK $TEST_CMD $LINT_CMD $BUILD_CMD $FORMAT_CMD $DEV_CMD'

build_prompt() {
  local TEMPLATE="$1"
  envsubst "$EXPAND_VARS" < "${PROMPTS_DIR}/${TEMPLATE}"
}

# ---------------------------------------------------------------------------
# Trap: clean up task state on unexpected termination
# ---------------------------------------------------------------------------
cleanup() {
  local EXIT_CODE=$?
  if [[ $EXIT_CODE -ne 0 ]]; then
    log "Builder exited with code ${EXIT_CODE} — cleaning up"
    case "$TASK_TYPE" in
      prd) task_transition "$WORK_ITEM" "prd-running" "prd-failed" 2>/dev/null || true ;;
      bug) task_transition "$WORK_ITEM" "bug-running" "bug-failed" 2>/dev/null || true ;;
    esac
    notify "Builder failed (exit ${EXIT_CODE}) on ${TASK_TYPE} #${WORK_ITEM}"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Handle review fixes (changes_requested on an existing PR)
# ---------------------------------------------------------------------------
handle_fixes() {
  local PR_NUMBER="$1"
  export PR_NUMBER
  local SESSION_LOG="${LOG_DIR}/fix-pr-${PR_NUMBER}.log"
  local START_EPOCH
  START_EPOCH=$(date +%s)

  local BRANCH_NAME
  BRANCH_NAME=$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPO" --json headRefName --jq '.headRefName') || {
    log "FATAL: Could not fetch PR #${PR_NUMBER} metadata"
    notify "Fix failed — could not fetch PR #${PR_NUMBER}"
    return 1
  }
  export BRANCH_NAME

  log "Fixing PR #${PR_NUMBER} on branch ${BRANCH_NAME}"
  notify "Fixing review items — PR #${PR_NUMBER} (${BRANCH_NAME})"

  local REVIEW
  REVIEW=$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPO" --json reviews \
    --jq '[.reviews[] | select(.state == "CHANGES_REQUESTED")] | last | .body')

  cd "$REPO"
  git fetch origin "$BRANCH_NAME"
  git checkout "$BRANCH_NAME"
  git pull origin "$BRANCH_NAME"

  # Record HEAD before agent runs (to detect if commits were pushed)
  local HEAD_BEFORE
  HEAD_BEFORE=$(git rev-parse HEAD)

  # Write untrusted content to file
  export TASK_FILE="/tmp/task-fix-${PR_NUMBER}.md"
  echo "$REVIEW" > "$TASK_FILE"

  local FIX_TIMEOUT=$(( TASK_TIMEOUT / 4 ))
  local PROMPT
  PROMPT=$(build_prompt "review-fix.md")

  invoke_agent "$PROMPT" "${FIX_TIMEOUT}" "$SESSION_LOG" || true
  handle_agent_result $? "Fix PR #${PR_NUMBER}" "$FIX_TIMEOUT" || true

  rm -f "$TASK_FILE"

  # Only re-request review if new commits were pushed
  local HEAD_AFTER
  HEAD_AFTER=$(git rev-parse HEAD 2>/dev/null || echo "$HEAD_BEFORE")

  if [[ "$HEAD_AFTER" != "$HEAD_BEFORE" ]]; then
    if ! gh pr edit "$PR_NUMBER" --repo "$GITHUB_REPO" --add-label "needs-review" 2>&1; then
      log "WARNING: Failed to add 'needs-review' label to PR #${PR_NUMBER}"
      notify "WARNING: Could not label PR #${PR_NUMBER} for review"
    fi
  else
    log "No new commits pushed — skipping re-review label"
    gh pr comment "$PR_NUMBER" --repo "$GITHUB_REPO" \
      --body "Fix attempt completed but no new commits were pushed. Manual intervention may be needed." 2>/dev/null || true
    notify "Fix attempt for PR #${PR_NUMBER} produced no new commits — manual review needed"
  fi

  local END_EPOCH
  END_EPOCH=$(date +%s)
  local DURATION=$(( (END_EPOCH - START_EPOCH) / 60 ))

  log "Fixes applied to PR #${PR_NUMBER} in ${DURATION}m"
  notify "Fixes applied — PR #${PR_NUMBER} (${DURATION}m)"
  post_session_report "$PR_NUMBER" "fix-${PR_NUMBER}" "$DURATION" "$SESSION_LOG"
}

# ---------------------------------------------------------------------------
# Handle bug fix
# ---------------------------------------------------------------------------
handle_bug() {
  local ISSUE_NUMBER="$1"
  export ISSUE_NUMBER
  local TASK_ID="bug-${ISSUE_NUMBER}"
  export TASK_ID
  local SESSION_LOG="${LOG_DIR}/${TASK_ID}.log"
  local START_EPOCH
  START_EPOCH=$(date +%s)

  local ISSUE_JSON
  ISSUE_JSON=$(task_view "$ISSUE_NUMBER" --json title,body,labels) || {
    log "FATAL: Could not fetch issue #${ISSUE_NUMBER}"
    notify "Bug fix failed — could not fetch issue #${ISSUE_NUMBER}"
    return 1
  }
  local TITLE
  TITLE=$(echo "$ISSUE_JSON" | jq -r '.title')
  export TITLE
  local BODY
  BODY=$(echo "$ISSUE_JSON" | jq -r '.body')

  local ISSUE_BASE
  ISSUE_BASE=$(echo "$ISSUE_JSON" | jq -r '.labels[] | select(.name | startswith("base:")) | .name[5:]' | head -1)
  ISSUE_BASE="${ISSUE_BASE:-$BASE_BRANCH}"

  log "Starting bug fix #${ISSUE_NUMBER}: ${TITLE} (base: ${ISSUE_BASE})"
  notify "Bug fix started: #${ISSUE_NUMBER} — ${TITLE}"

  task_transition "$ISSUE_NUMBER" "bug-queued" "bug-running"

  local INVESTIGATION=""
  INVESTIGATION=$(task_read_comments "$ISSUE_NUMBER" "## Investigation Report")

  # Build investigation block for template
  export INVESTIGATION_BLOCK=""
  if [[ -n "$INVESTIGATION" ]] && [[ "$INVESTIGATION" != "null" ]]; then
    local INVESTIGATION_FILE="/tmp/investigation-${ISSUE_NUMBER}.md"
    echo "$INVESTIGATION" > "$INVESTIGATION_FILE"
    INVESTIGATION_BLOCK="### Investigation Report

An investigation report is available from a prior analysis session. Read it
before starting — it already traced the root cause. Re-investigating wastes
a full session.

Read the report at \`${INVESTIGATION_FILE}\`."
    export INVESTIGATION_BLOCK
  fi

  cd "$REPO"
  git fetch origin "$ISSUE_BASE"
  git checkout "$ISSUE_BASE"
  git pull origin "$ISSUE_BASE"

  # Create the fix branch deterministically
  local BRANCH_NAME="fix/${ISSUE_NUMBER}"
  export BRANCH_NAME
  git checkout -b "$BRANCH_NAME"
  log "Created branch ${BRANCH_NAME} from ${ISSUE_BASE}"

  # Write untrusted content to file
  export TASK_FILE="/tmp/task-${TASK_ID}.md"
  echo "$BODY" > "$TASK_FILE"

  local BUG_TIMEOUT=$(( TASK_TIMEOUT / 2 ))
  local PROMPT
  PROMPT=$(build_prompt "bug.md")

  invoke_agent "$PROMPT" "${BUG_TIMEOUT}" "$SESSION_LOG" "${TASK_ID}" || true
  handle_agent_result $? "Bug #${ISSUE_NUMBER}" "$BUG_TIMEOUT" || true

  rm -f "$TASK_FILE" "/tmp/investigation-${ISSUE_NUMBER}.md" 2>/dev/null

  local PR_URL=""
  PR_URL=$(gh pr list --repo "$GITHUB_REPO" --head "$BRANCH_NAME" \
    --json url --jq '.[0].url' 2>&1) || {
    log "WARNING: Failed to query GitHub for PR on branch ${BRANCH_NAME}: ${PR_URL}"
    PR_URL=""
  }

  local END_EPOCH
  END_EPOCH=$(date +%s)
  local DURATION=$(( (END_EPOCH - START_EPOCH) / 60 ))

  if [[ -n "$PR_URL" ]] && [[ "$PR_URL" != "null" ]]; then
    task_transition "$ISSUE_NUMBER" "bug-running" "bug-complete"
    local PR_NUM
    PR_NUM=$(echo "$PR_URL" | grep -oE '[0-9]+$')
    if ! gh pr edit "$PR_NUM" --repo "$GITHUB_REPO" --add-label "needs-review" 2>&1; then
      log "WARNING: Failed to add 'needs-review' label to PR #${PR_NUM} — review pipeline may not trigger"
      notify "WARNING: Could not label PR #${PR_NUM} for review"
    fi
    post_session_report "$PR_NUM" "$TASK_ID" "$DURATION" "$SESSION_LOG"
  else
    task_transition "$ISSUE_NUMBER" "bug-running" "bug-failed"
    notify "Bug fix #${ISSUE_NUMBER} finished without creating a PR"
  fi

  log "Bug fix #${ISSUE_NUMBER} complete in ${DURATION}m"
  notify "Bug fix complete: #${ISSUE_NUMBER} — ${TITLE} (${DURATION}m)${PR_URL:+
PR: ${PR_URL}}"
}

# ---------------------------------------------------------------------------
# Handle PRD (new feature)
# ---------------------------------------------------------------------------
handle_prd() {
  local ISSUE_NUMBER="$1"
  export ISSUE_NUMBER
  local TASK_ID="prd-${ISSUE_NUMBER}"
  export TASK_ID
  local SESSION_LOG="${LOG_DIR}/${TASK_ID}.log"
  local START_EPOCH
  START_EPOCH=$(date +%s)

  local ISSUE_JSON
  ISSUE_JSON=$(task_view "$ISSUE_NUMBER" --json title,body,labels) || {
    log "FATAL: Could not fetch issue #${ISSUE_NUMBER}"
    notify "PRD failed — could not fetch issue #${ISSUE_NUMBER}"
    return 1
  }
  local TITLE
  TITLE=$(echo "$ISSUE_JSON" | jq -r '.title')
  export TITLE
  local BODY
  BODY=$(echo "$ISSUE_JSON" | jq -r '.body')

  local ISSUE_BASE
  ISSUE_BASE=$(echo "$ISSUE_JSON" | jq -r '.labels[] | select(.name | startswith("base:")) | .name[5:]' | head -1)
  ISSUE_BASE="${ISSUE_BASE:-$BASE_BRANCH}"

  log "Starting PRD #${ISSUE_NUMBER}: ${TITLE} (base: ${ISSUE_BASE})"
  notify "PRD started: #${ISSUE_NUMBER} — ${TITLE} (base: ${ISSUE_BASE})"

  task_transition "$ISSUE_NUMBER" "prd-queued" "prd-running"

  cd "$REPO"
  git fetch origin "$ISSUE_BASE"
  git checkout "$ISSUE_BASE"
  git pull origin "$ISSUE_BASE"

  # Create the feature branch deterministically
  local BRANCH_NAME="feat/${TASK_ID}"
  export BRANCH_NAME
  git checkout -b "$BRANCH_NAME"
  log "Created branch ${BRANCH_NAME} from ${ISSUE_BASE}"

  # Write untrusted content to file
  export TASK_FILE="/tmp/task-${TASK_ID}.md"
  echo "$BODY" > "$TASK_FILE"

  local PROMPT
  PROMPT=$(build_prompt "prd.md")

  invoke_agent "$PROMPT" "${TASK_TIMEOUT}" "$SESSION_LOG" "${TASK_ID}" || true
  handle_agent_result $? "PRD #${ISSUE_NUMBER}" "$TASK_TIMEOUT" || true

  rm -f "$TASK_FILE"

  local PR_URL=""
  PR_URL=$(gh pr list --repo "$GITHUB_REPO" --head "$BRANCH_NAME" \
    --json url --jq '.[0].url' 2>&1) || {
    log "WARNING: Failed to query GitHub for PR on branch ${BRANCH_NAME}: ${PR_URL}"
    PR_URL=""
  }

  local END_EPOCH
  END_EPOCH=$(date +%s)
  local DURATION=$(( (END_EPOCH - START_EPOCH) / 60 ))

  if [[ -n "$PR_URL" ]] && [[ "$PR_URL" != "null" ]]; then
    task_comment "$ISSUE_NUMBER" "PR created: ${PR_URL}"
    task_close "$ISSUE_NUMBER"
    task_transition "$ISSUE_NUMBER" "prd-running" "prd-complete"

    local PR_NUM
    PR_NUM=$(echo "$PR_URL" | grep -oE '[0-9]+$')
    if ! gh pr edit "$PR_NUM" --repo "$GITHUB_REPO" --add-label "needs-review" 2>&1; then
      log "WARNING: Failed to add 'needs-review' label to PR #${PR_NUM} — review pipeline may not trigger"
      notify "WARNING: Could not label PR #${PR_NUM} for review"
    fi
    post_session_report "$PR_NUM" "$TASK_ID" "$DURATION" "$SESSION_LOG"
  else
    task_transition "$ISSUE_NUMBER" "prd-running" "prd-failed"
    notify "PRD #${ISSUE_NUMBER} finished without creating a PR"
  fi

  log "PRD #${ISSUE_NUMBER} complete in ${DURATION}m"
  notify "PRD complete: #${ISSUE_NUMBER} — ${TITLE} (${DURATION}m)${PR_URL:+
PR: ${PR_URL}}"
}

# ---------------------------------------------------------------------------
# Main — single task dispatch, then exit
# ---------------------------------------------------------------------------
log "Builder starting (task: ${TASK_TYPE} #${WORK_ITEM}, runtime: ${AGENT_RUNTIME})"
notify "Builder online: ${TASK_TYPE} #${WORK_ITEM} (${AGENT_RUNTIME})"

# Prune session files older than 7 days
find "$SESSIONS_DIR" -name '*.id' -mtime +7 -delete 2>/dev/null || true

# Clean up orphaned Supabase branches from crashed sessions.
# Only runs if the Supabase MCP is configured (SUPABASE_ACCESS_TOKEN set).
if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" ]] && command -v npx &>/dev/null; then
  ORPHAN_BRANCHES=$(npx -y @supabase/mcp-server list_branches 2>/dev/null \
    | jq -r '.[] | select(.name | startswith("openthrottle-")) | .name' 2>/dev/null || true)
  if [[ -n "$ORPHAN_BRANCHES" ]]; then
    log "Cleaning up orphaned Supabase branches"
    while IFS= read -r branch; do
      log "  Deleting orphaned branch: $branch"
      npx -y @supabase/mcp-server delete_branch --name "$branch" 2>/dev/null || true
    done <<< "$ORPHAN_BRANCHES"
  fi
fi

# If using Claude via Agent SDK, delegate to TypeScript orchestrator
if [[ "$AGENT_RUNTIME" == "claude" ]] && [[ -f /opt/openthrottle/orchestrator/dist/index.js ]]; then
  log "Delegating to Agent SDK orchestrator"
  exec node /opt/openthrottle/orchestrator/dist/index.js
fi

case "$TASK_TYPE" in
  prd)        handle_prd "$WORK_ITEM" ;;
  bug)        handle_bug "$WORK_ITEM" ;;
  review-fix) handle_fixes "$WORK_ITEM" ;;
  *)
    log "Unknown TASK_TYPE for builder: ${TASK_TYPE}"
    exit 1
    ;;
esac

log "Builder finished"
