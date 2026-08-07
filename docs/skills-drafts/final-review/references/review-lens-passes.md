# Review lens passes

The three lenses in `SKILL.md` are the fixed spine of this review. Run each as
one serial pass over the whole subject. The deepening sub-passes below belong to
their parent lens and fire on a stated property of the subject, so the same
subject fires the same set every round — the only way the loop converges.

## How to run a pass

- **One lens at a time, whole subject each time.** Reading the diff once and
  asking all three questions per hunk answers correctness three times and
  regression never.
- **Trace, do not skim.** A pass ends when you have walked concrete values or
  concrete callers through the changed paths, not when you have read every line.
- **Collect candidates during the pass, judge them after,** so the ranking is
  coherent. When two passes reach the same construct only one finding survives:
  the one whose lens explains the damage best.
- **A pass that finds nothing is a completed pass.** Do not manufacture a
  finding to justify having run it.

---

## Pass 1 — Correctness: does the changed code do what it claims?

Read by executing in your head. Pick concrete values, especially at the edges,
and follow them through the new branches.

- **Boundaries.** Loop and slice bounds that drop the first or last element;
  inclusive-vs-exclusive mismatches; pagination that loses the final page when
  the total divides evenly; empty-collection paths nobody walked.
- **Absent values.** A function that returns nothing on failure with a caller
  that does not check; an optional field read without a guard, becoming a
  literal `"undefined"` in a string or a non-number in arithmetic.
- **State transitions.** A flag set on success and never cleared on failure; a
  machine that can reach a state its handlers do not cover; a multi-field update
  where a failure between fields leaves the record half-written.
- **Ordering and check-then-use.** Two operations whose interleaving matters
  with nothing enforcing order; a validity check whose subject can change before
  the dependent action runs; work assuming initialization already completed.
- **Error propagation.** Errors caught and dropped; errors re-raised with the
  context stripped; a fallback that makes "the query failed" indistinguishable
  from "there were no results".

Never flag here: naming, formatting, comment presence, code that is slow but
right, or a guard for a value that cannot be absent on a reachable path.

### Sub-pass 1a — Failure handling

*Fires when the change adds or edits an error handler, retry, timeout, fallback,
or any I/O call.*

- Every new I/O boundary (network, database, filesystem, queue, subprocess)
  either handles failure or has a caller that does. Name which.
- Retries have a ceiling and a growing delay; immediate unbounded retry turns a
  blip into a self-inflicted outage. External calls carry an explicit deadline;
  without one a slow dependency consumes the caller's capacity until none is
  left.
- Catch scopes are as narrow as the errors they expect. A broad catch wrapped
  around a block that also does real work will one day swallow a defect from
  that work — name the error classes it would hide.
- No handler is empty, and none logs and continues while returning a value the
  caller reads as success. A fallback is acceptable only when it is deliberate
  and observable; a silent fall back to a stub, a stale cache, or a default is a
  defect in costume.
- Trace the failure path for orphaned state: when a record, file, or lock is
  created before the risky call, does failure clean it up, and is retry
  idempotent?

### Sub-pass 1b — Untrusted input and authorization

*Fires when the change touches a request handler, a query, a template, a path or
URL built from data, deserialization, a permission check, or anything logged.*

- Follow each externally supplied value from entry to every place it is
  interpreted: query construction, markup, shell arguments, template evaluation,
  filesystem paths, outbound URLs. Interpolation into any of those without
  neutralization is the finding, and the trace is the evidence.
- New reachable entry points authenticate, and every lookup by a supplied
  identifier proves the caller may have that object. "Signed in" is not
  "entitled". Nothing secret reaches source, logs, error text, or a URL.
- Deserializing externally supplied bytes into live objects is a defect unless
  the format cannot express behaviour.
- Do not flag a second layer on an already-protected path, a development-only
  transport setting, or generic hardening with no reachable path here.

### Sub-pass 1c — Composition and sequence

*Fires when the change spans more than one module, adds a caller of existing
code, or introduces shared state.*

Each component can be right alone and wrong together. Construct the failure
rather than evaluating the code.

- **Assumption violation.** List what the new code takes for granted — a
  response is always well-formed, a key is always configured, a collection is
  never empty. For each, build the input that breaks it and follow it.
- **Contract mismatch across a boundary.** The caller's idea of the return value
  against the callee's; the error types one raises against the ones the other
  catches; a value passed in a shape the receiver never handles.
- **Shared state.** Two paths reading and writing the same row, key, file, or
  module-level value with nothing coordinating them.
- **Cascades.** Write the chain out — trigger, each step, end state. A timeout
  causing retries causing more timeouts; partial data written by one step and
  acted on by the next; a recovery path creating the duplicate it prevents.
- **Abuse from ordinary use.** The same action submitted a thousand times; a
  request arriving mid-deploy or between an invalidation and a refill; two
  actors editing one resource; input at exactly the permitted maximum.

Title these by the failure you constructed, not the pattern you matched; the
evidence is the chain: trigger, path, outcome.

---

## Pass 2 — Regression: what working behavior could this break?

The subject is half the input. The other half is everything that already depends
on the code it changed.

- **Callers.** For every changed signature, return type, thrown type, or error
  contract, open the call sites. A widened return type with unchanged callers is
  a defect at the callers, not at the definition.
- **Wire and storage shapes.** Renamed or removed response fields, changed
  status codes, narrowed accepted input, a field flipping between required and
  optional, a serialized or persisted shape older records still use.
- **Silent semantics.** A field that keeps its name and type but changes what it
  counts; a default that moves; an ordering relied on and no longer guaranteed.
  These are the regressions no type checker catches.
- **Migrations.** Anything running against existing rows: safe to re-run, safe
  at the volume actually stored, safe while the old code still serves,
  reversible.
- **Validation.** A check removed, relaxed, or moved to a layer that not every
  path goes through.
- **Cross-unit expectations.** Behavior another unit of this change now depends
  on, where only one of the two was updated.

Additive change is not a regression: new optional fields, endpoints, or
parameters with defaults. Neither is "slower".

### Sub-pass 2a — Types and invariants

*Fires when the change adds or reshapes a type, record, or schema that crosses a
module boundary.*

- Name the invariants the type is meant to carry. Are they enforced where values
  are constructed, or only asserted in a comment?
- Can an invalid instance be built through any constructor, setter, or partial
  update this change adds?
- Does the change add an escape hatch (an unchecked cast, a suppression comment,
  a permissive catch-all field) that lets an unproven value through a boundary
  that used to prove it?
- Prefer a finding naming the illegal state now representable over one rating
  the design.

### Sub-pass 2b — Cost and scale

*Fires when the change adds a query, a loop over externally sized data, an
allocation on a per-request path, or a full-collection read. Hold it to a higher
bar than the others: false positives cost real work, true positives are cheap to
fix later.*

- A query inside a loop over data whose size the caller controls.
- A read of an entire collection with no limit, cursor, or streaming, where the
  consumer holds the whole result.
- Expensive construction (compiled patterns, clients, large literals) inside a
  loop or per-request path when it could be built once.
- Blocking work on a path the runtime expects not to block.

Do not flag cold paths, early-stage code, or optimizations you cannot price.

---

## Pass 3 — Test proof: does the change carry proof it works?

Coverage is not the question. The question is whether these tests would fail if
the change were wrong.

- **New branches with no exercise.** Walk each new conditional and name the test
  that enters it. Logging-only branches are not behavior.
- **Assertions that cannot fail.** Tests that only assert nothing threw, assert
  truthiness where the value matters, or assert a collaborator was called rather
  than what the code produced.
- **Tests that verify their own scaffolding.** When every collaborator is
  replaced the test proves the arrangement; at least one test should cross the
  real chain wherever the change crosses layers.
- **Error paths asserted nowhere.** Every rejection, timeout, and denial wants a
  test that it fires and that the state left behind is sane.
- **Behavioral change with no test work at all** — not a gap inside tested
  code, but no test movement beside a behavior movement.
- **Brittleness.** Exact call counts, private functions asserted directly,
  snapshots of internal structures, order assertions where order is not
  contractual. These fail on refactors and pass on defects.

Never flag: trivial accessors, test-style preferences, coverage percentages, or
missing tests for untouched code.

## Deliberately not a pass here

Structural taste — file size, layering preference, premature abstraction,
naming — is out of scope by design and belongs to the simplification stage.
Raise it only when you can state the defect it causes in *this* subject.
