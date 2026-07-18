# OpenThrottle Supervisor

The control-plane program: receives Linear/GitHub webhooks, creates/resumes
per-ticket Daytona sandboxes, and sweeps stale tickets. See
`../docs/SPEC.md` for the full cross-component contract this component
implements.

## Local development

```bash
npm install
cp .env.example .env   # fill in values, then export into your shell
npm run dev             # tsx watch src/index.ts
```

`GET /healthz` should return `{"ok":true}` once running.

## Before first deploy: verify the TODOs

This scaffold marks every Linear Agent API (Developer Preview) field and
every uncertain Daytona SDK call with `// TODO(verify-linear-api)` or
`// TODO(verify-sdk)`. Grep for them and confirm against live docs/schema
before pointing this at a real Linear workspace:

```bash
grep -rn "TODO(verify" src/
```

In particular:
- `src/linear.ts` — `agentActivityCreate` / `agentSessionUpdate` mutation
  input shapes, the `Linear-Signature` header format, and the OAuth
  `actor=app` authorize/token flow.
- `src/daytona.ts` — the resume-mode session exec call (`executeSessionCommand`
  env/runAsync fields) and the deterministic preview URL domain.

## Deploy to Fly

1. **Launch the app** (from this directory):
   ```bash
   fly launch --no-deploy --copy-config
   ```
   This reads `fly.toml`. Set/confirm the app name; `fly launch` may rewrite
   `app = "..."` in `fly.toml` — that's expected.

2. **Create the persistent volume** for the SQLite DB (must be in the same
   region as `primary_region` in `fly.toml`):
   ```bash
   fly volumes create openthrottle_data --region iad --size 1
   ```

3. **Set secrets** (everything in `.env.example` marked blank; do NOT put
   secrets in `fly.toml`):
   ```bash
   fly secrets set \
     LINEAR_WEBHOOK_SECRET=... \
     LINEAR_CLIENT_ID=... \
     LINEAR_CLIENT_SECRET=... \
     LINEAR_MCP_API_KEY=... \
     GITHUB_WEBHOOK_SECRET=... \
     GITHUB_TOKEN=... \
     GITHUB_REPO=owner/name \
     DAYTONA_API_KEY=... \
     DAYTONA_SNAPSHOT=openthrottle \
     CLAUDE_CODE_OAUTH_TOKEN=... \
     CODEX_AUTH_JSON="$(cat ~/.codex/auth.json)"
   ```
   (Use `ANTHROPIC_API_KEY` and/or `CODEX_API_KEY` instead of the OAuth
   token / auth JSON if that's what you have.)

4. **Deploy**:
   ```bash
   fly deploy
   ```

5. **Confirm** `https://<your-app>.fly.dev/healthz` returns `{"ok":true}`.

## Linear OAuth app setup (actor=app)

The supervisor implements the Linear "agent app" OAuth install flow at
`GET /oauth/install` (redirects to Linear's authorize screen) and
`GET /oauth/callback` (exchanges the code, stores the access token in the
`settings` DB table).

1. In Linear, create a new OAuth application (Workspace settings ->
   API -> OAuth applications; or the dedicated Agents/Apps section if your
   workspace has the Agent API developer preview enabled).
2. Set the app's callback/redirect URL to
   `https://<your-app>.fly.dev/oauth/callback`.
3. Copy the generated Client ID / Client Secret into
   `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` (via `fly secrets set`).
4. Configure the app's **webhook** to point at
   `https://<your-app>.fly.dev/webhooks/linear`, subscribed to Agent Session
   events (`created`, `prompted`). Copy the webhook signing secret into
   `LINEAR_WEBHOOK_SECRET`.
5. Visit `https://<your-app>.fly.dev/oauth/install` once, in a browser,
   logged into the target Linear workspace, and approve the app with
   **actor = app** (the app acts as itself, not as the installing user).
   This is what makes the app "delegatable" on issues.
6. `LINEAR_MCP_API_KEY` is a *separate* plain Linear API key (Settings ->
   API -> Personal API keys, or a workspace API key), used only inside the
   sandbox for the Linear MCP server — it is not the OAuth token.

TODO(verify-linear-api): the exact steps/labels in Linear's UI for
Developer-Preview Agent API apps may differ from the above; confirm against
https://linear.app/developers/agents before go-live.

## GitHub webhook setup

1. In the target repo (`GITHUB_REPO`) or its org: Settings -> Webhooks ->
   Add webhook.
2. Payload URL: `https://<your-app>.fly.dev/webhooks/github`.
3. Content type: `application/json`.
4. Secret: same value as `GITHUB_WEBHOOK_SECRET`.
5. Events: select just "Pull requests".
6. `GITHUB_TOKEN` should be a fine-grained PAT scoped to this repo with
   **Contents: Read and write** and **Pull requests: Read and write**.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/webhooks/linear` | Agent session events (`created`, `prompted`) |
| `POST` | `/webhooks/github` | `pull_request` events (acts on `closed`) |
| `GET` | `/healthz` | Liveness check |
| `GET` | `/status` | Read-only ticket list (used by `openthrottle status`) |
| `GET` | `/oauth/install` | Redirects to Linear OAuth authorize (actor=app) |
| `GET` | `/oauth/callback` | Linear OAuth code exchange |

## SPEC-DEVIATIONs

None. This component follows `docs/SPEC.md` as written; all points of
genuine external-API uncertainty are left as `TODO(verify-*)` markers in
the source rather than deviations, per the spec's own convention.
