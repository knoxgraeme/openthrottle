#!/usr/bin/env bash
# =============================================================================
# entrypoint.sh — Daytona sandbox entrypoint for openthrottle
#
# Replaces the 400-line bootstrap.sh with a simple config-driven flow.
# Runs as root, configures the environment, then drops to the daytona user.
# =============================================================================

set -euo pipefail

: "${GITHUB_REPO:?GITHUB_REPO is required}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${TASK_TYPE:?TASK_TYPE is required}"
: "${WORK_ITEM:?WORK_ITEM is required}"

SANDBOX_HOME="/home/daytona"
REPO="${SANDBOX_HOME}/repo"

log() { echo "[entrypoint $(date +%H:%M:%S)] $1"; }

seal_file() {
  local FILE="$1"
  if chattr +i "$FILE" 2>/dev/null; then
    log "Sealed: $FILE (immutable)"
  else
    chown root:root "$FILE"
    chmod 444 "$FILE"
    log "WARNING: chattr +i not supported — sealed $FILE with permissions (weaker)"
  fi
}

# ---------------------------------------------------------------------------
# 1. Clone repo
# ---------------------------------------------------------------------------
log "Cloning ${GITHUB_REPO}"
gh repo clone "$GITHUB_REPO" "$REPO" -- --depth=50
cd "$REPO"

# ---------------------------------------------------------------------------
# 2. Read .openthrottle.yml
# ---------------------------------------------------------------------------
CONFIG="${REPO}/.openthrottle.yml"
if [[ ! -f "$CONFIG" ]]; then
  log "FATAL: .openthrottle.yml not found in repo"
  exit 1
fi

read_config() {
  local result
  result=$(yq -r "$1 // \"$2\"" "$CONFIG") || {
    log "FATAL: Failed to read config key $1 from $CONFIG"
    exit 1
  }
  echo "$result"
}

BASE_BRANCH=$(read_config '.base_branch' 'main')
TEST_CMD=$(read_config '.test' '')
LINT_CMD=$(read_config '.lint' '')
AGENT=$(read_config '.agent' 'claude')

# ---------------------------------------------------------------------------
# 3. Run post_bootstrap commands (as daytona user, not root)
# ---------------------------------------------------------------------------
POST_BOOTSTRAP=$(yq -r '.post_bootstrap // [] | .[]' "$CONFIG") || {
  log "FATAL: Failed to parse post_bootstrap from .openthrottle.yml — check YAML syntax"
  exit 1
}
if [[ -n "$POST_BOOTSTRAP" ]]; then
  log "Running post_bootstrap"
  while IFS= read -r cmd; do
    log "  > $cmd"
    gosu daytona bash -c "$cmd" || {
      log "FATAL: post_bootstrap command failed (exit $?): $cmd"
      exit 1
    }
  done <<< "$POST_BOOTSTRAP"
fi

# ---------------------------------------------------------------------------
# 4. Configure agent settings (per-agent)
# ---------------------------------------------------------------------------
log "Configuring agent settings (${AGENT})"

# 4a. Install universal git hooks and seal git config (works for ALL agent runtimes)
git -C "$REPO" config core.hooksPath /opt/openthrottle/git-hooks
log "Installed git hooks (pre-push)"
# Seal .git/config to prevent agents from changing core.hooksPath
seal_file "${REPO}/.git/config" 2>/dev/null || true

# 4b. Per-agent configuration
case "$AGENT" in
  claude)
    SETTINGS_DIR="${SANDBOX_HOME}/.claude"
    mkdir -p "$SETTINGS_DIR"

    # Build stop hooks from config
    STOP_HOOKS="[]"
    if [[ -n "$LINT_CMD" ]] || [[ -n "$TEST_CMD" ]]; then
      STOP_CMDS="[]"
      [[ -n "$LINT_CMD" ]] && STOP_CMDS=$(echo "$STOP_CMDS" | jq --arg c "$LINT_CMD" '. + [$c]')
      [[ -n "$TEST_CMD" ]] && STOP_CMDS=$(echo "$STOP_CMDS" | jq --arg c "$TEST_CMD" '. + [$c]')
      STOP_HOOKS=$(echo "$STOP_CMDS" | jq '[{"hooks": .}]')
    fi

    # Build base settings with hooks
    jq -n \
      --argjson stop_hooks "$STOP_HOOKS" \
      '{
        "permissions": {"allow": [], "deny": []},
        "hooks": {
          "PreToolUse": [
            {"matcher": "Bash", "hooks": ["/opt/openthrottle/hooks/block-push-to-main.sh"]}
          ],
          "PostToolUse": [
            {"matcher": "Bash", "hooks": ["/opt/openthrottle/hooks/log-commands.sh"]},
            {"matcher": "Write|Edit", "hooks": ["/opt/openthrottle/hooks/auto-format.sh"]}
          ],
          "Stop": $stop_hooks
        }
      }' > "${SETTINGS_DIR}/settings.json"

    # Merge default MCP servers (Telegram, Context7)
    DEFAULT_MCPS=$(jq -n '{
      "telegram": {
        "command": "npx",
        "args": ["-y", "@punkpeye/telegram-mcp"],
        "env": {
          "TELEGRAM_BOT_TOKEN": env.TELEGRAM_BOT_TOKEN,
          "TELEGRAM_CHAT_ID": env.TELEGRAM_CHAT_ID
        }
      },
      "context7": {
        "command": "npx",
        "args": ["-y", "@upstash/context7-mcp"]
      }
    }')

    # Merge project-specific MCP servers, resolving "from-env" placeholders
    PROJECT_MCPS=$(yq -o=json '.mcp_servers // {}' "$CONFIG") || {
      log "WARNING: Failed to parse mcp_servers — project MCP servers will not be configured"
      PROJECT_MCPS='{}'
    }
    if [[ "$PROJECT_MCPS" != "{}" ]]; then
      PROJECT_MCPS=$(echo "$PROJECT_MCPS" | jq '
        walk(if type == "object" then
          with_entries(
            if .value == "from-env" then
              .value = (env[.key] // null) |
              if .value == null then
                error("Environment variable \(.key) is required by mcp_servers config but not set")
              else . end
            else . end
          )
        else . end)
      ') || {
        log "FATAL: Missing required environment variable for MCP server configuration"
        exit 1
      }
    fi

    # Merge all MCP servers into settings
    ALL_MCPS=$(echo "$DEFAULT_MCPS" "$PROJECT_MCPS" | jq -s '.[0] * .[1]')
    jq --argjson mcps "$ALL_MCPS" '.mcpServers = $mcps' \
      "${SETTINGS_DIR}/settings.json" > "${SETTINGS_DIR}/settings.json.tmp" \
      && mv "${SETTINGS_DIR}/settings.json.tmp" "${SETTINGS_DIR}/settings.json"

    # Apply Supabase tool allowlist if supabase MCP is configured
    if echo "$ALL_MCPS" | jq -e '.supabase' > /dev/null 2>&1; then
      log "Supabase MCP detected — applying tool allowlist"
      jq '.permissions.allow += [
        "mcp__supabase__create_branch",
        "mcp__supabase__delete_branch",
        "mcp__supabase__list_branches",
        "mcp__supabase__reset_branch",
        "mcp__supabase__list_tables",
        "mcp__supabase__get_schemas",
        "mcp__supabase__list_migrations",
        "mcp__supabase__get_project_url",
        "mcp__supabase__search_docs",
        "mcp__supabase__get_logs"
      ] | .permissions.deny += [
        "mcp__supabase__execute_sql",
        "mcp__supabase__apply_migration",
        "mcp__supabase__deploy_edge_function",
        "mcp__supabase__merge_branch"
      ]' "${SETTINGS_DIR}/settings.json" > "${SETTINGS_DIR}/settings.json.tmp" \
        && mv "${SETTINGS_DIR}/settings.json.tmp" "${SETTINGS_DIR}/settings.json"
    fi
    ;;

  codex)
    SETTINGS_DIR="${SANDBOX_HOME}/.codex"
    mkdir -p "$SETTINGS_DIR"
    # Codex reads AGENTS.md for project instructions
    # No equivalent to Claude's settings.json hooks — git hooks provide safety
    log "Codex configured (safety via git hooks)"
    ;;

  aider)
    SETTINGS_DIR="${SANDBOX_HOME}"
    # Write Aider config
    cat > "${SANDBOX_HOME}/.aider.conf.yml" <<AIDEREOF
auto-commits: false
model: ${AGENT_MODEL:-claude-sonnet-4-20250514}
AIDEREOF
    log "Aider configured (safety via git hooks)"
    ;;

  *)
    log "WARNING: Unknown agent '${AGENT}' — using git hooks only for safety"
    SETTINGS_DIR="${SANDBOX_HOME}"
    ;;
esac

# ---------------------------------------------------------------------------
# 5. Seal settings (immutable — only root can undo)
# ---------------------------------------------------------------------------

# Seal agent-specific settings
if [[ "$AGENT" == "claude" ]]; then
  seal_file "${SETTINGS_DIR}/settings.json"
  touch "${SETTINGS_DIR}/settings.local.json"
  seal_file "${SETTINGS_DIR}/settings.local.json"

  # Nullify repo-level .claude/settings.json (prevent agent overrides)
  if [[ -f "${REPO}/.claude/settings.json" ]]; then
    : > "${REPO}/.claude/settings.json"
    seal_file "${REPO}/.claude/settings.json"
  fi
elif [[ "$AGENT" == "aider" ]] && [[ -f "${SANDBOX_HOME}/.aider.conf.yml" ]]; then
  seal_file "${SANDBOX_HOME}/.aider.conf.yml"
fi

# ---------------------------------------------------------------------------
# 7. Fix ownership (skip sealed files — chattr prevents chown on them)
# ---------------------------------------------------------------------------
chown -R daytona:daytona "$SANDBOX_HOME" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 8. Start heartbeat (resets autoStopInterval every 5 min)
#
# Daytona auto-stop only resets on Toolbox SDK API calls, NOT on internal
# process activity. The Toolbox agent runs inside the sandbox on port 63650.
# A lightweight filesystem list call keeps the sandbox alive.
# ---------------------------------------------------------------------------
(
  TOOLBOX_PORT="${DAYTONA_TOOLBOX_PORT:-63650}"
  FAIL_COUNT=0
  MAX_CONSECUTIVE_FAILURES=3
  while true; do
    sleep 300
    if curl -sf "http://localhost:${TOOLBOX_PORT}/filesystem/list?path=/" > /dev/null 2>&1; then
      FAIL_COUNT=0
    else
      FAIL_COUNT=$((FAIL_COUNT + 1))
      echo "[heartbeat $(date +%H:%M:%S)] WARNING: Toolbox heartbeat failed (attempt ${FAIL_COUNT}/${MAX_CONSECUTIVE_FAILURES})" >&2
      if [[ $FAIL_COUNT -ge $MAX_CONSECUTIVE_FAILURES ]]; then
        echo "[heartbeat $(date +%H:%M:%S)] CRITICAL: Toolbox heartbeat failed ${MAX_CONSECUTIVE_FAILURES} times. Sandbox may auto-stop." >&2
      fi
    fi
  done
) &
HEARTBEAT_PID=$!

# ---------------------------------------------------------------------------
# 9. Drop to daytona user and run the appropriate runner
# ---------------------------------------------------------------------------
log "Task: ${TASK_TYPE} #${WORK_ITEM} (agent: ${AGENT})"

export SANDBOX_HOME REPO BASE_BRANCH AGENT
export AGENT_RUNTIME="$AGENT"

case "$TASK_TYPE" in
  prd|bug|review-fix)
    exec gosu daytona /opt/openthrottle/run-builder.sh
    ;;
  review|investigation)
    exec gosu daytona /opt/openthrottle/run-reviewer.sh
    ;;
  *)
    log "Unknown TASK_TYPE: ${TASK_TYPE}"
    exit 1
    ;;
esac
