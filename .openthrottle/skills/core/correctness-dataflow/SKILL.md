---
name: correctness-dataflow
description: Use when reviewing changed control flow, data flow, state transitions, ordering, or failure behaviour for correctness defects.
---

# Correctness and data-flow review

Trace concrete values through the changed code and report defects where the
implementation can produce the wrong observable result or state.

## Review method

1. Identify each changed entry point and its promised output, state transition,
   or side effect.
2. Follow representative values through direct callers and callees until they
   reach a stable observable boundary.
3. Exercise meaningful empty, missing, first, last, and maximum cases.
4. Trace errors as data: where they originate, how they are transformed, which
   context is preserved, and whether any path turns failure into success.
5. Inspect ordering and partial-state behaviour around writes, queues, caches,
   and retries.
6. Compare both sides of every changed boundary for agreement on types, return
   values, persisted shapes, error classes, and sequencing.

## Finding bar

Report a finding only when a changed path makes a concrete invariant violation
reachable. Name the input or trigger, the path and stable symbol, the violated
contract, and the observable consequence. Use stable semantic anchors and a
short claim discriminator so the same defect can be recognized across review
rounds; do not key identity to a line number.

Prioritize a small set of actionable defects over broad commentary. Ground
each one in code, tests, or captured behaviour you inspected.

## Exclusions

Do not report naming, formatting, import order, helper extraction, speculative
hardening, unreachable defensive cases, unchanged defects, or failures already
demonstrated by an unrelated automated check unless the change caused them.
