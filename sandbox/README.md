# OpenThrottle sandbox

The Daytona snapshot is built from the repository root because it embeds the
shared `skills/` directory:

```bash
docker build -f sandbox/Dockerfile -t openthrottle .
daytona snapshot create openthrottle --dockerfile sandbox/Dockerfile --context .
```

It contains Node 22, git/curl/jq/yq/ripgrep/GitHub CLI, Claude Code, Codex,
and an unprivileged `agent` user. The root entrypoint owns checkout and safety
setup, then drops privileges for all repo and agent commands.

## Lifecycle

The eight phases are auth, checkout/push, sealed safety config, project config,
post-bootstrap, dev server, agent task, and completion marker. Supported
tasks are `implement`, `resume`, `review`, `review-fix`, and `investigate`.
Fresh tasks use their corresponding skill; resume continues the saved Claude
session or Codex thread.

`~/.ot` holds ticket context, task/dev logs, the agent session ID, normalized
run result, and a structured outbox. `ot-activity` writes progress into that
outbox. The exit trap writes exit code, Claude cost, PR URL, and sanitized
failure tail as a completion marker. Fly reads both through the Daytona SDK.

Claude receives only project-declared MCP servers through a strict runtime
config and user-level setting sources. Codex receives global instructions in
`~/.codex/AGENTS.md`. Neither engine receives Linear credentials. The target repo's
`AGENTS.md` and Claude settings remain untouched and editable. Git uses the
`gh` credential helper against a clean origin URL, so the token never enters
`.git/config` and the sealed config remains safe across resume runs.

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

The smoke checks the pinned real Claude and Codex CLI versions and required
flags, then uses a local bare repository and deterministic agent JSONL stubs.
It verifies implement and same-session resume for
both engines, checkout/branch creation, safety/config phases, session/cost
capture, completion markers, and absence of secrets in human-visible artifacts.

For live monitoring, use Daytona’s normal controls:

```bash
daytona list
daytona ssh <sandbox-id>
```

Or use `openthrottle logs <ticket>` for sanitized remote output and the
wake-on-click preview link attached to the Linear session.
