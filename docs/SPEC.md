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

### Canonical vocabulary

These terms are used consistently across every component contract below. The
Configurable Agentic Pipeline Coordinator plan introduces the pipeline/stage/
gate/attempt layer; the definitions here are the source of truth when a
component doc and that plan disagree.

- **Autonomous loop** — the durable ticket/event lifecycle from delegation to a
  terminal outcome. It is *not* a pipeline; it is the outer machine that drives
  one.
- **Pipeline** — the configured, versioned execution graph the loop runs. A
  pipeline is data (a validated manifest), not agent prose.
- **Stage** — one execution unit within a pipeline (an agent capability or a
  repository command).
- **Gate** — a transition condition evaluated over typed evidence. A gate is a
  deterministic decision the supervisor makes; an agent can produce evidence but
  never declares its own gate passed.
- **Attempt** — one immutable execution of a stage. A retry creates a new
  attempt, never mutates the prior one.
- **Resume** — a native-session continuation policy that continues the saved
  agent session/thread with a follow-up message. Resume is a context policy, not
  a pipeline or a task type.

The supervisor owns a **deterministic pipeline coordinator**: it validates
evidence and advances typed state transitions, but performs no semantic
reasoning. This is distinct from the
legacy `## OpenThrottle gates` PR checklist, which is agent-authored progress
prose — not a pipeline Gate. All agent reasoning stays inside explicitly
requested sandbox stages.
Runtime safety invariants (authentication, branch/push protection, one active
actor per ticket, fail-closed routing, minimal credentials, sanitization,
generation fencing) are non-configurable and are never expressed as product
gates.

## Components

```text
Linear AgentSessionEvent ──HMAC──> Fly supervisor ──@daytona/sdk──> sandbox
        ▲                            │    ▲                              │
        │ app-owned activities      │    └──── sandbox activity/result spool ──┘
        │                            └──SQLite inbox/session/run/outbox state
        └──────────────────────────────── GitHub webhooks <──── PR/CI
```

- `supervisor/`: Node 22, Hono, SQLite, OAuth/webhook/lifecycle control.
- `sandbox/`: Node 22 image, safety boundary, agent entrypoint and normalizer.
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
   labels, persists `promptContext`, and inserts the ticket and current
   `agent_sessions` generation. The legacy path atomically claims a run bound
   to that session; the pipeline path atomically pins its execution generation
   and first external effect instead. A `branch` label overrides the route's base branch for that one
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
4. In legacy mode it creates a private Daytona sandbox from `DAYTONA_SNAPSHOT`, labeled
   `openthrottle=true` and `ticket=<identifier>`. The image entrypoint is an
   inert no-op; Fly uploads the latest Linear context and run credentials,
   then explicitly starts the requested task in a Daytona process session.

While `PIPELINE_COORDINATOR_ENABLED=false` (the default), this is the legacy
path above. When admission is explicitly enabled for a new generation, the
supervisor first resolves the base branch to an exact commit, fetches and
validates `.openthrottle.yml` at that commit, pins catalog/config/runtime
digests, and atomically creates the pipeline instance, stage graph, first
attempt, and provision intent. Existing generations retain their pinned
`legacy` or `pipeline` mode across restart and flag changes. A durable effect
worker provisions and bootstraps the runtime, materializes only the stage's
declared credential scopes, acquires the ticket actor, and dispatches the
sealed stage request. The global admission flag and optional repository cohort
affect future generations only; disabling the flag never converts an active
pipeline generation to legacy.

### Pipeline stage lifecycle

The accepted catalog and independently built runtime descriptor must agree on
protocol and capabilities at supervisor boot. Aliases select immutable
manifest versions only for new generations. The CE v2 manifests split
implement into planning, implementation, semantic review, conditional
simplification, configured test/lint/build commands, exact-tree publication,
and a provider wait; investigate has a typed investigation and conditional
publication. Fixture command and agent manifests traverse the same coordinator
without CE-specific branches.

Each dispatched stage receives an immutable request envelope fenced by
instance, generation, task intent, stage, attempt, run, base commit and selected base branch,
manifest/config/capability digests,
task/transition context, context policy, credential scopes, and request hash. The sandbox independently
checks those values, writes hashed typed artifacts, and exposes the sealed
result through the sandbox event spool. The supervisor checks the observed Git
subject, required artifact set, assurance level, native-session policy, and
active attempt before committing a gate receipt and the next effect in one
transaction. Retries and repairs create new attempts and are bounded by the
manifest; provider feedback can re-enter only the configured repair edge.
Actionable reviews, comments, and red checks retain stable provider identities
in the shared feedback ledger. Events on one current head join an immutable
snapshot; arrivals after that snapshot is claimed collect for the next repair,
and a snapshot whose head has since changed is marked stale instead of reopening
the current revision. Pipeline snapshots advance the manifest edge directly and
never create legacy `session_work`.
The publish executor additionally proves that the remote branch head is the
local commit whose tree equals the gated subject, seals that commit separately,
and the supervisor pins it as the provider revision.
`fresh_review` always starts a separate native review context and invalidates
otherwise-successful evidence if that read-only stage changes the tracked tree.
An effect is acknowledged only after its provider action confirms success;
unconfirmed stop results remain retryable with their actor/resource ownership
intact. Successful and no-change terminal transitions enqueue idempotent runtime
cleanup; a delayed cleanup is fenced to its originating session before it can
clear the ticket's current sandbox binding.

A single green GitHub workflow is observational evidence, not terminal proof.
A failed or timed-out current-head check can trigger bounded repair; a merged
PR is the authoritative provider-success boundary for implement only when its
head equals the pinned executor-verified published commit. A later
`synchronize` to another head, or any merge/review evidence for another head,
fails closed to a human-required outcome rather than claiming the gated tree shipped. Linear and
GitHub publications use stable external IDs and durable receipts. Technical
terminal state remains completion-pending while a required publication is
retryable or permanently blocked.
Provider evidence that arrives during that publication-acknowledgement window
is durably deferred against the provider attempt and drained only after the
instance reaches `waiting_provider`.

### Follow-up

1. A signed `action=prompted` event carries the reply in
   `agentActivity.content.body` (legacy `agentActivity.body` is tolerated).
2. Native `signal=stop` and exact `/stop` bypass acknowledgement and prompt
   context mutation. Stop first claims the run into non-dispatchable `reaping`,
   confirms Daytona termination, then records the run/session as stopped,
   cancels pending work, and enqueues one terminal response. An unconfirmed
   termination remains quarantined with ticket exclusivity held.
3. Exact `/merge` (or `merge it`) uses the guarded merge path when enabled.
   Exact `/implement` promotes the next run to `implement`; the legacy
   free-text heuristic (`fix it`/`implement`/`go ahead` anywhere in the reply,
   only recognized on an `investigate`-labeled ticket) remains a deprecated
   alias that logs a warning when it fires instead of the command. Other
   replies are deduplicated by Linear activity ID in authoritative
   `work_items` (with a same-transaction `session_work` compatibility projection),
   acknowledged, and then claim a `resume` run in the existing sandbox when
   the session is idle. A busy session keeps the durable work row instead of
   requiring the user to resend it. On a busy session whose agent supports
   mid-run steering (Claude/Codex), the reply is additionally pushed to the
   `session_inbox` under the same activity ID (interrupt-on-send). The supervisor
   leases a fenced `work_delivery` and uploads its envelope; upload advances only
   to `dispatched`. The hook atomically journals the delivery/request hash after
   injection, and only the observed exact journal advances it to `acknowledged`.
   Completion consumes acknowledged work against that run and cancels the queued
   fallback (no double-apply). An unacknowledged delivery retries in the same
   context while its actor lives; if that actor ends first, one durable fallback
   owns the work in a continuation (or an operator steer is re-fenced there).

### Sandbox activity and completion

Each run receives a random one-time callback token; only its SHA-256 hash is
stored in the run table. Agents use `ot-activity` to write validated semantic
activity records locally: the five activity types (`thought`, `action`,
`elicitation`, `response`, `error`), plus `ot-activity plan "<content>=<status>"
…` which writes a `plan` event carrying a session-level checklist (Linear plan
statuses `pending`/`inProgress`/`completed`/`canceled`, replaced in full each
update). An `action` may carry a structured verb, parameter, and optional
result (`ot-activity action Ran "pnpm test" "583 passed"`), rendering as a real
Linear action rather than a flat "Progress" line; a single-argument action
stays a plain progress note. Independently, `runner/normalize.mjs` mirrors a throttled, ephemeral
`thought` for each meaningful agent step (a tool call, shell command, or file
edit) into the same outbox — a live "currently doing X" heartbeat that
self-replaces in the session and answers "stuck or working?" without cluttering
the permanent timeline (interval `OT_HEARTBEAT_INTERVAL_MS`, default 15s). This
is presentation progress, not liveness. A root-launched executor process emits
separate `heartbeat` records from a root-only directory from bootstrap through
exit even when the agent or command is quiet. Agent-writable outbox records
cannot impersonate this pulse; accepted records renew run liveness and are never
published as semantic activity. The entrypoint writes a completion marker with exit code,
cost, PR URL, sanitized
final assistant response, and sanitized failure tail. Every five seconds, Fly
polls only active runs through the Daytona SDK, durably claims each event, and
projects activities into `linear_outbox` using the run's immutable Linear
session binding; a `plan` event becomes an `agentSessionUpdate` carrying the
plan, and only `thought`/`action` activities may be marked `ephemeral`. A late event from a superseded session is consumed without
publishing into the newer conversation. Completion uses the same finalizer as
the legacy `POST /runs/:id/complete` endpoint and enqueues the first explicit
terminal activity when present, otherwise the captured final assistant response,
otherwise a generic terminal activity plus PR links through the Linear outbox.
If no result arrives by `TASK_TIMEOUT` plus grace, the sweep marks the run
timed out and enqueues the timeout error.
Every run start (workspace creation and every resume) re-asserts the session's
agent-owned external URLs via `agentSessionUpdate` — a full `externalUrls`
replace of the wake-on-click workspace preview (fresh per-ticket token) plus the
Pull Request link when one exists — so both stay visible and valid in whatever
run the user is viewing, not only the run that created the workspace. The
preview URL is also echoed into that run's "Started"/"Created workspace" action.
Opening the preview wakes the sandbox and runs `restart-dev.sh`, which probes
the dev server and, if it is down, (re)starts it from the repository's `dev:`
command (the workspace idling stops the server the run started). If it is
serving, the request redirects to the signed preview; if it was just restarted,
the endpoint returns an auto-refreshing "starting" page that opens the app once
it is ready; if the repository configures no `dev:` command, a clear note is
shown. The sanitized dev-server log accompanies both pages so any startup/crash
error is visible rather than a dead connection-refused link. A probe/restart
failure falls back to the plain redirect.

Before finalizing an outbox completion, Fly reads a fixed-size tail of
`~/.ot/task.log`, sanitizes it (including the one-time callback token), and
stores at most 100,000 characters on the run row. This private operator log is
not published to Linear or GitHub. Persisting a new tail clears older tails for
that ticket, bounding durable log storage to the latest captured run.

### GitHub/review lifecycle

- Pipeline generations route review comments, requested changes, current-head
  CI failures, PR synchronization, PR close, and merge through provider evidence and configured
  graph edges. They never enqueue the legacy automatic-resume choreography.
- Closing or merging an `ot/*` PR stops an active run, deletes its sandbox,
  and closes the ticket row. If a pipeline repair is active instead of waiting
  on the provider, the close is retained in the provider ledger and also
  creates a durable cancellation whose retries preserve `closed` as the
  ticket's final state.
- All GitHub feedback on an active, PR-backed ticket is retained under a stable
  provider identity. Events for the same ticket generation and PR head join one
  collecting snapshot. Recording the first event atomically creates the
  uniquely keyed pending `automatic` work item; claiming that immutable
  snapshot freezes membership and assigns exactly one repair round. The work
  item carries a triage message (gather the
  full review first via a `gh pr checks` snapshot and all open threads; reply
  visibly on every item — actioned items name the fixing commit and resolve the
  thread, no-change items give reasoning; run the local test/lint/build gates on
  the fix, push, and end the run — the run does not block on remote CI, because
  the supervisor watches the checks and re-delivers any failure as another
  `automatic` follow-up on the same session; refresh the PR's
  `## OpenThrottle gates` checklist; batch decision-required items into one
  elicitation; end with "Assumptions & decisions"): a human
  `CHANGES_REQUESTED` review, a non-self `commented` review (GitHub wraps
  every inline review comment in a `commented` review, so this also covers
  bot inline reviews), a new PR conversation comment, and a failed or
  timed-out `workflow_run`/`check_suite` conclusion. Events arriving after a
  claim form the next snapshot; old-head events remain auditable but cannot
  join current-head work. Provider identities make repeated deliveries a no-op
  without collapsing distinct workflow/check/review records. Feedback authored
  by the `GITHUB_TOKEN` account itself is ignored
  (the account login is resolved once and cached; review/comment feedback
  fails closed if it cannot be resolved).
- An idle ticket (no active run) drains and launches the next item
  immediately; an active run picks it up on completion. Every launch is a
  **`resume` of the original session** — there is no separate task type or
  fresh context for feedback. The former two-tier `review`/`review-fix`
  choreography and the ticket's pending-re-review flag are gone.
- **Drain recovery.** Completion is normally the only point that drains queued
  work for an active run, and it can skip that drain — deliberately (the run
  paused on an elicitation) or on a fault (no Linear client that moment, or a
  launch that released the item). The lifecycle sweep re-drains any idle,
  active ticket that still holds claimable pending work for its current
  session, so a single missed drain self-heals instead of stranding the
  feedback. Tickets whose last run parked on an unanswered elicitation are left
  pending — the sweep never resumes a session that is waiting on a human.
- **Rounds bound.** Claimed feedback snapshots own the repair counter; legacy
  consumed automatic work contributes to its initial value during migration.
  It is bounded by `REVIEW_MAX_ROUNDS`; human-source replies are never bounded.
  Exhausting the bound cancels the queued item
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
window), re-drains stalled work (idle active tickets with claimable
pending feedback whose last run did not park on an elicitation), and prunes old
delivery records. A webhook delivery is retried at most
eight times; terminal failures remain visible in SQLite/logs and enqueue one
final error activity when its session is known. Linear outbox rows preserve
per-session sequence order and keep later rows pending behind a failed earlier
row until retry/redrive. A separate ~60-second liveness reaper uses an exclusive
supervisor lease and the last sealed executor heartbeat, or `started_at` before
the first heartbeat. Its winner first moves the actor to non-dispatchable
`reaping`, confirms sandbox termination, and only then releases ticket
exclusivity and publishes failure. Failed termination remains visibly
`quarantined`; completion, stop, and reaper CAS losers perform no terminal side
effects. This is distinct from hard-timeout expiry. Mid-run steering
messages queued in `session_inbox` are delivered into running sandboxes on the
sandbox-event poll interval.

## Supervisor contract

### Endpoints

| Method | Path | Authentication | Purpose |
|---|---|---|---|
| `GET` | `/healthz` | public | liveness |
| `POST` | `/webhooks/linear` | Linear HMAC + freshness | agent events |
| `POST` | `/webhooks/github` | GitHub `sha256=` HMAC | PR/review/CI events |
| `GET` | `/oauth/install` | `OT_INSTALL_SECRET` bearer | start Linear OAuth |
| `GET` | `/oauth/callback` | one-time OAuth state | exchange/store token |
| `GET` | `/status` | `OT_STATUS_TOKEN` bearer | admission policy, execution summary, legacy-drain predicate, and ticket list |
| `GET` | `/repositories` | `OT_STATUS_TOKEN` bearer | registered target list |
| `POST` | `/repositories/register` | `OT_STATUS_TOKEN` bearer | verify and upsert a target route/webhook |
| `POST` | `/tickets/:id/stop` | `OT_STATUS_TOKEN` bearer | stop a ticket |
| `POST` | `/tickets/:id/steer` | `OT_STATUS_TOKEN` bearer | queue a fenced mid-run steering delivery for the running sandbox |
| `GET` | `/tickets/:id/logs` | `OT_STATUS_TOKEN` bearer | sanitized live logs, falling back to the latest durable private run tail |
| `GET` | `/preview/:id?token=` | per-ticket token | wake, restart the dev server if down, then redirect or show a status page |
| `POST` | `/runs/:id/complete` | one-time run bearer | consume run result |

Linear OAuth uses `actor=app`, scopes
`read,write,app:assignable,app:mentionable`, Bearer GraphQL auth, 24-hour
access tokens, and persisted refresh tokens. `agentActivityCreate` uses an
outbox-supplied UUID when available and
`content: {type, body}` or exact action fields `{type,action,parameter,result}`.
`agentSessionUpdate` passes the session as the mutation `id` and link arrays
inside `input`.

Daytona uses `@daytona/sdk` `0.199.x`. Run env is updated with
`sandbox.updateEnv`, then `/opt/openthrottle/entrypoint.sh` is launched with
`executeSessionCommand(..., {runAsync:true})`.

### Persistence

`tickets` stores identity/routing (including the resolved base branch, which
may be a per-ticket `branch › <name>` override of the route default),
sandbox/PR, state, current run guard, aggregate cost, last error,
preview-token hash, and latest Linear prompt context. A `pending_re_review`
column remains in the schema for existing rows — no code reads or writes it
anymore. `agent_sessions` stores each immutable Linear AgentSession generation
and marks the one current generation per issue. `schema_migrations` records each
ordered migration and its SHA-256 checksum; startup uses an exclusive SQLite
transaction and fails closed on checksum drift or an unknown newer version.
`work_items` is the authoritative semantic request. `work_deliveries` stores
immutable leased attempts bound to issue/session/run/native-session, generation,
context revision, request hash, and idempotency key. Its lifecycle is `leased →
dispatched → acknowledged → consumed`, with expired/canceled/dead terminals;
upload never implies acknowledgement. `work_item_sources` retains stable legacy
provenance, and `migration_reconciliation` records source/mapped/ambiguous counts.
`session_work` remains a same-transaction compatibility projection during drain:
a `source`
column distinguishes human replies (`human`) from GitHub-feedback items
(`automatic`), and status moves `pending → claimed → consumed`, or
`canceled` when superseded by a stop, dropped as already thread-resolved,
cut off by the rounds bound, or skipped because its ticket reached a terminal
state (`closed`/`expired`/`stopped`) before the queued work could launch — a
re-fetched terminal ticket never resumes into stale work. Only consumed
`automatic` rows seed the feedback-snapshot round count during migration;
`human`-source work is never bounded. `runs` stores
immutable run identity plus the originating Linear session/generation, task,
hashed callback token, deadline, result, cost, PR and failure tail.
`webhook_deliveries` is a durable inbox
containing the validated payload, lease/retry state, attempt count, processing
result, and sanitized last error. `sandbox_events` stores idempotency/retry
state for validated sandbox records without persisting the raw one-time token.
`provider_events`, `feedback_snapshots`, and `feedback_snapshot_events` retain
stable GitHub identities, current-head immutable membership, watermarks, and
one-round claims. `run_liveness` owns executor heartbeat and settlement/
quarantine state; `supervisor_leases` prevents overlapping reaper sweeps.
`pipeline_catalog_entries` makes each accepted `(pipeline_id, version)` digest
immutable while aliases may move for future instances.
`runtime_capability_descriptors` stores independently normalized runtime-release
evidence; manifests cannot add to that inventory.
`repository_config_snapshots`, `session_executions`, `pipeline_instances`,
`pipeline_instance_stages`, and `pipeline_stage_attempts` pin a generation's
exact manifest, base commit, repository blob/config, runtime protocol and
capabilities, execution task intent, gated tree, executor-verified published
commit, state version, stage/attempt ordinals, wait reason, and bounded
re-entry counters. `pipeline_inbox_events` and `pipeline_effect_intents` are the
typed transactional boundary: a reducer compare-and-set and its idempotent
external intents commit together, and dispatch leases can be reclaimed without
creating a second semantic intent. `pipeline_runtime_resources` durably binds
opaque provider resource IDs and lifecycle state to their instance. Artifact,
gate, publication, run, and work
binding tables use restricted foreign keys so audit-bearing parents cannot be
silently deleted. Existing generations are backfilled as `legacy`; a pipeline
generation and its instance are pinned in the same transaction.
`linear_outbox` stores all Linear activity/session-update mutations before
delivery, including UUID id, immutable payload hash, target session,
per-session sequence, retry state, and sanitized last error. `session_inbox` is
the compatibility projection for human/operator steering (`pending → dispatched
→ acknowledged`, or `canceled`); the hook writes processed journals under
`~/.ot/inbox-processed`. `settings` stores
OAuth tokens and small supervisor settings, including the durable Codex
`auth.json` (`codex_auth_json`). Codex's OAuth refresh token rotates on every
refresh, so `CODEX_AUTH_JSON` is only a bootstrap seed: the supervisor seeds
each fresh sandbox from the stored blob, reads back the token Codex rotated in
the sandbox on run completion, and reseeds later runs from it. Replaying the
frozen env snapshot would present an already-spent refresh token ("refresh
token was already used"). On resume, the supervisor seed and sandbox
`auth.json` are reconciled by account lineage and `last_refresh`: a strictly
newer compatible record wins in either direction, while incompatible accounts
fail closed before the agent starts. Before seeding, a near-expiry token is
refreshed centrally behind a single in-flight promise, so concurrent runs off
the one shared subscription account coalesce onto one refresh instead of racing
to spend the same token, and each run is handed the freshest token.
(This narrows but cannot fully close concurrency: two runs that both outlive the
access token still refresh independently inside their sandboxes. An OpenAI API
key, which does not rotate, is the fully-concurrent alternative to subscription
login.) Claude's `CLAUDE_CODE_OAUTH_TOKEN` is long-lived and non-rotating, so it
stays env-only with no durable state.
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
- Daytona: `DAYTONA_API_KEY`, `DAYTONA_SNAPSHOT=openthrottle`. Snapshot sizing
  is set when the snapshot is built (`supervisor/scripts/build-snapshot.mjs`)
  from optional `DAYTONA_SANDBOX_CPU=4` (cores), `DAYTONA_SANDBOX_MEMORY=8`
  (GiB), and `DAYTONA_SANDBOX_DISK=5` (GiB); the defaults clear Daytona's
  small default tier, which OOM-kills real pnpm/Turbo monorepo build and
  type-check gates (SIGKILL / exit 137). Disk is kept small because Daytona
  enforces a 30 GiB *total* org disk quota (not a per-sandbox cap) and
  OpenThrottle retains a stopped sandbox per non-closed ticket; raise it only
  on a plan with a larger quota. Right-size these per fleet.
- Agents: `CLAUDE_CODE_OAUTH_TOKEN` for Claude subscription login and/or
  `CODEX_AUTH_JSON` for Codex subscription login; `DEFAULT_AGENT=codex`.
- Limits: `BASE_BRANCH=main`, `MAX_TURNS=200`, `TASK_TIMEOUT=7200`,
  `CALLBACK_GRACE_SECONDS=120`, `DEV_PORT=3000`,
  `SWEEP_MAX_AGE_DAYS=14`, `ORPHAN_GRACE_MINUTES=5`,
  `WEBHOOK_MAX_AGE_SECONDS=60`, `REVIEW_MAX_ROUNDS=3`,
  `ALLOW_LINEAR_MERGE=false`, `SANDBOX_EVENT_POLL_INTERVAL_MS=5000`,
  `STALL_TIMEOUT_SECONDS=900`.
  `REVIEW_MAX_ROUNDS` bounds claimed GitHub-feedback snapshots per ticket
  generation, including preserved legacy counts. Optional `REVIEW_NUDGE_COMMENT` (default empty) is
  posted on the PR after a feedback-triggered resume completes cleanly, to
  prompt an external reviewer bot/human to look again; empty relies on the
  bot's own review-on-push behavior. `STALL_TIMEOUT_SECONDS` is the liveness
  cap: a running actor whose sealed executor heartbeat is silent for this long
  is claimed for reaping; before the first heartbeat, `started_at` is the
  liveness origin. Termination must be confirmed before release, otherwise the
  actor is quarantined, independent of the hard `TASK_TIMEOUT` wall clock.
- Pipeline admission: `PIPELINE_COORDINATOR_ENABLED=false`, optional
  comma-separated `PIPELINE_COORDINATOR_REPOSITORIES` canary cohort (an empty
  cohort means all routed repositories only when the flag is true), optional
  `PIPELINE_CATALOG_PATH` (defaults to the catalog shipped in the supervisor
  image), `SANDBOX_RUNTIME_RELEASE=openthrottle-snapshot/v1`, and optional
  `SANDBOX_RUNTIME_DESCRIPTOR_PATH` (the independently generated descriptor
  shipped for that runtime release). The supervisor
  validates and durably accepts the full catalog against the independently
  built runtime capability descriptor at boot even while admission is off;
  reusing an accepted pipeline version or runtime release with different
  normalized content fails startup.

Fly keeps one machine running, mounts `/data`, and health-checks `/healthz`.

## Sandbox contract

### Environment

For legacy execution the supervisor passes `TASK_TYPE`, `AGENT`, `GITHUB_REPO`, `GITHUB_TOKEN`,
`BASE_BRANCH`, `BRANCH_NAME`, non-secret Linear issue identifiers, `RUN_ID`,
`RUN_CALLBACK_TOKEN`, optional `RESUME_MESSAGE`, optional
`OT_GIT_AUTHOR_NAME`/`OT_GIT_AUTHOR_EMAIL`, model auth, and limit values
(`MAX_TURNS`, `TASK_TIMEOUT`, `DEV_PORT`). There is no per-run `PR_NUMBER` or
`REVIEW_ROUND` — feedback arrives as a `resume` and the agent re-derives PR
state itself (e.g. `gh pr view`). Daytona/Fly keys and webhook/install/operator
secrets never enter the sandbox.

For pipeline execution it instead seals `OT_STAGE_REQUEST_FILE` and the exact
manifest/config digests, provisions a deterministic process-session identity,
and materializes only the declared model/repository/provider scopes. Daytona,
Fly, Linear, webhook, install, and operator credentials remain unavailable.

### Entrypoint phases

1. Materialize model auth files and strip trailing CR/LF from tokens.
2. Clone/fetch, create or resume `BRANCH_NAME`, and push it immediately.
3. Install and seal the pre-push boundary and configure token-safe Git auth.
4. Read `.openthrottle.yml` with supervisor-owned base branch unchanged, and
   export a default `TURBO_CONCURRENCY=50%` (only when unset) so heavy
   Turbo-driven build/lint/test gates stay within the sandbox memory cgroup;
   a repo can override it in `post_bootstrap`.
5. Run `post_bootstrap` commands.
6. Start/restart the optional dev server on `0.0.0.0`.
7. Install OpenThrottle runtime adapters/instructions per agent, then run the
   selected legacy task or one fenced stage through the JSONL normalizer under
   `timeout`. A fenced stage invokes exactly its advertised capability and
   emits the typed artifacts required by its evaluator. Claude gets a
   fresh copy of the canonical `skills/tasks/*` directories under the sandbox
   user's `~/.claude/skills` (user scope) every run and is invoked with
   `-p "/<skill-name>"`; its user-scope `~/.claude/settings.json` also
   registers the baked `hooks/ot-inbox-drain.sh` as a `Stop`/`PostToolUse`
   hook that drains `~/.ot/inbox` and injects any queued mid-run steering,
   framed as guidance the agent weighs and acknowledges (never commands that
   override its task, plan, or safety) and blocking `Stop` so a run cannot end
   with unread steering. Codex registers the same drain hook via `~/.codex/hooks.json`
   (run with `--dangerously-bypass-hook-trust` when the pinned Codex advertises
   it); OpenCode steering delivery is a documented follow-up.
   Codex discovers the same canonical skills natively
   from the image-baked admin-scope `/etc/codex/skills/<name>/` (each with an
   `agents/openai.yaml` setting `allow_implicit_invocation: false`, so a skill
   only runs when explicitly named) and is invoked with piped stdin naming the
   skill (`$<skill-name>`) followed by runtime-context and Linear-context
   blocks. OpenCode cannot yet load agent-standard skills from a sandbox-owned
   directory, so its prompt is rendered at run time by stripping the
   canonical file's YAML frontmatter and appending the same context blocks.
   `resume` bypasses all of this and continues the saved native
   session/thread directly with the follow-up message.
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
For legacy generations, the adapters compose native CE as follows: `implement` uses `ce-work`, local
`ce-code-review`, a conditional `ce-simplify-code` pass (invoked only when the
branch diff is large or structurally complex; behavior-preserving, with skips
recorded in the assumptions ledger), and `ce-commit-push-pr`; `investigate` uses action-capable
`ce-debug mode:pipeline` and, when it converges on a fix, the same
`ce-commit-push-pr` tail to ship it — divergent findings return as residuals
instead. Neither loop babysits its own PR (`ce-babysit-pr` and the internal
`review`/`review-fix` tasks are removed); once a PR exists, external
GitHub-native reviewers own review, and their feedback arrives back at the
same session as a `resume`, never a separate task or fresh context. Fly
remains responsible for run serialization and event publication. For pipeline
generations, the same canonical adapters route each advertised capability to
the corresponding CE operation; command gates and provider waits stay outside
the agent boundary.

The supervisor treats a pipeline as an accepted manifest plus independently
advertised runtime capabilities, never as hard-coded skill composition. Adding
a pipeline or fixture means adding catalog data that validates against that
inventory, with no coordinator handler changes. A single
`skills/task-adapters-v1.json` registry remains only for legacy-generation
task-to-adapter compatibility until the cross-domain drain predicate has held;
the former scheduler `LOOP_REGISTRY` and shell mapping functions are removed.
Registered repositories are
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
item is backlogged — each ends fixed and pushed with a reply naming the fixing
commit, answered on its thread, or escalated. Remote CI is the supervisor's to
watch, not the run's to block on: after the local test/lint/build gates pass and
the push lands, the run ends, and the supervisor re-delivers any failing check
to the same session as a follow-up `resume` (bounded by `REVIEW_MAX_ROUNDS`) —
the adapter never sits in `gh pr checks --watch`. Every run also
writes or refreshes an `## OpenThrottle gates` checklist in the PR description
(tests, lint, build, internal review, simplification, CI, review threads) so a
human can see which gates completed; a gate that could not run — e.g. one the
sandbox OOM-killed (exit 137) — is recorded as a known gap, never reported as
passed. Every response and PR description ends with an "Assumptions &
decisions" section for human audit.
`implement`/`investigate` use fresh contexts; `resume` reads
`~/.ot/agent-session-id` and continues the same Claude session/Codex
thread/OpenCode session.

The normalizer captures session IDs and Claude `total_cost_usd`, writes
`~/.ot/run-result.json`, emits throttled ephemeral progress
described under "Sandbox activity and completion", and sanitizes all output
(the heartbeat body included). Sanitizers redact named secret env values, inner
strings in `CODEX_AUTH_JSON`, GitHub/OpenAI/Linear token shapes, and bearer
credentials.

The checkout remote is a clean `https://github.com/owner/repo` URL. `gh auth
setup-git` supplies the current token through Git's credential helper, so no
GitHub token is written to `.git/config`; the sealed config never needs to be
changed when a sandbox resumes.

## CLI contract

- `openthrottle setup`: verify the canonical Daytona snapshot when local
  credentials are available and print the one-time platform/Fly checklist.
  Snapshot creation is an operator command from this repository
  (`daytona snapshot create <name> --dockerfile sandbox/Dockerfile --context .`)
  and is automated on `main` by `.github/workflows/deploy.yml`, which builds
  commit-pinned `openthrottle-v2-ce-<short-sha>` snapshots through
  `supervisor/scripts/build-snapshot.mjs` and stages the `DAYTONA_SNAPSHOT`
  secret before the Fly deploy releases it.
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
