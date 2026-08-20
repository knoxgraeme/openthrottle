# Simplification heuristics

Expanded patterns for the lenses in `SKILL.md`: the shape to look for, the shape
to leave behind, and the failure mode of applying it too eagerly. Fewer lines is
never the goal; faster comprehension is, and several of these add lines.

## Reuse

- **Hand-rolled version of an existing helper.** *Before:* a private
  `titleCase` beside an imported formatting module that exports one. *After:*
  call the existing one. *Too eagerly:* the existing helper is a near-fit whose
  edge behaviour differs — keep the local one and leave it alone.
- **Re-implemented language or runtime primitive.** A manual de-duplication loop
  where a set-based idiom exists; a hand-written deep merge beside a built-in.
  Swap only where behaviour is equivalent **for the inputs actually in play**.
  Locale-sensitive formatting, sort stability, and serialization edge cases are
  not equivalences — a swap that changes one is a behaviour change in costume.
- **Near-identical blocks.** Two or three blocks differing by one value or one
  branch collapse into one form parameterised by that difference — but only if
  the difference is genuinely one axis. *Too eagerly:* unifying blocks that are
  alike today and diverging tomorrow produces a function with a mode flag, which
  is worse than the duplication.

## Clarity

- **Derivable state.** *Before:* `items`, `itemCount`, and an `isEmpty` flag
  kept in sync in three places. *After:* `items`, with the other two computed.
  *Too eagerly:* the value is memoised because computing it is genuinely
  expensive on a hot path — leave it and say why.
- **Parameter sprawl.** A fourth or fifth argument bolted on to avoid
  restructuring. *After:* one options value, or a split into the two operations
  the flags were selecting between. *Too eagerly:* grouping unrelated arguments
  into a bag hides what the call site means.
- **Leaked internals.** A caller reaching through an abstraction to a field that
  abstraction exists to own: expose the operation the caller wants instead. And
  bare strings where the repository already models the value as a named constant
  or union — swap to the named form.
- **Nesting that flattens.** *Before:* three levels of conditional whose body
  runs in one combination. *After:* guard clauses returning early, or a lookup
  keyed by the discriminant. *Too eagerly:* flattening a conditional whose order
  carries meaning — a cheap check placed first to avoid an expensive one —
  changes cost, not shape.
- **Comments restating the code or narrating the change.** Delete them. Keep
  every comment recording a non-obvious *why*: a constraint, a workaround, an
  invariant the type cannot express.
- **Dead code this change introduced.** Unreachable branches, unused imports,
  exports nothing consumes. Remove only what *this* change added, and only once
  you have established there is no consumer; a plausible reference elsewhere is
  a reason to leave it.

## Efficiency and altitude

- **Work repeated where it could be hoisted** — a compiled pattern, a client, or
  a large literal built inside a loop or a per-call path.
- **Per-item calls inside a loop** the surrounding code could satisfy in one
  round trip. *Too eagerly:* batching changes failure granularity, so one
  failure now fails the whole set. If the loop's error handling relied on
  per-item isolation, this is a behaviour change.
- **Independent operations forced into sequence** when nothing orders them and
  the repository already has an idiom for running them together.
- **New work on a hot path** — a per-request read, a per-render allocation, a
  check added inside the loop rather than before it — plus **unbounded
  accumulation** this change made possible, and **reads broader than the need**:
  the whole record where one field is used, the whole collection for one match.
- **Wrong altitude.** A low-level detail surfacing in a coordinating layer, or a
  policy buried in a leaf the coordinator should own: the detail moves down, the
  decision moves up. *Too eagerly:* moving a decision up through a boundary it
  was deliberately kept below is a design change, not a simplification.

## Never thin a safety property

Validation at a trust boundary, error handling that prevents data loss,
authorization checks, escaping and sanitization, and accessibility affordances
are load-bearing even when they read as redundant boilerplate. Code that drops
one is not simpler, it is unfinished; when a heuristic above appears to point at
one of these, the heuristic is wrong here. Two more that look like cleanups and
are not: inlining a helper whose only job is to *name* a concept, and removing a
testing or extension seam whose purpose you have not confirmed obsolete.

## Per-edit behaviour check

Before applying each edit, establish all four:

1. Same result for every input the code can actually receive.
2. Same error paths, in the same conditions, with the same types.
3. Same side effects, in the same order.
4. Same public surface — signatures, exported names, serialized shapes, and any
   message a caller or a test asserts on.

If reading cannot establish all four, skip the edit — silently. Do not argue
with the finding, do not leave it as a backlog note, and do not reach for a
broad command run to settle a doubt reading could not.

Report by dimension: what improved under reuse, clarity, and efficiency, and
what you deliberately skipped. Never report a line count.
