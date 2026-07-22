#!/usr/bin/env bash
# entrypoint.sh — OpenThrottle sandbox entrypoint. Runs as root inside the
# Daytona sandbox; all repo/agent work happens as the unprivileged `agent`
# user via gosu. See docs/SPEC.md "Sandbox contract" for the 8-phase
# contract this implements, and "Sandbox env contract" for every env var
# referenced below.
#
# Invoked twice per ticket:
#   - TASK_TYPE=implement : first run, right after the sandbox is created.
#   - TASK_TYPE=resume    : supervisor re-execs this same script inside the
#     already-running (or just-restarted) sandbox via the Daytona process
#     exec API, with RESUME_MESSAGE set. Every phase below is written to be
#     safe to re-run (idempotent) so the same script serves both cases.
#
# Never exits without writing a completion marker for the Fly supervisor —
# see write_run_completion() / the EXIT trap below.

set -euo pipefail

AGENT_USER="agent"
AGENT_HOME="/home/agent"
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

# Author agent commits as the GitHub account that owns GH_TOKEN so GitHub can
# attribute them to a real account and integrations that gate on commit-author
# identity (e.g. Vercel) accept the deployment. An explicit OT_GIT_AUTHOR_EMAIL
# (with optional OT_GIT_AUTHOR_NAME) override wins; otherwise the account's
# GitHub noreply identity is derived from `gh api user`. The placeholder is a
# last resort used only when the account lookup fails.
configure_git_identity() {
  local login="" uid="" identity name email
  if [[ -z "${OT_GIT_AUTHOR_EMAIL:-}" ]]; then
    login="$(as_agent "gh api user --jq .login" 2>/dev/null || true)"
    uid="$(as_agent "gh api user --jq .id" 2>/dev/null || true)"
    if [[ -z "$login" || -z "$uid" ]]; then
      log "WARNING: could not resolve a GitHub commit identity; author-gated integrations (e.g. Vercel) may reject commits"
    fi
  fi
  identity="$(resolve_git_identity "${OT_GIT_AUTHOR_NAME:-}" "${OT_GIT_AUTHOR_EMAIL:-}" "$login" "$uid")"
  name="${identity%%$'\t'*}"
  email="${identity#*$'\t'}"
  # Write to the agent's global config (like safe.directory above), never the
  # repository's .git/config: Phase 3 seals .git/config immutable, so a
  # repo-local write would fail on resume and abort the entrypoint. The clone
  # never sets a repo-local user.*, so this global identity always applies.
  as_agent "git config --global user.name '$name'"
  as_agent "git config --global user.email '$email'"
  log "commit identity: ${name} <${email}>"
}

COMPLETION_WRITTEN=0

write_run_completion() {
  local exit_code="$1"
  [[ -n "${RUN_ID:-}" && -n "${RUN_CALLBACK_TOKEN:-}" ]] || return 1

  local result_file="${OT_DIR}/run-result.json"
  local cost_usd="" final_response=""
  [[ -f "$result_file" ]] && cost_usd="$(jq -r '.cost_usd // empty' "$result_file" 2>/dev/null || true)"
  [[ -f "$result_file" ]] && final_response="$(jq -r '.final_response // empty' "$result_file" 2>/dev/null || true)"

  local tail_raw="" failure_tail="" pr_url="${PR_URL:-}" payload
  if [[ "$exit_code" -ne 0 ]]; then
    tail_raw="$(tail -c 4000 "${TASK_LOG:-/dev/null}" 2>/dev/null || true)"
    failure_tail="$(sanitize_log "$tail_raw")"
  fi
  payload="$(jq -n \
    --arg eventId "$(cat /proc/sys/kernel/random/uuid)" \
    --arg runId "$RUN_ID" \
    --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
    --arg token "$RUN_CALLBACK_TOKEN" \
    --argjson exitCode "$exit_code" \
    --arg cost "$cost_usd" \
    --arg finalResponse "$final_response" \
    --arg prUrl "$pr_url" \
    --arg failureTail "$failure_tail" \
    '{
       version: 1,
       kind: "completion",
       event_id: $eventId,
       run_id: $runId,
       created_at: $createdAt,
       token: $token,
       exit_code: $exitCode
     }
     + (if $cost == "" then {} else {cost_usd: ($cost | tonumber)} end)
     + (if $finalResponse == "" then {} else {final_response: $finalResponse} end)
     + (if $prUrl == "" then {} else {pr_url: $prUrl} end)
     + (if $failureTail == "" then {} else {failure_tail: $failureTail} end)')" || return 1

  local outbox_dir="${OT_DIR}/outbox"
  local stamp final_path temporary_path
  stamp="$(date +%s%3N)"
  mkdir -p "$outbox_dir"
  final_path="${outbox_dir}/${stamp}-completion-${RUN_ID}.json"
  temporary_path="${final_path}.tmp"
  printf '%s\n' "$payload" > "$temporary_path"
  chmod 0600 "$temporary_path"
  chown "${AGENT_USER}:${AGENT_USER}" "$temporary_path" 2>/dev/null || true
  mv "$temporary_path" "$final_path"
  log "wrote completion marker (run=${RUN_ID})"
}

# Always runs on script exit (success or failure). Fly polls this marker through
# the Daytona SDK, so completion does not depend on sandbox outbound internet.
handle_exit() {
  local exit_code="${1:-0}"
  if [[ -n "${MCP_CONFIG_FILE:-}" ]]; then
    rm -f "$MCP_CONFIG_FILE"
  fi
  if [[ -n "${OPENCODE_CONFIG_DIR:-}" ]]; then
    rm -rf "$OPENCODE_CONFIG_DIR"
  fi
  [[ "$COMPLETION_WRITTEN" == "1" ]] && return 0
  COMPLETION_WRITTEN=1
  write_run_completion "$exit_code" || log "ERROR: failed to write completion marker"
}

# =============================================================================
# Validate the bare minimum needed to report failures, then install the
# EXIT trap before doing anything else that could fail.
# =============================================================================

: "${RUN_ID:?RUN_ID is required}"
: "${RUN_CALLBACK_TOKEN:?RUN_CALLBACK_TOKEN is required}"

trap 'handle_exit "$?"' EXIT

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

if [[ "$TASK_TYPE" == "resume" ]]; then
  : "${RESUME_MESSAGE:?RESUME_MESSAGE is required when TASK_TYPE=resume}"
fi

MAX_TURNS="${MAX_TURNS:-200}"
TASK_TIMEOUT="${TASK_TIMEOUT:-7200}"
DEV_PORT="${DEV_PORT:-3000}"

# Strip trailing newlines from token-shaped secrets (SPEC phase 1).
GITHUB_TOKEN="$(strip_nl "$GITHUB_TOKEN")"
CLAUDE_CODE_OAUTH_TOKEN="$(strip_nl "${CLAUDE_CODE_OAUTH_TOKEN:-}")"
KIMI_CODE_API_KEY="$(strip_nl "${KIMI_CODE_API_KEY:-}")"
export GITHUB_TOKEN CLAUDE_CODE_OAUTH_TOKEN KIMI_CODE_API_KEY
export GH_TOKEN="$GITHUB_TOKEN"

mkdir -p "$OT_DIR" "${OT_DIR}/outbox" "${OT_DIR}/inbox"
chown -R "${AGENT_USER}:${AGENT_USER}" "$AGENT_HOME"
TASK_LOG="${OT_DIR}/task.log"
rm -f "${OT_DIR}/run-result.json"
: > "$TASK_LOG" || true
chown "${AGENT_USER}:${AGENT_USER}" "$TASK_LOG" || true

# Everything from here on (our own log() calls, and anything the agent
# writes to stdout/stderr through runner/normalize.mjs) is tee'd into
# task.log so handle_exit() has something to summarize on failure.
exec > >(tee -a "$TASK_LOG") 2>&1

log "TASK_TYPE=${TASK_TYPE} AGENT_env=${AGENT:-<unset>} repo=${GITHUB_REPO} branch=${BRANCH_NAME}"

# =============================================================================
# Phase 1 — auth files
# =============================================================================
log "phase 1: auth files"

if [[ -n "${CODEX_AUTH_JSON:-}" ]]; then
  mkdir -p "${AGENT_HOME}/.codex"
  if [[ -s "${AGENT_HOME}/.codex/auth.json" ]]; then
    # Resume reuses this sandbox, and Codex may have already rotated its refresh
    # token into auth.json. OpenAI invalidates the previous refresh token on
    # every rotation, so overwriting the file with the (older) seed would replay
    # a spent token — the "refresh token was already used" failure. Keep the
    # sandbox's rotated copy; the supervisor reads it back to reseed later runs.
    log "~/.codex/auth.json already present — keeping the sandbox's rotated token"
  else
    # Only strip a *trailing* newline here — this is a JSON blob, not a bare
    # token, so we must not touch whitespace inside it.
    printf '%s' "${CODEX_AUTH_JSON%$'\n'}" > "${AGENT_HOME}/.codex/auth.json"
    chmod 0600 "${AGENT_HOME}/.codex/auth.json"
    log "wrote ~/.codex/auth.json"
  fi
  chown -R "${AGENT_USER}:${AGENT_USER}" "${AGENT_HOME}/.codex"
else
  rm -f "${AGENT_HOME}/.codex/auth.json"
fi

# Claude subscription auth is env-var only (CLAUDE_CODE_OAUTH_TOKEN); the CLI
# reads it directly from the environment, no file needed.

# =============================================================================
# Phase 2 — clone / checkout / push branch (idempotent for resume)
# =============================================================================
log "phase 2: repo checkout"

if [[ "${OT_SMOKE_TEST:-0}" == "1" && -n "${OT_GIT_URL_OVERRIDE:-}" ]]; then
  GIT_URL="$OT_GIT_URL_OVERRIDE"
else
  GIT_URL="https://github.com/${GITHUB_REPO}.git"
fi

# GitHub CLI's credential helper reads the current run's GH_TOKEN. The token
# never lands in `.git/config`, so rotation does not require modifying the
# root-sealed repository config on resume.
as_agent "gh auth setup-git >/dev/null"

if [[ ! -d "${REPO_DIR}/.git" ]]; then
  log "cloning ${GITHUB_REPO} -> ${REPO_DIR}"
  as_agent "git clone --quiet '$GIT_URL' '$REPO_DIR'"
  as_agent "git config --global --add safe.directory '$REPO_DIR'"
else
  log "repo already present (resume) — fetching"
  as_agent "git -C '$REPO_DIR' fetch --quiet origin"
fi

# Set (or refresh, on resume) the commit identity every run. It writes only the
# agent's global git config, which is unaffected by the Phase 3 .git/config
# seal, so this is safe on resume as well as on fresh clones.
configure_git_identity

if as_agent "git -C '$REPO_DIR' show-ref --verify --quiet 'refs/heads/${BRANCH_NAME}'"; then
  as_agent "git -C '$REPO_DIR' checkout --quiet '$BRANCH_NAME'"
elif as_agent "git -C '$REPO_DIR' ls-remote --exit-code --heads origin '$BRANCH_NAME'" >/dev/null 2>&1; then
  log "branch exists on origin only — checking out"
  as_agent "git -C '$REPO_DIR' fetch --quiet origin '$BRANCH_NAME'"
  as_agent "git -C '$REPO_DIR' checkout --quiet -b '$BRANCH_NAME' 'origin/${BRANCH_NAME}'"
else
  log "branch does not exist yet — creating from ${BASE_BRANCH}"
  as_agent "git -C '$REPO_DIR' fetch --quiet origin '$BASE_BRANCH'"
  as_agent "git -C '$REPO_DIR' checkout --quiet -b '$BRANCH_NAME' 'origin/${BASE_BRANCH}'"
fi

if [[ "$TASK_TYPE" == "resume" ]]; then
  log "resume: pulling latest ${BRANCH_NAME}"
  as_agent "git -C '$REPO_DIR' pull --quiet --ff-only origin '$BRANCH_NAME'" \
    || log "WARNING: fast-forward pull failed — continuing with local branch state"
fi

# Push immediately so the branch exists on origin as the human escape hatch,
# even before the agent makes its first commit. No-op ("Everything
# up-to-date") on a resume where nothing changed locally.
as_agent "git -C '$REPO_DIR' push --quiet -u origin '$BRANCH_NAME'"

# =============================================================================
# Phase 3 — safety: pre-push hook + sealed .git/config. Claude is invoked
# with user-only setting sources, so target-repository hooks/settings remain
# editable project data but are never executed by the automated agent.
# =============================================================================
log "phase 3: safety"

HOOKS_PATH="${OPT_DIR}/safety"
CURRENT_HOOKS_PATH="$(as_agent "git -C '$REPO_DIR' config --get core.hooksPath" 2>/dev/null || true)"
if [[ "$CURRENT_HOOKS_PATH" != "$HOOKS_PATH" ]]; then
  as_agent "git -C '$REPO_DIR' config core.hooksPath '$HOOKS_PATH'"
  log "installed pre-push hook (core.hooksPath=${HOOKS_PATH})"
else
  log "pre-push hook already installed"
fi

# Seal .git/config as root so the agent (and the agent process itself,
# should it get compromised via prompt injection) cannot unset
# core.hooksPath or repoint origin. Idempotent — seal.sh no-ops if already
# sealed.
"${OPT_DIR}/safety/seal.sh" "${REPO_DIR}/.git/config"

# =============================================================================
# Phase 4 — read .openthrottle.yml (yq), with defaults
# =============================================================================
log "phase 4: reading .openthrottle.yml"

CONFIG_FILE="${REPO_DIR}/.openthrottle.yml"

# $1 = yq filter (applied with a `// "<default>"` fallback), $2 = default.
yq_get() { yq_value_or_default "$CONFIG_FILE" "$1" "$2"; }

CFG_AGENT="$(yq_get '.agent' 'codex')"
CFG_MODEL="$(yq_get '.model' '')"
CFG_DEV="$(yq_get '.dev' '')"
CFG_TEST="$(yq_get '.test' '')"
CFG_LINT="$(yq_get '.lint' '')"
CFG_BUILD="$(yq_get '.build' '')"
CFG_FORMAT="$(yq_get '.format' '')"
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

# Surface test/lint/build/format/dev to the agent process as env vars — SPEC
# phase 4 has entrypoint read them but doesn't otherwise say how the agent
# (specifically the implement-plan skill, which must "run configured
# test/lint/build before opening the PR") is meant to learn them. Exporting
# them here (inherited by the gosu'd agent process in as_agent/run below) is
# the simplest option that doesn't make every skill re-parse yq itself.
export OT_TEST_CMD="$CFG_TEST"
export OT_LINT_CMD="$CFG_LINT"
export OT_BUILD_CMD="$CFG_BUILD"
export OT_FORMAT_CMD="$CFG_FORMAT"
export OT_DEV_CMD="$CFG_DEV"
export OT_DEV_PORT="$DEV_PORT"

# Cap build-tool fan-out so heavy monorepo builds (Turbo/tsc/Jest launched
# through Turborepo) don't spike past the sandbox memory cgroup and get
# OOM-killed (SIGKILL / exit 137) before diagnostics print. Turbo defaults to
# one task per core (100%); halving that roughly halves peak build memory while
# keeping some parallelism. Only set when unset, so a repo whose build needs
# more (or less) can override it in .openthrottle.yml's post_bootstrap.
export TURBO_CONCURRENCY="${TURBO_CONCURRENCY:-50%}"
OT_CE_PIPELINE="$(task_ce_pipeline "$TASK_TYPE")"
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

OPENCODE_MODEL_FILE="${OT_DIR}/agent-model"
OPENCODE_MODEL=""
if [[ "$AGENT" == "opencode" ]]; then
  if [[ -z "$KIMI_CODE_API_KEY" ]]; then
    log "FATAL: KIMI_CODE_API_KEY is required for AGENT=opencode"
    exit 1
  fi
  if [[ "$TASK_TYPE" == "resume" ]]; then
    OPENCODE_MODEL="$(as_agent "cat '${OPENCODE_MODEL_FILE}' 2>/dev/null" || true)"
    if [[ -z "$OPENCODE_MODEL" ]]; then
      log "FATAL: resume requested for OpenCode but ${OPENCODE_MODEL_FILE} is missing/empty"
      exit 1
    fi
  else
    OPENCODE_MODEL="$CFG_MODEL"
    if [[ -z "$OPENCODE_MODEL" ]]; then
      log "FATAL: AGENT=opencode requires model: kimi-code/kimi-for-coding in .openthrottle.yml"
      exit 1
    fi
    OPENCODE_VALIDATION_DIR="$(mktemp -d /tmp/ot-opencode-validate-XXXXXX)"
    if ! node "${OPT_DIR}/runner/build-opencode-config.mjs" \
      --model "$OPENCODE_MODEL" --mcp-json '{}' --config-dir "$OPENCODE_VALIDATION_DIR" >/dev/null; then
      rm -rf "$OPENCODE_VALIDATION_DIR"
      exit 1
    fi
    rm -rf "$OPENCODE_VALIDATION_DIR"
    printf '%s\n' "$OPENCODE_MODEL" > "$OPENCODE_MODEL_FILE"
    chmod 0600 "$OPENCODE_MODEL_FILE"
    chown "${AGENT_USER}:${AGENT_USER}" "$OPENCODE_MODEL_FILE"
  fi
fi

log "config: agent=${AGENT}${OPENCODE_MODEL:+ model=${OPENCODE_MODEL}} ce_pipeline=${OT_CE_PIPELINE} dev='${CFG_DEV}' max_turns=${MAX_TURNS} task_timeout=${TASK_TIMEOUT}"

# =============================================================================
# Phase 5 — post_bootstrap
# =============================================================================
log "phase 5: post_bootstrap"

if [[ "${#POST_BOOTSTRAP_CMDS[@]}" -gt 0 ]]; then
  for cmd in "${POST_BOOTSTRAP_CMDS[@]}"; do
    log "  > ${cmd}"
    as_agent "cd '$REPO_DIR' && ${cmd}"
  done
else
  log "no post_bootstrap commands configured"
fi

# =============================================================================
# Phase 6 — dev server (background)
# =============================================================================
log "phase 6: dev server"

DEV_LOG="${OT_DIR}/dev.log"
DEV_PID_FILE="${OT_DIR}/dev.pid"

if [[ -n "$CFG_DEV" ]]; then
  if [[ -f "$DEV_PID_FILE" ]]; then
    OLD_PID="$(cat "$DEV_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
      log "restarting dev server (stopping previous pid ${OLD_PID})"
      kill "$OLD_PID" 2>/dev/null || true
      sleep 1
      kill -9 "$OLD_PID" 2>/dev/null || true
    fi
  fi
  log "starting dev server: ${CFG_DEV} (0.0.0.0:${DEV_PORT})"
  as_agent "cd '$REPO_DIR' && DEV_PORT='$DEV_PORT' PORT='$DEV_PORT' HOST=0.0.0.0 HOSTNAME=0.0.0.0 nohup ${CFG_DEV} >> '$DEV_LOG' 2>&1 < /dev/null & echo \$! > '$DEV_PID_FILE'"
else
  log "no dev command configured, skipping"
fi

# =============================================================================
# Phase 7 — run the agent under `timeout $TASK_TIMEOUT`, piped through
# runner/normalize.mjs. Skills are installed first.
# =============================================================================
log "phase 7: agent run"

# Claude skills live in the sandbox user's skill directory, never inside the
# target checkout. This avoids overwriting or dirtying a repository that
# already tracks its own .claude/skills content. Codex and OpenCode do not use
# this copy: Codex discovers the same canonical skills baked into
# /etc/codex/skills at image build time (admin scope), and OpenCode's prompt
# is rendered from the canonical file at runtime below.
mkdir -p "${AGENT_HOME}/.claude/skills"
if [[ -d "${OPT_DIR}/skills/tasks" ]]; then
  cp -r "${OPT_DIR}/skills/tasks/." "${AGENT_HOME}/.claude/skills/"
fi
chown -R "${AGENT_USER}:${AGENT_USER}" "${AGENT_HOME}/.claude"

# Mid-run steering "inbox": register the baked drain hook in the sandbox user's
# ~/.claude/settings.json (user scope, so it applies under `--setting-sources
# user`). The supervisor's inbox poller drops steering files into ~/.ot/inbox;
# on each PostToolUse the hook injects them as additionalContext, and on Stop it
# blocks so a run cannot end with unread steering. Merge into any existing
# settings so plugin-managed keys survive; fall back to a fresh file if the
# existing one is unparseable. Idempotent on resume.
if [[ "$AGENT" == "claude" ]]; then
  CLAUDE_SETTINGS="${AGENT_HOME}/.claude/settings.json"
  DRAIN_HOOK="${OPT_DIR}/hooks/ot-inbox-drain.sh"
  CLAUDE_SETTINGS_BASE='{}'
  [[ -s "$CLAUDE_SETTINGS" ]] && CLAUDE_SETTINGS_BASE="$(cat "$CLAUDE_SETTINGS")"
  if ! printf '%s' "$CLAUDE_SETTINGS_BASE" | jq \
      --arg cmd "$DRAIN_HOOK" '
        .hooks = (.hooks // {})
        | .hooks.Stop = [ { hooks: [ { type: "command", command: $cmd } ] } ]
        | .hooks.PostToolUse = [ { matcher: "*", hooks: [ { type: "command", command: $cmd } ] } ]
      ' > "${CLAUDE_SETTINGS}.tmp" 2>/dev/null; then
    jq -n --arg cmd "$DRAIN_HOOK" '
      { hooks: {
          Stop: [ { hooks: [ { type: "command", command: $cmd } ] } ],
          PostToolUse: [ { matcher: "*", hooks: [ { type: "command", command: $cmd } ] } ]
      } }' > "${CLAUDE_SETTINGS}.tmp"
  fi
  mv "${CLAUDE_SETTINGS}.tmp" "$CLAUDE_SETTINGS"
  chmod 0644 "$CLAUDE_SETTINGS"
  chown "${AGENT_USER}:${AGENT_USER}" "$CLAUDE_SETTINGS"
  log "registered Claude inbox drain hook (${DRAIN_HOOK})"
fi

# Codex mid-run steering is wired in the Codex config block below: it registers
# the same baked ot-inbox-drain.sh via ~/.codex/hooks.json. Codex and Claude
# share the hook stdin/stdout contract, so the drain script serves both unchanged.
#
# TODO(opencode steering): OpenCode has no settings.json-style hook system; its
# equivalent is a plugin. Delivering mid-run steering to OpenCode requires a
# small baked OpenCode plugin that polls ~/.ot/inbox and injects — a documented
# follow-up, deliberately not attempted here.

# Codex global instructions live outside the target checkout so AGENTS.md
# remains ordinary project data that a ticket can create or edit.
CODEX_HOOK_TRUST_FLAG=()
if [[ "$AGENT" == "codex" ]]; then
  AGENTS_FRAGMENT="${OPT_DIR}/skills/codex/AGENTS-fragment.md"
  if [[ -f "$AGENTS_FRAGMENT" ]]; then
    mkdir -p "${AGENT_HOME}/.codex"
    cp "$AGENTS_FRAGMENT" "${AGENT_HOME}/.codex/AGENTS.md"
    chown -R "${AGENT_USER}:${AGENT_USER}" "${AGENT_HOME}/.codex"
  else
    log "WARNING: ${AGENTS_FRAGMENT} not found, skipping global Codex instructions"
  fi

  # Mid-run steering: register the baked drain hook for Codex. Codex hooks are
  # enabled by default and share Claude's stdin (`hook_event_name`) and output
  # (`hookSpecificOutput.additionalContext`; Stop uses `decision:block`+`reason`)
  # contract, so ot-inbox-drain.sh serves both unchanged. hooks.json is a fresh,
  # isolated file — no config.toml merge risk.
  DRAIN_HOOK="${OPT_DIR}/hooks/ot-inbox-drain.sh"
  mkdir -p "${AGENT_HOME}/.codex"
  jq -n --arg cmd "$DRAIN_HOOK" '{
    hooks: {
      PostToolUse: [ { matcher: "", hooks: [ { type: "command", command: $cmd } ] } ],
      Stop: [ { hooks: [ { type: "command", command: $cmd } ] } ]
    }
  }' > "${AGENT_HOME}/.codex/hooks.json"
  chmod 0644 "${AGENT_HOME}/.codex/hooks.json"
  chown "${AGENT_USER}:${AGENT_USER}" "${AGENT_HOME}/.codex/hooks.json"

  # A non-managed command hook only runs once trusted, which a non-interactive
  # `codex exec` cannot do, so bypass trust for this invocation — but ONLY if the
  # pinned Codex advertises the flag, so an unknown flag can never break Codex
  # runs (worst case degrades to "no steering", never to a failed run).
  if { as_agent "codex exec --help 2>/dev/null" || true; as_agent "codex --help 2>/dev/null" || true; } \
       | grep -q -- "--dangerously-bypass-hook-trust"; then
    CODEX_HOOK_TRUST_FLAG=(--dangerously-bypass-hook-trust)
    log "registered Codex inbox drain hook (${DRAIN_HOOK}); hook-trust bypass enabled"
  else
    log "WARNING: codex lacks --dangerously-bypass-hook-trust; mid-run steering hook will be skipped by the trust gate"
  fi
fi

# MCP config for Claude contains only project-declared servers. Linear remains
# a Fly-owned boundary and no Linear credential enters this sandbox. Codex does
# not consume this file, so avoid materializing it for Codex runs.
MCP_CONFIG_FILE=""
if [[ "$AGENT" == "claude" ]]; then
  MCP_CONFIG_FILE="$(mktemp /tmp/ot-mcp-XXXXXX.json)"
  jq -n --argjson servers "$MCP_SERVERS_JSON" '{mcpServers: $servers}' > "$MCP_CONFIG_FILE"
  chmod 600 "$MCP_CONFIG_FILE"
  chown "${AGENT_USER}:${AGENT_USER}" "$MCP_CONFIG_FILE"
fi

if [[ "$AGENT" == "opencode" ]]; then
  OPENCODE_CONFIG_DIR="$(mktemp -d /tmp/ot-opencode-XXXXXX)"
  node "${OPT_DIR}/runner/build-opencode-config.mjs" \
    --model "$OPENCODE_MODEL" \
    --mcp-json "$MCP_SERVERS_JSON" \
    --config-dir "$OPENCODE_CONFIG_DIR" >/dev/null
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

# Build the exact agent command line per SPEC "Agent invocation" (verbatim
# flags), then run it under `timeout`, piped through normalize.mjs — all as
# the `agent` user in one gosu'd subshell so normalize.mjs's
# ~/.ot/agent-session-id write lands with the right owner/HOME.
AGENT_EXIT=0
CODEX_STDIN_FILE=""
OPENCODE_PROMPT_FILE=""

case "${AGENT}:${TASK_TYPE}" in
  claude:implement|claude:investigate)
    SKILL_NAME="$(task_skill_name "$TASK_TYPE")"
    AGENT_CMD=(claude -p "/${SKILL_NAME}" --output-format stream-json --verbose \
      --max-turns "$MAX_TURNS" --dangerously-skip-permissions \
      --mcp-config "$MCP_CONFIG_FILE" --strict-mcp-config \
      --setting-sources user)
    ;;
  claude:resume)
    SAVED_SESSION_ID="$(as_agent "cat '${OT_DIR}/agent-session-id' 2>/dev/null" || true)"
    if [[ -z "$SAVED_SESSION_ID" ]]; then
      log "FATAL: resume requested but ${OT_DIR}/agent-session-id is missing/empty"
      exit 1
    fi
    AGENT_CMD=(claude -p --resume "$SAVED_SESSION_ID" "$RESUME_MESSAGE" \
      --output-format stream-json --verbose --max-turns "$MAX_TURNS" \
      --dangerously-skip-permissions --mcp-config "$MCP_CONFIG_FILE" \
      --strict-mcp-config --setting-sources user)
    ;;
  codex:implement|codex:investigate)
    # Codex discovers the skill body itself natively from the admin-scope
    # /etc/codex/skills baked in at image build time (see Dockerfile) — the
    # stdin file only needs to name it, not carry its full text.
    SKILL_NAME="$(task_skill_name "$TASK_TYPE")"
    CODEX_STDIN_FILE="${OT_DIR}/codex-${TASK_TYPE}-stdin.md"
    {
      printf '$%s\n' "$SKILL_NAME"
      printf '\n## Runtime context\n- Task type: %s\n- CE pipeline: %s\n- Issue: %s (%s)\n- Repository: %s\n- Branch: %s\n- Base branch: %s\n' \
        "$TASK_TYPE" "$OT_CE_PIPELINE" "${LINEAR_ISSUE_IDENTIFIER:-unknown}" "${LINEAR_ISSUE_ID:-unknown}" \
        "$GITHUB_REPO" "$BRANCH_NAME" "$BASE_BRANCH"
      printf '\n\n## Linear ticket context\n'
      cat "${OT_DIR}/linear-context.md"
    } > "$CODEX_STDIN_FILE"
    chown "${AGENT_USER}:${AGENT_USER}" "$CODEX_STDIN_FILE"
    AGENT_CMD=(codex exec --json --dangerously-bypass-approvals-and-sandbox \
      "${CODEX_HOOK_TRUST_FLAG[@]}" --skip-git-repo-check -C "$REPO_DIR")
    ;;
  codex:resume)
    SAVED_SESSION_ID="$(as_agent "cat '${OT_DIR}/agent-session-id' 2>/dev/null" || true)"
    if [[ -z "$SAVED_SESSION_ID" ]]; then
      log "FATAL: resume requested but ${OT_DIR}/agent-session-id is missing/empty"
      exit 1
    fi
    AGENT_CMD=(codex exec --json --dangerously-bypass-approvals-and-sandbox \
      "${CODEX_HOOK_TRUST_FLAG[@]}" --skip-git-repo-check -C "$REPO_DIR" \
      resume "$SAVED_SESSION_ID" "$RESUME_MESSAGE")
    ;;
  opencode:implement|opencode:investigate)
    # OpenCode cannot yet discover skills from a sandbox-owned admin
    # directory the way Codex does, so the canonical SKILL.md is rendered
    # into the prompt at runtime: strip its YAML frontmatter (the first
    # `---`...`---` block) and append the same runtime-context/Linear-context
    # blocks Codex gets.
    SKILL_NAME="$(task_skill_name "$TASK_TYPE")"
    OPENCODE_PROMPT_FILE="${OT_DIR}/opencode-${TASK_TYPE}-prompt.md"
    {
      awk 'NR==1 && $0=="---" { fm=1; next } fm && $0=="---" { fm=0; next } fm { next } { print }' \
        "${OPT_DIR}/skills/tasks/${SKILL_NAME}/SKILL.md"
      printf '\n\n## Runtime context\n- Task type: %s\n- CE pipeline: %s\n- Issue: %s (%s)\n- Repository: %s\n- Branch: %s\n- Base branch: %s\n' \
        "$TASK_TYPE" "$OT_CE_PIPELINE" "${LINEAR_ISSUE_IDENTIFIER:-unknown}" "${LINEAR_ISSUE_ID:-unknown}" \
        "$GITHUB_REPO" "$BRANCH_NAME" "$BASE_BRANCH"
      printf '\n\n## Linear ticket context\n'
      cat "${OT_DIR}/linear-context.md"
    } > "$OPENCODE_PROMPT_FILE"
    chown "${AGENT_USER}:${AGENT_USER}" "$OPENCODE_PROMPT_FILE"
    AGENT_CMD=(opencode run --format json --model "$OPENCODE_MODEL" --dir "$REPO_DIR" --auto)
    ;;
  opencode:resume)
    SAVED_SESSION_ID="$(as_agent "cat '${OT_DIR}/agent-session-id' 2>/dev/null" || true)"
    if [[ -z "$SAVED_SESSION_ID" ]]; then
      log "FATAL: resume requested but ${OT_DIR}/agent-session-id is missing/empty"
      exit 1
    fi
    OPENCODE_PROMPT_FILE="${OT_DIR}/opencode-resume-prompt.md"
    printf '%s\n' "$RESUME_MESSAGE" > "$OPENCODE_PROMPT_FILE"
    chown "${AGENT_USER}:${AGENT_USER}" "$OPENCODE_PROMPT_FILE"
    AGENT_CMD=(opencode run --format json --model "$OPENCODE_MODEL" --dir "$REPO_DIR" --auto \
      --session "$SAVED_SESSION_ID")
    ;;
  *)
    log "FATAL: unsupported AGENT='${AGENT}' TASK_TYPE='${TASK_TYPE}' combination"
    exit 1
    ;;
esac

# Safely re-quote the array for the gosu'd bash -c string (handles
# RESUME_MESSAGE / plan text containing spaces, quotes, newlines, etc).
QUOTED_CMD="$(printf '%q ' "${AGENT_CMD[@]}")"

log "running: ${AGENT}:${TASK_TYPE} (max_turns=${MAX_TURNS}, timeout=${TASK_TIMEOUT}s)"

set +e
if [[ -n "$CODEX_STDIN_FILE" ]]; then
  as_agent "set -o pipefail; cd '$REPO_DIR' && timeout '$TASK_TIMEOUT' $QUOTED_CMD - < '$CODEX_STDIN_FILE' 2>&1 | node '${OPT_DIR}/runner/normalize.mjs'"
elif [[ -n "$OPENCODE_PROMPT_FILE" ]]; then
  as_agent "set -o pipefail; cd '$REPO_DIR' && OT_PROMPT=\$(cat '$OPENCODE_PROMPT_FILE') && timeout '$TASK_TIMEOUT' $QUOTED_CMD \"\$OT_PROMPT\" 2>&1 | node '${OPT_DIR}/runner/normalize.mjs'"
else
  as_agent "set -o pipefail; cd '$REPO_DIR' && timeout '$TASK_TIMEOUT' $QUOTED_CMD 2>&1 | node '${OPT_DIR}/runner/normalize.mjs'"
fi
AGENT_EXIT=$?
set -e

log "agent exited with code ${AGENT_EXIT}"

# Best-effort: pick up the PR URL for the success activity body, if the
# implement-plan/investigate skill already opened one via `gh pr create`.
if [[ "$AGENT_EXIT" -eq 0 ]]; then
  PR_URL="$(as_agent "cd '$REPO_DIR' && gh pr view '$BRANCH_NAME' --json url -q .url 2>/dev/null" || true)"
fi

[[ -z "$MCP_CONFIG_FILE" ]] || rm -f "$MCP_CONFIG_FILE"

# =============================================================================
# Phase 8 — completion marker. Handled by the EXIT trap and consumed by Fly.
# =============================================================================
exit "$AGENT_EXIT"
