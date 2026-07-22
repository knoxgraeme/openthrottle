#!/usr/bin/env bats
#
# Tests for sandbox/hooks/ot-inbox-drain.sh (the mid-run steering drain hook).
# Run with: bats sandbox/tests/inbox-drain.bats

setup() {
  DRAIN="${BATS_TEST_DIRNAME}/../hooks/ot-inbox-drain.sh"
  OT_INBOX_DIR="${BATS_TEST_TMPDIR}/inbox"
  export OT_INBOX_DIR
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
  printf 'focus on the failing test' > "$OT_INBOX_DIR/aaaa.md"
  run bash -c "printf '%s' '{\"hook_event_name\":\"PostToolUse\"}' | '$DRAIN'"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"hookSpecificOutput"'* ]]
  [[ "$output" == *'"hookEventName":"PostToolUse"'* ]]
  [[ "$output" == *'additionalContext'* ]]
  [[ "$output" == *'Mid-run steering'* ]]
  [[ "$output" == *'does not override'* ]]
  # Both response paths are offered: acknowledge-and-continue vs stop-and-ask,
  # with the elicit path gated to genuinely blocking questions (a bare question
  # is not by itself a reason to stop).
  [[ "$output" == *'ot-activity thought'* ]]
  [[ "$output" == *'ot-activity elicitation'* ]]
  [[ "$output" == *'not by itself a reason to stop'* ]]
  [[ "$output" == *'focus on the failing test'* ]]
  # Consumed exactly once — file deleted, no pending files remain.
  [ ! -f "$OT_INBOX_DIR/aaaa.md" ]
  run bash -c "ls '$OT_INBOX_DIR'/*.md 2>/dev/null | wc -l"
  [ "$output" -eq 0 ]
}

@test "Stop event blocks so the run does not end with unread steering" {
  mkdir -p "$OT_INBOX_DIR"
  printf 'do not forget the migration' > "$OT_INBOX_DIR/bbbb.md"
  run bash -c "printf '%s' '{\"hook_event_name\":\"Stop\"}' | '$DRAIN'"
  [ "$status" -eq 0 ]
  [[ "$output" == *'"decision":"block"'* ]]
  [[ "$output" == *'"reason"'* ]]
  [[ "$output" == *'"hookEventName":"Stop"'* ]]
  [[ "$output" == *'do not forget the migration'* ]]
  [ ! -f "$OT_INBOX_DIR/bbbb.md" ]
}

@test "multiple messages are concatenated and all consumed" {
  mkdir -p "$OT_INBOX_DIR"
  printf 'first msg' > "$OT_INBOX_DIR/0001.md"
  printf 'second msg' > "$OT_INBOX_DIR/0002.md"
  run bash -c "printf '%s' '{\"hook_event_name\":\"PostToolUse\"}' | '$DRAIN'"
  [ "$status" -eq 0 ]
  [[ "$output" == *'first msg'* ]]
  [[ "$output" == *'second msg'* ]]
  run bash -c "ls '$OT_INBOX_DIR'/*.md 2>/dev/null | wc -l"
  [ "$output" -eq 0 ]
}
