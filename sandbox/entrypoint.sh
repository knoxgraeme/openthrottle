#!/usr/bin/env bash
# entrypoint.sh — OpenThrottle sandbox entrypoint. Runs as root inside the
# Daytona sandbox; all repo/agent work happens as the unprivileged `agent`
# user via gosu. See docs/SPEC.md "Sandbox stage contract" for the sealed
# lifecycle and input contract implemented below.
#
# Invoked only for a root-fenced pipeline stage. The supervisor supplies three
# sealed inputs and the executor writes one typed result under
# /var/lib/openthrottle. There is no callback/completion-marker task mode.

set -euo pipefail

AGENT_USER="agent"
AGENT_HOME="/home/agent"
ACTION_USERS=(
  "$AGENT_USER"
  ot-review-final
  ot-review-selector
  ot-review-correctness
  ot-review-tests
  ot-review-reliability
  ot-review-agent-native
  ot-review-security
  ot-review-data
  ot-review-performance
  ot-review-standards
  ot-review-validator
)
PROCESS_FENCE_MAX_ATTEMPTS=100
PROCESS_FENCE_SLEEP_SECONDS=0.1
REPO_DIR="${AGENT_HOME}/repo"
OT_DIR="${AGENT_HOME}/.ot"
OPT_DIR="/opt/openthrottle"

# shellcheck source=lib/runtime.sh
source "${OPT_DIR}/lib/runtime.sh"

# =============================================================================
# Functions (defined up front — the EXIT trap can fire at any point once
# installed, and must be able to call handle_exit() no matter how
# early we abort).
# =============================================================================

log() {
  printf '[entrypoint %s] %s\n' "$(date -u +%H:%M:%S)" "$1" >&2
}

# Run a command as the `agent` user with a correct HOME/USER. gosu does not
# reset the environment (unlike su -l), so HOME/USER are set explicitly.
as_agent() {
  gosu "$AGENT_USER" env HOME="$AGENT_HOME" USER="$AGENT_USER" bash -c "$1"
}

# A stage may be followed by another stage in the same sandbox. Kill any
# descendants owned by the stage agent or any isolated review principal before
# new credentials or trusted runtime config are materialized, so a process from
# an untrusted review cannot cross that boundary.
live_action_user_pids() {
  local uid="$1" output status=0 pid process_state
  output="$(ps -o pid=,stat= -u "$uid" 2>/dev/null)" || status=$?
  if [[ "$status" -eq 1 ]]; then
    return 0
  fi
  if [[ "$status" -ne 0 ]]; then
    return "$status"
  fi
  while read -r pid process_state; do
    [[ "$pid" =~ ^[1-9][0-9]*$ && -n "$process_state" ]] || continue
    # Zombies are already dead, cannot mutate state, and cannot be removed by
    # SIGKILL while they wait for their parent to reap them.
    [[ "$process_state" == *Z* ]] || printf '%s\n' "$pid"
  done <<< "$output"
}

terminate_agent_processes() {
  local user uid current_uid status attempt live_pids converged
  current_uid="$(id -u)"
  for user in "${ACTION_USERS[@]}"; do
    uid="$(id -u "$user" 2>/dev/null)" || {
      log "FATAL: could not resolve action principal ${user}"
      return 1
    }
    if [[ ! "$uid" =~ ^[1-9][0-9]*$ || "$uid" == "$current_uid" ]]; then
      log "FATAL: refusing unsafe process cleanup for ${user} uid ${uid}"
      return 1
    fi

    converged=0
    attempt=0
    while [[ "$attempt" -lt "$PROCESS_FENCE_MAX_ATTEMPTS" ]]; do
      status=0
      live_pids="$(live_action_user_pids "$uid")" || status=$?
      if [[ "$status" -ne 0 ]]; then
        log "FATAL: could not enumerate stale ${user} processes"
        return "$status"
      fi
      if [[ -z "$live_pids" ]]; then
        converged=1
        break
      fi

      status=0
      # Signal by UID, not by enumerated PID: a PID reused between observation
      # and delivery cannot redirect root's signal outside this principal.
      pkill -KILL -u "$uid" 2>/dev/null || status=$?
      if [[ "$status" -ne 0 && "$status" -ne 1 ]]; then
        log "FATAL: could not terminate stale ${user} processes"
        return "$status"
      fi
      attempt=$((attempt + 1))
      sleep "$PROCESS_FENCE_SLEEP_SECONDS"
    done

    if [[ "$converged" -ne 1 ]]; then
      status=0
      live_pids="$(live_action_user_pids "$uid")" || status=$?
      if [[ "$status" -ne 0 ]]; then
        log "FATAL: could not enumerate stale ${user} processes"
        return "$status"
      fi
      if [[ -n "$live_pids" ]]; then
        log "FATAL: stale ${user} process cleanup did not converge to empty"
        return 1
      fi
    fi
  done
}

# Composite loop actions keep the shared stage profiles executor-sealed while
# sibling engines use their action-scoped homes. After killing every stale
# agent process, restore ownership at the stage boundary before the ordinary
# reset below preserves or replaces selected state. `find` is physical by
# default, so an agent-planted child symlink is never traversed as root.
restore_agent_state_ownership() {
  local path
  if [[ -L "$AGENT_HOME" || ! -d "$AGENT_HOME" ]]; then
    log "FATAL: agent home is not a real directory: ${AGENT_HOME}"
    return 1
  fi
  # Concurrent loop actions lock this shared parent root:root 0711 so sibling
  # homes cannot expose persistent stage state. With every action principal
  # terminated above, restore only the boundary itself before the next stage
  # writes ~/.gitconfig; sealed descendants retain their existing ownership.
  chown "${AGENT_USER}:${AGENT_USER}" "$AGENT_HOME"
  chmod 0700 "$AGENT_HOME"
  for path in \
    "${AGENT_HOME}/.claude" \
    "${AGENT_HOME}/.codex" \
    "${AGENT_HOME}/.local/share/opencode" \
    "${AGENT_HOME}/.ot"; do
    if [[ -L "$path" ]]; then
      log "FATAL: agent state path is a symlink: ${path}"
      return 1
    fi
    [[ -d "$path" ]] || continue
    chown -R "${AGENT_USER}:${AGENT_USER}" "$path"
    find "$path" -type d -exec chmod 0700 {} +
    find "$path" -type f -exec chmod 0600 {} +
  done
}

# Preserve native session/auth data, but discard every executable user-level
# config surface. Claude gets the OpenThrottle skills recopied per stage;
# Codex loads them from root-owned /etc/codex/skills. Per-stage hooks/config
# are rebuilt later below.
# ~/.claude/backups is part of that surface: the CLI's corruption recovery
# moves ~/.claude.json there, and heal_claude_config (lib/runtime.sh) restores
# the newest backup when the config is missing — exactly the state this reset
# creates — so leaving backups behind would resurrect the previous stage's
# config across the stage boundary.
reset_agent_execution_state() {
  for profile in "${AGENT_HOME}/.claude" "${AGENT_HOME}/.codex"; do
    if [[ -L "$profile" ]]; then
      log "FATAL: agent profile path is a symlink: ${profile}"
      return 1
    fi
    install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 0700 "$profile"
  done
  # These trees carry no durable native session/auth state. Replacing the
  # top-level entry is safe even when an earlier agent made it a symlink;
  # rm removes a final symlink without traversing its target.
  rm -rf "${AGENT_HOME}/.config"
  install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 0700 "${AGENT_HOME}/.config"
  if [[ -L "${AGENT_HOME}/.local" || ( -e "${AGENT_HOME}/.local" && ! -d "${AGENT_HOME}/.local" ) ]]; then
    rm -rf "${AGENT_HOME}/.local"
  fi
  install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 0700 "${AGENT_HOME}/.local"
  rm -rf "${AGENT_HOME}/.codex/.tmp"
  install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 0700 "${AGENT_HOME}/.codex/.tmp"
  rm -rf \
    "${AGENT_HOME}/.agents" \
    "${AGENT_HOME}/.claude/agents" \
    "${AGENT_HOME}/.claude/backups" \
    "${AGENT_HOME}/.claude/commands" \
    "${AGENT_HOME}/.claude/hooks" \
    "${AGENT_HOME}/.claude/plugins" \
    "${AGENT_HOME}/.claude/skills" \
    "${AGENT_HOME}/.codex/agents" \
    "${AGENT_HOME}/.codex/plugins" \
    "${AGENT_HOME}/.codex/prompts" \
    "${AGENT_HOME}/.codex/rules" \
    "${AGENT_HOME}/.codex/skills" \
    "${AGENT_HOME}/.local/bin" \
    "${AGENT_HOME}/bin"
  rm -f \
    "${AGENT_HOME}/.bash_profile" \
    "${AGENT_HOME}/.bashrc" \
    "${AGENT_HOME}/.claude/settings.json" \
    "${AGENT_HOME}/.claude/CLAUDE.md" \
    "${AGENT_HOME}/.claude.json" \
    "${AGENT_HOME}/.codex/AGENTS.md" \
    "${AGENT_HOME}/.codex/config.toml" \
    "${AGENT_HOME}/.codex/hooks.json" \
    "${AGENT_HOME}/.gitconfig" \
    "${AGENT_HOME}/.mcp.json" \
    "${AGENT_HOME}/.profile" \
    "${AGENT_HOME}/.zprofile" \
    "${AGENT_HOME}/.zshrc" \
    "${AGENT_HOME}/AGENTS.md" \
    "${AGENT_HOME}/CLAUDE.md"
}

assert_agent_directory() {
  local path="$1"
  if [[ -L "$path" || ( -e "$path" && ! -d "$path" ) ]]; then
    log "FATAL: agent state path is not a directory: ${path}"
    return 1
  fi
}

STAGE_REPO_DIR="$REPO_DIR"

# Author agent commits as the GitHub account that owns GH_TOKEN so GitHub can
# attribute them to a real account and integrations that gate on commit-author
# identity (e.g. Vercel) accept the deployment. The account's GitHub noreply
# identity is derived from `gh api user`; the placeholder is a last resort.
configure_git_identity() {
  local login="" uid="" identity name email
  login="$(as_agent "gh api user --jq .login" 2>/dev/null || true)"
  uid="$(as_agent "gh api user --jq .id" 2>/dev/null || true)"
  if [[ -z "$login" || -z "$uid" ]]; then
    log "WARNING: could not resolve a GitHub commit identity; author-gated integrations (e.g. Vercel) may reject commits"
  fi
  identity="$(resolve_git_identity "$login" "$uid")"
  name="${identity%%$'\t'*}"
  email="${identity#*$'\t'}"
  # Write to the agent's global config (like safe.directory above), never the
  # repository's .git/config: Phase 3 seals .git/config immutable, so a
  # repo-local write would fail in a later stage and abort the entrypoint. The clone
  # never sets a repo-local user.*, so this global identity always applies.
  as_agent "git config --global user.name '$name'"
  as_agent "git config --global user.email '$email'"
  log "commit identity: ${name} <${email}>"
}

HEARTBEAT_PID=""

handle_exit() {
  terminate_agent_processes || true
  if [[ -n "${HEARTBEAT_PID:-}" ]]; then
    kill "$HEARTBEAT_PID" 2>/dev/null || true
    wait "$HEARTBEAT_PID" 2>/dev/null || true
  fi
  if [[ -n "${MCP_CONFIG_FILE:-}" ]]; then
    rm -f "$MCP_CONFIG_FILE"
  fi
  if [[ -n "${OPENCODE_CONFIG_DIR:-}" ]]; then
    rm -rf "$OPENCODE_CONFIG_DIR"
  fi
  if [[ -n "${STAGE_POLICY_TEMP:-}" ]]; then
    rm -f "$STAGE_POLICY_TEMP"
  fi
}

# =============================================================================
# Validate the bare minimum needed to report failures, then install the
# EXIT trap before doing anything else that could fail.
# =============================================================================

STAGE_EXPECTED_SUBJECT=""
STAGE_BASE_COMMIT=""
STAGE_MODEL_REQUIRED=1
: "${OT_STAGE_REQUEST_FILE:?OT_STAGE_REQUEST_FILE is required}"
: "${OT_STAGE_CONFIG_FILE:?OT_STAGE_CONFIG_FILE is required}"
: "${OT_STAGE_MANIFEST_FILE:?OT_STAGE_MANIFEST_FILE is required}"
for sealed_input in "$OT_STAGE_REQUEST_FILE" "$OT_STAGE_CONFIG_FILE" "$OT_STAGE_MANIFEST_FILE"; do
  [[ "$(stat -c '%U' "$sealed_input")" == "root" ]] \
    || { log "FATAL: sealed stage input is not root-owned: ${sealed_input}"; exit 1; }
done
# Validate the complete hash/capability fence before any request field is used
# for auth, checkout, or process selection. Mutable provider env is transport
# only; the root-owned request is the execution authority.
node "${OPT_DIR}/runner/execute-stage.mjs" \
  --validate-inputs \
  --request "$OT_STAGE_REQUEST_FILE" \
  --config "$OT_STAGE_CONFIG_FILE" \
  --manifest "$OT_STAGE_MANIFEST_FILE"
RUN_ID="$(jq -er '.runId' "$OT_STAGE_REQUEST_FILE")"
GITHUB_REPO="$(jq -er '.repository' "$OT_STAGE_REQUEST_FILE")"
BRANCH_NAME="$(jq -er '.branch' "$OT_STAGE_REQUEST_FILE")"
STAGE_BASE_COMMIT="$(jq -er '.baseCommit' "$OT_STAGE_REQUEST_FILE")"
BASE_BRANCH="$(jq -er '.baseBranch' "$OT_STAGE_REQUEST_FILE")"
STAGE_EXPECTED_SUBJECT="$(jq -r '.expectedSubject // empty' "$OT_STAGE_REQUEST_FILE")"
AGENT="$(jq -er '.engine // .agent' "$OT_STAGE_REQUEST_FILE")"
TASK_TYPE="$(jq -er '.taskType' "$OT_STAGE_REQUEST_FILE")"
STAGE_CONTEXT_POLICY="$(jq -er '.contextPolicy' "$OT_STAGE_REQUEST_FILE")"
if ! jq -e '.credentialScopes | index("model.invoke") != null' "$OT_STAGE_REQUEST_FILE" >/dev/null; then
  STAGE_MODEL_REQUIRED=0
fi

: "${RUN_ID:?RUN_ID is required}"

trap 'handle_exit "$?"' EXIT

terminate_agent_processes
# An unconfirmed loop child keeps a persistent live-action fence so no sibling
# can expose shared state. The stage boundary has now killed every agent-owned
# process, so those conservative fences can be retired before new work begins.
find /var/lib/openthrottle/loop-actions -name '.ot-active-action.json' -type f -delete 2>/dev/null || true
restore_agent_state_ownership
reset_agent_execution_state

: "${TASK_TYPE:?TASK_TYPE is required}"
is_supported_task_type "$TASK_TYPE" \
  || { log "FATAL: unsupported TASK_TYPE '${TASK_TYPE}'"; exit 1; }

# =============================================================================
# Validate the rest of the required env (SPEC "Sandbox env contract").
# =============================================================================

: "${GITHUB_REPO:?GITHUB_REPO is required}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
: "${BASE_BRANCH:?BASE_BRANCH is required}"
: "${BRANCH_NAME:?BRANCH_NAME is required}"

MAX_TURNS="${MAX_TURNS:-200}"
TASK_TIMEOUT="${TASK_TIMEOUT:-7200}"

# Strip trailing newlines from token-shaped secrets (SPEC phase 1).
GITHUB_TOKEN="$(strip_nl "$GITHUB_TOKEN")"
CLAUDE_CODE_OAUTH_TOKEN="$(strip_nl "${CLAUDE_CODE_OAUTH_TOKEN:-}")"
KIMI_CODE_API_KEY="$(strip_nl "${KIMI_CODE_API_KEY:-}")"
export GITHUB_TOKEN CLAUDE_CODE_OAUTH_TOKEN KIMI_CODE_API_KEY
export GH_TOKEN="$GITHUB_TOKEN"

assert_agent_directory "$OT_DIR"
install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 0700 "$OT_DIR"
for state_dir in "${OT_DIR}/outbox" "${OT_DIR}/inbox"; do
  assert_agent_directory "$state_dir"
  install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 0700 "$state_dir"
done
HEARTBEAT_DIR="/var/lib/openthrottle/heartbeat"
install -d -o root -g root -m 0700 "$HEARTBEAT_DIR"
rm -f "${HEARTBEAT_DIR}/heartbeat.json" "${HEARTBEAT_DIR}/heartbeat.json.tmp"
TASK_LOG="${OT_DIR}/task.log"
rm -f "${OT_DIR}/run-result.json"
rm -f "$TASK_LOG"
install -o "$AGENT_USER" -g "$AGENT_USER" -m 0600 /dev/null "$TASK_LOG"

# Everything from here on (our own log() calls, and anything the agent writes to
# stdout/stderr) is tee'd into task.log so handle_exit() has something to
# summarize on failure.
exec > >(tee -a "$TASK_LOG") 2>&1

# A root-owned executor pulse covers quiet bootstrap and long commands. It is a
# liveness signal only; it is never published as semantic activity.
RUN_ID="$RUN_ID" OT_HEARTBEAT_FILE="${HEARTBEAT_DIR}/heartbeat.json" \
  node "${OPT_DIR}/runner/heartbeat.mjs" &
HEARTBEAT_PID=$!

log "TASK_TYPE=${TASK_TYPE} AGENT_env=${AGENT:-<unset>} repo=${GITHUB_REPO} branch=${BRANCH_NAME}"

# =============================================================================
# Phase 1 — auth files
# =============================================================================
log "phase 1: auth files"

if [[ -n "${CODEX_AUTH_JSON:-}" ]]; then
  mkdir -p "${AGENT_HOME}/.codex"
  # Only strip a *trailing* newline here — this is a JSON blob, not a bare
  # token, so we must not touch whitespace inside it.
  SEED_AUTH="${CODEX_AUTH_JSON%$'\n'}"
  # The seed always wins. The supervisor is the sole refresh authority: it
  # hands this sandbox an access-token-only blob (`tokens.refresh_token` is
  # the empty string) that already covers the whole action timeout, so the
  # sandbox can never mint a token worth preserving and any auth.json left
  # over from an earlier stage of a resumed sandbox is strictly staler than
  # what we are about to install.
  printf '%s' "$SEED_AUTH" | gosu "$AGENT_USER" tee "${AGENT_HOME}/.codex/auth.json" >/dev/null
  chmod 0600 "${AGENT_HOME}/.codex/auth.json"
  log "wrote ~/.codex/auth.json"
else
  rm -f "${AGENT_HOME}/.codex/auth.json"
fi

# Claude subscription auth is env-var only (CLAUDE_CODE_OAUTH_TOKEN); the CLI
# reads it directly from the environment, no file needed.

# =============================================================================
# Phase 2 — clone / checkout / reconstruct branch (idempotent across stages)
# =============================================================================
log "phase 2: repo checkout"

if [[ "${OT_SMOKE_TEST:-0}" == "1" && -n "${OT_GIT_URL_OVERRIDE:-}" ]]; then
  GIT_URL="$OT_GIT_URL_OVERRIDE"
else
  GIT_URL="https://github.com/${GITHUB_REPO}.git"
fi

# GitHub CLI's credential helper reads the current run's GH_TOKEN. The token
# never lands in `.git/config`, so rotation does not require modifying the
# root-sealed repository config in a later stage. Credential-helper setup and
# the commit identity below stay PER-RUN by design (not bake-once): the stage
# credential set is materialized per stage and can rotate or be withheld, and
# reset_agent_execution_state wipes ~/.gitconfig at every stage boundary.
as_agent "gh auth setup-git >/dev/null"

FRESH_CLONE=0
if [[ ! -d "${REPO_DIR}/.git" ]]; then
  log "cloning ${GITHUB_REPO} -> ${REPO_DIR}"
  FRESH_CLONE=1
  as_agent "git clone --quiet '$GIT_URL' '$REPO_DIR'"
  as_agent "git config --global --add safe.directory '$REPO_DIR'"
else
  log "repo already present from an earlier stage — fetching"
  as_agent "git -C '$REPO_DIR' fetch --quiet origin"
fi

# Set or refresh the commit identity every stage. It writes only the
# agent's global git config, which is unaffected by the Phase 3 .git/config
# seal, so this is safe on later stages as well as fresh clones.
configure_git_identity

if [[ -z "$STAGE_EXPECTED_SUBJECT" ]]; then
  # An initial stage of a retriggered generation reuses the ticket branch, and
  # earlier generations may already have published reviewed work to
  # origin/<branch>. initialize_stage_branch checks out exactly that remote
  # head when the branch exists on origin, creates the branch from the sealed
  # base commit only when origin has no such branch, and fails closed — never
  # silently falling back to the base commit — when the published head cannot
  # be reached (OPE-77).
  STAGE_BRANCH_START=""
  if ! STAGE_BRANCH_START="$(as_agent "source '${OPT_DIR}/lib/runtime.sh' && initialize_stage_branch '$REPO_DIR' '$BRANCH_NAME' '$STAGE_BASE_COMMIT'")"; then
    log "$STAGE_BRANCH_START"
    exit 1
  fi
  log "initialized stage branch ${BRANCH_NAME} (${STAGE_BRANCH_START})"
elif as_agent "git -C '$REPO_DIR' show-ref --verify --quiet 'refs/heads/${BRANCH_NAME}'"; then
  as_agent "git -C '$REPO_DIR' checkout --quiet '$BRANCH_NAME'"
elif as_agent "git -C '$REPO_DIR' ls-remote --exit-code --heads origin '$BRANCH_NAME'" >/dev/null 2>&1; then
  log "branch exists on origin only — checking out"
  as_agent "git -C '$REPO_DIR' fetch --quiet origin '$BRANCH_NAME'"
  as_agent "git -C '$REPO_DIR' checkout --quiet -b '$BRANCH_NAME' 'origin/${BRANCH_NAME}'"
else
  log "stage branch is absent — reconstructing from exact sealed base commit ${STAGE_BASE_COMMIT}"
  as_agent "git -C '$REPO_DIR' cat-file -e '${STAGE_BASE_COMMIT}^{commit}'"
  as_agent "git -C '$REPO_DIR' checkout --quiet -b '$BRANCH_NAME' '$STAGE_BASE_COMMIT'"
  as_agent "git -C '$REPO_DIR' reset --hard --quiet '$STAGE_BASE_COMMIT' && git -C '$REPO_DIR' clean -fdq"
fi

# A crash after sealing the stage result but before advancing the long-lived
# checkout can leave local HEAD one checkpoint behind even though the
# supervisor has acknowledged and pushed the exact commit. Reconcile from the
# supervisor-owned remote branch before the next stage. The remote commit is
# accepted only when its tree is exactly the sealed expected subject.
if [[ -n "$STAGE_EXPECTED_SUBJECT" ]] &&
   as_agent "git -C '$REPO_DIR' ls-remote --exit-code --heads origin '$BRANCH_NAME'" >/dev/null 2>&1; then
  as_agent "git -C '$REPO_DIR' fetch --quiet origin '$BRANCH_NAME'"
  REMOTE_STAGE_HEAD="$(as_agent "git -C '$REPO_DIR' rev-parse 'refs/remotes/origin/${BRANCH_NAME}'")"
  REMOTE_STAGE_SUBJECT="$(as_agent "git -C '$REPO_DIR' rev-parse '${REMOTE_STAGE_HEAD}^{tree}'")"
  if [[ "$REMOTE_STAGE_SUBJECT" != "$STAGE_EXPECTED_SUBJECT" ]]; then
    log "FATAL: remote task branch subject does not match the sealed stage subject"
    exit 1
  fi
  as_agent "git -C '$REPO_DIR' reset --hard --quiet '$REMOTE_STAGE_HEAD' && git -C '$REPO_DIR' clean -fdq"
  log "reconciled stage branch to acknowledged remote checkpoint ${REMOTE_STAGE_HEAD}"
fi

# Ignored files are intentionally outside the canonical workspace subject.
# Dependency state produced by the bake-once bootstrap (phase 5) persists for
# the sandbox lifetime under the recorded repository-config digest, so it is
# NOT wiped per stage — that is the entire point of paying post_bootstrap only
# once. What must never carry across a stage boundary is an ignored
# agent-executable config surface (commands/hooks/skills/instructions) that a
# later stage's engine could load, so those paths are still scrubbed every
# stage. This does not extend any stage's authority: tracked content is fenced
# by the sealed base commit / expected subject, engines run with user-only
# setting sources, and fresh-review stages execute against a disposable copy
# with no repository credential.
AGENT_CONFIG_SCRUB_PATHS=(
  ".agents" ".claude" ".claude.json" ".codex" ".config" ".cursor" ".mcp.json"
  ".opencode" ".vscode" "AGENTS.md" "CLAUDE.md"
)
AGENT_CONFIG_SCRUB_ARGS=""
for scrub_path in "${AGENT_CONFIG_SCRUB_PATHS[@]}"; do
  AGENT_CONFIG_SCRUB_ARGS+=" '${scrub_path}'"
done
as_agent "git -C '$REPO_DIR' clean -fdXq --${AGENT_CONFIG_SCRUB_ARGS}"

# =============================================================================
# Phase 3 — safety: pre-push hook + sealed .git/config. Claude is invoked
# with user-only setting sources, so target-repository hooks/settings remain
# editable project data but are never executed by the automated agent.
# =============================================================================
log "phase 3: safety"

HOOKS_PATH="${OPT_DIR}/safety"
STAGE_POLICY_DIR="/run/openthrottle"
STAGE_POLICY_FILE="${STAGE_POLICY_DIR}/stage-push-policy"
STAGE_POLICY_TEMP="$(mktemp)"
install -d -o root -g root -m 0755 "$STAGE_POLICY_DIR"
printf '%s\n' "$STAGE_CONTEXT_POLICY" > "$STAGE_POLICY_TEMP"
install -o root -g root -m 0444 "$STAGE_POLICY_TEMP" "$STAGE_POLICY_FILE"
rm -f "$STAGE_POLICY_TEMP"
STAGE_POLICY_TEMP=""
CURRENT_HOOKS_PATH="$(as_agent "git -C '$REPO_DIR' config --get core.hooksPath" 2>/dev/null || true)"
if [[ "$CURRENT_HOOKS_PATH" != "$HOOKS_PATH" ]]; then
  as_agent "git -C '$REPO_DIR' config core.hooksPath '$HOOKS_PATH'"
  log "installed pre-push hook (core.hooksPath=${HOOKS_PATH})"
else
  log "pre-push hook already installed"
fi
log "installed sealed stage push policy (${STAGE_CONTEXT_POLICY})"

# Seal .git/config as root so the agent (and the agent process itself,
# should it get compromised via prompt injection) cannot unset
# core.hooksPath or repoint origin. Idempotent — seal.sh no-ops if already
# sealed.
"${OPT_DIR}/safety/seal.sh" "${REPO_DIR}/.git/config"

# Local excludes/attributes are runtime control state, not repository content.
# Keep them empty and make their parent non-writable so a review cannot hide a
# later executable project config from the read-only workspace fence.
GIT_INFO_DIR="${REPO_DIR}/.git/info"
if [[ -L "$GIT_INFO_DIR" || ! -d "$GIT_INFO_DIR" ]]; then
  log "FATAL: repository info path is not a directory"
  exit 1
fi
chmod 0755 "$GIT_INFO_DIR"
rm -f "${GIT_INFO_DIR}/exclude" "${GIT_INFO_DIR}/attributes"
install -o root -g root -m 0444 /dev/null "${GIT_INFO_DIR}/exclude"
install -o root -g root -m 0444 /dev/null "${GIT_INFO_DIR}/attributes"
chown root:root "$GIT_INFO_DIR"
chmod 0555 "$GIT_INFO_DIR"

# =============================================================================
# Phase 4 — read .openthrottle.yml (yq), with defaults
# =============================================================================
log "phase 4: reading .openthrottle.yml"

CONFIG_FILE="${OT_STAGE_CONFIG_FILE:-${REPO_DIR}/.openthrottle.yml}"

# $1 = yq filter (applied with a `// "<default>"` fallback), $2 = default.
yq_get() { yq_value_or_default "$CONFIG_FILE" "$1" "$2"; }

CFG_AGENT="$(yq_get '.engine // .agent' 'codex')"
CFG_MODEL="$(yq_get '.model' '')"
MAX_TURNS="$(yq_get '.limits.max_turns' "$MAX_TURNS")"
TASK_TIMEOUT="$(yq_get '.limits.task_timeout' "$TASK_TIMEOUT")"

if [[ -f "$CONFIG_FILE" ]]; then
  MCP_SERVERS_JSON="$(yq -o=json -r '.mcp_servers // {}' "$CONFIG_FILE" 2>/dev/null || echo '{}')"
else
  MCP_SERVERS_JSON='{}'
fi
[[ -z "$MCP_SERVERS_JSON" || "$MCP_SERVERS_JSON" == "null" ]] && MCP_SERVERS_JSON='{}'

POST_BOOTSTRAP_CMDS=()
if [[ -f "$CONFIG_FILE" ]]; then
  while IFS= read -r cmd_line; do
    [[ -n "$cmd_line" ]] && POST_BOOTSTRAP_CMDS+=("$cmd_line")
  done < <(yq -r '.post_bootstrap // [] | .[]' "$CONFIG_FILE" 2>/dev/null || true)
fi

export MAX_TURNS TASK_TIMEOUT

# Cap build-tool fan-out so heavy monorepo builds (Turbo/tsc/Jest launched
# through Turborepo) don't spike past the sandbox memory cgroup and get
# OOM-killed (SIGKILL / exit 137) before diagnostics print. Turbo defaults to
# one task per core (100%); halving that roughly halves peak build memory while
# keeping some parallelism. Only set when unset, so a repo whose build needs
# more (or less) can override it in .openthrottle.yml's post_bootstrap.
export TURBO_CONCURRENCY="${TURBO_CONCURRENCY:-50%}"
OT_CE_PIPELINE="$(jq -er '.capability' "$OT_STAGE_REQUEST_FILE")"
export OT_CE_PIPELINE

# Agent resolution precedence:
#   1. AGENT from the supervisor (Linear label or DEFAULT_AGENT).
#   2. .openthrottle.yml's `agent:` field for local entrypoint runs.
#   3. codex as the local fallback.
if [[ -n "${AGENT:-}" ]]; then
  : # supervisor-selected agent always wins
elif [[ -n "$CFG_AGENT" ]]; then
  AGENT="$CFG_AGENT"
fi
AGENT="${AGENT:-codex}"
export AGENT

case "$AGENT" in
  claude|codex|opencode) ;;
  *) log "FATAL: resolved AGENT='${AGENT}' is invalid (expected claude|codex|opencode)"; exit 1 ;;
esac

# Provider-specific defaults follow the same precedence as the sealed stage
# executor: the selected provider's explicit default wins, while the legacy
# top-level model applies only when the repository's configured agent is the
# provider actually selected for this stage. This early resolution is needed
# for OpenCode because its private config is validated and rendered here,
# before execute-stage.mjs receives control.
CFG_AGENT_MODEL="$(yq_get ".agent_defaults.${AGENT}.model" '')"
RESOLVED_CONFIG_MODEL="$CFG_AGENT_MODEL"
if [[ -z "$RESOLVED_CONFIG_MODEL" && "$CFG_AGENT" == "$AGENT" ]]; then
  RESOLVED_CONFIG_MODEL="$CFG_MODEL"
fi

OPENCODE_MODEL=""
if [[ "$AGENT" == "opencode" && "$STAGE_MODEL_REQUIRED" == "1" ]]; then
  if [[ -z "$KIMI_CODE_API_KEY" ]]; then
    log "FATAL: KIMI_CODE_API_KEY is required for AGENT=opencode"
    exit 1
  fi
  OPENCODE_MODEL="$RESOLVED_CONFIG_MODEL"
  if [[ -z "$OPENCODE_MODEL" ]]; then
    log "FATAL: AGENT=opencode requires agent_defaults.opencode.model (or a matching legacy model) in .openthrottle.yml"
    exit 1
  fi
  OPENCODE_VALIDATION_DIR="$(mktemp -d /tmp/ot-opencode-validate-XXXXXX)"
  if ! node "${OPT_DIR}/runner/build-opencode-config.mjs" \
    --model "$OPENCODE_MODEL" --mcp-json "$MCP_SERVERS_JSON" --config-dir "$OPENCODE_VALIDATION_DIR" >/dev/null; then
    rm -rf "$OPENCODE_VALIDATION_DIR"
    exit 1
  fi
  rm -rf "$OPENCODE_VALIDATION_DIR"
fi

log "config: agent=${AGENT}${OPENCODE_MODEL:+ model=${OPENCODE_MODEL}} ce_pipeline=${OT_CE_PIPELINE} max_turns=${MAX_TURNS} task_timeout=${TASK_TIMEOUT}"

# =============================================================================
# Phase 5 — bake-once bootstrap. post_bootstrap installs and image-derived
# engine probes are paid once per sandbox lifetime, then fenced by a
# root-owned completion marker recording the sealed repository-config digest
# they ran under. Every later stage verifies that marker: a matching marker
# skips the bootstrap (logged, never silent); a mismatched, torn, or
# inconsistent marker fails closed — the sandbox is stale and the supervisor
# must reprovision it. There is no silent re-bootstrap path.
# =============================================================================
log "phase 5: bake-once bootstrap"

BOOTSTRAP_STATE_DIR="/var/lib/openthrottle/bootstrap"
BOOTSTRAP_MARKER="${BOOTSTRAP_STATE_DIR}/bootstrap.json"
BOOTSTRAP_SENTINEL="${BOOTSTRAP_STATE_DIR}/bootstrap.started"
# The request digest is authoritative: --validate-inputs already proved the
# sealed config file's content hashes to exactly this value.
STAGE_CONFIG_DIGEST="$(jq -er '.repositoryConfigDigest' "$OT_STAGE_REQUEST_FILE")"
install -d -o root -g root -m 0700 "$BOOTSTRAP_STATE_DIR"

BOOTSTRAP_DECISION=""
if ! BOOTSTRAP_DECISION="$(evaluate_bootstrap_marker \
    "$BOOTSTRAP_MARKER" "$BOOTSTRAP_SENTINEL" "$STAGE_CONFIG_DIGEST" "$FRESH_CLONE")"; then
  log "$BOOTSTRAP_DECISION"
  exit 1
fi

CODEX_HOOK_TRUST=0
case "$BOOTSTRAP_DECISION" in
  run)
    # The sentinel makes an interrupted bootstrap observable: if this stage
    # dies before the completion marker is sealed, the next stage fails closed
    # instead of silently re-running arbitrary install commands.
    printf '%s\n' "$STAGE_CONFIG_DIGEST" > "$BOOTSTRAP_SENTINEL"
    chmod 0600 "$BOOTSTRAP_SENTINEL"
    if [[ "${#POST_BOOTSTRAP_CMDS[@]}" -gt 0 ]]; then
      for cmd in "${POST_BOOTSTRAP_CMDS[@]}"; do
        log "  > ${cmd}"
        as_agent "cd '$REPO_DIR' && ${cmd}"
      done
    else
      log "no post_bootstrap commands configured"
    fi
    # Probe the installed Codex build once per sandbox. The result depends
    # only on the baked image, so later stages read it from the marker
    # instead of re-invoking the CLI.
    if { as_agent "codex exec --help 2>/dev/null" || true; as_agent "codex --help 2>/dev/null" || true; } \
         | grep -q -- "--dangerously-bypass-hook-trust"; then
      CODEX_HOOK_TRUST=1
    fi
    BOOTSTRAP_MARKER_TEMP="$(mktemp "${BOOTSTRAP_STATE_DIR}/.bootstrap.json.XXXXXX")"
    jq -n \
      --arg digest "$STAGE_CONFIG_DIGEST" \
      --argjson codexHookTrust "$([[ "$CODEX_HOOK_TRUST" == "1" ]] && printf 'true' || printf 'false')" \
      --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '{schema: "openthrottle.sandbox-bootstrap/v1", repositoryConfigDigest: $digest, codexHookTrust: $codexHookTrust, completedAt: $completedAt}' \
      > "$BOOTSTRAP_MARKER_TEMP"
    chmod 0400 "$BOOTSTRAP_MARKER_TEMP"
    mv "$BOOTSTRAP_MARKER_TEMP" "$BOOTSTRAP_MARKER"
    rm -f "$BOOTSTRAP_SENTINEL"
    log "bake-once bootstrap complete (config digest ${STAGE_CONFIG_DIGEST})"
    ;;
  "skip 0"|"skip 1")
    CODEX_HOOK_TRUST="${BOOTSTRAP_DECISION#skip }"
    log "bake-once bootstrap already complete (config digest ${STAGE_CONFIG_DIGEST}); skipping post_bootstrap"
    ;;
  *)
    log "FATAL: unrecognized bootstrap gate decision '${BOOTSTRAP_DECISION}'"
    exit 1
    ;;
esac

if [[ "${OT_COMPOSITE_PREPARE_ONLY:-}" == "1" ]]; then
  log "composite workspace preparation complete; exiting before agent invocation"
  exit 0
fi

log "phase 6-8: fenced one-stage executor"
for sealed_input in "$OT_STAGE_REQUEST_FILE" "$OT_STAGE_CONFIG_FILE" "$OT_STAGE_MANIFEST_FILE"; do
  chmod 0400 "$sealed_input"
done
install -d -o root -g root -m 0700 /var/lib/openthrottle/stage-results
assert_agent_directory "$OT_DIR"
rm -rf "${OT_DIR}/stage"
install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 0700 "${OT_DIR}/stage"
assert_agent_directory "${AGENT_HOME}/.claude"
assert_agent_directory "${AGENT_HOME}/.codex"
LINEAR_CONTEXT_TEMP="$(mktemp)"
jq -r '.taskContext' "$OT_STAGE_REQUEST_FILE" > "$LINEAR_CONTEXT_TEMP"
rm -f "${OT_DIR}/linear-context.md"
install -o "$AGENT_USER" -g "$AGENT_USER" -m 0600 "$LINEAR_CONTEXT_TEMP" "${OT_DIR}/linear-context.md"
rm -f "$LINEAR_CONTEXT_TEMP"
# Skills are materialized later by the action-profile adapter from the sealed
# action allowlist. No engine receives the whole built-in corpus here.

LIVE_STEERING="$(jq -r '.liveSteering' "$OT_STAGE_REQUEST_FILE")"
DRAIN_HOOK="${OPT_DIR}/hooks/ot-inbox-drain.sh"
if [[ "$AGENT" == "claude" ]]; then
  # A flaky snapshot bake or a mid-run Claude config-corruption recovery can
  # leave ~/.claude.json missing while ~/.claude/backups holds the moved copy;
  # the CLI then refuses every launch (OPE-87). Restore the newest backup — an
  # absent config with no backups is the normal post-reset state the CLI
  # regenerates from — and fail closed if no parseable config can be produced.
  CLAUDE_CONFIG_DECISION=""
  if ! CLAUDE_CONFIG_DECISION="$(as_agent "source '${OPT_DIR}/lib/runtime.sh' && heal_claude_config '${AGENT_HOME}/.claude.json' '${AGENT_HOME}/.claude/backups'")"; then
    log "$CLAUDE_CONFIG_DECISION"
    exit 1
  fi
  if [[ "$CLAUDE_CONFIG_DECISION" == restored\ * ]]; then
    log "restored ${AGENT_HOME}/.claude.json from bake backup ${CLAUDE_CONFIG_DECISION#restored }"
  fi
  CLAUDE_SETTINGS="${AGENT_HOME}/.claude/settings.json"
  if [[ "$LIVE_STEERING" == "true" ]]; then
    jq -n --arg cmd "$DRAIN_HOOK" '{ hooks: {
      Stop: [ { hooks: [ { type: "command", command: $cmd } ] } ],
      PostToolUse: [ { matcher: "*", hooks: [ { type: "command", command: $cmd } ] } ]
    } }' > "${CLAUDE_SETTINGS}.tmp"
  else
    printf '{}\n' > "${CLAUDE_SETTINGS}.tmp"
  fi
  mv "${CLAUDE_SETTINGS}.tmp" "$CLAUDE_SETTINGS"
  chown root:root "$CLAUDE_SETTINGS"
  chmod 0444 "$CLAUDE_SETTINGS"
fi

if [[ "$AGENT" == "codex" ]]; then
  rm -f "${AGENT_HOME}/.codex/AGENTS.md" "${AGENT_HOME}/.codex/hooks.json"
  if [[ -f "${OPT_DIR}/skills/codex/AGENTS-fragment.md" ]]; then
    install -o root -g root -m 0444 \
      "${OPT_DIR}/skills/codex/AGENTS-fragment.md" "${AGENT_HOME}/.codex/AGENTS.md"
  fi
  if [[ "$LIVE_STEERING" == "true" ]]; then
    jq -n --arg cmd "$DRAIN_HOOK" '{ hooks: {
      PostToolUse: [ { matcher: "", hooks: [ { type: "command", command: $cmd } ] } ],
      Stop: [ { hooks: [ { type: "command", command: $cmd } ] } ]
    } }' > "${AGENT_HOME}/.codex/hooks.json"
    chown root:root "${AGENT_HOME}/.codex/hooks.json"
    chmod 0444 "${AGENT_HOME}/.codex/hooks.json"
    # The hook-trust capability was probed once during the bake-once
    # bootstrap; CODEX_HOOK_TRUST carries the probed (or marker-recorded)
    # result for this sandbox's baked Codex build.
    if [[ "$CODEX_HOOK_TRUST" == "1" ]]; then
      export OT_CODEX_HOOK_TRUST_FLAG=1
    else
      log "WARNING: codex lacks --dangerously-bypass-hook-trust; steering remains subject to its trust gate"
    fi
  fi
fi

MCP_CONFIG_FILE=""
if [[ "$AGENT" == "claude" ]]; then
  MCP_CONFIG_FILE="$(mktemp /tmp/ot-mcp-XXXXXX.json)"
  jq -n --argjson servers "$MCP_SERVERS_JSON" '{mcpServers: $servers}' > "$MCP_CONFIG_FILE"
  chmod 0600 "$MCP_CONFIG_FILE"
  chown "${AGENT_USER}:${AGENT_USER}" "$MCP_CONFIG_FILE"
  export OT_CLAUDE_MCP_CONFIG="$MCP_CONFIG_FILE"
fi

if [[ "$AGENT" == "opencode" && "$STAGE_MODEL_REQUIRED" == "1" ]]; then
  OPENCODE_CONFIG_DIR="$(mktemp -d /tmp/ot-opencode-XXXXXX)"
  node "${OPT_DIR}/runner/build-opencode-config.mjs" \
    --model "$OPENCODE_MODEL" --mcp-json "$MCP_SERVERS_JSON" --config-dir "$OPENCODE_CONFIG_DIR" >/dev/null
  chmod 0755 "$OPENCODE_CONFIG_DIR"
  chmod 0644 "$OPENCODE_CONFIG_DIR/opencode.json"
  chown -R root:root "$OPENCODE_CONFIG_DIR"
  export OPENCODE_CONFIG_DIR
  export OPENCODE_DISABLE_PROJECT_CONFIG=1
  export OPENCODE_DISABLE_EXTERNAL_SKILLS=1
  export OPENCODE_DISABLE_CLAUDE_CODE=1
  export OPENCODE_DISABLE_AUTOUPDATE=1
  export OPENCODE_DISABLE_SHARE=1
fi

export OT_REPO_DIR="$STAGE_REPO_DIR"

STAGE_EXECUTOR_STATUS=0
node "${OPT_DIR}/runner/execute-stage.mjs" \
  --request "$OT_STAGE_REQUEST_FILE" \
  --config "$OT_STAGE_CONFIG_FILE" \
  --manifest "$OT_STAGE_MANIFEST_FILE" \
  --repo "$STAGE_REPO_DIR" || STAGE_EXECUTOR_STATUS=$?
exit "$STAGE_EXECUTOR_STATUS"
