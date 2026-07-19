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
  run sanitize_log "direct-secret-value nested-secret-value ghp_abcdefghijklmnop visible"
  [ "$status" -eq 0 ]
  [ "$output" = "[REDACTED] [REDACTED] [REDACTED] visible" ]
}

@test "task types map to the correct skill" {
  run task_skill_name implement
  [ "$output" = "implement-plan" ]
  run task_skill_name review-fix
  [ "$output" = "review-fix" ]
  run is_supported_task_type unknown
  [ "$status" -ne 0 ]
}

@test "task types declare their native Compound Engineering pipeline" {
  run task_ce_pipeline implement
  [ "$status" -eq 0 ]
  [ "$output" = "ce-work,ce-code-review,ce-commit-push-pr,ce-babysit-pr" ]

  run task_ce_pipeline review
  [ "$output" = "ce-code-review" ]

  run task_ce_pipeline review-fix
  [ "$output" = "ce-resolve-pr-feedback,ce-babysit-pr" ]

  run task_ce_pipeline investigate
  [ "$output" = "ce-debug,ce-commit-push-pr,ce-babysit-pr" ]

  run task_ce_pipeline resume
  [ "$output" = "resume" ]
}

@test "yq default does not require a config file" {
  run yq_value_or_default "/not/present" ".test" "npm test"
  [ "$status" -eq 0 ]
  [ "$output" = "npm test" ]
}
