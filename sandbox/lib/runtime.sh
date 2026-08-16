#!/usr/bin/env bash

# Pure helpers shared by entrypoint.sh and the shell test suite. Sourcing this
# file has no side effects.

strip_nl() {
  local value="$1"
  while [[ "$value" == *$'\n' || "$value" == *$'\r' ]]; do
    value="${value%$'\n'}"
    value="${value%$'\r'}"
  done
  printf '%s' "$value"
}

# resolve_git_identity GH_LOGIN GH_UID
#
# Chooses the authenticated GitHub account's noreply identity so GitHub
# attributes commits correctly, with a deterministic placeholder only when the
# account lookup fails. Emits "<name>\t<email>".
resolve_git_identity() {
  local login="$1" uid="$2" name="" email=""
  if [[ "$login" =~ ^[A-Za-z0-9-]+$ && "$uid" =~ ^[0-9]+$ ]]; then
    name="$login"
    email="${uid}+${login}@users.noreply.github.com"
  fi
  if [[ -z "$email" ]]; then
    name="${name:-OpenThrottle Agent}"
    email="agent@openthrottle.dev"
  fi
  printf '%s\t%s\n' "$name" "$email"
}

yq_value_or_default() {
  local file="$1"
  local filter="$2"
  local fallback="$3"
  if [[ -f "$file" ]]; then
    yq -r "$filter // \"$fallback\"" "$file"
  else
    printf '%s' "$fallback"
  fi
}

is_supported_task_type() {
  case "$1" in
    implement|investigate) return 0 ;;
    *) return 1 ;;
  esac
}

# evaluate_bootstrap_marker MARKER_FILE SENTINEL_FILE STAGE_CONFIG_DIGEST FRESH_CLONE
#
# Gate for the bake-once sandbox bootstrap (post_bootstrap installs and
# image-derived engine probes run once per sandbox lifetime). Decides, from the
# root-owned marker state, whether this stage must run the bootstrap, may skip
# it, or must fail closed because the sandbox no longer matches its sealed
# repository config. There is never a silent re-bootstrap or a silent skip.
#
# stdout on success (exit 0):
#   "run"       — fresh sandbox: the bake-once bootstrap must execute now
#   "skip <0|1>" — marker matches the sealed digest; <0|1> is the recorded
#                  codexHookTrust probe result
# stdout on failure (exit 1): the exact fail-closed diagnostic to log; the
# sandbox is stale and the supervisor must reprovision it.
evaluate_bootstrap_marker() {
  local marker="$1" sentinel="$2" stage_digest="$3" fresh_clone="$4"
  local marker_digest hook_trust
  if [[ -f "$marker" ]]; then
    if ! marker_digest="$(jq -er '.repositoryConfigDigest' "$marker" 2>/dev/null)"; then
      printf '%s\n' "FATAL: sandbox bootstrap marker is unreadable; the sandbox is stale — the supervisor must reprovision it"
      return 1
    fi
    if [[ "$marker_digest" != "$stage_digest" ]]; then
      printf '%s\n' "FATAL: sandbox bootstrap marker records repository config digest ${marker_digest} but the sealed stage request requires ${stage_digest}; the sandbox is stale — the supervisor must reprovision it"
      return 1
    fi
    if [[ "$fresh_clone" == "1" ]]; then
      printf '%s\n' "FATAL: sandbox bootstrap marker is present but the repository checkout was recreated; the sandbox is stale — the supervisor must reprovision it"
      return 1
    fi
    hook_trust="$(jq -r 'if .codexHookTrust == true then "1" else "0" end' "$marker" 2>/dev/null || printf '0')"
    printf 'skip %s\n' "$hook_trust"
    return 0
  fi
  if [[ -e "$sentinel" ]]; then
    printf '%s\n' "FATAL: sandbox bootstrap started but never completed; the sandbox is stale — the supervisor must reprovision it"
    return 1
  fi
  printf 'run\n'
}

# initialize_stage_branch REPO_DIR BRANCH_NAME BASE_COMMIT
#
# Creates or resets the working branch for an initial stage (one whose sealed
# request carries no expected subject). A retriggered (repair) generation
# reuses the ticket branch, and earlier generations may already have pushed
# reviewed work to origin/<branch>; starting from the sealed base commit would
# hand the stage a branch missing that published head (OPE-77). Contract:
#   - origin/<branch> exists  -> check out exactly that remote head
#   - origin/<branch> absent  -> create the branch at BASE_COMMIT
#   - origin unreachable, or the advertised head cannot be fetched -> fail
#     closed with a FATAL diagnostic. The stage never silently proceeds on a
#     branch that lacks the published work; the dead run is settled by the
#     supervisor as a retryable infrastructure failure.
#
# stdout on success (exit 0): "remote <sha>" or "base <sha>" naming the exact
# commit the branch was reset to.
# stdout on failure (exit 1): the exact fail-closed diagnostic to log.
initialize_stage_branch() {
  local repo="$1" branch="$2" base_commit="$3"
  local listing remote_head start_commit source_kind
  if ! listing="$(git -C "$repo" ls-remote --heads origin "refs/heads/${branch}" 2>/dev/null)"; then
    printf '%s\n' "FATAL: could not query origin for branch ${branch}; refusing to initialize the stage branch while the published head is unknown — the supervisor must retry the stage"
    return 1
  fi
  listing="${listing%%$'\n'*}"
  if [[ -n "$listing" ]]; then
    remote_head="${listing%%[[:space:]]*}"
    if [[ ! "$remote_head" =~ ^[0-9a-f]{40}$ ]] ||
       ! git -C "$repo" fetch --quiet origin "refs/heads/${branch}" 2>/dev/null ||
       ! git -C "$repo" cat-file -e "${remote_head}^{commit}" 2>/dev/null; then
      printf '%s\n' "FATAL: branch ${branch} exists on origin but its published head ${remote_head:-<unknown>} could not be fetched; refusing to rebuild the branch from the sealed base commit — the supervisor must retry the stage"
      return 1
    fi
    start_commit="$remote_head"
    source_kind="remote"
  else
    if ! git -C "$repo" cat-file -e "${base_commit}^{commit}" 2>/dev/null; then
      printf '%s\n' "FATAL: sealed base commit ${base_commit} is not present in the checkout; the supervisor must retry the stage"
      return 1
    fi
    start_commit="$base_commit"
    source_kind="base"
  fi
  if ! git -C "$repo" checkout --quiet -B "$branch" "$start_commit" ||
     ! git -C "$repo" reset --hard --quiet "$start_commit" ||
     ! git -C "$repo" clean -fdq; then
    printf '%s\n' "FATAL: could not check out branch ${branch} at ${start_commit}; the supervisor must retry the stage"
    return 1
  fi
  printf '%s %s\n' "$source_kind" "$start_commit"
}

# heal_claude_config CONFIG_FILE BACKUP_DIR
#
# The Claude CLI's config-corruption recovery can move ~/.claude.json into
# BACKUP_DIR/.claude.json.backup.<ms> WITHOUT recreating it (OPE-87). The CLI
# then refuses every launch ("Claude configuration file not found ... A backup
# file exists at: ..."), while a wholly absent config with NO backups is
# silently regenerated on launch — that absent state is normal, because
# reset_agent_execution_state removes ~/.claude.json at every stage boundary.
# Heal the poisoned missing-config-with-backups state before the agent launch.
#
# stdout on success (exit 0):
#   "ok"                — config present and parseable; left alone
#   "absent"            — no config and no backups; the CLI regenerates it
#   "restored <backup>" — newest backup restored to CONFIG_FILE and validated
# stdout on failure (exit 1): the exact fail-closed FATAL diagnostic to log;
# no parseable config could be produced, and the supervisor settles the dead
# run as a retryable infrastructure failure.
heal_claude_config() {
  local config="$1" backup_dir="$2"
  local newest=""
  if [[ ! -f "$config" ]]; then
    newest="$(ls -1 "${backup_dir}/.claude.json.backup."* 2>/dev/null | LC_ALL=C sort | tail -n 1)"
    if [[ -z "$newest" ]]; then
      printf 'absent\n'
      return 0
    fi
    if ! cp "$newest" "$config" 2>/dev/null; then
      printf '%s\n' "FATAL: could not restore ${config} from bake backup ${newest}; the supervisor must retry the stage"
      return 1
    fi
  fi
  if ! jq empty "$config" >/dev/null 2>&1; then
    if [[ -n "$newest" ]]; then
      printf '%s\n' "FATAL: ${config} restored from bake backup ${newest} is not valid JSON; the supervisor must retry the stage"
    else
      printf '%s\n' "FATAL: ${config} is present but not valid JSON; the supervisor must retry the stage"
    fi
    return 1
  fi
  if [[ -n "$newest" ]]; then
    printf 'restored %s\n' "$newest"
  else
    printf 'ok\n'
  fi
}
