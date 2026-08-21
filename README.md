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
fenced coding agent, then carries the result through review, command gates,
publication, and provider verification. You keep the supervisor, credentials,
policies, and execution environment under your control.

> [!IMPORTANT]
> OpenThrottle is pre-production software. Use it for controlled pilots, keep
> branch protection enabled, and register only repositories you trust to run
> code inside the sandbox.

## Why OpenThrottle

- **Plan first.** Work begins from an explicit task specification.
- **Filesystem-authored behavior.** Pipelines, agent instructions, skills, and
  eval schemas live under `.openthrottle/` and compile into one immutable
  DefinitionBundle.
- **Deterministic control plane.** The supervisor owns attempts, records,
  checkpoints, retries, and external effects; agents own reasoning only.
- **Agent choice.** Claude Code, Codex, and OpenCode receive the same standing
  instructions, task prompt, and progressively disclosed skill packages.
- **Work survives formatting mistakes.** Agents return small semantic
  candidates. Deterministic normalization and bounded same-session correction
  handle repairable output-shape errors without rerunning completed work.

## How it works

```text
Linear ticket or GitHub Issue
        |
        v
signed inbox -> admission -> immutable DefinitionBundle
                                  |
                                  v
                    Attempt -> Result -> Decision
                       |                       |
                  Checkpoint              next Attempt/Effect
                                               |
                                               v
                                      Delivery -> GitHub PR
```

Every action is pinned to an exact Git subject, request hash, DefinitionBundle
hash, lease, and repository authority. `inspect` actions receive an immutable
read-only view plus a bounded executor-authored diff artifact when reviewing an
accepted edit. `edit` actions receive an isolated writable content tree, while
Git commits, checkpoint refs, pushes, and publication remain executor-owned.

## Quick start

Prerequisites are Node.js 22, Docker, authenticated Fly and Daytona CLIs, and a
fine-grained GitHub token. Linear is optional when GitHub Issues are the control
surface.

```bash
npx openthrottle setup
cd your-repository
npx openthrottle init
```

`init` writes `.openthrottle/config.yml`, creates starter definition
directories, installs the global planning/operator skills, registers the
repository route, and verifies the runtime snapshot. Commit the definition tree
before validation or shipping; compilation always reads exact Git bytes.

For Linear control:

```bash
npx openthrottle plan prepare docs/plans/my-change.md
npx openthrottle plan validate docs/plans/my-change.md
npx openthrottle ship docs/plans/my-change.md
npx openthrottle status OPE-188
npx openthrottle logs OPE-188
npx openthrottle analysis --run OPE-188
```

For GitHub Issue control, an authorized collaborator applies the exact
`openthrottle` label to an open Issue in a registered repository.

Useful setup variants:

```bash
npx openthrottle setup --check
npx openthrottle setup --profile prod
npx openthrottle init --profile prod
```

See the [CLI guide](cli/README.md),
[automatic-admission runbook](docs/runbooks/automatic-admission.md), and
[normative specification](docs/SPEC.md) for the complete contracts.

## Repository layout

| Path | Purpose |
| --- | --- |
| `.openthrottle/` | Built-in filesystem definitions used by the factory itself |
| `contracts/` | Canonical contracts, compiler, and generated runtime validators |
| `supervisor/` | Hono/SQLite control plane deployed on Fly |
| `sandbox/` | Daytona action executor and repository authority boundary |
| `skills/` | Operator and planning distribution assets |
| `cli/` | Published `openthrottle` npm package |
| `docs/` | Normative specification, plans, and runbooks |

## Security model

Only the repository and model credentials enter an action sandbox. Daytona,
Fly, webhook, installation, operator, and publication credentials remain in the
supervisor. Signed ingress is bounded before parsing; large immutable evidence
is content-addressed; logs are bounded and sanitized.

These controls complement—not replace—GitHub branch protection,
least-privilege tokens, review rules, and dependency hygiene. See
[SECURITY.md](SECURITY.md).

## Development

The repository contains four independent npm projects and intentionally has no
root `package.json`. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for setup and
the full verification suite.

## License

OpenThrottle is available under the [MIT License](LICENSE).
