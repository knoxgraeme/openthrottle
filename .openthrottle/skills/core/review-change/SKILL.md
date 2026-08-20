---
name: review-change
description: Reviews the whole branch change for one fenced OpenThrottle semantic review stage and returns ranked, stable findings.
---

# Semantic review stage

Review the complete sealed change and produce ranked, evidence-backed findings.

## Scope

The subject is the full diff of the working tree against `origin/$BASE_BRANCH`.
Read the whole diff before judging any part of it.

- **`semantic_review`** — review the whole change against the approved plan.
- **`repair_semantic_review`** — the transition context names the repair. Judge
  whether the repair resolved what triggered it and whether it introduced
  anything new. Do not re-litigate content that a previous round already
  accepted.
- **`post_simplify_review`** — the transition context names the simplification
  delta. Your first question is whether behaviour was preserved.

## Lenses (run all of them, every time)

A fixed roster is the point: the same change must produce the same findings on
every round, or the repair loop never converges.
For the full lens checklists, read `references/branch-review-passes.md`.

1. **Correctness** — does the code do what the plan says, on the success path
   and on the failure and boundary paths?
2. **Tests** — does the added coverage fail without the change? Is a behaviour
   the plan promised untested, or asserted through a mock that would pass
   anyway?
3. **Contracts** — public signatures, schemas, serialized shapes, persisted
   data, and configuration: anything a caller or a stored record depends on.
4. **Untrusted input and secrets** — validation, escaping, injection surfaces,
   authorization checks, and anything that could log or expose a credential.
5. **Failure handling** — swallowed errors, silent fallbacks that hide a
   failure, unbounded retries or waits, and partial-failure states.
6. **Repository standards** — the conventions already visible in this codebase
   and its committed agent instructions.

## Evidence and finding identity

- Every finding cites a concrete anchor: a path, and the symbol or the quoted
  line it concerns. A finding you cannot anchor is not a finding.
- Identify a finding by `(path, enclosing symbol or nearest stable anchor,
  normalized title)`. **Never** identify it by line number: a repair that
  shifts lines would re-issue the same defect as a new one and the round budget
  would drain without progress.
- Carry every finding from a prior round in the transition context forward with
  its status: resolved, still open, or superseded. Do not silently drop one.
- On a repair review, raise no new advisory finding. Only a defect that blocks
  acceptance of *this* subject may be raised late.
- Severity: `P0` breaks the ticket's intent, loses data, or opens a security
  hole; `P1` must be fixed before merge; `P2` should be fixed; `P3` is
  advisory. Rank blocking findings first.
