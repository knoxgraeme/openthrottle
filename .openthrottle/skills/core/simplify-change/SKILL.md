---
name: simplify-change
description: Use when simplifying an existing software change for clarity, reuse, and efficiency without altering behaviour.
---

# Simplify a change

Improve the structure of the supplied change while preserving every observable
contract. Stay within files already touched by the change and avoid unrelated
repository cleanup.

## Review the change through three lenses

1. **Reuse:** find helpers, types, constants, and patterns the change duplicates.
   Reuse them only when they are an exact behavioural fit.
2. **Clarity:** align naming and abstraction level, remove dead paths and
   needless wrappers, derive rather than synchronize cheap state, and flatten
   nesting where order does not carry meaning.
3. **Efficiency:** remove obvious repeated work, redundant traversals, avoidable
   round trips, and newly unbounded accumulation. Do not optimize speculatively.

Read `references/simplification-heuristics.md` for expanded examples and
failure modes when the change is structurally complex.

## Behaviour-preservation check

Before keeping an edit, establish that it preserves:

- results for every reachable input;
- error types and conditions;
- side effects and their order;
- public signatures, exported names, serialized forms, configuration, and
  caller-visible messages; and
- validation, authorization, escaping, accessibility, and recovery properties.

Skip any edit whose equivalence is uncertain. Do not use a simplification pass
to fix a defect or redesign a contract.

## Verify and explain

Re-read the final diff and run focused existing tests for the code changed by
the pass. Report the concrete improvements by reuse, clarity, and efficiency,
including significant candidates skipped because safety or equivalence was not
clear. Do not use line count as the success measure.
