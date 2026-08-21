# Concepts

Shared domain vocabulary for this project — entities, named processes, and
status concepts with project-specific meaning. Seeded with core domain
vocabulary, then accretes as ce-compound and ce-compound-refresh process
learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Execution definitions

### Pipeline

A repository-authored orchestration definition that selects stages, transitions,
agent roles, procedures, evaluation contracts, and repository authority without
exposing the compiled runtime protocol as a second public concept.

### DefinitionBundle

An immutable, content-addressed closure of the selected exact filesystem
definitions, bound to a release-sealed runtime capability digest.

## Execution kernel

### Attempt

One fenced execution of a pipeline action, bound to an exact request,
DefinitionBundle, input subject, repository authority, and recovery context.

### ResultCandidate

The bounded semantic outcome proposed by an agent before the executor adds
identity, provenance, checkpoint, or delivery authority.

### Execution Record

Executor-authored durable evidence expressed as one of three kinds: a Result
records an Attempt outcome, a Decision records a reducer judgment, and a
Delivery records the confirmed or rejected outcome of an external Effect.

### Checkpoint

An executor-authored recovery artifact that binds an Attempt's exact identity
and input subject to its verified output subject and evidence.

### Effect

A durable, idempotent intent for an externally visible mutation that is anchored
to the Decision that authorized it and remains distinct from its Delivery.

### Result Pending

The recoverable state in which work and its Checkpoint are preserved while an
invalid ResultCandidate awaits bounded, result-only correction.

## Repository authority

### Inspect Authority

Permission for an agent Attempt to reason over an exact immutable repository
subject and bounded executor evidence without permission to change source
content or Git state.

### Edit Authority

Permission for an agent Attempt to change source content in isolation without
permission to administer Git identity, refs, pushes, integration, or
publication.

## Relationships

A Pipeline is compiled into a DefinitionBundle before it creates Attempts. An
Attempt may yield a ResultCandidate; the executor validates it and writes an
Execution Record and Checkpoint. A Decision can authorize an Effect, whose
external outcome becomes a Delivery record. Inspect and Edit Authority determine
what an agent Attempt may do to repository content, while Git authority remains
with the executor. Command Attempts may write disposable build trees, but those
side effects never advance the accepted repository subject.
