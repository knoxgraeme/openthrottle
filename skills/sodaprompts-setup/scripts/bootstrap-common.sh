#!/usr/bin/env bash
# =============================================================================
# bootstrap-common.sh — shared setup steps for all sprite types
#
# Source this from bootstrap.sh or bootstrap-reviewer.sh:
#   source /tmp/pipeline/bootstrap-common.sh
#
# Provides functions — does not run anything on its own.
# =============================================================================

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[bootstrap]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
fail() { echo -e "${RED}[error]${NC} $1"; exit 1; }

SPRITE_HOME="${SPRITE_HOME:-/home/sprite}"

# Use sudo when not running as root
SUDO=""
if [[ $(id -u) -ne 0 ]]; then SUDO="sudo"; fi

# ---------------------------------------------------------------------------
# Install system packages (apt-get)
# ---------------------------------------------------------------------------
install_system_packages() {
  log "Installing system packages..."
  $SUDO apt-get update -q
  $SUDO apt-get install -y -q curl wget git jq "$@"
  $SUDO apt-get clean; $SUDO rm -rf /var/lib/apt/lists/* || true
}

# ---------------------------------------------------------------------------
# Install and authenticate GitHub CLI
# ---------------------------------------------------------------------------
install_github_cli() {
  log "Installing GitHub CLI..."
  if ! command -v gh &>/dev/null; then
    GH_VERSION=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | jq -r '.tag_name' | tr -d 'v')
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
      | $SUDO tar xz --strip-components=1 -C /usr/local
  fi
  if gh auth status &>/dev/null; then
    log "GitHub CLI already authenticated"
  else
    # GITHUB_TOKEN in env blocks gh auth login; temporarily unset for this command
    GITHUB_TOKEN= gh auth login --with-token <<< "${GITHUB_TOKEN}"
  fi
  # Use credential helper instead of embedding token in clone URL
  gh auth setup-git
  log "GitHub CLI authenticated"
}

# ---------------------------------------------------------------------------
# Clone or update repo
# ---------------------------------------------------------------------------
clone_or_update_repo() {
  local base_branch="${1:-main}"

  log "Setting up repo for ${GITHUB_REPO}..."
  mkdir -p "${SPRITE_HOME}/logs"

  if [[ -d "${SPRITE_HOME}/repo/.git" ]]; then
    warn "${SPRITE_HOME}/repo already exists — pulling latest"
    git -C "${SPRITE_HOME}/repo" pull origin "$base_branch" 2>/dev/null || true
  else
    # Use gh CLI for cloning (uses credential helper, no token in .git/config)
    gh repo clone "${GITHUB_REPO}" "${SPRITE_HOME}/repo"
  fi

  git -C "${SPRITE_HOME}/repo" config user.email "agent@sprite.local"
  git -C "${SPRITE_HOME}/repo" config user.name  "Sprite Agent"
  log "Repo at ${SPRITE_HOME}/repo"
}

# ---------------------------------------------------------------------------
# Install agent runtime (Claude Code or Codex)
# ---------------------------------------------------------------------------
install_agent_runtime() {
  local runtime="${AGENT_RUNTIME:-claude}"
  local auth="${AGENT_AUTH:-login}"

  case "$runtime" in
    claude)
      log "Installing Claude Code..."
      if ! command -v claude &>/dev/null; then
        npm install -g @anthropic-ai/claude-code 2>/dev/null || {
          warn "Could not install Claude Code. Install manually."
        }
      fi
      if command -v claude &>/dev/null; then
        log "Claude Code installed: $(claude --version 2>/dev/null || echo 'version unknown')"
        if [[ "$auth" == "login" ]]; then
          log "Logging into Claude Code with your subscription..."
          claude login || warn "Login failed — fall back to ANTHROPIC_API_KEY if set"
        fi
      fi
      ;;
    codex)
      log "Installing Codex..."
      if ! command -v codex &>/dev/null; then
        npm install -g @openai/codex 2>/dev/null || {
          warn "Could not install Codex."
        }
      fi
      if command -v codex &>/dev/null; then
        log "Codex installed: $(codex --version 2>/dev/null || echo 'version unknown')"
        if [[ "$auth" == "login" ]]; then
          log "Logging into Codex with your subscription..."
          codex login || warn "Login failed — fall back to OPENAI_API_KEY if set"
        fi
      fi
      ;;
    *)
      fail "Unknown AGENT_RUNTIME: ${runtime}. Use 'claude' or 'codex'."
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Auto-start a script via .bashrc
# ---------------------------------------------------------------------------
add_autostart() {
  local script_name="$1"
  local script_path="$2"
  local log_path="$3"

  grep -q "$script_name" /root/.bashrc 2>/dev/null || \
    cat >> /root/.bashrc << BOOTEOF

# Start ${script_name} if not running
if ! pgrep -f "${script_name}" > /dev/null 2>&1; then
  nohup bash ${script_path} >> ${log_path} 2>&1 &
fi
BOOTEOF

  log "Auto-start configured for ${script_name}"
}
