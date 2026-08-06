#!/usr/bin/env bash
set -euo pipefail

ROOT="$(mktemp -d)"
chmod 0711 "$ROOT"
cleanup() {
  if [ -s "${ROOT_HELPER_PID_FILE:-}" ]; then
    kill "$(cat "$ROOT_HELPER_PID_FILE")" >/dev/null 2>&1 || true
  fi
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
LEAD_REQUEST="$ACTION_ROOT/attempt-current/action-lead/request.json"
LEAD_RESULT="$ACTION_ROOT/attempt-current/action-lead/result.json"
REVIEWER_REQUEST="$ACTION_ROOT/attempt-current/action-reviewer/request.json"
REVIEWER_RESULT="$ACTION_ROOT/attempt-current/action-reviewer/result.json"
BUILTIN_REQUEST="$ACTION_ROOT/attempt-current/action-builtin/request.json"
BUILTIN_RESULT="$ACTION_ROOT/attempt-current/action-builtin/result.json"
SEALED="$ROOT/sealed-input.txt"
ROOT_HELPER_SENTINEL="$ROOT/root-helper-sentinel.txt"
ROOT_HELPER_PID_FILE="$ROOT/root-helper.pid"
BACKGROUND_PID="$ACTION_ROOT/attempt-current/action-current/home/background.pid"
NATIVE_SESSION_ROOT="/var/lib/openthrottle/native-sessions"
export OT_NATIVE_SESSION_SOURCE_ROOT="$NATIVE_SESSION_ROOT"
PERSISTENT_CLAUDE_SECRET="/home/agent/.claude/ot-persistent-probe-secret.txt"
PERSISTENT_CODEX_SECRET="/home/agent/.codex/ot-persistent-probe-secret.txt"
PERSISTENT_OPENCODE_ROOT="/home/agent/.local/share/opencode"
PERSISTENT_OPENCODE_SECRET="$PERSISTENT_OPENCODE_ROOT/ot-persistent-probe-secret.txt"
PERSISTENT_OT_SECRET="/home/agent/.ot/ot-persistent-probe-secret.txt"
PROFILE_REPLACEMENT_TARGET="$ACTION_ROOT/attempt-current/profile-replacement-target"
# RU6 replaces (not merges) the loop-action child env, so PROBE_* test
# coordination variables no longer reach the agent stub via inheritance. Seal
# each invocation's PROBE_* values into this fixed, world-readable file that
# the stub sources for itself instead -- the same pattern this script already
# uses for other cross-process probe artifacts (/tmp/ot-probe-*).
PROBE_ENV_FILE="/tmp/ot-probe-env.sh"
write_probe_env() {
  : > "$PROBE_ENV_FILE"
  while [ "$#" -ge 2 ]; do
    printf 'export %s=%q\n' "$1" "$2" >> "$PROBE_ENV_FILE"
    shift 2
  done
  chmod 0644 "$PROBE_ENV_FILE"
}

install -d -o agent -g agent -m 0700 "$INTEGRATION"
install -d -o root -g root -m 0711 "$WORKTREES"
install -d -o root -g root -m 0700 "$ACTION_ROOT"
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

install -d -o root -g root -m 0700 "$ACTION_ROOT/attempt-current"
install -d -o root -g root -m 0700 "$ACTION_ROOT/attempt-current/action-current"
install -d -o agent -g agent -m 0700 "$ACTION_ROOT/attempt-current/action-sibling"
install -d -o agent -g agent -m 0700 "$ACTION_ROOT/attempt-prior/action-current"
install -d -o agent -g agent -m 0700 "$ACTION_ROOT/attempt-prior/action-home/home"
printf 'sibling secret\n' > "$ACTION_ROOT/attempt-current/action-sibling/secret.txt"
printf 'prior secret\n' > "$ACTION_ROOT/attempt-prior/action-current/secret.txt"
printf 'prior home secret\n' > "$ACTION_ROOT/attempt-prior/action-home/home/native-session.json"
chown -R agent:agent "$ACTION_ROOT/attempt-current/action-sibling" "$ACTION_ROOT/attempt-prior"
printf 'sealed secret\n' > "$SEALED"
chown root:root "$SEALED"
chmod 0400 "$SEALED"
printf 'root helper fd sentinel\n' > "$ROOT_HELPER_SENTINEL"
chown root:root "$ROOT_HELPER_SENTINEL"
chmod 0400 "$ROOT_HELPER_SENTINEL"
env PROBE_ROOT_HELPER_ENV_SENTINEL="root-helper-env-sentinel" \
  sh -c 'exec 3< "$1"; printf "%s\n" "$$" > "$2"; while :; do sleep 30; done' \
  sh "$ROOT_HELPER_SENTINEL" "$ROOT_HELPER_PID_FILE" &
while [ ! -s "$ROOT_HELPER_PID_FILE" ]; do sleep 0.1; done
install -d -o root -g root -m 0700 "$NATIVE_SESSION_ROOT"
OT_NATIVE_SESSION_SOURCE_ROOT="$NATIVE_SESSION_ROOT" node --input-type=module <<'NODE'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeNativeSessionState,
  nativeSessionStoragePath,
  sealNativeSessionPackage,
} from "/opt/openthrottle/runner/native-session-package.mjs";

function sessionRecord(agent, nativeSessionId) {
  if (agent === "claude") return `{"type":"user","sessionId":"${nativeSessionId}","message":{"role":"user","content":"x"}}\n`;
  if (agent === "codex") return `{"type":"session_meta","payload":{"id":"${nativeSessionId}"}}\n`;
  if (agent === "opencode") return `{"type":"step_start","sessionID":"${nativeSessionId}"}\n`;
  throw new Error(`unsupported agent ${agent}`);
}

function writeSessionFile({ agent, nativeSessionId, contents = sessionRecord(agent, nativeSessionId), fileName = `${nativeSessionId}.jsonl` }) {
  const profileRoot = mkdtempSync(join(tmpdir(), `ot-native-${agent}-${nativeSessionId}-`));
  const sessionStore = nativeSessionStoragePath(agent, profileRoot);
  mkdirSync(sessionStore, { recursive: true });
  writeFileSync(join(sessionStore, fileName), contents);
  return { profileRoot, sessionStore, fileName, contents };
}

function sealFixture(agent, nativeSessionId) {
  const fixture = writeSessionFile({ agent, nativeSessionId });
  sealNativeSessionPackage({ agent, nativeSessionId, profileRoot: fixture.profileRoot });
  return fixture;
}

function assertMaterializesOnlySelectedPackage(agent) {
  const currentId = `native-${agent}`;
  const siblingId = `native-${agent}-sibling`;
  const current = sealFixture(agent, currentId);
  sealFixture(agent, siblingId);
  const profileRoot = mkdtempSync(join(tmpdir(), `ot-materialized-${agent}-`));
  materializeNativeSessionState({
    request: { agent, nativeSessionId: currentId, contextPolicy: "resume_required" },
    profileRoot,
  });
  const sessionStore = nativeSessionStoragePath(agent, profileRoot);
  if (readFileSync(join(sessionStore, current.fileName), "utf8") !== current.contents) {
    throw new Error(`${agent} canonical native session did not materialize`);
  }
  if (existsSync(join(sessionStore, `${siblingId}.jsonl`))) {
    throw new Error(`${agent} sibling native session package materialized`);
  }
}

function expectSealRejects(agent, nativeSessionId, contents, label) {
  const fixture = writeSessionFile({ agent, nativeSessionId, contents });
  let rejected = false;
  try {
    sealNativeSessionPackage({ agent, nativeSessionId, profileRoot: fixture.profileRoot });
  } catch (error) {
    if (!/does not contain the reported native session id/.test(error.message)) throw error;
    rejected = true;
  }
  if (!rejected) throw new Error(`${label} native session fixture was accepted`);
}

for (const agent of ["claude", "codex", "opencode"]) {
  assertMaterializesOnlySelectedPackage(agent);
  expectSealRejects(agent, `native-${agent}-generic`, `generic native-${agent}-generic\n`, `${agent} generic exact-named`);
  expectSealRejects(agent, `native-${agent}-substring`, sessionRecord(agent, `prefix-native-${agent}-substring-suffix`), `${agent} substring`);
  expectSealRejects(agent, `native-${agent}-empty`, "", `${agent} empty`);
  expectSealRejects(agent, `native-${agent}-unrelated`, sessionRecord(agent, `native-${agent}-other`), `${agent} unrelated`);
}

expectSealRejects(
  "codex",
  "native-codex-output",
  '{"type":"thread.started","thread_id":"native-codex-output"}\n',
  "codex output-event"
);

sealFixture("codex", "native-current");
sealFixture("codex", "native-sibling");
NODE
install -d -o agent -g agent -m 0700 /home/agent/.claude /home/agent/.codex "$PERSISTENT_OPENCODE_ROOT" /home/agent/.ot
install -d -o agent -g agent -m 0700 "$PROFILE_REPLACEMENT_TARGET"
printf 'persistent claude secret\n' > "$PERSISTENT_CLAUDE_SECRET"
printf 'persistent codex secret\n' > "$PERSISTENT_CODEX_SECRET"
printf 'persistent opencode secret\n' > "$PERSISTENT_OPENCODE_SECRET"
printf 'persistent ot secret\n' > "$PERSISTENT_OT_SECRET"
chown agent:agent "$PERSISTENT_CLAUDE_SECRET" "$PERSISTENT_CODEX_SECRET" "$PERSISTENT_OPENCODE_SECRET" "$PERSISTENT_OT_SECRET"
chmod 0600 "$PERSISTENT_CLAUDE_SECRET" "$PERSISTENT_CODEX_SECRET" "$PERSISTENT_OPENCODE_SECRET" "$PERSISTENT_OT_SECRET"

mkdir -p "$INTEGRATION/.git/objects/info"
{
  printf '# pack-refs with: peeled fully-peeled sorted\n'
  printf '%s refs/tags/packed-probe\n' "$BASE"
} > "$INTEGRATION/.git/packed-refs"
printf 'alternate secret\n' > "$INTEGRATION/.git/objects/info/alternates.probe"
chown root:root "$INTEGRATION/.git/objects/info" "$INTEGRATION/.git/objects/info/alternates.probe" "$INTEGRATION/.git/packed-refs"
chmod 0500 "$INTEGRATION/.git/objects/info"
chmod 0400 "$INTEGRATION/.git/objects/info/alternates.probe"
chmod 0400 "$INTEGRATION/.git/packed-refs"

ln -s "$INTEGRATION/file.txt" "$WORKTREES/current/integration-link"

cat > "$BIN/codex" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

# RU6's action-scoped child env no longer carries this script's own
# inherited environment, so the outer probe seals this invocation's PROBE_*
# coordination variables here instead of relying on inheritance.
. /tmp/ot-probe-env.sh

must_fail() {
  if "$@" >/dev/null 2>&1; then
    echo "unexpected access succeeded: $*" >&2
    exit 41
  fi
}

emit_receipt() {
  node --input-type=module - "$2" <<'NODE'
const subject = process.argv[2];
const producerSkill = process.env.PROBE_RECEIPT_SKILL;
let type = "unit_completion";
let result = "success";
let payload = {
  summary: "Built-image isolation probe passed.",
  assumptions: [],
  decisions: [],
  issues: [],
  verification: ["sandbox/tests/worktree-isolation-probe.sh"],
  downstream_context: [],
  requested_human_input: [],
};
if (producerSkill === "builtin://accept-unit@1") {
  type = "unit_decision";
  result = "accept";
  payload = {
    rationale: "Built-image isolation probe accepted the candidate.",
    context_updates: [],
    accepted_subject: subject,
  };
} else if (producerSkill === "builtin://final-review@1") {
  type = "semantic_review";
  payload = {
    summary: "Built-image isolation probe review passed.",
    findings: [],
  };
}
const receipt = {
  schema: "openthrottle.receipt/v1",
  type,
  assurance: "semantic_attested",
  result,
  producer: {
    worker_id: "probe",
    skill: producerSkill,
    capability_digest: "1".repeat(64),
    // Repository-skill producers pin their exact package digest; builtin
    // producers have no repository package, so the contract requires null.
    skill_package_digest: producerSkill.startsWith("repo://") ? "3".repeat(64) : null,
  },
  subject: {
    base: subject,
    pre: subject,
    post: subject,
  },
  fence: {
    pipeline_instance_id: "probe-instance",
    graph_digest: "2".repeat(64),
    unit_id: process.env.PROBE_RECEIPT_UNIT_ID,
    attempt_id: process.env.PROBE_RECEIPT_ATTEMPT_ID,
    parent_run_id: process.env.PROBE_RECEIPT_PARENT_RUN_ID,
    action_attempt_id: process.env.PROBE_RECEIPT_ACTION_ATTEMPT_ID,
    generation: Number(process.env.PROBE_RECEIPT_GENERATION),
    native_session_id: process.env.PROBE_RECEIPT_NATIVE_SESSION_ID || null,
    request_hash: process.env.PROBE_RECEIPT_REQUEST_HASH,
  },
  evidence: ["built-image isolation probe passed"],
  payload,
  issued_at: "2026-07-30T00:00:00.000Z",
};
console.log(JSON.stringify(receipt));
NODE
}

test "$(id -un)" = "agent"
if [ -n "${PROBE_READONLY_ACTION_DIR:-}" ]; then
  test "$(stat -c '%a' "$PROBE_READONLY_ACTION_DIR")" = "711"
  test "$(git rev-parse HEAD)" = "$PROBE_BASE"
  git status --porcelain=v1 --untracked-files=all >/tmp/ot-probe-lead-status
  git show --stat --oneline HEAD >/tmp/ot-probe-lead-show
  must_fail sh -c "printf bad > '$PWD/lead-write.txt'"
  must_fail git add lead-write.txt
  must_fail git commit -m "lead direct commit"
  must_fail git update-ref refs/heads/lead-direct HEAD
  must_fail git cat-file -p "$PROBE_SIBLING_ONLY_BLOB"
  must_fail sh -c "printf bad >> '$PROBE_INTEGRATION/file.txt'"
  must_fail cat "$PROBE_INTEGRATION/file.txt"
  emit_receipt "$PROBE_READONLY_ACTION_DIR" "$(git rev-parse HEAD)"
  exit 0
fi
if [ -n "${PROBE_BUILTIN_ACTION_DIR:-}" ]; then
  test "$(stat -c '%a' "$PROBE_BUILTIN_ACTION_DIR")" = "711"
  test "$HOME" = "$PROBE_BUILTIN_ACTION_DIR/home"
  test "$CODEX_HOME" = "$PROBE_BUILTIN_ACTION_DIR/codex"
  test "$OT_NATIVE_SESSION_DIR" = "$PROBE_BUILTIN_ACTION_DIR/native-session"
  printf 'builtin home write\n' > "$HOME/builtin.txt"
  must_fail cat "$PROBE_PRIOR_HOME_SECRET"
  emit_receipt "$PROBE_BUILTIN_ACTION_DIR" "$(git rev-parse HEAD)"
  exit 0
fi
test "$(stat -c '%a' "$PROBE_CURRENT_ACTION_DIR")" = "711"
test "$HOME" = "$PROBE_CURRENT_ACTION_DIR/home"
test "$CODEX_HOME" = "$PROBE_CURRENT_ACTION_DIR/codex"
test -r "$CODEX_HOME/skills/repo_action/SKILL.md"
grep -q "pinned package" "$CODEX_HOME/skills/repo_action/SKILL.md"
test -r "$CODEX_HOME/sessions/native-current.jsonl"
grep -q '"type":"session_meta"' "$CODEX_HOME/sessions/native-current.jsonl"
grep -q '"id":"native-current"' "$CODEX_HOME/sessions/native-current.jsonl"
test ! -e "$CODEX_HOME/sessions/native-sibling.jsonl"
git status --porcelain=v1 --untracked-files=all >/tmp/ot-probe-git-status
printf 'worker write\n' > "$PWD/worker-write.txt"
setsid sh -c 'while :; do sleep 30; done' >/dev/null 2>&1 &
printf '%s\n' "$!" > "$PROBE_BACKGROUND_PID"
test -r "$PWD/.git"
must_fail sh -c "printf 'gitdir: /\n' > '$PWD/.git'"
must_fail rm -f "$PWD/.git"
must_fail git add worker-write.txt
must_fail git commit -m "agent direct commit"
must_fail git update-ref refs/heads/agent-direct HEAD
must_fail sh -c "printf bad >> '$PROBE_INTEGRATION/file.txt'"
must_fail cat "$PROBE_INTEGRATION/file.txt"
must_fail cat "$PROBE_INTEGRATION/.git/HEAD"
must_fail cat "$PROBE_INTEGRATION/.git/config"
must_fail cat "$PROBE_INTEGRATION/.git/packed-refs"
must_fail cat "$PWD/integration-link"
must_fail cat "$PROBE_SEALED_INPUT"
must_fail cat "/proc/$PROBE_ROOT_HELPER_PID/fd/3"
must_fail sh -c "tr '\\000' '\\n' < '/proc/$PROBE_ROOT_HELPER_PID/environ' | grep -F root-helper-env-sentinel"
must_fail cat "$PROBE_SIBLING_WORKTREE/file.txt"
must_fail sh -c "printf bad > '$PROBE_SIBLING_WORKTREE/bad.txt'"
must_fail git cat-file -p "$PROBE_SIBLING_ONLY_BLOB"
must_fail cat "$PROBE_INTEGRATION/.git/objects/${PROBE_SIBLING_ONLY_BLOB:0:2}/${PROBE_SIBLING_ONLY_BLOB:2}"
must_fail cat "$PROBE_SIBLING_ACTION_SECRET"
must_fail cat "$PROBE_PRIOR_ACTION_SECRET"
must_fail cat "$PROBE_PRIOR_HOME_SECRET"
must_fail cat "$PROBE_PERSISTENT_CLAUDE_SECRET"
must_fail cat "$PROBE_PERSISTENT_CODEX_SECRET"
must_fail cat "$PROBE_PERSISTENT_OPENCODE_SECRET"
must_fail cat "$PROBE_PERSISTENT_OT_SECRET"
must_fail sh -c "printf bad >> '$PROBE_PERSISTENT_CLAUDE_SECRET'"
must_fail sh -c "printf bad >> '$PROBE_PERSISTENT_CODEX_SECRET'"
must_fail sh -c "printf bad >> '$PROBE_PERSISTENT_OPENCODE_SECRET'"
must_fail sh -c "printf bad >> '$PROBE_PERSISTENT_OT_SECRET'"
must_fail mv "$PROBE_PERSISTENT_CLAUDE_ROOT" "$PROBE_PROFILE_REPLACEMENT_TARGET/claude"
must_fail mv "$PROBE_PERSISTENT_CODEX_ROOT" "$PROBE_PROFILE_REPLACEMENT_TARGET/codex"
must_fail mv "$PROBE_PERSISTENT_OPENCODE_LOCAL_ROOT" "$PROBE_PROFILE_REPLACEMENT_TARGET/local"
must_fail mv "$PROBE_PERSISTENT_OPENCODE_SHARE_ROOT" "$PROBE_PROFILE_REPLACEMENT_TARGET/share"
must_fail mv "$PROBE_PERSISTENT_OPENCODE_ROOT" "$PROBE_PROFILE_REPLACEMENT_TARGET/opencode"
must_fail mv "$PROBE_PERSISTENT_OT_ROOT" "$PROBE_PROFILE_REPLACEMENT_TARGET/ot"
must_fail sh -c "rm -rf '$PROBE_PERSISTENT_CODEX_ROOT' && ln -s '$PROBE_PROFILE_REPLACEMENT_TARGET/codex-link' '$PROBE_PERSISTENT_CODEX_ROOT'"
must_fail sh -c "rm -rf '$PROBE_PERSISTENT_OPENCODE_ROOT' && ln -s '$PROBE_PROFILE_REPLACEMENT_TARGET/opencode-link' '$PROBE_PERSISTENT_OPENCODE_ROOT'"
must_fail cat "$PROBE_INTEGRATION/.git/objects/info/alternates.probe"
must_fail sh -c "printf bad >> '$PROBE_INTEGRATION/.git/objects/info/alternates.probe'"
test ! -w /opt/openthrottle/safety/pre-push
node /opt/openthrottle/runner/execute-stage.mjs --print-subject --repo "$PWD" >/tmp/ot-probe-subject
emit_receipt "$PROBE_CURRENT_ACTION_DIR" "$(cat /tmp/ot-probe-subject)"
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
  protocol: "loop-action@2",
  actionId: "action-current",
  attemptId: "attempt-current",
  graphId: "graph-1",
  parentRunId: "run-parent",
  unitId: "unit-1",
  role: "worker",
  loop: "implement",
  agent: "codex",
  skill: repositorySkill.invocation,
  worktree: { id: "current" },
  nativeSessionId: "native-current",
  contextPolicy: "resume_required",
  timeoutMs: 120000,
  transitionContext: "Probe worktree isolation.",
  allowedMcpServers: [],
  credentialScopes: [],
  receiptSchema: "openthrottle.receipt/v1",
  repositorySkill,
};
mkdirSync(dirname(requestPath), { recursive: true, mode: 0o700 });
writeFileSync(requestPath, canonicalJson({ ...base, ...createLoopRequestHash(base) }), { mode: 0o400 });
NODE
chown root:root "$REQUEST"
chmod 0400 "$REQUEST"

install -d -o root -g root -m 0700 "$ACTION_ROOT/attempt-current/action-lead"
PATH="$BIN:$PATH" node --input-type=module - "$LEAD_REQUEST" "$BASE" <<'NODE'
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "/opt/openthrottle/runner/capabilities.mjs";
import { createLoopRequestHash } from "/opt/openthrottle/runner/execute-loop.mjs";

const requestPath = process.argv[2];
const candidateSubject = process.argv[3];
const base = {
  protocol: "loop-action@2",
  actionId: "action-lead",
  attemptId: "attempt-current",
  graphId: "graph-1",
  parentRunId: "run-parent",
  unitId: "unit-1",
  role: "lead",
  loop: "lead",
  agent: "codex",
  skill: "accept-unit",
  worktree: null,
  candidateSubject,
  nativeSessionId: null,
  contextPolicy: "fresh",
  timeoutMs: 120000,
  transitionContext: "Probe read-only repository view isolation.",
  allowedMcpServers: [],
  credentialScopes: [],
  receiptSchema: "openthrottle.receipt/v1",
};
mkdirSync(dirname(requestPath), { recursive: true, mode: 0o700 });
writeFileSync(requestPath, canonicalJson({ ...base, ...createLoopRequestHash(base) }), { mode: 0o400 });
NODE
chown root:root "$LEAD_REQUEST"
chmod 0400 "$LEAD_REQUEST"

install -d -o root -g root -m 0700 "$ACTION_ROOT/attempt-current/action-reviewer"
PATH="$BIN:$PATH" node --input-type=module - "$REVIEWER_REQUEST" <<'NODE'
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "/opt/openthrottle/runner/capabilities.mjs";
import { createLoopRequestHash } from "/opt/openthrottle/runner/execute-loop.mjs";

const requestPath = process.argv[2];
const base = {
  protocol: "loop-action@2",
  actionId: "action-reviewer",
  attemptId: "attempt-current",
  graphId: "graph-1",
  parentRunId: "run-parent",
  unitId: "unit-1",
  role: "reviewer",
  loop: "review",
  agent: "codex",
  skill: "final-review",
  worktree: null,
  nativeSessionId: null,
  contextPolicy: "fresh",
  timeoutMs: 120000,
  transitionContext: "Probe reviewer read-only repository view isolation.",
  allowedMcpServers: [],
  credentialScopes: [],
  receiptSchema: "openthrottle.receipt/v1",
};
mkdirSync(dirname(requestPath), { recursive: true, mode: 0o700 });
writeFileSync(requestPath, canonicalJson({ ...base, ...createLoopRequestHash(base) }), { mode: 0o400 });
NODE
chown root:root "$REVIEWER_REQUEST"
chmod 0400 "$REVIEWER_REQUEST"

install -d -o root -g root -m 0700 "$ACTION_ROOT/attempt-current/action-builtin"
PATH="$BIN:$PATH" node --input-type=module - "$BUILTIN_REQUEST" "$BASE" <<'NODE'
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "/opt/openthrottle/runner/capabilities.mjs";
import { createLoopRequestHash } from "/opt/openthrottle/runner/execute-loop.mjs";

const requestPath = process.argv[2];
const candidateSubject = process.argv[3];
const base = {
  protocol: "loop-action@2",
  actionId: "action-builtin",
  attemptId: "attempt-current",
  graphId: "graph-1",
  parentRunId: "run-parent",
  unitId: "unit-1",
  role: "lead",
  loop: "lead",
  agent: "codex",
  skill: "accept-unit",
  worktree: null,
  candidateSubject,
  nativeSessionId: null,
  contextPolicy: "fresh",
  timeoutMs: 120000,
  transitionContext: "Probe built-in loop action home isolation.",
  allowedMcpServers: [],
  credentialScopes: [],
  receiptSchema: "openthrottle.receipt/v1",
};
mkdirSync(dirname(requestPath), { recursive: true, mode: 0o700 });
writeFileSync(requestPath, canonicalJson({ ...base, ...createLoopRequestHash(base) }), { mode: 0o400 });
NODE
chown root:root "$BUILTIN_REQUEST"
chmod 0400 "$BUILTIN_REQUEST"

request_hash() {
  node --input-type=module - "$1" <<'NODE'
import { readFileSync } from "node:fs";
console.log(JSON.parse(readFileSync(process.argv[2], "utf8")).requestHash);
NODE
}

CURRENT_REQUEST_HASH="$(request_hash "$REQUEST")"
LEAD_REQUEST_HASH="$(request_hash "$LEAD_REQUEST")"
REVIEWER_REQUEST_HASH="$(request_hash "$REVIEWER_REQUEST")"
BUILTIN_REQUEST_HASH="$(request_hash "$BUILTIN_REQUEST")"

printf 'mutable worktree skill bytes\n' > "$WORKTREES/current/.agents/skills/current/SKILL.md"
printf '#!/bin/sh\necho executable probe\n' > "$WORKTREES/current/executable-probe.sh"
chmod 0755 "$WORKTREES/current/executable-probe.sh"

write_probe_env \
  PROBE_INTEGRATION "$INTEGRATION" \
  PROBE_SEALED_INPUT "$SEALED" \
  PROBE_ROOT_HELPER_PID "$(cat "$ROOT_HELPER_PID_FILE")" \
  PROBE_SIBLING_WORKTREE "$WORKTREES/sibling" \
  PROBE_SIBLING_ONLY_BLOB "$SIBLING_ONLY_BLOB" \
  PROBE_SIBLING_ACTION_SECRET "$ACTION_ROOT/attempt-current/action-sibling/secret.txt" \
  PROBE_PRIOR_ACTION_SECRET "$ACTION_ROOT/attempt-prior/action-current/secret.txt" \
  PROBE_PRIOR_HOME_SECRET "$ACTION_ROOT/attempt-prior/action-home/home/native-session.json" \
  PROBE_PERSISTENT_CLAUDE_SECRET "$PERSISTENT_CLAUDE_SECRET" \
  PROBE_PERSISTENT_CODEX_SECRET "$PERSISTENT_CODEX_SECRET" \
  PROBE_PERSISTENT_OPENCODE_SECRET "$PERSISTENT_OPENCODE_SECRET" \
  PROBE_PERSISTENT_OT_SECRET "$PERSISTENT_OT_SECRET" \
  PROBE_PERSISTENT_CLAUDE_ROOT "/home/agent/.claude" \
  PROBE_PERSISTENT_CODEX_ROOT "/home/agent/.codex" \
  PROBE_PERSISTENT_OPENCODE_LOCAL_ROOT "/home/agent/.local" \
  PROBE_PERSISTENT_OPENCODE_SHARE_ROOT "/home/agent/.local/share" \
  PROBE_PERSISTENT_OPENCODE_ROOT "$PERSISTENT_OPENCODE_ROOT" \
  PROBE_PERSISTENT_OT_ROOT "/home/agent/.ot" \
  PROBE_PROFILE_REPLACEMENT_TARGET "$PROFILE_REPLACEMENT_TARGET" \
  PROBE_CURRENT_ACTION_DIR "$ACTION_ROOT/attempt-current/action-current" \
  PROBE_BACKGROUND_PID "$BACKGROUND_PID" \
  PROBE_RECEIPT_UNIT_ID "unit-1" \
  PROBE_RECEIPT_ATTEMPT_ID "attempt-current" \
  PROBE_RECEIPT_REQUEST_HASH "$CURRENT_REQUEST_HASH" \
  PROBE_RECEIPT_PARENT_RUN_ID "run-parent" \
  PROBE_RECEIPT_ACTION_ATTEMPT_ID "action-current" \
  PROBE_RECEIPT_GENERATION "1" \
  PROBE_RECEIPT_NATIVE_SESSION_ID "native-current" \
  PROBE_RECEIPT_SKILL "repo://owner/repo@$BASE#.agents/skills/current"
PATH="$BIN:$PATH" \
OT_LOOP_ACTION_ROOT="$ACTION_ROOT" \
OT_WORKTREE_ROOT="$WORKTREES" \
OT_INTEGRATION_REPO_DIR="$INTEGRATION" \
/opt/openthrottle/runner/execute-loop.mjs --request "$REQUEST" --output "$RESULT"

if [ -s "$BACKGROUND_PID" ] && kill -0 "$(cat "$BACKGROUND_PID")" >/dev/null 2>&1; then
  echo "agent background process survived loop fence" >&2
  exit 42
fi

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

gosu agent git -C "$INTEGRATION" rev-parse HEAD >/tmp/ot-probe-restored-head
test "$(cat /tmp/ot-probe-restored-head)" = "$BASE"

write_probe_env \
  PROBE_INTEGRATION "$INTEGRATION" \
  PROBE_BASE "$BASE" \
  PROBE_SIBLING_ONLY_BLOB "$SIBLING_ONLY_BLOB" \
  PROBE_READONLY_ACTION_DIR "$ACTION_ROOT/attempt-current/action-lead" \
  PROBE_RECEIPT_UNIT_ID "unit-1" \
  PROBE_RECEIPT_ATTEMPT_ID "attempt-current" \
  PROBE_RECEIPT_REQUEST_HASH "$LEAD_REQUEST_HASH" \
  PROBE_RECEIPT_PARENT_RUN_ID "run-parent" \
  PROBE_RECEIPT_ACTION_ATTEMPT_ID "action-lead" \
  PROBE_RECEIPT_GENERATION "1" \
  PROBE_RECEIPT_NATIVE_SESSION_ID "" \
  PROBE_RECEIPT_SKILL "builtin://accept-unit@1"
PATH="$BIN:$PATH" \
OT_LOOP_ACTION_ROOT="$ACTION_ROOT" \
OT_WORKTREE_ROOT="$WORKTREES" \
OT_INTEGRATION_REPO_DIR="$INTEGRATION" \
/opt/openthrottle/runner/execute-loop.mjs --request "$LEAD_REQUEST" --output "$LEAD_RESULT"

node --input-type=module - "$LEAD_RESULT" <<'NODE'
import { readFileSync } from "node:fs";
const result = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (result.kind !== "loop_action_result" ||
    result.attempt_id !== "attempt-current" ||
    result.action_id !== "action-lead" ||
    result.outcome !== "success" ||
    !/^[a-f0-9]{40}$/.test(result.subject)) {
  throw new Error(`invalid lead probe result: ${JSON.stringify(result)}`);
}
NODE

write_probe_env \
  PROBE_INTEGRATION "$INTEGRATION" \
  PROBE_BASE "$BASE" \
  PROBE_SIBLING_ONLY_BLOB "$SIBLING_ONLY_BLOB" \
  PROBE_READONLY_ACTION_DIR "$ACTION_ROOT/attempt-current/action-reviewer" \
  PROBE_RECEIPT_UNIT_ID "unit-1" \
  PROBE_RECEIPT_ATTEMPT_ID "attempt-current" \
  PROBE_RECEIPT_REQUEST_HASH "$REVIEWER_REQUEST_HASH" \
  PROBE_RECEIPT_PARENT_RUN_ID "run-parent" \
  PROBE_RECEIPT_ACTION_ATTEMPT_ID "action-reviewer" \
  PROBE_RECEIPT_GENERATION "1" \
  PROBE_RECEIPT_NATIVE_SESSION_ID "" \
  PROBE_RECEIPT_SKILL "builtin://final-review@1"
PATH="$BIN:$PATH" \
OT_LOOP_ACTION_ROOT="$ACTION_ROOT" \
OT_WORKTREE_ROOT="$WORKTREES" \
OT_INTEGRATION_REPO_DIR="$INTEGRATION" \
/opt/openthrottle/runner/execute-loop.mjs --request "$REVIEWER_REQUEST" --output "$REVIEWER_RESULT"

node --input-type=module - "$REVIEWER_RESULT" <<'NODE'
import { readFileSync } from "node:fs";
const result = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (result.kind !== "loop_action_result" ||
    result.attempt_id !== "attempt-current" ||
    result.action_id !== "action-reviewer" ||
    result.outcome !== "success" ||
    !/^[a-f0-9]{40}$/.test(result.subject)) {
  throw new Error(`invalid reviewer probe result: ${JSON.stringify(result)}`);
}
NODE

write_probe_env \
  PROBE_BUILTIN_ACTION_DIR "$ACTION_ROOT/attempt-current/action-builtin" \
  PROBE_PRIOR_HOME_SECRET "$ACTION_ROOT/attempt-prior/action-home/home/native-session.json" \
  PROBE_RECEIPT_UNIT_ID "unit-1" \
  PROBE_RECEIPT_ATTEMPT_ID "attempt-current" \
  PROBE_RECEIPT_REQUEST_HASH "$BUILTIN_REQUEST_HASH" \
  PROBE_RECEIPT_PARENT_RUN_ID "run-parent" \
  PROBE_RECEIPT_ACTION_ATTEMPT_ID "action-builtin" \
  PROBE_RECEIPT_GENERATION "1" \
  PROBE_RECEIPT_NATIVE_SESSION_ID "" \
  PROBE_RECEIPT_SKILL "builtin://accept-unit@1"
PATH="$BIN:$PATH" \
OT_LOOP_ACTION_ROOT="$ACTION_ROOT" \
OT_WORKTREE_ROOT="$WORKTREES" \
OT_INTEGRATION_REPO_DIR="$INTEGRATION" \
/opt/openthrottle/runner/execute-loop.mjs --request "$BUILTIN_REQUEST" --output "$BUILTIN_RESULT"

node --input-type=module - "$BUILTIN_RESULT" <<'NODE'
import { readFileSync } from "node:fs";
const result = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (result.kind !== "loop_action_result" ||
    result.attempt_id !== "attempt-current" ||
    result.action_id !== "action-builtin" ||
    result.outcome !== "success" ||
    !/^[a-f0-9]{40}$/.test(result.subject)) {
  throw new Error(`invalid built-in probe result: ${JSON.stringify(result)}`);
}
NODE

gosu agent test ! -w "$WORKTREES/current"
test "$(stat -c '%a' "$ACTION_ROOT/attempt-current/action-current")" = "700"
test "$(stat -c '%a' "$ACTION_ROOT/attempt-current/action-lead")" = "700"
test "$(stat -c '%a' "$ACTION_ROOT/attempt-current/action-reviewer")" = "700"
test "$(stat -c '%a' "$ACTION_ROOT/attempt-current/action-builtin")" = "700"
gosu agent test ! -r "$ACTION_ROOT/attempt-current/action-current/request.json"
gosu agent test ! -r "$ACTION_ROOT/attempt-current/action-lead/request.json"
gosu agent test ! -r "$ACTION_ROOT/attempt-current/action-reviewer/request.json"
gosu agent test ! -r "$ACTION_ROOT/attempt-current/action-builtin/request.json"
gosu agent test ! -r "$ACTION_ROOT/attempt-current/action-sibling/secret.txt"
gosu agent test ! -r "$ACTION_ROOT/attempt-prior/action-current/secret.txt"
gosu agent test ! -r "$ACTION_ROOT/attempt-prior/action-home/home/native-session.json"
test ! -L /home/agent/.claude
test ! -L /home/agent/.codex
test ! -L /home/agent/.local
test ! -L /home/agent/.local/share
test ! -L "$PERSISTENT_OPENCODE_ROOT"
test ! -L /home/agent/.ot

CANDIDATE_JSON="$(/opt/openthrottle/runner/worktrees.mjs candidate --repo "$INTEGRATION" --root "$WORKTREES" --handle current --base "$BASE" --message "candidate from executor")"
CANDIDATE="$(printf '%s' "$CANDIDATE_JSON" | jq -r '.candidateCommit')"
test "$CANDIDATE" != "null"
/opt/openthrottle/runner/integrate-unit.mjs --repo "$INTEGRATION" --expected-head "$BASE" --candidate "$CANDIDATE" >/tmp/ot-probe-integration.json
jq -e --arg candidate "$CANDIDATE" '.candidate_commit == $candidate and .integrated == true' /tmp/ot-probe-integration.json >/dev/null
INTEGRATED_HEAD="$(git -c "safe.directory=$INTEGRATION" -C "$INTEGRATION" rev-parse HEAD)"
test "$INTEGRATED_HEAD" = "$CANDIDATE"
gosu agent sh -c "printf 'agent post-integrate write\n' > '$INTEGRATION/agent-after-integrate.txt'"
gosu agent test -x "$INTEGRATION/executable-probe.sh"
gosu agent git -C "$INTEGRATION" status --porcelain=v1 --untracked-files=all >/tmp/ot-probe-post-integrate-status
grep -q 'agent-after-integrate.txt' /tmp/ot-probe-post-integrate-status
rm -f "$INTEGRATION/agent-after-integrate.txt"
/opt/openthrottle/runner/worktrees.mjs create --repo "$INTEGRATION" --root "$WORKTREES" --handle after-loop --base "$INTEGRATED_HEAD" >/dev/null

echo "sandbox linked-worktree ownership isolation probe passed"
