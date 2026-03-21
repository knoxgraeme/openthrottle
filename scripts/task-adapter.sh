#!/usr/bin/env bash
# =============================================================================
# task-adapter.sh — Thin abstraction over task management APIs
#
# Wraps issue/task lifecycle operations so the runner scripts don't call
# `gh issue ...` directly. Currently GitHub-only; designed so a Linear (or
# other) backend can be swapped in later by adding a case branch.
#
# PR/code-hosting operations (gh pr ...) are NOT abstracted here — those are
# always GitHub regardless of task provider.
#
# Usage:
#   source /opt/sodaprompts/task-adapter.sh   # (in snapshot)
#   source ./scripts/task-adapter.sh          # (local dev)
#
# Requires:
#   GITHUB_REPO  — owner/repo
#   GITHUB_TOKEN — auth token (used implicitly by gh)
#
# Optional:
#   TASK_PROVIDER — "github" (default). Future: "linear".
# =============================================================================

TASK_PROVIDER="${TASK_PROVIDER:-github}"

# All valid state labels used by the system
_ALL_TASK_LABELS=(
  prd-queued prd-running prd-complete prd-failed
  bug-queued bug-running bug-complete bug-failed
  needs-review reviewing
  needs-investigation investigating
)

# ---------------------------------------------------------------------------
# task_ensure_labels — create all state labels (idempotent)
# ---------------------------------------------------------------------------
task_ensure_labels() {
  case "$TASK_PROVIDER" in
    github)
      for LABEL in "${_ALL_TASK_LABELS[@]}"; do
        gh label create "$LABEL" --repo "$GITHUB_REPO" --force 2>/dev/null || true
      done
      ;;
    *)
      echo "[task-adapter] Unknown provider: ${TASK_PROVIDER}" >&2
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# task_create TITLE BODY STATUS [EXTRA_LABELS]
#   Creates a new task/issue. Returns the URL.
#   EXTRA_LABELS — comma-separated additional labels (e.g. "base:dev")
# ---------------------------------------------------------------------------
task_create() {
  local TITLE="$1" BODY="$2" STATUS="$3" EXTRA_LABELS="${4:-}"

  case "$TASK_PROVIDER" in
    github)
      local LABELS="$STATUS"
      [[ -n "$EXTRA_LABELS" ]] && LABELS="${LABELS},${EXTRA_LABELS}"
      gh issue create \
        --repo "$GITHUB_REPO" \
        --title "$TITLE" \
        --body "$BODY" \
        --label "$LABELS"
      ;;
    *)
      echo "[task-adapter] Unknown provider: ${TASK_PROVIDER}" >&2
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# task_transition ID OLD_STATUS NEW_STATUS
#   Atomically moves a task from one state to another.
#   Removes the old label, adds the new one.
# ---------------------------------------------------------------------------
task_transition() {
  local ID="$1" OLD_STATUS="$2" NEW_STATUS="$3"

  case "$TASK_PROVIDER" in
    github)
      gh issue edit "$ID" --repo "$GITHUB_REPO" \
        --remove-label "$OLD_STATUS" --add-label "$NEW_STATUS" 2>/dev/null || true
      ;;
    *)
      echo "[task-adapter] Unknown provider: ${TASK_PROVIDER}" >&2
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# task_close ID
#   Closes a task/issue.
# ---------------------------------------------------------------------------
task_close() {
  local ID="$1"

  case "$TASK_PROVIDER" in
    github)
      gh issue close "$ID" --repo "$GITHUB_REPO" 2>/dev/null || true
      ;;
    *)
      echo "[task-adapter] Unknown provider: ${TASK_PROVIDER}" >&2
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# task_comment ID BODY
#   Posts a comment on a task/issue.
# ---------------------------------------------------------------------------
task_comment() {
  local ID="$1" BODY="$2"

  case "$TASK_PROVIDER" in
    github)
      gh issue comment "$ID" --repo "$GITHUB_REPO" --body "$BODY" 2>/dev/null || true
      ;;
    *)
      echo "[task-adapter] Unknown provider: ${TASK_PROVIDER}" >&2
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# task_view ID [--json FIELDS] [--jq EXPR]
#   Read task/issue details. Passes through --json and --jq to gh.
# ---------------------------------------------------------------------------
task_view() {
  local ID="$1"; shift

  case "$TASK_PROVIDER" in
    github)
      gh issue view "$ID" --repo "$GITHUB_REPO" "$@"
      ;;
    *)
      echo "[task-adapter] Unknown provider: ${TASK_PROVIDER}" >&2
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# task_list_by_status STATUS [--sort FIELD] [--limit N]
#   Returns task IDs (one per line) matching a status/label.
# ---------------------------------------------------------------------------
task_list_by_status() {
  local STATUS="$1"; shift

  case "$TASK_PROVIDER" in
    github)
      gh issue list --repo "$GITHUB_REPO" \
        --label "$STATUS" --state open \
        --json number --jq '.[].number' "$@" 2>/dev/null || echo ""
      ;;
    *)
      echo "[task-adapter] Unknown provider: ${TASK_PROVIDER}" >&2
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# task_first_by_status STATUS
#   Returns the ID of the oldest task in the given status, or empty string.
# ---------------------------------------------------------------------------
task_first_by_status() {
  local STATUS="$1"

  case "$TASK_PROVIDER" in
    github)
      gh issue list --repo "$GITHUB_REPO" \
        --label "$STATUS" --sort created --state open \
        --json number --jq '.[0].number' 2>/dev/null || echo ""
      ;;
    *)
      echo "[task-adapter] Unknown provider: ${TASK_PROVIDER}" >&2
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# task_read_comments ID FILTER_PATTERN
#   Read comments from a task, optionally filtered by a grep pattern.
#   Returns the matching comment bodies.
# ---------------------------------------------------------------------------
task_read_comments() {
  local ID="$1" FILTER="${2:-}"

  case "$TASK_PROVIDER" in
    github)
      if [[ -n "$FILTER" ]]; then
        gh issue view "$ID" --repo "$GITHUB_REPO" --json comments \
          --jq "[.comments[] | select(.body | contains(\"${FILTER}\"))] | last | .body" 2>/dev/null || echo ""
      else
        gh issue view "$ID" --repo "$GITHUB_REPO" --json comments \
          --jq '[.comments[].body] | join("\n\n---\n\n")' 2>/dev/null || echo ""
      fi
      ;;
    *)
      echo "[task-adapter] Unknown provider: ${TASK_PROVIDER}" >&2
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# task_count_by_status STATUS
#   Returns the count of open tasks in the given status.
# ---------------------------------------------------------------------------
task_count_by_status() {
  local STATUS="$1"

  case "$TASK_PROVIDER" in
    github)
      gh issue list --repo "$GITHUB_REPO" \
        --label "$STATUS" --state open \
        --json number --jq 'length' 2>/dev/null || echo "0"
      ;;
    *)
      echo "[task-adapter] Unknown provider: ${TASK_PROVIDER}" >&2
      return 1
      ;;
  esac
}

# ---------------------------------------------------------------------------
# task_list_closed_by_status STATUS [--limit N]
#   Returns closed tasks matching a status label (for "recent completed").
# ---------------------------------------------------------------------------
task_list_closed_by_status() {
  local STATUS="$1"; shift

  case "$TASK_PROVIDER" in
    github)
      gh issue list --repo "$GITHUB_REPO" \
        --label "$STATUS" --state closed --sort updated \
        --json number,title --jq '.[] | "#\(.number) — \(.title)"' "$@" 2>/dev/null || echo ""
      ;;
    *)
      echo "[task-adapter] Unknown provider: ${TASK_PROVIDER}" >&2
      return 1
      ;;
  esac
}
