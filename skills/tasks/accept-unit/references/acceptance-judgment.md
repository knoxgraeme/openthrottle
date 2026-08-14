# Acceptance judgment

This action is the only gate that can spend a repair round on judgment rather
than on a failed command. That makes the default posture, the depth of reading,
and the shape of a revision request the three things worth getting right.

## 1. Reading an acceptance entry

The `acceptance` entries are the contract. The rest of the unit's context —
`objective`/`requirements`/`approach` in the current plan format, or the
resolved `instructions` text in a legacy plan — explains them; the plan prose
around them is background. When the two disagree, the acceptance entry
decides.

Classify each entry before judging it:

- **Behavioural** — "invalid configuration is rejected", "the retry stops after
  three attempts". Judged by finding the behaviour in the candidate tree, not a
  sentence about it in the completion receipt.
- **Artifact** — "a migration exists for the new column", "the helper is
  exported from the shared module". Judged by the artifact's presence and shape.
- **Constraint** — "no change to the public response", "no new dependency".
  Judged by what the candidate *did not* do; most often skipped, and the ones a
  scope-match decision exists to enforce.

**Ambiguity resolves narrowly.** When an entry admits two readings, take the one
its own words support with the least additional work implied. An entry that says
"rejects invalid input" is met by rejection; it does not silently also require a
specific error type, a log line, or a metric unless it says so. Reading extra
requirements into an entry is how a lead invents work the plan never approved.

**An entry you cannot judge is not an entry you may assume.** If neither the
evidence nor the tree settles it, that is `needs_human`, not a guess.

## 2. How deep to read

Read enough to decide, and no further. Three tiers:

- **The claim is visible in the candidate.** The changed files show the
  behaviour or the artifact the entry names. Read those files and decide.
- **The claim is contestable.** The completion receipt asserts an entry is met
  and you cannot see it in the changed files, or the change looks like it does
  something adjacent. Open the file, read the callers, look for the existing
  test or guard that would make either side right. This tier is where a
  confidently-wrong claim gets caught, in both directions.
- **The change looks deliberate but wrong.** Before treating it as a scope
  breach, look for the reason: a neighbouring pattern, a constraint in the
  instructions, a downstream-context note handed to this unit. The worker had
  context you are reading second-hand; recover it before overriding it.

Read each file once and judge every entry that touches it together.

## 3. Default to accepting

Most candidates that reach this gate are acceptable. The commands have already
been graded, a failed candidate never arrives here, and the worker had the same
sealed instructions you did. Your job is to catch scope mismatch, not to raise
the quality bar.

The tripwires below are what a revision costs a round *for*. If none of them
trips, accept and move on. "I would have done it differently" is not a tripwire;
"acceptance entry A3 says X and the tree does not do X" is.

**Revise when:**

- A stated acceptance entry is unmet at this candidate — behavioural, artifact,
  or constraint.
- The change reaches outside the unit's stated scope in a way that must be
  undone: another unit's files, an unrelated defect fixed in passing, a
  dependency added, a shared contract the instructions never named.
- The unit did something it was explicitly told not to do.
- The candidate cannot satisfy an entry as written because the work was done
  against a different reading of it, and the correct reading is unambiguous.

**Never revise for:** naming, formatting, layout, structure, comment style, test
framework or test-layout preference, a refactor you would prefer, additional
coverage the acceptance entries never asked for, or a defect the unit inherited
and did not touch.

## 4. Accept with a note

The middle path exists and is usually the right one. When the work satisfies
every acceptance entry but you saw something worth saying — an imperfect shape,
a latent issue the unit did not introduce, a decision you would have made
differently, a fact the next unit will want — accept and put it in `rationale`.
An observation costs nothing there. As a revision request it costs a round, and
the round may be the last one the run has.

Two things belong in `rationale` rather than in a revision request:

- **Anything you would not fail the unit over.** If you would accept the
  candidate on a second look, you would accept it now.
- **Anything the next unit needs to know but this unit need not change.**
  Downstream-facing facts go through the context-update path when they have a
  verifiable target, and into `rationale` when they do not.

## 5. Writing a revision request that closes in one round

The repair worker acts on the text you write and little else. Give it, in one
sentence each:

1. **Which acceptance entry** is unmet, named as the plan names it.
2. **Where** — the file, and the symbol or construct.
3. **What observably differs** — the current and required behaviour, in terms
   someone can check by running something or reading the tree.

Weak: "Improve error handling in the config loader."
Strong: "`parseConfig` returns `null` for an empty `limits:` block, so an
invalid file is accepted silently — acceptance A3 (invalid config is rejected)
is unmet. It must raise, and the existing `rejects malformed config` test should
cover the empty-block case."

Ask for one round's worth of work. A revision request listing five unrelated
improvements produces a wide repair, and a wide repair is how the next round
arrives with new problems.

## 6. Stability across rounds

- Judge against the sealed acceptance entries only. Do not add a requirement
  between rounds; the entries did not change, so neither may the bar.
- When your previous revision request is satisfied, accept. Substituting a fresh
  objection is the failure mode that exhausts the budget — the one exception is
  a defect violating a stated entry that you can show was already unmet before.
- Do not restate a failure the executor already owns. Failed commands and failed
  candidates are decided before your receipt is read; read them for signal, then
  spend your decision on scope match.
