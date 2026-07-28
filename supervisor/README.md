# OpenThrottle Supervisor

The Node 22 control plane receives authenticated Linear/GitHub events and runs
the deterministic configurable pipeline coordinator. It pins an immutable
manifest, repository config snapshot, runtime descriptor, base commit, and
generation before provisioning; dispatches one fenced Daytona stage at a time;
reduces typed results; and persists effects before performing them.

Webhook deliveries, provider evidence, Linear publications, stage artifacts,
gate receipts, runtime resources, and effect intents are durable in SQLite.
Linear OAuth refresh is shared across webhook and sweep paths, and outbound
Linear/GitHub calls have bounded deadlines. A short-interval worker reads stage
results, activities, plans, and heartbeats from active Daytona sandboxes.

## Develop and test

```bash
npm ci
npm run typecheck
npm test
npm test -- src/__tests__/architecture.test.ts src/pipeline/manifest.test.ts src/pipeline/stage-request.test.ts src/runtime/contracts.test.ts
npm run dev
```

Export the values from `.env.example`; the process does not implicitly load
`.env`. `GET /healthz` is the only public operator endpoint.

## Source boundaries

`src/index.ts` is the sole composition root. It opens SQLite, builds the
composed supervisor and pipeline stores, constructs provider clients and the
Daytona runtime adapter, wires operations workers, and starts the HTTP server.
All other production modules live under an owning boundary:

- `app/` owns config, command/session orchestration, admission preflight, and
  provider-neutral application ports.
- `http/` owns Hono routes, listener startup, route auth, and durable webhook
  delivery leasing.
- `pipeline/` owns manifests, reducer/control logic, gates, stage requests,
  publication envelopes, and persistence capability contracts.
- `persistence/` owns SQLite bootstrap, schema, migrations, and concrete stores;
  production code outside this boundary does not import `better-sqlite3` or
  query legacy `runs`/`run_liveness` tables directly.
- `providers/` owns Linear, GitHub, Codex, and Daytona adapters; the Daytona SDK
  is confined to `providers/daytona`.
- `runtime/` owns provider-neutral runtime contracts, event polling, lifecycle,
  and steering.
- `operations/` owns reaping, sweeping, actor settlement, and retryable effect
  draining through neutral ports.
- `shared/` owns sanitization and bounded log constants.

`src/__tests__/architecture.test.ts` enforces these boundaries in Vitest.

## Deploy to Fly

`fly.toml` uses the `sjc` region, a persistent `/data` mount, and one always-on
shared machine so webhook acknowledgement and the in-process sweep remain
reliable.

```bash
fly volumes create openthrottle_data --region sjc --size 1
fly secrets set SUPERVISOR_URL=https://<app>.fly.dev \
  OT_STATUS_TOKEN=<random> OT_INSTALL_SECRET=<random> \
  LINEAR_WEBHOOK_SECRET=... LINEAR_CLIENT_ID=... LINEAR_CLIENT_SECRET=... \
  GITHUB_WEBHOOK_SECRET=... GITHUB_TOKEN=... GITHUB_READ_TOKEN=... \
  DAYTONA_API_KEY=... DAYTONA_SNAPSHOT=openthrottle
fly deploy
```

Add `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_JSON`, and/or `KIMI_CODE_API_KEY`
from subscription logins. `DEFAULT_AGENT=codex` applies when the ticket has no agent label.
Linear credentials remain in Fly and are never passed into Daytona.
Use a separate fine-grained `GITHUB_READ_TOKEN` with contents, pull-request,
checks, and Actions read access. Actions read powers CI-failure enrichment
(failing jobs, steps, and log tails); without it GitHub returns 403 on the
Actions endpoints and CI failures lose that detail. Read-only stages never
receive `GITHUB_TOKEN`.

## Automated deploys

`.github/workflows/deploy.yml` runs on every push to `main`:

- Changes under `sandbox/` or `skills/` build a commit-pinned Daytona snapshot
  named `openthrottle-v2-ce-<short-sha>` via
  `supervisor/scripts/build-snapshot.mjs` (the pinned `@daytona/sdk`, no CLI
  install), then stage `DAYTONA_SNAPSHOT` on the Fly app.
- The deploy job first ensures the Fly app and its `openthrottle_data` volume
  exist (idempotent — created only when missing), so a fresh account bootstraps
  itself instead of failing with `Could not find App`.
- Changes under `supervisor/` or the shared `contracts/` library (or a freshly
  built snapshot, whose staged secret applies on release) run `flyctl deploy
  --remote-only` against the same supervisor Fly app. `contracts/` is built as
  an input library, not deployed as a separate service.
- `workflow_dispatch` inputs force either half manually.

It needs the repository secrets `DAYTONA_API_KEY` and `FLY_API_TOKEN` (org-scoped
so it can create the app on first run), plus optional repository variables
`FLY_APP` (app name, default `openthrottle-supervisor`), `FLY_ORG` (org for
first-time creation, default `personal`), and `FLY_REGION` (volume region,
default `sjc`). Both `flyctl` deploy steps pass `--app` explicitly, so the
committed `fly.toml` app value never has to match.

The workflow does **not** set the runtime secrets — those are operator-owned and
still set once with `fly secrets set ...` (see [Deploy to Fly](#deploy-to-fly)).
Until they are set, the app and volume are created and the deploy releases, but
the `/healthz` check fails because the supervisor cannot start without its
configuration. Re-registering target repositories is still a manual step when
webhook event subscriptions change.

`DEFAULT_AGENT=opencode` and Linear label `agent:opencode` require
`KIMI_CODE_API_KEY`. That key must be a Kimi Code Console subscription key for
the OpenAI-compatible coding endpoint, not a Kimi Open Platform key.

## Linear app

Create an OAuth agent app with actor `app`, scopes `app:assignable` and
`app:mentionable`, redirect URL `https://<app>.fly.dev/oauth/callback`, and
Agent Session webhook `https://<app>.fly.dev/webhooks/linear`. Its receiver
must send `created` and `prompted` events and use the configured signing
secret.

Start installation without exposing the endpoint publicly:

```bash
curl -i -H "Authorization: Bearer $OT_INSTALL_SECRET" \
  https://<app>.fly.dev/oauth/install
```

Open the returned `Location` in a browser. Access tokens and refresh tokens
are stored in SQLite; access tokens are refreshed before expiry.

## Target repository onboarding

Run `openthrottle init` in each target checkout with `OT_SUPERVISOR_URL` and
`OT_STATUS_TOKEN`. The authenticated registration endpoint verifies the PAT's
access and requested base branch, creates or refreshes a JSON webhook at
`https://<app>.fly.dev/webhooks/github`, verifies that `DAYTONA_SNAPSHOT` is
active, and stores the Linear-team route in SQLite.

The PAT needs repository administration/webhooks read-write, contents and
pull requests read-write, and checks/actions read on every registered target.
The same `GITHUB_WEBHOOK_SECRET` signs each managed repository webhook. Keep
branch protection enabled. Routing is fail-closed: a Linear team without a
durable registration is rejected and never sent to a configured fallback.

## Operator endpoints

`/status`, `/repositories`, `/repositories/register`, `/tickets/:id/stop`, and
`/tickets/:id/logs` require
`Authorization: Bearer $OT_STATUS_TOKEN`. `/oauth/install` uses the separate
install token. The logs endpoint prefers sanitized live Daytona output and
falls back to the newest bounded private run tail. Publication retry uses
`/tickets/:id/publications/:publicationId/retry` and reopens only a persisted
failed receipt. Stop and PR-close flow through coordinator control/effect
intents; cleanup failures remain retryable and cannot resurrect the pipeline.
Full endpoint and database contracts are in [docs/SPEC.md](../docs/SPEC.md).
