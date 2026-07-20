# OpenThrottle Supervisor

The Node 22 control plane receives authenticated Linear/GitHub events, stores
them in a durable leased/retrying SQLite inbox, controls per-ticket Fly
Sprites (persistent, name-addressed microVMs), mirrors review/CI activity,
and sweeps stale resources. Linear OAuth refresh is shared across webhook and
sweep paths, and outbound Linear/GitHub calls have 15-second deadlines. Linear
activities and session updates are persisted to a SQLite outbox before
delivery, with per-session ordering and retry. Sandboxes push agent activity
and completion events to the supervisor (`POST /runs/:id/events` and
`POST /runs/:id/complete`) instead of being polled; an on-disk outbox spool on
the sprite is a fallback the sweep drains for overdue runs.
The run row also persists a bounded sanitized task-log tail so operator
debugging survives sandbox deletion without posting raw logs to Linear or PRs.

## Develop and test

```bash
npm ci
npm run typecheck
npm test
npm run dev
```

Export the values from `.env.example`; the process does not implicitly load
`.env`. `GET /healthz` is the only public operator endpoint.

## Deploy to Fly

`fly.toml` uses the `sjc` region, a persistent `/data` mount, and one always-on
shared machine so webhook acknowledgement and the in-process sweep remain
reliable.

```bash
fly volumes create openthrottle_data --region sjc --size 1
fly secrets set SUPERVISOR_URL=https://<app>.fly.dev \
  OT_STATUS_TOKEN=<random> OT_INSTALL_SECRET=<random> \
  LINEAR_WEBHOOK_SECRET=... LINEAR_CLIENT_ID=... LINEAR_CLIENT_SECRET=... \
  GITHUB_WEBHOOK_SECRET=... GITHUB_TOKEN=... \
  GITHUB_REPO=owner/name SPRITE_TOKEN=...
fly deploy
```

Add `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_JSON`, and/or `KIMI_CODE_API_KEY`
from subscription logins. `DEFAULT_AGENT=codex` applies when the ticket has no agent label.
Linear credentials and `SPRITE_TOKEN` remain in Fly and are never passed into
a sandbox; `SUPERVISOR_URL` is passed in (it is a public URL, not a secret) so
the sandbox can push its callbacks.

## Automated deploys

`.github/workflows/deploy.yml` runs on every push to `main`:

- There is no separate snapshot build/publish step. The sandbox payload
  (entrypoint, `provision.sh`, runner, skills) is baked into the supervisor's
  own Fly image as `payload.tar.gz`, so changes under `sandbox/` or `skills/`
  trigger the same supervisor deploy as changes under `supervisor/`.
- The deploy job first ensures the Fly app and its `openthrottle_data` volume
  exist (idempotent — created only when missing), so a fresh account bootstraps
  itself instead of failing with `Could not find App`.
- The job runs `flyctl deploy --remote-only`.
- `workflow_dispatch` can force a deploy manually.

It needs the repository secret `FLY_API_TOKEN` (org-scoped so it can create
the app on first run), plus optional repository variables `FLY_APP` (app
name, default `openthrottle-supervisor`), `FLY_ORG` (org for first-time
creation, default `personal`), and `FLY_REGION` (volume region, default
`sjc`). The `flyctl deploy` step passes `--app` explicitly, so the committed
`fly.toml` app value never has to match.

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
`OT_STATUS_TOKEN`. The authenticated registration endpoint pings the Fly
Sprites API as a liveness/authorization check, verifies the PAT's access and
requested base branch, creates or refreshes a JSON webhook at
`https://<app>.fly.dev/webhooks/github`, and stores the Linear-team route in
SQLite.

The PAT needs repository administration/webhooks read-write, contents and
pull requests read-write, and checks/actions read on every registered target.
The same `GITHUB_WEBHOOK_SECRET` signs each managed repository webhook. Keep
branch protection enabled. `GITHUB_REPO`/`BASE_BRANCH` remain fallback values
until the first durable registration exists; `GITHUB_REPO_MAPPINGS` remains a
legacy static fallback. After durable onboarding is active, an unmatched team
is rejected instead of being sent to the global fallback repository.

## Operator endpoints

`/status`, `/repositories`, `/repositories/register`, `/tickets/:id/stop`, and
`/tickets/:id/logs` require
`Authorization: Bearer $OT_STATUS_TOKEN`. `/oauth/install` uses the separate
install token. Preview links and run callbacks carry scoped random credentials.
The logs endpoint prefers a live read from the sandbox and falls back to the
latest private run tail stored in SQLite.
Stopping a ticket records the run/session as stopped and enqueues the terminal
Linear response before sandbox cleanup; cleanup failure is logged for retry and
does not resurrect the run. PR-close cleanup is best-effort and still closes
the terminal ticket while recording cleanup failures.
Full endpoint and database contracts are in [docs/SPEC.md](../docs/SPEC.md).
