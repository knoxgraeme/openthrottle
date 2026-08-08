# Diagnostic method

The ladder behind the four steps in `SKILL.md`, with the bar each rung clears
before you may climb the next.

## Rung 1 — Reproduce

Run the failing thing and capture the symptom verbatim: message, exit status,
wrong value, state left behind. A symptom you paraphrased is one you may already
have reinterpreted.

**When it does not reproduce after two or three attempts**, that is information.
Work these in order and record which you used:

- **Repeat under measurement.** Run it in a bounded loop and establish a rate.
  "One time in twenty" points at timing or data; "every time under one
  condition" points at that condition.
- **Isolate one variable at a time** — different data seed, serial rather than
  parallel, with and without network. **Find the data trigger**: size, encoding,
  an edge value, ordering.
- **Suspect order pollution.** If it passes alone and fails in the suite, run it
  alone, then its file alone, then bisect the tests that precede it. Usual
  culprits: module-level state, undone substitutions, temporary files, and
  environment values mutated and never restored.

**When it will not reproduce at all**, say exactly what you ran, what conditions
appear to be missing, and what evidence you are substituting. A failure you
never observed is a hypothesis and must be labelled as one.

**Minimize before tracing.** Halve the reproduction, check whether it still
fails, recurse on the half that does; strip payload fields and setup steps one
at a time. The minimal form often names the cause outright — "only when the
value contains a tab" is far louder than a five-hundred-line integration case.

## Rung 2 — Isolate

**Confirm the environment before blaming the code.** Right branch, no unintended
local modifications, dependencies actually installed, expected runtime version
active, required environment values present and non-empty, no stale build
output. The last two are among the most common false leads.

**Trace backwards, not forwards.** Read the stack bottom-up, opening each frame.
Find the earliest frame whose input is *already* wrong — that bounds where the
cause can be. Instrument the boundaries around it and capture the values that
actually flow rather than the ones you expect. Walk down until valid input
becomes invalid output; that transition is the site. Do not stop at the first
function that looks wrong: the cause is where bad state originates, not where it
is first noticed.

**When the failure crosses subsystems**, one call chain is the wrong instrument.
List every boundary the data crosses from trigger to symptom, capture what
enters and leaves each in a single run, then read the log linearly comparing
each "leaves" against the next "enters". The first mismatch is the failing
layer; backward tracing resumes inside it.

**Check the history of the files you read.** "It used to work" is a claim about
a specific change; find it rather than reasoning around it. And change one thing
at a time — changing several to see which helps adds variables.

**If instrumenting makes the symptom vanish, you have not fixed it** — you
perturbed it. That is itself diagnostic: it points at timing, memory pressure,
or I/O ordering rather than the nominal logic. Capture into memory and dump
after the failure, or use post-mortem state, instead of live tracing.

## Rung 3 — Root cause

**Audit the assumptions first.** Write down the "this must be true" beliefs your
understanding rests on — this function returns what its name implies, this
configuration loads before that runs, this caller never passes an empty value —
and mark each *verified* (read, ran, or observed) or *assumed*. Most stuck
investigations are a correct hypothesis tested against a wrong assumption.

**Every hypothesis needs a grounding observation.** Not "X looks off" but "X is
empty at this call because Y is only populated on the branch condition Z
selects". A hypothesis with no observation behind it is theorising: go back to
rung 2 and instrument.

**Write the causal chain with no gaps.** Trigger, each step, symptom. "Somehow"
marks a gap, and a gap means you do not have the cause.

**Predict where a link is uncertain.** A useful prediction names something you
have *not* looked at — a different path or observable that must also hold if the
link is real. "The value will be empty when I log it" restates the hypothesis
and cannot falsify it; "the non-cached path will not fail, and failing requests
will all carry this header" can. If a fix works but the prediction was false,
you found a symptom and the cause is still live.

**Diagnose being stuck** rather than trying harder. After two or three failed
hypotheses:

| Pattern | Means | Next move |
|---|---|---|
| Hypotheses land in unrelated subsystems | A design problem | Report it |
| Evidence contradicts itself | Your model is wrong | Re-read from the entry |
| Passes here, fails in the gate | The difference is the bug | Compare the two |
| Fix works, prediction false | Symptom, not cause | Keep going |

**Pattern-match before deep tracing** — cheap and often decisive. Does the
symptom fit a known class: time zones and DST, encoding and locale, floating
point, integer overflow, fencepost, cache staleness, permissions, dependency
drift, path case sensitivity, concurrency and ordering, stale build artefacts,
or check-then-use?

## Rung 4 — The evidence bar for the report

Before the diagnosis is a result rather than a guess, all of these hold:

- The symptom is quoted as observed, not as described to you.
- The cause is a specific construct in a specific file, named.
- The chain from trigger to symptom contains no "somehow", and at least one link
  is backed by a value you actually observed.
- Where a link was uncertain, the prediction is stated and its outcome recorded.
- You can say which existing test should have caught this and why it did not.
- If you applied a fix, you can say why *that* change closes *that* cause, and
  the regression test fails before it and passes after.
