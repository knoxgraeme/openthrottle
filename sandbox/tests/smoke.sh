#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:-openthrottle:test}"
SMOKE_DIR="$(mktemp -d)"
NETWORK="ot-smoke-$RANDOM-$$"
CLAUDE_CONTAINER="ot-smoke-claude-$RANDOM-$$"

restore_host_ownership() {
  local path="$1"
  [[ -d "$path" ]] || return 0
  docker run --rm --entrypoint sh -v "$path:/state" "$IMAGE" \
    -c 'chattr -R -i /state >/dev/null 2>&1 || true; chown -R "$1:$2" /state; chmod -R u+rwX /state' \
    sh "$(id -u)" "$(id -g)"
}

cleanup() {
  docker rm -f "$CLAUDE_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  restore_host_ownership "$SMOKE_DIR" >/dev/null 2>&1 || true
  rm -rf "$SMOKE_DIR"
}
trap cleanup EXIT

mkdir -p \
  "$SMOKE_DIR/work" \
  "$SMOKE_DIR/bin" \
  "$SMOKE_DIR/result/claude-home" \
  "$SMOKE_DIR/result/codex-home" \
  "$SMOKE_DIR/result/opencode-home"
git init --bare "$SMOKE_DIR/repo.git" >/dev/null
git init -b main "$SMOKE_DIR/work" >/dev/null
git -C "$SMOKE_DIR/work" config user.email smoke@openthrottle.dev
git -C "$SMOKE_DIR/work" config user.name "OpenThrottle Smoke"
printf '{"name":"smoke","private":true}\n' > "$SMOKE_DIR/work/package.json"
printf '.claude/commands/persisted-project-review-command.md\n' > "$SMOKE_DIR/work/.gitignore"
printf 'agent: claude\nmodel: kimi-code/kimi-for-coding\npost_bootstrap: []\nlimits:\n  max_turns: 2\n  task_timeout: 30\n' \
  > "$SMOKE_DIR/work/.openthrottle.yml"
git -C "$SMOKE_DIR/work" add package.json .openthrottle.yml .gitignore
git -C "$SMOKE_DIR/work" commit -m "test: seed smoke fixture" >/dev/null
git -C "$SMOKE_DIR/work" remote add origin "file://$SMOKE_DIR/repo.git"
git -C "$SMOKE_DIR/work" push -u origin main >/dev/null
git --git-dir "$SMOKE_DIR/repo.git" symbolic-ref HEAD refs/heads/main

test "$(docker image inspect --format '{{json .Config.Entrypoint}}' "$IMAGE")" = '["/bin/true"]'

docker run --rm --entrypoint bash "$IMAGE" -lc '
  claude --version | rg -q "^2\.1\.201" &&
  claude --help | rg -q -- "--setting-sources" &&
  claude --help | rg -q -- "--strict-mcp-config" &&
  test "$(git -C /opt/openthrottle/compound-engineering-marketplace rev-parse HEAD)" = "8163a96e86656a89797869ac61905fe4641f81be" &&
  test "$(jq -r '\''.plugins[] | select(.name == "compound-engineering").source.sha'\'' /opt/openthrottle/compound-engineering-marketplace/.agents/plugins/marketplace.json)" = "8163a96e86656a89797869ac61905fe4641f81be" &&
  gosu agent env HOME=/home/agent claude plugin list --json | jq -e '\''.[] | select(.id == "compound-engineering@compound-engineering-plugin" and .version == "3.19.0" and .enabled == true)'\'' >/dev/null &&
  gosu agent env HOME=/home/agent claude plugin details compound-engineering@compound-engineering-plugin | rg -q "ce-work" &&
  test -f /home/agent/.claude/plugins/cache/compound-engineering-plugin/compound-engineering/3.19.0/skills/ce-work/SKILL.md &&
  rg -q "ce-work" /opt/openthrottle/skills/tasks/implement-plan/SKILL.md &&
  for ce_skill in $(rg -o "\bce-[a-z][a-z-]*[a-z]\b" /opt/openthrottle/skills/tasks/implement-plan/SKILL.md | sort -u); do
    test -f "/home/agent/.claude/plugins/cache/compound-engineering-plugin/compound-engineering/3.19.0/skills/${ce_skill}/SKILL.md" &&
    test -f "/home/agent/.codex/plugins/cache/compound-engineering-plugin/compound-engineering/3.19.0/skills/${ce_skill}/SKILL.md" &&
    find /opt/openthrottle/compound-engineering-marketplace -type f -path "*/skills/${ce_skill}/SKILL.md" -print -quit | rg -q .
  done &&
  test -f /opt/openthrottle/skills/tasks/investigate/SKILL.md &&
  test ! -e /opt/openthrottle/skills/claude &&
  test ! -e /opt/openthrottle/skills/opencode &&
  test ! -e /opt/openthrottle/skills/codex/implement-plan.md &&
  test ! -e /opt/openthrottle/skills/codex/review.md &&
  test ! -e /opt/openthrottle/skills/codex/review-fix.md &&
  test ! -e /opt/openthrottle/skills/codex/investigate.md &&
  test -f /opt/openthrottle/skills/codex/AGENTS-fragment.md &&
  codex --version | rg -q "0\.143\.0" &&
  codex exec --help | rg -q -- "--json" &&
  codex exec --help | rg -q -- "--dangerously-bypass-approvals-and-sandbox" &&
  codex exec resume --help | rg -q -- "--skip-git-repo-check" &&
  gosu agent env HOME=/home/agent CODEX_HOME=/home/agent/.codex codex plugin list --json | jq -e '\''.installed[] | select(.pluginId == "compound-engineering@compound-engineering-plugin" and .version == "3.19.0" and .enabled == true)'\'' >/dev/null &&
  test -f /home/agent/.codex/plugins/cache/compound-engineering-plugin/compound-engineering/3.19.0/skills/ce-work/SKILL.md &&
  test -f /etc/codex/skills/ce-work/SKILL.md &&
  test -f /etc/codex/skills/implement-plan/SKILL.md &&
  test -f /etc/codex/skills/investigate/SKILL.md &&
  rg -q "allow_implicit_invocation: false" /etc/codex/skills/implement-plan/agents/openai.yaml &&
  rg -q "allow_implicit_invocation: false" /etc/codex/skills/investigate/agents/openai.yaml &&
  opencode --version 2>&1 | rg -q "1\.18\.3" &&
  opencode run --help 2>&1 | rg -q -- "--format" &&
  opencode run --help 2>&1 | rg -q -- "--session" &&
  opencode run --help 2>&1 | rg -q -- "--model" &&
  opencode run --help 2>&1 | rg -q -- "--dir" &&
  opencode run --help 2>&1 | rg -q -- "--auto"
'

docker run --rm --entrypoint bash "$IMAGE" -lc '
  if /opt/openthrottle/safety/enforce-stage-push-policy; then
    echo "missing default push policy unexpectedly passed" >&2
    exit 1
  fi
  install -d -o root -g root -m 0755 /run/openthrottle
  printf "fresh\n" > /run/openthrottle/stage-push-policy
  chmod 0644 /run/openthrottle/stage-push-policy
  if /opt/openthrottle/safety/enforce-stage-push-policy; then
    echo "mutable default push policy unexpectedly passed" >&2
    exit 1
  fi
  chmod 0444 /run/openthrottle/stage-push-policy
  /opt/openthrottle/safety/enforce-stage-push-policy
'

cat > "$SMOKE_DIR/bin/claude" <<'STUB'
#!/usr/bin/env sh
test -f /opt/openthrottle/compound-engineering-marketplace/skills/ce-work/SKILL.md || {
  echo "Claude root-owned CE skill missing" >&2
  exit 25
}
case " $* " in
  *" --plugin-dir /opt/openthrottle/compound-engineering-marketplace "*) ;;
  *) echo "Claude did not load the root-owned CE marketplace" >&2; exit 25 ;;
esac
repo_dir="${OT_REPO_DIR:-$HOME/repo}"
ot-activity action "smoke Claude agent started"
if [ -n "${OT_STAGE_PROPOSAL_FILE:-}" ]; then
  case "$*" in
    *"/implement-plan"*) ;;
    *) echo "Claude stage did not use slash-command skill syntax" >&2; exit 26 ;;
  esac
  case " $* " in *" --max-turns 2 "*) ;; *) exit 27 ;; esac
  case " $* " in *" --strict-mcp-config "*) ;; *) exit 28 ;; esac
  test -f "$HOME/.claude/settings.json" || exit 29
  grep -Fq 'fixture-mcp' "${OT_CLAUDE_MCP_CONFIG:?}" || exit 30
  mkdir -p "$repo_dir/.claude/commands"
  touch "$repo_dir/.claude/commands/persisted-project-review-command.md"
  ot-stage-result '{"schema":"openthrottle.stage-proposal/v1","suggested_outcome":"success","summary":"Claude stage complete","evidence":["stub engine invoked"],"findings":[],"actions":[],"uncertainty":[]}' --output "$OT_STAGE_PROPOSAL_FILE" || exit 23
  test -s "$OT_STAGE_PROPOSAL_FILE" || exit 24
fi
printf '%s\n' "$*" >> "$HOME/.ot/claude-args.log"
case " $* " in
  *" --resume "*) cost=0.250 ;;
  *) cost=0.125 ;;
esac
printf '%s\n' \
  '{"type":"system","subtype":"init","session_id":"smoke-claude-session","model":"stub"}' \
  '{"type":"assistant","message":{"content":[{"type":"text","text":"smoke complete"}]}}' \
  "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"num_turns\":1,\"total_cost_usd\":${cost},\"result\":\"done\"}"
STUB

cat > "$SMOKE_DIR/bin/codex" <<'STUB'
#!/usr/bin/env sh
if [ "${1:-}" = "exec" ] && [ "${2:-}" = "--help" ]; then
  echo '--dangerously-bypass-hook-trust'
  exit 0
fi
test -f /etc/codex/skills/ce-work/SKILL.md || {
  echo "Codex admin-scope CE skill missing" >&2
  exit 25
}
ot-activity action "smoke Codex agent started"
if [ -n "${OT_STAGE_PROPOSAL_FILE:-}" ]; then
  test -f "$HOME/.codex/AGENTS.md" || exit 26
  test -f "$HOME/.codex/hooks.json" || exit 27
  case " $* " in *" --dangerously-bypass-hook-trust "*) ;; *) exit 28 ;; esac
  ot-stage-result '{"schema":"openthrottle.stage-proposal/v1","suggested_outcome":"success","summary":"Codex stage complete","evidence":["stub engine invoked"],"findings":[],"actions":[],"uncertainty":[]}' --output "$OT_STAGE_PROPOSAL_FILE" || exit 23
  test -s "$OT_STAGE_PROPOSAL_FILE" || exit 24
fi
if [ "${1:-}" = "mcp" ]; then
  exit 0
fi
printf '%s\n' "$*" >> "$HOME/.ot/codex-args.log"
last=""
for arg in "$@"; do last="$arg"; done
if [ "$last" = "-" ]; then
  cat > "$HOME/.ot/codex-stdin.log"
fi
printf '%s\n' \
  '{"type":"thread.started","thread_id":"smoke-codex-thread"}' \
  '{"type":"turn.started"}' \
  '{"type":"item.completed","item":{"type":"agent_message","text":"smoke complete"}}' \
  '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
STUB

cat > "$SMOKE_DIR/bin/opencode" <<'STUB'
#!/usr/bin/env sh
ot-activity action "smoke OpenCode agent started"
if [ -n "${OT_STAGE_PROPOSAL_FILE:-}" ]; then
  ot-stage-result '{"schema":"openthrottle.stage-proposal/v1","suggested_outcome":"success","summary":"OpenCode stage complete","evidence":["stub engine invoked"],"findings":[],"actions":[],"uncertainty":[]}' --output "$OT_STAGE_PROPOSAL_FILE" || exit 23
  test -s "$OT_STAGE_PROPOSAL_FILE" || exit 24
fi
if [ -n "${OPENCODE_CONFIG_DIR:-}" ]; then
  test "${OPENCODE_DISABLE_PROJECT_CONFIG:-}" = "1"
  test "${OPENCODE_DISABLE_EXTERNAL_SKILLS:-}" = "1"
  test "${OPENCODE_DISABLE_CLAUDE_CODE:-}" = "1"
  test -f "$OPENCODE_CONFIG_DIR/opencode.json"
  test -r "$OPENCODE_CONFIG_DIR/opencode.json"
  grep -Fq '/opt/openthrottle/compound-engineering-marketplace' "$OPENCODE_CONFIG_DIR/opencode.json"
  grep -Fq '{env:KIMI_CODE_API_KEY}' "$OPENCODE_CONFIG_DIR/opencode.json"
  grep -Fq 'fixture-mcp' "$OPENCODE_CONFIG_DIR/opencode.json"
  if grep -Fq "$KIMI_CODE_API_KEY" "$OPENCODE_CONFIG_DIR/opencode.json"; then
    exit 12
  fi
fi
printf '%s\n' "$*" >> "$HOME/.ot/opencode-args.log"
last=""
for arg in "$@"; do last="$arg"; done
printf '%s\n' "$last" >> "$HOME/.ot/opencode-prompt.log"
printf '%s\n' \
  '{"type":"message","sessionID":"smoke-opencode-session","part":{"type":"text","text":"smoke complete"}}' \
  '{"type":"step_finish","sessionID":"smoke-opencode-session","part":{"cost":0.375}}'
STUB
chmod 0755 "$SMOKE_DIR/bin/claude" "$SMOKE_DIR/bin/codex" "$SMOKE_DIR/bin/opencode"

docker network create "$NETWORK" >/dev/null

seed_agent_home() {
  local home_dir="$1"
  chmod 0777 "$home_dir"
  docker run --rm --entrypoint bash \
    -v "$home_dir:/seed" \
    "$IMAGE" -lc '
      gosu agent cp -a /home/agent/.claude /home/agent/.codex /seed/
      # Docker Desktop bind mounts reject the entrypoint ownership refresh
      # for copied git packfiles. Plugin discovery does not use cache VCS data.
      find /seed/.claude /seed/.codex -type d -name .git -prune \
        -exec rm -rf -- {} +
    '
}

CLAUDE_HOME="$SMOKE_DIR/result/claude-home"
seed_agent_home "$CLAUDE_HOME"

CODEX_HOME="$SMOKE_DIR/result/codex-home"
seed_agent_home "$CODEX_HOME"

OPENCODE_HOME="$SMOKE_DIR/result/opencode-home"
seed_agent_home "$OPENCODE_HOME"

CLAUDE_STATE="$SMOKE_DIR/result/stage-claude"
mkdir -p "$CLAUDE_STATE"
chmod 0777 "$CLAUDE_STATE"
docker run -d --name "$CLAUDE_CONTAINER" \
  --entrypoint tail \
  --network "$NETWORK" \
  -v "$SMOKE_DIR:/fixture" \
  -v "$SMOKE_DIR/bin/claude:/usr/local/bin/claude:ro" \
  -v "$SMOKE_DIR/bin/codex:/usr/local/bin/codex:ro" \
  -v "$SMOKE_DIR/bin/opencode:/usr/local/bin/opencode:ro" \
  -v "$CLAUDE_HOME:/home/agent" \
  -v "$CLAUDE_STATE:/var/lib/openthrottle" \
  "$IMAGE" -f /dev/null >/dev/null

run_stage_smoke() {
  local agent="$1"
  local home_dir="$2"
  local stage_kind="${3:-agent}"
  local state_dir="$SMOKE_DIR/result/stage-$agent-$stage_kind"
  if [[ "$agent" == "claude" ]]; then
    state_dir="$SMOKE_DIR/result/stage-claude"
  fi
  local attempt_id="attempt-$agent-$stage_kind"
  local run_id="run-stage-$agent-$stage_kind"
  local branch="ot/stage-$agent-$stage_kind"
  local base_commit tree_oid
  base_commit="$(git -C "$SMOKE_DIR/work" rev-parse HEAD)"
  tree_oid="$(git -C "$SMOKE_DIR/work" rev-parse 'HEAD^{tree}')"
  mkdir -p "$state_dir"
  chmod 0777 "$state_dir"

  docker run --rm --entrypoint node \
    -e "STAGE_AGENT=$agent" \
    -e "STAGE_KIND=$stage_kind" \
    -e "STAGE_ATTEMPT=$attempt_id" \
    -e "STAGE_RUN=$run_id" \
    -e "STAGE_BRANCH=$branch" \
    -e "STAGE_BASE=$base_commit" \
    -e "STAGE_TREE=$tree_oid" \
    -v "$state_dir:/state" \
    "$IMAGE" --input-type=module -e '
      import { mkdirSync, rmSync, writeFileSync } from "node:fs";
      import { canonicalJson, RUNTIME_DESCRIPTOR } from "/opt/openthrottle/runner/capabilities.mjs";
      import { digest } from "/opt/openthrottle/runner/artifacts.mjs";
      import { createStageRequestHash } from "/opt/openthrottle/runner/execute-stage.mjs";
      const commandStage = process.env.STAGE_KIND === "command";
      const config = {
        agent: process.env.STAGE_AGENT,
        ...(commandStage ? { test: "true" } : { model: "kimi-code/kimi-for-coding" }),
        post_bootstrap: [],
        limits: { max_turns: 2, task_timeout: 30 },
        mcp_servers: { "fixture-mcp": { command: "node", args: ["fixture-mcp.mjs"] } },
      };
      const capability = commandStage ? "command/run@1" : "ce/plan@1";
      const requiredArtifacts = commandStage
        ? ["stage_result", "command_result"]
        : ["stage_result"];
      const credentialScopes = commandStage ? ["repo.read"] : ["model.invoke", "repo.read"];
      const manifest = {
        schema: "openthrottle.pipeline/v1",
        id: "ce/stage-smoke",
        version: 1,
        description: "Provider-neutral stage smoke",
        entry_stage: "planning",
        max_attempts: 1,
        requires: { protocol: "stage-executor@1", capabilities: [capability] },
        stages: [{
          id: "planning",
          executor: { kind: commandStage ? "command" : "agent", capability },
          ...(commandStage ? { commandName: "test" } : {}),
          evaluator: commandStage
            ? { kind: "command", assurance: "executor_verified", required_artifacts: ["command_result"] }
            : { kind: "semantic", assurance: "semantic_attested", required_artifacts: ["stage_result"] },
          context: commandStage ? "none" : "fresh",
          live_steering: !commandStage,
          credentials: credentialScopes,
          produces: requiredArtifacts,
          transitions: {},
        }],
      };
      const configRaw = canonicalJson(config);
      const manifestRaw = canonicalJson(manifest);
      const base = {
        protocol: "stage-executor@1",
        pipelineInstanceId: `pipeline-${process.env.STAGE_AGENT}`,
        manifestDigest: digest(manifestRaw),
        runtimeRelease: RUNTIME_DESCRIPTOR.release,
        capabilityDigest: digest(canonicalJson(RUNTIME_DESCRIPTOR)),
        repositoryConfigDigest: digest(configRaw),
        stageId: "planning",
        attemptId: process.env.STAGE_ATTEMPT,
        runId: process.env.STAGE_RUN,
        issueId: `issue-${process.env.STAGE_AGENT}`,
        sessionId: `session-${process.env.STAGE_AGENT}`,
        generation: 1,
        taskType: "implement",
        taskContext: "Exercise the fenced planning stage for the smoke fixture.",
        transitionContext: "",
        repository: "owner/smoke",
        baseCommit: process.env.STAGE_BASE,
        baseBranch: "main",
        branch: process.env.STAGE_BRANCH,
        agent: process.env.STAGE_AGENT,
        contextRevision: 0,
        expectedSubject: process.env.STAGE_TREE,
        contextPolicy: commandStage ? "none" : "fresh",
        nativeSessionId: null,
        capability,
        requiredArtifacts,
        credentialScopes,
        liveSteering: !commandStage,
        ...(commandStage ? { commandName: "test" } : {}),
      };
      rmSync("/state/stage-input", { recursive: true, force: true });
      mkdirSync("/state/stage-input", { recursive: true, mode: 0o700 });
      writeFileSync("/state/stage-input/repository-config.json", configRaw, { mode: 0o400 });
      writeFileSync("/state/stage-input/pipeline-manifest.json", manifestRaw, { mode: 0o400 });
      writeFileSync(`/state/stage-input/${process.env.STAGE_ATTEMPT}.json`, canonicalJson({ ...base, ...createStageRequestHash(base) }), { mode: 0o400 });
    '

  local stage_env=(
    -e OT_SMOKE_TEST=1
    -e OT_GIT_URL_OVERRIDE=file:///fixture/repo.git
    -e "OT_STAGE_REQUEST_FILE=/var/lib/openthrottle/stage-input/$attempt_id.json"
    -e OT_STAGE_CONFIG_FILE=/var/lib/openthrottle/stage-input/repository-config.json
    -e OT_STAGE_MANIFEST_FILE=/var/lib/openthrottle/stage-input/pipeline-manifest.json
    -e TASK_TYPE=env-tampered
    -e AGENT=env-tampered
    -e GITHUB_REPO=env/tampered
    -e GITHUB_TOKEN=github-smoke-token
    -e "BASE_BRANCH=$base_commit"
    -e BRANCH_NAME=env/tampered
    -e "RUN_ID=$run_id"
    -e TASK_TIMEOUT=30
  )
  local docker_args=(
    run --rm
    --entrypoint /opt/openthrottle/entrypoint.sh
    --network "$NETWORK"
    -v "$SMOKE_DIR:/fixture"
    -v "$SMOKE_DIR/bin/claude:/usr/local/bin/claude:ro"
    -v "$SMOKE_DIR/bin/codex:/usr/local/bin/codex:ro"
    -v "$SMOKE_DIR/bin/opencode:/usr/local/bin/opencode:ro"
    -v "$home_dir:/home/agent"
    -v "$state_dir:/var/lib/openthrottle"
  )
  if [[ "$agent" == "claude" ]]; then
    stage_env+=(-e CLAUDE_CODE_OAUTH_TOKEN=claude-oauth-token)
  elif [[ "$agent" == "codex" ]]; then
    stage_env+=(-e 'CODEX_AUTH_JSON={}')
  elif [[ "$stage_kind" != "command" ]]; then
    stage_env+=(-e KIMI_CODE_API_KEY=kimi-smoke-secret)
  fi
  local stage_failed=0
  if [[ "$agent" == "claude" ]]; then
    docker exec "${stage_env[@]}" "$CLAUDE_CONTAINER" /opt/openthrottle/entrypoint.sh || stage_failed=$?
  else
    docker "${docker_args[@]}" "${stage_env[@]}" "$IMAGE" || stage_failed=$?
  fi
  if [[ "$stage_failed" -ne 0 ]]; then
    echo "stage container failed for ${agent}/${stage_kind}" >&2
    if [[ -f "$home_dir/.ot/task.log" ]]; then
      tail -n 200 "$home_dir/.ot/task.log" >&2
    fi
    return 1
  fi

  # The runtime intentionally creates its spool root-only. Make this bind
  # mounted smoke fixture readable/removable by the non-root GitHub runner
  # without weakening the permissions used in real Daytona sandboxes.
  restore_host_ownership "$state_dir"

  test "$(git -c "safe.directory=$home_dir/repo" -C "$home_dir/repo" branch --show-current)" = "$branch"

  local result="$state_dir/stage-results/$attempt_id.json"
  if ! jq -e --arg attempt "$attempt_id" --arg run "$run_id" --arg stageKind "$stage_kind" '
    .kind == "stage_result" and .attempt_id == $attempt and .run_id == $run and
    .outcome == "success" and
    (if $stageKind == "command" then
      (.artifacts | length == 2) and all(.artifacts[]; .assurance == "executor_verified")
    else
      (.artifacts | length == 1) and
      all(.artifacts[]; .assurance == "semantic_attested" and
        (.payload | fromjson | .result == "success"))
    end)
  ' "$result" >/dev/null; then
    echo "invalid normalized stage result for $agent" >&2
    cat "$result" >&2
    exit 1
  fi
  if find "$home_dir/.ot/outbox" -name "*completion-$run_id.json" -print -quit | grep -q .; then
    echo "stage execution emitted an unexpected completion event" >&2
    exit 1
  fi
}

# The per-stage task.log lives in the agent home; read it through the image so
# the root-only ~/.ot permissions never have to be weakened for the host.
assert_claude_stage_log() {
  local pattern="$1"
  if ! docker run --rm --entrypoint grep -v "$CLAUDE_HOME:/home/agent" "$IMAGE" \
      -F -q "$pattern" /home/agent/.ot/task.log; then
    echo "expected claude stage log to contain: $pattern" >&2
    exit 1
  fi
}

run_stage_smoke claude "$CLAUDE_HOME"
# First stage in a fresh sandbox pays the bake-once bootstrap and seals the
# digest-fenced completion marker.
assert_claude_stage_log "bake-once bootstrap complete (config digest"
# Subsequent stages reuse the same sandbox (shared stage-claude state dir) but
# carry distinct attempt/run/branch ids, so they must skip the bootstrap.
run_stage_smoke claude "$CLAUDE_HOME" second
assert_claude_stage_log "bake-once bootstrap already complete (config digest"
run_stage_smoke claude "$CLAUDE_HOME" third
assert_claude_stage_log "bake-once bootstrap already complete (config digest"
run_stage_smoke codex "$CODEX_HOME"
run_stage_smoke opencode "$OPENCODE_HOME"
run_stage_smoke opencode "$OPENCODE_HOME" command

echo "sandbox Claude + Codex + OpenCode fenced stage smoke passed"
