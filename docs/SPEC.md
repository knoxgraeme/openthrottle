# OpenThrottle v2 — Architecture & Contracts

This is the cross-component source of truth. The GitHub repository remains
`knoxgraeme/openthrottle-v2`; the product, CLI, snapshot, and package are named
`openthrottle`.

## Concept

An approved plan in Linear is delegated to the OpenThrottle app. The
always-on supervisor acknowledges it, creates one private Daytona sandbox for
the ticket, and starts Claude Code, Codex, or OpenCode. The agent pushes an `ot/*` branch,
opens a GitHub PR, and can resume in the same sandbox/session when a human
replies in Linear. Closing the PR deletes the sandbox.

One ticket has at most one active run. Tickets may run in parallel.

## Components

```text
Linear AgentSessionEvent ──HMAC──> Fly supervisor ──@daytona/sdk──> sandbox
        ▲                            │    ▲                              │
        │ app-owned activities      │    └──── activity/result outbox ──┘
        │                            └──SQLite run/delivery/event state
        └──────────────────────────────── GitHub webhooks <──── PR/CI
```

- `supervisor/`: Node 22, Hono, SQLite, OAuth/webhook/lifecycle control.
- `sandbox/`: Node 22 image, safety boundary, agent entrypoint and normalizer.
- `skills/`: Claude skills plus Codex/OpenCode prompt mirrors.
- `cli/`: npm package `openthrottle` (`setup`, `init`, `ship`, `status`, `stop`, `logs`).

## Event flows

### New ticket

1. Linear sends a signed `AgentSessionEvent` with `action=created`.
2. The supervisor validates `Linear-Signature` and a 60-second timestamp
   window, durably inserts the raw payload under `Linear-Delivery`/`webhookId`,
   then returns HTTP 200. A leased worker handles it in the background with
   bounded exponential retries; duplicate deliveries reuse the stored row.
3. It posts an ephemeral `thought`, resolves the Linear team through durable
   repository registrations (then legacy env fallbacks), resolves agent labels, persists
   `promptContext`, inserts the ticket, and atomically claims a run.
4. It creates a private Daytona sandbox from `DAYTONA_SNAPSHOT`, labeled
   `openthrottle=true` and `ticket=<identifier>`. The image entrypoint is an
   inert no-op; Fly uploads the latest Linear context and run credentials,
   then explicitly starts the requested task in a Daytona process session.

### Follow-up

1. A signed `action=prompted` event carries the reply in
   `agentActivity.content.body` (legacy `agentActivity.body` is tolerated).
2. `/stop` stops the current run. Exact `/merge` uses the guarded merge path
   when enabled. Other replies claim a run and re-execute the entrypoint in
   the existing sandbox with `TASK_TYPE=resume`.
3. If a run is already active, the prompt is rejected with a polite activity;
   it is not queued.

### Sandbox activity and completion

Each run receives a random one-time callback token; only its SHA-256 hash is
stored in the run table. Agents use `ot-activity` to write validated semantic
activity records locally. The entrypoint writes a completion marker with exit
code, cost, PR URL, and sanitized failure tail. Every five seconds, Fly polls
only active runs through the Daytona SDK, durably claims each event, posts
activities as the OpenThrottle app, and consumes completion through the same
finalizer used by the legacy `POST /runs/:id/complete` endpoint. If no result
arrives by `TASK_TIMEOUT` plus grace, the sweep marks the run timed out.
Before finalizing an outbox completion, Fly reads a fixed-size tail of
`~/.ot/task.log`, sanitizes it (including the one-time callback token), and
stores at most 100,000 characters on the run row. This private operator log is
not published to Linear or GitHub. Persisting a new tail clears older tails for
that ticket, bounding durable log storage to the latest captured run.

### GitHub/review lifecycle

- Closing or merging an `ot/*` PR stops an active run, deletes its sandbox,
  and closes the ticket row.
- `needs-review` labels or `review_requested` start a fresh `review` task.
- A human `CHANGES_REQUESTED` review starts `review-fix`; a successful fix
  starts a fresh re-review.
- Implement and review-fix runs invoke bounded `ce-babysit-pr mode:pipeline`
  so actionable CI/review feedback can be repaired before Fly's next event.
- Review verdicts are PR comments, never GitHub approval/rejection state.
- Completed workflow/check-suite and submitted-review events are mirrored to
  Linear.
- Review rounds stop at `REVIEW_MAX_ROUNDS` and require human judgment.

### Sweep

On boot and every 30 seconds, the supervisor drains new, failed, and
lease-expired webhook deliveries. A separate boot and 15-minute lifecycle
sweep expires callback-less runs, expires old no-PR tickets, deletes old
orphaned sandboxes (with a provisioning grace window), and prunes old delivery
records. A delivery is retried at most eight times; terminal failures remain
visible in SQLite/logs and Linear receives one final error activity when its
session is known.

## Supervisor contract

### Endpoints

| Method | Path | Authentication | Purpose |
|---|---|---|---|
| `GET` | `/healthz` | public | liveness |
| `POST` | `/webhooks/linear` | Linear HMAC + freshness | agent events |
| `POST` | `/webhooks/github` | GitHub `sha256=` HMAC | PR/review/CI events |
| `GET` | `/oauth/install` | `OT_INSTALL_SECRET` bearer | start Linear OAuth |
| `GET` | `/oauth/callback` | one-time OAuth state | exchange/store token |
| `GET` | `/status` | `OT_STATUS_TOKEN` bearer | ticket list |
| `GET` | `/repositories` | `OT_STATUS_TOKEN` bearer | registered target list |
| `POST` | `/repositories/register` | `OT_STATUS_TOKEN` bearer | verify and upsert a target route/webhook |
| `POST` | `/tickets/:id/stop` | `OT_STATUS_TOKEN` bearer | stop a ticket |
| `GET` | `/tickets/:id/logs` | `OT_STATUS_TOKEN` bearer | sanitized live logs, falling back to the latest durable private run tail |
| `GET` | `/preview/:id?token=` | per-ticket token | wake and signed redirect |
| `POST` | `/runs/:id/complete` | one-time run bearer | consume run result |

Linear OAuth uses `actor=app`, scopes
`read,write,app:assignable,app:mentionable`, Bearer GraphQL auth, 24-hour
access tokens, and persisted refresh tokens. `agentActivityCreate` uses
`content: {type, body}` or exact action fields `{type,action,parameter,result}`.
`agentSessionUpdate` passes the session as the mutation `id` and link arrays
inside `input`.

Daytona uses `@daytona/sdk` `0.199.x`. Run env is updated with
`sandbox.updateEnv`, then `/opt/openthrottle/entrypoint.sh` is launched with
`executeSessionCommand(..., {runAsync:true})`.

### Persistence

`tickets` stores identity/routing (including the resolved base branch), sandbox/PR, state, current run guard,
aggregate cost, last error, preview-token hash, and latest Linear prompt
context. `runs` stores immutable
run identity plus task, hashed callback token, deadline, result, cost, PR and
failure tail. `webhook_deliveries` is a durable inbox containing the validated
payload, lease/retry state, attempt count, processing result, and sanitized
last error. `sandbox_events` stores idempotency/retry state for validated
outbox records without persisting the raw one-time token. `settings` stores
OAuth tokens and small supervisor settings.
`repository_registrations` durably maps one Linear team key (and optional
stable team ID) to a canonical GitHub `owner/name`, verified base branch,
managed webhook ID, and verified snapshot name. Team ID lookup wins over key;
re-registering the same team updates the route atomically.
The global repository fallback is allowed only while no durable registrations
exist. Once onboarding is active, an unmatched team fails closed; explicit
legacy `GITHUB_REPO_MAPPINGS` entries remain valid during migration.
The `runs` table also stores a bounded sanitized `log_tail` for authenticated
operator debugging after a sandbox is deleted.
Migrations are additive for existing v2 databases; pre-inbox delivery rows are
preserved as already processed so an upgrade cannot replay them.

Ticket states: `active | closed | expired | error | stopped`.
Task types: `implement | resume | review | review-fix | investigate`.

### Environment

Required unless noted:

- HTTP/storage: `SUPERVISOR_URL`, `OT_STATUS_TOKEN`, `OT_INSTALL_SECRET`,
  `PORT=8080`, `DATABASE_PATH=/data/openthrottle.db`.
- Linear: `LINEAR_WEBHOOK_SECRET`, `LINEAR_CLIENT_ID`,
  `LINEAR_CLIENT_SECRET`.
- GitHub: `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`, `GITHUB_REPO`; optional
  `GITHUB_REPO_MAPPINGS` JSON maps Linear team id/key to `owner/name` as a
  legacy fallback. The token also needs webhook-administration permission for
  per-repository onboarding.
- Daytona: `DAYTONA_API_KEY`, `DAYTONA_SNAPSHOT=openthrottle`.
- Agents: `CLAUDE_CODE_OAUTH_TOKEN` for Claude subscription login and/or
  `CODEX_AUTH_JSON` for Codex subscription login; `DEFAULT_AGENT=codex`.
- Limits: `BASE_BRANCH=main`, `MAX_TURNS=200`, `TASK_TIMEOUT=7200`,
  `CALLBACK_GRACE_SECONDS=120`, `DEV_PORT=3000`,
  `SWEEP_MAX_AGE_DAYS=14`, `ORPHAN_GRACE_MINUTES=5`,
  `WEBHOOK_MAX_AGE_SECONDS=60`, `REVIEW_MAX_ROUNDS=3`,
  `ALLOW_LINEAR_MERGE=false`, `SANDBOX_EVENT_POLL_INTERVAL_MS=5000`.

Fly keeps one machine running, mounts `/data`, and health-checks `/healthz`.

## Sandbox contract

### Environment

The supervisor passes `TASK_TYPE`, `AGENT`, `GITHUB_REPO`, `GITHUB_TOKEN`,
`BASE_BRANCH`, `BRANCH_NAME`, non-secret Linear issue identifiers,
`RUN_ID`, `RUN_CALLBACK_TOKEN`, optional `RESUME_MESSAGE`,
`PR_NUMBER`, `REVIEW_ROUND`, model auth, and limit values. Daytona/Fly keys
and webhook/install/operator secrets never enter the sandbox.

### Entrypoint phases

1. Materialize model auth files and strip trailing CR/LF from tokens.
2. Clone/fetch, create or resume `BRANCH_NAME`, and push it immediately.
3. Install and seal the pre-push boundary and configure token-safe Git auth.
4. Read `.openthrottle.yml` with supervisor-owned base branch unchanged.
5. Run `post_bootstrap` commands.
6. Start/restart the optional dev server on `0.0.0.0`.
7. Install OpenThrottle runtime adapters/instructions and run the selected
   task through the JSONL normalizer under `timeout`.
8. Remove temporary runtime MCP material and atomically write a completion
   marker for Fly to consume through Daytona.

The snapshot contains one pinned Compound Engineering marketplace checkout and
installs that same release natively into the sandbox user's Claude and Codex
profiles. OpenThrottle's task adapters remain outside the target checkout:
Claude adapters are installed in the sandbox user's home, while Codex gets
global runtime instructions in `~/.codex/AGENTS.md`. Claude receives a strict
temporary config containing only project-declared MCP servers with user-only
setting sources. Project `AGENTS.md` and `.claude/settings.json` files remain
untouched and editable.
The adapters compose native CE as follows: implement uses `ce-work`, local
`ce-code-review`, `ce-commit-push-pr`, and bounded `ce-babysit-pr`; review uses
report-only `ce-code-review`; review-fix uses `ce-resolve-pr-feedback` and
bounded `ce-babysit-pr`; investigate uses action-capable `ce-debug
mode:pipeline` and ships convergent fixes. Fly remains responsible for run
serialization, event publication, and fresh re-review scheduling.
Implement/review/review-fix/investigate use fresh contexts; resume reads
`~/.ot/agent-session-id` and continues the same Claude session/Codex thread.

The normalizer captures session IDs and Claude `total_cost_usd`, writes
`~/.ot/run-result.json`, and sanitizes all output. Sanitizers redact named
secret env values, inner strings in `CODEX_AUTH_JSON`, GitHub/OpenAI/Linear
token shapes, and bearer credentials.

The checkout remote is a clean `https://github.com/owner/repo` URL. `gh auth
setup-git` supplies the current token through Git's credential helper, so no
GitHub token is written to `.git/config`; the sealed config never needs to be
changed when a sandbox resumes.

## CLI contract

- `openthrottle setup`: verify the canonical Daytona snapshot when local
  credentials are available and print the one-time platform/Fly checklist.
  Snapshot creation is a one-time operator command from this repository:
  `daytona snapshot create openthrottle --dockerfile sandbox/Dockerfile --context .`.
- `openthrottle init`: run from a target GitHub checkout; detect its origin,
  base branch, package commands (or accept manual non-Node commands), write
  `.openthrottle.yml`, and call the authenticated supervisor registration
  endpoint. The supervisor verifies repository/branch access, creates or
  refreshes its GitHub webhook, verifies the configured Daytona snapshot is
  active, and persists the Linear-team route without a Fly restart.
- `openthrottle ship <file.md>`: create a Linear issue and, when
  `OT_AGENT_APP_ID` is set, delegate it with `IssueUpdateInput.delegateId`.
- `openthrottle status`: authenticated ticket table.
- `openthrottle stop <ticket>`: authenticated stop control.
- `openthrottle logs <ticket>`: authenticated sanitized live output, with the
  latest durable private run tail after workspace cleanup.

Target repository config:

```yaml
agent: codex
test: pnpm test
build: pnpm build
lint: pnpm lint
dev: pnpm dev --port 3000 --hostname 0.0.0.0
post_bootstrap:
  - pnpm install
limits:
  max_turns: 200
  task_timeout: 7200
mcp_servers: {}
```

`BASE_BRANCH` is supervisor-owned and is deliberately absent. The effective
base branch is captured in the durable registration and copied onto each
ticket so later runs remain stable if the route changes.

## Security invariants

1. No Linear OAuth/API credential, Daytona API key, or webhook signing secret enters a sandbox.
2. The pre-push hook blocks main/master and non-fast-forward pushes; its path
   is root-sealed. GitHub branch protection remains required.
3. Logs and outbound agent-derived text are sanitized.
4. Every webhook is authenticated before side effects; operator endpoints
   require bearer auth and OAuth uses one-time state.
5. Run and preview credentials are random, stored hashed, scoped, and
   one-time or short-lived.

## Verification contract

Node 22 CI runs TypeScript checks, Vitest contract/handler suites, Bats shell
tests, and a real Docker smoke. The smoke first checks the pinned real Claude
and Codex CLI versions/flags, then uses deterministic JSONL stubs to exercise
implement and same-session resume for all engines, clone/branch safety,
config, session/cost capture, activity/completion markers, and secret-leak checks.
Live Linear/Daytona/Fly acceptance remains a deployment gate because it
requires operator-owned accounts and secrets.
