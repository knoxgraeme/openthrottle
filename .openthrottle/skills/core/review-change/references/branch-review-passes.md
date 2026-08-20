# Branch review passes

The six lenses in `SKILL.md` are the fixed roster. Run them as serial passes
over the whole branch diff — one lens at a time, the whole diff each time. A
fixed roster run in a fixed order is what makes round N+1 produce the same
findings as round N for an unchanged subject; re-picking lenses from what the
diff happens to touch is the mechanism that turns a repair loop into churn.

## Working rules for every pass

- **Read the whole diff before judging any hunk.** A hunk that looks wrong alone
  is often correct given a sibling hunk, and vice versa.
- **Primary, secondary, pre-existing.** Added and modified lines are primary.
  Unchanged code in the same function or block that the change makes newly
  reachable or newly wrong is secondary — report it, saying the defect lives in
  the interaction. Unchanged code the diff neither touches nor makes relevant is
  pre-existing: not a finding here.
- **Collect candidates during the pass, judge them afterwards** so severity and
  ranking are decided once, over the whole set, and one defect yields one
  finding, filed under the lens that best explains the harm.
- **A pass with no findings is a completed pass.** Say so; do not pad.

## Pass 1 — Correctness

Execute the new paths in your head with concrete values, especially at the
edges. Success path *and* the failure and boundary paths the plan implies.

- Boundary and fencepost errors; inclusive-versus-exclusive mismatches; empty
  and single-element cases; a value that is `0` or `""` treated as absent.
- Absent values reaching code that assumes presence; a missing return on one
  branch.
- State set on success and not cleared on failure; partial updates that leave a
  record half-written; ordering assumptions with nothing enforcing them; a check
  whose subject can change before the dependent action runs.
- Does the code do what the plan says, or something adjacent to it? A mismatch
  between the stated intent and the actual behavior is a high-value finding
  regardless of which side is wrong.

## Pass 2 — Tests

The question is whether the added coverage would fail if the change were wrong.

- Walk each new branch and name the test that enters it. Tests that assert only
  "did not throw", assert truthiness where the value matters, or assert that a
  collaborator was called rather than what was produced.
- Tests so heavily substituted that they verify the arrangement rather than the
  code. Where the change crosses layers, one test should cross the real chain.
- Behavior the plan promised with no test at all — distinct from a gap inside
  tested code. Error paths, rejections, and denials with no assertion that they
  fire and none about the state left behind.
- Brittleness that will fail on the next refactor: exact call counts, direct
  assertions on private functions, snapshots of internal structures, order
  assertions where order is not contractual.

Not findings: trivial accessors, test-layout preference, coverage percentages,
missing tests for code the branch did not touch.

## Pass 3 — Contracts

Anything a caller or a stored record depends on.

- Public signatures, return types, thrown types, exported names; response
  shapes, status codes, field names, required-versus-optional flips, narrowed
  accepted input.
- Serialized and persisted shapes older records or clients still use, plus
  configuration keys, defaults, and environment expectations.
- Silent semantic drift: a field keeps its name and type but changes what it
  counts; a relied-on ordering is no longer guaranteed. No type checker catches
  these, which is why the pass exists.
- Migrations: safe to re-run, safe at the volume actually stored, safe while the
  previous code is still serving, and reversible.
- Additive change is not a contract break — new optional fields, endpoints, or
  parameters with defaults.

## Pass 4 — Untrusted input and secrets

- Follow each externally supplied value from entry to every place it is
  interpreted: query construction, markup, shell arguments, template evaluation,
  filesystem paths, outbound URLs. Interpolation without neutralization is the
  finding, and the trace is the evidence.
- Every new reachable entry point authenticates, and every lookup by a supplied
  identifier proves the caller may have that object. Nothing secret reaches
  source, logs, error text, or a URL.
- Deserializing externally supplied bytes into live objects, unless the format
  cannot express behavior.
- Do not file a second layer on an already-protected path, a development-only
  transport setting, or hardening with no reachable path here.

## Pass 5 — Failure handling

- New I/O boundaries — network, database, filesystem, queue, subprocess — that
  neither handle failure nor have a caller that does.
- Catch scopes broader than the errors they expect; name what they would hide.
  Handlers that swallow, or log and continue while returning a value the caller
  reads as success; silent fallbacks to a stub, a stale cache, or a default,
  where the caller cannot tell degraded from healthy.
- Retries with no ceiling and no growing delay; external calls with no deadline.
- Partial-failure states: state created before a risky call with no cleanup on
  failure, and a retry that duplicates rather than resumes.

## Pass 6 — Repository standards

Audit against the conventions this repository actually wrote down — its
committed agent instructions and the patterns in the neighbouring code — not
against general practice.

- Quote the rule and quote the violating line. A standards finding without both
  is not a finding.
- Match rules to what they govern: a convention for one file type is not
  evidence against another. Skip anything the toolchain already enforces, and do
  not review the standards themselves — they are the criteria here.

## Adjusting for the review mode

The roster does not change between modes; what you do with the result does.

- **Fresh review.** All six passes, full depth. Advisory findings are welcome
  here and only here.
- **Repair review.** All six passes, each opening with whether the repair closed
  what triggered it and whether it introduced anything new. Content a previous
  round accepted is settled. Raise no new advisory finding: only a defect that
  blocks acceptance of *this* subject may arrive late.
- **Post-simplification review.** All six passes, with Pass 1 and Pass 3 asked
  first as one question: was behavior preserved? A simplification that changed
  an error message a caller or test asserts on, thinned a validation, or altered
  a public shape is a blocking finding even when the code reads better.

Carry every prior-round finding forward with an explicit status — resolved,
still open, or superseded — and never drop one silently. A resolved finding is
raised again only when the defect is demonstrably still present here, and then
with a note on why the previous repair did not close it.

## Findings, not fixes

This review action has inspect authority only. Never edit repository content,
even when a correction appears small and local. File the defect with a stable
anchor so the supervisor can schedule a separate writable remediation attempt.
Never weaken, skip, substitute, or delete a test to make a check pass — a
failing check you silenced is a defect you concealed.
