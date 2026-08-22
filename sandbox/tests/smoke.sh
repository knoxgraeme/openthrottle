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
    summary: { type: "string", required: true, max_length: 4000, normalize: "string-array-to-newlines/v1" },
    verification: { type: "string_list", required: true, max_length: 1000, max_items: 32 },
  },
};
const request = (attempt, authority, requestHash) => ({
  schema: "openthrottle.kernel-action-request/v2",
  phase: "work",
  pipeline_run_id: "smoke-run",
  attempt_id: attempt,
  stage_id: authority === "edit" ? "implement" : "review",
  scope: { kind: "stage", stage_id: authority === "edit" ? "implement" : "review" },
  request_hash: requestHash,
  definition_bundle_hash: "b".repeat(64),
  input_subject: subject,
  repository_authority: authority,
  lease_id: `lease-${attempt}`,
  worker_id: "smoke-worker",
  task_prompt: authority === "edit" ? "Update work.txt." : "Inspect work.txt without changing it.",
  context: { records: [], checkpoints: [] },
  runtime_resource: null,
  change_boundary: null,
  action: {
    kind: "agent",
    engine: "claude",
    model: null,
    reasoning_effort: null,
    agent_id: "core/smoke-agent",
    skill_ids: ["core/implement-plan"],
    entry_skill: "core/implement-plan",
    eval_id: semantic.id,
    semantic_result_schema: semantic,
    execution_limits: { max_turns: 12, task_timeout_seconds: 600 },
    definition_entries: [
      { definition_kind: "agent", definition_id: "core/smoke-agent", content_hash: digest(instructions), normalized_payload: instructions },
      { definition_kind: "skill", definition_id: "core/implement-plan", content_hash: digest(skill), normalized_payload: skill },
    ],
  },
  executor_policy: { git_administration: "executor_only", commit: false, push: false, publish: false },
});
writeFileSync(join(output, "edit.json"), `${JSON.stringify(request("attempt-edit", "edit", "a".repeat(64)))}\n`);
writeFileSync(join(output, "inspect.json"), `${JSON.stringify(request("attempt-inspect", "inspect", "c".repeat(64)))}\n`);
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

mkdir -p "$SMOKE_DIR/poison"
cat > "$SMOKE_DIR/poison/claude" <<'POISON'
#!/usr/bin/env bash
printf 'redispatched\n' > /tmp/openthrottle-smoke-redispatched
exit 99
POISON
chmod 0755 "$SMOKE_DIR/poison/claude"

CONTAINER="$(docker run -d --entrypoint tail "$IMAGE" -f /dev/null)"
docker exec "$CONTAINER" mkdir -p /var/lib/openthrottle/repository-source/repo /requests /transport/edit /transport/inspect /runtime/fences /tmp/stub /tmp/poison
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
  chmod 0755 /tmp/stub/claude /tmp/poison/claude
'
for name in edit inspect; do
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

for removed in execute-stage.mjs execute-loop.mjs execute-child-action.mjs; do
  docker exec "$CONTAINER" test ! -e "/opt/openthrottle/runner/$removed"
done
docker exec "$CONTAINER" test ! -e /usr/local/bin/ot-stage-result
docker exec "$CONTAINER" test ! -e /usr/local/bin/ot-subject-post

echo "sandbox kernel smoke passed"
