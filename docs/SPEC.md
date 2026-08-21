# OpenThrottle specification

Status: normative for the filesystem-definition and execution-kernel release.
Executable validators and the fresh epoch SQL are the byte-level authority for
their respective formats; this document defines how those contracts compose.

## 1. Product boundary

OpenThrottle turns an approved work item into tested, reviewed, published code.
It deliberately separates:

- deterministic coordination in the Fly supervisor;
- agent reasoning in a sealed Daytona action;
- repository and publication evidence in Git/GitHub;
- control events from Linear, GitHub, or an operator.

Pipeline is the only public orchestration abstraction. The supervisor may
compile a pipeline into a private manifest, but users do not author or select a
second runtime model.

The supervisor owns every authoritative identity and transition. Agents may
reason, inspect, edit an allowed content tree, run tools exposed by the action,
and submit semantic candidates. They do not own Git administration, commits,
publication, durable state, timestamps, provenance, or external-effect claims.

## 2. System flow

```text
signed provider event / operator command
                 |
                 v
       registered route + exact Git subject
                 |
                 v
 filesystem definitions --compile--> immutable DefinitionBundle
                                         |
                                         v
                           PipelineRun + first Attempt
                                         |
                     +-------------------+------------------+
                     |                   |                  |
                 Checkpoint          Record            Effect intent
                                                             |
                                                      reconcile / write
                                                             |
                                                       DeliveryRecord
```

At most one reducer transition owns a run cursor version. Concurrent work is a
bounded frontier of independent Attempts; it is not concurrent cursor mutation.

## 3. Filesystem definitions

### 3.1 Layout

Definitions live at fixed paths:

```text
.openthrottle/config.yml
.openthrottle/agents/<id>/instructions.md
.openthrottle/pipelines/<id>/pipeline.yml
.openthrottle/pipelines/<id>/loops/<loop>.yml
.openthrottle/skills/<id>/SKILL.md
.openthrottle/evals/<id>/eval.yml
```

IDs include their namespace. The platform reserves `core/`; repositories may
define other namespaces. Paths are normalized, bounded, free of symlinks and
parent traversal, and unique by definition identity and path.

The platform tree and repository tree use the same validators. Platform files
are trusted only when their normalized content hash is present in the
release-sealed catalog. Repository files are bound to the admitted exact Git
subject.

### 3.2 Config

`openthrottle.config/v2` selects one pipeline and one engine and may set model,
reasoning effort, named commands, bootstrap commands, and limits. Commands are
strings executed only by deterministic command actions. Repository config
cannot widen supervisor credentials or platform authority and has no MCP
configuration surface.

### 3.3 Agents

`agents/<id>/instructions.md` is nonempty plain Markdown containing stable role
instructions. It has no runtime YAML wrapper and is not a skill package. The
compiler normalizes line endings and hashes the resulting string.

An action profile is layered in this order:

1. platform safety and executor fence;
2. the selected agent instructions;
3. the sealed task/action prompt;
4. references to only the selected skills and result tool.

Later layers cannot widen engine, model, tools, MCP access, credentials,
repository authority, subject, session policy, or selected definitions.

### 3.4 Skills

A skill is one `SKILL.md` plus its package-local references. It is a reusable
procedure, not a delegation wrapper or an agent's whole prompt. Selected skill
bytes are included in the DefinitionBundle. The runtime exposes only those
packages through the engine's native progressive-disclosure mechanism.

The stage may name an `entry_skill`; it must be in the stage's skill allowlist.
No skill may discover an unselected sibling package. If an engine cannot
enforce selective disclosure, capability admission fails.

### 3.5 Pipelines and loops

`openthrottle.pipeline-definition/v1` contains:

- a stable `id`, integer `version`, and `entry` stage;
- agent, command, effect, or wait stages;
- an outcome-to-next-stage or outcome-to-terminal map;
- optional bounded re-entry with an explicit exhausted outcome;
- an optional bounded loop over sealed data.

Agent stages name one agent, `inspect` or `edit` authority, a skill allowlist,
an optional entry skill, and one eval. Command stages name a configured command.
Effect and wait stages name runtime-registered deterministic primitives.

A loop body is inline by default. A complex loop may reference exactly one
pipeline-local file under `pipelines/<pipeline>/loops/`. A loop declares its
data selector, maximum parallel members, and maximum rounds. Compiled closure
and runtime bounds may only narrow these values.

Every referenced stage, agent, skill, eval, loop file, and command must exist.
Every stage must be reachable. Every transition and terminal outcome must be
closed and validated before admission.

### 3.6 Evals

`openthrottle.eval-definition/v1` binds an agent stage to:

- a runtime-registered deterministic evaluator;
- one `openthrottle.semantic-result-schema/v1`;
- a closed outcome set;
- at most 64 bounded payload fields of type `string`, `string_list`, `boolean`,
  `integer`, or `json`;
- explicitly allowed normalizations.

Eval files are declarative. They do not load executable code from a repository.
The release must already implement the named evaluator and normalization.

### 3.7 Compilation and DefinitionBundle

The compiler reads a bounded virtual file map from either the local filesystem
or an exact Git subject. Both readers must emit identical canonical bytes.

Compilation:

1. validates the repository config and selected pipeline;
2. applies repository-over-platform selection without allowing repository
   definitions in `core/`;
3. computes the exact transitive closure;
4. normalizes and hashes each definition;
5. binds compiler version and runtime-capability digest;
6. emits `openthrottle.definition-bundle/v1` and its canonical SHA-256;
7. compiles the private runtime manifest from those same bytes.

Each bundle entry contains only `definition_kind`, `definition_id`, `origin`,
`path`, `content_hash`, and `normalized_payload`. The bundle also binds source
commit and selected pipeline. Dependencies not in the exact closure are
rejected; the compiler cannot silently add a broader skill or evaluator set.

The canonical bundle is written to the content-addressed store and verified
before a run row commits. A restart reconstructs the private manifest from that
blob, the release-sealed compiler environment, and trusted platform hashes. It
must not reread `.openthrottle/` from a mutable checkout.

## 4. Admission and routing

One repository registration binds either:

- a Linear team ID/key to one GitHub repository; or
- a GitHub repository to itself as the Issue control route.

It also binds base branch, installation/webhook identities where applicable,
and the runtime snapshot. Duplicate routes or repositories are rejected.
Unregistered webhook routes are acknowledged and ignored; they do not create
work.

Admission resolves the exact base subject before compilation. Automatic
admission may run independent read-only planner and reviewer actions to choose
`simple`, `structured`, or `needs_human`. `simple` selects `core/implement`;
`structured` selects `core/structured`. An explicitly requested investigation
may select `core/investigate` outside this implementation-routing decision.
Untrusted ticket text cannot name a platform definition, widen scope, select
credentials, or approve its own plan.

For structured work, the sealed task prompt contains exactly one validated
`openthrottle.execution-plan/v2` block whose `pipeline_id` is the selected
pipeline. Units have stable IDs, bounded dependencies, file/scope hints,
acceptance criteria, and verification obligations. Cycles, missing
dependencies, another pipeline ID, or more than the runtime bound are rejected.

All fallible source reading, compilation, bundle verification, and runtime
compatibility checks happen before the atomic admission transaction. Admission
then creates one work item, one pipeline run, the immutable definition
snapshots, the bundle pointer, and the first pending Attempt.

## 5. Execution kernel

### 5.1 Run

A PipelineRun binds:

- work item and selected pipeline;
- immutable DefinitionBundle hash and pointer;
- current exact Git subject;
- status and optional terminal outcome;
- cursor stage, version, re-entry counters, structured frontier, completed
  scope keys, and optional barrier;
- work-retry and result-correction limits;
- the last transition identity/hash.

Live states are `pending` and `running`. Terminal outcomes are `completed`,
`no_change`, `needs_human`, `failed`, `canceled`, and `superseded`.

### 5.2 Attempt

An Attempt is one leased unit of work. It binds run, scope, stage, authority,
request hash, DefinitionBundle hash, exact input subject, selected context
record/checkpoint IDs, retry/correction ordinals, and optional native session.

Scopes are a pipeline stage, loop item, or fanout member. Non-stage scopes bind
their parent, group, member ID, and stable index. Dependency counts determine
lease eligibility; scheduling order is deterministic.

Attempt states are:

```text
pending -> running -> work_complete -> recorded -> settled
                  \-> result_pending -> recorded -> settled
                  \-> needs_human | failed | canceled | superseded
```

`result_pending` is not failed work. It means an executor-captured checkpoint
exists but the semantic candidate still needs bounded result correction.

Leases use compare-and-set versions, owner, purpose, expiry, and started flag.
Starting work, binding a session, finishing work, recording a result, and
settling each validate the exact current run/cursor/Attempt fence. Expired work
may be retried only through the reducer; stale completions cannot mutate state.

### 5.3 Request identity

One request hash covers run and Attempt IDs, stage/scope, exact input subject,
DefinitionBundle hash, repository authority, selected action definition hashes,
task prompt, context record/checkpoint hashes, accepted-edit boundary, runtime
resource identity, and executor policy.

The action request carries that hash plus the exact bundle entries needed by
the action. The sandbox recomputes and verifies the seal. A mismatch fails
before invoking an engine or command.

### 5.4 Checkpoint

The executor creates `openthrottle.attempt-checkpoint/v1`. It binds Attempt
identity, input subject, verified output subject (or null), native session,
payload schema/content, and capture time.

The agent cannot author the output subject. For edit actions the executor
captures the resulting tree, constructs the subject, and verifies it. For
inspect actions output subject is unchanged. An inspect action reviewing edits
receives the preceding accepted checkpoint whose output equals its exact input
subject.

### 5.5 Records

All durable evidence uses `openthrottle.record/v1` and one of three kinds:

- **ResultRecord** — the executor-materialized semantic or command result for
  one exact Attempt, including original and normalized candidate hashes.
- **DecisionRecord** — one deterministic reducer/evaluator judgment over an
  ordered set of input record IDs.
- **DeliveryRecord** — confirmed or rejected evidence for one exact Effect,
  idempotency key, target, and external identity.

Records are immutable and sequenced within a run. At most one ResultRecord owns
an Attempt and at most one DeliveryRecord owns an Effect. A settled Attempt has
an explicit DecisionRecord; pointer presence, not historical scanning, proves
ownership.

### 5.6 Atomic reduction

The reducer is a pure function of the compiled manifest, run, current Attempts,
selected records/checkpoints, and confirmed Effect evidence. It emits one
atomic transition bundle. Persistence validates expected versions and commits
the new run cursor, changed Attempts, new Records, Checkpoints, and Effect
intents in one SQLite transaction.

Replay of the same command is byte-identical and idempotent. A command ID or
semantic key that collides with different bytes is corruption and fails closed.
No agent candidate alone advances a cursor.

## 6. Action execution

### 6.1 Inspect authority

An inspect action receives a packed clone/materialized checkout at the exact
input subject. Repository content is root-owned and read-only, Git remotes are
disabled, and provider-native tool policy permits only reading/searching plus
the action result tool. It cannot edit content, administer Git, commit, push,
publish, or invoke mutating MCP/provider operations.

When an inspect action reviews an accepted edit, the executor also writes one
root-owned, read-only, bounded change artifact outside the checkout. It binds
the exact accepted base/input subjects and trees, a changed-path manifest, and
the textual diff. Oversized sections are omitted with explicit diagnostics.
Every engine receives the same named artifact through native file-read access;
it grants no shell, network, edit, Git-administration, provider, or MCP authority.

Read-only authority is intentional even though agents do not own commits. It
prevents review contamination and proves that a finding describes the sealed
subject. Native read/search CLI features remain available. Commands such as
tests or builds that need writable caches run as separate command Attempts.

Planning, admission review, unit acceptance, whole-change review, persona
selection/review, finding validation, and result correction use inspect.

### 6.2 Edit authority

An edit action receives an isolated writable content worktree whose Git
administration directory, refs, remotes, hooks, and publication credentials are
executor-owned. It may change only repository content within the sealed scope.
It cannot commit, push, publish, open/update a pull request, integrate a sibling
unit, or claim external success.

Implementation, simplification, investigation-with-fix, unit repair, and final
repair use edit. After work exits, the executor verifies the content tree and
creates the checkpoint before accepting any semantic candidate.

### 6.3 Native session binding

An agent executor reports the native provider session as soon as the
conversation exists. The supervisor atomically binds it while the started work
lease and exact launch fence remain live. Agent work cannot complete or emit a
checkpoint before this bind. Command actions are sessionless.

A work retry clears the session. Result correction retains the session because
it repairs only the representation of already completed work. Any session/run,
Attempt, request, bundle, subject, lease, retry, or correction mismatch fails
closed.

### 6.4 Semantic candidates and normalization

An agent submits only:

```json
{
  "schema": "openthrottle.result-candidate/v1",
  "outcome": "success",
  "payload": {}
}
```

The candidate and any JSON field are bounded to 64 KiB canonical bytes. The
outcome and payload fields must exactly match the sealed eval. Unknown fields,
types, outcomes, or oversized values are diagnostics, not partial success.

The only initial normalization is `string-array-to-newlines/v1`. When declared
for a string field, a nonempty bounded array of strings is joined with `\n`.
The transformation records its ID, JSON path, input hash, and output hash. This
repairs the common case where `payload.summary` is returned as an array without
discarding successfully completed code or tests.

If validation then succeeds, the executor creates a ResultRecord with original
and normalized hashes. If it fails after work completed, the Attempt enters
`result_pending` with diagnostics, deadline, and correction count.

### 6.5 Result correction

Correction resumes the same native session against the locked subject and
checkpoint. It always has inspect authority, no MCP or provider access, and
exactly one `ot-result` tool. It receives the semantic schema and diagnostics,
not a new implementation task. Claude and Codex retain the same sealed steering
hook and exact run/attempt/request/bundle/lease/session bindings; injected
guidance cannot widen the result-only authority frame.

Correction has its own lease, deadline, and finite budget. A valid candidate
records normally. Exhaustion or loss of the exact session becomes
`needs_human`; it never reruns or discards the checkpoint implicitly.

### 6.6 Commands

A command action resolves one named command from the sealed config. The sandbox
executes it against the checkpoint tree with bounded output and time. Exit code,
command ID, and summary are executor-authored. Commands may write build/cache
artifacts inside their disposable command environment but cannot change the
accepted Git subject or publish.

## 7. Pipeline behavior

### 7.1 Ordinary work

The core implementation pipeline performs edit implementation, inspect review,
separate edit remediation when required, simplification, a second inspect
review, configured test/lint/build commands, publication Effect, and provider
wait. All steps use kernel primitives; there is no alternate ordinary runner.

The investigation pipeline performs an evidence-led edit/diagnosis action,
then publishes only a convergent changed subject. `no_change` terminates without
publication.

### 7.2 Structured work

Structured execution parses the exact validated execution plan from the sealed
task prompt. It compiles a bounded dependency frontier with stable Attempt IDs.
Ready units may execute concurrently up to the pipeline limit; deterministic
dependency evidence is merged into each action context.

Each unit cycles through edit implementation/simplification, commands,
inspect-only lead acceptance, optional edit repair, and an integration Effect.
Only accepted checkpoints integrate. Integration is serial against the current
exact subject; a unit whose base is stale must be reconciled explicitly.

After all units integrate, whole-change commands run. An inspect selector
chooses a bounded roster from the sealed reviewer-skill allowlist. Each persona
is an independent inspect fanout Attempt. An inspect validation action confirms
blocking findings. Confirmed blockers schedule a separate edit final-repair
Attempt and repeat the bounded assurance cycle; advisory findings do not gain
transition authority.

Structured planning and recovery query Attempts by exact run, bundle, parent,
scope group, stage, member, and settled status. They do not infer state by
scanning arbitrary historical text.

## 8. Effects and runtime resources

An Effect is a write-ahead intent derived from a DecisionRecord. It binds kind,
target, optional exact subject, canonical payload, intent hash, and one globally
unique idempotency key. Scheduling the intent and its authorizing decision is
atomic.

The worker follows this order:

1. lease the Effect;
2. reconcile the target using its idempotency key and expected identity;
3. if already committed, verify exact evidence and write a DeliveryRecord;
4. if absent, perform at most one dispatch for the leased attempt;
5. reconcile again and record confirmed/rejected evidence;
6. if outcome is unknown, release with backoff in reconcile-only mode.

An unknown external outcome is never blindly replayed. Conflicting external
identity, target, subject, or payload fails closed.

Built-in plans cover Daytona provision/stop/cleanup, accepted structured-unit
integration, exact-subject GitHub publication, Linear/GitHub status delivery,
and provider waiting. Multi-phase operations checkpoint each confirmed phase.

Provisioning expands privately into provision, stop, and cleanup lifecycle
ownership. Every terminal path—success, failure, human intervention, stop,
supersede, retry exhaustion—must either independently prove provisioning never
committed or schedule cleanup from exact confirmed create evidence. A runtime
resource cannot be considered clean from an agent statement.

## 9. Persistence and blobs

### 9.1 Fresh SQLite epoch

The live database is created from the one immutable SQL artifact in
`supervisor/src/persistence/epoch-schema.ts`. It has exactly twelve tables:

| Table | Responsibility |
|---|---|
| `schema_migrations` | one baseline version/name/checksum |
| `settings` | bounded typed settings and maintenance fence |
| `leases` | process-wide exclusive work |
| `repository_registrations` | provider route to repository/runtime binding |
| `work_items` | immutable admitted request plus lifecycle |
| `inbox_events` | deduplicated, leased provider/operator input |
| `definitions` | normalized definition identity/provenance snapshots |
| `pipeline_runs` | bundle pointer, exact subject, status, cursor |
| `attempts` | shared work/correction scope and lease state |
| `records` | immutable result, decision, and delivery evidence |
| `effects` | write-ahead external intent and reconciliation state |
| `checkpoints` | executor-captured work/subject evidence |

`definitions` is intentionally narrow: its only columns are
`definition_kind`, `definition_id`, `source_commit`, `content_hash`, and
`normalized_payload`. Runtime behavior comes from the immutable DefinitionBundle
blob; the table is provenance/query support, not another authoring registry.

All tables are `STRICT`; identity tables use `WITHOUT ROWID` where applicable.
Foreign keys are on. The live connection uses WAL, `synchronous=FULL`, and a
bounded busy timeout. Boot verifies application ID, user version, baseline
checksum, required tables/indices/triggers, foreign keys, integrity, immutable
epoch identity, BlobStore identity, and bootstrap checksum. An old, partial,
unknown, or mismatched database is refused rather than upgraded in place.

Only `supervisor/src/persistence/` imports `better-sqlite3` or issues SQL.
Production callers depend on explicit ports.

### 9.2 Content-addressed payloads

Inline JSON is at most 64 KiB. Larger immutable payloads are stored under a
volume BlobStore keyed by SHA-256. A pointer carries algorithm, digest, bytes,
encoding, media type, and payload schema. Database and BlobStore must be on the
same volume but the database path must be outside the blob root.

Blob creation uses an exclusive temporary regular file, writes and fsyncs
bytes, verifies digest and length, publishes without replacing an existing
different object, fsyncs directories, and returns an unforgeable verified
token. Relational stores accept that token, not a caller-authored pointer.

Reads reject symlinks, non-files, wrong size, wrong digest, wrong store marker,
or inode substitution. Active corruption blocks the lifecycle and requires
operator action. Settled Records and Checkpoints are never rewritten.

Provider ingress is bounded to 1 MiB; payloads above 64 KiB use the same blob
contract. The immutable DefinitionBundle always uses a verified blob pointer.

## 10. HTTP and CLI surface

All bodies and text are bounded and sanitized before logging or returning an
error. Status/operator endpoints use constant-time bearer-token comparison.
Webhook endpoints verify provider HMAC before ingestion.

| Method and path | Auth | Contract |
|---|---|---|
| `GET /healthz` | public | `{ok:true}` process liveness |
| `GET /capabilities` | status bearer | release, capability digest, capabilities, limits |
| `GET /runs/:reference/status` | status bearer | run/cursor/Attempt/Effect projection |
| `GET /runs/:reference/logs` | status bearer | stable cursor page across run, Attempt, Record, Effect, Checkpoint, inbox events |
| `GET /analysis/runs` | status bearer | bounded settled-run metadata query |
| `GET /runs/:reference/analysis` | status bearer | bounded result/decision/delivery metadata |
| `POST /runs/:reference/control` | status bearer | durable deduplicated `stop` or `supersede` request |
| `GET /repositories` | status bearer | registrations |
| `POST /repositories/register` | status bearer | prepared Linear or GitHub route registration |
| `GET /maintenance` | deploy bearer | maintenance fence/version |
| `POST /maintenance/close` | deploy bearer | compare-and-set close |
| `POST /maintenance/open` | deploy bearer | compare-and-set open |
| `GET /maintenance/active-work` | deploy bearer | named settle-or-abandon preflight |
| `POST /webhooks/linear` | Linear HMAC | bounded deduplicated event |
| `POST /webhooks/github` | GitHub HMAC | bounded deduplicated event |

During maintenance every mutating provider event returns `503`, `Retry-After`,
`acknowledge:false`, and persists nothing. After reopening, a provider retry
enters the normal inbox and deduplicates by provider delivery/semantic group.

The CLI maps `status`, `logs`, `analysis`, and `stop` to these kernel-native
projections. It presents pipeline, Attempt, Record, Effect, and Checkpoint
vocabulary only. `init` scaffolds `.openthrottle/`, registers the repository,
and installs local planning/operator skills; it does not create runtime
definition rows directly.

## 11. Security and trust boundaries

- Registered repositories are trusted for code execution because config may
  contain bootstrap and command strings. Registration is an operator trust
  decision.
- Ticket, issue, plan, comment, review, commit-message, and repository prose is
  untrusted data and cannot override system/action fences.
- Sandbox credentials are minimal: scoped repository/provider access needed by
  the action and one model credential. Fly, Daytona administration, webhooks,
  installation, and operator tokens never enter the action.
- Origin URLs are clean; a credential helper supplies GitHub credentials.
- Exact Git subjects are full lowercase hexadecimal object IDs. Branch names
  are routing hints, never evidence authority.
- Logs and activities redact tokens, credentials, auth headers, URL user-info,
  and bounded secret-like values. Raw model/provider output is not emitted to
  public logs.
- All native session and provider callbacks are treated as untrusted until
  bound to the exact live fence.
- Only deterministic registered primitives may evaluate candidates, integrate
  checkpoints, publish, wait on providers, or mutate runtime resources.

## 12. Offline epoch replacement

There is no compatibility runtime and no online epoch transition protocol.
Because this installation is dogfood-only, replacement is one explicit
maintenance operation using:

```bash
npm run build --prefix contracts
npm run build --prefix supervisor
node supervisor/scripts/offline-replace.mjs /absolute/path/to/manifest.json
```

The manifest is bounded and uses argv arrays, never shell strings. It declares:

- proof that ingress is closed, supervisors/workers are stopped, and no storage
  lock exists;
- every active Attempt, correction, Effect, lease, and runtime resource, each
  terminal or explicitly abandoned with cleanup proof;
- exact old release, database, blob root, and unused archive root;
- exact fresh release, distinct absent database/blob paths, BlobStore identity,
  and checksummed bootstrap containing only settings and repository
  registrations;
- one unused report path;
- commands to start/stop the candidate, run named ordinary/structured smoke
  work, reopen ingress, and restore the old tuple.

The command refuses relative, root, nested, symlinked, existing fresh, or
overlapping paths. It makes a SQLite backup, runs integrity and foreign-key
checks, records schema and table counts, copies and hashes every blob, and
atomically publishes the archive manifest. It initializes and verifies the
fresh twelve-table database and BlobStore before starting the candidate.

Both smoke commands must return distinct IDs, `status:"passed"`, and bounded
evidence. They exercise ordinary and structured pipelines before ingress
reopens. Success writes one checksum-bound completion report.

On any failure, the command stops the candidate and invokes restoration of the
matching old release/database/blob tuple. It writes a checksum-bound rollback
report and exits nonzero. New-epoch rows are never imported into the old
database. The archived old tuple is retained until the operator accepts the new
epoch.

The normal deployment workflow performs direct releases only after this
one-time replacement. It does not reproduce maintenance phases or storage
authority in CI YAML. See
[`runbooks/execution-kernel-rollout.md`](runbooks/execution-kernel-rollout.md).

## 13. Verification contract

Every release must pass:

- contract validation and cross-reader/cross-process canonical-byte fixtures;
- compiler closure, platform trust, and cold-manifest reconstruction tests;
- pure reducer, transition idempotency, persistence restart, and corruption
  tests;
- inspect/edit action-profile and native-session fencing tests for every engine;
- semantic normalization, result-pending correction, and exhaustion tests;
- ordinary and structured coordinator tests on the shared kernel;
- Effect reconciliation, acknowledgement-loss, unknown-outcome, and runtime
  cleanup tests;
- fresh epoch, blob fault-injection, maintenance ingress, HTTP, CLI projection,
  and offline replacement/rollback tests;
- TypeScript build/typecheck, all project test suites, Bats runtime tests,
  Docker ordinary smoke, and structured walking skeleton.

Credentialed live proof additionally runs one named disposable ordinary item
and one structured item, records their IDs and replacement report digest, and
verifies no runtime resource remains before the epoch is accepted.
