# OpenThrottle

OpenThrottle is a plan-first coding pipeline: delegate an approved Linear
ticket, get an isolated Daytona workspace running Claude Code or Codex, review
the resulting GitHub PR, and reply in Linear to continue the same session.

The GitHub repository is `openthrottle-v2`; the product, CLI, npm package,
and Daytona snapshot are all named `openthrottle`.

## How it works

```text
Linear ticket ──> Fly supervisor ──> Daytona sandbox ──> ot/* branch + PR
     ▲                 │     ▲              │                    │
     └── activities ───┘     └── outbox ────┴── GitHub events ──┘
```

The supervisor authenticates webhooks, durably stores and retries deliveries,
owns one-time run state in SQLite, and keeps one sandbox per ticket. Agents
push early, cannot push main/master, and run through a sanitizer. PR
close/merge deletes the workspace. Review and CI events are mirrored back to
the Linear session.

See [docs/SPEC.md](docs/SPEC.md) for the normative contracts and
[docs/PLAN.md](docs/PLAN.md) for the delivery/acceptance plan.

## Bootstrap

Requires Node 22, Docker, Fly CLI, Daytona CLI, and the service credentials in
`supervisor/.env.example`.

```bash
# test all non-live contracts
npm ci --prefix supervisor && npm test --prefix supervisor
npm ci --prefix cli && npm test --prefix cli
npm ci --prefix sandbox && npm test --prefix sandbox
bats sandbox/tests/runtime.bats
docker build -f sandbox/Dockerfile -t openthrottle:test .
sandbox/tests/smoke.sh openthrottle:test

# create the canonical Daytona snapshot once (requires `daytona login`)
daytona snapshot create openthrottle --dockerfile sandbox/Dockerfile --context .

# deploy the always-on supervisor
cd supervisor
fly volumes create openthrottle_data --region sjc --size 1
fly secrets set SUPERVISOR_URL=... OT_STATUS_TOKEN=... OT_INSTALL_SECRET=... # plus .env.example
fly deploy
```

Then install the Linear OAuth app through authenticated `/oauth/install`, add
the Linear and GitHub webhooks described in [supervisor/README.md](supervisor/README.md),
and initialize a target repository:

```bash
npx openthrottle init
npx openthrottle ship docs/plans/my-change.md
npx openthrottle status
```

## Repository layout

- `supervisor/` — Hono/SQLite control plane deployed on Fly.
- `sandbox/` — Daytona image, safety boundary, entrypoint, tests.
- `skills/` — OpenThrottle task adapters layered over the native Compound
  Engineering toolkit installed for both Claude Code and Codex.
- `cli/` — the `openthrottle` command-line package.
- `docs/` — architecture and execution plan.

## Security boundary

Only repo, Linear, and model credentials enter a sandbox—never Daytona, Fly,
webhook, install, or operator tokens. Webhooks are signature-verified, run and
preview tokens are stored hashed, and logs redact named/nested credentials and
known token shapes. GitHub branch protection and a fine-grained PAT are still
required as the outer enforcement layer.

The deterministic contract suite and Docker smoke are green locally. Live
Linear/Daytona/Fly acceptance is intentionally a separate deployment gate
because it consumes operator-owned credentials and account state.
