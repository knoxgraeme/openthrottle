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

# resolve_git_identity OVERRIDE_NAME OVERRIDE_EMAIL GH_LOGIN GH_UID
#
# Chooses the git commit author identity, preferring an explicit override
# email, then the GitHub account's noreply identity (so GitHub attributes
# commits to a real account and author-gated integrations such as Vercel
# accept the deployment), then a placeholder. Emits "<name>\t<email>".
resolve_git_identity() {
  local name="$1" email="$2" login="$3" uid="$4"
  if [[ -z "$email" && -n "$login" && -n "$uid" ]]; then
    name="${name:-$login}"
    email="${uid}+${login}@users.noreply.github.com"
  fi
  if [[ -z "$email" ]]; then
    name="${name:-OpenThrottle Agent}"
    email="agent@openthrottle.dev"
  fi
  # Never emit an empty author name: git refuses to commit without one, so an
  # override email supplied without a name derives the name from its local part.
  name="${name:-${email%%@*}}"
  printf '%s\t%s\n' "$name" "$email"
}

sanitize_log() {
  local text="$1"
  local name value nested
  while IFS='=' read -r name value; do
    [[ "$name" =~ (TOKEN|KEY|SECRET|PASSWORD|AUTH_JSON) ]] || continue
    [[ -z "$value" ]] && continue
    text="${text//$value/[REDACTED]}"

    # CODEX_AUTH_JSON and similar secret blobs can be logged one field at a
    # time. Redact sufficiently long scalar strings inside valid JSON too.
    while IFS= read -r nested; do
      [[ "${#nested}" -lt 8 ]] && continue
      text="${text//$nested/[REDACTED]}"
    done < <(jq -r '.. | strings' <<<"$value" 2>/dev/null || true)
  done < <(env)

  printf '%s' "$text" | sed -E \
    -e 's/gh[opsu]_[A-Za-z0-9_]+/[REDACTED]/g' \
    -e 's/github_pat_[A-Za-z0-9_]+/[REDACTED]/g' \
    -e 's/sk-[A-Za-z0-9_-]+/[REDACTED]/g' \
    -e 's/lin_(api|oauth)_[A-Za-z0-9_]+/[REDACTED]/g' \
    -e 's/Bearer [^[:space:]]+/Bearer [REDACTED]/g'
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
    implement|resume|investigate) return 0 ;;
    *) return 1 ;;
  esac
}

task_skill_name() {
  case "$1" in
    implement) printf '%s' 'implement-plan' ;;
    investigate) printf '%s' 'investigate' ;;
    *) return 1 ;;
  esac
}

# The OpenThrottle adapters are intentionally thin. This declaration makes
# their native Compound Engineering composition explicit to the entrypoint,
# tests, logs, and the agent itself while Fly remains the outer scheduler.
task_ce_pipeline() {
  case "$1" in
    implement) printf '%s' 'ce-work,ce-code-review,ce-commit-push-pr' ;;
    investigate) printf '%s' 'ce-debug,ce-commit-push-pr' ;;
    resume) printf '%s' 'resume' ;;
    *) return 1 ;;
  esac
}
