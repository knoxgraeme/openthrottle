---
name: implement-plan
description: Use when implementing an approved software plan with repository-aligned changes and focused verification.
---

# Implement an approved plan

Turn the supplied plan into the smallest complete change that satisfies its
requirements and acceptance criteria. Treat the plan as the scope boundary:
adjacent improvements are observations, not extra implementation work.

## Prepare

1. Map each requirement to the files, symbols, and tests likely to carry it.
2. Read those files and their nearest neighbours before editing. Follow local
   naming, layering, error handling, and test conventions.
3. Find the tests that already own the affected behaviour. Prefer extending or
   strengthening them to adding a parallel test surface.
4. Identify dependencies between changes so shared contracts move before their
   consumers.

If the work is already present, verify it against the acceptance criteria and
avoid reimplementing it.

## Implement

- Work in small coherent behaviour slices.
- Keep public interfaces, persisted shapes, and error semantics aligned with
  the plan and existing callers.
- Add or update tests with each behaviour change. Cover the normal path and the
  meaningful boundary, rejection, and failure cases.
- When a change crosses layers, trace callbacks, retries, middleware, alternate
  entry points, and partial-state failure paths at least two levels out.
- Avoid new dependencies or abstractions unless the plan requires them and the
  repository has no simpler established pattern.

For a repair pass, enumerate the supplied failures first, establish each one in
the current code, and make only the changes needed to close them. Do not use a
repair as an opportunity to widen the original plan.

## Verify

Run the narrowest real checks that exercise the changed behaviour while you
work. Re-run any previously failing check after the fix, then run the focused
neighbouring tests needed to catch collateral damage. Record commands and
observed outcomes exactly; do not claim checks that were not run.

Before finishing, re-read the plan and compare every requirement and acceptance
criterion with the final tree. Summarize changed paths, verification performed,
assumptions made, and unresolved issues.

## Decision boundary

Do not quietly choose between materially different requirements when the plan
leaves a foundational decision open—for example a public contract, data
migration, security behaviour, architecture boundary, destructive operation,
or new dependency. State the decision needed, the viable options and
trade-offs, and a recommendation so the caller can resolve it.
