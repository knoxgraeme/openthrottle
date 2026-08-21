# AGENTS.md

Guidance for coding agents working in this repository. This is the canonical
instruction file; `CLAUDE.md` imports it with `@AGENTS.md`.

## What OpenThrottle is

OpenThrottle is a plan-first software factory. A registered Linear ticket or
GitHub Issue selects a filesystem-authored pipeline at an exact Git commit. The
Fly supervisor compiles that pipeline and all of its dependencies into an
immutable DefinitionBundle, then advances one deterministic execution kernel.
Agent reasoning runs inside a fenced Daytona sandbox; the supervisor owns
identity, state, Git checkpoints, external effects, and publication.

```text
control event -> DefinitionBundle -> PipelineRun -> Attempt
                                             |-> Record
                                             |-> Checkpoint
                                             `-> Effect -> DeliveryRecord
```

[`docs/SPEC.md`](docs/SPEC.md) is normative. [`docs/PLAN.md`](docs/PLAN.md)
states the shipped acceptance boundary. Read the spec first when a change
touches a contract.

[`docs/solutions/`](docs/solutions/) contains searchable learnings from past
bugs, architecture decisions, and workflow improvements. Entries are organized
by category and indexed by YAML frontmatter such as `module`, `tags`, and
`problem_type`; they are relevant when implementing or debugging in a
documented area. [`CONCEPTS.md`](CONCEPTS.md) defines the shared domain
vocabulary used across plans, tickets, documentation, and code.

## Four npm projects, no root package

`contracts/`, `supervisor/`, `cli/`, and `sandbox/` are independent projects.
Always select one with `--prefix`:

```bash
npm ci --prefix contracts && npm ci --prefix supervisor && npm ci --prefix cli && npm ci --prefix sandbox

npm run typecheck --prefix contracts && npm run build --prefix contracts
npm run typecheck --prefix supervisor && npm run typecheck --prefix cli
npm run build --prefix supervisor && npm run build --prefix cli

npm test --prefix contracts
npm test --prefix supervisor
npm test --prefix cli
npm test --prefix sandbox
bats sandbox/tests/runtime.bats
```

Run one Vitest file after `--`, for example:

```bash
npm test --prefix supervisor -- src/persistence/kernel-store.test.ts
npm test --prefix supervisor -- -t "reconciles an unknown effect"
```

Node 22 is required. TypeScript is ESM with `moduleResolution: nodenext`, so
relative imports include `.js` even when their source is `.ts`.

The complete local/CI proof is:

```bash
npm run typecheck --prefix contracts && npm run build --prefix contracts
npm run typecheck --prefix supervisor && npm run typecheck --prefix cli
npm run build --prefix supervisor && npm run build --prefix cli
npm test --prefix contracts && npm test --prefix supervisor
npm test --prefix cli && npm test --prefix sandbox
bats sandbox/tests/runtime.bats
docker build -f sandbox/Dockerfile -t openthrottle:test .
sandbox/tests/smoke.sh openthrottle:test
node sandbox/tests/structured-walking-skeleton.mjs openthrottle:test
```

Credentialed Linear, GitHub, Daytona, and Fly checks are operator gates and are
never implied by local or CI success.

## Authored definitions

Behavior that users template belongs under `.openthrottle/`:

```text
.openthrottle/
  config.yml
  agents/<id>/instructions.md
  pipelines/<id>/pipeline.yml
  pipelines/<id>/loops/<loop>.yml
  skills/<id>/SKILL.md
  evals/<id>/eval.yml
```

Pipeline is the only public orchestration concept. A loop normally stays inline;
use a pipeline-local loop file only when the body is large enough to obscure the
pipeline. Compiled manifests are private runtime protocol, not another authoring
surface.

An agent definition contains standing role instructions only. An action is
composed at runtime from those instructions, the sealed task prompt, and only
the skills named by its compiled stage. Skills keep their native progressive
disclosure: do not paste an entire skill library into the standing prompt and
do not duplicate a skill body per engine.

The compiler reads an exact Git subject through a bounded reader, rejects
ambiguous or unsafe paths, normalizes every selected definition, closes over
the pipeline's transitive dependencies, and emits byte-identical bundle bytes.
The bundle hash is durable run identity. Recovery recompiles the private
manifest from those exact bytes and release-sealed platform hashes; it does not
reread mutable source files.

## Repository authority

Every agent action has exactly one repository authority:

- `inspect` receives an immutable exact-subject checkout. The executor disables
  remotes and mutation, and also applies provider-native read-only tool policy.
  Review, planning, acceptance, and result correction use this authority.
- `edit` receives an isolated writable content tree. The agent may change files
  but still cannot administer Git, commit, push, publish, or claim an external
  effect. The executor captures the resulting tree as a checkpoint.

Keep review actions inspect-only. A blocking finding schedules a distinct edit
remediation Attempt. Commands that naturally write caches or build output are
deterministic command Attempts, not a reason to make the review checkout
writable. An inspect action that reviews edits receives the exact edited subject
and the preceding accepted checkpoint boundary.

## Execution ownership

Agent actions return a small semantic ResultCandidate defined by their eval.
The executor supplies the attempt, request, DefinitionBundle, subject, session,
checkpoint, timestamps, and provenance fields. Never ask an agent to reproduce
those fields.

The deterministic normalizer may perform only transformations declared by the
eval. In particular, `string-array-to-newlines/v1` converts an array-valued
`payload.summary` into a newline-delimited string and records both hashes. If a
candidate is still invalid after normalization, completed work enters
`result_pending`; the same native session gets a bounded, result-only correction
request with only `ot-result`. Formatting failure must not rerun successful code
work.

Ordinary and structured pipelines share four primitives:

- **Attempt** — one leased unit of agent, command, effect, or wait work, fenced
  by request hash, DefinitionBundle hash, exact input subject, and authority.
- **Record** — immutable `result`, `decision`, or `delivery` evidence.
- **Effect** — a write-ahead intent for an external mutation, carrying one
  immutable idempotency key. Reconcile before write; an unknown outcome is never
  blindly replayed.
- **Checkpoint** — executor-captured subject and evidence for accepted work.

The reducer is pure; persistence commits transitions atomically. Agent output
does not move the cursor, settle an Attempt, advance a subject, or authorize an
Effect by itself.

## Repository boundaries

- `contracts/` owns canonical JSON, hashes, definition compilation, result,
  record, effect, checkpoint, and pipeline contracts shared across processes.
- `supervisor/src/index.ts` is the production composition root.
- `supervisor/src/app/` owns admission, control, bootstrap, action/session
  orchestration, and provider-neutral ports.
- `supervisor/src/pipeline/kernel/` owns the pure reducer, action construction,
  evaluation, structured-frontier logic, and successor derivation.
- `supervisor/src/persistence/` is the only SQLite boundary. It also owns the
  storage-safe one-shot offline replacement. The fresh epoch has
  exactly twelve tables: `schema_migrations`, `settings`, `leases`,
  `repository_registrations`, `work_items`, `inbox_events`, `definitions`,
  `pipeline_runs`, `attempts`, `records`, `effects`, and `checkpoints`.
- `supervisor/src/operations/` owns effect draining, reconciliation, and
  cleanup.
- `supervisor/src/providers/` contains provider clients/adapters. Provider SDKs
  do not cross into sibling provider trees.
- `supervisor/src/runtime/` owns the provider-neutral sandbox wire contract and
  runtime-resource lifecycle.
- `supervisor/src/http/` owns Hono, auth/signature checks, bounded input, and
  response mapping.
- `sandbox/` validates and executes one sealed action or result correction. Its
  private state lives outside the repository view.
- `skills/planning/` and `skills/operator/` are local human-facing tools.
  Runtime skills live under `.openthrottle/skills/`.
- `cli/` is a plain argv router for setup, initialization, validation, shipping,
  status, logs, analysis, and control.

Large immutable payloads use content-addressed blobs. SQLite keeps their SHA-256
digest, byte count, encoding, media type, and payload schema. A blob must be
written and verified before a relational pointer commits. Active reads verify
the object; settled records remain immutable.

## Security invariants

- Registered repositories are trusted to execute their validated bootstrap and
  command configuration. Ticket text, issue bodies, review text, commit
  messages, and repository content remain untrusted input.
- A sandbox receives only repository, model, and scoped provider credentials.
  Daytona, Fly, webhook, installation, and operator credentials stay in the
  supervisor.
- One registered control route maps to one GitHub repository. Unmatched routes
  fail closed.
- Native session IDs bind atomically to a live leased Attempt and its exact run,
  cursor, request, bundle, input subject, retry ordinal, and correction count.
- Git remotes and refs are executor-owned. Agents never publish.
- Mutating ingress returns a retryable non-acknowledgement while maintenance is
  closed, so providers retry into the fresh epoch instead of crossing epochs.

The current dogfood epoch is replaced offline, not migrated in place. Stop all
writers, archive and hash the old database/blob/release tuple, initialize
distinct empty paths, run ordinary and structured smoke items, then reopen
ingress. Do not add compatibility reads, dual writes, or a durable transition
state machine. See
[`docs/runbooks/execution-kernel-rollout.md`](docs/runbooks/execution-kernel-rollout.md).

## Operator GitHub work

The following applies only to an operator workstation with GitHub MCP tools.
Sandbox actions follow their sealed request instead.

Use `mcp__github__*` tools for GitHub operations. Do not open a pull request
unless explicitly asked. After creating one, subscribe to its activity and
surface CI failures or review comments as they arrive.
