#!/usr/bin/env bash
# Executes one root-sealed kernel request. Repository changes, result
# validation, Git subjects, and checkpoint bundles remain executor-owned.

set -euo pipefail

readonly AGENT_USER="agent"
readonly REPO_PARENT="/var/lib/openthrottle/repository-source"
readonly REPO_DIR="${REPO_PARENT}/repo"
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

validate_repository_source() {
  local ownership_violation write_violation

  # The enclosing 0700 directory is the replacement fence: the agent cannot
  # traverse it, rename the checkout, or swap a new tree into its place.
  [[ -d "$REPO_PARENT" && ! -L "$REPO_PARENT" ]] \
    || { log "repository source parent is unavailable"; return 1; }
  [[ "$(readlink -f -- "$REPO_PARENT")" = "$REPO_PARENT" ]] \
    || { log "repository source parent must be a physical directory"; return 1; }
  [[ "$(stat -c '%U:%G:%a' "$REPO_PARENT")" = "root:root:700" ]] \
    || { log "repository source parent must be root:root mode 0700"; return 1; }

  for path in "$REPO_DIR" "$REPO_DIR/.git"; do
    [[ -d "$path" && ! -L "$path" ]] \
      || { log "repository source component is not a physical directory: ${path}"; return 1; }
    [[ "$(readlink -f -- "$path")" = "$path" ]] \
      || { log "repository source component escapes its physical path: ${path}"; return 1; }
    [[ "$(stat -c '%U:%G' "$path")" = "root:root" ]] \
      || { log "repository source component must be root-owned: ${path}"; return 1; }
    [[ $(( 8#$(stat -c '%a' "$path") & 0022 )) -eq 0 ]] \
      || { log "repository source component must not be agent-writable: ${path}"; return 1; }
  done

  ownership_violation="$(find -P "$REPO_DIR" \( ! -user root -o ! -group root \) -print -quit)" \
    || { log "repository source ownership validation failed"; return 1; }
  [[ -z "$ownership_violation" ]] \
    || { log "repository source tree must be root-owned"; return 1; }
  write_violation="$(find -P "$REPO_DIR" ! -type l -perm /022 -print -quit)" \
    || { log "repository source writeability validation failed"; return 1; }
  [[ -z "$write_violation" ]] \
    || { log "repository source tree must not be agent-writable"; return 1; }
}

seal_repository_source() {
  local write_violation

  # Root-owned Git imports may leave owner-write bits behind. Remove them before
  # constructing any action view; physical traversal preserves symlink targets.
  find -P "$REPO_DIR" ! -type l -exec chmod a-w -- {} +
  write_violation="$(find -P "$REPO_DIR" ! -type l -perm /0222 -print -quit)" \
    || { log "repository source seal verification failed"; return 1; }
  [[ -z "$write_violation" ]] \
    || { log "repository source tree could not be sealed read-only"; return 1; }
}

handle_exit() {
  local status="$?"
  terminate_agent_processes || true
  if [[ -n "${OT_ACTION_RESULT_FILE:-}" && -n "${OT_ACTION_FORENSICS_FILE:-}" ]]; then
    node "${RUNNER_DIR}/stage-attempt-forensics.mjs" "$status" || true
  fi
}
trap handle_exit EXIT INT TERM

[[ "$(id -u)" -eq 0 ]] || { log "entrypoint must run as root"; exit 1; }
terminate_agent_processes

if [[ -n "${OT_ACTION_REQUEST_FILE:-}${OT_ACTION_RESULT_FILE:-}${OT_ACTION_SESSION_FILE:-}" &&
      -n "${OT_INTEGRATION_REQUEST_FILE:-}${OT_INTEGRATION_RESULT_FILE:-}" ]]; then
  log "action and integration request families are mutually exclusive"
  exit 1
fi

validate_repository_source
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
