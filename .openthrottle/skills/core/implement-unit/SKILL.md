---
name: implement-unit
description: Use when implementing one bounded execution-plan unit with tests and concrete local evidence.
---

# Implement one plan unit

Implement exactly the supplied unit. Its requirements and acceptance criteria
define the behaviour to deliver; its file list and approach guide the work but
do not replace those obligations.

## Scope the unit

- Resolve every requirement and acceptance statement before editing. If they
  conflict, call out the conflict rather than choosing silently.
- Work only on the named behaviour plus the smallest supporting changes needed
  to build, test, and satisfy acceptance.
- Do not begin a dependent unit, refactor unrelated neighbours, upgrade a
  dependency, or fix an incidental defect.
- Treat upstream notes as constraints and facts, not additional scope.
- If the unit is already complete, verify it and leave the implementation
  alone.

## Implementation discipline

1. Read the named files, the enclosing constructs, the nearest analogous code,
   and the existing tests before writing.
2. Change one coherent behaviour at a time and follow repository conventions.
3. Move tests with behaviour: add coverage for new behaviour, update coverage
   for changed behaviour, and remove coverage only when behaviour is removed.
4. Cover the normal path and every meaningful boundary, rejection, failure, or
   integration case implied by the unit.
5. Trace hooks, middleware, retries, persisted state, and alternate entry points
   far enough to detect collateral effects.
6. Run focused checks throughout the work and fix failures immediately.

Read `references/implementation-discipline.md` when the unit crosses layers,
changes durable state, lacks an obvious test seam, or arrives after a failed
attempt.

## Evidence

Leave a concise account of:

- each path changed and the behaviour it now provides;
- tests or other checks run, with their observed outcomes;
- assumptions and implementation choices not settled by the unit;
- issues deliberately left outside scope; and
- facts a declared dependent unit will need.

Never describe unfinished or unverified work as complete. If a requirement
cannot be satisfied without missing authority, information, or a broader design
decision, identify the exact blocker and the smallest question that resolves it.
