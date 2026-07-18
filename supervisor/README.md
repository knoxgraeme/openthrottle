# OpenThrottle Supervisor

The Node 22 control plane receives authenticated Linear/GitHub events, stores
them in a durable leased/retrying SQLite inbox, controls Daytona ticket
sandboxes, mirrors review/CI activity, and sweeps stale resources. Linear
OAuth refresh is shared across webhook and sweep paths, and outbound
Linear/GitHub calls have 15-second deadlines. A short-interval worker reads
agent activities and completion markers from active Daytona sandboxes.

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
  GITHUB_REPO=owner/name DAYTONA_API_KEY=... DAYTONA_SNAPSHOT=openthrottle
fly deploy
```

Add `CLAUDE_CODE_OAUTH_TOKEN` and/or `CODEX_AUTH_JSON` from subscription
logins. `DEFAULT_AGENT=codex` applies when the ticket has no agent label.
Linear credentials remain in Fly and are never passed into Daytona.

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

## GitHub webhook

Point a JSON webhook at `https://<app>.fly.dev/webhooks/github`, using
`GITHUB_WEBHOOK_SECRET`. Subscribe to pull requests, pull request reviews,
workflow runs, and check suites. The PAT needs repository contents and pull
requests read/write plus checks/actions read for status mirroring/guarded
merge. Keep branch protection enabled.

## Operator endpoints

`/status`, `/tickets/:id/stop`, and `/tickets/:id/logs` require
`Authorization: Bearer $OT_STATUS_TOKEN`. `/oauth/install` uses the separate
install token. Preview links and legacy callbacks carry scoped random credentials.
Stopping a ticket returns an error and preserves its active state if Daytona
cannot confirm the stop; PR-close cleanup is best-effort and still closes the
terminal ticket while recording cleanup failures.
Full endpoint and database contracts are in [docs/SPEC.md](../docs/SPEC.md).
