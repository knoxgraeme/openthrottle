---
name: review-change
description: Use when reviewing a complete software change for ranked, stable, evidence-backed findings.
---

# Review a complete change

Review the complete sealed change and produce ranked, evidence-backed findings.

## Scope

The subject is the complete executor-materialized change between the sealed
base and input subjects named in the action context. Read the supplied diff or
checkpoint evidence and every affected file before judging any part of it.
Do not infer ambient branch refs or fetch additional history.

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

## Semantic output

Return `payload.findings` as an array of finding objects. Each object must have
exactly these fields:

- `severity`: `P0`, `P1`, `P2`, or `P3`;
- `path`: the repository-relative file path;
- `anchor`: the enclosing symbol or nearest stable anchor, never a line number;
- `title`: a concise normalized defect title;
- `evidence`: the concrete trigger, violated invariant, and observable impact.

Use an empty array when there are no findings. Do not add `blocking`, `status`,
fix instructions, or other fields; deterministic evaluation derives transition
authority from the closed finding shape and severity.

Never return `semantic_repair_required` yourself. Report `P0` and `P1` defects
through the finding objects; the deterministic review evaluator alone derives
the repair transition. `P2` and `P3` findings do not authorize remediation.
