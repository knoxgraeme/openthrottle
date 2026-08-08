# Implementation discipline

The full method behind the numbered steps in `SKILL.md`. Sections 1–6 apply to
any edit in this worktree. Section 7 applies when this action repairs rejected
work; section 8 applies to both.

## 1. Read before writing

Orient before the first edit, in this order:

1. **The files the unit names** — whole if small, and the whole enclosing
   construct if not. A diff written from a partial read is where "works in
   isolation, breaks in place" comes from.
2. **The nearest existing example of what you are adding** — a sibling handler,
   an adjacent module doing the same job for another case, the last commit
   against the same seam. It tells you what this repository considers correct.
3. **The tests that already own the behaviour** (§3).

Capture the local conventions explicitly, because your defaults leak in
otherwise: file layout, import style, how errors are raised and handled, how
things are named, how configuration is reached, how tests are shaped. Where the
repository disagrees with your preference the repository wins, and no note is
needed. Where the repository is inconsistent, follow the nearest neighbour.

## 2. Smallest correct increment

Change one behaviour at a time and keep the tree in a state you could hand over
at any moment. Two behaviours that must move together to stay coherent are one
increment; two that merely share a file are two. The test: can you describe what
changed in one sentence naming a behaviour rather than a set of files? If it
needs "and also", the failure you hit later will be harder to locate.

## 3. Test discovery

Before changing an implementation file, find the tests that already cover it:
files that import it, files sharing its name under a test prefix or suffix, and
files mirroring its path under a test directory. Check the repository's own
layout convention before assuming any of the three.

Then prefer, in order:

1. **Extend** a test that already owns the contract.
2. **Correct** an expectation this change makes wrong — and say in `decisions`
   why the old expectation no longer holds.
3. **Strengthen** a test that would pass either way but covers this behaviour.
4. **Add** a new test only when no existing test is the right home.

Tests move with behaviour: new behaviour gets new coverage, changed behaviour
gets updated coverage, removed behaviour gets its coverage removed. Changing
behaviour with no test movement needs a stated reason.

## 4. Scenario completeness

For each behaviour-bearing change, check the categories that apply. Where the
unit's instructions or acceptance name scenarios, start there and fill the gaps;
where they are vague ("validates correctly"), derive concrete cases first.

- **Happy path** — always. The input/output pair the unit exists to produce.
- **Boundary** — where the unit has real edges: empty, absent, first, last,
  maximum, zero, one.
- **Failure** — where it validates, calls out, or enforces: each input it must
  reject, each denial it must enforce, each downstream failure it must survive.
- **Integration** — where it crosses a layer: the real chain end to end, with
  the interacting layers not substituted.

Skip a category deliberately, not silently: if the unit has no real edges, say
so in `decisions`.

## 5. Trace two levels out

Before calling the work done, answer these against the code — not against its
documentation or its name:

- **What else fires when this runs?** Lifecycle hooks, middleware, subscribers,
  observers, scheduled follow-ups, cache invalidations. Open them.
- **Do the tests exercise the real chain?** If every collaborator is replaced,
  the test proves the arrangement, not the interaction. Where the change crosses
  a layer, one test should leave the interacting layers real.
- **Can a mid-way failure leave partial state?** If the code persists a row,
  file, lock, or queue entry before a call that can fail, trace what failure
  leaves behind and whether a retry duplicates it.
- **What other entry points expose this?** Alternative interfaces, re-exports, a
  second caller of the same helper. If parity matters, it matters now.
- **Do the error strategies at each layer agree?** A retry wrapper, an
  application fallback, and a framework handler can each be right and together
  produce double execution or a swallowed failure. Name the error classes each
  layer raises and check the handler above it matches.

Skip this for a leaf change with no hooks, no persistence, and no second entry
point — the answer is "nothing fires".

## 6. Verify as you go

After each meaningful change, run the narrowest real check: the single test file
or case you touched, a focused type check, a direct invocation. Fix failures
immediately; a deferred failure becomes a gate failure and costs a round. Record
what you actually ran and what it actually produced — a recorded check that did
not happen is worse than no check, because the next action builds on it.

## 7. Repair: establish the failure first

A repair that edits before it can name the failure degenerates into a rewrite,
and a rewrite is the shape that burns rounds without converging.

**The reproduce ladder**, in strict order of preference:

1. **Sealed text.** Any failure output, revision request, or named finding in
   this action's context or prior evidence. Read it whole. When a command
   failed, the *first* real error is the signal — not the last line of output.
2. **The continued session.** What you last did, what you left unproven, what
   you already ruled out. Do not re-test an eliminated hypothesis.
3. **Reproduce it.** Run the relevant configured command in this worktree and
   read the first real error. If it does not reproduce, that is itself the
   finding: say what you ran, what you expected, and what you saw.

If none of the three yields a statable failure, stop. Do not guess and do not
rewrite the unit — take the receipt's escape hatch with the exact question.

**Once the failure is named:**

- Fix it at its cause, never by suppressing the symptom. Deleting, skipping,
  weakening, substituting, or marking-as-expected a failing test, assertion,
  type, or rule to make a gate pass turns one visible defect into two hidden
  ones. If a test is genuinely wrong, say why and correct it as a test.
- **One change per hypothesis.** Changing several to see what helps adds
  variables instead of removing them. On a failed repair, state what the failure
  ruled out *before* forming the next hypothesis; retrying variants of the same
  theory is not iteration.
- **Re-run the exact check that failed**, confirm it passes, then run the
  narrowest checks around what you touched.
- **Add the test that would have caught it** when the failure was behavioural
  and nothing covers it — that makes rounds compound rather than oscillate.
- **Keep the repair smaller than the change it repairs.** More files touched
  than the original implementation means scope widened; narrow it back.

## 8. Signals you are about to shortcut

- **A fix proposed before the cause is stated.** If "change X" arrives before
  "the cause is Y", the fix may be right but nothing here can tell.
- **"It works now"** with no account of *why*. If the chain still needs the word
  "somehow", you have a symptom. "It's probably just…" is the same tell: small
  problems do not survive two attempts.
- **Certainty before reading.** Pattern-matching is right often enough to be
  dangerous when wrong. Read the code anyway.
- **Widening because the wide fix is easier to justify.** Unrelated defects go
  into `issues` unfixed: recording one costs a line, fixing one costs a round.
