#!/usr/bin/env bash
set -euo pipefail

ROOT="$(mktemp -d)"
chmod 0711 "$ROOT"
cleanup() {
  chmod -R u+rwX "$ROOT" >/dev/null 2>&1 || true
  rm -rf "$ROOT"
}
trap cleanup EXIT

INTEGRATION="$ROOT/integration"
WORKTREES="$ROOT/worktrees"
ACTION_ROOT="$ROOT/loop-actions"
BIN="$ROOT/bin"
REQUEST="$ACTION_ROOT/attempt-current/action-current/request.json"
RESULT="$ACTION_ROOT/attempt-current/action-current/result.json"
SEALED="$ROOT/sealed-input.txt"

install -d -o agent -g agent -m 0700 "$INTEGRATION"
install -d -o root -g root -m 0711 "$WORKTREES" "$ACTION_ROOT"
install -d -m 0755 "$BIN"

gosu agent git -C "$INTEGRATION" init -q -b main
gosu agent git -C "$INTEGRATION" config user.email probe@openthrottle.dev
gosu agent git -C "$INTEGRATION" config user.name "OpenThrottle Probe"
gosu agent git -C "$INTEGRATION" config gc.auto 0
gosu agent sh -c "printf 'integration-owned\n' > '$INTEGRATION/file.txt'"
gosu agent mkdir -p "$INTEGRATION/.agents/skills/current"
gosu agent sh -c "cat > '$INTEGRATION/.agents/skills/current/SKILL.md' <<'SKILL'
---
name: repo_action
description: Probe repository skill
---

Probe repository skill from the pinned package.
SKILL"
gosu agent git -C "$INTEGRATION" add file.txt
gosu agent git -C "$INTEGRATION" add .agents/skills/current/SKILL.md
gosu agent git -C "$INTEGRATION" commit -q -m "seed integration"
BASE="$(gosu agent git -C "$INTEGRATION" rev-parse HEAD)"
SIBLING_ONLY_BLOB="$(gosu agent sh -c "printf 'sibling object secret\n' | git -C '$INTEGRATION' hash-object -w --stdin")"

/opt/openthrottle/runner/worktrees.mjs create --repo "$INTEGRATION" --root "$WORKTREES" --handle current --base "$BASE" >/dev/null
/opt/openthrottle/runner/worktrees.mjs create --repo "$INTEGRATION" --root "$WORKTREES" --handle sibling --base "$BASE" >/dev/null

install -d -o root -g root -m 0711 "$ACTION_ROOT/attempt-current"
install -d -o root -g root -m 0700 "$ACTION_ROOT/attempt-current/action-current"
install -d -o agent -g agent -m 0700 "$ACTION_ROOT/attempt-current/action-sibling"
install -d -o agent -g agent -m 0700 "$ACTION_ROOT/attempt-prior/action-current"
printf 'sibling secret\n' > "$ACTION_ROOT/attempt-current/action-sibling/secret.txt"
printf 'prior secret\n' > "$ACTION_ROOT/attempt-prior/action-current/secret.txt"
chown -R agent:agent "$ACTION_ROOT/attempt-current/action-sibling" "$ACTION_ROOT/attempt-prior"
printf 'sealed secret\n' > "$SEALED"
chown root:root "$SEALED"
chmod 0400 "$SEALED"

mkdir -p "$INTEGRATION/.git/objects/info"
printf 'alternate secret\n' > "$INTEGRATION/.git/objects/info/alternates.probe"
chown root:root "$INTEGRATION/.git/objects/info" "$INTEGRATION/.git/objects/info/alternates.probe"
chmod 0500 "$INTEGRATION/.git/objects/info"
chmod 0400 "$INTEGRATION/.git/objects/info/alternates.probe"

ln -s "$INTEGRATION/file.txt" "$WORKTREES/current/integration-link"

cat > "$BIN/codex" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

must_fail() {
  if "$@" >/dev/null 2>&1; then
    echo "unexpected access succeeded: $*" >&2
    exit 41
  fi
}

test "$(id -un)" = "agent"
test -r "$CODEX_HOME/skills/repo_action/SKILL.md"
grep -q "pinned package" "$CODEX_HOME/skills/repo_action/SKILL.md"
git status --porcelain=v1 --untracked-files=all >/tmp/ot-probe-git-status
node /opt/openthrottle/runner/execute-stage.mjs --print-subject --repo "$PWD" >/tmp/ot-probe-subject
printf 'worker write\n' > "$PWD/worker-write.txt"
must_fail git add worker-write.txt
must_fail git commit -m "agent direct commit"
must_fail git update-ref refs/heads/agent-direct HEAD
must_fail sh -c "printf bad >> '$PROBE_INTEGRATION/file.txt'"
must_fail cat "$PROBE_INTEGRATION/file.txt"
must_fail cat "$PWD/integration-link"
must_fail cat "$PROBE_SEALED_INPUT"
must_fail cat "$PROBE_SIBLING_WORKTREE/file.txt"
must_fail sh -c "printf bad > '$PROBE_SIBLING_WORKTREE/bad.txt'"
must_fail git cat-file -p "$PROBE_SIBLING_ONLY_BLOB"
must_fail cat "$PROBE_INTEGRATION/.git/objects/${PROBE_SIBLING_ONLY_BLOB:0:2}/${PROBE_SIBLING_ONLY_BLOB:2}"
must_fail cat "$PROBE_SIBLING_ACTION_SECRET"
must_fail cat "$PROBE_PRIOR_ACTION_SECRET"
must_fail cat "$PROBE_INTEGRATION/.git/objects/info/alternates.probe"
must_fail sh -c "printf bad >> '$PROBE_INTEGRATION/.git/objects/info/alternates.probe'"
test ! -w /opt/openthrottle/safety/pre-push
printf '{"probe":"ok"}\n'
STUB
chmod 0755 "$BIN/codex"

PATH="$BIN:$PATH" node --input-type=module - "$REQUEST" "$INTEGRATION" <<'NODE'
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "/opt/openthrottle/runner/capabilities.mjs";
import { digest } from "/opt/openthrottle/runner/artifacts.mjs";
import { createLoopRequestHash } from "/opt/openthrottle/runner/execute-loop.mjs";

const requestPath = process.argv[2];
const repoDir = process.argv[3];
const skillPath = ".agents/skills/current/SKILL.md";
function git(args) {
  return execFileSync("git", ["-c", `safe.directory=${repoDir}`, "-C", repoDir, ...args], { encoding: "utf8" }).trim();
}
const head = git(["rev-parse", "HEAD"]);
const blobSha = git(["rev-parse", `${head}:${skillPath}`]);
const unsignedPackage = {
  schema: "openthrottle.repository-skill-package/v1",
  reference: `repo://owner/repo@${head}#.agents/skills/current`,
  invocation: "repo_action",
  directory: ".agents/skills/current",
  commit: head,
  files: [{
    path: skillPath,
    blobSha,
    digest: digest(readFileSync(`${repoDir}/${skillPath}`)),
  }],
};
const repositorySkill = { ...unsignedPackage, packageDigest: digest(canonicalJson(unsignedPackage)) };
const base = {
  protocol: "loop-action@1",
  actionId: "action-current",
  attemptId: "attempt-current",
  graphId: "graph-1",
  unitId: "unit-1",
  role: "worker",
  loop: "implement",
  agent: "codex",
  skill: repositorySkill.invocation,
  worktree: { id: "current" },
  nativeSessionId: null,
  contextPolicy: "fresh",
  timeoutMs: 120000,
  transitionContext: "Probe worktree isolation.",
  allowedMcpServers: [],
  credentialScopes: [],
  receiptSchema: "probe/no-receipt@1",
  repositorySkill,
};
mkdirSync(dirname(requestPath), { recursive: true, mode: 0o700 });
writeFileSync(requestPath, canonicalJson({ ...base, ...createLoopRequestHash(base) }), { mode: 0o400 });
NODE
chown root:root "$REQUEST"
chmod 0400 "$REQUEST"

PATH="$BIN:$PATH" \
OT_LOOP_ACTION_ROOT="$ACTION_ROOT" \
OT_WORKTREE_ROOT="$WORKTREES" \
PROBE_INTEGRATION="$INTEGRATION" \
PROBE_SEALED_INPUT="$SEALED" \
PROBE_SIBLING_WORKTREE="$WORKTREES/sibling" \
PROBE_SIBLING_ONLY_BLOB="$SIBLING_ONLY_BLOB" \
PROBE_SIBLING_ACTION_SECRET="$ACTION_ROOT/attempt-current/action-sibling/secret.txt" \
PROBE_PRIOR_ACTION_SECRET="$ACTION_ROOT/attempt-prior/action-current/secret.txt" \
/opt/openthrottle/runner/execute-loop.mjs --request "$REQUEST" --output "$RESULT"

node --input-type=module - "$RESULT" <<'NODE'
import { readFileSync } from "node:fs";
const result = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (result.kind !== "loop_action_result" ||
    result.attempt_id !== "attempt-current" ||
    result.action_id !== "action-current" ||
    result.outcome !== "success" ||
    !/^[a-f0-9]{40}$/.test(result.subject)) {
  throw new Error(`invalid probe result: ${JSON.stringify(result)}`);
}
NODE

gosu agent test ! -w "$WORKTREES/current"
gosu agent test ! -r "$ACTION_ROOT/attempt-current/action-current/request.json"
gosu agent test ! -r "$ACTION_ROOT/attempt-current/action-sibling/secret.txt"
gosu agent test ! -r "$ACTION_ROOT/attempt-prior/action-current/secret.txt"

CANDIDATE_JSON="$(/opt/openthrottle/runner/worktrees.mjs candidate --repo "$INTEGRATION" --root "$WORKTREES" --handle current --base "$BASE" --message "candidate from executor")"
CANDIDATE="$(printf '%s' "$CANDIDATE_JSON" | jq -r '.candidateCommit')"
test "$CANDIDATE" != "null"
/opt/openthrottle/runner/integrate-unit.mjs --repo "$INTEGRATION" --expected-head "$BASE" --candidate "$CANDIDATE" >/tmp/ot-probe-integration.json
jq -e --arg candidate "$CANDIDATE" '.candidate_commit == $candidate and .integrated == true' /tmp/ot-probe-integration.json >/dev/null
INTEGRATED_HEAD="$(git -c "safe.directory=$INTEGRATION" -C "$INTEGRATION" rev-parse HEAD)"
test "$INTEGRATED_HEAD" = "$CANDIDATE"
/opt/openthrottle/runner/worktrees.mjs create --repo "$INTEGRATION" --root "$WORKTREES" --handle after-loop --base "$INTEGRATED_HEAD" >/dev/null

echo "sandbox linked-worktree ownership isolation probe passed"
