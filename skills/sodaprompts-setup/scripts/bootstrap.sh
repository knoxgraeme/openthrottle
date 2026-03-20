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
# =============================================================================

set -euo pipefail

source /tmp/pipeline/bootstrap-common.sh

# ---------------------------------------------------------------------------
# Preflight 1 — Claude Code auth
# ---------------------------------------------------------------------------
log "Checking Claude Code authentication..."

if ! command -v claude &>/dev/null; then
  fail "Claude Code not found. It should be pre-installed on Sprites — check: which claude"
fi

AUTH_CHECK=$(claude -p "reply with only the word OK" --output-format text 2>&1 || true)

if echo "$AUTH_CHECK" | grep -qi "login\|auth\|sign in\|not logged\|unauthorized"; then
  echo ""
  echo -e "${RED}  Claude Code is not authenticated.${NC}"
  echo ""
  echo "  Fix:"
  echo "    1. Run: claude"
  echo "    2. Open the printed URL on your laptop and log in"
  echo "    3. Re-run bootstrap.sh"
  echo ""
  exit 1
fi

log "Claude Code authenticated"

# Warn if ANTHROPIC_API_KEY is set — it overrides the subscription session
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  warn "ANTHROPIC_API_KEY is set — this overrides your subscription login"
  warn "and bills per-token. Unset it to use your Max plan: unset ANTHROPIC_API_KEY"
  warn "Continuing anyway..."
fi

# ---------------------------------------------------------------------------
# Preflight 2 — required env vars
# ---------------------------------------------------------------------------
log "Checking required env vars..."
: "${GITHUB_TOKEN:?GITHUB_TOKEN is not set}"
: "${GITHUB_REPO:?GITHUB_REPO is not set}"
: "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN is not set}"
: "${TELEGRAM_CHAT_ID:?TELEGRAM_CHAT_ID is not set}"
log "All env vars present"

# ---------------------------------------------------------------------------
# Preflight 3 — Node.js and pnpm
# ---------------------------------------------------------------------------
log "Checking Node.js and pnpm..."
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Sprites should have it pre-installed — check: which node"
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

# ---------------------------------------------------------------------------
# 1. System packages (doer needs extra packages for browser testing)
# ---------------------------------------------------------------------------
install_system_packages unzip chromium chromium-driver xvfb

# ---------------------------------------------------------------------------
# 2. GitHub CLI
# ---------------------------------------------------------------------------
install_github_cli

# ---------------------------------------------------------------------------
# 3. Soda Prompts plugin
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# 4. Compound Engineering plugin
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# 5. agent-browser + Playwright
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# 6. Telegram MCP + hooks + settings.json
# ---------------------------------------------------------------------------
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

    # If Supabase MCP was added, allowlist safe tools only.
    # New Supabase MCP versions may add tools — allowlist ensures only known-safe
    # tools are permitted without requiring manual updates to a denylist.
    if echo "$RESOLVED_MCPS" | jq -e '.supabase' > /dev/null 2>&1; then
      log "Supabase MCP detected — applying tool allowlist..."
      jq '.permissions.allow += [
        "mcp__supabase__list_tables",
        "mcp__supabase__list_migrations",
        "mcp__supabase__list_branches",
        "mcp__supabase__create_branch",
        "mcp__supabase__delete_branch",
        "mcp__supabase__reset_branch",
        "mcp__supabase__get_project_url",
        "mcp__supabase__search_docs",
        "mcp__supabase__get_logs",
        "mcp__supabase__get_schemas"
      ] | .permissions.allow |= unique' "$SETTINGS" > "${SETTINGS}.tmp" \
        && mv "${SETTINGS}.tmp" "$SETTINGS"
      log "Supabase tools scoped via allowlist (branch management, read-only operations)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 7. Clone repo
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# 7b. Disable project-level hooks — sprite uses its own from ~/.claude/
# ---------------------------------------------------------------------------
# The repo may have .claude/settings.json with hooks for interactive use.
# Nullify it so only the sprite's ~/.claude/settings.json hooks apply.
REPO_SETTINGS="${SPRITE_HOME}/repo/.claude/settings.json"
if [[ -f "$REPO_SETTINGS" ]]; then
  log "Disabling project-level hooks (sprite has its own)..."
  echo '{}' > "$REPO_SETTINGS"
  git -C "${SPRITE_HOME}/repo" update-index --assume-unchanged "$REPO_SETTINGS" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 7c. Seal settings.json — prevent agent from modifying hooks or permissions
# ---------------------------------------------------------------------------
# With --dangerously-skip-permissions the agent has full bash access and could
# rewrite ~/.claude/settings.json to remove hooks or the Supabase allowlist.
# Making the file immutable (chattr +i) prevents this. Only root can undo it,
# and the agent runs as a regular user.
if [[ -f "$SETTINGS" ]]; then
  log "Sealing settings.json (immutable)..."
  chattr +i "$SETTINGS" 2>/dev/null || {
    # Fallback for systems without chattr (e.g., some container runtimes)
    chmod 444 "$SETTINGS"
    log "chattr not available — using chmod 444 (weaker: agent could chmod back)"
  }
fi

# ---------------------------------------------------------------------------
# 8. Verify .env exists
# ---------------------------------------------------------------------------
ENV_FILE="${SPRITE_HOME}/repo/.env"
if [[ -f "$ENV_FILE" ]]; then
  log ".env found — secrets available"
else
  warn ".env not found at ${ENV_FILE}"
  warn "Pipeline secrets (GITHUB_TOKEN, TELEGRAM_*) may not be available"
  warn "Re-run /sodaprompts-setup to push .env files"
fi

# ---------------------------------------------------------------------------
# 9. Install and start Telegram poller
# ---------------------------------------------------------------------------
log "Installing Telegram poller..."
cp /tmp/pipeline/telegram-poller.sh "${SPRITE_HOME}/telegram-poller.sh"
chmod +x "${SPRITE_HOME}/telegram-poller.sh"

# Start the poller as a background daemon
nohup bash "${SPRITE_HOME}/telegram-poller.sh" \
  >> "${SPRITE_HOME}/logs/telegram-poller.log" 2>&1 &
POLLER_PID=$!
echo "$POLLER_PID" > "${SPRITE_HOME}/telegram-poller.pid"

# Auto-start on boot via .bashrc (only if not already running)
add_autostart "telegram-poller.sh" "${SPRITE_HOME}/telegram-poller.sh" "${SPRITE_HOME}/logs/telegram-poller.log"

log "Telegram poller running (PID: ${POLLER_PID})"

# ---------------------------------------------------------------------------
# 9b. Install and start run-builder.sh
# ---------------------------------------------------------------------------
log "Installing builder skill..."
cd "${SPRITE_HOME}/repo"
bash /tmp/pipeline/install-skill.sh sodaprompts-builder
cd "${SPRITE_HOME}"

log "Installing run-builder.sh..."
cp /tmp/pipeline-builder/run-builder.sh "${SPRITE_HOME}/run-builder.sh"
chmod +x "${SPRITE_HOME}/run-builder.sh"
log "run-builder.sh installed"

# Auto-start on boot
add_autostart "run-builder.sh" "${SPRITE_HOME}/run-builder.sh" "${SPRITE_HOME}/logs/builder.log"

# Start the builder loop now
log "Starting builder loop..."
nohup bash "${SPRITE_HOME}/run-builder.sh" >> "${SPRITE_HOME}/logs/builder.log" 2>&1 &
BUILDER_PID=$!
echo "$BUILDER_PID" > "${SPRITE_HOME}/builder.pid"
log "Builder running (PID: ${BUILDER_PID})"

# ---------------------------------------------------------------------------
# 10. Run project-specific post-bootstrap commands
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
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
