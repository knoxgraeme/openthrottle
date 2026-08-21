---
title: Separate agent semantics from executor-owned state
date: 2026-08-20
category: architecture-patterns
module: execution-kernel
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "An agent pipeline must preserve completed work when model output is malformed"
  - "Multiple model providers need one portable authority boundary"
  - "Repository-authored agents and procedures must remain independently reusable"
  - "A read-only reviewer needs the exact accepted change without mutation authority"
root_cause: wrong_api
resolution_type: workflow_improvement
related_components:
  - "definition-compiler"
  - "sandbox-runtime"
  - "persistence"
tags:
  - "agent-runtime"
  - "execution-kernel"
  - "filesystem-definitions"
  - "progressive-disclosure"
  - "result-normalization"
  - "read-only-review"
---

# Separate agent semantics from executor-owned state

## Context

An agent factory becomes fragile when one prompt must define a role, teach every
procedure, perform repository work, and reproduce an authority-heavy receipt.
Those concerns change at different rates and live at different trust levels:
role posture is stable, procedures should be reusable and progressively
disclosed, task context changes for every Attempt, and identity and provenance
must be deterministic.

OPE-188 exposed the cost of collapsing those boundaries. A unit completed its
code and tests, but returned `payload.summary` as an array where the receipt
expected a string. A representation error at the end of the action threatened
to discard successful work. The durable response was not a larger prompt. It
was a smaller semantic result, declared normalization, a preserved checkpoint,
and bounded result-only correction.

Earlier implementations moved receipt instructions between prompt layers while
leaving the model responsible for the same large authoritative envelope. That
did not remove the failure surface. They also treated the inability to commit or
push as sufficient review isolation, even though a writable reviewer could
still change uncommitted files, generated artifacts, or caches and thereby
alter the evidence it was judging. Provider-native read-only modes also varied
too much to serve as the cross-engine boundary. These dead ends recurred across
the implementation sessions that produced this refactor (session history).

## Guidance

### Keep the three agent-semantic inputs separate

Keep the three inputs that define the agent's reasoning surface distinct. Store
stable role behavior in
`.openthrottle/agents/<id>/instructions.md`. Keep reusable procedures in
`.openthrottle/skills/<id>/SKILL.md`, including lazily loaded references and
support files. Keep the sealed task prompt specific to one Attempt.

The pipeline selects those parts independently: agent, repository authority,
skill allowlist, entry skill, eval, and transitions. The compiler closes over
only the selected definitions and every bounded file in each selected skill
package. The resulting DefinitionBundle is immutable input to execution rather
than a prompt assembled from whatever happens to be installed later.

This separation makes progressive disclosure real. An agent starts with clear
standing instructions and the task prompt, sees the selected skill catalog, and
loads procedural detail only when required. Adding a skill or changing a
pipeline does not require copying a role prompt for every engine.

Defining contracts:

- [`contracts/src/definition-bundle.ts`](../../../contracts/src/definition-bundle.ts)
  constrains agent definitions to `instructions.md` and records each selected
  definition's normalized payload and content hash.
- [`contracts/src/pipeline.ts`](../../../contracts/src/pipeline.ts) keeps the
  agent, authority, skills, entry skill, eval, and transitions as distinct stage
  fields.
- [`sandbox/runner/action-profile.mjs`](../../../sandbox/runner/action-profile.mjs)
  materializes selected skills separately and composes them with the role and
  task prompt at execution time.

### Let the model return semantics, not authority

The model returns a ResultCandidate containing only `schema`, `outcome`, and
semantic `payload`. It does not invent or echo Attempt IDs, request hashes,
DefinitionBundle hashes, Git subjects, session IDs, timestamps, checkpoint IDs,
idempotency keys, or delivery claims. The candidate contract is deliberately
small in [`contracts/src/result-candidate.ts`](../../../contracts/src/result-candidate.ts).

The executor derives authoritative identity from persisted state:

- An Attempt binds the exact request, DefinitionBundle, input subject,
  repository authority, context, retry state, and native session.
- A ResultRecord binds the original and normalized candidate hashes back to
  that Attempt.
- A Checkpoint binds the same identity to the executor-verified input and
  output subjects.
- A DecisionRecord authorizes state transitions and any resulting Effect.
- A DeliveryRecord captures a confirmed or rejected external outcome.

The model can reason about whether work succeeded; it cannot grant itself
authority or certify its own provenance.

### Normalize only declared representation drift

Normalization belongs to an eval field, never to a permissive global parser.
For the OPE-188 shape, the unit-result eval declares `summary` as a string and
opts into `string-array-to-newlines/v1`. That transform accepts a bounded array,
joins it with newlines, and records the field path plus input and output hashes.
The staged result retains the original candidate, normalized candidate, both
hashes, and the transformation diagnostics.

If a candidate remains invalid, the Attempt enters `result_pending` instead of
reclassifying completed code work as failed. A correction request stays bound to
the existing checkpoint and native session, uses inspect authority, and exposes
only result submission. The implementation is split across
[`contracts/src/result-candidate.ts`](../../../contracts/src/result-candidate.ts),
[`sandbox/runner/result-submission.mjs`](../../../sandbox/runner/result-submission.mjs),
and [`supervisor/src/pipeline/kernel/action-request.ts`](../../../supervisor/src/pipeline/kernel/action-request.ts).

Normalization must never reinterpret meaning, invent missing evidence, broaden
an outcome, or supply an authority field. Unknown or undeclared shapes remain
validation failures.

### Keep inspect authority immutable

An inspect action receives the exact requested Git subject, a synthetic local
history sufficient for that action, a disabled remote, sealed Git state, and a
root-owned read-only source tree. Post-action verification rejects changed
content or Git administration state. Provider-native restrictions for Claude,
Codex, and OpenCode remain useful defense in depth, but filesystem immutability
is the portable boundary.

Do not weaken this boundary because the agent cannot commit. Commit and push
authority are only part of the risk. A writable reviewer could still mutate the
very worktree used to produce its findings or poison later deterministic gates.

Instead, make review useful with an executor-generated change artifact tied to
the exact accepted edit checkpoint. The artifact contains the checkpoint ID,
base and input subjects and trees, sorted changed paths, textual diff, and
explicit omission diagnostics. Path count, diff size, and total artifact size
are bounded. Oversized evidence is omitted explicitly rather than silently
truncated. The executor seals the artifact read-only and verifies its descriptor
and SHA-256 before accepting the result. See
[`sandbox/runner/action-repository.mjs`](../../../sandbox/runner/action-repository.mjs)
and [`sandbox/runner/agent-runtime.mjs`](../../../sandbox/runner/agent-runtime.mjs).

The artifact is evidence, not a capability channel. It does not widen tool,
network, provider, or repository authority.

### Schedule mutation as another Attempt

A blocking review result transitions to a separate edit remediation stage. It
does not turn the current inspect action writable. Likewise, test, lint, and
build run as command Attempts in disposable writable trees because tools may
create caches or generated output. Command side effects do not advance the
accepted Git subject.

Edit agents may change source content, but Git administration remains sealed.
The executor verifies the resulting tree and creates the checkpoint, commit,
ref, integration, push, and publication state. The implementation pipeline
makes these boundaries explicit in
[`.openthrottle/pipelines/core/implement/pipeline.yml`](../../../.openthrottle/pipelines/core/implement/pipeline.yml).

## Why This Matters

This ownership split turns common model variance into data the system can
validate and repair. Small semantic candidates reduce schema burden. Declared
transforms absorb known harmless drift without hiding it. Result-only correction
can repair formatting while preserving completed code and its checkpoint.

It also gives every trust decision one owner:

- the model reasons about or edits content;
- the supervisor selects and seals the Attempt's definitions and inputs;
- the sandbox enforces repository authority, verifies the tree, and captures a
  checkpoint;
- the reducer authorizes transitions and external effects;
- provider adapters deliver already-authorized effects idempotently.

Hard inspect authority matters even when agents never commit. Without it, a
review could observe or create a workspace different from the accepted
checkpoint and still return plausible findings. The exact-boundary artifact
recovers the useful part of ordinary code review without surrendering the
immutable-subject proof.

Finally, the same primitives cover ordinary and structured execution. Recovery
replays deterministic Attempts, Records, Effects, and Checkpoints instead of
inferring progress from prompt prose or maintaining a second structured-only
lifecycle.

## When to Apply

- A role is reused across tasks while its procedures differ by pipeline stage.
- Successful work can be lost because the final model JSON is slightly wrong.
- Audit or recovery must prove which definitions, request, subject, and session
  produced an outcome.
- Review findings must be reproducible against one accepted edit boundary.
- Tests or builds need writable caches but must not alter accepted source state.
- Multiple agent engines need one shared authority contract.

## Examples

The filesystem authoring split stays deliberately small:

```text
.openthrottle/
  agents/core/reviewer/instructions.md
  skills/core/review-change/SKILL.md
  pipelines/core/implement/pipeline.yml
  evals/core/review-result/eval.yml
```

The pipeline composes the reviewer without turning its procedure into the role:

```yaml
- id: review
  kind: agent
  agent_id: core/reviewer
  repository_authority: inspect
  skills: [core/review-change]
  entry_skill: core/review-change
  eval: core/review-result
```

An OPE-188-style candidate remains semantic:

```json
{
  "schema": "openthrottle.result-candidate/v1",
  "outcome": "success",
  "payload": {
    "summary": ["Implemented the unit.", "Targeted tests pass."],
    "verification": ["targeted tests pass"]
  }
}
```

Because that one eval field declares the array-to-newlines transform, the
executor validates and stages this value while preserving the original hashes
and diagnostic:

```json
{
  "summary": "Implemented the unit.\nTargeted tests pass."
}
```

No Attempt ID, bundle hash, Git subject, timestamp, or assurance claim appears
in either candidate. Those belong to executor-authored records and checkpoints.

Authority changes are pipeline transitions, not prompt exceptions:

```text
edit implementation -> inspect review -> edit repair (only if blocked)
                    -> edit simplification -> inspect review
                    -> writable disposable test/lint/build command Attempts
```

## Related

- [Filesystem definitions and execution-kernel implementation plan](../../plans/2026-08-20-0116-refactor-filesystem-execution-kernel-plan.md)
- [Execution-kernel deletion ledger](../../architecture/execution-kernel-deletion-ledger.md)
- [Normative execution contracts](../../SPEC.md)
- [Delivery and acceptance plan](../../PLAN.md)
- [Skills and agent-instructions authoring guide](../../../skills/README.md)
