---
name: simplify-unit
description: Use when simplifying one implemented plan unit while preserving its observable behaviour and contracts.
---

# Simplify one plan unit

Improve the shape of the supplied unit without changing what it does. Restrict
the pass to code already changed for the unit and prefer clear, local
improvements over broad refactoring.

## Lenses

1. **Reuse:** replace a local reimplementation with an established helper or
   pattern only when its edge behaviour is equivalent.
2. **Clarity:** remove accidental indirection, derived state, dead branches,
   redundant narration, and nesting that can be flattened safely.
3. **Efficiency:** remove obvious repeated work, excess passes, or needless
   round trips without changing ordering or failure granularity.

Read `references/simplification-heuristics.md` when evaluating a non-trivial
candidate or when equivalence is not obvious.

## Preserve

Every edit must keep the same outputs, error conditions, side effects and
ordering, public interfaces, serialized forms, configuration keys, and tested
messages. Do not weaken validation, authorization, escaping, accessibility,
error handling, or extension seams whose purpose is still live.

If equivalence cannot be established by reading the code and focused tests,
skip the edit. A defect discovered during simplification is separate repair
work, not a reason to change behaviour here.

## Verify

Review each edit against the unit diff and run the narrowest existing tests
that cover it. Summarize improvements by reuse, clarity, and efficiency; name
important candidates deliberately skipped and why. Line-count reduction is not
evidence of simplification.
