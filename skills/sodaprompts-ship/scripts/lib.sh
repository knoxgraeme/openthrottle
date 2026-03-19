#!/usr/bin/env bash
# lib.sh — shared helpers for sodaprompts local scripts
# Source this at the top of every script: source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

set -euo pipefail

# ---------------------------------------------------------------------------
# Config + env
# ---------------------------------------------------------------------------
load_config() {
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  CONFIG="${REPO_ROOT}/.sodaprompts.yml"
  ENV_FILE="${REPO_ROOT}/.env"

  if [[ -f "$ENV_FILE" ]]; then
    set -a && source "$ENV_FILE" && set +a
  fi

  if [[ -f "$CONFIG" ]]; then
    CONFIG_SPRITE=$(grep '^sprite:' "$CONFIG" | awk '{print $2}' 2>/dev/null || true)
    BASE_BRANCH=$(grep '^base_branch:' "$CONFIG" | awk '{print $2}' 2>/dev/null || echo "main")
  else
    CONFIG_SPRITE=""
    BASE_BRANCH="main"
  fi

  SPRITE="${CONFIG_SPRITE:-${SPRITES_BASE_NAME:-soda-base}}"
  GITHUB_REPO="${GITHUB_REPO:-}"
}

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
require_env() {
  local var_name="$1"
  if [[ -z "${!var_name:-}" ]]; then
    echo "Error: ${var_name} is not set in .env"
    exit 1
  fi
}

require_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Error: .env not found at ${ENV_FILE}"
    echo "Create a .env at the repo root with GITHUB_TOKEN, GITHUB_REPO, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID."
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Telegram
# ---------------------------------------------------------------------------
notify() {
  local text="$1"
  if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]] && [[ -n "${TELEGRAM_CHAT_ID:-}" ]]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHAT_ID}" \
      -d "text=${text}" \
      > /dev/null 2>&1 || true
  fi
}
