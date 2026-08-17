# Plan Format

Write a human-readable artifact that also contains enough explicit structure for
`prepare-execution-plan` to create self-contained runtime units without
inventing meaning.

## Required sections

```markdown
# <type>: <searchable change title>

## Summary
<What this plan will change and the intended outcome.>

## Problem
<Why the change is needed and what currently happens.>

## Scope
### In scope
### Out of scope

## Requirements
- R1. <Observable behavior or constraint.>

## Decisions
- D1. <Chosen technical direction and concise rationale.>

## Repository Grounding
- <Relevant path or contract and how it shapes the plan.>

## Implementation Units

### U1. <Unit title>
**Goal:** <One meaningful outcome.>

**Dependencies:** <None or stable U-IDs.>

**Requirements:**
- R1. <Repeat the complete applicable meaning.>

**Files:**
- `repo/relative/path`
- `repo/relative/test-path`

**Approach:**
1. <Key boundary, data flow, or integration decision.>

**Patterns to follow:**
- `<repo-relative path>`: <specific convention or example.>

**Test scenarios:**
- <Input/state, action, and expected result.>

**Acceptance:**
- <Observable completion condition.>

**Verification:**
- <Named check and expected outcome.>

## Verification Contract
- `<configured-command-name>`: <what success proves.>

## Definition of Done
- <Whole-change completion conditions.>
```

## Unit rules

- Give each unit one coherent behavior, component boundary, or integration
  seam that could be implemented and reviewed independently.
- Order units by dependency. Preserve stable U-IDs across revisions; gaps are
  valid.
- Include full requirement meaning inside every applicable unit. A runtime unit
  cannot depend on “see R3 above” or other surrounding prose.
- Name every file that is reasonably knowable, including the explicit test file
  for behavior-bearing units.
- Enumerate test scenarios with starting state, action, and expected outcome.
  Cover success, relevant boundaries, failure paths, and cross-layer handoffs.
- For a non-behavioral unit, state why no automated test is appropriate and
  provide another observable verification method.
- Express verification as observable proof. Use command names declared by
  `.openthrottle.yml`; do not invent unavailable commands.
- Keep dependencies acyclic and explicit.
- Keep a structured plan within 1–64 units. Each unit may carry 1–32 entries in
  requirements, approach, tests, acceptance, and verification, and 1–64 file
  paths. Split only on meaningful boundaries; never create filler units to fit
  a field limit.
- Keep repeated unit text concise. The generated execution JSON has a 256 KiB
  ceiling, and the dispatched request adds its own envelope inside the same
  262,144-byte admission bound. A contract-valid block near the ceiling may
  still be too large to dispatch.

## Optional sections

Include only when they carry decisions or execution value:

- Assumptions.
- High-Level Design, with a diagram or state/sequence representation when prose
  hides important relationships.
- System-Wide Impact.
- Risks and Mitigations.
- Migration or Rollout.
- Alternatives Considered.
- Dependencies and Prerequisites.
- Documentation Changes.
- Deferred Work.

Include `## Source Trace` when the planning input contains stable IDs or
independently checkable requirements, decisions, constraints, or acceptance
conditions. Keep it compact:

```markdown
- <source ID or S1>: <short source meaning> -> R2, D1, U3, or <explicit disposition>
```

The trace records preservation; it does not replace full requirement meaning in
the plan or in self-contained execution units.

Use a file tree when a new package, service, plugin, or module introduces a
meaningful directory structure.

## Traceability checks

- Every requirement reaches at least one unit, acceptance condition, or explicit
  deferral.
- Every unit names the requirements it advances.
- Every product-visible failure behavior has a test or acceptance scenario.
- Every decision that affects unit shape is visible in that unit's approach.
- Every whole-change success condition is represented in the Verification
  Contract or Definition of Done.
- Every retained source-ledger item reaches a plan ID or an explicit approved
  disposition; no item disappears silently.

## Writing rules

- Use repo-relative paths and stable symbols instead of absolute paths or
  brittle line numbers.
- Record decisions and rationale, not implementation code.
- Keep one authoritative statement for each rule; cite its ID elsewhere.
- Replace superseded text instead of stacking corrections below it.
- Put known tangential work under Deferred Work, not active units.
- Put execution-time discoveries in a clearly labeled deferred note.
- Do not finalize with unresolved product blockers.
