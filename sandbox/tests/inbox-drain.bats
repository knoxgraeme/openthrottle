#!/usr/bin/env bats
#
# Tests for sandbox/hooks/ot-inbox-drain.sh (the mid-run steering drain hook).
# Run with: bats sandbox/tests/inbox-drain.bats

setup() {
  unset RUN_ID
  DRAIN="${BATS_TEST_DIRNAME}/../hooks/ot-inbox-drain.sh"
  OT_INBOX_DIR="${BATS_TEST_TMPDIR}/inbox"
  OT_INBOX_PROCESSED_DIR="${BATS_TEST_TMPDIR}/processed"
  export OT_INBOX_DIR
  export OT_INBOX_PROCESSED_DIR
}

write_message() {
  local path="$1" body="$2" delivery="${3:-00000000-0000-4000-8000-000000000001}"
  jq -n --arg body "$body" --arg delivery "$delivery" '{
    version:1,
    delivery_id:$delivery,
    request_hash:("a" * 64),
    issue_id:"issue-1",
    session_id:"session-1",
    run_id:"run-1",
    native_session_id:"native-1",
    generation:1,
    context_revision:0,
    body:$body
  }' > "$path"
}

@test "absent inbox dir: exit 0 with no stdout" {
  # OT_INBOX_DIR intentionally not created.
  run bash -c "printf '%s' '{\"hook_event_name\":\"PostToolUse\"}' | '$DRAIN'"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "empty inbox dir: exit 0 with no stdout" {
  mkdir -p "$OT_INBOX_DIR"
  run bash -c "printf '%s' '{\"hook_event_name\":\"PostToolUse\"}' | '$DRAIN'"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "PostToolUse with one message injects framed additionalContext and consumes the file" {
  mkdir -p "$OT_INBOX_DIR"
  write_message "$OT_INBOX_DIR/aaaa.json" 'focus on the failing test'
  run bash -c "printf '%s' '{\"hook_event_name\":\"PostToolUse\"}' | '$DRAIN'"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"hookSpecificOutput"'* ]]
  [[ "$output" == *'"hookEventName":"PostToolUse"'* ]]
  [[ "$output" == *'additionalContext'* ]]
  [[ "$output" == *'Mid-run steering'* ]]
  [[ "$output" == *'does not override'* ]]
  [[ "$output" == *'via ot-activity'* ]]
  [[ "$output" == *'focus on the failing test'* ]]
  # Consumed exactly once — file deleted, no pending files remain.
  [ ! -f "$OT_INBOX_DIR/aaaa.json" ]
  [ -f "$OT_INBOX_PROCESSED_DIR/00000000-0000-4000-8000-000000000001.json" ]
  run bash -c "ls '$OT_INBOX_DIR'/*.json 2>/dev/null | wc -l"
  [ "$output" -eq 0 ]
}

@test "Stop event blocks so the run does not end with unread steering" {
  mkdir -p "$OT_INBOX_DIR"
  write_message "$OT_INBOX_DIR/bbbb.json" 'do not forget the migration'
  run bash -c "printf '%s' '{\"hook_event_name\":\"Stop\"}' | '$DRAIN'"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"decision":"block"'* ]]
  [[ "$output" == *'"reason"'* ]]
  [[ "$output" == *'"hookEventName":"Stop"'* ]]
  [[ "$output" == *'do not forget the migration'* ]]
  [ ! -f "$OT_INBOX_DIR/bbbb.json" ]
}

@test "multiple messages are concatenated and all consumed" {
  mkdir -p "$OT_INBOX_DIR"
  write_message "$OT_INBOX_DIR/0001.json" 'first msg' '00000000-0000-4000-8000-000000000001'
  write_message "$OT_INBOX_DIR/0002.json" 'second msg' '00000000-0000-4000-8000-000000000002'
  run bash -c "printf '%s' '{\"hook_event_name\":\"PostToolUse\"}' | '$DRAIN'"
  [ "$status" -eq 0 ]
  [[ "$output" == *'first msg'* ]]
  [[ "$output" == *'second msg'* ]]
  run bash -c "ls '$OT_INBOX_DIR'/*.json 2>/dev/null | wc -l"
  [ "$output" -eq 0 ]
}

@test "journal failure leaves the envelope for at-least-once redelivery" {
  mkdir -p "$OT_INBOX_DIR"
  write_message "$OT_INBOX_DIR/retry.json" 'retry after journal failure'
  # A regular file at the processed-dir path makes mkdir fail after the hook
  # has constructed/emitted its injection response.
  printf '%s' blocked > "$OT_INBOX_PROCESSED_DIR"

  run bash -c "printf '%s' '{\"hook_event_name\":\"PostToolUse\"}' | '$DRAIN'"

  [ "$status" -eq 0 ]
  [[ "$output" == *'retry after journal failure'* ]]
  [ -f "$OT_INBOX_DIR/retry.json" ]
}

@test "one failed journal does not invalidate earlier receipts in the same injection" {
  mkdir -p "$OT_INBOX_DIR" "$OT_INBOX_PROCESSED_DIR"
  write_message "$OT_INBOX_DIR/0001.json" 'first msg' '00000000-0000-4000-8000-000000000001'
  write_message "$OT_INBOX_DIR/0002.json" 'second msg' '00000000-0000-4000-8000-000000000002'
  # Redirection to this directory fails for only the second journal.
  mkdir "$OT_INBOX_PROCESSED_DIR/00000000-0000-4000-8000-000000000002.json.tmp"

  run bash -c "printf '%s' '{\"hook_event_name\":\"PostToolUse\"}' | '$DRAIN'"

  [ "$status" -eq 0 ]
  [[ "$output" == *'first msg'* ]]
  [[ "$output" == *'second msg'* ]]
  [ -f "$OT_INBOX_PROCESSED_DIR/00000000-0000-4000-8000-000000000001.json" ]
  [ ! -f "$OT_INBOX_DIR/0001.json" ]
  [ -f "$OT_INBOX_DIR/0002.json" ]
}

@test "a prior run's envelope is discarded without injection or acknowledgement" {
  mkdir -p "$OT_INBOX_DIR"
  write_message "$OT_INBOX_DIR/stale.json" 'stale steering'
  export RUN_ID="run-2"

  run bash -c "printf '%s' '{\"hook_event_name\":\"PostToolUse\"}' | '$DRAIN'"

  [ "$status" -eq 0 ]
  [ -z "$output" ]
  [ ! -f "$OT_INBOX_DIR/stale.json" ]
  [ ! -e "$OT_INBOX_PROCESSED_DIR/00000000-0000-4000-8000-000000000001.json" ]
}
