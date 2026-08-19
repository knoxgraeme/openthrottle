# Structured admission review checklist

Review the exact candidate plan. Do not improve, rewrite, or reserialize it.

## Scope coverage

- Map every bounded ticket requirement and acceptance condition to a unit.
- Reject omissions and requirements represented only by vague prose.
- Reject extra product behavior, architecture, dependencies, migrations,
  cleanup, or rollout work without ticket authority.

## Explicit source IDs

- Inventory every explicit stable requirement or acceptance ID in the bounded
  ticket before reviewing units.
- Require each ID to appear verbatim beside its complete meaning in at least
  one owning unit's `requirements` or `acceptance` text.
- Reject an omitted ID, weakened obligation, conflicting reuse of one ID, or an
  ID-only pointer. Consistent repetition across owning units or proof fields is
  allowed and is not duplication.
- Do not require generated IDs when the source ticket is free-form.

## Unit completeness

Every unit contains objective, requirements, files, approach, tests,
acceptance, and verification in full. Reject pointers to the ticket, another
document, a parent issue, or prose unavailable to the eventual worker.

## Dependency coherence

- Unit ids are unique and every dependency names an existing unit.
- The dependency graph is acyclic.
- Contract producers precede consumers, and integration responsibility is
  explicit when work crosses components.

## Plausibility and proof

- File paths are repository-relative and plausible in the pinned view.
- Tests cover the promised success behavior plus applicable boundaries and
  failures.
- Verification names executable repository commands or focused checks. Reject
  invented commands, subjective “inspect manually” gates, and claims that a
  check already passed.

## Verdict boundary

Use `rejected` for correctable plan defects. Use `needs_human` only when the
ticket itself lacks necessary product or acceptance authority. A structured
lock permits only an approved structured candidate or a needs-human stop; it
never permits a simple route or fabricated scope.
