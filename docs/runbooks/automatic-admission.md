# Automatic admission runbook

Automatic admission turns one signed Linear or GitHub control event into one
exact-subject PipelineRun. It is fail-closed: planning output is advice until
the supervisor validates it, compiles the selected filesystem definitions, and
commits admission atomically.

## Preconditions

- The route appears in `GET /repositories` and names the intended repository,
  base branch, and runtime snapshot.
- The selected exact repository subject contains a valid `.openthrottle/`
  definition tree, or valid repository config selecting sealed platform
  definitions.
- The configured engine credential is available.
- The candidate runtime advertises the compiler/runtime capability digest
  required by the selected definitions.
- Maintenance is open.

Check supervisor readiness:

```bash
curl -fsS "$OT_SUPERVISOR_URL/healthz"
curl -fsS \
  -H "Authorization: Bearer $OT_STATUS_TOKEN" \
  "$OT_SUPERVISOR_URL/capabilities" | jq .
curl -fsS \
  -H "Authorization: Bearer $OT_STATUS_TOKEN" \
  "$OT_SUPERVISOR_URL/repositories" | jq .
```

Never paste bearer tokens into ticket text or logs.

## Admission sequence

1. The HTTP boundary reads a bounded body and verifies the Linear or GitHub
   HMAC before parsing the control event.
2. The route resolves to exactly one repository registration. An unknown route
   is acknowledged and ignored.
3. The inbox deduplicates provider delivery ID and semantic event group. A
   reordered retry cannot replace newer accepted input.
4. The supervisor resolves the exact full Git subject for the registered base
   or operator-approved branch override.
5. Read-only planner and independent reviewer actions classify the request as:
   - `simple`, which selects `core/implement`, for bounded whole-change work;
   - `structured`, which selects `core/structured`, when the work needs
     explicit units/dependencies;
   - `needs_human` when scope, authority, or plan completeness is unresolved.
6. Structured admission accepts exactly one validated
   `openthrottle.execution-plan/v2` block bound to `core/structured`. The
   reviewer may reject it but cannot rewrite or silently extend it.
7. The exact-Git reader compiles the selected pipeline and its transitive agent,
   skill, eval, loop, command, and config dependencies.
8. The supervisor verifies runtime compatibility and prewrites/re-reads the
   immutable DefinitionBundle blob.
9. One transaction inserts the work item, definition snapshots, PipelineRun,
   bundle pointer, and first pending Attempt.

No planning candidate, ticket label, repository prose, or engine output can
skip steps 6–9.

## What planner actions can do

Admission planner and reviewer actions use `repository_authority: inspect`.
They receive an immutable checkout at the exact proposed subject, disabled Git
remotes, native read/search tools, the sealed action prompt, and only their
selected progressive skills.

They cannot edit files, run mutating commands, commit, push, publish, register a
repository, select credentials, or approve their own output. The reviewer runs
in a fresh native session and sees the exact candidate bytes; it does not inherit
the planner's hidden context.

If a planner returns a shape error, declared normalization runs first. For core
schemas, an array-valued `payload.summary` becomes a newline-delimited string
with transformation hashes. Any remaining schema error enters bounded
result-only correction in the same native session; it does not rerun planning
or lose a valid structured plan candidate.

## Observe admission

Use the provider reference or PipelineRun ID:

```bash
openthrottle status OPE-188
openthrottle logs OPE-188
openthrottle analysis --run OPE-188
```

The status projection should expose:

- selected pipeline and DefinitionBundle hash;
- exact current subject and cursor version;
- current Attempts with authority, state, retry/correction counts, and lease;
- Record, Checkpoint, and Effect summaries;
- terminal outcome or actionable block.

The output must not expose raw credentials, full private prompts, or unbounded
model/provider output.

## Common refusals

### Unregistered route

Symptom: webhook is acknowledged but no work is created.

Action: inspect `GET /repositories`; register the exact Linear team or GitHub
repository. Do not add a permissive fallback route.

### Maintenance closed

Symptom: provider receives `503`, `Retry-After`, and `acknowledge:false`.

Action: this is expected during offline maintenance. Do not manually replay into
storage. After maintenance opens, let the provider retry through normal inbox
deduplication.

### Definition compile failure

Symptom: no PipelineRun commits; diagnostics name a path, missing dependency,
unknown evaluator, unsafe file, duplicate identity, or widened closure.

Action: fix `.openthrottle/` at a new reviewed commit, then retry the control
event. Never patch compiled bundle bytes or insert definition rows manually.

### Runtime incompatibility

Symptom: selected engine, evaluator, authority profile, or progressive skill
delivery is absent from the runtime-capability release.

Action: deploy a matching sealed Daytona snapshot or narrow the pipeline. Do
not fall back to inlining all skills or a writable inspect checkout.

### Structured plan rejected

Symptom: `needs_human` before unit execution.

Action: inspect planner/reviewer Result and Decision records. Correct the ticket
or approved plan so units, dependencies, scope, acceptance criteria, and
verification are explicit. A human must approve meaningful scope changes.

### Result pending

Symptom: planning work completed but the Attempt is `result_pending`.

Action: wait for same-session result correction. If its budget/deadline is
exhausted, inspect diagnostics and resolve `needs_human`; do not restart the
whole action merely to change JSON formatting.

### Stale subject or session fence

Symptom: completion is rejected after the repository subject, cursor, lease, or
native session changed.

Action: treat the callback as stale evidence. Let the reducer schedule a fresh
Attempt against current state. Never copy output from one Attempt into another.

## Stop or supersede

```bash
openthrottle stop OPE-188
```

Stop/supersede is a durable deduplicated inbox command. It does not edit run rows
directly. Terminal reduction must stop and clean any confirmed runtime resource
before the run settles, unless exact evidence independently proves provisioning
never committed.

## Acceptance check

For one ordinary and one structured disposable item, record:

- provider reference, PipelineRun ID, DefinitionBundle hash, and final subject;
- planner/reviewer and implementation Attempt IDs;
- result normalization/correction evidence when intentionally exercised;
- Result, Decision, and Delivery record IDs;
- publication idempotency key and external identity;
- terminal cleanup DeliveryRecord;
- final status and provider evidence.

Both runs must settle without duplicate publication, stale-subject acceptance,
or a retained Daytona resource.
