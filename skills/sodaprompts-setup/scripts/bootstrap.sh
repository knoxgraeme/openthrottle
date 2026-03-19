#!/usr/bin/env bash
# =============================================================================
# bootstrap.sh — run ONCE inside the Sprite via /sodaprompts-setup
#
# Before running:
#   1. sprite console -s <sprite>
#   2. Run: claude        <- triggers device login, open the URL on your laptop
#   3. ctrl+c once authenticated, then run this script
#
# Required env vars (export before running):
#   GITHUB_TOKEN        — personal access token with repo scope
#   GITHUB_REPO         — e.g. "owner/repo"
#   TELEGRAM_BOT_TOKEN  — from @BotFather
#   TELEGRAM_CHAT_ID    — your Telegram chat ID
#
# Supports --from-step N to resume after a failed step.
# =============================================================================

set -uo pipefail
# No -e — step runner handles errors via run_step

source /tmp/pipeline/bootstrap-common.sh
source /tmp/pipeline/ship-common.sh

# Override logging prefix for bootstrap context
log()  { echo -e "${GREEN}[bootstrap]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }

SHIP_SCRIPT_NAME="bootstrap.sh"
parse_args "$@"

# Source secrets (from repo .env if staging already processed, or from staging)
# This enables --from-step resume without manual env sourcing
if [[ -f "${SPRITE_HOME}/repo/.env" ]]; then
  set -a && source "${SPRITE_HOME}/repo/.env" && set +a
elif [[ -f /tmp/env-staging/.env ]]; then
  set -a && source /tmp/env-staging/.env && set +a
fi

# ═════════════════════════════════════════════════════════════════════════
# Step functions
# ═════════════════════════════════════════════════════════════════════════

step_preflight() {
  # Claude Code presence (auth was verified by ship-doer.sh step 4)
  if ! command -v claude &>/dev/null; then
    fail_step "command -v claude" \
      "Claude Code not found. It should be pre-installed on Sprites — check: which claude"
    return 1
  fi
  log "Claude Code found (auth verified by caller)"

  # Warn if ANTHROPIC_API_KEY is set — it overrides the subscription session
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    warn "ANTHROPIC_API_KEY is set — this overrides your subscription login"
    warn "and bills per-token. Unset it to use your Max plan: unset ANTHROPIC_API_KEY"
    warn "Continuing anyway..."
  fi

  # Required env vars
  log "Checking required env vars..."
  local missing=()
  [[ -z "${GITHUB_TOKEN:-}" ]] && missing+=("GITHUB_TOKEN")
  [[ -z "${GITHUB_REPO:-}" ]] && missing+=("GITHUB_REPO")
  [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]] && missing+=("TELEGRAM_BOT_TOKEN")
  [[ -z "${TELEGRAM_CHAT_ID:-}" ]] && missing+=("TELEGRAM_CHAT_ID")
  if [[ ${#missing[@]} -gt 0 ]]; then
    fail_step "env var check" "Missing required env vars: ${missing[*]}"
    return 1
  fi
  log "All env vars present"

  # Node.js and pnpm
  log "Checking Node.js and pnpm..."
  if ! command -v node &>/dev/null; then
    fail_step "command -v node" \
      "Node.js not found. Sprites should have it pre-installed — check: which node"
    return 1
  fi
  # Ensure npm global bin is in PATH (sprite node installs may not add it)
  NPM_GLOBAL_BIN="$(npm prefix -g)/bin"
  if [[ ":$PATH:" != *":$NPM_GLOBAL_BIN:"* ]]; then
    export PATH="$NPM_GLOBAL_BIN:$PATH"
  fi
  if ! command -v pnpm &>/dev/null; then
    log "Installing pnpm..."
    npm install -g pnpm
  fi
  log "Node $(node -v), pnpm $(pnpm -v)"

  return 0
}

step_system_packages() {
  install_system_packages unzip chromium chromium-driver xvfb
  return 0
}

step_github_cli() {
  install_github_cli
  return 0
}

step_plugins() {
  log "Installing sodaprompts plugin..."
  if command -v claude &>/dev/null && claude plugin install knoxgraeme/sodaprompts 2>/dev/null; then
    log "Plugin installed via CLI"
  else
    log "Installing sodaprompts plugin from git..."
    git clone https://github.com/knoxgraeme/sodaprompts.git /tmp/sodaprompts-plugin 2>/dev/null || true
    if [[ -d /tmp/sodaprompts-plugin/skills ]]; then
      mkdir -p "${HOME}/.claude/skills"
      cp -r /tmp/sodaprompts-plugin/skills/* "${HOME}/.claude/skills/"
      log "Plugin installed from git"
    else
      warn "Could not install sodaprompts plugin"
    fi
  fi
  log "sodaprompts plugin ready"

  log "Installing compound-engineering plugin..."
  npx @every-env/compound-plugin install compound-engineering || {
    warn "CE plugin install failed — /ce:plan, /ce:work, /ce:review won't be available"
    warn "The pipeline will still work but planning/review will be less structured"
  }
  # Verify CE skills are reachable
  if claude -p "list your available skills" --output-format text 2>/dev/null | grep -qi "ce-plan\|compound"; then
    log "CE plugin verified"
  else
    warn "CE plugin installed but skills not detected — check: claude -p 'list skills'"
  fi

  return 0
}

step_browser_tools() {
  log "Installing agent-browser..."
  npm install -g agent-browser
  agent-browser install --with-deps
  CI=1 npx -y skills add vercel-labs/agent-browser || {
    warn "Interactive skill install failed — install agent-browser skill manually if needed"
  }
  log "agent-browser installed"

  log "Installing Playwright..."
  npx playwright install --with-deps chromium || {
    warn "Playwright install failed — /test-browser skill won't work"
    warn "Chromium is still available for agent-browser"
  }
  log "Playwright installed"

  return 0
}

step_settings() {
  log "Installing Telegram MCP..."
  npm install -g @s1lverain/claude-telegram-mcp
  MCP_BIN="$(npm root -g)/@s1lverain/claude-telegram-mcp/dist/index.js"

  cat > "${HOME}/.claude-telegram-mcp.json" << TGEOF
{
  "botToken": "${TELEGRAM_BOT_TOKEN}",
  "chatId":   "${TELEGRAM_CHAT_ID}"
}
TGEOF
  log "Telegram MCP config written"

  log "Installing hooks..."
  mkdir -p "${HOME}/.claude/hooks"
  cp /tmp/pipeline/hooks/block-push-to-main.sh "${HOME}/.claude/hooks/"
  cp /tmp/pipeline/hooks/log-commands.sh        "${HOME}/.claude/hooks/"
  cp /tmp/pipeline/hooks/auto-format.sh         "${HOME}/.claude/hooks/"
  chmod +x "${HOME}/.claude/hooks/"*.sh
  log "Hooks installed to ~/.claude/hooks/"

  # Read lint/test commands from config (fallback to generic defaults)
  LINT_CMD="npm run lint"
  TEST_CMD="npm test"
  if [[ -f /tmp/pipeline/sodaprompts.yml ]]; then
    LINT_CMD=$(python3 -c "
import yaml
with open('/tmp/pipeline/sodaprompts.yml') as f:
    print(yaml.safe_load(f).get('lint', 'npm run lint'))
" 2>/dev/null || echo "npm run lint")
    TEST_CMD=$(python3 -c "
import yaml
with open('/tmp/pipeline/sodaprompts.yml') as f:
    print(yaml.safe_load(f).get('test', 'npm test'))
" 2>/dev/null || echo "npm test")
  fi

  log "Writing ~/.claude/settings.json..."
  cat > "${HOME}/.claude/settings.json" << SETTEOF
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/block-push-to-main.sh" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/log-commands.sh" }]
      },
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/auto-format.sh" }]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash -c 'cd \$CLAUDE_PROJECT_DIR && OUTPUT=\$(${LINT_CMD} 2>&1); EXIT=\$?; echo \"\$OUTPUT\" | tail -40; if [ \$EXIT -ne 0 ]; then echo \"Lint failed. Fix before finishing.\" >&2; exit 2; fi'",
            "timeout": 120
          },
          {
            "type": "command",
            "command": "bash -c 'cd \$CLAUDE_PROJECT_DIR && OUTPUT=\$(${TEST_CMD} 2>&1); EXIT=\$?; echo \"\$OUTPUT\" | tail -40; if [ \$EXIT -ne 0 ]; then echo \"Tests failed. Fix before finishing.\" >&2; exit 2; fi'",
            "timeout": 120
          }
        ]
      }
    ]
  },
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["${MCP_BIN}"]
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/context7-mcp"]
    }
  }
}
SETTEOF
  log "settings.json written"

  # Merge project MCP servers from config if defined
  if [[ -f /tmp/pipeline/sodaprompts.yml ]]; then
    PROJECT_MCPS=$(python3 -c "
import yaml, json, sys
with open('/tmp/pipeline/sodaprompts.yml') as f:
    config = yaml.safe_load(f) or {}
mcps = config.get('mcp_servers', {})
if mcps:
    print(json.dumps(mcps))
" 2>/dev/null || true)

    if [[ -n "$PROJECT_MCPS" ]] && [[ "$PROJECT_MCPS" != "{}" ]]; then
      log "Merging project MCP servers into settings..."
      # Replace 'from-env' placeholders with actual env values
      RESOLVED_MCPS=$(echo "$PROJECT_MCPS" | python3 -c "
import json, os, sys
mcps = json.load(sys.stdin)
for name, conf in mcps.items():
    for key, val in conf.get('env', {}).items():
        if val == 'from-env':
            conf['env'][key] = os.environ.get(key, '')
print(json.dumps(mcps))
" 2>/dev/null || echo "$PROJECT_MCPS")

      # Merge into settings.json using jq
      SETTINGS="${HOME}/.claude/settings.json"
      jq --argjson new_mcps "$RESOLVED_MCPS" \
        '.mcpServers += $new_mcps' "$SETTINGS" > "${SETTINGS}.tmp" \
        && mv "${SETTINGS}.tmp" "$SETTINGS"
      log "Project MCPs merged"

      # If Supabase MCP was added, scope it — deny tools that could touch production
      if echo "$RESOLVED_MCPS" | jq -e '.supabase' > /dev/null 2>&1; then
        log "Supabase MCP detected — adding production safety denies..."
        jq '.permissions.deny += [
          "mcp__supabase__execute_sql",
          "mcp__supabase__apply_migration",
          "mcp__supabase__deploy_edge_function",
          "mcp__supabase__merge_branch"
        ] | .permissions.deny |= unique' "$SETTINGS" > "${SETTINGS}.tmp" \
          && mv "${SETTINGS}.tmp" "$SETTINGS"
        log "Supabase tools scoped (execute_sql, apply_migration, deploy_edge_function, merge_branch denied)"
      fi
    fi
  fi

  return 0
}

step_clone_repo() {
  PULL_BRANCH="main"
  if [[ -f /tmp/pipeline/sodaprompts.yml ]]; then
    PULL_BRANCH=$(python3 -c "
import yaml
with open('/tmp/pipeline/sodaprompts.yml') as f:
    print(yaml.safe_load(f).get('base_branch', 'main'))
" 2>/dev/null || echo "main")
  fi

  mkdir -p "${SPRITE_HOME}"/{prd-inbox,logs}
  clone_or_update_repo "$PULL_BRANCH"

  # Copy .env files from staging (pushed in Step 6b before clone)
  if [[ -d /tmp/env-staging ]]; then
    log "Copying .env files from staging..."
    cp -r /tmp/env-staging/. "${SPRITE_HOME}/repo/"
    rm -rf /tmp/env-staging
    log ".env files copied to repo"
  fi

  # Disable project-level hooks — sprite uses its own from ~/.claude/
  REPO_SETTINGS="${SPRITE_HOME}/repo/.claude/settings.json"
  if [[ -f "$REPO_SETTINGS" ]]; then
    log "Disabling project-level hooks (sprite has its own)..."
    echo '{}' > "$REPO_SETTINGS"
    git -C "${SPRITE_HOME}/repo" update-index --assume-unchanged "$REPO_SETTINGS" 2>/dev/null || true
  fi

  # Verify .env exists
  ENV_FILE="${SPRITE_HOME}/repo/.env"
  if [[ -f "$ENV_FILE" ]]; then
    log ".env found — secrets available"
  else
    warn ".env not found at ${ENV_FILE}"
    warn "Pipeline secrets (GITHUB_TOKEN, TELEGRAM_*) may not be available"
    warn "Re-run /sodaprompts-setup to push .env files"
  fi

  return 0
}

step_services() {
  # Initialize managed autostart file
  init_autostart

  # Telegram poller
  log "Installing Telegram poller..."
  cp /tmp/pipeline/telegram-poller.sh "${SPRITE_HOME}/telegram-poller.sh"
  chmod +x "${SPRITE_HOME}/telegram-poller.sh"

  nohup bash "${SPRITE_HOME}/telegram-poller.sh" \
    >> "${SPRITE_HOME}/logs/telegram-poller.log" 2>&1 &
  POLLER_PID=$!
  echo "$POLLER_PID" > "${SPRITE_HOME}/telegram-poller.pid"

  add_autostart "telegram-poller.sh" "${SPRITE_HOME}/telegram-poller.sh" "${SPRITE_HOME}/logs/telegram-poller.log"
  log "Telegram poller running (PID: ${POLLER_PID})"

  # Builder skill
  log "Installing builder skill..."
  cd "${SPRITE_HOME}/repo"
  bash /tmp/pipeline/install-skill.sh sodaprompts-builder
  cd "${SPRITE_HOME}"

  log "Installing run-builder.sh..."
  cp /tmp/pipeline-builder/run-builder.sh "${SPRITE_HOME}/run-builder.sh"
  chmod +x "${SPRITE_HOME}/run-builder.sh"
  log "run-builder.sh installed"

  add_autostart "run-builder.sh" "${SPRITE_HOME}/run-builder.sh" "${SPRITE_HOME}/logs/builder.log"

  log "Starting builder loop..."
  nohup bash "${SPRITE_HOME}/run-builder.sh" >> "${SPRITE_HOME}/logs/builder.log" 2>&1 &
  BUILDER_PID=$!
  echo "$BUILDER_PID" > "${SPRITE_HOME}/builder.pid"
  log "Builder running (PID: ${BUILDER_PID})"

  return 0
}

step_post_bootstrap() {
  if [[ -f /tmp/pipeline/sodaprompts.yml ]]; then
    cp /tmp/pipeline/sodaprompts.yml "${SPRITE_HOME}/repo/.sodaprompts.yml"

    # Run post_bootstrap commands if defined
    POST_BOOTSTRAP=$(python3 -c "
import yaml, sys
with open('/tmp/pipeline/sodaprompts.yml') as f:
    config = yaml.safe_load(f)
for cmd in config.get('post_bootstrap', []):
    print(cmd)
" 2>/dev/null || true)

    if [[ -n "$POST_BOOTSTRAP" ]]; then
      log "Running post-bootstrap commands..."
      cd "${SPRITE_HOME}/repo"
      while IFS= read -r cmd; do
        log "  Running: $cmd"
        bash -c "$cmd" || warn "  Command failed: $cmd"
      done <<< "$POST_BOOTSTRAP"
    fi
  fi

  return 0
}

step_summary() {
  SPRITE_URL=$(sprite url 2>/dev/null || echo "(run: sprite url)")

  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}  Bootstrap complete!${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo "  Sprite URL: ${SPRITE_URL}"
  echo ""
  echo "  Session tip: Claude auth expires after a few weeks."
  echo "  To refresh:  sprite console -> claude login"
  echo "               -> sprite checkpoint create golden-base"
  echo ""

  return 0
}

# ═════════════════════════════════════════════════════════════════════════
# Main — run all steps
# ═════════════════════════════════════════════════════════════════════════

echo ""
echo "Soda Prompts — Bootstrap"
echo "━━━━━━━━━━━━━━━━━━━━━━━━"
[[ "$FROM_STEP" -gt 1 ]] && echo "Resuming from step ${FROM_STEP}"

run_step  1  "preflight"          "Check prerequisites"                  step_preflight         --required
run_step  2  "system-packages"    "Install system packages"              step_system_packages
run_step  3  "github-cli"         "Install and authenticate GitHub CLI"  step_github_cli
run_step  4  "plugins"            "Install Claude plugins"               step_plugins
run_step  5  "browser-tools"      "Install agent-browser and Playwright" step_browser_tools
run_step  6  "settings"           "Configure MCP, hooks, and settings"   step_settings
run_step  7  "clone-repo"         "Clone repo and set up environment"    step_clone_repo
run_step  8  "services"           "Start Telegram poller and builder"    step_services
run_step  9  "post-bootstrap"     "Run post-bootstrap commands"          step_post_bootstrap
run_step 10  "summary"            "Print summary"                        step_summary
