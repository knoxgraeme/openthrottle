# sandbox/

Docker image + entrypoint that runs inside each per-ticket Daytona sandbox.
This is the component described by `docs/SPEC.md` §"Sandbox contract" and
§"Sandbox env contract" — read those first; this README covers build/run
mechanics and a few implementation decisions the spec leaves open.

## Building the image

Build context **must be the repo root**, not `sandbox/` — the image also
bakes in `skills/` (Claude + Codex skill bodies), which lives at the repo
root as a sibling of `sandbox/`:

```sh
docker build -f sandbox/Dockerfile -t openthrottle .
```

The `cli/ init` command's declarative Daytona snapshot builder should mirror
this Dockerfile (`Image.base('node:22-bookworm')...`), or use
`Image.fromDockerfile('sandbox/Dockerfile')` with the repo root as context
when run from within this repo — see `docs/SPEC.md` §"CLI contract".

## What's inside

| Path (in image) | Source | Purpose |
|---|---|---|
| `/opt/openthrottle/entrypoint.sh` | `sandbox/entrypoint.sh` | The 8-phase sandbox bootstrap + agent run (see below). |
| `/opt/openthrottle/runner/normalize.mjs` | `sandbox/runner/` | JSONL stdin processor sitting between the agent CLI and the task log. |
| `/opt/openthrottle/safety/pre-push` | `sandbox/safety/` | Git hook: blocks push to main/master, blocks force-push. |
| `/opt/openthrottle/safety/seal.sh` | `sandbox/safety/` | Best-effort immutability seal (`chattr +i`, chmod 444 fallback). |
| `/opt/openthrottle/skills/` | `skills/` (repo root) | Claude skills (`skills/claude/*/SKILL.md`) + Codex prompt mirrors (`skills/codex/*.md`). |

Non-root user `agent` (home `/home/agent`). The container starts as root
(needed for `chattr`, `chown`, and privilege drop) and `entrypoint.sh` uses
`gosu` for every repo/agent-facing operation.

## Env contract (supervisor → sandbox)

Exact names, see `docs/SPEC.md` §"Sandbox env contract" for the canonical
version — reproduced here for convenience:

| Var | Required | Meaning |
|---|---|---|
| `TASK_TYPE` | yes | `implement` \| `resume` |
| `AGENT` | no* | `claude` \| `codex`. See "Agent resolution" below. |
| `GITHUB_REPO` | yes | `owner/name` |
| `GITHUB_TOKEN` | yes | fine-grained PAT (contents + PRs, read/write) |
| `BASE_BRANCH` | yes | e.g. `main` |
| `BRANCH_NAME` | yes | `ot/eng-123` |
| `LINEAR_SESSION_ID` | yes | agent session to post activities to |
| `LINEAR_ISSUE_ID` / `LINEAR_ISSUE_IDENTIFIER` | no | issue ids, used for ticket context (e.g. Codex stdin) |
| `LINEAR_ACCESS_TOKEN` | yes | OAuth app token, used for GraphQL activity posting from entrypoint.sh itself |
| `LINEAR_MCP_API_KEY` | no | plain API key for the Linear MCP server inside the agent |
| `RESUME_MESSAGE` | yes iff `TASK_TYPE=resume` | the human's follow-up message |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | one of, iff `AGENT=claude` | Claude auth (env-var only, no file written) |
| `CODEX_API_KEY` / `CODEX_AUTH_JSON` | one of, iff `AGENT=codex` | Codex auth. `CODEX_AUTH_JSON` (raw contents of `~/.codex/auth.json`) is written to `~/.codex/auth.json` (0600). |
| `MAX_TURNS` | no (default 200) | passed to `--max-turns` |
| `TASK_TIMEOUT` | no (default 7200) | seconds, wraps the agent invocation in `timeout` |
| `DEV_PORT` | no (default 3000) | dev server bind port |

\* `AGENT` is expected to always be set by the supervisor in practice (it
resolves the Linear `agent:codex` label vs. the default). It's optional at
the script level to support standalone testing; see "Agent resolution".

`~/.ot/` (i.e. `/home/agent/.ot/`) holds: `agent-session-id`, `dev.log`,
`dev.pid` (not in the spec's file list, but needed to restart the dev server
cleanly on resume — see below), `task.log`.

## The 8 phases (`entrypoint.sh`)

Runs as root, drops to `agent` via `gosu` for every git/npm/agent-CLI
command. Written to be idempotent so the exact same script handles both
`TASK_TYPE=implement` (fresh sandbox) and `TASK_TYPE=resume` (re-exec'd into
a running/restarted sandbox by the supervisor via the Daytona process exec
API — see `docs/SPEC.md` §"Event flows" #2):

1. **Auth files** — writes `~/.codex/auth.json` (0600) from `CODEX_AUTH_JSON`
   if set. Strips trailing newlines from token-shaped env vars.
2. **Clone / checkout / push** — clones only if `~/repo/.git` doesn't already
   exist (resume case: reuses the persisted filesystem, just fetches).
   Checks out `BRANCH_NAME` (creating it from `BASE_BRANCH` if new, or from
   `origin/BRANCH_NAME` if it already exists remotely but not locally). On
   resume, does a fast-forward `git pull` first. Always finishes with
   `git push -u origin BRANCH_NAME` — a no-op on resume if nothing moved,
   but guarantees the branch is on origin as the human escape hatch even
   before the agent's first commit.
3. **Safety** — installs `safety/pre-push` via `core.hooksPath`, seals
   `.git/config` (`safety/seal.sh`; both steps skip themselves if already
   done, so resume doesn't try to rewrite an immutable file), and
   neutralizes `.claude/settings.json` → `{}` (backed up to `.bak` once).
4. **Read `.openthrottle.yml`** via `yq` (mikefarah/yq, jq-style filters),
   with defaults for every field. See "Agent resolution" for the `agent:`
   field's precedence.
5. **`post_bootstrap`** — runs each configured command as `agent`, in repo
   root, in order. Any failure aborts the script (`set -e`), which the EXIT
   trap turns into a Linear `error` activity.
6. **Dev server** — if `dev:` is configured, starts it in the background
   (`nohup ... &`, PID recorded to `~/.ot/dev.pid`), logging to
   `~/.ot/dev.log`, with `DEV_PORT`/`PORT`/`HOST`/`HOSTNAME` set so it binds
   `0.0.0.0:$DEV_PORT`. On resume, kills the previous PID first (SPEC's
   "restart dev server").
7. **Agent run** — installs Claude skills into `.claude/skills/` and, for
   Codex, appends the `AGENTS-fragment.md` to `AGENTS.md` (both added to
   `.git/info/exclude`, not committed — see "Design notes" below for a
   caveat). Writes a temp `--mcp-config` JSON (Linear MCP + repo-configured
   `mcp_servers`). Runs the exact command line SPEC prescribes for the
   `AGENT`×`TASK_TYPE` combination (see below), under
   `timeout $TASK_TIMEOUT`, piped through `runner/normalize.mjs`, all in one
   `gosu agent` subshell.
8. **Final Linear activity** — an `EXIT` trap (`post_final_activity`,
   installed right after `TASK_TYPE`/`LINEAR_SESSION_ID`/
   `LINEAR_ACCESS_TOKEN` are validated, before anything else can fail) always
   fires: `response` with a short success note (+ PR URL if discoverable via
   `gh pr view`) on exit 0, `error` with a sanitized tail of `~/.ot/task.log`
   otherwise. This is a safety-net status update distinct from — and in
   addition to — the richer `response` (with PR + preview link) that the
   `implement-plan` skill itself posts via the Linear MCP from inside the
   agent run.

### Agent invocation (exact command lines, per SPEC)

- **Claude implement**: `claude -p "/implement-plan" --output-format stream-json --verbose --max-turns $MAX_TURNS --dangerously-skip-permissions --mcp-config <tmpfile>`, cwd `/home/agent/repo`.
- **Claude resume**: `claude -p --resume "$(cat ~/.ot/agent-session-id)" "$RESUME_MESSAGE" --output-format stream-json --verbose --max-turns $MAX_TURNS --dangerously-skip-permissions --mcp-config <tmpfile>`.
- **Codex implement**: `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C /home/agent/repo - < <skill+ticket-context file>` (entrypoint concatenates `skills/codex/implement-plan.md` with a small ticket-context block before piping it in).
- **Codex resume**: `codex exec resume "$(cat ~/.ot/agent-session-id)" --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C /home/agent/repo "$RESUME_MESSAGE"`.

### How resume is invoked

The supervisor never recreates the sandbox for a follow-up. Per
`docs/SPEC.md` §"Event flows" #2, on a Linear `prompted` webhook it:

1. Looks up the ticket's DB row for the sandbox id.
2. `sandbox.start()` if the sandbox is stopped (Daytona auto-stops idle
   sandboxes after 60 min; the filesystem persists across stop/start).
3. Uses the **Daytona process exec API** to run
   `/opt/openthrottle/entrypoint.sh` again *inside* that sandbox, with
   `TASK_TYPE=resume` and `RESUME_MESSAGE` set (plus the rest of the normal
   env contract).

This is a fresh process exec of the same entrypoint script, not a new
container — hence phases 1-6 above needing to be idempotent/resumable, and
phase 7 branching to the `resume` command line for whichever `AGENT` the
ticket uses.

## `runner/normalize.mjs`

Zero-dependency Node script (only `node:` builtins — no `npm install` step,
works straight off the image's Node 22). Reads the agent's stdout line by
line:

- **Claude** (`--output-format stream-json`): recognizes `system`/`assistant`/
  `user`/`result` line shapes, captures `session_id` (written once, first
  wins) to `~/.ot/agent-session-id`, pretty-prints assistant text and
  `tool_use` calls.
- **Codex** (`exec --json`): recognizes `thread.*`/`turn.*`/`item.*`/`error`
  line shapes, captures the thread id from `thread.started`, prints
  `item.completed` summaries. Marked `TODO(verify-codex-json-schema)` in the
  source — the exact Codex JSONL field names are a best-effort
  reconstruction and should be checked against the installed `@openai/codex`
  version.
- Anything else (non-JSON lines, or JSON that doesn't match either shape) is
  passed through, truncated at 2000 chars.
- Every line written to stdout goes through `sanitize()` first: redacts the
  value of every env var whose name matches `(TOKEN|KEY|SECRET|PASSWORD)`,
  plus the regexes `ghp_\w+`, `github_pat_\w+`, `sk-[\w-]+`, `lin_api_\w+`,
  `Bearer \S+`.

`entrypoint.sh` has its own independent (bash) implementation of the same
sanitization rules for the log-tail it posts to Linear on failure, so a
failure that happens before Node/the agent are even reachable can still be
reported safely.

## `safety/`

- **`pre-push`**: installed via `git config core.hooksPath
  /opt/openthrottle/safety`. Blocks any push whose remote ref is
  `refs/heads/main` or `refs/heads/master`, and separately refuses
  force/non-fast-forward pushes on any branch (checked via `git merge-base
  --is-ancestor`). This is defense-in-depth — the primary control is GitHub
  branch protection on the target repo, which this hook can't see or
  enforce; configure that too (SPEC "Security invariants" #4).
- **`seal.sh <file>`**: tries `chattr +i`; falls back to root-owned
  `chmod 444` with a logged warning if the filesystem doesn't support the
  immutable attribute (common on some overlay/container filesystems).
  Idempotent (checks `lsattr` first).

## `.git/info/exclude`, not `.gitignore`

Skills and the Codex `AGENTS.md` fragment are installed into the repo at
*runtime*, not committed. `.git/info/exclude` (a local, per-clone ignore
list) is used instead of `.gitignore` so nothing about the OpenThrottle
plumbing needs to be a tracked, PR-visible change to the target repo.

## Design notes / things to double check

- **`agent:` precedence** (`.openthrottle.yml` vs. the `AGENT` env var):
  SPEC's `.openthrottle.yml` sample comments `agent: claude # ... (label
  agent:codex on a ticket overrides)`, i.e. the yml value is the repo's
  default and a Linear `agent:codex` label overrides it. Since the
  supervisor is what resolves that label into the `AGENT` env var, this
  entrypoint implements: `AGENT=codex` from the env always wins (explicit
  per-ticket override); otherwise `.openthrottle.yml`'s `agent:` field wins;
  otherwise `claude`. Worth confirming this matches how the supervisor
  actually sets `AGENT` once that component exists.
- **`AGENTS.md` fragment, if already tracked**: if the target repo already
  has a *tracked* `AGENTS.md`, appending the fragment at runtime makes it
  show up as a local modification in `git status`/`git diff` regardless of
  `.git/info/exclude` (exclude only hides *untracked* paths) — the
  `implement-plan`/`review` skills' self-review-the-diff step should be
  aware `AGENTS.md` changes are sandbox plumbing, not agent work, and not
  commit them.
- **`# TODO(verify-linear-api)`** in `entrypoint.sh`'s `post_linear_activity`
  — the `agentActivityCreate` mutation shape (`AgentActivityCreateInput`,
  `agentSessionId`, `content.type`/`content.body`) is a guess; the Linear
  Agent API is Developer Preview. Verify against current docs before first
  real run.
- **`# TODO(verify-mcp-config)`** in `entrypoint.sh` phase 7 — the
  `--mcp-config` JSON shape for a remote HTTP MCP server
  (`mcpServers.<name>.{type,url,headers}`) should be checked against the
  installed `@anthropic-ai/claude-code` version.
- No `SPEC-DEVIATION`s: everything above is either literal SPEC text or a
  documented interpretation of something SPEC left ambiguous (agent
  precedence; idempotent re-running of phases 3-6 on resume, since SPEC's
  "Event flows" #2 gives a shorter resume description — "git pull, restart
  dev server, then resume the agent" — than the full phase list, but phase 2
  is explicitly called "idempotent for resume" and the rest of the phases
  are naturally safe to re-run).
