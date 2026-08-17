<p align="center">
  <img src="docs/assets/banner.jpg" alt="OpenThrottle" width="100%">
</p>

<p align="center"><strong>Turn approved plans into reviewed pull requests with a self-hosted, deterministic agent pipeline.</strong></p>

<p align="center">
  <a href="https://github.com/knoxgraeme/openthrottle/actions/workflows/ci.yml"><img src="https://github.com/knoxgraeme/openthrottle/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/openthrottle"><img src="https://img.shields.io/npm/v/openthrottle" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>

OpenThrottle connects an approved Linear ticket or labeled GitHub Issue to a
fenced coding agent, then carries the result through review, tests, publication,
and provider verification. You keep the supervisor, credentials, policies, and
execution environment under your control.

> [!IMPORTANT]
> OpenThrottle is pre-production software. Use it for controlled pilots, keep
> branch protection enabled, and register only repositories you trust to run
> code inside the sandbox.

## Why OpenThrottle

- **Plan first.** Work begins from an explicit task specification, not an
  open-ended prompt.
- **Deterministic control plane.** The supervisor owns stage order, retries,
  gates, and external effects; agents reason only inside fenced stages.
- **Agent choice.** Run Claude Code, Codex, or OpenCode without changing the
  pipeline contract.
- **Evidence before publication.** Typed results, command gates, semantic
  review, and exact-commit verification decide whether work advances.
- **Self-hosted boundaries.** Fly, Daytona, SQLite, GitHub, and optional Linear
  integrations remain in infrastructure you operate.

## How it works

```text
Linear ticket or GitHub Issue
        |
        v
Fly supervisor -> sealed Daytona stage -> Claude Code / Codex / OpenCode
        ^                   |
        |                   v
status + evidence <- gates, review, tests -> ot/* branch + GitHub PR
```

The supervisor pins the pipeline manifest, repository config, runtime
descriptor, base commit, generation, and expected Git subject. It dispatches
one stage at a time and persists external effects before execution so retries
remain bounded and recoverable.

## Quick start

### Prerequisites

- Node.js 22
- Docker
- The Fly and Daytona CLIs, authenticated to accounts you control
- A GitHub fine-grained token for the repositories OpenThrottle will manage
- Optional: a Linear OAuth app when using Linear as the control surface

Run the guided setup from any directory:

```bash
npx openthrottle setup
```

Then initialize a target repository:

```bash
cd your-repository
npx openthrottle init
```

`init` installs user-global planning/operator skills for detected local agents,
writes `.openthrottle.yml`, registers either a Linear-team or GitHub-Issue route,
creates the repository webhook, and verifies the runtime snapshot.

With `LINEAR_API_KEY` and `OT_AGENT_APP_ID` exported, prepare and delegate a
plan through Linear control:

```bash
npx openthrottle plan prepare docs/plans/my-change.md
npx openthrottle ship docs/plans/my-change.md
npx openthrottle status
```

With GitHub-Issue control, apply the exact `openthrottle` label to an open Issue
from an authorized collaborator. OpenThrottle maintains status on that Issue.

Useful setup variants:

```bash
npx openthrottle setup --check          # read-only readiness report
npx openthrottle setup --profile prod   # named environment
npx openthrottle init --profile prod
```

For a manual source install, create the canonical snapshot with the production
resource defaults:

```bash
daytona snapshot create openthrottle --dockerfile sandbox/Dockerfile --context . \
  --cpu 4 --memory 8 --disk 5
```

See the [CLI guide](cli/README.md) for every command and configuration option.

## Repository layout

| Path | Purpose |
| --- | --- |
| `contracts/` | Shared canonical JSON, schema, and digest contracts |
| `supervisor/` | Hono/SQLite control plane deployed on Fly |
| `sandbox/` | Daytona image, stage executor, and safety boundary |
| `skills/` | Self-contained planning and execution adapters |
| `cli/` | Published `openthrottle` npm package |
| `docs/` | Normative specification, plans, and operator runbooks |

For the complete architecture and contracts, read [docs/SPEC.md](docs/SPEC.md).
For delivery and acceptance status, read [docs/PLAN.md](docs/PLAN.md).

## Security model

Only credentials declared by the selected stage enter a sandbox. Daytona,
Fly, webhook, installation, and operator credentials remain in the supervisor.
Webhook signatures are verified before persistence; stage requests bind the
run, generation, attempt, config, runtime, and Git subject; logs and retained
tails are bounded and sanitized.

These controls complement—not replace—GitHub branch protection, least-privilege
tokens, review rules, and normal dependency hygiene. See [SECURITY.md](SECURITY.md)
for the disclosure process and supported versions.

## Development

The repository contains four independent npm projects and intentionally has no
root `package.json`. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
tests, project conventions, and pull-request expectations.

## License

OpenThrottle is available under the [MIT License](LICENSE).
