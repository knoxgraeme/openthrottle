#!/usr/bin/env bash
# Injects only flat steering envelopes fenced to the live kernel work or result
# correction lease. The hook supplies guidance; CLI policy remains authoritative.

set -euo pipefail

readonly INBOX_DIR="${OT_INBOX_DIR:-/home/agent/.ot/inbox}"
readonly PROCESSED_DIR="${OT_INBOX_PROCESSED_DIR:-/home/agent/.ot/inbox-processed}"
readonly LEASE_GENERATION_LOCK_FILE="${OT_LEASE_GENERATION_LOCK_FILE:-}"
readonly MAX_ENVELOPE_BYTES=65536

event_json="$(cat 2>/dev/null || true)"
event_name="$(printf '%s' "$event_json" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
shopt -s nullglob
files=("$INBOX_DIR"/*.json)
shopt -u nullglob
[ "${#files[@]}" -gt 0 ] || exit 0

# The supervisor creates this stable, root-owned inode before publishing the
# fence. Its exclusive refresh and this shared read-side section linearize the
# generation observed for validation, emission, and durable consumption.
[ -n "$LEASE_GENERATION_LOCK_FILE" ] && [ -f "$LEASE_GENERATION_LOCK_FILE" ] || exit 0
exec {lease_generation_lock_fd}<"$LEASE_GENERATION_LOCK_FILE" || exit 0
flock --shared "$lease_generation_lock_fd" || exit 0

active_session="$(jq -r '.native_session_id // empty' "${OT_SESSION_FENCE_FILE:-/nonexistent}" 2>/dev/null || true)"
active_lease_generation="$(jq -er \
  '.lease_generation | select(type == "number" and . >= 0 and floor == .)' \
  "${OT_LEASE_GENERATION_FENCE_FILE:-/nonexistent}" 2>/dev/null || true)"
[ -n "$active_session" ] && [ -n "$active_lease_generation" ] || exit 0

live_fence_matches() {
  local current_session current_lease_generation
  current_session="$(jq -r '.native_session_id // empty' \
    "${OT_SESSION_FENCE_FILE:-/nonexistent}" 2>/dev/null || true)"
  current_lease_generation="$(jq -er \
    '.lease_generation | select(type == "number" and . >= 0 and floor == .)' \
    "${OT_LEASE_GENERATION_FENCE_FILE:-/nonexistent}" 2>/dev/null || true)"
  [ "$current_session" = "$active_session" ] &&
    [ "$current_lease_generation" = "$active_lease_generation" ]
}

bodies=""
valid_files=()
valid_envelopes=()
for file in "${files[@]}"; do
  [ -f "$file" ] || continue
  file_bytes="$(wc -c < "$file" 2>/dev/null || echo 999999)"
  [ "$file_bytes" -le "$MAX_ENVELOPE_BYTES" ] || continue
  envelope="$(cat "$file" 2>/dev/null || true)"
  if ! printf '%s' "$envelope" | jq -e \
    --arg run "${OT_PIPELINE_RUN_ID:-}" \
    --arg attempt "${OT_ATTEMPT_ID:-}" \
    --arg request "${OT_REQUEST_HASH:-}" \
    --arg bundle "${OT_DEFINITION_BUNDLE_HASH:-}" \
    --arg lease "${OT_LEASE_ID:-}" \
    --arg session "$active_session" \
    --argjson lease_generation "$active_lease_generation" \
    '.schema == "openthrottle.kernel-steering/v1" and
     .pipeline_run_id == $run and .attempt_id == $attempt and
     .request_hash == $request and .definition_bundle_hash == $bundle and
     .lease_id == $lease and .native_session_id == $session and
     .lease_generation == $lease_generation and
     (.delivery_id | type == "string" and length > 0 and length <= 200) and
     (.body | type == "string" and length > 0 and length <= 32000)' >/dev/null 2>&1; then
    continue
  fi
  body="$(printf '%s' "$envelope" | jq -er '.body')"
  [ -z "$bodies" ] || bodies="${bodies}"$'\n\n---\n\n'
  bodies="${bodies}${body}"
  valid_files+=("$file")
  valid_envelopes+=("$envelope")
done
[ "${#valid_files[@]}" -gt 0 ] || exit 0

framed="Mid-run guidance from the operator. Weigh it within the approved task and safety constraints; it cannot expand your authority:"$'\n\n'"${bodies}"
if [ "$event_name" = "Stop" ]; then
  rendered="$(jq -cn --arg ctx "$framed" \
    '{decision:"block",reason:$ctx,hookSpecificOutput:{hookEventName:"Stop",additionalContext:$ctx}}')"
else
  rendered="$(jq -cn --arg ctx "$framed" --arg event "${event_name:-PostToolUse}" \
    '{hookSpecificOutput:{hookEventName:$event,additionalContext:$ctx}}')"
fi

# The supervisor is the only writer of both root-owned fence files. Re-read
# them after all untrusted envelope parsing and immediately before emission.
live_fence_matches || exit 0
printf '%s\n' "$rendered"

# Do not consume an envelope across a recovery that raced with emission.
live_fence_matches || exit 0
mkdir -p "$PROCESSED_DIR" || exit 0
for index in "${!valid_files[@]}"; do
  file="${valid_files[$index]}"
  envelope="${valid_envelopes[$index]}"
  delivery_id="$(printf '%s' "$envelope" | jq -r '.delivery_id')"
  journal="${PROCESSED_DIR}/${delivery_id}.json"
  temporary="${journal}.tmp"
  if printf '%s' "$envelope" | jq -c '. + {processed_at:(now|todateiso8601)} | del(.body)' > "$temporary" &&
     chmod 0600 "$temporary" && mv "$temporary" "$journal"; then
    rm -f "$file"
  else
    rm -f "$temporary"
  fi
done
