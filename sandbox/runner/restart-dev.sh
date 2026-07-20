#!/usr/bin/env bash
# restart-dev.sh — probe the dev server and, if it is down, (re)start it from
# the repository's configured `dev:` command.
#
# The wake-on-click preview only starts the *sandbox*; the dev server itself is
# started by entrypoint.sh during a task run, so after the workspace idles the
# preview would point at a dead port. The supervisor runs this on a preview
# open so the app comes back instead of a dead link. Self-contained: it reads
# the dev command straight from the checked-out repo, so it needs no state from
# the original run and never touches entrypoint.sh's own dev-server handling.
#
# Emits exactly one status line the supervisor parses, then the dev-log tail:
#   OT_DEV_STATUS:listening  — already serving; the caller should redirect
#   OT_DEV_STATUS:starting   — was down, (re)started; the caller shows "starting"
#   OT_DEV_STATUS:no-dev     — down and no `dev:` command configured
#
# Idempotent: never starts a second server when one is already listening.

set -u

PORT="${1:-${DEV_PORT:-3000}}"
REPO="/home/agent/repo"
LOG="/home/agent/.ot/dev.log"
CONFIG="${REPO}/.openthrottle.yml"

emit() { printf 'OT_DEV_STATUS:%s\n' "$1"; }

if curl -s -o /dev/null --max-time 3 "http://127.0.0.1:${PORT}/" 2>/dev/null; then
  emit listening
else
  DEV_CMD=""
  if [[ -f "$CONFIG" ]] && command -v yq >/dev/null 2>&1; then
    DEV_CMD="$(yq -r '.dev // ""' "$CONFIG" 2>/dev/null || true)"
  fi
  if [[ -n "$DEV_CMD" && "$DEV_CMD" != "null" ]]; then
    # Start detached, exactly as entrypoint.sh phase 6 does, so it survives this
    # command returning. Run as the unprivileged agent when invoked as root.
    run="cd '${REPO}' && DEV_PORT='${PORT}' PORT='${PORT}' HOST=0.0.0.0 HOSTNAME=0.0.0.0 nohup ${DEV_CMD} >> '${LOG}' 2>&1 < /dev/null &"
    if [[ "$(id -u)" == "0" ]]; then
      gosu agent env HOME=/home/agent USER=agent bash -lc "$run"
    else
      bash -lc "$run"
    fi
    emit starting
  else
    emit no-dev
  fi
fi

tail -c 16000 "$LOG" 2>/dev/null || true
