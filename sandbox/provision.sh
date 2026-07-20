#!/usr/bin/env bash
# provision.sh — OpenThrottle sandbox provisioning for Fly Sprites.
#
# Runs once per sprite, as root (`sudo bash /opt/openthrottle/provision.sh`),
# against the live Ubuntu overlay. It is the runtime-provisioning replacement
# for sandbox/Dockerfile: same install steps, but applied to an already-booted
# base image instead of baked into an image layer.
#
# Every step is idempotent — the supervisor may re-run this script (e.g. after
# a partial failure, or a sprite that was provisioned by an older payload
# version), and a second run must be a safe no-op. Each network/install step
# therefore checks whether its target is already present/correct before doing
# any work.
#
# By the time this script runs, the supervisor has already uploaded and
# extracted the payload tarball at `/`:
#   - /opt/openthrottle/{entrypoint.sh,lib,runner,safety,skills,...}
#   - /usr/local/bin/ot-activity
# This script does not create those files; it only installs the system
# toolchain they depend on, creates the `agent` user, installs the pinned
# Compound Engineering marketplace/plugins, and fixes up the payload's
# permission bits (tar extraction does not reliably preserve exec bits).

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "provision.sh must run as root (invoke via sudo)" >&2
  exit 1
fi

log() {
  printf '[provision %s] %s\n' "$(date -u +%H:%M:%S)" "$1" >&2
}

ARCH="$(dpkg --print-architecture)"

# ---------------------------------------------------------------------------
# System packages: git curl jq ripgrep, plus ca-certificates/gnupg (needed to
# add the GitHub CLI apt repo), plus gh itself from its own apt repo.
# ---------------------------------------------------------------------------
log "system packages"

REQUIRED_APT_PKGS=(git curl ca-certificates gnupg jq ripgrep)
MISSING_APT_PKGS=()
for pkg in "${REQUIRED_APT_PKGS[@]}"; do
  dpkg -s "$pkg" >/dev/null 2>&1 || MISSING_APT_PKGS+=("$pkg")
done

if [[ "${#MISSING_APT_PKGS[@]}" -gt 0 ]]; then
  log "installing: ${MISSING_APT_PKGS[*]}"
  apt-get update
  apt-get install -y --no-install-recommends "${MISSING_APT_PKGS[@]}"
else
  log "system packages already present"
fi

if ! command -v gh >/dev/null 2>&1; then
  log "installing gh (GitHub CLI)"
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=${ARCH} signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update
  apt-get install -y --no-install-recommends gh
else
  log "gh already present"
fi

# ---------------------------------------------------------------------------
# gosu — privilege drop from root to the `agent` user. Binary release,
# selected by architecture only.
# ---------------------------------------------------------------------------
GOSU_VERSION="1.17"
if ! command -v gosu >/dev/null 2>&1; then
  log "installing gosu ${GOSU_VERSION}"
  curl -fsSL -o /usr/local/bin/gosu "https://github.com/tianon/gosu/releases/download/${GOSU_VERSION}/gosu-${ARCH}"
  chmod +x /usr/local/bin/gosu
  gosu nobody true
else
  log "gosu already present"
fi

# ---------------------------------------------------------------------------
# yq (mikefarah/yq, Go binary — NOT the python-yq apt package). entrypoint.sh
# relies on the mikefarah `-r '.foo // "default"'` jq-style filter syntax.
# ---------------------------------------------------------------------------
YQ_VERSION="v4.44.3"
if ! command -v yq >/dev/null 2>&1 || ! yq --version 2>/dev/null | grep -qF "$YQ_VERSION"; then
  log "installing yq ${YQ_VERSION}"
  curl -fsSL -o /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${ARCH}"
  chmod +x /usr/local/bin/yq
  yq --version
else
  log "yq ${YQ_VERSION} already present"
fi

# ---------------------------------------------------------------------------
# pnpm + yarn via corepack (bundled with Node). Cheap and inherently
# idempotent — no guard needed.
# ---------------------------------------------------------------------------
log "corepack enable"
corepack enable

# ---------------------------------------------------------------------------
# Coding agent CLIs. Pin the versions whose flags/JSONL contracts are covered
# by the smoke and normalizer tests; upgrade deliberately with those tests.
# `npm ls -g <pkg>@<version>` exits 0 only if that exact version is already
# satisfied globally, so this both skips already-correct installs and
# self-heals a stale/mismatched version.
# ---------------------------------------------------------------------------
CLAUDE_CODE_VERSION="2.1.201"
CODEX_VERSION="0.143.0"
OPENCODE_VERSION="1.18.3"

ensure_global_npm_pinned() {
  local spec="$1"
  if npm ls -g --depth=0 "$spec" >/dev/null 2>&1; then
    log "npm -g ${spec} already installed"
  else
    log "installing npm -g ${spec}"
    npm install -g "$spec"
  fi
}

ensure_global_npm_pinned "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
ensure_global_npm_pinned "@openai/codex@${CODEX_VERSION}"
ensure_global_npm_pinned "opencode-ai@${OPENCODE_VERSION}"

# ---------------------------------------------------------------------------
# Non-root user the agent process runs as. Stays root-owned/root-run up to
# the point entrypoint.sh drops privileges via gosu, so root can seal
# .git/config etc.
# ---------------------------------------------------------------------------
log "agent user"

if ! id -u agent >/dev/null 2>&1; then
  useradd --create-home --home-dir /home/agent --shell /bin/bash --user-group agent
  log "created agent user"
else
  log "agent user already exists"
fi
mkdir -p /home/agent/.ot /home/agent/.codex
chown -R agent:agent /home/agent

# ---------------------------------------------------------------------------
# Native Compound Engineering plugin installation for both agent CLIs. Keep a
# single, exact marketplace checkout on the sprite and install it into both
# of the sandbox user's normal agent profiles. Updating CE is therefore one
# deliberate ref/version bump, and every target repository sees the same
# skill set from its first agent invocation.
# ---------------------------------------------------------------------------
log "Compound Engineering marketplace"

COMPOUND_ENGINEERING_REF="8163a96e86656a89797869ac61905fe4641f81be"
COMPOUND_ENGINEERING_VERSION="3.19.0"
CE_MARKETPLACE="/opt/openthrottle/compound-engineering-marketplace"

if [[ ! -d "${CE_MARKETPLACE}/.git" ]]; then
  install -d -m 0755 "$CE_MARKETPLACE"
  git -C "$CE_MARKETPLACE" init -q
fi
if ! git -C "$CE_MARKETPLACE" remote get-url origin >/dev/null 2>&1; then
  git -C "$CE_MARKETPLACE" remote add origin https://github.com/EveryInc/compound-engineering-plugin.git
fi
if [[ "$(git -C "$CE_MARKETPLACE" rev-parse HEAD 2>/dev/null || true)" != "$COMPOUND_ENGINEERING_REF" ]]; then
  git -C "$CE_MARKETPLACE" fetch -q --depth=1 origin "$COMPOUND_ENGINEERING_REF"
  git -C "$CE_MARKETPLACE" checkout -q --detach FETCH_HEAD
fi
test "$(git -C "$CE_MARKETPLACE" rev-parse HEAD)" = "$COMPOUND_ENGINEERING_REF"

CLAUDE_CE_VERSION="$(gosu agent env HOME=/home/agent \
  claude plugin list --json 2>/dev/null \
  | jq -r '.[]? | select(.id == "compound-engineering@compound-engineering-plugin" and .enabled == true) | .version' 2>/dev/null \
  || true)"
if [[ "$CLAUDE_CE_VERSION" != "$COMPOUND_ENGINEERING_VERSION" ]]; then
  log "installing Compound Engineering plugin for claude"
  gosu agent env HOME=/home/agent \
    claude plugin marketplace add "$CE_MARKETPLACE" --scope user || true
  gosu agent env HOME=/home/agent \
    claude plugin install compound-engineering@compound-engineering-plugin --scope user
else
  log "Compound Engineering plugin already installed for claude (${CLAUDE_CE_VERSION})"
fi
test "$(gosu agent env HOME=/home/agent claude plugin list --json \
  | jq -r '.[] | select(.id == "compound-engineering@compound-engineering-plugin" and .enabled == true) | .version')" \
  = "$COMPOUND_ENGINEERING_VERSION"

CODEX_CE_VERSION="$(gosu agent env HOME=/home/agent CODEX_HOME=/home/agent/.codex \
  codex plugin list --json 2>/dev/null \
  | jq -r '.installed[]? | select(.pluginId == "compound-engineering@compound-engineering-plugin") | .version' 2>/dev/null \
  || true)"
if [[ "$CODEX_CE_VERSION" != "$COMPOUND_ENGINEERING_VERSION" ]]; then
  log "installing Compound Engineering plugin for codex"
  gosu agent env HOME=/home/agent CODEX_HOME=/home/agent/.codex \
    codex plugin marketplace add "$CE_MARKETPLACE" --json || true
  gosu agent env HOME=/home/agent CODEX_HOME=/home/agent/.codex \
    codex plugin add compound-engineering@compound-engineering-plugin --json
else
  log "Compound Engineering plugin already installed for codex (${CODEX_CE_VERSION})"
fi
test "$(gosu agent env HOME=/home/agent CODEX_HOME=/home/agent/.codex \
  codex plugin list --json | jq -r '.installed[] | select(.pluginId == "compound-engineering@compound-engineering-plugin") | .version')" \
  = "$COMPOUND_ENGINEERING_VERSION"

# ---------------------------------------------------------------------------
# Fix up the payload's permission bits. The supervisor's tarball extraction
# does not reliably preserve exec bits, so ensure the scripts we need to run
# are executable. The files themselves were already extracted at `/` before
# this script runs.
# ---------------------------------------------------------------------------
log "payload permissions"

chmod 0755 /opt/openthrottle/entrypoint.sh
chmod 0755 /opt/openthrottle/lib/runtime.sh
chmod 0755 /usr/local/bin/ot-activity
chmod 0755 /opt/openthrottle/safety/pre-push /opt/openthrottle/safety/seal.sh

# ---------------------------------------------------------------------------
# Canonical task skills → Codex admin scope. Claude copies skills/tasks/* into
# the sandbox user's ~/.claude/skills at runtime (entrypoint.sh); Codex instead
# discovers them natively from /etc/codex/skills, so bake them in here. Each
# skill's agents/openai.yaml sets allow_implicit_invocation: false, so a skill
# only runs when the entrypoint's prompt names it. Overwrite-copy = idempotent.
# ---------------------------------------------------------------------------
log "codex admin-scope skills"
mkdir -p /etc/codex/skills
cp -r /opt/openthrottle/skills/tasks/. /etc/codex/skills/

log "provisioning complete"
