# OpenThrottle sandbox

Each ticket runs in a Fly Sprite (a persistent microVM). There is no prebuilt
image: the sandbox payload — this directory plus the shared `skills/` tree — is
baked into the supervisor's Fly image as `payload.tar.gz`, and on first create
the supervisor uploads it to the sprite and runs `sandbox/provision.sh` on the
live Ubuntu overlay.

`provision.sh` installs (idempotently, so it is safe to re-run) Node 22 tooling,
git/curl/jq/yq/ripgrep/GitHub CLI, `gosu`, the pinned Claude Code / Codex /
OpenCode CLIs, a pinned native Compound Engineering installation for all agent
CLIs, and an unprivileged `agent` user. The supervisor then launches each run
through the Sprites `run` service, which invokes this root task script; it owns
checkout and safety setup before dropping privileges for repo and agent commands.

## Lifecycle

The eight phases are auth, checkout/push, sealed safety config, project config,
post-bootstrap, dev server, agent task, and completion marker. Supported
tasks are `implement`, `resume`, and `investigate`. Fresh tasks use their
corresponding canonical skill from `skills/tasks/`; resume continues the saved
Claude session, Codex thread, or OpenCode session — including PR feedback
(reviews, comments, CI failures) queued while the sandbox was idle, which is
delivered as a resume message in the same session rather than a new task.
OpenCode also saves the initial model in `~/.ot/agent-model` so a resumed
session cannot switch models after a project config change.

The corresponding OpenThrottle skill is a thin product adapter over native CE:

- `implement` → `ce-work` → `ce-code-review` → configured gates →
  `ce-commit-push-pr` → resolve/retarget the PR.
- `investigate` → action-capable `ce-debug mode:pipeline`, with convergent fixes
  shipped and divergent decisions escalated as elicitation questions.

Neither task babysits its own PR after opening it. GitHub-native reviewers
(bot or human) own review from there, and their feedback re-enters as a
`resume` of the same session — see `skills/README.md` for the full loop.

Fly owns run serialization, webhook retries, follow-up scheduling, and Linear
publication. Sandbox events are session-bound by the supervisor run record
before they enter the Linear outbox, so a late event from an older delegated
session cannot be redirected into a newer Linear conversation. CE owns agent
reasoning and code/PR work within the run.

`~/.ot` holds ticket context, task/dev logs, the agent session ID, normalized
run result, and a structured outbox. `ot-activity` posts progress to the
supervisor (`POST /runs/:id/events`) and the exit trap posts the completion
(`POST /runs/:id/complete`) with exit code, Claude cost, PR URL, and sanitized
final assistant output/failure tail. Both fall back to spooling a file in the
outbox that the supervisor's sweep drains if the POST fails.
At completion Fly also reads, sanitizes, and persists only the last 100,000
characters of `task.log` in its private SQLite database. Live logs are served
while the workspace exists and this durable tail is the fallback after cleanup;
only the newest captured tail per ticket is retained, and neither form is
automatically attached to Linear or the PR.

Claude receives only project-declared MCP servers through a strict runtime
config and user-level setting sources. Claude and Codex receive the same native
Compound Engineering release through their normal user plugin installations;
Codex also receives OpenThrottle global instructions in `~/.codex/AGENTS.md`.
Neither engine receives Linear credentials. The target repo's `AGENTS.md` and
Claude settings remain untouched and editable. Git uses the `gh` credential
helper against a clean origin URL, so the token never enters `.git/config` and
the sealed config remains safe across resume runs.

OpenCode receives a root-owned runtime config outside the repository through
`OPENCODE_CONFIG_DIR`. Repository `opencode.json[c]`, `.opencode` content,
Claude compatibility loading, and external skills are disabled; only validated
`.openthrottle.yml` MCP declarations and the allowlisted
`kimi-code/kimi-for-coding` profile enter the config. The Kimi key remains an
environment value referenced by name and is not written to JSON.

## Safety and sanitization

The pre-push hook blocks main/master and non-fast-forward pushes, with
`core.hooksPath` root-sealed. This complements—does not replace—GitHub branch
protection.

Both shell and Node sanitizers redact direct named secret values, inner values
from `CODEX_AUTH_JSON`, and known GitHub/OpenAI/Linear/bearer token shapes.

## Verification

```bash
npm ci --prefix sandbox
npm test --prefix sandbox
bats sandbox/tests/runtime.bats
docker build -f sandbox/tests/Dockerfile -t openthrottle:test .
sandbox/tests/smoke.sh openthrottle:test
```

The smoke checks the pinned real Claude, Codex, and OpenCode CLI versions,
required flags, and native Compound Engineering installation and skill discovery. It then uses
a local bare repository and deterministic agent JSONL stubs. It verifies
implement and same-session resume for all engines, checkout/branch creation,
safety/config phases, session/cost capture, completion markers, and absence of
secrets in human-visible artifacts.

For live monitoring, use the Sprites CLI/API (`sprite list --prefix ot-`, then
`sprite exec`/`sprite console` against a named sprite), or `openthrottle logs
<ticket>` for authenticated, sanitized live output or the latest durable private
tail after workspace deletion. The org-private sprite URL wakes the sandbox on
request.
