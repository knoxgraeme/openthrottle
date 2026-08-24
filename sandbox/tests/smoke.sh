#!/usr/bin/env bash

set -euo pipefail

IMAGE="${1:-openthrottle:test}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SMOKE_DIR="$(mktemp -d)"
CONTAINER=""

cleanup() {
  if [ -n "$CONTAINER" ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
  rm -rf "$SMOKE_DIR"
}
trap cleanup EXIT

for command in docker git jq node; do
  command -v "$command" >/dev/null || { echo "missing smoke dependency: $command" >&2; exit 1; }
done

SOURCE_REPO="$SMOKE_DIR/source"
REQUESTS="$SMOKE_DIR/requests"
mkdir -p "$SOURCE_REPO" "$REQUESTS"
git -C "$SOURCE_REPO" init -q -b main
git -C "$SOURCE_REPO" config user.name "Smoke Test"
git -C "$SOURCE_REPO" config user.email smoke@example.com
printf 'base\n' > "$SOURCE_REPO/work.txt"
printf '#!/bin/sh\nexit 0\n' > "$SOURCE_REPO/tool.sh"
chmod 0755 "$SOURCE_REPO/tool.sh"
git -C "$SOURCE_REPO" add .
git -C "$SOURCE_REPO" commit -qm base

node --input-type=module - "$SOURCE_REPO" "$REQUESTS" <<'NODE'
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [source, output] = process.argv.slice(2);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
};
const digest = (value) => sha(canonical(value));
const subject = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const instructions = "Follow the sealed task and return concise, evidence-backed results.";
const reference = "Check only the acceptance criteria supplied in the task.";
const skill = {
  frontmatter: { name: "implement-plan", description: "Implement one approved task" },
  instructions: "Use references/checklist.md only when implementation details require it.",
  files: [{ path: "references/checklist.md", content: reference, content_hash: sha(reference) }],
};
const semantic = {
  schema: "openthrottle.semantic-result-schema/v1",
  id: "core/smoke-result",
  outcomes: ["success", "failure", "needs_human"],
  payload: {
    summary: { type: "string", max_length: 4000, normalize: "string-array-to-newlines/v1" },
    verification: { type: "string_list", max_length: 1000, max_items: 32 },
  },
};
const request = (attempt, authority, requestHash, engine = "claude") => ({
  schema: "openthrottle.kernel-action-request/v2",
  phase: "work",
  pipeline_run_id: "smoke-run",
  attempt_id: attempt,
  stage_id: authority === "edit" ? "implement" : "review",
  scope: { kind: "stage", stage_id: authority === "edit" ? "implement" : "review" },
  request_hash: requestHash,
  definition_bundle_hash: "b".repeat(64),
  input_subject: subject,
  checkpoint_base_subject: subject,
  repository_authority: authority,
  lease_id: `lease-${attempt}`,
  worker_id: "smoke-worker",
  task_prompt: authority === "edit" ? "Update work.txt." : "Inspect work.txt without changing it.",
  context: { records: [], checkpoints: [] },
  runtime_resource: null,
  change_boundary: null,
  action: {
    kind: "agent",
    engine,
    model: null,
    reasoning_effort: null,
    agent_id: "core/smoke-agent",
    skill_ids: ["core/implement-plan"],
    entry_skill: "core/implement-plan",
    eval_id: semantic.id,
    semantic_result_schema: semantic,
    execution_limits: {
      max_turns: engine === "claude" ? 12 : null,
      task_timeout_seconds: 600,
    },
    definition_entries: [
      { definition_kind: "agent", definition_id: "core/smoke-agent", content_hash: digest(instructions), normalized_payload: instructions },
      { definition_kind: "skill", definition_id: "core/implement-plan", content_hash: digest(skill), normalized_payload: skill },
    ],
  },
  executor_policy: { git_administration: "executor_only", commit: false, push: false, publish: false },
});
writeFileSync(join(output, "edit.json"), `${JSON.stringify(request("attempt-edit", "edit", "a".repeat(64)))}\n`);
writeFileSync(join(output, "inspect.json"), `${JSON.stringify(request("attempt-inspect", "inspect", "c".repeat(64)))}\n`);
writeFileSync(join(output, "inspect-codex.json"), `${JSON.stringify(request(
  "attempt-inspect-codex",
  "inspect",
  "d".repeat(64),
  "codex",
))}\n`);
writeFileSync(join(output, "command.json"), `${JSON.stringify({
  ...request("attempt-command", "edit", "e".repeat(64)),
  action: {
    kind: "command",
    command_id: "git-metadata",
    command_line: [
      'test "$(id -un)" = agent',
      'test "$(stat -c %U .)" = agent',
      'test "$(stat -c %U .git)" = root',
      'test ! -w .git',
      'test ! -w .git/config',
      'test "$GIT_CONFIG_COUNT" = 1',
      'test "$GIT_CONFIG_KEY_0" = safe.directory',
      'test "$GIT_CONFIG_VALUE_0" = "$PWD"',
      'test "$GIT_CONFIG_NOSYSTEM" = 1',
      'test "$GIT_CONFIG_GLOBAL" = /dev/null',
      'test "$GIT_OPTIONAL_LOCKS" = 0',
      'test "$GIT_TERMINAL_PROMPT" = 0',
      'test "$(git config --get-all safe.directory)" = "$PWD"',
      'test "$(git rev-parse --show-toplevel)" = "$PWD"',
      'test "$(git show --no-patch --format=%s HEAD)" = "OpenThrottle action boundary"',
    ].join(" && "),
    post_bootstrap: [],
    execution_limits: { max_turns: null, task_timeout_seconds: 120 },
  },
})}\n`);
NODE

mkdir -p "$SMOKE_DIR/stub"
cat > "$SMOKE_DIR/stub/claude" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
prompt="$(cat)"
[[ "$prompt" == *"## Agent instructions (core/smoke-agent)"* ]]
[[ "$prompt" == *"## Available skills"* ]]
[[ "$prompt" == *"## Sealed task prompt"* ]]
test -f "$HOME/.claude/skills/implement-plan/SKILL.md"
test -f "$HOME/.claude/skills/implement-plan/references/checklist.md"
test ! -e "$HOME/.claude/skills/review-change"
test -f "$OT_LEASE_GENERATION_FENCE_FILE"
test -f "$OT_LEASE_GENERATION_LOCK_FILE"
[ "$(stat -c %U "$OT_LEASE_GENERATION_FENCE_FILE")" = "root" ]
[ "$(stat -c %a "$OT_LEASE_GENERATION_FENCE_FILE")" = "444" ]
[ "$(stat -c %U "$OT_LEASE_GENERATION_LOCK_FILE")" = "root" ]
[ "$(stat -c %a "$OT_LEASE_GENERATION_LOCK_FILE")" = "444" ]
[ ! -s "$OT_LEASE_GENERATION_LOCK_FILE" ]
jq -e --arg attempt "$OT_ATTEMPT_ID" '
  .schema == "openthrottle.kernel-lease-generation-fence/v1" and
  .attempt_id == $attempt and .lease_generation == 0
' "$OT_LEASE_GENERATION_FENCE_FILE" >/dev/null
mkdir -p /tmp/openthrottle-smoke-launches
printf 'launch\n' >> "/tmp/openthrottle-smoke-launches/${OT_ATTEMPT_ID}"
if [ "$OT_ATTEMPT_ID" = "attempt-edit" ]; then
  source_parent=/var/lib/openthrottle/repository-source
  source_repository="$source_parent/repo"
  if printf 'poisoned shared source\n' > "$source_repository/work.txt" 2>/dev/null; then
    echo "edit agent mutated the shared source checkout" >&2
    exit 40
  fi
  if mv "$source_repository" /tmp/repository-source-renamed 2>/dev/null; then
    echo "edit agent renamed the shared source checkout" >&2
    exit 41
  fi
  mkdir -p /tmp/repository-source-replacement
  if mv /tmp/repository-source-replacement "$source_parent/replacement" 2>/dev/null; then
    echo "edit agent introduced a replacement source checkout" >&2
    exit 42
  fi
  grep -qx base work.txt
  test -x tool.sh
  printf 'implemented\n' > work.txt
  summary='["Edited repository.","Verification passed."]'
else
  grep -qx base work.txt
  test ! -e source-link
  git status --short >/dev/null
  git show --no-patch --format=%s HEAD >/dev/null
  git diff --quiet
  if printf 'forbidden\n' > work.txt 2>/dev/null; then
    echo "inspect repository was writable" >&2
    exit 41
  fi
  summary='["Inspected repository.","No mutation was possible."]'
fi
printf '{"type":"system","subtype":"init","session_id":"session-%s"}\n' "$OT_ATTEMPT_ID"
printf '{"type":"result","subtype":"success","structured_output":{"schema":"openthrottle.result-candidate/v1","outcome":"success","payload":{"summary":%s,"verification":["stub assertions passed"]}}}\n' "$summary"
STUB
chmod 0755 "$SMOKE_DIR/stub/claude"

cat > "$SMOKE_DIR/stub/codex" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

contains_pair() {
  local expected_key="$1" expected_value="$2" previous=""
  shift 2
  for argument in "$@"; do
    if [ "$previous" = "$expected_key" ] && [ "$argument" = "$expected_value" ]; then
      return 0
    fi
    previous="$argument"
  done
  return 1
}

contains_pair --ask-for-approval never "$@"
contains_pair --sandbox danger-full-access "$@"
contains_pair --disable apps "$@"
contains_pair --disable browser_use "$@"
contains_pair --disable plugins "$@"
for argument in "$@"; do
  [ "$argument" != "read-only" ]
done

prompt="$(cat)"
[[ "$prompt" == *"## Agent instructions (core/smoke-agent)"* ]]
[[ "$prompt" == *"## Available skills"* ]]
[[ "$prompt" == *"## Sealed task prompt"* ]]
test -f "$CODEX_HOME/skills/implement-plan/SKILL.md"
test -f "$CODEX_HOME/skills/implement-plan/references/checklist.md"

for name in GITHUB_TOKEN GH_TOKEN LINEAR_API_KEY DAYTONA_API_KEY FLY_API_TOKEN GIT_ASKPASS GIT_SSH_COMMAND SSH_ASKPASS; do
  if env | grep -q "^${name}="; then
    echo "ambient credential reached Codex child: ${name}" >&2
    exit 43
  fi
done

test "$(stat -c %U:%G .)" = root:root
test "$(stat -c %U:%G .git)" = root:root
test ! -w .
test ! -w .git
test ! -w work.txt
test "$(git config --get remote.origin.url)" = DISABLED_BY_OPENTHROTTLE_INSPECT
test "$(git config --get remote.origin.pushurl)" = DISABLED_BY_OPENTHROTTLE_INSPECT
grep -qx base work.txt
test ! -e source-link
git status --short >/dev/null
git show --no-patch --format=%s HEAD >/dev/null
git diff --quiet
if printf 'forbidden\n' > work.txt 2>/dev/null; then
  echo "Codex inspect repository was writable" >&2
  exit 44
fi
if git config remote.origin.url https://example.invalid/repository 2>/dev/null; then
  echo "Codex inspect changed executor-owned Git configuration" >&2
  exit 45
fi
if git update-ref refs/heads/forbidden HEAD 2>/dev/null; then
  echo "Codex inspect changed executor-owned Git refs" >&2
  exit 46
fi
temporary="/tmp/openthrottle-codex-inspect-${OT_ATTEMPT_ID}"
printf 'writable\n' > "$temporary"
grep -qx writable "$temporary"

mkdir -p /tmp/openthrottle-smoke-launches
printf 'launch\n' >> "/tmp/openthrottle-smoke-launches/${OT_ATTEMPT_ID}"
node --input-type=module - "$OT_ATTEMPT_ID" <<'NODE'
const [attemptId] = process.argv.slice(2);
const candidate = {
  schema: "openthrottle.result-candidate/v1",
  outcome: "success",
  payload: {
    summary: ["Inspected repository.", "No mutation was possible."],
    verification: ["Codex argv and executor boundary assertions passed"],
  },
};
process.stdout.write(`${JSON.stringify({
  type: "thread.started",
  thread_id: `session-${attemptId}`,
})}\n`);
process.stdout.write(`${JSON.stringify({
  type: "item.completed",
  item: { type: "agent_message", text: JSON.stringify(candidate) },
})}\n`);
NODE
STUB
chmod 0755 "$SMOKE_DIR/stub/codex"

docker run --rm --entrypoint sh "$IMAGE" -ec '
  test "$(codex --version)" = "codex-cli 0.149.0"
  gosu agent env HOME=/home/agent CODEX_HOME=/home/agent/.codex \
    codex --ask-for-approval never exec \
      --sandbox danger-full-access \
      --ephemeral \
      --ignore-user-config \
      --ignore-rules \
      -c '\''web_search="disabled"'\'' \
      --disable apps \
      --disable browser_use \
      --disable in_app_browser \
      --disable multi_agent \
      --disable plugins \
      --disable remote_plugin \
      --disable image_generation \
      --help >/dev/null
'

mkdir -p "$SMOKE_DIR/poison"
cat > "$SMOKE_DIR/poison/claude" <<'POISON'
#!/usr/bin/env bash
printf 'redispatched\n' > /tmp/openthrottle-smoke-redispatched
exit 99
POISON
chmod 0755 "$SMOKE_DIR/poison/claude"

CONTAINER="$(docker run -d --entrypoint tail "$IMAGE" -f /dev/null)"
docker exec "$CONTAINER" mkdir -p /var/lib/openthrottle/repository-source/repo /requests /transport/edit /transport/inspect /transport/inspect-codex /transport/command /runtime/fences /tmp/stub /tmp/poison
docker cp "$SOURCE_REPO/." "$CONTAINER:/var/lib/openthrottle/repository-source/repo/"
docker cp "$REQUESTS/." "$CONTAINER:/requests/"
docker cp "$SMOKE_DIR/stub/." "$CONTAINER:/tmp/stub/"
docker cp "$SMOKE_DIR/poison/." "$CONTAINER:/tmp/poison/"
docker exec "$CONTAINER" sh -c 'touch /tmp/source-link-target && chown agent:agent /tmp/source-link-target && chmod 0660 /tmp/source-link-target && ln -s /tmp/source-link-target /var/lib/openthrottle/repository-source/repo/source-link'
docker exec "$CONTAINER" sh -c '
  find -P /var/lib/openthrottle/repository-source/repo -exec chown -h root:root -- {} +
  find -P /var/lib/openthrottle/repository-source/repo ! -type l -exec chmod go-w -- {} +
  chown root:root /var/lib/openthrottle/repository-source
  chmod 0700 /var/lib/openthrottle/repository-source
  chown -R root:root /requests /tmp/stub /tmp/poison
  chmod 0400 /requests/*.json
  chmod 0755 /tmp/stub/claude /tmp/stub/codex /tmp/poison/claude
'
for name in edit inspect inspect-codex command; do
  docker exec "$CONTAINER" sh -c '
    printf '\''{"schema":"openthrottle.kernel-lease-generation-fence/v1","attempt_id":"%s","lease_generation":0}\n'\'' "$1" > "$2"
    : > "$3"
    chown root:root "$2" "$3"
    chmod 0444 "$2" "$3"
  ' _ "attempt-${name}" "/runtime/fences/${name}.json" "/runtime/fences/${name}.lock"
done

run_action() {
  local name="$1" stub_path="${2:-/tmp/stub}"
  docker exec \
    -e "PATH=${stub_path}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    -e "OT_ACTION_REQUEST_FILE=/requests/${name}.json" \
    -e "OT_ACTION_RESULT_FILE=/transport/${name}/result.json" \
    -e "OT_ACTION_SESSION_FILE=/transport/${name}/session.json" \
    -e "OT_LEASE_GENERATION_FENCE_FILE=/runtime/fences/${name}.json" \
    -e "OT_LEASE_GENERATION_LOCK_FILE=/runtime/fences/${name}.lock" \
    -e "GITHUB_TOKEN=ambient-github-token" \
    -e "GH_TOKEN=ambient-gh-token" \
    -e "LINEAR_API_KEY=ambient-linear-key" \
    -e "DAYTONA_API_KEY=ambient-daytona-key" \
    -e "FLY_API_TOKEN=ambient-fly-token" \
    -e "GIT_ASKPASS=/tmp/ambient-git-askpass" \
    -e "GIT_SSH_COMMAND=ssh -i /tmp/ambient-git-key" \
    -e "SSH_ASKPASS=/tmp/ambient-ssh-askpass" \
    "$CONTAINER" /opt/openthrottle/entrypoint.sh
}

# A traversable executor-source parent must fail before the runner can create
# any session or result evidence. Use otherwise-valid sealed inputs so the
# physical repository fence is the only failing precondition.
docker exec "$CONTAINER" sh -c '
  cp /requests/edit.json /requests/invalid-source.json
  cp /runtime/fences/edit.json /runtime/fences/invalid-source.json
  cp /runtime/fences/edit.lock /runtime/fences/invalid-source.lock
  mkdir -p /transport/invalid-source
  chmod 0755 /var/lib/openthrottle/repository-source
'
INVALID_SOURCE_LOG="$SMOKE_DIR/invalid-source.log"
if run_action invalid-source >"$INVALID_SOURCE_LOG" 2>&1; then
  echo "entrypoint accepted a traversable repository-source parent" >&2
  exit 42
fi
grep -F 'repository source parent must be root:root mode 0700' "$INVALID_SOURCE_LOG" >/dev/null
docker exec "$CONTAINER" test ! -e /transport/invalid-source/session.json
docker exec "$CONTAINER" test ! -e /transport/invalid-source/result.json
docker exec "$CONTAINER" chmod 0700 /var/lib/openthrottle/repository-source

# Daytona sessions inherit persistent sandbox environment; reject mixed
# request families instead of selecting an executor.
MIXED_REQUEST_LOG="$SMOKE_DIR/mixed-request-family.log"
if docker exec \
  -e "OT_ACTION_REQUEST_FILE=/requests/edit.json" \
  -e "OT_ACTION_RESULT_FILE=/transport/edit/result.json" \
  -e "OT_ACTION_SESSION_FILE=/transport/edit/session.json" \
  -e "OT_INTEGRATION_REQUEST_FILE=/requests/stale-integration.json" \
  -e "OT_INTEGRATION_RESULT_FILE=/transport/stale-integration/result.json" \
  "$CONTAINER" /opt/openthrottle/entrypoint.sh >"$MIXED_REQUEST_LOG" 2>&1; then
  echo "entrypoint accepted mixed action and integration request families" >&2
  exit 47
fi
grep -F 'action and integration request families are mutually exclusive' "$MIXED_REQUEST_LOG" >/dev/null
docker exec "$CONTAINER" test ! -e /transport/edit/result.json
docker exec "$CONTAINER" test ! -e /transport/edit/session.json

run_action edit
[ "$(docker exec "$CONTAINER" stat -c %U:%G:%a /var/lib/openthrottle/repository-source)" = "root:root:700" ]
[ -z "$(docker exec "$CONTAINER" find -P /var/lib/openthrottle/repository-source/repo \( ! -user root -o ! -group root \) -print -quit)" ]
[ -z "$(docker exec "$CONTAINER" find -P /var/lib/openthrottle/repository-source/repo ! -type l -perm /0222 -print -quit)" ]
docker exec "$CONTAINER" test -x /var/lib/openthrottle/repository-source/repo/tool.sh
[ "$(docker exec "$CONTAINER" stat -c %U /tmp/source-link-target)" = "agent" ]
[ "$(docker exec "$CONTAINER" stat -c %a /tmp/source-link-target)" = "660" ]
[ "$(docker exec "$CONTAINER" cat /var/lib/openthrottle/repository-source/repo/work.txt)" = "base" ]
EDIT_RESULT="$(docker exec "$CONTAINER" cat /transport/edit/result.json)"
printf '%s' "$EDIT_RESULT" | jq -e '
  .schema == "openthrottle.kernel-runtime-result/v1" and
  .outcome.state == "work_complete" and
  .outcome.result.candidate.candidate.payload.summary == "Edited repository.\nVerification passed." and
  .outcome.result.candidate.transformations[0].id == "string-array-to-newlines/v1" and
  .outcome.checkpoint.output_subject == .outcome.checkpoint.payload_artifact.commit and
  .outcome.checkpoint.payload_artifact.commit != .outcome.checkpoint.payload_artifact.tree
' >/dev/null
printf '%s' "$(docker exec "$CONTAINER" cat /transport/edit/session.json)" | jq -e '
  .schema == "openthrottle.kernel-session-event/v1" and
  .attempt_id == "attempt-edit" and .native_session_id == "session-attempt-edit"
' >/dev/null

EDIT_FILE="$(printf '%s' "$EDIT_RESULT" | jq -r '.outcome.checkpoint.payload_artifact.file')"
EDIT_REF="$(printf '%s' "$EDIT_RESULT" | jq -r '.outcome.checkpoint.payload_artifact.ref')"
EDIT_COMMIT="$(printf '%s' "$EDIT_RESULT" | jq -r '.outcome.checkpoint.payload_artifact.commit')"
EDIT_TREE="$(printf '%s' "$EDIT_RESULT" | jq -r '.outcome.checkpoint.payload_artifact.tree')"
docker exec "$CONTAINER" git -C /var/lib/openthrottle/repository-source/repo bundle verify "/transport/edit/$EDIT_FILE" >/dev/null
docker exec "$CONTAINER" git init -q --bare /tmp/restored-checkpoint.git
docker exec "$CONTAINER" git -C /tmp/restored-checkpoint.git fetch -q "/transport/edit/$EDIT_FILE" "$EDIT_REF:refs/checkpoint"
[ "$(docker exec "$CONTAINER" git -C /tmp/restored-checkpoint.git rev-parse refs/checkpoint)" = "$EDIT_COMMIT" ]
[ "$(docker exec "$CONTAINER" git -C /tmp/restored-checkpoint.git rev-parse 'refs/checkpoint^{tree}')" = "$EDIT_TREE" ]

# Immutable result evidence makes a lost acknowledgement safe: even a poison
# engine on replay must never be launched.
run_action edit /tmp/poison
[ "$(docker exec "$CONTAINER" awk 'END { print NR }' /tmp/openthrottle-smoke-launches/attempt-edit)" = "1" ]
docker exec "$CONTAINER" test ! -e /tmp/openthrottle-smoke-redispatched

run_action inspect
INSPECT_RESULT="$(docker exec "$CONTAINER" cat /transport/inspect/result.json)"
printf '%s' "$INSPECT_RESULT" | jq -e '
  .outcome.state == "work_complete" and
  .outcome.result.candidate.candidate.payload.summary == "Inspected repository.\nNo mutation was possible." and
  .outcome.checkpoint.output_subject == null
' >/dev/null
[ "$(git -C "$SOURCE_REPO" show HEAD:work.txt)" = "base" ]

run_action inspect-codex
CODEX_INSPECT_RESULT="$(docker exec "$CONTAINER" cat /transport/inspect-codex/result.json)"
printf '%s' "$CODEX_INSPECT_RESULT" | jq -e '
  .outcome.state == "work_complete" and
  .outcome.result.candidate.candidate.payload.summary == "Inspected repository.\nNo mutation was possible." and
  .outcome.checkpoint.output_subject == null
' >/dev/null
[ "$(git -C "$SOURCE_REPO" show HEAD:work.txt)" = "base" ]

run_action command
COMMAND_RESULT="$(docker exec "$CONTAINER" cat /transport/command/result.json)"
printf '%s' "$COMMAND_RESULT" | jq -e '
  .outcome.state == "work_complete" and
  .outcome.result.kind == "command" and
  .outcome.result.outcome == "success" and
  .outcome.result.command_id == "git-metadata" and
  .outcome.checkpoint.output_subject == null
' >/dev/null

for removed in execute-stage.mjs execute-loop.mjs execute-child-action.mjs; do
  docker exec "$CONTAINER" test ! -e "/opt/openthrottle/runner/$removed"
done
docker exec "$CONTAINER" test ! -e /usr/local/bin/ot-stage-result
docker exec "$CONTAINER" test ! -e /usr/local/bin/ot-subject-post

echo "sandbox kernel smoke passed"
