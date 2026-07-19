#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:-openthrottle:test}"
SMOKE_DIR="$(mktemp -d)"
NETWORK="ot-smoke-$RANDOM-$$"

cleanup() {
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$SMOKE_DIR"
}
trap cleanup EXIT

mkdir -p \
  "$SMOKE_DIR/work" \
  "$SMOKE_DIR/bin" \
  "$SMOKE_DIR/result/claude-home" \
  "$SMOKE_DIR/result/codex-home"
git init --bare "$SMOKE_DIR/repo.git" >/dev/null
git init -b main "$SMOKE_DIR/work" >/dev/null
git -C "$SMOKE_DIR/work" config user.email smoke@openthrottle.dev
git -C "$SMOKE_DIR/work" config user.name "OpenThrottle Smoke"
printf '{"name":"smoke","private":true}\n' > "$SMOKE_DIR/work/package.json"
printf 'agent: claude\npost_bootstrap: []\nlimits:\n  max_turns: 2\n  task_timeout: 30\n' \
  > "$SMOKE_DIR/work/.openthrottle.yml"
git -C "$SMOKE_DIR/work" add package.json .openthrottle.yml
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
  gosu agent env HOME=/home/agent claude plugin list --json | jq -e '\''.[] | select(.id == "compound-engineering@compound-engineering-plugin" and .version == "3.19.0" and .enabled == true)'\'' >/dev/null &&
  gosu agent env HOME=/home/agent claude plugin details compound-engineering@compound-engineering-plugin | rg -q "ce-work" &&
  test -f /home/agent/.claude/plugins/cache/compound-engineering-plugin/compound-engineering/3.19.0/skills/ce-work/SKILL.md &&
  rg -q "/ce-work" /opt/openthrottle/skills/claude/implement-plan/SKILL.md &&
  codex --version | rg -q "0\.143\.0" &&
  codex exec --help | rg -q -- "--json" &&
  codex exec --help | rg -q -- "--dangerously-bypass-approvals-and-sandbox" &&
  codex exec resume --help | rg -q -- "--skip-git-repo-check" &&
  gosu agent env HOME=/home/agent CODEX_HOME=/home/agent/.codex codex plugin list --json | jq -e '\''.installed[] | select(.pluginId == "compound-engineering@compound-engineering-plugin" and .version == "3.19.0" and .enabled == true)'\'' >/dev/null &&
  test -f /home/agent/.codex/plugins/cache/compound-engineering-plugin/compound-engineering/3.19.0/skills/ce-work/SKILL.md
'

cat > "$SMOKE_DIR/bin/claude" <<'STUB'
#!/usr/bin/env sh
test -f "$HOME/.claude/plugins/cache/compound-engineering-plugin/compound-engineering/3.19.0/skills/ce-work/SKILL.md"
ot-activity action "smoke Claude agent started"
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
test -f "$HOME/.codex/plugins/cache/compound-engineering-plugin/compound-engineering/3.19.0/skills/ce-work/SKILL.md"
ot-activity action "smoke Codex agent started"
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
chmod 0755 "$SMOKE_DIR/bin/claude" "$SMOKE_DIR/bin/codex"

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

run_sandbox() {
  local home_dir="$1"
  local agent="$2"
  local task_type="$3"
  local branch="$4"
  local run_id="$5"
  local issue_identifier="$6"
  local resume_message="${7:-}"
  mkdir -p "$home_dir/.ot"
  printf '# %s\n\nApproved smoke-test plan.\n' "$issue_identifier" \
    > "$home_dir/.ot/linear-context.md"
  local docker_args=(
    run --rm
    --entrypoint /opt/openthrottle/entrypoint.sh
    --network "$NETWORK"
    -e OT_SMOKE_TEST=1
    -e OT_GIT_URL_OVERRIDE=file:///fixture/repo.git
    -e "TASK_TYPE=$task_type"
    -e "AGENT=$agent"
    -e GITHUB_REPO=owner/smoke
    -e GITHUB_TOKEN=github-smoke-token
    -e BASE_BRANCH=main
    -e "BRANCH_NAME=$branch"
    -e "LINEAR_ISSUE_ID=issue-$issue_identifier"
    -e "LINEAR_ISSUE_IDENTIFIER=$issue_identifier"
    -e "RUN_ID=$run_id"
    -e "RUN_CALLBACK_TOKEN=token-$run_id"
    -e TASK_TIMEOUT=30
    -v "$SMOKE_DIR:/fixture"
    -v "$SMOKE_DIR/bin/claude:/usr/local/bin/claude:ro"
    -v "$SMOKE_DIR/bin/codex:/usr/local/bin/codex:ro"
    -v "$home_dir:/home/agent"
  )
  if [[ -n "$resume_message" ]]; then
    docker_args+=(-e "RESUME_MESSAGE=$resume_message")
  fi
  if [[ "$agent" == "claude" ]]; then
    docker_args+=(-e CLAUDE_CODE_OAUTH_TOKEN=claude-oauth-token)
  else
    docker_args+=(-e 'CODEX_AUTH_JSON={}')
  fi
  docker "${docker_args[@]}" "$IMAGE"
}

CLAUDE_HOME="$SMOKE_DIR/result/claude-home"
seed_agent_home "$CLAUDE_HOME"
run_sandbox "$CLAUDE_HOME" claude implement ot/smoke-claude claude-implement OT-CLAUDE
test "$(cat "$CLAUDE_HOME/.ot/agent-session-id")" = "smoke-claude-session"
run_sandbox "$CLAUDE_HOME" claude resume ot/smoke-claude claude-resume OT-CLAUDE "continue"
grep -q -- '--resume smoke-claude-session' "$CLAUDE_HOME/.ot/claude-args.log"
jq -e '.exit_code == 0 and .cost_usd == 0.125' \
  "$(find "$CLAUDE_HOME/.ot/outbox" -name '*completion-claude-implement.json' -print -quit)" >/dev/null
jq -e '.exit_code == 0 and .cost_usd == 0.25' \
  "$(find "$CLAUDE_HOME/.ot/outbox" -name '*completion-claude-resume.json' -print -quit)" >/dev/null
jq -e '.kind == "activity" and .type == "action"' \
  "$(find "$CLAUDE_HOME/.ot/outbox" -name '*-activity-*.json' -print -quit)" >/dev/null

CODEX_HOME="$SMOKE_DIR/result/codex-home"
seed_agent_home "$CODEX_HOME"
run_sandbox "$CODEX_HOME" codex implement ot/smoke-codex codex-implement OT-CODEX
test "$(cat "$CODEX_HOME/.ot/agent-session-id")" = "smoke-codex-thread"
grep -Fq '$ce-work' "$CODEX_HOME/.ot/codex-stdin.log"
grep -Fq 'CE pipeline: ce-work,ce-code-review,ce-commit-push-pr,ce-babysit-pr' \
  "$CODEX_HOME/.ot/codex-stdin.log"
run_sandbox "$CODEX_HOME" codex resume ot/smoke-codex codex-resume OT-CODEX "continue"
grep -q -- 'exec .* resume smoke-codex-thread continue' "$CODEX_HOME/.ot/codex-args.log"
jq -e '.exit_code == 0 and (has("cost_usd") | not)' \
  "$(find "$CODEX_HOME/.ot/outbox" -name '*completion-codex-implement.json' -print -quit)" >/dev/null
jq -e '.exit_code == 0 and (has("cost_usd") | not)' \
  "$(find "$CODEX_HOME/.ot/outbox" -name '*completion-codex-resume.json' -print -quit)" >/dev/null
jq -e '.kind == "activity" and .type == "action"' \
  "$(find "$CODEX_HOME/.ot/outbox" -name '*-activity-*.json' -print -quit)" >/dev/null

git --git-dir "$SMOKE_DIR/repo.git" show-ref --verify --quiet refs/heads/ot/smoke-claude
git --git-dir "$SMOKE_DIR/repo.git" show-ref --verify --quiet refs/heads/ot/smoke-codex
if grep -R --exclude-dir=outbox -n -E -- \
  'github-smoke-token|claude-oauth-token|token-(claude|codex)' \
  "$SMOKE_DIR/result"; then
  echo "smoke artifacts leaked a secret" >&2
  exit 1
fi

echo "sandbox Claude + Codex implement/resume smoke passed"
