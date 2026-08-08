# Finding quality

A finding is a request for work from a budgeted repair round. It is worth its
cost only when the next action can act on it without re-deriving your reasoning.
This file covers the four properties that decide that: evidence, severity,
actionability, and identity.

## 1. The evidence bar

Before a finding is blocking, quote the construct that makes it true — the
actual line or lines from *this* subject, with the file path. That quote is the
whole defence against the largest false-positive class in automated review:
confidently describing a symbol, field, or path that does not exist. What
"quote it" means per claim shape:

| Claim | Quote this |
|---|---|
| "field X is missing on Y" | the definition site where X would be declared |
| "this can be absent here" | the assignment that leaves it absent |
| "A and B race" | both A and B |
| "wrong argument / wrong return" | the call site *and* the signature |
| "this violates a repository rule" | the rule text *and* the violating line |

When the symbol is produced by a framework — a schema declaration, a decorator,
a migration, a generated client — quote the construct that generates it. Reading
the generator satisfies the bar; a search that found nothing does not.

**If you cannot quote it, it is not blocking.** Downgrade to advisory or drop.

## 2. Severity, calibrated against the gate

Severity is not a mood ring. In this pipeline it is a control signal:

- **`P0` / `P1` are blocking.** Either forces a repair round no matter what
  `result` you declare, drawn from a small fixed budget whose exhaustion ends
  the run with no pull request.
- **`P2` / `P3` are advisory.** Recorded, never repaired, acted on by nothing.

So the honest question is not "is this bad?" but "is this worth one of the run's
remaining rounds, and could the repair action close it?" A wrong blocking
finding burns a round on nothing and can end the run; a missed one ships the
defect. Calibrate per class rather than uniformly:

- **Data loss, corruption, exposure**: blocking even when you could not fully
  confirm exploitability, provided you can quote the construct. Being wrong
  costs a round; being silent costs the data.
- **Correctness, contracts, regressions**: blocking when a normal caller or
  stored record hits it on a reachable path.
- **Cost and scale**: blocking only when you can name the input that makes it
  hurt — this class is cheap to fix later and expensive to be wrong about.
- **Structure, naming, ergonomics**: never blocking here.

A style nit is never `P0`. A silent data-corruption path is never `P2`.

## 3. The honesty ladder

Apply this to yourself, per finding, before assigning severity. Take the lowest
rung you can state truthfully.

1. **Mechanical** — verifiable from the code alone with no interpretation: a
   definitive logic error, a type or signature mismatch, or an explicit breach
   of a rule you can quote. Blocking if the consequence is blocking.
2. **Traced** — you followed a concrete path from an input to a wrong outcome
   and can name the observable consequence. Blocking likewise.
3. **Plausible** — the pattern is present but one step depends on something you
   cannot see here. Advisory, unless the class is data loss or exposure, in
   which case file it blocking with the gap stated.
4. **Speculative** — the failure needs conditions you have no evidence for.
   Drop it silently; do not file it as advisory to hedge.

"Will a caller, an operator, or stored data concretely meet this?" separates 2
from 3. "This could be cleaner" and "I would have written it differently" are
not rungs on this ladder at all.

## 4. Non-findings

These are not low-severity findings to route to advisory. They are noise, and
each one costs ranking positions that only ten findings ever reach:

- **Pre-existing problems the change does not touch or make newly reachable.**
- **Anything the toolchain already owns** — formatting, import order, unused
  locals a configured linter reports, or a rule the author deliberately
  suppressed with a comment naming exactly what you are about to raise.
- **Code that looks wrong but is deliberate.** Check the surrounding code, the
  plan, and the change's own summary before flagging intent.
- **Concerns already handled elsewhere** — by a caller, a guard one line up, a
  middleware, a framework default, or a parallel handler you did not read.
- **Restatements of the code** — "consider extracting a helper" where the code
  already is one; "add a guard" where the guard exists.
- **"Consider adding X" with no named failure mode.** If you cannot say what
  breaks, there is no finding.
- **Rules the repository never wrote down.** "This file is long", "too many
  parameters", "hard to read" are findings only against a committed convention
  you can quote.
- **Future-tense worry** — "this might not scale", "requirements could change".

## 5. Repair-actionability

Write every finding so the repair action can start editing immediately.

- **Say what changes.** Name the file, the symbol, and the behavior that must
  differ. "Improve error handling" is not a request; "`loadConfig` returns an
  empty map when the file is unreadable, so callers cannot distinguish an empty
  config from a read failure — propagate the error instead" is.
- **Ground the fix in the repository's own conventions** when a parallel example
  exists. Point at it; that is worth more than a general principle.
- **Incomplete information is not a reason to omit the fix.** Ask what you would
  change if the choice were yours right now, propose that, and state the
  assumption so it can be corrected.
- **The genuine no-fix cases are rare**: a question with no defensible default,
  or a resolution with no code component. Either of those is a `needs_human`
  signal, not a repair request.

## 6. Stable identity

Line numbers move whenever anything above them moves. An identity containing one
turns a single unfixed defect into a fresh finding every round, and the run
drains its budget while converging on nothing.

Open each `message` with the content-derived tag `SKILL.md` specifies, and hold
it byte-stable across rounds. Worked examples:

```
BAD  [src/config.ts:142: null return]
     — moves when anything above line 142 moves.
BAD  [src/config.ts: error handling]
     — two different defects in the file collide on one identity.
GOOD [src/config.ts#loadConfig: read failure is indistinguishable from empty]
GOOD [src/config.ts#loadConfig: partial write is not rolled back on throw]
     — same file, same symbol, two invariants, two stable identities.
```

Across a repair round the tag does not change even when the code does. If round
1 raises `[src/queue.ts#drain: retries have no ceiling]` and round 2 finds it
resolved, the tag is byte-identical even though the repair moved and reformatted
the function — which is what makes the round legible as progress rather than
churn. If the symbol itself disappears, anchor to the nearest surviving stable
construct — an exported name, or the module path plus the invariant — never to a
position.
