#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:-openthrottle:test}"
SMOKE_DIR="$(mktemp -d)"
NETWORK="ot-smoke-$RANDOM-$$"
CALLBACK_CONTAINER="ot-callback-$RANDOM-$$"

cleanup() {
  docker rm -f "$CALLBACK_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$SMOKE_DIR"
}
trap cleanup EXIT

mkdir -p \
  "$SMOKE_DIR/work" \
  "$SMOKE_DIR/bin" \
  "$SMOKE_DIR/result/callback" \
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

docker run --rm --entrypoint bash "$IMAGE" -lc '
  claude --version | rg -q "^2\.1\.201" &&
  claude --help | rg -q -- "--setting-sources" &&
  claude --help | rg -q -- "--strict-mcp-config" &&
  codex --version | rg -q "0\.143\.0" &&
  codex exec --help | rg -q -- "--json" &&
  codex exec --help | rg -q -- "--dangerously-bypass-approvals-and-sandbox" &&
  codex exec resume --help | rg -q -- "--skip-git-repo-check"
'

cat > "$SMOKE_DIR/bin/claude" <<'STUB'
#!/usr/bin/env sh
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
if [ "${1:-}" = "mcp" ]; then
  exit 0
fi
printf '%s\n' "$*" >> "$HOME/.ot/codex-args.log"
printf '%s\n' \
  '{"type":"thread.started","thread_id":"smoke-codex-thread"}' \
  '{"type":"turn.started"}' \
  '{"type":"item.completed","item":{"type":"agent_message","text":"smoke complete"}}' \
  '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
STUB
chmod 0755 "$SMOKE_DIR/bin/claude" "$SMOKE_DIR/bin/codex"

cat > "$SMOKE_DIR/callback.mjs" <<'SERVER'
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

createServer((request, response) => {
  const match = request.url?.match(/^\/runs\/([^/]+)\/complete$/);
  const runId = match?.[1];
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    if (
      request.method !== "POST" ||
      !runId ||
      request.headers.authorization !== `Bearer token-${runId}`
    ) {
      response.writeHead(401).end("invalid");
      return;
    }
    writeFileSync(`/result/${runId}.json`, Buffer.concat(chunks));
    response.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
  });
}).listen(8080, "0.0.0.0");
SERVER

docker network create "$NETWORK" >/dev/null
docker run -d --rm \
  --name "$CALLBACK_CONTAINER" \
  --network "$NETWORK" \
  -v "$SMOKE_DIR/callback.mjs:/callback.mjs:ro" \
  -v "$SMOKE_DIR/result/callback:/result" \
  node:22-bookworm node /callback.mjs >/dev/null

run_sandbox() {
  local home_dir="$1"
  local agent="$2"
  local task_type="$3"
  local branch="$4"
  local run_id="$5"
  local issue_identifier="$6"
  local resume_message="${7:-}"
  local docker_args=(
    run --rm
    --network "$NETWORK"
    -e OT_SMOKE_TEST=1
    -e OT_GIT_URL_OVERRIDE=file:///fixture/repo.git
    -e "TASK_TYPE=$task_type"
    -e "AGENT=$agent"
    -e GITHUB_REPO=owner/smoke
    -e GITHUB_TOKEN=github-smoke-token
    -e BASE_BRANCH=main
    -e "BRANCH_NAME=$branch"
    -e "LINEAR_SESSION_ID=session-$issue_identifier"
    -e "LINEAR_ISSUE_ID=issue-$issue_identifier"
    -e "LINEAR_ISSUE_IDENTIFIER=$issue_identifier"
    -e LINEAR_ACCESS_TOKEN=linear-oauth-token
    -e LINEAR_MCP_API_KEY=linear-mcp-key
    -e CLAUDE_CODE_OAUTH_TOKEN=claude-oauth-token
    -e CODEX_API_KEY=codex-api-key
    -e SUPERVISOR_URL="http://$CALLBACK_CONTAINER:8080"
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
  docker "${docker_args[@]}" "$IMAGE"
}

CLAUDE_HOME="$SMOKE_DIR/result/claude-home"
run_sandbox "$CLAUDE_HOME" claude implement ot/smoke-claude claude-implement OT-CLAUDE
test "$(cat "$CLAUDE_HOME/.ot/agent-session-id")" = "smoke-claude-session"
run_sandbox "$CLAUDE_HOME" claude resume ot/smoke-claude claude-resume OT-CLAUDE "continue"
rg -q -- '--resume smoke-claude-session' "$CLAUDE_HOME/.ot/claude-args.log"
jq -e '.exit_code == 0 and .cost_usd == 0.125' \
  "$SMOKE_DIR/result/callback/claude-implement.json" >/dev/null
jq -e '.exit_code == 0 and .cost_usd == 0.25' \
  "$SMOKE_DIR/result/callback/claude-resume.json" >/dev/null

CODEX_HOME="$SMOKE_DIR/result/codex-home"
run_sandbox "$CODEX_HOME" codex implement ot/smoke-codex codex-implement OT-CODEX
test "$(cat "$CODEX_HOME/.ot/agent-session-id")" = "smoke-codex-thread"
run_sandbox "$CODEX_HOME" codex resume ot/smoke-codex codex-resume OT-CODEX "continue"
rg -q -- 'exec .* resume smoke-codex-thread continue' "$CODEX_HOME/.ot/codex-args.log"
jq -e '.exit_code == 0 and (has("cost_usd") | not)' \
  "$SMOKE_DIR/result/callback/codex-implement.json" >/dev/null
jq -e '.exit_code == 0 and (has("cost_usd") | not)' \
  "$SMOKE_DIR/result/callback/codex-resume.json" >/dev/null

git --git-dir "$SMOKE_DIR/repo.git" show-ref --verify --quiet refs/heads/ot/smoke-claude
git --git-dir "$SMOKE_DIR/repo.git" show-ref --verify --quiet refs/heads/ot/smoke-codex
if rg -n \
  'github-smoke-token|linear-oauth-token|linear-mcp-key|claude-oauth-token|codex-api-key|token-(claude|codex)' \
  "$SMOKE_DIR/result"; then
  echo "smoke artifacts leaked a secret" >&2
  exit 1
fi

echo "sandbox Claude + Codex implement/resume smoke passed"
