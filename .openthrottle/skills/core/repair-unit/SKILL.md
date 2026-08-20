---
name: repair-unit
description: Use when diagnosing and repairing a failed plan unit without widening its original scope.
---

# Repair one plan unit

Repair the supplied unit from concrete failure evidence. The original unit
requirements remain the scope; failures and revision requests identify what is
wrong, not permission to redesign the unit.

## Establish the failure

1. Enumerate every supplied failure, unmet criterion, or revision request.
2. Reproduce the strongest available failure with the narrowest relevant
   command, or trace the captured output to the first causal error.
3. Compare the failing path with the unit's requirements and the current code.
4. State a causal hypothesis and the observation that would falsify it.

If the evidence does not identify a concrete failure, stop and identify the
missing information instead of rewriting the unit speculatively.

## Repair

- Fix the cause, not the assertion, type rule, validation, or error that exposes
  it.
- Make one coherent change per hypothesis.
- Preserve correct work from earlier attempts and leave unrelated defects
  untouched.
- Update or add a regression test when behaviour was wrong.
- If a test is itself incorrect, explain the contract mismatch before changing
  its expectation.
- Keep the repair smaller than the work it repairs. Broad file growth is a sign
  to reassess the diagnosis.

Read `references/implementation-discipline.md` when failure evidence is
ambiguous, the repair crosses layers, or the existing tests do not expose the
cause.

## Verify and hand off

Rerun the exact failing check first, then the focused neighbouring checks for
the code touched. Account for every supplied failure as resolved, disproved, or
still blocked, with paths and observed verification. Record assumptions and any
out-of-scope issue without fixing it.

When the requested repair conflicts with an explicit requirement or requires a
new product, architecture, data, or security decision, preserve the conflict
and state the precise decision needed.
