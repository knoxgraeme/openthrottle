#!/usr/bin/env bats

setup() {
  source "${BATS_TEST_DIRNAME}/../lib/runtime.sh"
}

@test "strip_nl removes repeated CRLF suffixes only" {
  run strip_nl $'value\r\n\r\n'
  [ "$status" -eq 0 ]
  [ "$output" = "value" ]
}

@test "sanitize_log redacts direct and nested credentials" {
  export GITHUB_TOKEN="direct-secret-value"
  export CODEX_AUTH_JSON='{"tokens":{"access_token":"nested-secret-value"}}'
  export KIMI_CODE_API_KEY="kimi-secret-value"
  run sanitize_log "direct-secret-value nested-secret-value kimi-secret-value ghp_abcdefghijklmnop visible"
  [ "$status" -eq 0 ]
  [ "$output" = "[REDACTED] [REDACTED] [REDACTED] [REDACTED] visible" ]
}

@test "stage task types are implement or investigate" {
  run is_supported_task_type implement
  [ "$status" -eq 0 ]
  run is_supported_task_type resume
  [ "$status" -ne 0 ]
  run is_supported_task_type investigate
  [ "$status" -eq 0 ]
  run is_supported_task_type review
  [ "$status" -ne 0 ]
  run is_supported_task_type review-fix
  [ "$status" -ne 0 ]
}

@test "sealed stage push policy allows known policies and fails closed" {
  policy="${BATS_TEST_TMPDIR}/stage-push-policy"
  printf '%s\n' prefer_resume > "$policy"
  run "${BATS_TEST_DIRNAME}/../safety/enforce-stage-push-policy" "$policy"
  [ "$status" -eq 0 ]

  printf '%s\n' attacker_selected > "$policy"
  run "${BATS_TEST_DIRNAME}/../safety/enforce-stage-push-policy" "$policy"
  [ "$status" -ne 0 ]
  [[ "$output" == *"absent or invalid"* ]]
}

@test "resolve_git_identity uses GitHub noreply, then a placeholder" {
  run resolve_git_identity "knoxgraeme" "42"
  [ "$output" = $'knoxgraeme\t42+knoxgraeme@users.noreply.github.com' ]

  run resolve_git_identity "" ""
  [ "$output" = $'OpenThrottle Agent\tagent@openthrottle.dev' ]

  run resolve_git_identity '{"message":"Bad credentials"}' '{"status":401}'
  [ "$output" = $'OpenThrottle Agent\tagent@openthrottle.dev' ]
}

@test "yq default does not require a config file" {
  run yq_value_or_default "/not/present" ".test" "npm test"
  [ "$status" -eq 0 ]
  [ "$output" = "npm test" ]
}

@test "codex_reconcile_auth installs the newest trusted seed and fails closed across accounts" {
  older='{"tokens":{"account_id":"acct","refresh_token":"rt0"},"last_refresh":"2026-07-01T00:00:00.000Z"}'
  newer='{"tokens":{"account_id":"acct","refresh_token":"rt1"},"last_refresh":"2026-07-02T00:00:00.000Z"}'
  no_ts='{"tokens":{"account_id":"acct","refresh_token":"rtX"}}'
  other='{"tokens":{"account_id":"OTHER","refresh_token":"rtZ"},"last_refresh":"2026-07-09T00:00:00.000Z"}'

  # A strictly newer central seed replaces the sandbox's rotated token (#1).
  run codex_reconcile_auth "$newer" "$older"
  [ "$output" = "seed" ]

  # An older or equal seed is never replayed over the rotated token.
  run codex_reconcile_auth "$older" "$newer"
  [ "$output" = "keep" ]
  run codex_reconcile_auth "$newer" "$newer"
  [ "$output" = "keep" ]

  # Unknown ages stay conservative: keep the sandbox's rotated token.
  run codex_reconcile_auth "$no_ts" "$newer"
  [ "$output" = "keep" ]
  run codex_reconcile_auth "$no_ts" "$no_ts"
  [ "$output" = "keep" ]

  # A seed from a different account is rejected, not silently trusted.
  run codex_reconcile_auth "$newer" "$other"
  [ "$output" = "incompatible" ]
}

@test "bake-once bootstrap gate: fresh sandbox runs, completed marker skips" {
  marker="${BATS_TEST_TMPDIR}/bootstrap.json"
  sentinel="${BATS_TEST_TMPDIR}/bootstrap.started"
  digest_a="$(printf 'a%.0s' {1..64})"

  # Fresh sandbox (no marker, no sentinel): the bake-once bootstrap must run,
  # whether or not this stage performed the initial clone.
  run evaluate_bootstrap_marker "$marker" "$sentinel" "$digest_a" 1
  [ "$status" -eq 0 ]
  [ "$output" = "run" ]
  run evaluate_bootstrap_marker "$marker" "$sentinel" "$digest_a" 0
  [ "$status" -eq 0 ]
  [ "$output" = "run" ]

  # Second stage: a completed marker for the same sealed digest skips the
  # bootstrap and replays the recorded codex hook-trust probe.
  printf '{"schema":"openthrottle.sandbox-bootstrap/v1","repositoryConfigDigest":"%s","codexHookTrust":true,"completedAt":"2026-07-26T00:00:00Z"}\n' \
    "$digest_a" > "$marker"
  run evaluate_bootstrap_marker "$marker" "$sentinel" "$digest_a" 0
  [ "$status" -eq 0 ]
  [ "$output" = "skip 1" ]

  printf '{"schema":"openthrottle.sandbox-bootstrap/v1","repositoryConfigDigest":"%s","codexHookTrust":false,"completedAt":"2026-07-26T00:00:00Z"}\n' \
    "$digest_a" > "$marker"
  run evaluate_bootstrap_marker "$marker" "$sentinel" "$digest_a" 0
  [ "$status" -eq 0 ]
  [ "$output" = "skip 0" ]
}

@test "bake-once bootstrap gate fails closed on digest mismatch with the exact error" {
  marker="${BATS_TEST_TMPDIR}/bootstrap.json"
  sentinel="${BATS_TEST_TMPDIR}/bootstrap.started"
  digest_a="$(printf 'a%.0s' {1..64})"
  digest_b="$(printf 'b%.0s' {1..64})"
  printf '{"schema":"openthrottle.sandbox-bootstrap/v1","repositoryConfigDigest":"%s","codexHookTrust":true,"completedAt":"2026-07-26T00:00:00Z"}\n' \
    "$digest_a" > "$marker"

  run evaluate_bootstrap_marker "$marker" "$sentinel" "$digest_b" 0
  [ "$status" -eq 1 ]
  [ "$output" = "FATAL: sandbox bootstrap marker records repository config digest ${digest_a} but the sealed stage request requires ${digest_b}; the sandbox is stale — the supervisor must reprovision it" ]
}

@test "bake-once bootstrap gate fails closed on torn or inconsistent state" {
  marker="${BATS_TEST_TMPDIR}/bootstrap.json"
  sentinel="${BATS_TEST_TMPDIR}/bootstrap.started"
  digest_a="$(printf 'a%.0s' {1..64})"

  # Sentinel without a completion marker: a previous bootstrap died mid-run.
  printf '%s\n' "$digest_a" > "$sentinel"
  run evaluate_bootstrap_marker "$marker" "$sentinel" "$digest_a" 0
  [ "$status" -eq 1 ]
  [ "$output" = "FATAL: sandbox bootstrap started but never completed; the sandbox is stale — the supervisor must reprovision it" ]
  rm -f "$sentinel"

  # Matching marker but the checkout was recreated this stage: the baked
  # dependency state is gone, so skipping would be a silent lie.
  printf '{"schema":"openthrottle.sandbox-bootstrap/v1","repositoryConfigDigest":"%s","codexHookTrust":true,"completedAt":"2026-07-26T00:00:00Z"}\n' \
    "$digest_a" > "$marker"
  run evaluate_bootstrap_marker "$marker" "$sentinel" "$digest_a" 1
  [ "$status" -eq 1 ]
  [ "$output" = "FATAL: sandbox bootstrap marker is present but the repository checkout was recreated; the sandbox is stale — the supervisor must reprovision it" ]

  # Corrupt marker JSON is never trusted.
  printf 'not json\n' > "$marker"
  run evaluate_bootstrap_marker "$marker" "$sentinel" "$digest_a" 0
  [ "$status" -eq 1 ]
  [ "$output" = "FATAL: sandbox bootstrap marker is unreadable; the sandbox is stale — the supervisor must reprovision it" ]
}

@test "codex_reconcile_auth orders ISO-8601 offsets and fractional seconds by instant" {
  before='{"tokens":{"account_id":"acct"},"last_refresh":"2026-07-01T23:59:59.900Z"}'
  after_offset='{"tokens":{"account_id":"acct"},"last_refresh":"2026-07-02T02:00:00.100+02:00"}'
  same_instant='{"tokens":{"account_id":"acct"},"last_refresh":"2026-07-02T00:00:00.100Z"}'
  invalid='{"tokens":{"account_id":"acct"},"last_refresh":"not-a-timestamp"}'

  run codex_reconcile_auth "$after_offset" "$before"
  [ "$output" = "seed" ]
  run codex_reconcile_auth "$same_instant" "$after_offset"
  [ "$output" = "keep" ]
  run codex_reconcile_auth "$after_offset" "$invalid"
  [ "$output" = "keep" ]
}
