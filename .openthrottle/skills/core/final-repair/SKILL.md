---
name: final-repair
description: Use when applying focused repairs for validated whole-change findings and verifying each disposition.
---

# Repair validated review findings

Use the supplied finding set as the work list. Close demonstrated defects with
the smallest coherent changes and preserve all unrelated behaviour.

## Triage before editing

1. Enumerate every finding and identify its stable path and semantic anchor.
2. Reinspect the cited code and reproduce or otherwise demonstrate the claimed
   defect independently.
3. Rank findings by impact and dependency so foundational fixes happen before
   their dependents.
4. Mark claims that are stale, duplicated, or unsupported; never invent a code
   change merely to make a questionable claim disappear.

## Repair discipline

- Change only what a validated finding requires.
- Avoid unrelated refactors, formatting sweeps, dependency changes, new
  features, and opportunistic hardening.
- Fix causes rather than weakening tests, validation, types, or safety checks.
- Add or update a regression test for each testable behaviour defect. Observe
  the failure before the fix when a practical test seam exists.
- Preserve the finding's stable identity when explaining its disposition so a
  later review can correlate it across rounds.
- When one fix closes several findings, explain the shared cause and verify each
  observable consequence separately.

## Verify every disposition

For each finding, state one of:

- fixed — paths changed and the focused check that now demonstrates the
  expected behaviour;
- not reproduced — evidence showing why the claim does not hold in the current
  code; or
- blocked — the missing decision or broader change required.

Rerun the originally failing check first, then focused neighbouring tests for
the code touched. Do not describe a blocking finding as resolved without
observed evidence. If closing it would require widening scope or contradicting
an explicit contract, leave the code unchanged and state the precise decision
needed.
