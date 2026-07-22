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

@test "task types map to the correct skill" {
  run task_skill_name implement
  [ "$output" = "implement-plan" ]
  run task_skill_name investigate
  [ "$output" = "investigate" ]
  run task_skill_name resume
  [ "$status" -ne 0 ]
  run is_supported_task_type unknown
  [ "$status" -ne 0 ]
}

@test "task types collapse to implement, resume, investigate" {
  run is_supported_task_type implement
  [ "$status" -eq 0 ]
  run is_supported_task_type resume
  [ "$status" -eq 0 ]
  run is_supported_task_type investigate
  [ "$status" -eq 0 ]
  run is_supported_task_type review
  [ "$status" -ne 0 ]
  run is_supported_task_type review-fix
  [ "$status" -ne 0 ]
}

@test "task types declare their native Compound Engineering pipeline" {
  run task_ce_pipeline implement
  [ "$status" -eq 0 ]
  [ "$output" = "ce-work,ce-code-review,ce-commit-push-pr" ]

  run task_ce_pipeline investigate
  [ "$output" = "ce-debug,ce-commit-push-pr" ]

  run task_ce_pipeline resume
  [ "$output" = "resume" ]

  run task_ce_pipeline review
  [ "$status" -ne 0 ]

  run task_ce_pipeline review-fix
  [ "$status" -ne 0 ]
}

@test "no pipeline mentions ce-babysit-pr" {
  for task in implement investigate resume; do
    run task_ce_pipeline "$task"
    [[ "$output" != *ce-babysit-pr* ]]
  done
}

@test "resolve_git_identity prefers override, then GitHub noreply, then placeholder" {
  # Explicit override email wins and keeps an explicit name.
  run resolve_git_identity "Ada" "ada@example.com" "octocat" "583231"
  [ "$output" = $'Ada\tada@example.com' ]

  # No override: derive the account's GitHub noreply identity.
  run resolve_git_identity "" "" "knoxgraeme" "42"
  [ "$output" = $'knoxgraeme\t42+knoxgraeme@users.noreply.github.com' ]

  # Override email with no name derives the name from the address local part
  # (git refuses to commit with an empty author name).
  run resolve_git_identity "" "custom@example.com" "" ""
  [ "$output" = $'custom\tcustom@example.com' ]

  # Account lookup failed and no override: placeholder of last resort.
  run resolve_git_identity "" "" "" ""
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
