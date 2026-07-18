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
    implement|resume|review|review-fix|investigate) return 0 ;;
    *) return 1 ;;
  esac
}

task_skill_name() {
  case "$1" in
    implement) printf '%s' 'implement-plan' ;;
    review|review-fix|investigate) printf '%s' "$1" ;;
    *) return 1 ;;
  esac
}
