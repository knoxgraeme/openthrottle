#!/usr/bin/env bats

setup() {
  source "${BATS_TEST_DIRNAME}/../lib/runtime.sh"
}

@test "strip_nl removes repeated CRLF suffixes only" {
  run strip_nl $'value\r\n\r\n'
  [ "$status" -eq 0 ]
  [ "$output" = "value" ]
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

@test "reset_agent_execution_state clears Claude config backups so heal cannot resurrect a prior stage's config" {
  AGENT_HOME="${BATS_TEST_TMPDIR}/agent-home"
  AGENT_USER="$(id -un)"
  if ! install -d -o "$AGENT_USER" -g "$AGENT_USER" "${BATS_TEST_TMPDIR}/install-probe" 2>/dev/null; then
    skip "cannot install with owner/group ${AGENT_USER} in this test environment"
  fi
  log() { printf '%s\n' "$*"; }
  # The function is defined in entrypoint.sh, which cannot be sourced whole
  # (it executes the stage lifecycle at load); extract exactly its definition.
  eval "$(sed -n '/^reset_agent_execution_state()/,/^}/p' "${BATS_TEST_DIRNAME}/../entrypoint.sh")"

  mkdir -p "$AGENT_HOME/.claude/backups"
  printf '{"generation":"previous-stage"}\n' > "$AGENT_HOME/.claude/backups/.claude.json.backup.1753900000000"
  printf '{"generation":"previous-stage"}\n' > "$AGENT_HOME/.claude.json"

  run reset_agent_execution_state
  [ "$status" -eq 0 ]
  [ ! -e "$AGENT_HOME/.claude.json" ]
  [ ! -e "$AGENT_HOME/.claude/backups" ]

  # With the backups gone, the stage-boundary heal reports the normal absent
  # state for CLI regeneration instead of restoring the prior stage's config
  # across the security boundary.
  run heal_claude_config "$AGENT_HOME/.claude.json" "$AGENT_HOME/.claude/backups"
  [ "$status" -eq 0 ]
  [ "$output" = "absent" ]
}

@test "stage-boundary process cleanup rechecks until every live action process is gone" {
  fake_bin="${BATS_TEST_TMPDIR}/process-fence-bin"
  state_file="${BATS_TEST_TMPDIR}/process-state"
  signal_log="${BATS_TEST_TMPDIR}/signals"
  mkdir -p "$fake_bin"
  printf '%s\n' '#!/usr/bin/env bash' \
    'if [[ "$#" -eq 1 && "$1" == "-u" ]]; then printf "0\n"; exit 0; fi' \
    'if [[ "$#" -eq 2 && "$1" == "-u" && "$2" == "agent" ]]; then printf "1001\n"; exit 0; fi' \
    'exit 2' > "${fake_bin}/id"
  printf '%s\n' '#!/usr/bin/env bash' \
    'if [[ "$(< "$FAKE_PROCESS_STATE")" == "live" ]]; then printf " 101 S\n 102 Z\n"; fi' \
    > "${fake_bin}/ps"
  printf '%s\n' '#!/usr/bin/env bash' \
    '[[ "$1" == "-KILL" && "$2" == "-u" && "$3" == "1001" ]] || exit 2' \
    'printf "signal\n" >> "$FAKE_SIGNAL_LOG"' \
    'if [[ "$(< "$FAKE_PROCESS_STATE")" != "sticky" ]]; then printf "empty\n" > "$FAKE_PROCESS_STATE"; fi' \
    > "${fake_bin}/pkill"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "${fake_bin}/sleep"
  chmod 0755 "${fake_bin}/id" "${fake_bin}/ps" "${fake_bin}/pkill" "${fake_bin}/sleep"

  ACTION_USERS=(agent)
  PROCESS_FENCE_MAX_ATTEMPTS=3
  PROCESS_FENCE_SLEEP_SECONDS=0
  log() { printf '%s\n' "$*"; }
  eval "$(sed -n '/^live_action_user_pids()/,/^}/p' "${BATS_TEST_DIRNAME}/../entrypoint.sh")"
  eval "$(sed -n '/^terminate_agent_processes()/,/^}/p' "${BATS_TEST_DIRNAME}/../entrypoint.sh")"
  printf 'live\n' > "$state_file"
  export FAKE_PROCESS_STATE="$state_file" FAKE_SIGNAL_LOG="$signal_log"

  run env PATH="${fake_bin}:$PATH" bash -c \
    "$(declare -p ACTION_USERS PROCESS_FENCE_MAX_ATTEMPTS PROCESS_FENCE_SLEEP_SECONDS); $(declare -f log live_action_user_pids terminate_agent_processes); terminate_agent_processes"
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$signal_log" | tr -d ' ')" -eq 1 ]
}

@test "stage-boundary process cleanup fails closed when a principal never converges" {
  fake_bin="${BATS_TEST_TMPDIR}/process-fence-bin"
  state_file="${BATS_TEST_TMPDIR}/process-state"
  signal_log="${BATS_TEST_TMPDIR}/signals"
  mkdir -p "$fake_bin"
  printf '%s\n' '#!/usr/bin/env bash' \
    'if [[ "$#" -eq 1 && "$1" == "-u" ]]; then printf "0\n"; exit 0; fi' \
    'if [[ "$#" -eq 2 && "$1" == "-u" && "$2" == "agent" ]]; then printf "1001\n"; exit 0; fi' \
    'exit 2' > "${fake_bin}/id"
  printf '%s\n' '#!/usr/bin/env bash' 'printf " 201 Sl\n 202 Z+\n"' > "${fake_bin}/ps"
  printf '%s\n' '#!/usr/bin/env bash' \
    '[[ "$1" == "-KILL" && "$2" == "-u" && "$3" == "1001" ]] || exit 2' \
    'printf "signal\n" >> "$FAKE_SIGNAL_LOG"' > "${fake_bin}/pkill"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "${fake_bin}/sleep"
  chmod 0755 "${fake_bin}/id" "${fake_bin}/ps" "${fake_bin}/pkill" "${fake_bin}/sleep"

  ACTION_USERS=(agent)
  PROCESS_FENCE_MAX_ATTEMPTS=2
  PROCESS_FENCE_SLEEP_SECONDS=0
  log() { printf '%s\n' "$*"; }
  eval "$(sed -n '/^live_action_user_pids()/,/^}/p' "${BATS_TEST_DIRNAME}/../entrypoint.sh")"
  eval "$(sed -n '/^terminate_agent_processes()/,/^}/p' "${BATS_TEST_DIRNAME}/../entrypoint.sh")"
  printf 'sticky\n' > "$state_file"
  export FAKE_PROCESS_STATE="$state_file" FAKE_SIGNAL_LOG="$signal_log"

  run env PATH="${fake_bin}:$PATH" bash -c \
    "$(declare -p ACTION_USERS PROCESS_FENCE_MAX_ATTEMPTS PROCESS_FENCE_SLEEP_SECONDS); $(declare -f log live_action_user_pids terminate_agent_processes); terminate_agent_processes"
  [ "$status" -eq 1 ]
  [[ "$output" == *"cleanup did not converge to empty"* ]]
  [ "$(wc -l < "$signal_log" | tr -d ' ')" -eq 2 ]
}
