# OpenThrottle supervisor

The Node 22 control plane accepts authenticated Linear and GitHub events and
runs filesystem-authored pipelines through one deterministic execution kernel.
It compiles an exact Git subject into an immutable DefinitionBundle, then
coordinates Attempts, Result/Decision/Delivery records, Effects, and
Checkpoints. Agent reasoning never runs in the supervisor.

## Develop and test

```bash
npm ci --prefix contracts
npm ci --prefix supervisor
npm run build --prefix contracts
npm run typecheck --prefix supervisor
npm test --prefix supervisor
npm run dev --prefix supervisor
```

The complete release proof also runs both Bats suites, builds the supervisor and
sandbox images, and runs the sandbox smoke, kernel sandbox E2E, and structured
walking skeleton listed in [`AGENTS.md`](../AGENTS.md). Those local harnesses use
stubbed or local boundaries; live publication, trusted provider wait, semantic
remediation, provider-backed cleanup, and Fly/SQLite behavior are exercised by
real dogfood rather than claimed by those harnesses.

Export the values from `.env.example`; the process does not load `.env`
implicitly. `GET /healthz` is public. Operator and deployment endpoints require
their configured bearer token, while webhooks require provider HMACs.

## Source boundaries

`src/index.ts` is the sole production composition root.

- `app/` owns admission, control, HTTP-facing services, release trust, and
  provider-neutral application ports.
- `http/` owns Hono routes, bounded request parsing, bearer/HMAC verification,
  and listener startup.
- `pipeline/kernel/` owns deterministic reduction and the shared action,
  record, effect, checkpoint, steering, and runtime-resource protocols.
- `persistence/` owns SQLite, the content-addressed BlobStore, and projections.
- `providers/` owns GitHub, Linear session-start, Codex-auth, and Daytona
  adapters. Linear webhook verification and normalization remain at the
  HTTP/application ingress boundary; later Linear status delivery is deferred.
- `operations/` owns leased, idempotent external-effect execution and
  reconciliation.
- `runtime/` owns the provider-neutral wire boundary.
- `shared/` owns bounded I/O and sanitization helpers.

Production code outside `persistence/` does not import `better-sqlite3` or issue
SQL. Daytona SDK imports stay under `providers/daytona`; Hono imports stay under
`http/`.

## Persistence

The live schema is a fresh execution epoch with exactly twelve tables:

```text
schema_migrations  settings  leases  repository_registrations
work_items         inbox_events  definitions  pipeline_runs
attempts           records       effects      checkpoints
```

Large immutable bundles, checkpoints, recovery material, and evidence are
written to the content-addressed blob root before SQLite commits their verified
hash pointer. There are no compatibility reads, dual writes, graph tables,
receipt tables, or online cutover state machine.

For the one-time empty dogfood epoch, build and inspect the packaged initializer:

```bash
npm run build --prefix supervisor
npm run epoch:initialize --prefix supervisor -- --help
```

Follow [the execution-kernel rollout runbook](../docs/runbooks/execution-kernel-rollout.md).
The initializer first publishes only to absent database/blob paths, seals an
empty bootstrap to the exact release, and starts ingress closed. A retry accepts
only the exact empty BlobStore partial or exact bootstrap-only closed pair.
Normal startup only opens and verifies an existing epoch.

## Deploy to Fly

`fly.toml` mounts the single-writer SQLite/blob volume at `/data`.
`openthrottle setup` provisions and verifies a pinned release but refuses the
first deploy until the one-shot initializer receipt has supplied
`OT_EPOCH_BOOTSTRAP_CHECKSUM`; `setup --check` is read-only. A manual
installation needs the supervisor/operator tokens, provider webhook secrets,
GitHub and Daytona credentials, a Daytona snapshot, and at least one supported
model credential.

```bash
fly volumes create openthrottle_data --region sjc --size 1
fly secrets set \
  SUPERVISOR_URL=https://<app>.fly.dev \
  OT_STATUS_TOKEN=<random> OT_DEPLOY_TOKEN=<random> \
  OT_EPOCH_BOOTSTRAP_CHECKSUM=<initializer-receipt-checksum> \
  LINEAR_WEBHOOK_SECRET=... LINEAR_CLIENT_ID=... LINEAR_CLIENT_SECRET=... \
  GITHUB_WEBHOOK_SECRET=... GITHUB_TOKEN=... GITHUB_READ_TOKEN=... \
  DAYTONA_API_KEY=... DAYTONA_SNAPSHOT=openthrottle \
  CODEX_AUTH_JSON='...'
```

Before the first deploy, run the exact candidate image's initializer against
the stopped volume, stage its emitted `OT_EPOCH_BOOTSTRAP_CHECKSUM`, and set the
repository variable `FRESH_EPOCH_INITIALIZED=true`. The [runbook](../docs/runbooks/execution-kernel-rollout.md)
contains the complete one-time sequence. After deployment, register the
repository while maintenance is closed and explicitly open ingress.

`.github/workflows/deploy.yml` builds a commit-named Daytona snapshot when the
sandbox, contracts, or definition tree changes, stages that exact snapshot,
and deploys the supervisor directly. Its deploy job is disabled until the
mechanical `FRESH_EPOCH_INITIALIZED` storage prerequisite is true. This flag is
not an acceptance gate and remains true after the one-time initialization.
After deploying with `--ha=false`, the workflow scales to one Machine and
verifies the sole data volume is attached to it. Later releases deploy directly
against the same exact open-only epoch.

## Repository onboarding

`openthrottle init` calls the authenticated registration endpoint. Registration
verifies the repository and base branch, creates or refreshes the GitHub
webhook, verifies the configured Daytona snapshot, and binds either a Linear
team or GitHub-Issue control route. Routing is fail-closed.

Registered repositories are trusted for code execution because
`.openthrottle/config.yml` may contain `post_bootstrap` commands. Ticket text,
Issue bodies, comments, review bodies, and agent candidates remain untrusted
data.

## Operator endpoints

- `GET /capabilities`
- `GET /repositories` and `POST /repositories/register`
- `GET /runs/:reference/status`, `/logs`, and `/analysis`
- `POST /runs/:reference/control`
- `GET /analysis/runs`
- `GET /maintenance`, `POST /maintenance/close`,
  `POST /maintenance/open`, and `GET /maintenance/active-work`
- `POST /webhooks/linear` and `POST /webhooks/github`

Full request, response, persistence, and recovery contracts live in
[docs/SPEC.md](../docs/SPEC.md).
