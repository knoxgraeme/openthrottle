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

task_adapter_value() {
  local task="$1"
  local field="$2"
  local registry="${OT_TASK_ADAPTERS_FILE:-/opt/openthrottle/skills/task-adapters-v1.json}"
  jq -er --arg task "$task" --arg field "$field" '
    .tasks[$task][$field]
    | if type == "array" then join(",") elif type == "string" then . else error("missing adapter field") end
  ' "$registry"
}

# Extract a string field from a Codex auth.json blob; empty on absent/invalid.
codex_auth_field() {
  # $1 = json blob, $2 = jq path (e.g. '.last_refresh')
  jq -r "$2 // empty" <<<"$1" 2>/dev/null || true
}

# Convert any valid ISO-8601 instant accepted by the JavaScript runtime to
# epoch milliseconds. Empty output means the value is absent or invalid. This
# avoids byte-order comparisons, which are wrong for equivalent timestamps
# expressed with different offsets or fractional-second precision.
codex_auth_timestamp_ms() {
  node -e '
    const value = Date.parse(process.argv[1] ?? "");
    if (Number.isFinite(value)) process.stdout.write(String(value));
  ' "$1" 2>/dev/null || true
}

# Decide how to reconcile a freshly-seeded Codex auth blob against the blob
# already present in the sandbox on resume. The supervisor now refreshes the
# rotating subscription token centrally before seeding (see codex-auth.ts), so
# the seed can be *newer* than the sandbox's local copy — but it can also be
# older if Codex rotated again mid-run. Install whichever is newest and trusted;
# never cross accounts. Echoes exactly one of:
#   seed         -> the seed is strictly newer; install it
#   keep         -> the existing sandbox token is newer-or-equal (or ages are
#                   unknown); keep it, since overwriting with an older/unknown
#                   blob would replay a spent refresh token
#   incompatible -> the two blobs name different accounts; caller must fail closed
# Args: $1 = seed blob, $2 = existing blob
codex_reconcile_auth() {
  local seed="$1" existing="$2"
  local seed_acct existing_acct seed_ts existing_ts seed_ms existing_ms
  seed_acct="$(codex_auth_field "$seed" '.tokens.account_id')"
  existing_acct="$(codex_auth_field "$existing" '.tokens.account_id')"
  if [[ -n "$seed_acct" && -n "$existing_acct" && "$seed_acct" != "$existing_acct" ]]; then
    printf '%s' 'incompatible'
    return 0
  fi
  seed_ts="$(codex_auth_field "$seed" '.last_refresh')"
  existing_ts="$(codex_auth_field "$existing" '.last_refresh')"
  seed_ms="$(codex_auth_timestamp_ms "$seed_ts")"
  existing_ms="$(codex_auth_timestamp_ms "$existing_ts")"
  # Only override the rotated sandbox token when the seed is provably and
  # strictly newer. An invalid existing timestamp remains conservative unless
  # the timestamp is wholly absent.
  if [[ -n "$seed_ms" && ( -z "$existing_ts" || ( -n "$existing_ms" && "$seed_ms" -gt "$existing_ms" ) ) ]]; then
    printf '%s' 'seed'
    return 0
  fi
  printf '%s' 'keep'
}
