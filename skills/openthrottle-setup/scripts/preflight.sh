#!/usr/bin/env bash
# =============================================================================
# preflight.sh — deterministic checks before agent-driven setup
#
# Run from the repo root. Runs ALL checks, prints a summary, and exits
# non-zero if any failed. No agent reasoning needed — pure pass/fail.
# =============================================================================

set -uo pipefail
# Note: no -e — this script accumulates failures and reports them all at once.

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
PASS=0; FAIL=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; echo -e "    Fix: $2"; FAIL=$((FAIL + 1)); }

echo ""
echo "Open Throttle — Preflight Checks"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 1. Project files (check early — .env sourcing depends on being in repo root)

echo "Project:"

if git rev-parse --is-inside-work-tree &>/dev/null; then
  pass "git repository"
else
  fail "not a git repo" "git init && git remote add origin <url>"
fi

if git remote get-url origin &>/dev/null; then
  pass "git remote 'origin' configured"
else
  fail "no git remote 'origin'" "git remote add origin <url>"
fi

if [[ -f "package.json" ]] || [[ -f "Gemfile" ]] || [[ -f "pyproject.toml" ]] || [[ -f "go.mod" ]]; then
  pass "project manifest found"
else
  fail "no package.json, Gemfile, pyproject.toml, or go.mod" "run from the project root"
fi

# ── 2. CLI tools ─────────────────────────────────────────────────────────

echo ""
echo "Tools:"

if command -v sprite &>/dev/null; then
  pass "sprite CLI"
  if sprite list &>/dev/null; then
    pass "sprite authenticated"
  else
    fail "sprite not authenticated" "sprite login"
  fi
else
  fail "sprite CLI not found" "curl -fsSL https://sprites.dev/install.sh | sh"
fi

if command -v gh &>/dev/null; then
  pass "gh CLI"
  if gh auth status &>/dev/null; then
    pass "gh authenticated"
  else
    fail "gh not authenticated" "gh auth login"
  fi
else
  fail "gh CLI not found" "https://cli.github.com/manual/installation"
fi

# ── 3. Environment variables ─────────────────────────────────────────────

echo ""
echo "Environment:"

ENV_FILE=".env"
if [[ -f "$ENV_FILE" ]]; then
  pass ".env file exists"

  # Parse .env safely — only accept KEY=VALUE lines, no eval
  declare -A ENV_VALS
  while IFS= read -r line; do
    # Skip comments and blank lines
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    # Strip optional 'export ' prefix
    line="${line#export }"
    # Extract key and value
    if [[ "$line" =~ ^([a-zA-Z_][a-zA-Z0-9_]*)=(.*) ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      # Strip surrounding quotes from value
      value="${value#\"}" ; value="${value%\"}"
      value="${value#\'}" ; value="${value%\'}"
      ENV_VALS["$key"]="$value"
    fi
  done < "$ENV_FILE"

  for var in GITHUB_TOKEN GITHUB_REPO TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do
    if [[ -n "${ENV_VALS[$var]:-}" ]]; then
      pass "$var"
    else
      case "$var" in
        GITHUB_TOKEN)       fail "$var" "GitHub → Settings → Developer settings → PAT (repo scope)" ;;
        GITHUB_REPO)        fail "$var" "Add GITHUB_REPO=owner/repo to .env" ;;
        TELEGRAM_BOT_TOKEN) fail "$var" "Telegram @BotFather → /newbot" ;;
        TELEGRAM_CHAT_ID)   fail "$var" "https://api.telegram.org/bot<TOKEN>/getUpdates" ;;
      esac
    fi
  done
else
  fail ".env file not found" "Create .env with: GITHUB_TOKEN, GITHUB_REPO, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID"
fi

# ── 4. Security reminder ─────────────────────────────────────────────────

echo ""
echo "Note: SPRITES_TOKEN is NOT stored in .env — it's only needed as a"
echo "GitHub Actions secret and on your machine for setup (sprite login)."
echo ""
echo "Do not paste secret values (tokens, keys) into the chat — the"
echo "preflight script checks for their presence, not their values."

# ── Summary ───────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}All $PASS checks passed.${NC} Ready for setup."
  echo ""
  exit 0
else
  echo -e "${RED}$FAIL failed${NC}, $PASS passed. Fix the issues above and re-run."
  echo ""
  exit 1
fi
