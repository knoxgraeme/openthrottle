# OpenThrottle

OpenThrottle is a plan-first coding pipeline: delegate an approved Linear
ticket, get an isolated Daytona workspace running Claude Code, Codex, or
OpenCode, review
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
push early, cannot push main/master, and run through a sanitizer. Fly is the
deterministic outer state machine; native Compound Engineering skills drive
two loops inside each authorized run — `implement` (feature/bug plan) and
`investigate` (debugging), both ending in a PR. Once a PR exists, external
GitHub-native reviewers (bots or humans) own review; their feedback — reviews,
PR comments, failed CI — is deduplicated and delivered back as a `resume` of
the same agent session, bounded by a rounds counter with a Linear/PR
escalation. PR close/merge deletes the workspace. Review and CI events are
mirrored back to the Linear session.

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
# Size it for real monorepo builds — the default tier OOM-kills pnpm/Turbo
# build and type-check gates (exit 137). CI builds via
# supervisor/scripts/build-snapshot.mjs read DAYTONA_SANDBOX_CPU/MEMORY/DISK
# (default 4 vCPU / 8 GiB / 40 GiB).
daytona snapshot create openthrottle --dockerfile sandbox/Dockerfile --context . \
  --cpu 4 --memory 8 --disk 40

# inspect the one-time platform checklist
npx openthrottle setup

# deploy the always-on supervisor
cd supervisor
fly volumes create openthrottle_data --region sjc --size 1
fly secrets set SUPERVISOR_URL=... OT_STATUS_TOKEN=... OT_INSTALL_SECRET=... # plus .env.example
fly deploy
```

Then install the Linear OAuth app through authenticated `/oauth/install`.
Run `init` from each target repository; it detects the GitHub origin, writes
the repo-local execution config, registers the Linear-team route in Fly's
SQLite database, creates or refreshes that repository's GitHub webhook, and
verifies the canonical Daytona snapshot:

```bash
npx openthrottle init
npx openthrottle ship docs/plans/my-change.md
npx openthrottle status
```

`init` requires `OT_SUPERVISOR_URL` and `OT_STATUS_TOKEN`. One Linear team
currently routes to one GitHub repository; re-running `init` updates that
registration without restarting Fly or creating a new Daytona snapshot. Once
the first durable route exists, delegations from unmatched teams fail closed
instead of falling back to the wrong repository.

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
- `sandbox/` — Daytona image, safety boundary, entrypoint, tests.
- `skills/` — OpenThrottle task adapters layered over the native Compound
  Engineering toolkit installed for Claude Code, Codex, and OpenCode.
- `cli/` — the `openthrottle` command-line package.
- `docs/` — architecture and execution plan.

## Security boundary

Only repo, Linear, and model credentials enter a sandbox—never Daytona, Fly,
webhook, install, or operator tokens. Webhooks are signature-verified, run and
preview tokens are stored hashed, and logs redact named/nested credentials and
known token shapes. A bounded private task-log tail is stored in Fly's SQLite
database so operator debugging survives workspace deletion; raw logs are not
attached to Linear or GitHub. GitHub branch protection and a fine-grained PAT
are still required as the outer enforcement layer.

The deterministic contract suite and Docker smoke are green locally. Live
Linear/Daytona/Fly acceptance is intentionally a separate deployment gate
because it consumes operator-owned credentials and account state.

OpenCode is an opt-in third engine. The first supported provider profile is
`model: kimi-code/kimi-for-coding` using `KIMI_CODE_API_KEY` from the Kimi Code
Console subscription endpoint (`https://api.kimi.com/coding/v1`), not a Kimi
Open Platform pay-as-you-go key or `kimi-k3` model ID. Production enablement
requires a live operator-owned check that this stable alias is currently backed
by K3 and authorized for OpenCode.
