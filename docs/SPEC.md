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

Repository-authored graphs may reference committed repository skills only
through `repo://<skill-id>`. The repository config owns the allowlist that maps
each skill id exactly to `.openthrottle/skills/<skill-id>`, a committed
directory containing `SKILL.md`; ticket text cannot choose a skill path and a
second `.agents/skills` copy is never generated. Admission resolves that
directory at the exact pinned base
commit, fetches the bounded package closure as regular files, rejects traversal,
path escape, symlinks, oversized or undeclared entries, and pins every accepted
blob plus the package digest. Repository skill identity is separate from runtime
execution authority: compiled stages use the platform-owned
`agent/repository-skill@1` capability while carrying the canonical repository
skill reference, invocation name, pinned package files, and package digest in
the manifest and sealed request. Production advertises `agent/repository-skill@1`
in its installed runtime capability descriptor, so a `run` node backed by a
repository skill is reachable through the existing whole-attempt dispatch path.
Compiler-produced repository manifest identity includes an explicit compiler
identity version in addition to the pinned graph id, path, and blob. Any
compiler change that alters normalized manifest bytes bumps that identity
version instead of reusing an already-accepted immutable catalog key. Builtin
graph compilation is a parity check against the canonical catalog manifest and
does not publish repository-only ordinary loop bindings.
Builtin `run` skills must name an installed whole-stage dispatch adapter (or
the intentional generic `agent/semantic@1` executor). Structured builtin phase
skills are exact: `implement` uses `ce/implement@1`, `simplify` uses
`ce/simplify@1`, and `lead` uses `accept-unit@1`; pinned repository skills are
the only configurable alternative. A repository graph's ordinary `run` loop
is accepted only when its `timeout_seconds` equals the effective existing hard
deadline—the lesser
of supervisor `TASK_TIMEOUT` and repository `limits.task_timeout` (default
7,200 seconds)—because per-loop ordinary-stage deadlines are not yet carried
through the sealed stage protocol. Admission rejects any mismatch. Repository
ordinary `run` loop scope is fixed by its dispatch adapter: semantic,
implementation, planning, publication, investigation, and pinned repository
skills use `graph`, while review and simplification use `diff`. The `review`
scope and every adapter/scope mismatch are rejected until a sealed request
projection can enforce them.
For ordinary stages, `max_rounds` bounds repeat entries into the stage
independently of the graph transition and manifest-wide retry/repair safety
limits; the first forward entry is not a repeat round, and the first exhausted
bound wins.
Directly loaded `PIPELINE_CATALOG_PATH` manifests reject ordinary stage loop
bindings because their repository-specific effective timeout cannot be proven
at catalog load time; ordinary loop bindings are admitted only through
repository graph compilation and its timeout-equality check.
Structured unit repair cycles rerun each declared loop-backed phase in the
repair sequence (`implement`, optional `simplify`, and `lead`), so their durable
repair budget is the minimum of those phases' authored `max_rounds`; the first
repeated-phase bound exhausted wins. Whole-change final-review repair is a
distinct internal loop with its own one-round bound; it never borrows the unit
repair budget.
Internal whole-change final review and repair bindings do not declare an
independent timeout, so their sealed action timeout inherits the supervisor
`TASK_TIMEOUT` hard resource bound.
The composite `graph/for-each-unit@1` capability (structured multi-unit
execution) is installed only with the composition root that constructs and
drains the child unit runtime. A composite host stage dispatches no
whole-stage sandbox request; entering it provisions/bootstrap the runtime,
binds the parent actor, seeds one child execution graph from the sealed
execution-plan block and graph-declared phase sequence, and drains child work
actions through the provider-neutral unit effect port.
For a `for_each_unit` node, the repository graph owns the ordered `phases`
array. The platform owns the closed mechanism vocabulary and the security
contract behind each mechanism:

- `agent`: one sealed `loop-action@2` invocation in the unit worktree, using a
  declared unit loop and its pinned worker/skill/MCP/credential/session scope.
- `command`: one or more repository-configured command names, run by the
  executor without model credentials.
- `evidence`: executor-derived typed evidence such as candidate evidence.
- `gate`: a read-only decision phase evaluated against required receipts by
  the supervisor gate code; graph configuration cannot waive receipt checks.
- `integrate`: executor-only Git integration authority; this phase is never
  agent-writable.

The phase list is non-empty, bounded, and limited to the platform vocabulary.
Agent and gate phases reference declared loops; command phases name configured
repository commands. `implement`, `candidate`, `lead`, and `integrate` are
required, `lead` immediately precedes `integrate`, `candidate` precedes `lead`,
and `integrate` is the last unit phase. Repositories may remove optional phases
such as `simplify` or move command phases earlier, but they cannot configure
their way around candidate evidence, lead acceptance, or executor-only
integration.

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
unbound Daytona orphans after `ORPHAN_GRACE_MINUTES`. "Unbound" means no
`pipeline_instances` row still owns the resource (by `runtime_provider_
resource_id`, not by the ticket's possibly-stale `sandbox_id` projection,
which a newer generation's delegation overwrites); a resource still owned by
some generation is left entirely to the reclaim path below regardless of
`ORPHAN_GRACE_MINUTES`.

A terminal instance's `stopped` runtime resource (e.g. the needs_human
cleanup effect's `preserve` path, which stops rather than deletes so the
workspace stays inspectable) is otherwise kept indefinitely and still counts
against the Daytona memory quota. `operations/runtime-resource-reclaim.ts`
deletes it once `RUNTIME_RESOURCE_RETENTION_MINUTES` has elapsed and the
instance has no active stage attempt or unsettled effect intent (`pending`,
`processing`, or retryable `failed`); a resource
is deleted only when its exact provider binding is still `stopped` on the
owning (single-generation) `pipeline_instances` row and its stopped timestamp
is still at or before the retention cutoff immediately before deletion. The
DB only records `cleaned` after provider deletion is confirmed (provider "not
found" and duplicate cleanup both converge for free — see `cleanup()` in
`providers/daytona/adapter.ts`). The periodic sweep runs this on the configured
retention window; capacity-constrained provisioning
(`app/admission-preflight.ts`'s `checkDaytonaCapacity`, and a provision/
dispatch effect that fails with a capacity error in
`operations/pipeline-effects.ts`) runs a one-candidate, five-second-wait pass
with the same eligibility rule before rejecting or retrying. Reclaim triggers
share one local single-flight; a slow provider deletion may finish after the
hot caller's wait budget, while remaining candidates stay queued for the
periodic bulk sweep. Capacity pressure never bypasses the
retention window, since doing so could destroy
another operator's still-fresh diagnostic workspace.

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
steering permission; repository-skill package identity where the capability is
`agent/repository-skill@1`; and a request hash/idempotency key covering the
fence.

The entrypoint ignores conflicting ambient identity values and derives runtime
identity from the sealed request. It verifies input ownership/mode and all
digests before cloning. An initial stage checks out the exact published
`origin/<branch>` head when the working branch already exists on the remote
(a retriggered generation reuses the ticket branch), starts from the exact
sealed base commit only when the remote has no such branch, and fails closed —
never silently proceeding from the base commit — when the published head
cannot be queried or fetched; later stages reconstruct the exact expected
subject. Git safety config is root-sealed.

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

That bake-once dependency state covers only the integration checkout.
Structured unit and final-repair worktrees are created bare (`git worktree
add --detach`) and inherit none of it, so before the first repository command
executes in a unit worktree the child executor re-runs the sealed config's
`post_bootstrap` commands inside that worktree, as the agent user under the
same process fence and bounded output/timeout as the command itself. The
re-run happens once per worktree under a root-owned marker recording the
sealed repository-config digest; a digest-mismatched or unreadable marker
fails closed. A started-but-incomplete marker also fails closed so replay
cannot repeat arbitrary bootstrap side effects in-place; removing or freshly
recreating a worktree clears its marker and permits one new attempt. A
worktree bootstrap failure is a retryable infrastructure failure
for that child action — never a command receipt — so it cannot consume a
semantic repair round. Graph-scoped final commands carry no worktree and run
in the bake-once-bootstrapped integration checkout.

Executor-owned repository command receipts retain sha256 digests of the bounded
process captures for stdout and stderr. Failed receipts also carry independently
optional,
secret-sanitized diagnostic tails of at most 512 UTF-8 bytes per stream. The
canonical receipt, including those tails, is passed unchanged in the bounded
prior-evidence envelope to unit repair and final review actions; it remains
subject to the standard-receipt schema and the 48 KiB aggregate prior-evidence
limit.

The executor runs exactly one stage:

- agent capabilities invoke the appropriate OpenThrottle adapter and native CE
  skill, under the manifest context policy;
- command capabilities invoke one validated `.openthrottle.yml` command;
- provider-wait stages run in the supervisor and do not launch a sandbox actor.

Agent proposals are strict JSON written to `OT_STAGE_PROPOSAL_FILE`. The runner
normalizes output, verifies produced artifact declarations and Git subject, and
writes one `stage_result` event to the supervisor-owned stage-result spool. It
does not call a completion HTTP endpoint or emit a task completion marker.

### Loop action runtime isolation

Structured loop actions are executor-owned filesystem operations. The
integration checkout, sealed inputs, Git hooks, executor Git metadata, stage
spools, sibling action directories, prior action directories, and native-session
packages are root-owned and not readable or writable by the agent UID. The only
agent-writable repository path for a worker action is that action's selected
unit or final-repair worktree. Lead and reviewer actions receive a detached
read-only repository view: lead views are built from the sealed candidate
subject, reviewer views are built from the current integration `HEAD`, tracked
executable bits are preserved, and the view must remain Git-clean while being
unwritable by the agent.

Loop action inputs, logs, outbox, inbox, processed steering, native-session
transport, repository-skill discovery, and action home/profile directories are
namespaced by child action attempt. Before an action executes and after it
finishes, executor cleanup must converge the agent-writable surfaces back to an
empty/private state or return retryable infrastructure failure for quarantine;
a live current action directory must not be made traversable without first
holding that exact action's dispatch/replay lock. Exact replay removes any
action-local repository-skill proposal before invoking the engine, so stale
agent output cannot satisfy the receipt/proposal fence.

Native session continuation is materialized only from the exact sealed
executor-owned package selected by the request. Claude and Codex packages must
contain engine-native durable records for the selected session id, must be
bounded regular files with normalized digests, and are replaced through a
validated sibling staging directory plus atomic swap so the last resumable
package survives any failed replacement. OpenCode loop actions are not
supported: OpenCode's database-backed session store and built-in adapter body
delivery are deferred to a later slice, and both the supervisor loop dispatch
and the sandbox loop validator reject `agent: opencode` fail-closed. OpenCode
stage execution is unaffected.

Repository skills remain sourced from committed repository paths selected by
admission, not from ticket text. The sandbox materializes only the sealed
package bytes into the current action's engine discovery directory, requires the
`SKILL.md` frontmatter `name` to match the sealed invocation, invokes that
invocation from the isolated action view, and removes the ephemeral copy before
another action can observe sibling or prior packages.

### Action-scoped credentials and MCP servers

Each loop action materializes its own declared logical credentials
(`model.invoke`, `provider.read`, `repo.read`, `repo.write`, `mcp`) and MCP
servers from a clean trusted baseline, independent of whatever the whole
attempt's stage-level credentials are. The Daytona adapter maps the action's
exact declared scopes to the same minimal, closed sandbox credential-name
allowlist as stage dispatch (`GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
`CODEX_AUTH_JSON`, `KIMI_CODE_API_KEY`) and rejects any operator-only Daytona,
Fly, webhook, install, or supervisor credential the materializer might
mistakenly return; provider secret identifiers never appear in repository
schemas or sealed loop requests. The resulting envelope is uploaded to a
root-owned, action-attempt-namespaced file next to the sealed request and
named on the dispatch command line; it is never written into the persistent
sandbox process environment.

The sandbox reads, applies, and immediately deletes that envelope before
invoking the engine: the agent process is launched with a cleared
environment (not one inherited from the sandbox's own process, which could
still carry the whole attempt's stage credentials) containing only the
image's own fixed `PATH`/locale baseline plus the action's materialized
credentials, passed as an explicit child-process environment rather than as
command-line arguments (an argv vector is visible to any co-resident process
via `/proc/<pid>/cmdline`, unlike an explicit env map). `CODEX_AUTH_JSON` is
written to the action's isolated Codex home as `auth.json` rather than
exported as a raw variable, so Codex's own token rotation stays confined to
and is wiped with that action's directory. Cleanup is idempotent after a
restart: a missing envelope (already consumed, or a role with no declared
credential scopes) yields no credentials rather than an error, a retried
dispatch re-uploads a fresh envelope regardless of what an earlier failed
attempt already consumed, and a redispatch against an already-completed
action removes its freshly re-uploaded envelope immediately rather than
leaving it to be cleaned up by a script body that will never run again.

MCP configuration is built the same way, scoped to the action's declared
`allowedMcpServers` and filtered from the sealed repository config uploaded at
bootstrap (never a real operator's personal MCP configuration or the whole
attempt's unfiltered server list). Claude receives a private, read-only
`--mcp-config` file when servers are declared, and `--strict-mcp-config` is
always present so a zero-server action cannot fall back to a repo-committed
`.mcp.json` or other ambient discovery outside its declared scope. Codex
receives the equivalent `[mcp_servers.*]` blocks appended to its
action-scoped `config.toml`; because the installed Codex CLI supports only
local (stdio) servers, a remote-only server assigned to a codex-agent worker
fails the action closed rather than silently granting Codex a smaller tool
surface than an identically-scoped Claude worker. A subsequent action, a
retained failed worktree, and lead/reviewer/publisher roles (which receive no
worktree at all) cannot read a prior action's credential envelope, MCP
config, or rotated Codex auth state: the same per-action-attempt namespacing,
deletion, and tree relock that isolate worktrees and native sessions (above)
cover this material too.

RU5/RU6 do not validate standard receipt authority, activate the structured
reducer, or compose production child execution. Those contracts remain
fail-closed until their owning RU7, RU8/RU9, and RU9/RU11 slices install
them.

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

The structured `for_each_unit` composite stage does not support live steering
yet. It always compiles with `live_steering: false` -- the manifest forbids
`live_steering: true` for any executor other than a plain `agent` stage, and
the composite stage's executor is `loop_action` -- so `canSteerPipelineRun`
never treats a running composite stage as steerable, no matter which child
action (unit-scoped or whole-change) is currently live underneath it. A reply
sent while a structured run is active is always captured unbound (never fenced
to a run) and stays pending until that run ends, at which point terminal
cleanup cancels it; it is never delivered into any child action's sandbox.
Capture still records the reply durably in the structured ledger's activity
log (`steering_undelivered`) so the terminal receipt says so, rather than
losing the fact silently, and the reply remains visible as ordinary Linear
session activity throughout. Live steering to a specific in-progress child
action -- fenced to that action's own attempt/request so a stale or
cross-action reply is rejected fail-closed -- is a tracked follow-up, not
current behavior.

Outside the structured composite stage, stale session/request/subject replies
remain audit-only under the same generation/context-revision/run fence used
for the top-level pipeline.

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
publication, provider evidence handling, or terminal acknowledgement. A Linear
outbox row's retry is bounded (`MAX_LINEAR_OUTBOX_ATTEMPTS`): once a row keeps
failing without its error matching a recognized dead-token pattern, it goes
`dead` after the attempt cap rather than retrying forever, so it stops
head-of-line-blocking later same-session rows -- including a session's own
terminal receipt -- behind it.

Published content is sanitized and bounded. Raw task logs, secret values, and
untrusted webhook bodies are never automatically attached to Linear or a PR.

### Structured child publication

Each reportable child transition -- a unit repair round, a unit settling to
`completed`/`exited`/`failed`, the whole-change final review passing or
requesting a repair, the graph stopping, and aggregate emission -- inserts one
row into `execution_publication_events` and its correlated `linear_outbox`
activity row in the same SQL transaction as the durable reducer transition
that produced it (`supervisor/src/persistence/pipeline/unit-store.ts`). Both
rows are addressed by a deterministic id derived from the parent attempt, unit,
and transition, so a retried transaction is a pure no-op rather than a
duplicate or re-sanitized insert. `execution_publication_events` carries its
own strictly increasing `sequence` per parent attempt, independent of the
`linear_outbox` session-wide sequence, giving a restart-safe, gap-free replay
order for the structured graph specifically.

The event body is sanitized and bounded (`bounded()` in
`supervisor/src/pipeline/execution-publication.ts`, reusing the same
`sanitizeText` redaction used elsewhere) before either row is inserted, so
sanitization cannot be bypassed by replaying the same transition: a replay
either no-ops against the existing row or re-derives the identical sanitized
body from the same inputs. Only the bounded transition summary is durably
recorded; raw prompts, logs, and command output are never captured here.

The correlated `linear_outbox` row projects and is acknowledged through the
existing outbox processor and delivery ordering, but that delivery is an
independent, separate concern from reading the ledger back: the structured
ledger's restart-safe "Structured Activity Log" section (appended after the
live per-unit status breakdown in both the Linear and GitHub publication
bodies) renders directly from the `execution_publication_events` rows
themselves (`listExecutionPublicationEvents`), ordered by that per-attempt
sequence, without waiting on the correlated `linear_outbox` activity to reach
`processed`. Because each event row is inserted in the same transaction as the
reportable transition it reports, this converges immediately from durable
state -- including on the very same pass that emits an event (e.g. the
aggregate emitted alongside the terminal transition) and after a
crash-and-restart replay -- rather than depending on a second, independent
delivery to finish first. Every attempt whose terminal receipt is built after
the structured stage hands off to a later stage (e.g. `publish`) still carries
this ledger: it is resolved by `pipeline_instance_id`
(`getStructuredExecutionPublicationForInstance`), not by whichever attempt id
happens to be transitioning, since a later attempt in the same generation owns
no execution graph of its own. The rendered log is capped both by count (the
most recent 32 events) and by an explicit byte budget
(`MAX_ACTIVITY_LOG_BYTES`), dropping the oldest entries first with an
omitted-count note, so a long-running or repair-heavy graph's history can
never itself consume the whole publication body and evict the findings, event
sentence, or links rendered after it.

## Supervisor HTTP contract

| Method | Path | Authentication | Purpose |
|---|---|---|---|
| `GET` | `/healthz` | public | process liveness |
| `POST` | `/webhooks/linear` | Linear HMAC + freshness | durable agent events |
| `POST` | `/webhooks/github` | GitHub `sha256=` HMAC | durable PR/review/check events |
| `GET` | `/oauth/install` | `OT_INSTALL_SECRET` bearer | begin Linear OAuth |
| `GET` | `/oauth/callback` | one-time OAuth state | exchange and store installation |
| `GET` | `/status` | `OT_STATUS_TOKEN` bearer | tickets and pipeline/effect/publication state |
| `GET` | `/capabilities` | `OT_STATUS_TOKEN` bearer | active runtime release, capability digest/IDs, and effective limits |
| `GET` | `/analysis/runs` | `OT_STATUS_TOKEN` bearer | read-only, filterable `run_outcomes` evidence for improvement proposals |
| `POST` | `/analysis/citations/grade` | `OT_STATUS_TOKEN` bearer | reproduce proposal citations and deterministically grade their evidence graph |
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

`GET /capabilities` returns the installed runtime capability descriptor's
`release`, `capabilityDigest`, and `capabilities` array, read directly off the
same `ValidatedRuntimeCapabilityDescriptor` admission validates every pipeline
against. Its `limits.taskTimeoutSeconds` field reports the same configured hard
deadline repository-graph admission enforces. The CLI's structured `ship`
command queries this endpoint as a
pre-mutation activation check (see "CLI contract" below): explicit structured
selection never proceeds to any Linear call, let alone mutation, when the
endpoint is unreachable, unauthenticated, or its response is missing,
malformed, or does not list the exact structured capability.

`GET /analysis/runs` returns `run_outcomes` rows (see "Persistence contract"
below), filterable by `outcome`, `reason` (`closed_reason`), `attribution`
(`fault_attribution`), `graph` (`execution_graph_id`), `skill_digest` (matches
an entry in `skill_digests`), and an inclusive `from`/`to` range over
`created_at`; `limit` is clamped to a 200-row cap. An unrecognized filter
value or a malformed timestamp fails the request with `400` rather than
silently matching nothing. This is the analysis read-contract's only sanctioned
entry point into the corpus -- see "Persistence contract" for the doctrine and
its enforcement.

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
- structured child execution: `execution_graphs`, `execution_units`,
  `execution_work_attempts`, `execution_gate_receipts`,
  `execution_downstream_context`, `execution_publication_events`;
- cross-run orchestration history: `orchestration_journal`;
- settlement rollup measurement corpus: `run_outcomes`;
- operations: `repository_registrations`, `supervisor_leases`, `settings`,
  `schema_migrations`, `migration_reconciliation`.

`orchestration_journal` is append-only data capture, keyed by team,
repository, issue, and recorded time. Supervisor-owned orchestration decisions
use `actor = 'supervisor'` with null notes; notable agent proposal projections
use `actor = 'stage_agent'` with sanitized, bounded notes and structured
evidence references. The journal is queryable for operator or future
orchestrator inspection, but no coordinator transition, gate, or effect
scheduling logic may consume it as authority.

`run_outcomes` holds one deterministic row per pipeline instance, written
exactly once at its terminal transition -- either applyTransition's normal
settlement or supersedeOtherInstances' fencing of a superseded generation.
Supervisor-derived facts only, no agent-authored free text: join keys
(ticket, instance, generation, execution graph id, plan digest, base
commit), outcome and closed reason, fault attribution, generations
consumed, per-unit repair rounds, per-phase durations, token cost (`NULL`
means unmeasured -- no production path stamps a cost yet), engine, and the
deduped skill digests that ran (from receipt producers). Retained under the
separate, longer `RUN_OUTCOME_RETENTION_DAYS` cutoff rather than the other
operational-data retention windows, since it is safe to keep for
skill-tuning measurement.

### Analysis read-contract

`run_outcomes` and the receipt tables it is derived from are exposed
read-only through `GET /analysis/runs` and `openthrottle analysis` (see
"Supervisor HTTP contract" above). This generalizes the `orchestration_journal`
doctrine above: the corpus is evidence for improvement proposals, never an
input to a pipeline decision -- no gate, transition, scheduler, or
effect-drain module may import or query it.
`supervisor/src/persistence/pipeline/analysis-store.ts` is the corpus's only
read surface and is wired into the HTTP layer from a plain `db` handle in
`index.ts`, deliberately separate from `PipelineStore` (which
gate/transition/scheduler/effect-drain code consumes). `PipelineStore`
exposes no `run_outcomes` read method of its own for exactly that reason: a
method on that interface would be reachable by any decision code already
holding the store, without importing `analysis-store.ts` at all -- the
single-row lookup a settlement write wants to verify still exists on
`RunOutcomeStore` itself (`persistence/pipeline/run-outcome-store.ts`), not
on `PipelineStore`.

`supervisor/src/__tests__/architecture.test.ts` enforces the contract with
two rules. The first names the gate (`pipeline/gates.ts`,
`pipeline/execution-gates.ts`, `persistence/pipeline/unit-store-phase-reducer.ts`),
transition (`persistence/pipeline/transition-store.ts`,
`persistence/pipeline/instance-store.ts`), scheduler (`pipeline/coordinator.ts`,
`pipeline/unit-coordinator.ts`), and effect-drain (`operations/pipeline-effects.ts`,
`operations/unit-effects.ts`, `operations/structured-child-runtime.ts`,
`pipeline/control.ts`, `pipeline/settlement.ts`) modules as roots and walks
the import graph forward from them, transitively, so it fails if any of them
-- or anything they come to depend on, at any depth -- imports the analysis
surface, not just a direct import from a listed file itself. The second
confines every `run_outcomes` SQL literal, anywhere in the source tree, to
exactly `run-outcome-store.ts` (the write path) and `analysis-store.ts` (the
read surface) -- closing the gap the first rule alone leaves open, where a
decision module under the `persistence` boundary could otherwise read the
corpus with a raw query of its own and no import to catch.

Schema migrations are transactional, checksum-pinned, and idempotent. Migration
code may recognize historical direct-run rows solely to reconcile an older
SQLite file conservatively. Such rows never participate in admission,
selection, routing, scheduling, status summaries, or sandbox execution. New
databases do not create the retired task-work table. Historical satellite
tables such as `run_liveness`, `session_executions`,
`pipeline_runtime_resources`, `run_stage_bindings`, and
`pipeline_work_bindings` remain in immutable migrations only; live state is
stored on the owning actor, session, instance, attempt, or work row.

Citation-backed proposal flows use a separate provider-neutral citation gate.
`/analysis/citations/grade` is still the only production path that resolves
analysis queries against `run_outcomes`; after resolution it calls the
pipeline-level citation gate with plain proposal bytes plus resolved result
rows. The gate emits canonical `openthrottle.citation-gate/v1` decisions with
bounded reason codes (`all_citations_reproduced`,
`partial_claim_survival`, `no_claims_survived`, `stale_evidence`) and persists
them in `citation_gate_receipts` by proposal
hash. Exact replay returns the original receipt; the same proposal hash paired
with different resolved evidence is rejected as conflicting replay. Scheduler,
transition, reducer, and effect-drain code must not import the analysis store
to recreate this evidence, and must not treat citation receipts as authority to
advance pipeline execution.

Stage C child-unit work must add any needed live binding state to the owning
unit/work records rather than reviving empty historical binding tables.
For the serial `for_each_unit` composite stage, `execution_graphs` binds one
parent pipeline attempt/run to an immutable execution graph and plan digest,
plus the graph-declared unit phase sequence, the pinned configured command
names, the bounded max repair rounds, and the whole-change final phase
(`command`/`review`/`repair`/`done`, `NULL` before the first unit integrates);
`execution_units` stores the immutable unit projection, dependency list,
authored order, canonical execution-plan command sequence for that unit,
active work pointer, current phase
(`implement`/`simplify`/`command`/`candidate`/`lead`/`integrate`), current
repair cycle, repair round count, command index, accepted/integration subjects,
and terminal level/alarm fields; and `execution_work_attempts` stores each
child action attempt with parent instance/attempt/run/unit fences, unit id
(`NULL` for a whole-change final action), action kind, repair cycle, command
name, idempotency key, runtime request/session hashes, lease owner/window,
payload, result hash, output subject, receipt, and terminal/error state.
Composite foreign keys bind every unit, action, receipt, and downstream
context record to the same execution graph and parent attempt so cross-instance
or mixed-attempt child identities are rejected durably. When an execution plan
declares commands, those commands are the authoritative command sequence:
unit-scoped commands run only for their named unit, unscoped commands run for
every unit, and the whole-change final command sequence uses the canonical plan
command names. If the plan declares no commands, the graph's command phase
defaults are used for backward-compatible structured runs. A declared command
missing from the sealed repository config fails closed before child dispatch,
and a `not_configured` receipt for a declared unit or final command is a failed
gate. The durable unit
reducer advances a unit through the persisted graph-declared phase order:
implement (or repair on re-entry), optional simplify, declared command slots,
executor candidate derivation, lead acceptance bound to that exact candidate
subject and its command receipts, and only then integration. A
`semantic_repair_required` lead decision returns the unit to a fresh implement
cycle with command index reset, bounded by the graph's max repair rounds, after
which the unit settles as `failed`. Once every unit has settled,
and at least one unit reached `completed`, the same fenced-action mechanics
rerun the full configured commands and one fresh, report-only final review
against the final integrated subject; a `semantic_repair_required` final
review routes through a dedicated final-repair action and a fresh command/review
cycle, invalidating the prior review's authority. The reducer may lease at most
one active action -- unit-scoped or whole-change -- per parent attempt at a
time. It expires only pre-dispatch claims by lease time. Dispatched or running
child actions remain the active action while their parent-run-fenced child
liveness is fresh, and are recovered/collected by idempotency rather than
duplicated. When a dispatched or running child action misses its heartbeat
fence, the supervisor first identifies that exact expired current action and
invokes idempotent runtime result collection outside the SQLite transaction. A
recovered result completes only through a compare-and-set against the unit's
(or graph's) current active action pointer. Only confirmed no-result collection
may then mark the work attempt dead, level the unit to `exited` with
`alarm = 0` (or stop the whole graph for a lost whole-change final action),
clear the active action pointer through a separate compare-and-set, and allow
serial dispatch to continue with the next ready unit. Collection errors do not
prove absence; they retain the active action for bounded retry. A stopped
child graph records `stopped_at` and `stop_reason` on `execution_graphs`,
levels unfinished units to `exited`, and makes leasing fail closed while that
stop fence is present, including when stop was requested before any child
action was active. A gate decision (`unit_acceptance`, `integration`, or
`final_review`) is supplied by the caller already evaluated against the pinned
receipt fence and producer bindings; the reducer only persists it once and
applies its routing exactly once, so a replayed identical decision is a no-op
rather than a duplicate repair round.

`execution_gate_receipts` records deterministic child gate decisions by work
attempt and gate kind. A receipt is accepted only after the typed child evidence
matches the expected producer, parent attempt/run/request, unit/action,
generation/native-session, input subject, and current output subject fences;
exact replay is idempotent and conflicting replay is rejected. The receipt
stores the shared gate result/outcome/reason, sorted artifact hashes, canonical
payload, and receipt hash.

`execution_downstream_context` records immutable context emitted by an already
integrated/completed unit for existing pending units in the same execution
graph. Context records are addressed by source unit, target unit, and payload
hash; duplicate exact records are idempotent, unknown targets, non-pending
targets, non-integrated sources, and topology changes are rejected rather than
mutating the graph.

Once every unit has settled and, when at least one unit completed, the
whole-change final review has passed (`execution_graphs.final_phase = 'done'`),
the reducer emits one `execution_graph_result` artifact and one aggregate
`stage_result` for the parent attempt; the aggregate hash is compare-and-set on
`execution_graphs` so the parent can settle once through the ordinary
stage-result path. Structured success requires every authored unit to have a
`completed` terminal level plus accepted integration evidence for that unit's
exact integration subject. The graph's integration subject and whole-change
final review remain bound to the exact final integrated commit after all unit
and whole-change integration phases complete. At the successful aggregate
boundary, the parent `stage_result`, `execution_graph_result` aggregate
artifact, persisted immutable subject, and downstream publish request are
instead bound to the canonical workspace tree from the accepted
executor-verified integration receipt for that exact commit. The supervisor
keeps the independent observed-workspace equality fence fail-closed; commit
subjects are not accepted as aliases for tree subjects at publication time. A
stopped, exited, failed, or partially integrated graph never claims structured
success.

`pipeline_artifacts.kind` includes `execution_graph_result` for the child
aggregate artifact in addition to the existing stage, review, command,
provider, human, and publish artifacts.

`execution_publication_events` records the ordered, durable child-publication
event described in "Structured child publication" above: one row per
reportable transition, fenced to its exact execution graph/pipeline
instance/parent attempt, carrying a per-attempt sequence, an event `kind`
(`unit_repair`, `unit_settled`, `graph_stopped`, `final_review`, `aggregate`,
`steering_undelivered`),
its sanitized body, and the id of the `linear_outbox` row it produced in the
same transaction.

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
  `RUNTIME_RESOURCE_RETENTION_MINUTES=60`,
  `WEBHOOK_MAX_AGE_SECONDS=60`, `SANDBOX_EVENT_POLL_INTERVAL_MS=5000`,
  `STALL_TIMEOUT_SECONDS=900`, `ALLOW_LINEAR_MERGE=false`,
  `RUN_OUTCOME_RETENTION_DAYS=180`;
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
stage, plus once per structured unit worktree before the first repository
command executes there — it is the repository's declared way to make any
fresh checkout runnable, and unit worktrees are fresh checkouts.

## CLI contract

`openthrottle setup` verifies snapshot availability and prints the supervisor
secret checklist. `openthrottle init` detects the GitHub origin/default branch,
writes `.openthrottle.yml`, and idempotently registers the Linear-team route and
GitHub webhook. Its explicit `--editable-skills` option transactionally writes
an editable `simple_editable` repository graph, the exact referenced
`implement-plan` package closure under `.openthrottle/skills/`, and
`.openthrottle/skills.lock.json`. The lock pins the OpenThrottle release plus
the upstream and scaffold graph, package, and file digests and binds those
fields with a self-integrity digest. The package closure has the same 64-file
and 256-KiB limits as supervisor admission and rejects symlinks and non-regular
entries. Generated loop timeouts use the authenticated supervisor's advertised
effective task-timeout limit. Preflight validates the complete candidate config
and graph, compares local/upstream/provenance digests, and permits only
`unchanged` and `upstream-only`; `local-only` and `conflict` refuse all writes.
The CLI prints every classification and requires a separate confirmation before
applying; `--dry-run` exits after the read-only plan without files or
registration changes. This scaffold rewires only the simple graph's
initial and repair implementation loops. Review, simplification, publication,
and structured-unit bindings stay platform-owned and are not advertised as
editable because current repository-skill dispatch cannot faithfully replace
their scopes. `openthrottle ship <plan.md>` creates and delegates a Linear
issue. `status`, `stop`, `logs`, and `analysis` call authenticated supervisor
endpoints; `analysis` filters `GET /analysis/runs` by `--outcome`, `--reason`,
`--attribution`, `--graph`, `--skill-digest`, `--from`, `--to`, and `--limit`.

An explicit structured (unit-consuming) graph selection adds one pre-mutation
step to `ship`: before any Linear call, the CLI calls the configured
supervisor's `GET /capabilities` and requires the exact `graph/for-each-unit@1`
capability in the response. Unreachable, unauthenticated, missing, or
malformed/stale evidence fails closed with a stable error and never falls back
to `simple`; only a matching, well-formed response permits the ship to
proceed to team resolution and issue creation.

The CLI never creates per-project snapshots or configures routing fallbacks.

## Security invariants

- Ticket text, PR comments, reviews, commit messages, and repository content are
  untrusted data. Registered repository code itself is execution-trusted.
- Only credentials declared by the selected stage enter its sandbox. Daytona,
  Fly, Linear app, webhook, installation, and operator secrets remain in Fly.
- `repo.write` receives the write-capable GitHub token. `repo.read` and
  `provider.read` receive the separate read-only token unless the same stage
  explicitly declares `repo.write`.
- The same applies per loop action, independent of the whole attempt's stage
  credentials: each action's engine process launches with a cleared
  environment carrying only its own declared, materialized credentials and
  MCP servers (see Action-scoped credentials and MCP servers above).
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
