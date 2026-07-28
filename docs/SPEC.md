# OpenThrottle specification

This document is the normative contract for the pre-production OpenThrottle
proof of concept.

## Concept

OpenThrottle turns an approved Linear delegation into an immutable,
deterministic coding pipeline:

```text
Linear delegation
  -> durable repository route + catalog selection
  -> pinned manifest/config/runtime/base commit/generation
  -> one fenced Daytona stage at a time
  -> typed artifacts and deterministic gates
  -> exact-subject GitHub publication/provider evidence
  -> durable Linear acknowledgement and resource cleanup
```

The Fly supervisor owns state, admission, ordering, retries, effects, and
publication. Agent reasoning lives only inside stage executors through native
Compound Engineering. There is no second execution architecture.

### Canonical vocabulary

- **Pipeline manifest:** a versioned stage graph selected from the catalog.
- **Pipeline instance:** one generation pinned to normalized manifest,
  repository config, runtime capability descriptor, repository, branch, and
  base commit digests.
- **Stage attempt:** one idempotent invocation fenced by instance, generation,
  stage, ordinal, request hash, run id, and expected Git subject.
- **Artifact:** bounded typed evidence with a normalized payload hash,
  assurance class, and optional Git subject.
- **Gate receipt:** the deterministic evaluator decision for an attempt.
- **Effect intent:** a persisted external action such as provisioning,
  dispatch, publication, stop, or cleanup.
- **Publication receipt:** a durable Linear or GitHub-facing publication with
  retry state.
- **Native session:** a Claude session, Codex thread, or OpenCode session used
  only when the manifest’s context policy permits continuation.

## Components

- `supervisor/`: Hono control plane, SQLite state, webhook inbox, coordinator,
  Daytona effects, GitHub provider handling, Linear outbox, sweep/recovery.
- `sandbox/`: sealed single-stage executor and agent runtime boundary.
- `skills/`: thin OpenThrottle adapters over the pinned native CE plugin.
- `cli/`: target-repository onboarding and operator commands.
- `supervisor/pipelines/`: immutable manifests, catalog aliases, and runtime
  capability descriptor.

## Admission and routing

1. Linear HMAC and timestamp freshness are verified before persistence.
2. A `created` agent-session event must contain an issue, session, and a durable
   `repository_registrations` match by Linear team id or key. Routing is
   fail-closed; no environment or label value may choose an arbitrary repo.
3. The branch label may override the registration’s base branch for this
   delegation. Agent labels select Claude, Codex, or OpenCode; `investigate`
   selects the investigate intent, otherwise the intent is implement.
4. The supervisor fetches the exact base commit and target `.openthrottle.yml`,
   validates both, resolves the repository’s pipeline alias against the catalog,
   validates runtime capabilities and credential scopes, then atomically pins
   the instance.
5. Re-delivery of the same session/generation is idempotent. A newer Linear
   generation supersedes the prior instance through a typed coordinator event
   and durable stop/cleanup effects. Failed selection does not replace the
   previous generation.

Supported ticket intents are `implement` and `investigate`. Pipeline selection
is unconditional for every new generation.

## Manifest and catalog contract

Pipeline YAML is strictly parsed with duplicate keys, aliases, unknown fields,
oversized documents, invalid identifiers, and invalid graph edges rejected.
Normalized JSON and SHA-256 digests are stored before execution.

Each `openthrottle.pipeline/v1` manifest declares:

- immutable `id`, integer `version`, `entry_stage`, `max_attempts`, and
  optional `max_repair_rounds`;
- required executor protocol and capabilities;
- optional `defaults.transitions` and `defaults.retry` authoring shortcuts that
  expand before normalization and digesting;
- ordered stages with executor/evaluator kind, assurance, required artifacts,
  context policy, live-steering flag, credential scopes, produced artifacts,
  and outcome transitions;
- bounded re-entry and an explicit exhausted outcome where a transition loops.
  New manifests should set `max_repair_rounds` as the primary whole-run repair
  bound; the coordinator enforces it only when scheduling a backward/self
  re-entry, so an already-moving repair round can reach command gates,
  publication, provider wait, or a terminal boundary. `max_attempts` remains a
  high raw-attempt safety net for genuine runaways. Per-transition
  `max_reentries` still bounds individual loops.

Allowed outcomes are `success`, `no_change`,
`semantic_repair_required`, `retryable_infrastructure_failure`, `needs_human`,
`canceled`, `superseded`, and `failure`. Terminal pipeline outcomes are
`shipped`, `no_change`, `needs_human`, `canceled`, `superseded`, and `failed`.
Every normalized stage has an explicit transition for every stage outcome. A
manifest-level `defaults.transitions` map may supply shared outcome
transitions, and a stage-level transition for the same outcome wins. Unknown
default outcome keys are rejected. The key `same_as` is reserved and rejected.
`defaults.retry: { max_reentries, on_exhausted }` and stage-level `retry`
expand to `retryable_infrastructure_failure` self-loops for the declaring
stage; the target is implied and cannot be authored.

Context policies are `none`, `fresh`, `resume_required`, and `prefer_resume`.
Assurance classes are `semantic_attested`,
`semantic_corroborated`, `executor_verified`, `provider_verified`, and
`human_approved`. An evaluator may accept only its declared assurance class.

Platform-authored pipelines use the `core/` namespace. CE remains the default
skill pack, but the `ce/` namespace is reserved for capability IDs such as
`core/implement@4`, `ce/review@1`, and `ce/publish@1`.

Catalog aliases resolve to exact manifest id/version pairs. Repository config
may override the implement or investigate alias, but cannot supply arbitrary
manifest bodies. Runtime compatibility is verified before provisioning.

## Coordinator lifecycle

The coordinator is a pure reducer around a transactional store:

1. Load the pinned instance, active stage/attempt, and normalized manifest.
2. Verify instance, generation, attempt id, request hash, result hash, event
   kind, subject fence, artifact declarations, artifact hashes/assurance, and
   stage-specific requirements.
3. Persist artifacts, one gate receipt, transition history, next attempt or
   terminal outcome, and resulting effect intents in one transaction.
4. Drain effects outside the reducer. Effects are idempotent and retryable.

A stage result cannot advance a provider-wait or human-evaluated stage.
Provider and human events cannot enter other stage kinds. Duplicate event ids
return the previously committed result; a stale generation, request, run, or Git
subject is rejected.

The default `core/implement@4` graph starts at implementation, then proceeds
through semantic review, a simplification stage that may no-op, configured
command gates, publication, and provider evidence. Semantic repair uses the
manifest's round-based repair budget and scoped repair re-entry. The default
`core/investigate@1` graph runs investigation, then conditionally publishes an
exact-subject result.

Provider feedback excludes supervisor-authored GitHub summary comments and
Linear bridge linkback comments; those are publication/linkage artifacts, not
human repair requests. A linkback is recognized only by the exact bridge bot
identity (`linear[bot]`, `linear-code[bot]`) or by a bot comment whose body
starts with the explicit `<!-- linear-linkback -->` marker — never by keyword
heuristics over untrusted comment bodies, so substantive automated review
feedback is still recorded as provider evidence. Human PR comments,
reviews requesting changes, Linear replies during provider waits, and failed
workflow/check-suite completions for the exact published commit remain
provider evidence and may start a bounded repair round. Feedback filed against a
superseded commit from the same pipeline instance, Linear session, and generation
may be carried forward only when that commit appears in acknowledged publication
history for the instance; unrelated heads and cross-instance or cross-generation
feedback remain stale and must produce an operator-visible activity instead of
being dropped silently.

## Effect and runtime-resource contract

External actions are persisted before execution. Provisioning creates one
Daytona resource for the instance, uploads sealed request/config/manifest
inputs, and records the resource binding. Dispatch atomically binds the planned
run id to the stage attempt and starts the sandbox entrypoint. When a transition
enters a non-dispatched wait such as provider evidence or human approval, an
`idle` effect may lower the bound sandbox to the idle autostop window while
leaving the instance runtime resource status as `active`; it is a best-effort
runtime side effect, not gate authority, and stale or failed idle work must not
block provider evidence, terminal controls, or repair dispatch. Stop must be
confirmed before cleanup; failed termination quarantines the resource rather
than pretending cleanup succeeded.

Runtime resource states and effect attempts are durable so process restart can
resume unfinished work. A new instance must not reuse another instance’s
resource. Ticket `sandbox_id` and `run_id` are projections used for operator
visibility and event polling, not coordinator authority.

Hard expiry uses `TASK_TIMEOUT`. Stalled actors are detected from actor state
on `runs` and `pipeline_stage_attempts` plus `STALL_TIMEOUT_SECONDS`. The sweep also resumes pending effects,
reaps expired runs, releases or quarantines resources safely, and removes
unbound Daytona orphans after `ORPHAN_GRACE_MINUTES`.

## Sandbox stage contract

The supervisor launches `/opt/openthrottle/entrypoint.sh` with paths to three
root-owned, read-only inputs:

- `OT_STAGE_REQUEST_FILE` — canonical `stage-executor@1` request;
- `OT_STAGE_CONFIG_FILE` — normalized repository config snapshot;
- `OT_STAGE_MANIFEST_FILE` — normalized pinned manifest.

The request includes pipeline/manifest/runtime/config identities; stage,
attempt, run, issue, session, and generation identities; ticket intent and
bounded task/transition context; repository, exact base commit, base branch,
working branch, and expected subject; agent and context policy; native session
id where allowed; capability, required artifacts, credential scopes, and live
steering permission; and a request hash/idempotency key covering the fence.

The entrypoint ignores conflicting ambient identity values and derives runtime
identity from the sealed request. It verifies input ownership/mode and all
digests before cloning. An initial stage starts from the exact sealed base
commit; later stages reconstruct the exact expected subject. Git safety config
is root-sealed.

Sandbox setup is split between bake-once and per-run work. `post_bootstrap`
commands and image-derived engine probes are bake-once: they execute exactly
once per sandbox lifetime and seal a root-owned completion marker recording
the repository-config digest they ran under. Every stage verifies that marker
before executing; a digest-mismatched, torn (started but never completed), or
otherwise inconsistent marker fails the stage closed — the sandbox no longer
matches its sealed config and the supervisor must reprovision it. There is no
silent re-bootstrap and no silent skip. Credential materialization, `gh`
credential-helper setup, commit identity, branch reconstruction, fence
validation, and the per-stage scrub of ignored agent-executable config
surfaces remain per-run; ignored dependency state installed by the bake-once
bootstrap persists for the sandbox lifetime under the recorded digest.

The executor runs exactly one stage:

- agent capabilities invoke the appropriate OpenThrottle adapter and native CE
  skill, under the manifest context policy;
- command capabilities invoke one validated `.openthrottle.yml` command;
- provider-wait stages run in the supervisor and do not launch a sandbox actor.

Agent proposals are strict JSON written to `OT_STAGE_PROPOSAL_FILE`. The runner
normalizes output, verifies produced artifact declarations and Git subject, and
writes one `stage_result` event to the supervisor-owned stage-result spool. It
does not call a completion HTTP endpoint or emit a task completion marker.

The supervisor also accepts run-bound `activity`, `plan`, and `heartbeat`
events. Every event is checked against the current ticket run and pipeline
attempt before processing; late events from older actors are discarded.

### Live steering

Exact Linear prompt text that is not `/stop` or `/merge` is retained while a
pipeline is running. When the active manifest stage declares `live_steering`, the
active run is fenced to that attempt, and the selected agent supports injection,
the retained message is leased and delivered as live steering. Messages captured
during a running non-steerable stage remain pending and unbound until a later
steerable stage can lease them, or until terminal cleanup cancels them.
Deliveries use the durable work store, bind to the pipeline
instance/attempt/run/context revision, and require an exact sandbox
acknowledgement before consumption. Actor exit expires and cancels
unacknowledged deliveries. Once steering has been leased to a run, it is sealed
to that owning run and attempt and never crosses that boundary into a later
actor.

Native session continuation is not steering and is not a task type. It is
selected solely by the next stage’s context policy and sealed native session id.

## GitHub provider contract

GitHub webhook HMAC is verified before durable delivery. PR open/reopen and
synchronize events establish the authoritative head for the ticket branch.
Reviews, PR comments, workflow runs, and check suites are stored as typed
provider evidence for the pipeline generation.

Provider evidence advances only an active provider-wait stage and only when its
head SHA equals the executor-verified published commit. The one same-run
exception is feedback captured against an earlier acknowledged publication from
the same pipeline instance, Linear session, generation, and pipeline-feedback
work item lineage; before claim, the snapshot is retargeted to the current
executor-verified published commit and then drained normally. Mismatched heads
outside that exception require human attention and enqueue a visible operator
activity before the snapshot is marked stale; evidence for a future stage remains
pending. A feedback snapshot is immutable once claimed and is consumed only after
the coordinator commits the provider event.

Linear replies sent while the current pipeline instance is in `waiting_provider`
are recorded on the same provider-feedback channel as GitHub evidence, with
provider `linear`, an idempotency identity derived from the Linear agent
activity id, and the executor-verified published commit as the head fence. The
sanitized, bounded reply body is carried in the provider event evidence/payload
so a repair stage receives it through sealed transition context rather than
session memory.

PR close is authoritative for ticket closure. If a stage actor is live, a typed
stop event schedules termination/cleanup; ticket/session/inbox closure does not
depend on a live attempt still existing. Optional merge-from-Linear is guarded
by `ALLOW_LINEAR_MERGE` and GitHub mergeability/check validation.

## Linear publication contract

Activities and terminal responses are persisted before network delivery and
ordered per Linear session. OAuth access tokens are refreshed using the stored
installation when required. Failures retry with bounded backoff. Pipeline
terminal acknowledgement uses a publication receipt; a failed receipt can be
reopened only by the authenticated operator retry endpoint.

Linear issue workflow state is a side-effect projection of the run lifecycle,
not coordinator authority. Workflow states are resolved dynamically from the
issue team by Linear workflow state `type`; state ids are never hardcoded.
Selection/dispatch projects the issue to the first `started` state only when
the current state is `triage`, `backlog`, or `unstarted`. Provider wait after PR
publication projects to the `started` state named `In Review` when present,
falling back to the first `started` state. A shipped terminal outcome or PR
merge webhook projects to the team's `completed` state. Failed and
needs-human terminal outcomes do not advance the issue to completed. Projection
delivery is idempotent and forward-only: issues already at or beyond the target,
or manually moved to `completed` or `canceled`, are skipped. Projection delivery
failures are logged and retried by the Linear outbox but never block the run,
publication, provider evidence handling, or terminal acknowledgement.

Published content is sanitized and bounded. Raw task logs, secret values, and
untrusted webhook bodies are never automatically attached to Linear or a PR.

## Supervisor HTTP contract

| Method | Path | Authentication | Purpose |
|---|---|---|---|
| `GET` | `/healthz` | public | process liveness |
| `POST` | `/webhooks/linear` | Linear HMAC + freshness | durable agent events |
| `POST` | `/webhooks/github` | GitHub `sha256=` HMAC | durable PR/review/check events |
| `GET` | `/oauth/install` | `OT_INSTALL_SECRET` bearer | begin Linear OAuth |
| `GET` | `/oauth/callback` | one-time OAuth state | exchange and store installation |
| `GET` | `/status` | `OT_STATUS_TOKEN` bearer | tickets and pipeline/effect/publication state |
| `GET` | `/repositories` | `OT_STATUS_TOKEN` bearer | registered routes |
| `POST` | `/repositories/register` | `OT_STATUS_TOKEN` bearer | verify and upsert route/webhook |
| `POST` | `/tickets/:id/stop` | `OT_STATUS_TOKEN` bearer | coordinator stop |
| `POST` | `/tickets/:id/steer` | `OT_STATUS_TOKEN` bearer | capture or queue steering |
| `GET` | `/tickets/:id/logs` | `OT_STATUS_TOKEN` bearer | sanitized live or durable bounded logs |
| `POST` | `/tickets/:id/publications/:publicationId/retry` | `OT_STATUS_TOKEN` bearer | reopen a failed receipt |

Bearer tokens are compared by hashed value with timing-safe equality. Webhook
deliveries are acknowledged after durable claim and processed asynchronously
through leases so restart does not lose accepted work.

`GET /status` returns one block per ticket. For tickets with a pipeline
instance, the nested `pipeline` object includes:

| Field | Meaning |
|---|---|
| `pipeline_id` | pinned pipeline manifest id |
| `pipeline_version` | pinned pipeline manifest version |
| `generation` | Linear session generation bound to the instance |
| `status` | current pipeline instance status |
| `terminal_outcome` | terminal pipeline outcome, or `null` while active |
| `stage_id` | active stage id, falling back to the latest attempt stage |
| `attempt_ordinal` | latest stage attempt ordinal |
| `reentry_ordinal` | latest stage re-entry ordinal |
| `wait_reason` | reason the pipeline is waiting, or `null` |
| `whose_move` | honest-ledger owner: `waiting on you`, `waiting on GitHub`, `working`, or `finished` |
| `published_pr_url` | published pull request URL when known |
| `last_error` | newest failed/dead effect or failed gate summary, sanitized and capped at 500 chars |
| `last_state_change_at` | pipeline instance state-change timestamp |

## Persistence contract

SQLite is the authority. Core tables include:

- ticket/run/session projections: `tickets`, `runs`, `agent_sessions`;
- durable transport: `webhook_deliveries`, `linear_outbox`, `session_inbox`,
  `sandbox_events`, `work_items`, `work_item_sources`, `work_deliveries`;
- provider evidence: `provider_events`, `feedback_snapshots`,
  `feedback_snapshot_events`;
- immutable selection: `pipeline_catalog_entries`, `pipeline_catalog_aliases`,
  `runtime_capability_descriptors`, `repository_config_snapshots`,
  `pipeline_instances`, `pipeline_instance_stages`;
- fenced execution: `pipeline_stage_attempts`, `pipeline_inbox_events`;
- evidence/effects: `pipeline_artifacts`, `pipeline_gate_receipts`,
  `pipeline_publication_receipts`, `pipeline_effect_intents`;
- cross-run orchestration history: `orchestration_journal`;
- operations: `repository_registrations`, `supervisor_leases`, `settings`,
  `schema_migrations`, `migration_reconciliation`.

`orchestration_journal` is append-only data capture, keyed by team,
repository, issue, and recorded time. Supervisor-owned orchestration decisions
use `actor = 'supervisor'` with null notes; notable agent proposal projections
use `actor = 'stage_agent'` with sanitized, bounded notes and structured
evidence references. The journal is queryable for operator or future
orchestrator inspection, but no coordinator transition, gate, or effect
scheduling logic may consume it as authority.

Schema migrations are transactional, checksum-pinned, and idempotent. Migration
code may recognize historical direct-run rows solely to reconcile an older
SQLite file conservatively. Such rows never participate in admission,
selection, routing, scheduling, status summaries, or sandbox execution. New
databases do not create the retired task-work table. Historical satellite
tables such as `run_liveness`, `session_executions`,
`pipeline_runtime_resources`, `run_stage_bindings`, and
`pipeline_work_bindings` remain in immutable migrations only; live state is
stored on the owning actor, session, instance, attempt, or work row.

Stage C child-unit work must add any needed live binding state to the owning
unit/work records rather than reviving empty historical binding tables.

## Supervisor environment

Required:

- HTTP/storage: `SUPERVISOR_URL`, `OT_STATUS_TOKEN`, `OT_INSTALL_SECRET`;
- Linear: `LINEAR_WEBHOOK_SECRET`, `LINEAR_CLIENT_ID`,
  `LINEAR_CLIENT_SECRET`;
- GitHub: `GITHUB_WEBHOOK_SECRET`, write-capable `GITHUB_TOKEN`, and
  read-only `GITHUB_READ_TOKEN`;
- Daytona: `DAYTONA_API_KEY`.

Optional/defaulted:

- `PORT=8080`, `DATABASE_PATH=/data/openthrottle.db`,
  `DAYTONA_SNAPSHOT=openthrottle`;
- `DEFAULT_AGENT=codex`, plus the selected agent credential:
  `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_JSON`, or `KIMI_CODE_API_KEY`;
- `TASK_TIMEOUT=7200`, `ORPHAN_GRACE_MINUTES=5`,
  `WEBHOOK_MAX_AGE_SECONDS=60`, `SANDBOX_EVENT_POLL_INTERVAL_MS=5000`,
  `STALL_TIMEOUT_SECONDS=900`, `ALLOW_LINEAR_MERGE=false`;
- `PIPELINE_CATALOG_PATH`, `SANDBOX_RUNTIME_RELEASE`, and
  `SANDBOX_RUNTIME_DESCRIPTOR_PATH` for pinned deployment assets.

Snapshot build automation uses `DAYTONA_SANDBOX_CPU=4`,
`DAYTONA_SANDBOX_MEMORY=8`, and `DAYTONA_SANDBOX_DISK=5` unless an operator
supplies another positive integer size.

Repository and base-branch routing are not environment configuration; they
must come from authenticated durable registration.

## Repository config

Committed `.openthrottle.yml` may declare `agent`, OpenCode `model`,
`test`/`lint`/`build`/`dev`/`format` commands, `post_bootstrap`, limits,
`mcp_servers`, and implement/investigate pipeline aliases. It is fetched from
the exact base commit, strictly validated, normalized, hashed, and uploaded as a
sealed snapshot. Registered repositories are trusted for code execution because
`post_bootstrap` is arbitrary code. `post_bootstrap` runs once per sandbox
lifetime under the bake-once marker (see Sandbox stage contract), not once per
stage.

## CLI contract

`openthrottle setup` verifies snapshot availability and prints the supervisor
secret checklist. `openthrottle init` detects the GitHub origin/default branch,
writes `.openthrottle.yml`, and idempotently registers the Linear-team route and
GitHub webhook. `openthrottle ship <plan.md>` creates and delegates a Linear
issue. `status`, `stop`, and `logs` call authenticated supervisor endpoints.

The CLI never creates per-project snapshots or configures routing fallbacks.

## Security invariants

- Ticket text, PR comments, reviews, commit messages, and repository content are
  untrusted data. Registered repository code itself is execution-trusted.
- Only credentials declared by the selected stage enter its sandbox. Daytona,
  Fly, Linear app, webhook, installation, and operator secrets remain in Fly.
- `repo.write` receives the write-capable GitHub token. `repo.read` and
  `provider.read` receive the separate read-only token unless the same stage
  explicitly declares `repo.write`.
- Git credentials use a helper and clean origin URL; `.git/config` and the
  pre-push hook are root-sealed.
- Pushes to main/master and non-fast-forward updates are rejected in the
  sandbox and should also be rejected by GitHub branch protection.
- Named/nested secrets and known GitHub/OpenAI/Linear/bearer token shapes are
  sanitized before logging or publication, including a Codex auth file rotated
  during the active stage.
- All external events are signature checked, durably deduplicated, and fenced
  to the current generation and subject before they can affect state; the only
  subject retargeting allowed is provider feedback from the same instance/session
  and generation against an acknowledged prior publication head.

## Verification contract

CI installs all four npm projects, typechecks/builds contracts, supervisor, and CLI, runs
all Vitest suites and Bats runtime tests, builds the sandbox image, and executes
the sealed multi-agent/command-stage Docker smoke. The smoke uses deterministic
stub agents and a local bare repository; it does not consume operator
credentials.

A credentialed Linear/Daytona/GitHub exercise is a separate explicitly
authorized acceptance step. If skipped, it is reported as a verification gap;
it does not activate or justify an alternate execution path.
