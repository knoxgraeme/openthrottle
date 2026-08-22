#!/usr/bin/env bats

setup() {
  SANDBOX_DIR="${BATS_TEST_DIRNAME}/.."
}

@test "kernel shell boundaries parse" {
  run bash -n "$SANDBOX_DIR/entrypoint.sh"
  [ "$status" -eq 0 ]

  run bash -n "$SANDBOX_DIR/hooks/ot-inbox-drain.sh"
  [ "$status" -eq 0 ]
}

@test "entrypoint exposes only action and integration request families" {
  run grep -E 'OT_(STAGE|LOOP|CHILD|RECEIPT|UNIT)_' "$SANDBOX_DIR/entrypoint.sh"
  [ "$status" -eq 1 ]

  run grep -F 'OT_ACTION_REQUEST_FILE' "$SANDBOX_DIR/entrypoint.sh"
  [ "$status" -eq 0 ]
  run grep -F 'OT_ACTION_RESULT_FILE' "$SANDBOX_DIR/entrypoint.sh"
  [ "$status" -eq 0 ]
  run grep -F 'OT_ACTION_SESSION_FILE' "$SANDBOX_DIR/entrypoint.sh"
  [ "$status" -eq 0 ]
  run grep -F 'OT_INTEGRATION_REQUEST_FILE' "$SANDBOX_DIR/entrypoint.sh"
  [ "$status" -eq 0 ]
  run grep -F 'OT_INTEGRATION_RESULT_FILE' "$SANDBOX_DIR/entrypoint.sh"
  [ "$status" -eq 0 ]
}

@test "entrypoint dispatches exactly one executor per request family" {
  [ "$(grep -Fc 'execute-attempt.mjs' "$SANDBOX_DIR/entrypoint.sh")" -eq 2 ]
  [ "$(grep -Fc 'integrate-checkpoint.mjs' "$SANDBOX_DIR/entrypoint.sh")" -eq 1 ]
  [ ! -e "$SANDBOX_DIR/runner/execute-stage.mjs" ]
  [ ! -e "$SANDBOX_DIR/runner/execute-loop.mjs" ]
  [ ! -e "$SANDBOX_DIR/runner/execute-child-action.mjs" ]
  [ ! -e "$SANDBOX_DIR/bin/ot-stage-result.mjs" ]
  [ ! -e "$SANDBOX_DIR/bin/ot-subject-post.mjs" ]
}

@test "entrypoint validates the executor-owned source fence before sealing" {
  entrypoint="$SANDBOX_DIR/entrypoint.sh"

  run grep -F 'readonly REPO_PARENT="/var/lib/openthrottle/repository-source"' "$entrypoint"
  [ "$status" -eq 0 ]
  run grep -F 'validate_repository_source' "$entrypoint"
  [ "$status" -eq 0 ]
  run grep -F 'root:root:700' "$entrypoint"
  [ "$status" -eq 0 ]
  run grep -F 'seal_repository_source' "$entrypoint"
  [ "$status" -eq 0 ]
  run grep -F -- 'find -P "$REPO_DIR"' "$entrypoint"
  [ "$status" -eq 0 ]
  run grep -F -- 'chmod a-w' "$entrypoint"
  [ "$status" -eq 0 ]
}

@test "inspect authority uses native CLI restrictions and edit authority stays explicit" {
  authority="$SANDBOX_DIR/runner/repository-authority.mjs"
  runtime="$SANDBOX_DIR/runner/agent-runtime.mjs"

  run grep -F -- '"--tools", "Read,Grep,Glob"' "$authority"
  [ "$status" -eq 0 ]
  run grep -F -- '"--sandbox", "read-only"' "$authority"
  [ "$status" -eq 0 ]
  run grep -F -- '"--dangerously-skip-permissions"' "$runtime"
  [ "$status" -eq 0 ]
  run grep -F -- '"--dangerously-bypass-approvals-and-sandbox"' "$runtime"
  [ "$status" -eq 0 ]
}

@test "result correction cannot mutate the repository or load skills" {
  runtime="$SANDBOX_DIR/runner/agent-runtime.mjs"
  run grep -F -- '"--allowedTools", "Bash(ot-result:*)"' "$runtime"
  [ "$status" -eq 0 ]
  run grep -F -- 'allowedSkills: []' "$runtime"
  [ "$status" -eq 0 ]
  run grep -F -- 'prepareResultCorrectionRuntime' "$runtime"
  [ "$status" -eq 0 ]
}

@test "checkpoint and integration artifacts use one immutable bundle protocol" {
  checkpoint="$SANDBOX_DIR/runner/checkpoint-bundle.mjs"
  integration="$SANDBOX_DIR/runner/integrate-checkpoint.mjs"
  run grep -F 'openthrottle.attempt-checkpoint-wire/v1' "$checkpoint"
  [ "$status" -eq 0 ]
  run grep -F 'openthrottle.git-checkpoint-bundle/v1' "$checkpoint"
  [ "$status" -eq 0 ]
  run grep -F 'refs/openthrottle/checkpoints/' "$checkpoint"
  [ "$status" -eq 0 ]
  run grep -F 'refs/openthrottle/integrations/' "$integration"
  [ "$status" -eq 0 ]
}
