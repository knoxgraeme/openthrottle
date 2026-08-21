#!/usr/bin/env bash
# Executes one root-sealed kernel request. Repository changes, result
# validation, Git subjects, and checkpoint bundles remain executor-owned.

set -euo pipefail

readonly AGENT_USER="agent"
readonly REPO_DIR="/home/agent/repo"
readonly RUNNER_DIR="/opt/openthrottle/runner"

log() {
  printf '[kernel-entrypoint %s] %s\n' "$(date -u +%H:%M:%S)" "$1" >&2
}

terminate_agent_processes() {
  local uid status=0
  uid="$(id -u "$AGENT_USER")"
  [[ "$uid" =~ ^[1-9][0-9]*$ ]] || { log "unsafe agent uid: ${uid}"; return 1; }
  pkill -KILL -u "$uid" 2>/dev/null || status=$?
  [[ "$status" -eq 0 || "$status" -eq 1 ]] || return "$status"
  local attempt
  for attempt in $(seq 1 100); do
    if ! ps -o stat= -u "$uid" 2>/dev/null | grep -qv 'Z'; then return 0; fi
    sleep 0.1
  done
  log "agent process cleanup did not converge"
  return 1
}

sealed_input() {
  local path="$1" label="$2"
  [[ "$path" = /* && -f "$path" && ! -L "$path" ]] \
    || { log "${label} must be an absolute regular file"; return 1; }
  [[ "$(stat -c '%U' "$path")" = "root" ]] \
    || { log "${label} must be root-owned"; return 1; }
  [[ $(( 8#$(stat -c '%a' "$path") & 0222 )) -eq 0 ]] \
    || { log "${label} must not be writable"; return 1; }
}

seal_repository_source() {
  # The bound checkout is executor input, never an agent workspace. Physical
  # traversal keeps repository symlinks intact and never changes their targets.
  find -P "$REPO_DIR" -exec chown -h root:root -- {} +
  find -P "$REPO_DIR" ! -type l -exec chmod a-w -- {} +
}

handle_exit() {
  terminate_agent_processes || true
}
trap handle_exit EXIT INT TERM

[[ "$(id -u)" -eq 0 ]] || { log "entrypoint must run as root"; exit 1; }
[[ -d "$REPO_DIR" && ! -L "$REPO_DIR" ]] \
  || { log "bound repository is unavailable at ${REPO_DIR}"; exit 1; }

terminate_agent_processes
seal_repository_source

if [[ -n "${OT_INTEGRATION_REQUEST_FILE:-}" || -n "${OT_INTEGRATION_RESULT_FILE:-}" ]]; then
  : "${OT_INTEGRATION_REQUEST_FILE:?OT_INTEGRATION_REQUEST_FILE is required}"
  : "${OT_INTEGRATION_RESULT_FILE:?OT_INTEGRATION_RESULT_FILE is required}"
  sealed_input "$OT_INTEGRATION_REQUEST_FILE" "integration request"
  node "${RUNNER_DIR}/integrate-checkpoint.mjs"
  exit 0
fi

: "${OT_ACTION_REQUEST_FILE:?OT_ACTION_REQUEST_FILE is required}"
: "${OT_ACTION_RESULT_FILE:?OT_ACTION_RESULT_FILE is required}"
: "${OT_ACTION_SESSION_FILE:?OT_ACTION_SESSION_FILE is required}"
sealed_input "$OT_ACTION_REQUEST_FILE" "action request"

# No persistent user config, repository config, or prior inbox entry is an
# action authority. Profiles and progressive skills are reconstructed beneath
# the sealed attempt root by execute-attempt.mjs.
rm -rf /home/agent/.ot/inbox /home/agent/.ot/inbox-processed
install -d -o agent -g agent -m 0700 /home/agent/.ot/inbox /home/agent/.ot/inbox-processed

node "${RUNNER_DIR}/execute-attempt.mjs"
