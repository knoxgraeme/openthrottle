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
# already present from an earlier stage. The supervisor refreshes the
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
