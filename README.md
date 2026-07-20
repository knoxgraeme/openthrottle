# OpenThrottle

OpenThrottle is a plan-first coding pipeline: delegate an approved Linear
ticket, get an isolated Fly Sprites workspace running Claude Code, Codex, or
OpenCode, review
the resulting GitHub PR, and reply in Linear to continue the same session.

The GitHub repository is `openthrottle-v2`; the product, CLI, and npm package
are all named `openthrottle`.

## How it works

```text
Linear ticket ──> Fly supervisor ──> Fly Sprite ──> ot/* branch + PR
     ▲                 │     ▲              │                    │
     └── activities ───┘     └── outbox ────┴── GitHub events ──┘
```

The supervisor authenticates webhooks, durably stores and retries deliveries,
owns one-time run state in SQLite, and keeps one sandbox per ticket. Agents
push early, cannot push main/master, and run through a sanitizer. Fly is the
deterministic outer state machine; native Compound Engineering skills are the
agentic implementation/review/debug loop inside each authorized run. PR
close/merge deletes the workspace. Review and CI events are mirrored back to
the Linear session.

See [docs/SPEC.md](docs/SPEC.md) for the normative contracts and
[docs/PLAN.md](docs/PLAN.md) for the delivery/acceptance plan.

## Bootstrap

Requires Node 22, Docker, Fly CLI, an org-scoped Fly Sprites API token
(`SPRITE_TOKEN`, from https://sprites.dev), and the service credentials in
`supervisor/.env.example`.

There is no separate sandbox image to build or publish: the sandbox payload
(entrypoint, provisioning script, runner, skills) is assembled into
`payload.tar.gz` and baked into the supervisor's own Fly image at deploy
time, then written into each ticket's Sprite at provision time. Supervisor
and sandbox assets are therefore always in lockstep — one artifact, one
deploy.

```bash
# test all non-live contracts
npm ci --prefix supervisor && npm test --prefix supervisor
npm ci --prefix cli && npm test --prefix cli
npm ci --prefix sandbox && npm test --prefix sandbox
bats sandbox/tests/runtime.bats
docker build -f sandbox/tests/Dockerfile -t openthrottle:test .
sandbox/tests/smoke.sh openthrottle:test

# inspect the one-time platform checklist (verifies SPRITE_TOKEN)
npx openthrottle setup

# deploy the always-on supervisor — run from the repo root: the image build
# context must include the sibling sandbox/ and skills/ directories
fly volumes create openthrottle_data --region sjc --size 1 --config supervisor/fly.toml
fly secrets set --config supervisor/fly.toml \
  SUPERVISOR_URL=... OT_STATUS_TOKEN=... OT_INSTALL_SECRET=... SPRITE_TOKEN=... # plus .env.example
fly deploy --config supervisor/fly.toml --dockerfile supervisor/Dockerfile
```

Then install the Linear OAuth app through authenticated `/oauth/install`.
Run `init` from each target repository; it detects the GitHub origin, writes
the repo-local execution config, registers the Linear-team route in Fly's
SQLite database, and creates or refreshes that repository's GitHub webhook:

```bash
npx openthrottle init
npx openthrottle ship docs/plans/my-change.md
npx openthrottle status
```

`init` requires `OT_SUPERVISOR_URL` and `OT_STATUS_TOKEN`. One Linear team
currently routes to one GitHub repository; re-running `init` updates that
registration without restarting Fly. Once the first durable route exists,
delegations from unmatched teams fail closed instead of falling back to the
wrong repository.

The team route also fixes the base branch each run is cut from. To target a
different base for a single ticket, label the issue with a `branch` label before
delegating. Two equivalent forms are supported:

- **A Linear label group named `branch`** (recommended) whose child label is the
  branch name — e.g. a `branch` group containing `feature/x`. This keeps branch
  labels tidy under one group. Linear's webhook only carries the child's leaf
  name, so the supervisor resolves the parent group through a GraphQL lookup.
- **A flat `branch › <name>` label** (also `branch >`, `branch:`, or `branch/`),
  matched directly from the webhook with no extra call.

The supervisor verifies the branch exists on the resolved repository, cuts the
`ot/*` branch from it, and opens the PR against it. An unmatched or malformed
branch fails closed with a Linear error. The base is read when the run is
delegated (the `created` agent event), so apply the label before assigning.

## Repository layout

- `supervisor/` — Hono/SQLite control plane deployed on Fly.
- `sandbox/` — sandbox payload (provisioning, entrypoint), safety boundary, tests.
- `skills/` — OpenThrottle task adapters layered over the native Compound
  Engineering toolkit installed for Claude Code, Codex, and OpenCode.
- `cli/` — the `openthrottle` command-line package.
- `docs/` — architecture and execution plan.

## Security boundary

Only repo, Linear, and model credentials enter a sandbox—never `SPRITE_TOKEN`,
webhook, install, or operator tokens. Webhooks are signature-verified, run and
preview tokens are stored hashed, and logs redact named/nested credentials and
known token shapes. A bounded private task-log tail is stored in Fly's SQLite
database so operator debugging survives workspace deletion; raw logs are not
attached to Linear or GitHub. GitHub branch protection and a fine-grained PAT
are still required as the outer enforcement layer.

The deterministic contract suite and Docker smoke are green locally. Live
Linear/Sprites/Fly acceptance is intentionally a separate deployment gate
because it consumes operator-owned credentials and account state.

OpenCode is an opt-in third engine. The first supported provider profile is
`model: kimi-code/kimi-for-coding` using `KIMI_CODE_API_KEY` from the Kimi Code
Console subscription endpoint (`https://api.kimi.com/coding/v1`), not a Kimi
Open Platform pay-as-you-go key or `kimi-k3` model ID. Production enablement
requires a live operator-owned check that this stable alias is currently backed
by K3 and authorized for OpenCode.
