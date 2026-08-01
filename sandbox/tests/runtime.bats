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

@test "pre-push blocks internal unit refs" {
  if ! install -d -m 0755 /run/openthrottle 2>/dev/null; then
    skip "cannot install default root-owned push policy in this test environment"
  fi
  printf '%s\n' prefer_resume > /run/openthrottle/stage-push-policy
  chmod 0444 /run/openthrottle/stage-push-policy

  repo="${BATS_TEST_TMPDIR}/repo"
  mkdir "$repo"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.name Test
  git -C "$repo" config user.email test@example.com
  printf '%s\n' initial > "$repo/file.txt"
  git -C "$repo" add .
  git -C "$repo" commit -qm initial

  run env -C "$repo" "${BATS_TEST_DIRNAME}/../safety/pre-push" <<EOF
refs/heads/main $(git -C "$repo" rev-parse HEAD) refs/heads/unit/attempt-1 0000000000000000000000000000000000000000
EOF
  [ "$status" -ne 0 ]
  [[ "$output" == *"internal OpenThrottle worktree ref"* ]]
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

# Shared fixture for the initialize_stage_branch tests: a bare origin with
# main at $BASE_SHA and ot/ope-58 published at $PUBLISHED_SHA, plus a fresh
# clone at $CLONE (the sandbox's phase-2 checkout).
make_stage_branch_fixture() {
  ORIGIN="${BATS_TEST_TMPDIR}/origin.git"
  SEED="${BATS_TEST_TMPDIR}/seed"
  CLONE="${BATS_TEST_TMPDIR}/repo"
  git init -q --bare "$ORIGIN"
  git init -q -b main "$SEED"
  git -C "$SEED" config user.name Test
  git -C "$SEED" config user.email test@example.com
  printf '%s\n' base > "$SEED/file.txt"
  git -C "$SEED" add .
  git -C "$SEED" commit -qm base
  BASE_SHA="$(git -C "$SEED" rev-parse HEAD)"
  git -C "$SEED" push -q "$ORIGIN" main
  git -C "$SEED" checkout -qb ot/ope-58
  printf '%s\n' published > "$SEED/file.txt"
  git -C "$SEED" commit -qam published
  PUBLISHED_SHA="$(git -C "$SEED" rev-parse HEAD)"
  git -C "$SEED" push -q "$ORIGIN" ot/ope-58
  git clone -q "$ORIGIN" "$CLONE"
}

@test "initialize_stage_branch checks out the exact published remote head for a reused ticket branch" {
  make_stage_branch_fixture

  # A repair generation's initial stage seals baseCommit at the base-branch
  # head, but origin/ot/ope-58 already carries the reviewed work. The stage
  # branch must start from exactly that published head, not the base commit.
  run initialize_stage_branch "$CLONE" ot/ope-58 "$BASE_SHA"
  [ "$status" -eq 0 ]
  [ "$output" = "remote ${PUBLISHED_SHA}" ]
  [ "$(git -C "$CLONE" rev-parse HEAD)" = "$PUBLISHED_SHA" ]
  [ "$(git -C "$CLONE" rev-parse --abbrev-ref HEAD)" = "ot/ope-58" ]

  # Even a stale local branch already parked at the base commit is reset to
  # the published head, never silently kept.
  git -C "$CLONE" checkout -qB ot/ope-58 "$BASE_SHA"
  run initialize_stage_branch "$CLONE" ot/ope-58 "$BASE_SHA"
  [ "$status" -eq 0 ]
  [ "$output" = "remote ${PUBLISHED_SHA}" ]
  [ "$(git -C "$CLONE" rev-parse HEAD)" = "$PUBLISHED_SHA" ]
}

@test "initialize_stage_branch creates an absent branch from the sealed base commit" {
  make_stage_branch_fixture

  run initialize_stage_branch "$CLONE" ot/ope-99 "$BASE_SHA"
  [ "$status" -eq 0 ]
  [ "$output" = "base ${BASE_SHA}" ]
  [ "$(git -C "$CLONE" rev-parse HEAD)" = "$BASE_SHA" ]
  [ "$(git -C "$CLONE" rev-parse --abbrev-ref HEAD)" = "ot/ope-99" ]
}

@test "initialize_stage_branch fails closed when the published head cannot be fetched" {
  make_stage_branch_fixture

  # Origin advertises a head whose object it cannot serve (stale/unreachable
  # published head). The stage must fail with the typed diagnostic, not fall
  # back to the base commit.
  fake_sha="$(printf 'a%.0s' {1..40})"
  printf '%s\n' "$fake_sha" > "$ORIGIN/refs/heads/ot/ope-58"
  run initialize_stage_branch "$CLONE" ot/ope-58 "$BASE_SHA"
  [ "$status" -eq 1 ]
  [ "$output" = "FATAL: branch ot/ope-58 exists on origin but its published head ${fake_sha} could not be fetched; refusing to rebuild the branch from the sealed base commit — the supervisor must retry the stage" ]
  # No silent fallback: the working branch was never created.
  run git -C "$CLONE" show-ref --verify --quiet refs/heads/ot/ope-58
  [ "$status" -ne 0 ]
}

@test "initialize_stage_branch fails closed when origin cannot be queried" {
  make_stage_branch_fixture

  git -C "$CLONE" remote set-url origin "${BATS_TEST_TMPDIR}/missing.git"
  run initialize_stage_branch "$CLONE" ot/ope-58 "$BASE_SHA"
  [ "$status" -eq 1 ]
  [ "$output" = "FATAL: could not query origin for branch ot/ope-58; refusing to initialize the stage branch while the published head is unknown — the supervisor must retry the stage" ]
  run git -C "$CLONE" show-ref --verify --quiet refs/heads/ot/ope-58
  [ "$status" -ne 0 ]
}

@test "heal_claude_config restores the newest bake backup when the config is missing" {
  config="${BATS_TEST_TMPDIR}/.claude.json"
  backups="${BATS_TEST_TMPDIR}/backups"
  mkdir -p "$backups"
  printf '{"generation":"older"}\n' > "$backups/.claude.json.backup.1753900000000"
  printf '{"generation":"newest"}\n' > "$backups/.claude.json.backup.1753900000001"

  run heal_claude_config "$config" "$backups"
  [ "$status" -eq 0 ]
  [ "$output" = "restored ${backups}/.claude.json.backup.1753900000001" ]
  [ "$(jq -r '.generation' "$config")" = "newest" ]
}

@test "heal_claude_config leaves an existing valid config alone" {
  config="${BATS_TEST_TMPDIR}/.claude.json"
  backups="${BATS_TEST_TMPDIR}/backups"
  mkdir -p "$backups"
  printf '{"generation":"live"}\n' > "$config"
  printf '{"generation":"stale"}\n' > "$backups/.claude.json.backup.1753900000000"

  run heal_claude_config "$config" "$backups"
  [ "$status" -eq 0 ]
  [ "$output" = "ok" ]
  [ "$(jq -r '.generation' "$config")" = "live" ]
}

@test "heal_claude_config reports an absent config with no backups for CLI regeneration" {
  # Not a failure: reset_agent_execution_state removes ~/.claude.json at every
  # stage boundary, and the Claude CLI regenerates a fresh config on launch
  # whenever no corruption-recovery backups exist. Only the
  # missing-config-WITH-backups state blocks the launch (OPE-87).
  config="${BATS_TEST_TMPDIR}/.claude.json"
  run heal_claude_config "$config" "${BATS_TEST_TMPDIR}/backups"
  [ "$status" -eq 0 ]
  [ "$output" = "absent" ]
  [ ! -e "$config" ]
}

@test "heal_claude_config fails closed when the restored backup is not valid JSON" {
  config="${BATS_TEST_TMPDIR}/.claude.json"
  backups="${BATS_TEST_TMPDIR}/backups"
  mkdir -p "$backups"
  printf '{"generation":"older-valid"}\n' > "$backups/.claude.json.backup.1753900000000"
  printf 'not json\n' > "$backups/.claude.json.backup.1753900000001"

  run heal_claude_config "$config" "$backups"
  [ "$status" -eq 1 ]
  [ "$output" = "FATAL: ${config} restored from bake backup ${backups}/.claude.json.backup.1753900000001 is not valid JSON; the supervisor must retry the stage" ]
}

@test "heal_claude_config fails closed on an existing corrupt config" {
  config="${BATS_TEST_TMPDIR}/.claude.json"
  printf 'not json\n' > "$config"

  run heal_claude_config "$config" "${BATS_TEST_TMPDIR}/backups"
  [ "$status" -eq 1 ]
  [ "$output" = "FATAL: ${config} is present but not valid JSON; the supervisor must retry the stage" ]
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
