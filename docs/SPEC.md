# OpenThrottle v2 — Architecture & Contracts

This is the cross-component source of truth. The GitHub repository remains
`knoxgraeme/openthrottle-v2`; the product, CLI, and package are named
`openthrottle`.

## Concept

An approved plan in Linear is delegated to the OpenThrottle app. The
always-on supervisor acknowledges it, creates one persistent Fly Sprite (a
named microVM) for the ticket, and starts Claude Code, Codex, or OpenCode. The
agent pushes an `ot/*` branch, opens a GitHub PR, and can resume in the same
sandbox/session when a human replies in Linear. Closing the PR deletes the
sandbox.

One ticket has at most one active run. Tickets may run in parallel.

## Components

```text
Linear AgentSessionEvent ──HMAC──> Fly supervisor ──Sprites REST──> sandbox
        ▲                            │    ▲                              │
        │ app-owned activities      │    └──── POST /runs/:id/{events,complete} ──┘
        │                            └──SQLite inbox/session/run/outbox state
        └──────────────────────────────── GitHub webhooks <──── PR/CI
```

- `supervisor/`: Node 22, Hono, SQLite, OAuth/webhook/lifecycle control.
- `sandbox/`: safety boundary, agent entrypoint, `provision.sh`, and
  normalizer; packaged into the supervisor's own Fly image and installed onto
  each Fly Sprite at provision time.
- `skills/`: canonical `implement`/`investigate` task adapters (`skills/tasks/<name>/SKILL.md`), delivered natively to Claude, Codex, and OpenCode.
- `cli/`: npm package `openthrottle` (`setup`, `init`, `ship`, `status`, `stop`, `logs`).

## Event flows

### New ticket

1. Linear sends a signed `AgentSessionEvent` with `action=created`.
2. The supervisor validates `Linear-Signature` and a 60-second timestamp
   window, durably inserts the raw payload under `Linear-Delivery`/`webhookId`,
   then returns HTTP 200. A leased worker handles it in the background with
   bounded exponential retries; duplicate deliveries reuse the stored row.
3. It durably enqueues an ephemeral `thought`, resolves the Linear team through
   durable repository registrations (then legacy env fallbacks), resolves agent
   labels, persists `promptContext`, inserts the ticket and current
   `agent_sessions` generation, and atomically claims a run bound to that
   session. A `branch` label overrides the route's base branch for that one
   ticket. It resolves from either a Linear label **group** named `branch` whose
   child is the branch name (the recommended, tidy form — the webhook carries
   only the child's leaf name, so grouped labels are resolved with their parent
   group through the `IssueLabels` GraphQL query), or a flat `branch › <name>`
   label (also `branch >`, `branch:`, `branch/`, matched directly from the
   webhook with no extra call). The branch name is validated and verified to
   exist on the resolved repository before the ticket captures it, so a missing
   or unsafe branch fails closed with a Linear error instead of a clone failure
   inside the sandbox; a failed group lookup degrades to the flat-label behavior.
   The `ot/<identifier>` working branch is always cut from the resolved base, and
   the PR is opened against it.
4. It creates (idempotently, by name) a private Fly Sprite `ot-<identifier>`
   (lowercased); the `tickets.sandbox_id` column stores that sprite name.
   There is no prebuilt image: on first create the supervisor uploads the
   sandbox payload tarball and runs `sandbox/provision.sh` (idempotent)
   against the live Ubuntu overlay, and applies a DNS egress allowlist scoped
   to the sprite. It then uploads the latest Linear context and per-run
   credentials and starts the requested task as a self-stopping Sprites
   service running `/opt/openthrottle/entrypoint.sh`.

### Follow-up

1. A signed `action=prompted` event carries the reply in
   `agentActivity.content.body` (legacy `agentActivity.body` is tolerated).
2. Native `signal=stop` and exact `/stop` bypass acknowledgement and prompt
   context mutation. Stop first records the run/session as stopped, cancels
   pending work, and enqueues one terminal response; sandbox cleanup is retried
   independently if it fails.
3. Exact `/merge` (or `merge it`) uses the guarded merge path when enabled.
   Exact `/implement` promotes the next run to `implement`; the legacy
   free-text heuristic (`fix it`/`implement`/`go ahead` anywhere in the reply,
   only recognized on an `investigate`-labeled ticket) remains a deprecated
   alias that logs a warning when it fires instead of the command. Other
   replies are deduplicated by Linear activity ID in `session_work`,
   acknowledged, and then claim a `resume` run in the existing sandbox when
   the session is idle. A busy session keeps the durable work row instead of
   requiring the user to resend it.

### Sandbox activity and completion

Each run receives a random one-time callback token; only its SHA-256 hash is
stored in the run table. Agents use `ot-activity` to write validated semantic
activity records and POST them to `POST /runs/:id/events` (bearer-authed with
the run callback token); the supervisor durably claims each one by `event_id`
in `sandbox_events` before projecting it into `linear_outbox`, using the run's
immutable Linear session binding. A late event from a superseded session is
consumed without publishing into the newer conversation. The entrypoint's
completion trap POSTs the same shape of payload (exit code, cost, PR URL,
sanitized final assistant response, and sanitized failure tail) to
`POST /runs/:id/complete`, gated by the same one-time callback token (once a
run is no longer `running`, its token no longer works). If a push fails, or
`SUPERVISOR_URL` is unreachable, the sandbox instead writes the event to an
on-disk outbox spool; the sweep drains any spooled events for an overdue run —
reusing the exact dedupe and projection the push endpoints use — before
declaring it timed out. Completion enqueues the first explicit terminal
activity when present, otherwise the captured final assistant response,
otherwise a generic terminal activity plus PR links through the Linear outbox.
If no result arrives by `TASK_TIMEOUT` plus grace, the sweep marks the run
timed out and enqueues the timeout error.
The run row also stores a bounded sanitized tail of the sandbox's
`~/.ot/task.log` (at most 100,000 characters) for authenticated operator
debugging after a sandbox is deleted. This private operator log is not
published to Linear or GitHub. Persisting a new tail clears older tails for
that ticket, bounding durable log storage to the latest captured run.

### GitHub/review lifecycle

- Closing or merging an `ot/*` PR stops an active run, deletes its sandbox,
  and closes the ticket row.
- All GitHub feedback on an active, PR-backed ticket becomes deduplicated
  `automatic` session work, each item carrying a triage message (act on clear
  fixes, answer non-actionable threads with reasoning, batch decision-required
  items into one elicitation, end with "Assumptions & decisions"): a human
  `CHANGES_REQUESTED` review, a non-self `commented` review (GitHub wraps
  every inline review comment in a `commented` review, so this also covers
  bot inline reviews), a new PR conversation comment, and a failed or
  timed-out `workflow_run`/`check_suite` conclusion. Dedup keys
  (`gh-review-<id>`, `gh-comment-<id>`, `gh-ci-<id>`) make repeated deliveries
  a no-op. Feedback authored by the `GITHUB_TOKEN` account itself is ignored
  (the account login is resolved once and cached; review/comment feedback
  fails closed if it cannot be resolved).
- An idle ticket (no active run) drains and launches the next item
  immediately; an active run picks it up on completion. Every launch is a
  **`resume` of the original session** — there is no separate task type or
  fresh context for feedback. The former two-tier `review`/`review-fix`
  choreography and the ticket's pending-re-review flag are gone.
- **Rounds bound.** One counter — `automatic`-source session-work items
  consumed per ticket — is bounded by `REVIEW_MAX_ROUNDS`; human-source
  replies are never bounded. Exhausting the bound cancels the queued item
  without launching and posts a "needs a human decision" message to both the
  Linear activity stream and the PR (best-effort).
- **Resolved-thread skip.** Before launching a review/comment-sourced
  automatic item, the supervisor checks its PR's review threads via `gh`; if
  every thread is already resolved (a prior resume may have addressed several
  queued items at once), the item is dropped instead of launched. A check
  failure launches anyway rather than dropping work.
- **External-reviewer nudge.** After a feedback-triggered resume completes
  cleanly (exit 0, no pending elicitation) with a PR, the supervisor
  optionally posts `REVIEW_NUDGE_COMMENT` on the PR to prompt the external
  reviewer bot/human to look again (e.g. `@codex review`). Never posted for
  human-triggered resumes, and never when the comment is unset (default:
  rely on the bot's own review-on-push behavior).
- **Missing-session resume.** A `resume` requires the saved native session
  (`~/.ot/agent-session-id`), which can be lost if the sandbox was recreated.
  When a resume fails for that reason, the supervisor posts a Linear error
  ("workspace was recreated — re-delegate to continue") instead of silently
  falling back to a fresh context.
- Webhook subscriptions cover `pull_request`, `pull_request_review`,
  `issue_comment`, `workflow_run`, and `check_suite`; repositories registered
  before `issue_comment` was added pick it up on the next
  `/repositories/register` (or `openthrottle init`) refresh.
- Review verdicts are PR comments, never GitHub approval/rejection state.
- Every completed `workflow_run`/`check_suite` and every submitted review is
  mirrored to Linear as an activity, regardless of whether it also becomes
  queued feedback work.

### Sweep

On boot and every 30 seconds, the supervisor drains new, failed, and
lease-expired webhook deliveries plus pending Linear outbox rows. A separate
boot and 15-minute lifecycle sweep expires callback-less runs, expires old
no-PR tickets, deletes old orphaned sandboxes (with a provisioning grace
window), and prunes old delivery records. A webhook delivery is retried at most
eight times; terminal failures remain visible in SQLite/logs and enqueue one
final error activity when its session is known. Linear outbox rows preserve
per-session sequence order and keep later rows pending behind a failed earlier
row until retry/redrive.

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
| `GET` | `/preview/:id?token=` | per-ticket token | wake and redirect to the org-private sprite URL |
| `POST` | `/runs/:id/events` | one-time run bearer | push sandbox activity |
| `POST` | `/runs/:id/complete` | one-time run bearer | consume run result |

Linear OAuth uses `actor=app`, scopes
`read,write,app:assignable,app:mentionable`, Bearer GraphQL auth, 24-hour
access tokens, and persisted refresh tokens. `agentActivityCreate` uses an
outbox-supplied UUID when available and
`content: {type, body}` or exact action fields `{type,action,parameter,result}`.
`agentSessionUpdate` passes the session as the mutation `id` and link arrays
inside `input`.

Fly Sprites uses `supervisor/src/sprites.ts`, a thin in-repo REST client (no
`@daytona/sdk` or `@fly/sprites` dependency). Per-run credentials are written
to a 0600 env file via `fs/write`, then `/opt/openthrottle/entrypoint.sh` is
launched as a self-stopping Sprites service
(`PUT /v1/sprites/:name/services/run`) that sources and deletes the env file
before running.

### Persistence

`tickets` stores identity/routing (including the resolved base branch, which
may be a per-ticket `branch › <name>` override of the route default),
sandbox/PR (the `sandbox_id` column holds the Fly Sprite name), state, current
run guard, aggregate cost, last error, preview-token hash, and latest Linear
prompt context. A `pending_re_review` column remains in the schema for existing
rows — no code reads or writes it anymore. `agent_sessions` stores each immutable
Linear AgentSession generation and marks the one current generation per issue.
`session_work` stores deduplicated human/automatic work by source id and
priority: a `source` column distinguishes human replies (`human`) from
GitHub-feedback items (`automatic`), and status moves `pending → claimed →
consumed`, or `canceled` when superseded by a stop, dropped as already
thread-resolved, or cut off by the rounds bound. Only consumed `automatic` rows
count toward `REVIEW_MAX_ROUNDS`; `human`-source work is never bounded. `runs`
stores immutable run identity plus the originating Linear session/generation,
task, hashed callback token, deadline, result, cost, PR and failure tail.
`webhook_deliveries` is a durable inbox
containing the validated payload, lease/retry state, attempt count, processing
result, and sanitized last error. `sandbox_events` stores idempotency/retry
state for validated sandbox records without persisting the raw one-time token.
`linear_outbox` stores all Linear activity/session-update mutations before
delivery, including UUID id, immutable payload hash, target session,
per-session sequence, retry state, and sanitized last error. `settings` stores
OAuth tokens and small supervisor settings.
`repository_registrations` durably maps one Linear team key (and optional
stable team ID) to a canonical GitHub `owner/name`, verified base branch,
managed webhook ID, and a retained `snapshot` placeholder column (Fly Sprites
has no image to verify, so registration instead runs a Sprites API
liveness/authorization probe before touching GitHub). Team ID lookup wins over
key; re-registering the same team updates the route atomically.
The global repository fallback is allowed only while no durable registrations
exist. Once onboarding is active, an unmatched team fails closed; explicit
legacy `GITHUB_REPO_MAPPINGS` entries remain valid during migration.
The `runs` table also stores a bounded sanitized `log_tail` for authenticated
operator debugging after a sandbox is deleted.
Migrations are additive for existing v2 databases; pre-inbox delivery rows are
preserved as already processed so an upgrade cannot replay them.

Ticket states: `active | closed | expired | error | stopped`.
Task types: `implement | resume | investigate`. `implement` and `investigate`
are the two loops; `resume` is the single continuation mechanism for either,
fed by a human reply or queued GitHub feedback.

### Environment

Required unless noted:

- HTTP/storage: `SUPERVISOR_URL`, `OT_STATUS_TOKEN`, `OT_INSTALL_SECRET`,
  `PORT=8080`, `DATABASE_PATH=/data/openthrottle.db`.
- Linear: `LINEAR_WEBHOOK_SECRET`, `LINEAR_CLIENT_ID`,
  `LINEAR_CLIENT_SECRET`.
- GitHub: `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN`, `GITHUB_REPO`; optional
  `GITHUB_REPO_LABEL_MAPPINGS` JSON maps Linear repo label names or suffixes
  to `owner/name`, and takes precedence when a matching repo label is present.
  `GITHUB_REPO_MAPPINGS` JSON maps Linear team id/key to `owner/name` as a
  legacy fallback. The token also needs webhook-administration permission for
  per-repository onboarding. Optional `OT_GIT_AUTHOR_NAME`/`OT_GIT_AUTHOR_EMAIL`
  override the sandbox commit author; unset, the sandbox authors commits as the
  `GITHUB_TOKEN` account's GitHub noreply identity so downstream author-gated
  integrations (e.g. Vercel) accept the deployment.
- Fly Sprites: `SPRITE_TOKEN` (org-scoped Sprites API token); optional
  `SPRITES_API_URL` (default `https://api.sprites.dev`) and
  `OT_PAYLOAD_TAR_PATH` (default `/app/payload.tar.gz`, the sandbox payload
  tarball baked into the supervisor's own Fly image).
- Agents: `CLAUDE_CODE_OAUTH_TOKEN` for Claude subscription login and/or
  `CODEX_AUTH_JSON` for Codex subscription login; `DEFAULT_AGENT=codex`.
- Limits: `BASE_BRANCH=main`, `MAX_TURNS=200`, `TASK_TIMEOUT=7200`,
  `CALLBACK_GRACE_SECONDS=120`, `DEV_PORT=3000`,
  `SWEEP_MAX_AGE_DAYS=14`, `ORPHAN_GRACE_MINUTES=5`,
  `WEBHOOK_MAX_AGE_SECONDS=60`, `REVIEW_MAX_ROUNDS=3`,
  `ALLOW_LINEAR_MERGE=false`.
  `REVIEW_MAX_ROUNDS` bounds `automatic` (GitHub-feedback) session-work items
  consumed per ticket. Optional `REVIEW_NUDGE_COMMENT` (default empty) is
  posted on the PR after a feedback-triggered resume completes cleanly, to
  prompt an external reviewer bot/human to look again; empty relies on the
  bot's own review-on-push behavior.

Fly keeps one machine running, mounts `/data`, and health-checks `/healthz`.

## Sandbox contract

### Environment

The supervisor passes `TASK_TYPE`, `AGENT`, `GITHUB_REPO`, `GITHUB_TOKEN`,
`BASE_BRANCH`, `BRANCH_NAME`, non-secret Linear issue identifiers, `RUN_ID`,
`RUN_CALLBACK_TOKEN`, `SUPERVISOR_URL` (a public URL, not a secret — it lets the
sandbox POST activity/completion callbacks), optional `RESUME_MESSAGE`, optional
`OT_GIT_AUTHOR_NAME`/`OT_GIT_AUTHOR_EMAIL`, model auth, and limit values
(`MAX_TURNS`, `TASK_TIMEOUT`, `DEV_PORT`). There is no per-run `PR_NUMBER` or
`REVIEW_ROUND` — feedback arrives as a `resume` and the agent re-derives PR
state itself (e.g. `gh pr view`). `SPRITE_TOKEN` and webhook/install/operator
secrets never enter the sandbox.

### Entrypoint phases

1. Materialize model auth files and strip trailing CR/LF from tokens.
2. Clone/fetch, create or resume `BRANCH_NAME`, and push it immediately.
3. Install and seal the pre-push boundary and configure token-safe Git auth.
4. Read `.openthrottle.yml` with supervisor-owned base branch unchanged.
5. Run `post_bootstrap` commands.
6. Register (or restart) the optional dev server as a Sprites service on
   `0.0.0.0`, so it survives sprite pause/wake.
7. Install OpenThrottle runtime adapters/instructions per agent, then run the
   selected task through the JSONL normalizer under `timeout`. Claude gets a
   fresh copy of the canonical `skills/tasks/*` directories under the sandbox
   user's `~/.claude/skills` (user scope) every run and is invoked with
   `-p "/<skill-name>"`. Codex discovers the same canonical skills natively
   from the provisioned admin-scope `/etc/codex/skills/<name>/` (each with an
   `agents/openai.yaml` setting `allow_implicit_invocation: false`, so a skill
   only runs when explicitly named) and is invoked with piped stdin naming the
   skill (`$<skill-name>`) followed by runtime-context and Linear-context
   blocks. OpenCode cannot yet load agent-standard skills from a sandbox-owned
   directory, so its prompt is rendered at run time by stripping the
   canonical file's YAML frontmatter and appending the same context blocks.
   `resume` bypasses all of this and continues the saved native
   session/thread directly with the follow-up message.
8. Remove temporary runtime MCP material, POST the completion payload to
   `POST /runs/:id/complete`, and fall back to an on-disk outbox completion
   marker (drained by the sweep) when the push fails.

Provisioning (`sandbox/provision.sh`, run idempotently the first time a
sprite is used) installs one pinned Compound Engineering marketplace checkout
and installs that same release natively into the sandbox user's Claude and
Codex profiles. OpenThrottle's task adapters remain outside the target checkout:
Claude adapters are installed in the sandbox user's home, while Codex gets
global runtime instructions in `~/.codex/AGENTS.md`. Claude receives a strict
temporary config containing only project-declared MCP servers with user-only
setting sources. Project `AGENTS.md` and `.claude/settings.json` files remain
untouched and editable.
The adapters compose native CE as follows: `implement` uses `ce-work`, local
`ce-code-review`, a conditional `ce-simplify` pass (invoked only when the
branch diff is large or structurally complex; behavior-preserving, with skips
recorded in the assumptions ledger), and `ce-commit-push-pr`; `investigate` uses action-capable
`ce-debug mode:pipeline` and, when it converges on a fix, the same
`ce-commit-push-pr` tail to ship it — divergent findings return as residuals
instead. Neither loop babysits its own PR (`ce-babysit-pr` and the internal
`review`/`review-fix` tasks are removed); once a PR exists, external
GitHub-native reviewers own review, and their feedback arrives back at the
same session as a `resume`, never a separate task or fresh context. Fly
remains responsible for run serialization and event publication.

The supervisor treats a loop purely as an interface — an entry task name, its
sandbox env contract, the `ot-activity` outbox events it may emit, and its
completion marker — never the loop's internal skill/CE composition; adding a
loop means registering a task name against a skill and CE pipeline
declaration, with no handler changes. Registered repositories are
code-execution-trusted (`post_bootstrap` runs arbitrary repository-configured
commands before the agent starts, and Codex's repo-scope `.agents/skills`
discovery stays enabled beside the admin-scope bake, since a checked-in skill
adds no capability beyond what `post_bootstrap` already grants); only ticket
text, PR comments, and review bodies remain untrusted data regardless of
where they are read from.

Adapters enforce a decision gate: critical, foundational, or risky changes
(schema/data migrations, auth/security behavior, public API or contract
changes, architecture rework, dependency changes, destructive operations, or
multiple defensible interpretations) are never implemented without a human
answer. Clear fixes ship first; remaining items go out as one batched
`elicitation` decision list whose Linear reply resumes the same session. No
item is backlogged — each ends fixed, answered on its thread, or escalated —
and every response and PR description ends with an "Assumptions & decisions"
section for human audit.
`implement`/`investigate` use fresh contexts; `resume` reads
`~/.ot/agent-session-id` and continues the same Claude session/Codex
thread/OpenCode session.

The normalizer captures session IDs and Claude `total_cost_usd`, writes
`~/.ot/run-result.json`, and sanitizes all output. Sanitizers redact named
secret env values, inner strings in `CODEX_AUTH_JSON`, GitHub/OpenAI/Linear
token shapes, and bearer credentials.

The checkout remote is a clean `https://github.com/owner/repo` URL. `gh auth
setup-git` supplies the current token through Git's credential helper, so no
GitHub token is written to `.git/config`; the sealed config never needs to be
changed when a sandbox resumes.

## CLI contract

- `openthrottle setup`: verify `SPRITE_TOKEN` with a live GET against the Fly
  Sprites API when local credentials are available, and print the one-time
  Fly secrets checklist. There is no snapshot to build or verify: the sandbox
  payload (entrypoint, `provision.sh`, runner, skills) is baked into the
  supervisor's own Fly image at deploy time and installed onto each sprite by
  `sandbox/provision.sh` on first use, so `.github/workflows/deploy.yml` has a
  single deploy job with no separate snapshot build/stage step.
- `openthrottle init`: run from a target GitHub checkout; detect its origin,
  base branch, package commands (or accept manual non-Node commands), write
  `.openthrottle.yml`, and call the authenticated supervisor registration
  endpoint. The supervisor pings the Fly Sprites API as a liveness/
  authorization probe, verifies repository/branch access, creates or
  refreshes its GitHub webhook, and persists the Linear-team route without a
  Fly restart. `init` no longer verifies or persists a snapshot.
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

1. No Linear OAuth/API credential, `SPRITE_TOKEN`, or webhook signing secret enters a sandbox.
2. The pre-push hook blocks main/master and non-fast-forward pushes; its path
   is root-sealed. GitHub branch protection remains required.
3. Logs and outbound agent-derived text are sanitized.
4. Every webhook is authenticated before side effects; operator endpoints
   require bearer auth and OAuth uses one-time state.
5. Run and preview credentials are random, stored hashed, scoped, and
   one-time or short-lived.
6. Each ticket sandbox runs in its own per-sprite Firecracker microVM; a DNS
   egress allowlist (`include: defaults` plus the supervisor callback host) is
   applied to every ticket sprite, and per-run credentials arrive via a 0600
   env file that the entrypoint sources then deletes.

## Verification contract

Node 22 CI runs TypeScript checks, Vitest contract/handler suites, Bats shell
tests, and a real Docker smoke. The smoke first checks the pinned real Claude
and Codex CLI versions/flags, then uses deterministic JSONL stubs to exercise
implement and same-session resume for all engines, clone/branch safety,
config, session/cost capture, activity/completion markers, and secret-leak checks.
Live Linear/Sprites/Fly acceptance remains a deployment gate because it
requires operator-owned accounts and secrets.
