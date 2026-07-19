# OpenThrottle sandbox

The Daytona snapshot is built from the repository root because it embeds the
shared `skills/` directory:

```bash
docker build -f sandbox/Dockerfile -t openthrottle .
daytona snapshot create openthrottle --dockerfile sandbox/Dockerfile --context .
```

It contains Node 22, git/curl/jq/yq/ripgrep/GitHub CLI, Claude Code, Codex,
OpenCode, a pinned native Compound Engineering installation for all agent CLIs, and an
unprivileged `agent` user. Its automatic image entrypoint is an inert no-op so
Daytona provisioning cannot race the supervisor. Fly uploads the run context
and explicitly launches the root task script, which owns checkout and safety
setup before dropping privileges for repo and agent commands.

## Lifecycle

The eight phases are auth, checkout/push, sealed safety config, project config,
post-bootstrap, dev server, agent task, and completion marker. Supported
tasks are `implement`, `resume`, `review`, `review-fix`, and `investigate`.
Fresh tasks use their corresponding skill; resume continues the saved Claude
session, Codex thread, or OpenCode session. OpenCode also saves the initial
model in `~/.ot/agent-model` so a resumed session cannot switch models after a
project config change.

The corresponding OpenThrottle skill is a thin product adapter over native CE:

- `implement` → `ce-work` → `ce-code-review` → `ce-commit-push-pr` → bounded
  `ce-babysit-pr`.
- `review` → report-only `ce-code-review` and one PR verdict comment.
- `review-fix` → `ce-resolve-pr-feedback` → bounded `ce-babysit-pr`; Fly then
  schedules a fresh review.
- `investigate` → action-capable `ce-debug mode:pipeline`, with convergent fixes
  shipped and divergent decisions returned as needs-human residuals.

Fly owns run serialization, webhook retries, follow-up scheduling, and Linear
publication. Sandbox events are session-bound by the supervisor run record
before they enter the Linear outbox, so a late event from an older delegated
session cannot be redirected into a newer Linear conversation. CE owns agent
reasoning and code/PR work within the run.

`~/.ot` holds ticket context, task/dev logs, the agent session ID, normalized
run result, and a structured outbox. `ot-activity` writes progress into that
outbox. The exit trap writes exit code, Claude cost, PR URL, and sanitized
final assistant output/failure tail as a completion marker. Fly reads both
through the Daytona SDK.
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
docker build -f sandbox/Dockerfile -t openthrottle:test .
sandbox/tests/smoke.sh openthrottle:test
```

The smoke checks the pinned real Claude, Codex, and OpenCode CLI versions,
required flags, and native Compound Engineering installation and skill discovery. It then uses
a local bare repository and deterministic agent JSONL stubs. It verifies
implement and same-session resume for all engines, checkout/branch creation,
safety/config phases, session/cost capture, completion markers, and absence of
secrets in human-visible artifacts.

For live monitoring, use Daytona’s normal controls:

```bash
daytona list
daytona ssh <sandbox-id>
```

Or use `openthrottle logs <ticket>` for authenticated, sanitized live output or
the latest durable private tail after workspace deletion. The wake-on-click
preview link remains attached to the Linear session.
