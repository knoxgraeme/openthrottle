---
title: "Filesystem Definitions and Execution Kernel - Plan"
type: refactor
date: 2026-08-20
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
deepened: 2026-08-20
---

> **Operational supersession (2026-08-21):** The archive/restore hooks,
> prescribed canaries, replacement report, and readiness gate in this design
> history were removed before first dogfood. The current contract is the
> absent-path initializer, open-only boot, one writer, explicit ingress open,
> and fix-forward dogfood in [`docs/SPEC.md`](../SPEC.md) §12.

# Filesystem Definitions and Execution Kernel - Plan

## Goal Capsule

| Field | Contract |
|---|---|
| Objective | Make OpenThrottle easier to extend and more durable under agent failure by reducing authored definitions, execution state, and result handling to a small set of explicit concepts. |
| Means | Compile filesystem-authored definitions into one immutable bundle; compose each agent from instructions, a sealed task prompt, and progressively disclosed skills; execute every pipeline through one attempt/record/effect/checkpoint kernel. (KTD1–KTD6) |
| Authority | docs/SPEC.md owns runtime behavior. Deterministic executor fences outrank repository instructions, skills, task text, and agent output. |
| Stop conditions | Stop the replacement if any old writer is still running, the old release/storage archive cannot be verified, any supported engine cannot preserve the instruction/skill boundary, or a committed blob pointer cannot be resolved and verified. |
| Execution profile | Eleven dependency-ordered units. Contract and characterization coverage precede deletion. No intermediate unit is deployable, no compatibility store or online migration protocol is introduced, and the old installation is stopped before the fresh epoch starts. |
| Tail ownership | U8 owns deletion, offline replacement proof, ordinary and structured dogfood runs, and the final documentation update. |

---

## Product Contract

### Summary

OpenThrottle will expose one filesystem definition model rooted at .openthrottle/. A deterministic compiler will convert the selected pipeline and its transitive dependencies into one immutable DefinitionBundle. The supervisor will run both ordinary and structured work through the same durable kernel, while agents submit small semantic candidates that the executor turns into authoritative records.

### Problem Frame

The current system has accumulated parallel concepts and recovery paths. Public configuration selects graphs while the supervisor executes pipeline manifests. Ordinary stages and structured units persist similar lifecycles through separate stores and tables. Agent skills also carry role instructions, operating fences, craft guidance, and large receipt schemas in one body.

This duplication makes extensions expensive and turns formatting mistakes into task failures. OPE-188 is representative: a unit completed its code and tests, but an array-valued summary failed the receipt contract. The recovery system preserved the work, yet the action still settled as failed because semantic work and authority-heavy receipt construction share one model-authored boundary.

The live SQLite schema reflects these layers through roughly fifty tables and repeated identity columns. Large checkpoints and recovery payloads also share the database with hot scheduling state. These choices make the supervisor harder to reason about and leave future pipeline, agent, skill, and evaluation authors dependent on internal runtime concepts.

### Actors

- A1. Pipeline author — creates repository-owned pipelines, agent instructions, skills, and live gate definitions.
- A2. Execution agent — performs one fenced action and reports semantic facts about that action.
- A3. Executor — controls the action environment, validates submissions, derives Git and evidence facts, and creates ResultRecords.
- A4. Supervisor — reduces records into decisions, schedules attempts and effects, and owns durable recovery.
- A5. Operator — admits repositories, observes runs, handles needs_human outcomes, and performs the offline epoch replacement.

### Key Decisions

- **Filesystem definitions are the authoring source, and pipeline is the only public orchestration concept.** The database retains immutable normalized snapshots; compiled runtime manifests are private protocol. (session-settled: user-approved — chosen over definition/persona tables and a public graph/pipeline split: files are reviewable, templatable, and portable.) Governs R1–R4.
- **An agent is composed from stable instructions, a sealed action prompt, and separately disclosed skills; repository authority is either inspect or edit.** Inspect actions receive an exact-subject read view, edit actions receive an isolated writable worktree with executor-owned Git state, and no model owns commit, push, or publication. (session-settled: user-directed — chosen over using SKILL.md as the whole role prompt or treating `repo.write` as a generic credential: identity, reusable procedure, and repository authority have different lifecycles.) Governs R5–R7.
- **Agents report semantics; executors author authority.** Result validation and bounded correction preserve completed work without asking a model to echo fences, hashes, subjects, provenance, or timestamps. (session-settled: user-approved — chosen over model-authored receipts and prompt-only schema defense: deterministic fields should not be model obligations.) Governs R8–R12.
- **Ordinary and structured execution share one durable kernel and one identity spine.** (session-settled: user-approved — chosen over parallel stage and graph subsystems: both modes need the same attempts, records, effects, and checkpoints.) Governs R13–R17 and R22.
- **The live database contracts directly, large immutable bytes move behind content-addressed pointers, and the dogfood installation is replaced offline.** (session-settled: user-directed — chosen over compatibility compilation, dual schemas, and a durable cutover state machine: OpenThrottle has no external users and downtime is acceptable.) Governs R18–R21 and R23–R25.

### Requirements

#### Definition authoring and compilation

- R1. Repository behavior is authored under .openthrottle/config.yml, agents/<id>/instructions.md, pipelines/<id>/pipeline.yml, skills/<id>/SKILL.md, and evals/<id>/eval.yml.
- R2. The compiler reads definitions from exact Git subjects, rejects unsafe or ambiguous filesystem input, normalizes every accepted definition, and emits byte-identical bundles plus runtime validator artifacts in the CLI, supervisor, and sandbox.
- R3. A DefinitionBundle contains only the selected pipeline's transitive agent, skill, eval, pipeline-local loop, behavior-affecting config, compiler-version, and runtime-capability closure; platform and repository origins are explicit, the core namespace cannot be shadowed, and unrelated definitions do not change its hash.
- R4. Pipeline YAML is the sole public orchestration DSL; simple loops remain inline, complex loops may use files inside that pipeline directory, and no public graph contract, graph digest, graph alias, or graph selection key remains.

#### Agent composition and skill disclosure

- R5. Configuration uses engine for claude, codex, or opencode, while each agent action binds a separate agent_id and a bounded skill allowlist from the DefinitionBundle.
- R6. Every engine receives the same pinned platform fence, agent instructions, sealed task prompt, and skill catalog; full skill bodies and references remain undisclosed until activation, except that a pipeline may name one entry skill for immediate activation.
- R7. Every agent action compiles to one repository_authority of inspect or edit. Admission, planning, review, evaluation, and result-only correction inspect an exact sealed subject; implementation, simplification, investigation-with-fix, and remediation edit an isolated worktree. Instructions and skills cannot widen credentials, tools, MCP access, repository scope, session policy, or authority. No agent action may commit, push, or publish: the executor checkpoints an accepted edited tree and executes publication effects.

#### Semantic result boundary and recovery

- R8. An agent submits only the semantic fields defined by the action's referenced eval schema; the executor creates the record identity, subject, provenance, fence, assurance, evidence bindings, content hashes, and timestamps.
- R9. Provider-native structured output and ot-result submit feed the same generated validator and action-scoped compare-and-set path; an exact replay is idempotent and a conflicting replay is rejected.
- R10. A versioned normalization registry may apply only named field-level transformations that preserve bounded content, including an array of bounded summary strings to one newline-joined summary; every transformation retains original and normalized hashes plus diagnostics.
- R11. A cleanly completed action with a valid checkpoint but an invalid or missing candidate enters result_pending, resumes the same native session with repository mutation and non-result tools disabled, and never reruns the completed work.
- R12. Exhausted or unavailable result-only correction settles needs_human with its checkpoint, candidate, diagnostics, and session evidence intact; genuine launch, runtime, work, subject, or security failures keep their existing retryable or terminal meanings.

#### Shared execution kernel and identity

- R13. Ordinary stages, structured units, review fanout members, command gates, publication, and provider waits use the same Attempt lifecycle and differ only through compiled scope and executor metadata.
- R14. ResultRecord states observed action facts, DecisionRecord states a deterministic reducer or gate choice, and DeliveryRecord states an external effect outcome; artifacts are content referenced by these records, not additional receipt types.
- R15. A reducer transition atomically settles the current attempt, appends records, advances the run, schedules attempts or effects, and updates checkpoint metadata.
- R16. Runtime identity uses one canonical request_hash, one definition_bundle_hash, one input_subject on the attempt, one verified output_subject on a mutating ResultRecord, and one idempotency_key per effect.
- R17. Recovery compares the same attempt, request, bundle, subject, session, record, checkpoint, and idempotency identities so a restart cannot repeat completed work or externally visible delivery.
- R22. Every externally mutating effect uses provider-native idempotency or a deterministic external identity with read-before-write and unknown-outcome reconciliation; an indeterminate result is never blindly replayed.

#### Persistence, blobs, and offline replacement

- R18. The fresh SQLite epoch contains only the twelve tables declared by KTD5; definition snapshots use exactly definition_kind, definition_id, source_commit, content_hash, and normalized_payload as application fields.
- R19. Definition bundles, checkpoints, recovery packages, native-session packages, and evidence above a canonical 64 KiB UTF-8 boundary use supervisor-owned content-addressed blobs; bounded summaries, decisions, delivery metadata, leases, and indexed fence fields remain relational or inline.
- R20. The one-time replacement runs in an operator-declared maintenance window: admission and mutating ingress close, all supervisors and workers stop, and every dogfood run is either terminal or explicitly abandoned with its runtime resources cleaned before fresh storage starts.
- R21. The old database and blob root become a checksum-bound read-only archive; the live runtime contains no compatibility reads, bridge tables, dual writes, or active-run replay from that archive.
- R23. A one-shot replacement report records the old release and storage hashes, explicit abandonment decisions, bootstrap-manifest digest, new release and storage identities, integrity results, and smoke-run IDs; it is an operator artifact, not a runtime table or resumable phase protocol.
- R24. During maintenance, mutating ingress returns a retryable maintenance response and never acknowledges an uncaptured event. The operator chooses a quiet dogfood window and clears or accepts loss of internal provider activity; no cross-epoch provider-event migration, watermark, or replay protocol is built.
- R25. The new epoch opens after a checksummed bootstrap plus one ordinary and one structured smoke run pass against fresh database and blob paths. There is no fixed observation window; a failed smoke stops the candidate and restores the archived old release/storage pair.

### Success Criteria

- The OPE-188 summary-array fixture completes through the normalization path without a second work attempt.
- A malformed but repairable candidate enters result_pending and settles through the same native session without changing the verified output subject.
- Claude, Codex, and OpenCode start with equivalent instructions and skill metadata, and no provider receives every skill body or reference inline.
- One source commit and selected pipeline compile to the same DefinitionBundle hash in contracts, CLI, supervisor, and sandbox fixtures.
- Ordinary and structured Docker proofs persist only the shared kernel primitives and reach the same terminal outcomes as their current equivalents.
- A schema snapshot contains the twelve declared tables and no graph, receipt, unit-runtime, catalog-alias, or duplicated stage-runtime table.
- Large-payload tests prove blob-before-pointer ordering, digest verification, restart recovery, and an operator-visible response to missing or corrupt committed blobs.
- An offline replacement drill proves old writers are stopped, the archive is verifiable, fresh storage is empty and correctly initialized, both smoke modes pass, and rollback restores the matching old release/storage pair.

### Acceptance Examples

- AE1. Covers R9–R12. Given completed unit work whose candidate has summary as an array of bounded strings, submission records the normalization, joins the strings with newlines, creates one ResultRecord, and does not redispatch implementation.
- AE2. Covers R10–R12. Given an unknown outcome or contradictory semantic value, normalization does not guess; the attempt enters result_pending and receives JSON-pointer diagnostics in its same session.
- AE3. Covers R11–R12. Given result correction exhausts its budget, the run becomes needs_human with its output subject and checkpoint recoverable rather than failed with the work discarded.
- AE4. Covers R3 and R16. Given an unrelated skill changes after admission, an existing run continues on its pinned bundle and the unrelated edit does not change a newly compiled bundle for a pipeline that cannot reference it.
- AE5. Covers R6–R7. Given an inspect action allowlists review-change but not publish, the engine may disclose review-change and its references, can read only the sealed subject, and cannot edit, commit, push, discover publish, or invoke publication; a blocking finding schedules a distinct edit-authority remediation attempt.
- AE6. Covers R15–R17. Given the supervisor crashes after a candidate is staged but before record construction, restart creates at most one ResultRecord and schedules each resulting effect at most once.
- AE7. Covers R19. Given a blob write fails, SQLite never commits its pointer; given a committed blob later fails digest verification, the attempt becomes operator-actionable and cannot settle from corrupted evidence.
- AE8. Covers R20–R21 and R23. Given an old dogfood attempt, correction, effect, or runtime resource is still live, the replacement command refuses to initialize fresh storage until it is settled or the operator explicitly abandons it and cleanup is verified.
- AE9. Covers R22. Given a provider accepts an effect and the supervisor crashes before acknowledgement, recovery reconciles the deterministic external identity and appends one DeliveryRecord without repeating the mutation.
- AE10. Covers R23–R25. Given an event arrives during maintenance, the route returns a retryable maintenance response without acknowledging or storing it; after the fresh epoch opens, a provider retry is handled as an ordinary deduplicated inbox event.

### Scope Boundaries

#### Included

- Filesystem definitions, compilation, bundle pinning, CLI scaffolding, and validation.
- Pipeline/graph convergence, inline or pipeline-local loops, and live referenced eval definitions.
- Engine/agent vocabulary, standing instructions, progressive skills, semantic submission, normalization, and result-only recovery.
- Shared run, attempt, record, effect, and checkpoint behavior plus the contracted SQLite epoch.
- Volume-backed content-addressed blobs, one-shot replacement tooling, runtime removal, tests, and documentation.

#### Outside This Change

- Arbitrary repository code executing inside the supervisor.
- A hosted or multi-tenant definition registry.
- Compatibility compilation, legacy configuration aliases, old-schema readers, or live data backfill.
- Zero-downtime migration, an online cutover state machine, cross-epoch event bridging, provider watermark reconciliation, or preservation of abandoned dogfood runs.
- An external object-storage provider, blob garbage collection, and cross-region replication.

#### Deferred to Follow-Up Work

- Offline eval orchestration, longitudinal quality scoring, and automatic skill or pipeline tuning from the new record corpus.
- A remote BlobStore adapter if deployment topology outgrows the supervisor volume.
- A UI for browsing definition bundles, skill disclosures, and archived historical runs.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Compile a dependency-closed DefinitionBundle through shared contracts.** The pure compiler accepts a bounded virtual file map so the CLI, GitHub-backed admission, build tooling, and tests use one parser and canonicalizer. It assigns explicit platform or repository origin, reserves the core namespace, and emits sealed validator/normalizer artifacts for the sandbox image. Each entry keeps its own content hash inside the bundle index, while requests carry only the bundle hash. This implements R1–R4. (session-settled: user-approved — chosen over per-kind registries and independent runtime digests: one closure is the immutable behavior identity.)
- KTD2. **Materialize one sealed action profile per engine.** The profile layers the platform fence, plain agent instructions, and the action prompt, exposes only the allowlisted Agent Skills packages through the host's progressive-disclosure mechanism, and compiles repository_authority independently as inspect or edit. Inspect uses one immutable exact-subject view and provider-native read-only/tool restrictions where available; edit uses an isolated worktree whose Git administration and remotes remain executor-owned. Native CLI restrictions are defense in depth, not the cross-engine authority boundary. OpenCode must gain a sealed native skill root or fail capability admission; full-body inlining is not a fallback. This implements R5–R7. (session-settled: user-directed — chosen over SKILL.md as the role prompt and over agent-owned commits: instructions, reusable capabilities, tree mutation, and publication evolve independently.)
- KTD3. **Use one staged semantic-candidate ingress.** The contracts build emits one sealed JavaScript validator/normalizer and provider JSON Schemas whose digest enters runtime capability identity. The sandbox image copies that artifact, and both ot-result submit and provider-native final output execute it. A staged candidate becomes authoritative only after engine completion and executor verification of the action's Git and evidence postconditions. This implements R8–R9.
- KTD4. **Make normalization and result repair deterministic state.** The normalizer uses a closed versioned registry and records its transformations. Invalid clean-exit output advances work_complete to result_pending; correction has its own lease, budget, deadline, and read-only tool policy. This implements R10–R12. (session-settled: user-approved — chosen over failing or rerunning completed work: formatting repair is not task execution.)
- KTD5. **Adopt a twelve-table baseline with five execution tables.** The live schema target is schema_migrations, settings, leases, repository_registrations, work_items, inbox_events, definitions, pipeline_runs, attempts, records, effects, and checkpoints. The five execution tables are pipeline_runs, attempts, records, effects, and checkpoints. Before DDL freezes, an invariant matrix maps every existing lifecycle to typed columns, cardinality, constraints, lease/CAS operations, and indexes. If an independently leased or queried lifecycle cannot fit without nullable polymorphism or JSON state scans, implementation stops for a SPEC amendment instead of silently adding a table or weakening an invariant. This implements R13–R18. (session-settled: user-approved — chosen over graph-, stage-, unit-, gate-, artifact-, and publication-specific tables: those are projections of the same lifecycle.)
- KTD6. **Store large immutable bytes in a volume-backed content-addressed store.** The first BlobStore adapter uses safe digest-derived regular-file paths, writes and file-syncs a temporary object, verifies digest and size, publishes without clobber, directory-syncs the parent, and returns a typed prewrite token before SQLite may commit a pointer. The pointer includes algorithm, digest, byte size, encoding, media type, and payload schema. Active-object corruption blocks recovery and becomes operator-actionable; settled records remain immutable and raise a global integrity incident. Initial delivery does not delete blobs. Agents receive authorized materializations, never blob-store credentials. This implements R19.
- KTD7. **Replace the dogfood installation offline as one release unit.** A one-shot operator command closes ingress, stops every old process, requires terminal or explicitly abandoned dogfood work, snapshots and verifies the old database/blob/release tuple, initializes distinct empty storage from a bounded bootstrap file, deploys one new release tuple, and runs ordinary plus structured smoke work before reopening. The command emits a checksum-bound report but creates no cutover table, phase state machine, provider-watermark protocol, or compatibility path. Rollback stops the candidate and restores the archived old tuple; no new-epoch row is imported backward. This implements R20–R21 and R23–R25. (session-settled: user-directed — chosen over compatibility compilation, dual operation, and an online cutover protocol: there are no external consumers and downtime is acceptable.)
- KTD8. **Treat eval files as live declarative gate definitions, not executable plugins.** A referenced eval binds a bounded semantic result schema and a runtime-registered deterministic evaluator primitive. Agent judgment remains an explicit pipeline action that returns a ResultRecord. Offline corpus evaluation and self-tuning stay deferred.
- KTD9. **Keep authority-separated ports over shared records.** Reducers may read only their current aggregate and exact record IDs; context resolution accepts an explicit allowlist; effect workers receive leased effect views; status/log consumers receive projections; historical analysis uses a separately wired read port that decision code cannot import. Result, Decision, and Delivery payloads remain schema-versioned unions with kind-specific ownership constraints.
- KTD10. **Bind runs to content-addressed bundles, not an unsafe definitions foreign key.** definitions uses a composite immutable key over its five application fields and permits identical content across IDs or commits. The canonical bundle bytes are prewritten to BlobStore by hash and normalized bundle entries remain in definitions for provenance. pipeline_runs.definition_bundle_hash is a verified content-addressed pointer, not a foreign key to non-unique definition content.

### Output Structure

The OpenThrottle repository carries the built-in definitions in the same shape that target repositories may extend:

~~~
.openthrottle/
  config.yml
  agents/
    <agent-id>/
      instructions.md
  pipelines/
    <pipeline-id>/
      pipeline.yml
      loops/
        <complex-loop>.yml
  skills/
    <skill-id>/
      SKILL.md
      references/
        ...
  evals/
    <eval-id>/
      eval.yml
~~~

The loops/ directory is optional. Simple loops stay inside pipeline.yml. Existing skills/planning/ and skills/operator/ remain product-distribution assets; only sandbox task definitions move into the compiled definition tree.

### High-Level Technical Design

#### Definition and execution topology

~~~mermaid
flowchart LR
    Git["Exact Git subject<br/>.openthrottle/"] --> Compiler["Shared definition compiler"]
    Runtime["Pinned runtime capabilities"] --> Compiler
    Compiler --> Bundle["Dependency-closed<br/>DefinitionBundle + runtime validators"]
    Bundle -. verified bytes .-> Blob
    Bundle --> Definitions["definitions snapshot"]
    Bundle --> Run["pipeline_run<br/>bundle hash"]
    Run --> Attempt["attempt<br/>request hash + input subject"]
    Attempt --> Profile["Sealed engine profile<br/>fence + instructions + prompt"]
    Profile --> Skills["Allowlisted skill catalog<br/>bodies disclosed on activation"]
    Skills --> Candidate["Semantic candidate"]
    Candidate --> Result["ResultRecord<br/>verified output subject"]
    Result --> Reducer["Deterministic reducer / eval"]
    Reducer --> Decision["DecisionRecord"]
    Reducer --> Next["Next attempt or effect"]
    Next --> Delivery["DeliveryRecord"]
    Result -. large evidence .-> Blob["Content-addressed BlobStore"]
    Decision -. large evidence .-> Blob
    Run --> Checkpoint["checkpoint"]
    Checkpoint -. payload .-> Blob
~~~

#### Directional pipeline grammar

~~~yaml
id: structured
entry: implement
stages:
  - id: implement
    agent: implementer
    entry_skill: implement-unit
    skills: [repository-research, testing]
    eval: unit-result
    loop:
      over: execution_plan.units
      body: [...]
    on:
      success: review
      needs_human: terminal
~~~

The authored DSL names product concepts. The compiler expands defaults, validates references and capability limits, and emits the private runtime manifest. Complex loop bodies may move to pipelines/<pipeline-id>/loops/ without becoming globally addressable definitions.

#### Candidate settlement and external delivery

~~~mermaid
sequenceDiagram
    participant A as Agent session
    participant X as Sandbox executor
    participant S as Supervisor
    participant B as BlobStore
    participant P as Provider
    A->>X: ot-result submit(candidate)
    X->>X: normalize and validate
    X-->>A: accepted or JSON-pointer diagnostics
    A-->>X: engine exits
    X->>X: verify subject and evidence
    X->>S: staged candidate + checkpoint
    S->>B: write and verify large payloads
    B-->>S: immutable pointers
    S->>S: append ResultRecord + advance attempt to recorded atomically
    S->>S: reduce recorded attempt + append DecisionRecord + settle + schedule atomically
    S->>P: execute with idempotency key
    P-->>S: provider acknowledgement
    S->>S: append DeliveryRecord and settle effect atomically
~~~

#### Attempt and result-repair lifecycle

~~~mermaid
stateDiagram-v2
    [*] --> pending
    pending --> running: fenced lease
    running --> work_complete: clean engine exit + checkpoint
    running --> failed: genuine terminal work or security failure
    running --> pending: retryable infrastructure failure
    work_complete --> recorded: valid candidate + verified postconditions
    work_complete --> result_pending: invalid or missing candidate
    result_pending --> recorded: same-session result-only correction
    result_pending --> needs_human: budget, deadline, or session exhausted
    recorded --> settled: reducer transaction
    settled --> [*]
    needs_human --> [*]
    failed --> [*]
~~~

### Persistence Ownership

| Table | Sole responsibility |
|---|---|
| schema_migrations | Fresh schema-epoch version and checksum ledger. |
| settings | Operator-controlled scalar configuration that is not definition content. |
| leases | Supervisor-wide singleton or maintenance leases that do not belong to one attempt or effect. |
| repository_registrations | Trusted repository routing and provider identity. |
| work_items | One admitted unit of user-requested work and its source reference. |
| inbox_events | Deduplicated inbound provider, webhook, command, and steering events. |
| definitions | Immutable normalized filesystem definitions using the five fields in R18; repeated content across IDs or commits is valid and provenance remains explicit. |
| pipeline_runs | Run status, selected pipeline, work item, bundle hash, current subject, and reducer cursor. |
| attempts | Fenced stage/unit/action lifecycle, parent/scope metadata, request hash, session, leases, and input subject. |
| records | Immutable, schema-versioned result, decision, or delivery facts with kind-specific owner constraints, hot index fields, and bounded payload or blob pointer. |
| effects | Durable external or runtime work with lease, retry state, one idempotency key, immutable intent hash, and reconciliation identity. |
| checkpoints | Resumable Git/session/runtime state and verified blob pointers. |

The definitions composite key preserves kind, ID, source commit, content hash, and normalized payload provenance. A run's definition_bundle_hash addresses canonical bundle bytes in BlobStore and is verified in the create-run transaction; it is not a foreign key to a content hash that may legitimately repeat in definitions.

Before U6 writes DDL, the implementation must add a SPEC matrix that maps every old table, state machine, and store operation to: its target owner; relational columns; PK/FK/UNIQUE/CHECK/NOT NULL/delete rules; lease and compare-and-set fence; required indexes; payload schema; authorized read port; and characterization test. This matrix is the proof that twelve tables are sufficient.

### Sequencing

~~~mermaid
flowchart LR
    U1["U1 Contracts"] --> U2["U2 Definitions"]
    U1 --> U4["U4 Results"]
    U2 --> U3["U3 Agent profiles"]
    U2 --> U5["U5 Kernel"]
    U4 --> U5
    U5 --> U6["U6 Schema + blobs"]
    U3 --> U7["U7 Admission + ordinary"]
    U6 --> U7
    U7 --> U9["U9 Structured execution"]
    U9 --> U10["U10 Effects + resources"]
    U10 --> U11["U11 Inbox + projections"]
    U11 --> U8["U8 Removal + offline replacement"]
~~~

### Assumptions

- OpenThrottle has no external users during this refactor. The only active work is controlled dogfood work, downtime is acceptable, and an operator may explicitly abandon it before replacement.
- A volume-backed BlobStore is sufficient for the current single-supervisor Fly topology.
- Supported OpenCode can be upgraded or configured to expose a sealed skill root progressively; otherwise OpenCode admission fails for skill-bound stages until it can.
- The old database remains valuable as an archive for manual analysis, but no live self-improvement path requires querying it after replacement.
- A 64 KiB evidence threshold matches the existing receipt boundary closely enough to be the initial inline/blob split; later tuning may change the threshold without changing record semantics.
- Repository registrations and operator settings are re-created from a bounded, checksummed bootstrap manifest in the new epoch; they are not read through the retired schema.

### System-Wide Impact

- Pipeline authors use one directory and one pipeline term. Existing graph/config examples become invalid at the clean cut.
- Agent behavior becomes easier to review because role instructions and task skills have separate diffs and hashes.
- Status, logs, analysis, recovery, steering, publication, and provider feedback must read the shared records rather than mode-specific projections.
- The new record corpus captures candidate diagnostics, normalization, correction, skill disclosure, reducer input IDs, and delivery outcomes for later self-improvement without granting those observations live authority.
- Operators coordinate one offline stop/archive/recreate/start window and retain the old release plus storage snapshot until the new ordinary and structured smoke runs pass.
- The shared records table does not broaden authority: reducers, context resolvers, effect workers, projections, and historical analysis receive distinct ports and query scopes.
- Webhook and control ingress return retryable maintenance responses while stopped; the quiet dogfood window intentionally has no cross-epoch event bridge.

### Risks and Mitigations

| Risk | Mitigation |
|---|---|
| A large rewrite silently changes execution behavior. | Build contract fixtures and a pure reducer first; port ordinary and structured fixtures to the new kernel before deleting old code; deploy only the new path. |
| Normalization hides a semantic error. | Use a closed field-level registry, keep original and normalized hashes, reject ambiguous values and unknown fields, and surface every applied rule. |
| Result repair mutates completed work. | Lock the worktree and output subject before correction; resume with result-only tools and no write, MCP, provider, or publication authority. |
| Provider skill behavior diverges. | Test sealed profile composition and disclosure for each pinned engine; fail admission rather than inline all content or expose ambient skills. |
| Bundle hashing churns on unrelated files. | Compile only the selected transitive closure and normalize ordering, line endings, YAML, and referenced resources. |
| Blob/database ordering creates dangling pointers. | Publish and verify blobs before the SQLite transaction; retry transient reads; make digest mismatch needs_human and operator-visible. |
| Offline replacement discards wanted dogfood work. | List every nonterminal run before shutdown; settle it or record an explicit abandonment, verify resource cleanup, then snapshot database and blob root before creating fresh storage. |
| The new schema becomes a JSON dumping ground. | Keep all fence, lease, state, parent, subject, idempotency, and query fields relational; bound and schema-check every cold payload. |
| The twelve-table target hides an independent lifecycle. | Complete the lifecycle-to-schema matrix before DDL; stop for a SPEC amendment if typed constraints and indexed operations cannot represent it cleanly. |
| Old and new supervisors write concurrently. | Stop and verify every old machine and worker before initializing distinct fresh paths; the replacement command refuses to continue while an old process or storage lock is live. |
| Provider success is lost before acknowledgement. | Give every effect primitive provider-native idempotency or a deterministic external identity and reconciler; block unknown outcomes instead of replaying. |
| A provider event arrives during maintenance. | Choose a quiet dogfood window and return retryable maintenance without acknowledgement. No external user event requires preservation; any internal event not retried is explicitly accepted as disposable dogfood activity. |
| Restoring the old snapshot leaves smoke artifacts. | Run smoke work on named disposable dogfood tickets/branches, stop the candidate before rollback, archive its storage for diagnosis, and close or delete its test artifacts manually; do not build a general compensation ledger. |

### Sources and Research

- docs/SPEC.md — normative supervisor, sandbox, schema, and sanitization contracts.
- AGENTS.md — package boundaries, test matrix, runtime safety, and architecture constraints.
- contracts/src/config.ts, contracts/src/graph.ts, supervisor/src/pipeline/manifest.ts, and supervisor/src/pipeline/execution-graph.ts — current graph/pipeline duality.
- supervisor/src/persistence/pipeline/transition-store.ts and supervisor/src/persistence/pipeline/unit-store.ts — duplicated atomic execution paths.
- contracts/src/receipts.ts, sandbox/runner/execute-loop.mjs, and sandbox/runner/execute-stage.mjs — current receipt burden and the admission semantic-output precedent.
- supervisor/src/persistence/migrations/definitions.ts — current schema growth and obsolete representation layers.
- supervisor/src/persistence/admission-drain-store.ts and supervisor/src/persistence/deployment-cutover-store.ts — current incomplete drain vocabulary and database-local cutover authority.
- supervisor/src/persistence/pipeline/analysis-store.ts — existing separation between historical evidence and live gate authority.
- skills/README.md and skills/tasks/implement-unit/SKILL.md — provider delivery and mixed role/procedure/receipt content.
- Commit 8a72658 and follow-up receipt-recovery commits — prompt enumeration did not eliminate receipt-shape failures.
- Agent Skills specification: https://agentskills.io/specification
- Agent Skills client implementation guide: https://agentskills.io/client-implementation/adding-skills-support

---

## Implementation Units

### Unit Index

| Unit | Outcome | Key files | Depends on |
|---|---|---|---|
| U1 | Unified definition, semantic-result, record, effect, and identity contracts | docs/SPEC.md; contracts/src/ | None |
| U2 | Pure filesystem/Git definition compiler plus CLI scaffolding | .openthrottle/; contracts/src/definition-bundle.ts; cli/src/ | U1 |
| U3 | Engine-neutral standing instructions, progressive skills, and inspect/edit authority profiles | sandbox/runner/; sandbox/Dockerfile | U2 |
| U4 | Semantic submission and result-repair protocol, characterized but not yet activated | sandbox/bin/; sandbox/runner/ | U1 |
| U5 | Pure shared reducer and authority-separated kernel ports | supervisor/src/pipeline/kernel/ | U2, U4 |
| U6 | Fresh twelve-table epoch and durable content-addressed BlobStore | supervisor/src/persistence/ | U5 |
| U7 | Bundle-pinned admission and ordinary execution on the new kernel | supervisor/src/app/; supervisor/src/pipeline/ | U3, U6 |
| U9 | Structured units, integration, review fanout, and downstream context on the same kernel | supervisor/src/pipeline/; supervisor/src/operations/ | U7 |
| U10 | Idempotent provider effects and runtime-resource lifecycle | supervisor/src/operations/; supervisor/src/providers/ | U9 |
| U11 | Closed ingress, steering, feedback, status, logs, and analysis projections | supervisor/src/http/; supervisor/src/persistence/; cli/src/ | U10 |
| U8 | Deletion ledger, offline fresh-epoch replacement, smoke proof, and documentation | deploy workflow; smoke proofs; docs/ | U11 |

Unit IDs remain stable after deepening; U8 is intentionally the final unit even though U9–U11 were added to split its prerequisites.

### U1. Establish the unified contracts and vocabulary

**Goal:** Define the clean public contracts, record semantics, identity spine, and generated schema sources before changing runtime behavior.

**Requirements:** R2–R4, R8–R10, R13–R18, R22; KTD1, KTD3, KTD5, KTD9–KTD10.

**Dependencies:** None.

**Files:**

- docs/SPEC.md
- contracts/src/config.ts
- contracts/src/definition-bundle.ts
- contracts/src/pipeline.ts
- contracts/src/result-candidate.ts
- contracts/src/records.ts
- contracts/src/effects.ts
- contracts/src/validation.ts
- contracts/src/index.ts
- contracts/scripts/build-runtime-artifacts.mjs
- contracts/generated/
- contracts/src/contracts.test.ts
- contracts/src/determinism-fixture.ts
- contracts/fixtures/

**Approach:**

1. Add the canonical definitions for engine, agent_id, DefinitionBundle, authored pipeline, private compiled manifest, ResultCandidate, schema-versioned record unions, effect intent, BlobPointer, and the attempt identity fields.
2. Build sealed JavaScript validator/normalizer artifacts and provider JSON Schemas from the same TypeScript source; hash the generated artifact set and reject hand-maintained sandbox mirrors.
3. Define the versioned normalization registry contract and include the OPE-188 summary-array transformation.
4. Specify platform versus repository origin, reserved namespaces, bundle-entry identity, exact input/output Git subjects by concern, and immutable effect intent/idempotency identity.
5. Mark graph and receipt contracts for removal without adding aliases to the new parsers.
6. Update SPEC with the authoritative meanings of pipeline, attempt, result, decision, delivery, effect, checkpoint, work_complete, and result_pending.

**Patterns to follow:** contracts/src/canonical.ts for canonical JSON and digest stability; contracts/src/admission-evaluation.ts for semantic-only output schemas; contracts/src/validation.ts for strict bounded parsing.

**Test scenarios:**

- The same virtual definition map compiles to byte-identical normalized contracts across repeated runs and key-order or line-ending variations.
- Unknown fields, duplicate IDs, path traversal, symlinks, oversized files, invalid skill frontmatter, and unresolved pipeline references fail with stable paths.
- Result candidates reject authority fields such as subject, fence, assurance, producer, hash, and timestamp.
- Covers AE1. A bounded string-array summary produces the documented normalized string and retains both candidate hashes.
- Ambiguous arrays, non-string members, unknown outcomes, and extra semantic fields remain invalid.
- The built JavaScript validator and every provider schema match the TypeScript fixture corpus byte-for-byte, and the sandbox can load only the sealed generated artifact.
- Reusing an idempotency key for a different effect kind, subject, payload, or immutable intent hash is a contract error.

**Verification:** Shared contracts expose no new public graph or receipt type, all schemas have determinism fixtures, and SPEC names one owner for each identity and lifecycle rule.

### U2. Build the filesystem definition compiler and scaffolding

**Goal:** Make .openthrottle/ the sole authoring surface and produce one deterministic dependency closure without switching live admission or persistence yet.

**Requirements:** R1–R4, R16; KTD1, KTD8.

**Dependencies:** U1.

**Files:**

- .openthrottle/config.yml
- .openthrottle/agents/*/instructions.md
- .openthrottle/pipelines/*/pipeline.yml
- .openthrottle/pipelines/*/loops/*.yml
- .openthrottle/skills/*/SKILL.md
- .openthrottle/evals/*/eval.yml
- supervisor/src/pipeline/manifest.ts
- supervisor/src/providers/github/client.ts
- cli/src/init.ts
- cli/src/init.test.ts
- cli/src/plan.ts
- cli/src/plan.test.ts
- contracts/src/definition-bundle.test.ts
- supervisor/src/pipeline/manifest.test.ts
- sandbox/tests/definition-bundle-determinism.test.mjs

**Approach:**

1. Move built-in runtime definitions into the target layout and keep operator/planning skills outside the runtime bundle.
2. Give filesystem and GitHub readers the same bounded virtual file-map interface.
3. Compile the selected pipeline's transitive closure, reject implicit overrides, and include behavior-affecting config plus compiler/runtime capability identity.
4. Make init write .openthrottle/config.yml and optional starter directories; make plan validation name pipelines, not graphs.
5. Produce canonical definition entries and bundle bytes for later storage, but do not alter admission, catalog persistence, or production selection in this unit.

**Execution note:** Start with golden compiler fixtures before moving built-in files so path and digest drift is visible.

**Patterns to follow:** supervisor/src/pipeline/manifest.ts strict YAML parsing; supervisor/src/providers/github/client.ts bounded repository package reads; CLI init fixtures for deterministic generated files.

**Test scenarios:**

- Covers AE4. Editing an unrelated skill or eval does not change a bundle that cannot reference it.
- Editing any selected instruction, skill body/reference, pipeline loop, eval, behavior config, compiler version, or runtime capability changes the bundle hash.
- Cyclic references, duplicate namespace IDs, missing entry skills, evals bound to unknown primitives, and pipeline-local loop escapes fail before admission.
- Filesystem, CLI, and Git-backed readers compile the same commit and pipeline to the same bytes and hash.
- A sandbox fixture loads the same source-pinned corpus and asserts canonical bundle bytes and hash equal the contracts, CLI, and supervisor outputs.
- Init creates the new tree and never emits default_graph, graphs, graph aliases, or the old root .openthrottle.yml.
- Identical normalized content under different definition IDs or source commits remains distinct provenance while sharing content hashes safely.

**Verification:** Golden fixtures prove compiler and scaffold behavior with no production admission or persistence switch in this unit.

### U3. Separate agent instructions from progressive skills

**Goal:** Give every supported engine the same sealed agent composition without treating a skill body as the standing role prompt.

**Requirements:** R5–R7, R16; KTD2.

**Dependencies:** U2.

**Files:**

- sandbox/Dockerfile
- sandbox/entrypoint.sh
- sandbox/runner/action-home-baseline.mjs
- sandbox/runner/loop-agent-environment.mjs
- sandbox/runner/repository-skills.mjs
- sandbox/runner/build-opencode-config.mjs
- sandbox/runner/execute-stage.mjs
- sandbox/runner/execute-loop.mjs
- skills/codex/AGENTS-fragment.md
- sandbox/runner/action-home-baseline.test.mjs
- sandbox/runner/loop-agent-environment.test.mjs
- sandbox/runner/build-opencode-config.test.mjs
- sandbox/runner/execute-stage.test.mjs
- sandbox/runner/execute-loop.test.mjs
- sandbox/tests/ce-adapters.test.mjs

**Approach:**

1. Build one action-profile adapter that materializes the platform fence, selected instructions, and only the allowed skill packages into engine-specific private roots.
2. Rename provider selection from agent to engine at the request/config boundary and carry agent_id independently.
3. Keep an optional entry skill explicit; leave other packages and all references/resources lazy through native disclosure.
4. Remove OpenCode body/reference inlining and require a pinned engine capability that can expose the sealed skill root.
5. Record only executor-observed skill activation and exact bundle entry hashes; never accept an agent-authored provenance list.
6. Replace generic repo.write inference with a compiled repository_authority. inspect actions use one executor-materialized exact-subject read-only view plus native CLI read-only/tool restrictions where supported; edit actions use an isolated writable content tree while Git administration, refs, remotes, commit creation, and push stay executor-owned.
7. Make every review action inspect-only. Remove the ordinary review adapter's small-fix exception and schedule a distinct edit-authority remediation attempt for blocking findings, matching structured execution.
8. Remove duplicated standing role and receipt material from task skills after equivalent instructions and result contracts exist.
9. Copy only U1's sealed generated validator/normalizer artifact into the sandbox image and include its digest in the engine capability profile.

**Patterns to follow:** Current root-owned Claude/Codex skill materialization and action-local home fences; AGENTS-fragment.md's distinction between standing context and skill workflow.

**Test scenarios:**

- Initial stdin and standing context for Claude, Codex, and OpenCode contain the same platform fence, selected instructions, and task prompt but no unactivated skill body or reference text.
- Covers AE5. An unlisted skill is absent from the action profile and cannot be discovered through ambient user, project, plugin, or compatibility paths.
- An entry skill activates at launch while a secondary skill loads only when selected; reference content remains lazy.
- New and resumed Codex action-local homes retain the selected instructions.
- An OpenCode build without sealed progressive-skill capability fails admission instead of receiving an inline fallback.
- Repository instructions that ask for wider credentials, tools, Git actions, or publication do not change the compiled executor fence.
- Admission, planning, review, evaluation, and result correction cannot modify the exact-subject view even when their prompt asks; implementation, simplification, investigation-with-fix, and remediation can edit only their isolated worktree.
- No agent can update Git refs or remotes. An accepted edit tree receives one executor-created checkpoint commit, while a blocking review creates a separate remediation attempt and never changes its reviewed subject.

**Verification:** Provider profile snapshots are equivalent at the contract level, and each engine's smoke trace proves bounded skill discovery from the pinned bundle.

### U4. Introduce semantic submission and result-only repair

**Goal:** Prevent repairable output-shape mistakes from failing or rerunning completed work.

**Requirements:** R8–R12, R16–R17; KTD3–KTD4.

**Dependencies:** U1.

**Files:**

- sandbox/bin/ot-result.mjs
- sandbox/bin/ot-result.test.mjs
- sandbox/bin/ot-stage-result.mjs
- sandbox/runner/execute-stage.mjs
- sandbox/runner/execute-loop.mjs
- sandbox/runner/loop-receipts.mjs
- sandbox/runner/artifacts.mjs
- sandbox/runner/admission-contracts.mjs
- sandbox/runner/execute-stage.test.mjs
- sandbox/runner/execute-loop.test.mjs
- sandbox/runner/artifacts.test.mjs
- sandbox/tests/contracts-mirror.test.mjs
- sandbox/tests/structured-walking-skeleton.mjs

**Approach:**

1. Replace full-receipt output with an action-scoped staged candidate path and generated validator.
2. Route ot-result submissions and native structured final output through the same normalizer, validator, and compare-and-set.
3. Keep a valid candidate staged until engine exit, output-subject verification, evidence derivation, and process cleanup succeed.
4. Emit work_complete and result_pending as explicit executor results with bounded diagnostics and the native session needed for result-only correction.
5. Resume correction against a locked worktree with no write, MCP, provider, publication, or unrelated command authority.
6. Remove mirror validators and receipt examples from sandbox code and task skills once generated contracts cover them.

**Execution note:** Preserve the OPE-188 invalid receipt as a characterization fixture, then change its expected outcome to normalized completion. This unit proves the sandbox protocol and fixtures; U7 activates its production supervisor settlement path after the new persistence epoch exists.

**Patterns to follow:** execute-stage.mjs admission structured-output flow; ot-stage-result atomic proposal validation; execute-loop.mjs private recovery and same-session fences.

**Test scenarios:**

- Covers AE1. One array-valued summary normalizes and records without a new work attempt or changed output subject.
- Covers AE2. An unknown outcome returns exact diagnostics, enters result_pending, and succeeds after one same-session semantic correction.
- Covers AE3. Correction exhaustion or missing native session yields needs_human with the checkpoint and invalid candidate preserved.
- A tool candidate and native final candidate that are byte-equivalent settle once; conflicting valid candidates fail closed.
- A forged identity, subject, assurance, timestamp, or provenance field is rejected as an unknown semantic field.
- A crash after staged submission but before record creation recovers the same staged candidate.
- A genuine timeout or non-clean process exit does not claim work_complete merely because a partial candidate exists.

**Verification:** Sandbox protocols expose no agent-authored receipt path, and every action type reaches the same semantic submission boundary.

### U5. Build the shared deterministic execution kernel

**Goal:** Express ordinary and structured scheduling through one reducer and store contract before replacing persistence.

**Requirements:** R13–R17, R22; KTD5, KTD9.

**Dependencies:** U2, U4.

**Files:**

- supervisor/src/pipeline/kernel/types.ts
- supervisor/src/pipeline/kernel/reducer.ts
- supervisor/src/pipeline/kernel/store.ts
- supervisor/src/pipeline/kernel/ports.ts
- supervisor/src/pipeline/kernel/effect-intent.ts
- supervisor/src/pipeline/kernel/reducer.test.ts
- supervisor/src/pipeline/control.ts
- supervisor/src/pipeline/coordinator.ts
- supervisor/src/pipeline/unit-coordinator.ts
- supervisor/src/pipeline/store.ts
- supervisor/src/persistence/pipeline/transition-store.ts
- supervisor/src/persistence/pipeline/unit-store-phase-reducer.ts

**Approach:**

1. Model a structured unit, review persona, command, publication wait, and ordinary stage as Attempt scope metadata under one compiled pipeline cursor.
2. Make the pure reducer consume the run, current attempt, immutable record IDs, and checkpoint facts, then propose one atomic transition bundle.
3. Define explicit commands for lease, start, work_complete, result_pending, record, settle, retry, needs_human, stop, and supersede.
4. Keep semantic judgment in ResultRecords from agent attempts; keep topology, budgets, gates, retries, and next-step selection deterministic.
5. Preserve transition-store.ts's all-or-nothing settlement guarantee as the shared store contract.
6. Expose separate capabilities for aggregate reduction, explicit downstream context, leased effect execution, status/log projection, and historical analysis; decision code cannot import the historical corpus port.
7. Define effect execution as immutable intent plus provider-specific reconciliation so an unknown acknowledgement cannot cause a blind replay.

**Patterns to follow:** transition-store.ts applyTransition transaction; unit-store-phase-reducer.ts deterministic phase advancement; existing fenced compare-and-set helpers.

**Test scenarios:**

- Equivalent ordinary and one-unit structured fixtures produce the same attempt and record lifecycle.
- Parallel units and review personas create sibling attempts with durable parent/scope metadata without a second kernel.
- Covers AE6. Reapplying an identical transition after a crash is idempotent; a stale cursor or conflicting record is rejected.
- result_pending holds the pipeline cursor and does not consume a work retry or repair round.
- Stop, supersede, retry exhaustion, and needs_human settle child attempts, effects, and checkpoints consistently in both pipeline shapes.
- A reducer cannot schedule delivery without an owning DecisionRecord and idempotency key.
- A reducer cannot enumerate unrelated records or historical analysis, and an effect worker cannot query unleased effects.
- Reconciliation of an already-observed external identity proposes one DeliveryRecord without issuing the mutation again.

**Verification:** Pure reducer fixtures cover every state edge in the lifecycle diagram and no branch tests for ordinary-versus-structured persistence.

### U6. Replace persistence and add the content-addressed blob store

**Goal:** Implement the twelve-table epoch and keep large immutable data outside hot SQLite rows.

**Requirements:** R15–R19, R21–R22; KTD5–KTD6, KTD9–KTD10.

**Dependencies:** U5.

**Files:**

- docs/SPEC.md
- supervisor/src/persistence/schema.ts
- supervisor/src/persistence/database.ts
- supervisor/src/persistence/store.ts
- supervisor/src/persistence/migrations/definitions.ts
- supervisor/src/persistence/migrations/runner.ts
- supervisor/src/persistence/kernel-store.ts
- supervisor/src/persistence/blob-store.ts
- supervisor/src/persistence/kernel-store.test.ts
- supervisor/src/persistence/blob-store.test.ts
- supervisor/src/persistence/migrations/runner.test.ts
- supervisor/src/persistence/schema-ownership.test.ts
- supervisor/src/persistence/fresh-epoch.test.ts
- supervisor/src/persistence/pipeline/checkpoint-store.ts
- supervisor/src/persistence/pipeline/effect-store.ts

**Approach:**

1. Before DDL, add the SPEC lifecycle-to-schema matrix for every existing table and store operation, including runtime resources, steering, task-branch lineage, review dispatch, checkpoints, and provider deliveries. Map each to typed fields, cardinality, PK/FK/UNIQUE/CHECK/NOT NULL/delete rules, lease/CAS fences, indexes, payload schema, authorized port, and a characterization test. Stop for an explicit SPEC amendment if the twelve-table model cannot preserve an independent lifecycle cleanly.
2. Implement a fresh-epoch initializer: an empty distinct path creates the complete baseline transactionally; a recognized new epoch passes exact schema, migration checksum, foreign-key, trigger/index, integrity, release, and storage-root verification; old, unknown, partial, or drifted schemas fail before any write.
3. Implement the five execution tables behind U5's segregated ports and consolidate intake, inbox, definition, registration, settings, and global lease ownership into the seven support tables. Use schema-versioned record payload unions and kind-specific owner constraints rather than nullable polymorphism or JSON scans for operational queries.
4. Preserve definition provenance with the five application fields and a composite immutable key; prewrite canonical DefinitionBundle bytes to BlobStore and verify pipeline_runs.definition_bundle_hash without treating repeated definition content as a unique foreign-key target.
5. Add the same-volume SHA-256 BlobStore using digest-safe regular-file paths: write and fsync a temporary file, verify canonical UTF-8 bytes/digest/size, publish without clobber, verify any existing deduplicated object, fsync the parent directory, then return a typed prewrite token that a SQLite transaction may reference.
6. Store pointer algorithm, digest, byte size, encoding, media type, and payload schema. Convert definition bundles, checkpoints, recovery/native-session packages, and oversized evidence; retain bounded hot fields inline and defer deletion/garbage collection.
7. Treat active-object corruption as a blocked/operator-actionable lifecycle state; never rewrite a settled historical record, and instead raise a global integrity incident. Audit active pointers at startup and the full archive during offline replacement.
8. Add exact schema ownership tests that reject every undeclared table, column family, index, trigger, disabled foreign key, or unapproved query capability.

**Execution note:** Characterize atomic transition and checkpoint recovery before replacing DDL; do not preserve old table shapes for test convenience.

**Patterns to follow:** Existing migration checksum runner; pipeline effect leasing; checkpoint-object digest validation; SQLite transaction boundaries in transition-store.ts.

**Test scenarios:**

- The new database contains exactly the KTD5 table set, with typed constraints enforcing bundle, request, record-owner, checkpoint, lease, and idempotency invariants.
- The definitions table exposes only the five application fields from R18; identical content across different IDs and commits remains valid, and each bundle pointer verifies independently.
- Empty initialization is atomic; old, partial, drifted, wrong-release, wrong-storage-root, disabled-foreign-key, or undeclared-object databases fail before write, with the old database byte-identical after refusal.
- Covers AE7. Fault injection at every blob step proves no committed pointer precedes durable publication; a post-commit missing or corrupt active blob blocks settlement, while settled-history corruption emits an integrity incident without mutating its record.
- Two identical blob writes deduplicate to one immutable object; two different payloads cannot claim the same digest.
- A crash after blob publication but before SQLite commit leaves a harmless orphan; restart may reuse it.
- Concurrent effect leases, duplicate inbox events, stale attempt fences, and conflicting record inserts fail atomically.
- Small semantic records remain inline and large evidence crosses the 64 KiB boundary without changing record meaning.

**Verification:** The store passes restart and concurrency tests with foreign keys enabled, and database rows never contain checkpoint, recovery, session, or oversized evidence bytes.

### U7. Switch admission and ordinary execution to the shared kernel

**Goal:** Admit one bundle-pinned pipeline and run ordinary actions through the new persistence and semantic-result boundary.

**Requirements:** R1–R17, R19; KTD1–KTD6, KTD8–KTD10.

**Dependencies:** U3, U6.

**Files:**

- supervisor/src/app/admission.ts
- supervisor/src/app/admission-preflight.ts
- supervisor/src/pipeline/coordinator.ts
- supervisor/src/pipeline/execution-gates.ts
- supervisor/src/pipeline/gates.ts
- supervisor/src/pipeline/stage-request.ts
- supervisor/src/runtime/contracts.ts
- supervisor/src/persistence/kernel-store.ts
- supervisor/src/persistence/pipeline/transition-store.ts
- supervisor/src/persistence/run-store.ts

**Approach:**

1. Make admission read the exact Git subject, compile one selected pipeline, prewrite and verify its bundle, persist normalized definition provenance, and atomically create a pipeline_run pinned to the bundle hash without graph, alias, or catalog identity.
2. Fail preflight when the selected engine cannot support the compiled instruction/skill profile or generated result schema.
3. Build ordinary stage requests from the attempt ID, canonical request hash, input subject, bundle hash, agent/skill/eval references, and executor-owned policy.
4. Activate U4's semantic candidate protocol: translate verified sandbox work_complete/result_pending outcomes into the shared attempt lifecycle and construct ResultRecords only after subject/evidence verification.
5. Compile ordinary review as inspect authority and remove its small-fix behavior. A blocking review DecisionRecord schedules a separate edit-authority remediation attempt; the reviewed ResultRecord's subject never changes.
6. Run deterministic command/eval gates as DecisionRecords, advance the ordinary pipeline through the U5 reducer, and resolve only explicitly authorized record/blob context for each next action.
7. Keep the old runtime intact only as non-deployed characterization code until U8; production composition for the candidate epoch wires only the new ports.

**Patterns to follow:** Existing application ports, provider-neutral runtime contracts, effect drainer, reaper fencing, and bounded prior-evidence construction.

**Test scenarios:**

- One ordinary implement/review/simplify pipeline reaches its pre-publication terminal through only the new attempts, records, effects, and checkpoints.
- A live eval referenced by a pipeline consumes ResultRecord content and emits one DecisionRecord; an unreferenced eval is never loaded.
- Exact request replay recovers one attempt; a bundle, input-subject, or session mismatch fails closed.
- Admission persists and re-reads the exact source-pinned bundle before creating an attempt; a compiler, bundle, or runtime-artifact digest mismatch creates no run.
- OPE-188 normalization and a malformed-result correction complete without a second work attempt, while genuine work failure retains its retry meaning.
- Ordinary review cannot edit its exact-subject view; one blocking finding schedules one separately fenced remediation attempt whose accepted tree receives an executor checkpoint.
- Authorized downstream context resolves a blob and validates it; an unrelated record or blob remains inaccessible.

**Verification:** The ordinary candidate path uses the new schema and generated sandbox protocol end to end; no admission or request-construction code reads a graph/catalog alias or model-authored receipt.

### U9. Port structured execution, review fanout, and integration

**Goal:** Express structured units and their coordination as scopes and sibling attempts on the same reducer rather than a second execution subsystem.

**Requirements:** R3, R8–R17, R19; KTD1, KTD3–KTD5, KTD8–KTD10.

**Dependencies:** U7.

**Files:**

- supervisor/src/pipeline/unit-coordinator.ts
- supervisor/src/pipeline/structured-loop-envelope.ts
- supervisor/src/pipeline/review-fanout.ts
- supervisor/src/pipeline/review-journal.ts
- supervisor/src/operations/review-orchestration.ts
- supervisor/src/operations/structured-child-primitives.ts
- supervisor/src/operations/structured-child-runtime.ts
- supervisor/src/operations/prior-evidence.ts
- sandbox/runner/execute-loop.mjs
- sandbox/runner/execute-child-action.mjs
- sandbox/runner/integrate-unit.mjs
- sandbox/tests/structured-walking-skeleton.mjs

**Approach:**

1. Compile inline and pipeline-local loops to private scope metadata and schedule each unit, review persona, integration action, and correction as a normal Attempt with parent/sibling relationships.
2. Replace unit-specific phase state with ResultRecords plus deterministic DecisionRecords for dependency readiness, review disposition, integration readiness, and downstream scheduling.
3. Preserve isolated worktree and exact-subject behavior while moving unit integration outcomes through the shared semantic submission boundary.
4. Compile leads and review personas as inspect authority and implementation, simplification, unit repair, and final repair as edit authority. All accepted edits are checkpointed and integrated by the executor; review never owns a commit.
5. Resolve prior evidence through the explicit context port using pipeline-declared record IDs/kinds and verified blob materialization; do not expose corpus-wide queries to agents or reducers.
6. Characterize fanout limits, repair budgets, dependency cancellation, and integration conflicts before removing unit-store behavior.

**Patterns to follow:** Current unit coordinator dependency checks, review fanout bounds, structured child isolation, integrate-unit subject verification, and bounded prior-evidence assembly.

**Test scenarios:**

- A two-unit dependency graph, parallel independent units, and review fanout all use the same Attempt lifecycle and records as U7's ordinary stage.
- Unit success cannot advance a dependent unit until integration emits the expected verified output subject and DecisionRecord.
- Conflicting integration, review-request correction, review exhaustion, stop, and supersede preserve every completed checkpoint and settle siblings deterministically.
- A downstream action receives only pipeline-authorized result/decision fields and verified blob materializations; unrelated historical evidence is inaccessible.
- Restart at every unit, review, and integration boundary schedules no duplicate child attempt and consumes no extra retry.

**Verification:** The structured Docker proof reaches the same outcome without querying unit-runtime tables or constructing unit-specific receipt types.

### U10. Port external effects and runtime resources

**Goal:** Make every provider mutation and sandbox-resource action a leased, idempotent effect with explicit unknown-outcome reconciliation.

**Requirements:** R13–R17, R22; KTD5, KTD9.

**Dependencies:** U9.

**Files:**

- supervisor/src/operations/pipeline-effects.ts
- supervisor/src/operations/unit-effects.ts
- supervisor/src/operations/actor-settlement.ts
- supervisor/src/operations/runtime-resource-reclaim.ts
- supervisor/src/operations/reaper.ts
- supervisor/src/operations/github-webhook-reconciliation.ts
- supervisor/src/providers/github/checkpoint-push.ts
- supervisor/src/providers/github/pipeline-publication.ts
- supervisor/src/providers/linear/outbox.ts
- supervisor/src/providers/daytona/adapter.ts
- supervisor/src/persistence/pipeline/effect-store.ts

**Approach:**

1. Convert Git branch/checkpoint publication, PR creation/update, comments, checks, Linear activity/state, Daytona create/stop/cleanup, and provider waits into immutable effect intents owned by DecisionRecords.
2. Use provider-native idempotency where available; otherwise derive a deterministic external identity and implement read-before-write plus read-after-unknown reconciliation.
3. Reject reuse of one idempotency key with a different effect kind, exact subject, payload, provider target, or intent hash as corruption.
4. Persist runtime-resource identity and cleanup state through typed effect/record/checkpoint fields so the reaper can reconcile leases and resources without a parallel actor table.
5. Append one DeliveryRecord for a confirmed outcome and atomically settle the effect; never infer success solely from an expired lease or replay an indeterminate mutation.

**Patterns to follow:** Existing pipeline effect leases, provider-neutral ports, actor settlement, runtime-resource reclaimer, reaper fencing, and Git checkpoint provenance checks.

**Test scenarios:**

- For Git branch/push/PR/comment/check, Linear activity/state, and Daytona create/stop/cleanup, a crash after provider acceptance but before local acknowledgement reconciles one external result and emits no duplicate mutation.
- Provider-native idempotency and deterministic identity adapters return the same DeliveryRecord semantics.
- Same idempotency key plus different intent fails closed and raises an operator-visible integrity error.
- Unknown provider outcome remains reconciliation-pending; retry backoff never sends blindly.
- Expired attempts, orphaned sandboxes, stopped runs, and superseded children converge to one cleanup effect and one terminal resource outcome.

**Verification:** Kill-point tests cover before send, after send/before acknowledgement, after acknowledgement/before the atomic DeliveryRecord-and-settlement commit, and after that commit/before worker completion or its next claim for every effect family.

### U11. Port ingress, steering, feedback, and read projections

**Goal:** Close the remaining live consumers over the new inbox and capability-separated record views before deleting the old schema.

**Requirements:** R13–R17, R20, R22, R24; KTD5, KTD7, KTD9.

**Dependencies:** U10.

**Files:**

- supervisor/src/http/server.ts
- supervisor/src/http/webhook-delivery.ts
- supervisor/src/app/commands.ts
- supervisor/src/app/thread-control.ts
- supervisor/src/app/provider-feedback.ts
- supervisor/src/runtime/steering.ts
- supervisor/src/persistence/admission-drain-store.ts
- supervisor/src/persistence/delivery-store.ts
- supervisor/src/persistence/feedback-store.ts
- supervisor/src/persistence/steering-store.ts
- supervisor/src/persistence/pipeline/status-store.ts
- supervisor/src/persistence/pipeline/analysis-store.ts
- cli/src/status.ts
- cli/src/logs.ts
- cli/src/analysis.ts

**Approach:**

1. Normalize webhooks, commands, feedback, steering, and runtime observations into deduplicated inbox_events before application handling; bind each mutation to the exact work/run/attempt when applicable.
2. Add one maintenance fence used by the offline replacement command: while closed, mutating routes return retryable maintenance responses and do not acknowledge or persist an event.
3. Deliver steering only to the bound live attempt and preserve result-only correction's reduced tool policy.
4. Replace delivery, feedback, steering, status, logs, and analysis store reads with their authorized projections over inbox events and shared records. Historical analysis remains separately wired and cannot influence live decisions.
5. Expose a bounded active-work report listing nonterminal attempts, corrections, effects, leases, and runtime resources so the operator can settle or explicitly abandon each dogfood item before shutdown. Do not turn this report into an online drain protocol.

**Patterns to follow:** Existing durable webhook leasing, steering session binding, admission drain reporting, bounded status projection, and analysis-store authority separation.

**Test scenarios:**

- Duplicate or reordered provider events settle once; an event arriving during maintenance receives a retryable non-acknowledgement and is processed normally only if the provider retries after reopening.
- Status and logs distinguish pending, running, work_complete, result_pending, recorded, needs_human, failed, and settled without mode-specific tables.
- Steering reaches only the current bound attempt; stale generation/session/fence messages are rejected and result-only correction cannot gain write authority.
- Analysis can query settled history but its port is not importable by reducers, gates, admission, or effect workers.
- Active-work reports name every live lifecycle and require an explicit settle-or-abandon disposition before offline replacement.

**Verification:** Architecture tests enforce port capabilities, and every HTTP/CLI/runtime consumer operates without old graph, receipt, unit, delivery, steering, feedback, or analysis store shapes.

### U8. Remove obsolete layers and replace the dogfood epoch offline

**Goal:** Delete the replaced architecture, prove the clean release, and replace the dogfood installation through a small verified maintenance workflow.

**Requirements:** R1–R25; KTD1–KTD10.

**Dependencies:** U11.

**Files:**

- contracts/src/graph.ts
- contracts/src/receipts.ts
- supervisor/src/pipeline/execution-graph.ts
- supervisor/src/persistence/pipeline/catalog-store.ts
- supervisor/src/persistence/pipeline/transition-store.ts
- supervisor/src/persistence/pipeline/unit-store.ts
- supervisor/src/persistence/pipeline/unit-store-phase-reducer.ts
- supervisor/src/persistence/admission-drain-store.ts
- supervisor/src/persistence/deployment-cutover-store.ts
- supervisor/pipelines/
- skills/tasks/
- sandbox/bin/ot-stage-result.mjs
- supervisor/scripts/cutover-control.mjs
- supervisor/scripts/deploy-cutover-workflow.test.mjs
- .github/workflows/deploy.yml
- sandbox/tests/smoke.sh
- sandbox/tests/structured-walking-skeleton.mjs
- docs/SPEC.md
- docs/PLAN.md
- docs/pipelines/
- docs/runbooks/pipeline-coordinator-rollout.md
- docs/runbooks/automatic-admission.md
- skills/README.md

**Approach:**

1. Create a deletion ledger mapping every retired table, module, API, job, CLI projection, and term to its new owner, preserved invariant, characterization test, and deletion proof. Delete graph/config parsers, receipt taxonomy and prompt sections, catalog/config snapshots, mode-specific stores, obsolete migrations, mirrors, and architectural exports only after their ledger rows are proven.
2. Add static dependency and vocabulary tests that allow old terms only in historical fixtures, archive documentation, deletion-ledger references, and explicit rejection tests.
3. Rewrite cutover-control.mjs as a one-shot maintenance command and runbook, not a product state machine. Its preflight closes ingress, prints every active dogfood lifecycle, requires each to be terminal or explicitly abandoned, verifies resource cleanup, stops every supervisor/worker, and refuses to proceed while any old writer or storage lock is live.
4. Take a WAL-consistent snapshot of the old database and blob root with the exact old supervisor/sandbox release. Run SQLite integrity_check and foreign_key_check, record schema/migration/row counts, hash the archive, and prove a disposable restore. This archive is retained only for diagnosis and rollback.
5. Create distinct empty database/blob paths and initialize the new epoch from a bounded checksummed bootstrap file containing only settings and repository registrations. Verify the exact new supervisor release, sandbox image, generated validator digest, schema, volume, and BlobStore identity; reject a nonempty, partial, old-schema, or wrong-root target.
6. Run the full local gate, then start the new release with public admission still closed and execute one named disposable ordinary smoke item and one structured smoke item. Together they exercise progressive skill loading, inspect/edit authority, semantic normalization, result_pending correction, Result/Decision/Delivery records, effect reconciliation, checkpoints/blobs, steering, and cleanup.
7. If either smoke fails, stop every new writer, archive the candidate storage for diagnosis, restore the matching old release/storage tuple, and manually close or delete disposable smoke branches/tickets. Never import new-epoch rows into the old database and do not build a general delta-compensation subsystem.
8. On success, emit one checksum-bound replacement report with old/new release and storage identities, abandonment decisions, archive/bootstrap hashes, integrity results, and smoke IDs; then reopen admission immediately and use normal dogfood monitoring.
9. Rewrite normative, authoring, operational, and troubleshooting documentation around the new vocabulary and capture the shipped architecture as a durable solution learning.

**Execution note:** This is an offline replacement, not a reusable migration framework. Stop immediately on a live old writer, unresolved non-abandoned dogfood resource, integrity/schema drift, a corrupt blob, mixed release/storage identity, duplicate records or external effects, idempotency conflict, Git-subject violation, or leaked runtime resource.

**Patterns to follow:** Existing deployment cutover workflow, Docker smoke lifecycle, structured walking skeleton, and architecture import-map tests.

**Test scenarios:**

- Covers AE8. Every live lifecycle blocks replacement with a named reason until it is settled or explicitly abandoned and its resources are cleaned.
- A live old process or storage lock, integrity/foreign-key/schema/row-count drift, corrupt archive blob, failed disposable restore, nonempty fresh path, or mixed release/storage identity blocks candidate startup.
- Covers AE10. Maintenance ingress returns retryable non-acknowledgement; a later provider retry enters the new deduplicated inbox through the ordinary path, with no cross-epoch import.
- Covers AE9. Every smoke provider mutation survives acknowledgement loss without duplication through the normal effect reconciler.
- Rollback restores the old database/blob snapshot and matching supervisor/sandbox release without reading or importing new-schema rows; disposable smoke artifacts are explicitly listed for manual cleanup.
- Old .openthrottle.yml graph keys, graph contracts, and receipt submissions fail with direct clean-cut diagnostics.
- The deletion ledger and static checks prove no production owner/import/caller remains for removed graph, receipt, catalog, transition-store, unit-store, mirrored contract, or skills/tasks paths.
- Docker ordinary and structured proofs exercise progressive skill loading, OPE-188 normalization, result_pending correction, restart idempotency, and large-blob recovery.
- One ordinary and one structured live smoke settle cleanly before admission reopens.

**Verification:** CI, Docker proofs, deletion ledger, schema/archive audits, maintenance preflight, one rollback drill, and both live smoke modes pass; the emitted replacement report is checksum-bound and no cutover state exists in the live database.

---

## Verification Contract

### Focused verification

- contracts: typecheck, build, deterministic bundle fixtures, generated JavaScript/provider-schema parity, public-config rejection, candidate/record validation, normalization fixtures, and effect-intent conflicts.
- supervisor: pipeline compiler, pure reducer, authority-separated ports, lifecycle/schema ownership, fresh-epoch refusal, kernel store, blob fault injection, effect reconciliation, recovery, maintenance ingress fencing, status, architecture, and offline-replacement preflight tests.
- sandbox: action-profile composition, inspect/edit repository authority, provider skill disclosure, DefinitionBundle determinism, semantic submission, same-session result repair, subject fencing, and generated-contract parity.
- cli: init scaffold, pipeline validation, status/log rendering, and clean diagnostics for removed graph configuration.

### Full repository gate

~~~text
npm run typecheck --prefix contracts && npm run build --prefix contracts
npm run typecheck --prefix supervisor && npm run typecheck --prefix cli
npm run build --prefix supervisor && npm run build --prefix cli
npm test --prefix contracts
npm test --prefix supervisor
npm test --prefix cli
npm test --prefix sandbox
bats sandbox/tests/runtime.bats
docker build -f sandbox/Dockerfile -t openthrottle:test .
sandbox/tests/smoke.sh openthrottle:test
node sandbox/tests/structured-walking-skeleton.mjs openthrottle:test
~~~

### Behavioral release evidence

- Compile the same selected pipeline through contracts, CLI, and supervisor paths, then load it through the sandbox fixture and compare the canonical bundle bytes and hash across all four environments.
- Capture each engine's initial context and skill-disclosure trace without exposing secrets or skill bodies in logs.
- Exercise valid submission, OPE-188 normalization, result_pending correction, correction exhaustion, staged-candidate crash recovery, and conflicting replay.
- Exercise restart between ResultRecord, DecisionRecord, effect execution, and DeliveryRecord boundaries, including the provider-accepted/local-acknowledgement-lost boundary for each external effect family.
- Verify one inline evidence record, one large evidence blob, one checkpoint blob, one active corrupt-blob block, one settled-history integrity incident, and one harmless orphan prewrite.
- Prove the fresh initializer refuses old, partial, drifted, mixed-release, or wrong-root inputs without modifying them.
- Run the offline replacement preflight against disposable volumes: prove a live writer or undisposed dogfood item blocks, the old archive restores, only empty fresh paths initialize, and a failed smoke can restore the matching old release/storage tuple.
- Record one ordinary and one structured live smoke result before reopening admission; subsequent confidence comes from normal dogfood runs rather than a fixed observation protocol.

---

## Definition of Done

- Every R1–R25 requirement is implemented and covered by its owning unit's tests or release evidence.
- .openthrottle/ is the sole runtime-definition source, and config, documentation, CLI output, and APIs use engine, agent, and pipeline consistently.
- The DefinitionBundle is dependency-closed, byte-deterministic, source-pinned, and the only definition identity carried by attempts.
- Agents never author authority-bearing records; all actions use generated semantic schemas and the shared submission boundary.
- OPE-188 completes without work redispatch, and exhausted result repair retains an operator-recoverable checkpoint.
- Ordinary and structured work use the same reducer, store, table set, reaper, status projection, and effect drainer.
- The lifecycle-to-schema matrix and ownership tests prove the live database contains exactly the KTD5 baseline; large immutable payloads are durable, verified content-addressed blobs.
- Shared records remain authority-separated through aggregate, context, effect, projection, and historical-analysis ports.
- Every provider mutation has tested native idempotency or deterministic external identity plus unknown-outcome reconciliation.
- No production compatibility compiler, legacy schema read, bridge table, dual write, old graph contract, receipt parser, or unit-specific execution store remains.
- The deletion ledger accounts for every retired module, table, API, job, projection, and invariant before its removal.
- The old database/blob snapshot, exact old release, bootstrap manifest, offline replacement report, and rollback proof are checksummed and recoverable; the new live runtime never reads the archive and contains no cutover state machine.
- Full CI, Docker smoke, structured walking skeleton, deployment dry run, offline rollback drill, and ordinary/structured live smoke evidence pass.
- docs/SPEC.md, docs/PLAN.md, pipeline authoring docs, runbooks, CLI help, and skills/README.md describe the shipped architecture.
- Abandoned compatibility scaffolding, temporary adapters, dead tests, and experimental code are removed from the final diff.
