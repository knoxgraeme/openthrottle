#!/usr/bin/env bash
# =============================================================================
# run-reviewer.sh — Daytona sandbox reviewer
#
# Handles a single review or investigation task and exits.
# No polling, no idle timeout — ephemeral sandbox per task.
#
# Supports both Claude Code and Codex as the agent runtime.
# =============================================================================

set -euo pipefail

SANDBOX_HOME="${SANDBOX_HOME:-/home/daytona}"
REPO="${REPO:-${SANDBOX_HOME}/repo}"
LOG_DIR="${SANDBOX_HOME}/.claude/logs"
SESSIONS_DIR="${SANDBOX_HOME}/.claude/sessions"
TASK_TIMEOUT="${TASK_TIMEOUT:-1800}"  # 30 min per task
MAX_REVIEW_ROUNDS="${MAX_REVIEW_ROUNDS:-3}"
AGENT_RUNTIME="${AGENT_RUNTIME:-claude}"
RUNNER_NAME="reviewer"
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

if [[ -f "$CONFIG" ]]; then
  MAX_REVIEW_ROUNDS=$(read_config '.review.max_rounds' "$MAX_REVIEW_ROUNDS")
fi

# Read project commands from config
export TEST_CMD=$(read_config '.test' '')
export LINT_CMD=$(read_config '.lint' '')
export BUILD_CMD=$(read_config '.build' '')
export FORMAT_CMD=$(read_config '.format' '')
export DEV_CMD=$(read_config '.dev' '')

# ---------------------------------------------------------------------------
# build_prompt — expand a template file with environment variables
# ---------------------------------------------------------------------------
EXPAND_VARS='$GITHUB_REPO $ISSUE_NUMBER $PR_NUMBER $TITLE $BRANCH_NAME $BASE_BRANCH $TASK_FILE $BUILDER_FILE $REVIEW_ROUND $MAX_REVIEW_ROUNDS $RE_REVIEW_BLOCK $TEST_CMD $LINT_CMD $BUILD_CMD $FORMAT_CMD $DEV_CMD'

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
    log "Reviewer exited with code ${EXIT_CODE} — cleaning up"
    case "$TASK_TYPE" in
      review)
        gh pr edit "$WORK_ITEM" --repo "$GITHUB_REPO" \
          --remove-label "reviewing" --add-label "needs-review" 2>/dev/null || true
        ;;
      investigation)
        task_transition "$WORK_ITEM" "investigating" "needs-investigation" 2>/dev/null || true
        ;;
    esac
    notify "Reviewer failed (exit ${EXIT_CODE}) on ${TASK_TYPE} #${WORK_ITEM}"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# PR Review
# ---------------------------------------------------------------------------
review_pr() {
  local PR_NUMBER="$1"
  export PR_NUMBER
  local SESSION_LOG="${LOG_DIR}/review-pr-${PR_NUMBER}.log"

  local REVIEW_COUNT
  REVIEW_COUNT=$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPO" --json reviews \
    --jq '[.reviews[] | select(.state == "CHANGES_REQUESTED")] | length' 2>/dev/null || echo "0")

  if [[ "$REVIEW_COUNT" -ge "$MAX_REVIEW_ROUNDS" ]]; then
    log "PR #${PR_NUMBER} hit max rounds (${MAX_REVIEW_ROUNDS}). Auto-approving."
    gh pr edit "$PR_NUMBER" --repo "$GITHUB_REPO" --remove-label "needs-review" 2>/dev/null || true
    if ! gh pr review "$PR_NUMBER" --repo "$GITHUB_REPO" --approve \
      --body "Auto-approved after ${MAX_REVIEW_ROUNDS} review rounds. Please review manually." 2>&1; then
      log "WARNING: Auto-approval failed for PR #${PR_NUMBER} — may require manual approval"
      notify "WARNING: Auto-approval failed for PR #${PR_NUMBER}"
    fi
    notify "PR #${PR_NUMBER} auto-approved after ${MAX_REVIEW_ROUNDS} rounds."
    return 0
  fi

  local REVIEW_ROUND=$((REVIEW_COUNT + 1))
  export REVIEW_ROUND
  export MAX_REVIEW_ROUNDS

  gh pr edit "$PR_NUMBER" --repo "$GITHUB_REPO" \
    --remove-label "needs-review" --add-label "reviewing" 2>/dev/null || true

  log "Reviewing PR #${PR_NUMBER} (round ${REVIEW_ROUND}/${MAX_REVIEW_ROUNDS})"
  notify "Reviewing PR #${PR_NUMBER} (round ${REVIEW_ROUND})"

  # Fetch PR metadata
  local PR_JSON
  PR_JSON=$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPO" \
    --json body,title,headRefName,state) || {
    log "FATAL: Could not fetch PR #${PR_NUMBER} from GitHub API"
    notify "Review failed — could not fetch PR #${PR_NUMBER}"
    return 1
  }

  local PR_BODY
  PR_BODY=$(echo "$PR_JSON" | jq -r '.body // ""')
  local BRANCH_NAME
  BRANCH_NAME=$(echo "$PR_JSON" | jq -r '.headRefName // ""')
  export BRANCH_NAME

  if [[ -z "$BRANCH_NAME" ]]; then
    log "FATAL: PR #${PR_NUMBER} has no head branch"
    return 1
  fi

  # Extract linked issue
  local LINKED_ISSUE=""
  LINKED_ISSUE=$(echo "$PR_BODY" | grep -oiE '(fix(es)?|close[sd]?|resolve[sd]?) #[0-9]+' \
    | grep -oE '[0-9]+' | head -1 || echo "")

  # Write original task to file
  export TASK_FILE="/tmp/review-task-${PR_NUMBER}.md"
  if [[ -n "$LINKED_ISSUE" ]]; then
    local ORIGINAL_TASK=""
    ORIGINAL_TASK=$(task_view "$LINKED_ISSUE" --json body --jq '.body' 2>/dev/null || echo "")
    echo "${ORIGINAL_TASK:-No linked issue content found.}" > "$TASK_FILE"
    log "Found linked issue #${LINKED_ISSUE}"
  else
    echo "No linked issue found. Skip task alignment phase." > "$TASK_FILE"
  fi

  # Write builder review notes to file
  export BUILDER_FILE="/tmp/review-builder-${PR_NUMBER}.md"
  local BUILDER_REVIEW=""
  BUILDER_REVIEW=$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPO" --json comments \
    --jq '[.comments[] | select(.body | test("Decision Log|Review Notes|Session Report"; "i"))] | [.[].body] | join("\n\n---\n\n")' \
    2>/dev/null || echo "")
  echo "${BUILDER_REVIEW:-No builder review comments found.}" > "$BUILDER_FILE"

  # Build re-review block
  export RE_REVIEW_BLOCK=""
  if [[ "$REVIEW_ROUND" -gt 1 ]]; then
    RE_REVIEW_BLOCK="### Re-review (round ${REVIEW_ROUND})

This is a follow-up round. Focus on whether previous requested changes were addressed.

- Check if each prior blocking item was resolved
- **Approve if prior blockers are fixed**, even if you'd nitpick
- New non-blocking findings: note them but approve anyway
- Only request changes for regressions or genuinely missed P1+ issues
- Do NOT hold up the PR for P2/P3 items discovered on re-review"
  fi

  # Checkout PR branch
  cd "$REPO"
  git fetch origin "$BRANCH_NAME" || {
    log "FATAL: Could not fetch branch '${BRANCH_NAME}' for PR #${PR_NUMBER}"
    notify "Review failed — could not fetch branch for PR #${PR_NUMBER}"
    return 1
  }
  git checkout "$BRANCH_NAME" || {
    log "FATAL: Could not checkout branch '${BRANCH_NAME}'"
    return 1
  }
  git pull origin "$BRANCH_NAME" || {
    log "WARNING: Could not pull latest for branch '${BRANCH_NAME}' — reviewing local version"
  }

  local PROMPT
  PROMPT=$(build_prompt "review.md")

  invoke_agent "$PROMPT" "$TASK_TIMEOUT" "$SESSION_LOG" "review-${PR_NUMBER}" || true
  handle_agent_result $? "Review PR #${PR_NUMBER}" "$TASK_TIMEOUT" || true

  rm -f "$TASK_FILE" "$BUILDER_FILE"

  gh pr edit "$PR_NUMBER" --repo "$GITHUB_REPO" --remove-label "reviewing" 2>/dev/null || true
  log "Review complete for PR #${PR_NUMBER}"
  notify "Review complete — PR #${PR_NUMBER}"
}

# ---------------------------------------------------------------------------
# Bug Investigation
# ---------------------------------------------------------------------------
investigate_bug() {
  local ISSUE_NUMBER="$1"
  export ISSUE_NUMBER
  local SESSION_LOG="${LOG_DIR}/investigate-${ISSUE_NUMBER}.log"

  local ISSUE_JSON
  ISSUE_JSON=$(task_view "$ISSUE_NUMBER" --json title,body) || {
    log "FATAL: Could not fetch issue #${ISSUE_NUMBER}"
    notify "Investigation failed — could not fetch issue #${ISSUE_NUMBER}"
    return 1
  }
  local TITLE
  TITLE=$(echo "$ISSUE_JSON" | jq -r '.title')
  export TITLE

  task_transition "$ISSUE_NUMBER" "needs-investigation" "investigating"

  log "Investigating issue #${ISSUE_NUMBER}: ${TITLE}"
  notify "Investigating: #${ISSUE_NUMBER} — ${TITLE}"

  cd "$REPO"
  git pull origin "$BASE_BRANCH" || {
    log "WARNING: Could not pull latest ${BASE_BRANCH} — investigating local version"
  }

  local PROMPT
  PROMPT=$(build_prompt "investigation.md")

  invoke_agent "$PROMPT" "$TASK_TIMEOUT" "$SESSION_LOG" "investigate-${ISSUE_NUMBER}" || true
  handle_agent_result $? "Investigation #${ISSUE_NUMBER}" "$TASK_TIMEOUT" || true

  gh issue edit "$ISSUE_NUMBER" --repo "$GITHUB_REPO" --remove-label "investigating" 2>/dev/null || true
  log "Investigation complete for issue #${ISSUE_NUMBER}"
  notify "Investigation complete: #${ISSUE_NUMBER} — ${TITLE}"
}

# ---------------------------------------------------------------------------
# Main — single task dispatch, then exit
# ---------------------------------------------------------------------------
log "Reviewer starting (task: ${TASK_TYPE} #${WORK_ITEM}, runtime: ${AGENT_RUNTIME}, max rounds: ${MAX_REVIEW_ROUNDS})"
notify "Reviewer online: ${TASK_TYPE} #${WORK_ITEM} (${AGENT_RUNTIME})"

# Prune session files older than 7 days
find "$SESSIONS_DIR" -name '*.id' -mtime +7 -delete 2>/dev/null || true

# If using Claude via Agent SDK, delegate to TypeScript orchestrator
if [[ "$AGENT_RUNTIME" == "claude" ]] && [[ -f /opt/openthrottle/orchestrator/dist/index.js ]]; then
  log "Delegating to Agent SDK orchestrator"
  exec node /opt/openthrottle/orchestrator/dist/index.js
fi

case "$TASK_TYPE" in
  review)        review_pr "$WORK_ITEM" ;;
  investigation) investigate_bug "$WORK_ITEM" ;;
  *)
    log "Unknown TASK_TYPE for reviewer: ${TASK_TYPE}"
    exit 1
    ;;
esac

log "Reviewer finished"
