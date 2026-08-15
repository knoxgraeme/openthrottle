# OpenThrottle

OpenThrottle is a plan-first coding pipeline: delegate an approved Linear
ticket or labeled GitHub Issue, run an immutable configurable pipeline through
fenced Daytona stages using Claude Code, Codex, or OpenCode, and review the
resulting GitHub PR.

The GitHub repository is `openthrottle-v2`; the product, CLI, npm package,
and Daytona snapshot are all named `openthrottle`.

## How it works

```text
Linear ticket or GitHub Issue ──> Fly supervisor ──> Daytona ──> ot/* branch + PR
          ▲                           │     ▲                        │
          └──── activities/status ────┘     └──── GitHub events ────┘
```

The supervisor authenticates and durably retries webhooks, pins the manifest,
repository config, runtime descriptor, base commit, and generation, then
dispatches one sealed stage at a time. Typed artifacts and gates determine the
next transition; external effects are persisted before execution.
Self-contained OpenThrottle skills supply agent reasoning inside the stage
boundary.

The implement pipeline separates planning, implementation, semantic review,
simplification, command gates, exact-subject publication, and provider
verification. Investigate uses its own immutable graph. GitHub reviews and CI
are deduplicated as evidence for the published commit; bounded repair
transitions may continue the native agent session when the manifest permits.

See [docs/SPEC.md](docs/SPEC.md) for the normative contracts and
[docs/PLAN.md](docs/PLAN.md) for the delivery/acceptance plan.

## Bootstrap

Requires Node 22, Docker, Fly CLI, Daytona CLI, and the service credentials in
`supervisor/.env.example`.

```bash
# test all non-live contracts
npm ci --prefix contracts && npm run build --prefix contracts && npm test --prefix contracts
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
# (default 4 vCPU / 8 GiB / 5 GiB; disk is kept small because Daytona's 30 GiB
# total org quota is shared across every retained sandbox — raise it only on
# a larger-quota plan).
daytona snapshot create openthrottle --dockerfile sandbox/Dockerfile --context . \
  --cpu 4 --memory 8 --disk 5

# inspect the one-time platform checklist
npx openthrottle setup

# deploy the always-on supervisor
cd supervisor
fly volumes create openthrottle_data --region sjc --size 1
fly secrets set SUPERVISOR_URL=... OT_STATUS_TOKEN=... OT_DEPLOY_TOKEN=... OT_INSTALL_SECRET=... # plus .env.example
fly deploy
```

For Linear control, install the Linear OAuth app through authenticated
`/oauth/install`. Run `init` from each target repository; it detects the GitHub
origin, writes the repo-local execution config, registers either the Linear-team
or GitHub-Issue route in Fly's SQLite database, creates or refreshes that
repository's GitHub webhook, and verifies the canonical Daytona snapshot:

```bash
npx openthrottle init
npx openthrottle ship docs/plans/my-change.md
npx openthrottle status
```

`init` requires `OT_SUPERVISOR_URL` and `OT_STATUS_TOKEN` and asks which control
provider to use. One Linear team currently routes to one GitHub repository;
GitHub-Issue control is repository-native and needs no Linear team. Re-running
`init` updates that registration without restarting Fly or creating a new
Daytona snapshot. Linear delegations from unmatched teams and GitHub Issues
from unregistered repositories fail closed. In GitHub mode, an authorized
collaborator starts work by applying the exact `openthrottle` label to an open
Issue; the supervisor maintains a pinned status comment on that Issue.

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

- `contracts/` — shared library of canonical JSON and sha256 digest helpers
  kept byte-identical across packages.
- `supervisor/` — Hono/SQLite control plane deployed on Fly.
- `sandbox/` — Daytona image, safety boundary, entrypoint, tests.
- `skills/` — self-contained OpenThrottle task adapters for Claude Code,
  Codex, and OpenCode. Each skill carries its own craft; the pinned Compound
  Engineering plugin remains only as a legacy ambient image input that no
  skill depends on.
- `cli/` — the `openthrottle` command-line package.
- `docs/` — architecture and execution plan.

## Security boundary

Only credentials declared by the selected stage enter a sandbox—never Daytona,
Fly, Linear app, webhook, install, or operator tokens. Webhooks are
signature-verified; sealed requests bind the generation, attempt, run, config,
runtime, and Git subject; and logs redact named/nested credentials and known
token shapes. A bounded private task-log tail is stored in Fly's SQLite
database so operator debugging survives workspace deletion; raw logs are not
attached to Linear or GitHub. GitHub branch protection and a fine-grained PAT
remain the outer enforcement layer.

The deterministic contract suite and Docker smoke are green locally. Live
Linear/Daytona/Fly acceptance is intentionally a separate deployment gate
because it consumes operator-owned credentials and account state.

OpenCode is an opt-in third engine. The first supported provider profile is
`model: kimi-code/kimi-for-coding` using `KIMI_CODE_API_KEY` from the Kimi Code
Console subscription endpoint (`https://api.kimi.com/coding/v1`), not a Kimi
Open Platform pay-as-you-go key or `kimi-k3` model ID. Production enablement
requires a live operator-owned check that this stable alias is currently backed
by K3 and authorized for OpenCode.
