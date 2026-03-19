#!/usr/bin/env bash
# =============================================================================
# bootstrap-reviewer.sh — run ONCE inside the Reviewer Sprite
#
# Sets up a review-only sprite with the configured agent runtime.
# Set AGENT_RUNTIME=claude (default) or AGENT_RUNTIME=codex.
#
# Required env vars:
#   GITHUB_TOKEN        — PAT with repo scope
#   GITHUB_REPO         — e.g. "owner/repo"
#
# Optional env vars:
#   AGENT_RUNTIME       — "claude" (default) or "codex"
#   AGENT_AUTH          — "login" (default, uses subscription) or "api-key"
#   TELEGRAM_BOT_TOKEN  — for notifications
#   TELEGRAM_CHAT_ID    — notification target
#   REVIEW_MODEL        — model ID for the agent
#   ANTHROPIC_API_KEY   — required if AGENT_AUTH=api-key and AGENT_RUNTIME=claude
#   OPENAI_API_KEY      — required if AGENT_AUTH=api-key and AGENT_RUNTIME=codex
# =============================================================================

set -euo pipefail

source /tmp/pipeline/bootstrap-common.sh

# ---------------------------------------------------------------------------
# 1. Preflight — required env vars
# ---------------------------------------------------------------------------
log "Checking required env vars..."
: "${GITHUB_TOKEN:?GITHUB_TOKEN is not set}"
: "${GITHUB_REPO:?GITHUB_REPO is not set}"
log "Required env vars present"

AGENT_RUNTIME="${AGENT_RUNTIME:-claude}"
AGENT_AUTH="${AGENT_AUTH:-login}"  # "login" (subscription) or "api-key"
log "Agent runtime: ${AGENT_RUNTIME}, auth: ${AGENT_AUTH}"

# Check auth requirements
if [[ "$AGENT_AUTH" == "api-key" ]]; then
  case "$AGENT_RUNTIME" in
    claude)
      [[ -n "${ANTHROPIC_API_KEY:-}" ]] || warn "ANTHROPIC_API_KEY not set — required for api-key auth" ;;
    codex)
      [[ -n "${OPENAI_API_KEY:-}" ]] || warn "OPENAI_API_KEY not set — required for api-key auth" ;;
  esac
elif [[ "$AGENT_AUTH" == "login" ]]; then
  log "Will use subscription login (interactive browser flow during bootstrap)"
fi

# ---------------------------------------------------------------------------
# 2. System packages
# ---------------------------------------------------------------------------
install_system_packages

# ---------------------------------------------------------------------------
# 3. GitHub CLI
# ---------------------------------------------------------------------------
install_github_cli

# ---------------------------------------------------------------------------
# 4. Agent runtime
# ---------------------------------------------------------------------------
install_agent_runtime

# ---------------------------------------------------------------------------
# 5. Clone repo (for context, not for building)
# ---------------------------------------------------------------------------
clone_or_update_repo

# Copy .env files from staging (pushed before clone to avoid directory collision)
if [[ -d /tmp/env-staging ]]; then
  log "Copying .env files from staging..."
  cp -r /tmp/env-staging/. "${SPRITE_HOME}/repo/"
  rm -rf /tmp/env-staging
  log ".env files copied to repo"
fi

# ---------------------------------------------------------------------------
# 6. Install skill + run-reviewer.sh
# ---------------------------------------------------------------------------
log "Installing thinker skills for ${AGENT_RUNTIME}..."
cd "${SPRITE_HOME}/repo"
bash /tmp/pipeline/install-skill.sh sodaprompts-reviewer
bash /tmp/pipeline/install-skill.sh sodaprompts-investigator
cd "${SPRITE_HOME}"

log "Installing run-reviewer.sh..."
cp /tmp/pipeline-reviewer/run-reviewer.sh "${SPRITE_HOME}/run-reviewer.sh"
chmod +x "${SPRITE_HOME}/run-reviewer.sh"
log "run-reviewer.sh installed"

# ---------------------------------------------------------------------------
# 7. Auto-start on boot
# ---------------------------------------------------------------------------
init_autostart
add_autostart "run-reviewer.sh" "${SPRITE_HOME}/run-reviewer.sh" "${SPRITE_HOME}/logs/reviewer.log"

# ---------------------------------------------------------------------------
# 8. Start the reviewer loop now
# ---------------------------------------------------------------------------
log "Starting reviewer loop..."
nohup bash "${SPRITE_HOME}/run-reviewer.sh" >> "${SPRITE_HOME}/logs/reviewer.log" 2>&1 &
REVIEWER_PID=$!
echo "$REVIEWER_PID" > "${SPRITE_HOME}/reviewer.pid"
log "Reviewer running (PID: ${REVIEWER_PID})"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  Reviewer Sprite Bootstrap Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Repo:    ${GITHUB_REPO}"
echo "  Runtime: ${AGENT_RUNTIME} (auth: ${AGENT_AUTH})"
echo "  Model:   ${REVIEW_MODEL:-default}"
echo "  Polling: every ${POLL_INTERVAL:-60}s for 'needs-review' PRs"
echo "  Max rounds: ${MAX_REVIEW_ROUNDS:-3}"
echo ""
echo "  Logs:    tail -f ${SPRITE_HOME}/logs/reviewer.log"
echo ""
echo "  Next: checkpoint this sprite as golden-base:"
echo "    sprite checkpoint create -s <sprite-name> --comment golden-base"
echo ""
