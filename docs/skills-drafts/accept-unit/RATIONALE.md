# Rationale — review/acceptance family rewrite (`accept-unit`, `final-review`, `final-repair`)

Drafts: `.context/skills-drafts/{accept-unit,final-review,final-repair}/SKILL.md`.
No tracked file was modified. Sources read: `skills/README.md`, `AGENTS.md`,
`.context/skill-audit.md` (§C1–C9, §5b, §6, E1–E8), the three adapters at
`origin/main`, `sandbox/runner/execute-loop.mjs` (`loopPrompt`, `priorEvidence`,
`parseLoopReceipt`, `assertLoopReceiptFence`),
`supervisor/src/pipeline/execution-gates.ts`,
`supervisor/src/pipeline/structured-loop-envelope.ts`,
`supervisor/src/operations/structured-child-runtime.ts`,
`contracts/src/receipts.ts`, `supervisor/src/persistence/pipeline/unit-store.ts`,
and the installed `ce-code-review` tree (concepts only — every line below is
written fresh; no CE text, structure, or naming is carried over).

---

## `accept-unit` — 117 lines

**Kept.** Lead scope-match framing; "not a code review"; the four-value
`unit_decision` vocabulary; the no-edit / no-commit / no-publish / no-gate-authority
boundary; one receipt per action.

**Dropped.** `Do not invoke \`ce-code-review\`` (the only CE token in the old
file). The prohibition it encoded — do not turn the lead gate into a code review
— is now carried positively by "the `acceptance` entries are the criteria,
nothing else is" plus the revise-economics rule.

**Added.**
1. **Evidence binding (C7/E1, live gate defect).** Explicit verbatim-copy rule
   naming exactly which hashes qualify: the `completion`, `candidate`, and every
   `command` entry in `## Prior Evidence`. Includes the anti-paraphrase list
   (no re-hash / truncate / prefix / uppercase / reformat), the "never compute a
   digest yourself" rule, and an explicit override of the Receipt Authority
   Contract's `evidence` sentence ("do not reuse sibling or prior action
   evidence"), which today points the model away from the only thing that makes
   the receipt valid. The exact gate error string is quoted so the failure is
   recognizable in logs.
   *Version note:* `origin/main` requires `[completion, candidate, …commands]`;
   the working branch `operator-staging-sync` currently requires
   `[candidate, …commands]`. Copying **all** prior-evidence hashes satisfies both,
   which is why the rule is phrased as "every entry", not as a field list.
2. **`unit_decision` payload fields** — `rationale`, `revision_request`,
   `context_updates`, `accepted_subject`, with `accepted_subject` pinned to
   `subject.post` (the gate throws `lead accepted_subject fence mismatch` otherwise).
3. **`subject.post`** — for a read-only action it is `subject.pre`. This is
   provable from the code (lead expected subject = the candidate receipt's
   `subject.post`, which is also the lead action's `inputSubject`), so unlike the
   worker family it needs no helper and no algorithm description.
4. **Repair economics** — revision costs one of a small fixed budget whose
   exhaustion ends the run as `needs_human` with no PR; a concrete
   bad-vs-good `revision_request` example; an explicit "accept imperfect work"
   instruction.
5. **Round stability (C4)** — do not add requirements between rounds; accept once
   your own previous request is satisfied.
6. **`context_updates` validity** — target must exist, be a *declared dependent*,
   and still be pending, or the whole action aborts mid-transaction
   (`unit-store.ts` `listDownstreamContext`-side validation; the T21 class in E6b).
   Default guidance is "leave it empty".
7. Fence/producer verbatim echo + `assurance` is top-level, never inside
   `producer` (C2 — previously only a code comment in `loopPrompt()`).
8. Budgets (C3) and the single-line JSON output convention (C9 —
   `parseLoopReceipt` scans whole output, then individual lines).

---

## `final-review` — 140 lines

**Kept.** Report-only with no edit authority; review the integrated whole once;
edits route through `final-repair`, which invalidates this receipt and forces a
fresh review of the repaired head; one `semantic_review` receipt. These were the
best-written parts of the old adapter and are normative.

**Dropped.**
- The CE hop (`ce-code-review mode:agent base:origin/$BASE_BRANCH`) and with it:
  the cross-model peer egress path (unsanctioned code egress out of a minimal-
  credential boundary), the ~4.7k lines of persona/reference loading, the
  risk-inferred per-run roster (a major churn source), and the JSON→3-field
  mapping the adapter never specified.
- `base:origin/$BASE_BRANCH` itself (**C5**): `BASE_BRANCH` is not in
  `safeBaseEnv()`'s passthrough allowlist, so the structured final review has
  been reviewing against a guess. Replaced by `subject.base` from the Receipt
  Authority Contract, with an explicit "do not assume `main`/`master`/`origin/*`"
  because a `branch` Linear label can override the base per ticket.

**Added.**
1. **Evidence binding (C7/E1)** — copy every `final_command` `receiptHash`
   verbatim; same override of the contract's `evidence` sentence; quoted gate
   error. Plus the unstated ordering rule: `issued_at` must not precede any
   command receipt (`final review receipt predates whole-change command evidence`).
2. **A fixed three-lens taxonomy** (correctness / regression / test-coverage) with
   concrete hunting lists and explicit non-goals, written in own words. Fixed and
   ordered so the same subject yields the same review each round — determinism is
   the point, and per-run roster re-selection was half of the churn mechanism.
3. **Severity mapped to the actual gate** — `P0`/`P1` set
   `semantic_repair_required` in `semanticDecisionForEvidence` *regardless of the
   declared `result`*, `P2`/`P3` never do. This coupling was invisible to the
   reviewer before; it is the single most consequential thing a reviewer controls.
4. **Anchoring rule** — a blocking finding must name the construct in the current
   subject; otherwise downgrade or drop. (Own-words analogue of a quote-the-line
   gate, minus the confidence-anchor machinery, which has no representation in the
   3-field `parseFindings` shape.)
5. **Stable finding identity** — see below.
6. **Budget-native output** — `{severity, message, path}` only, ≤64 findings,
   `message` ≤2,000, ranked by severity because only the **first 10** are ever
   rendered downstream and the receipt hard-fails over 12 KiB.
7. Read-only posture made operational: do not re-run project commands; the
   executor's command receipts in prior evidence are the authority.

---

## `final-repair` — 118 lines

**Kept.** Exact-base repair worktree; sealed failure context only; one
`unit_completion` receipt; no direct mutation of the integration checkout; no
publishing; no gate authority.

**Dropped.**
- `ce-work mode:return-to-caller <final repair context supplied in the loop
  context>` — a mode token with a *description* rather than a path, which the
  pinned CE version itself classifies as an error path. Dropping it also removes
  the inherited incremental-commit behavior, the branch-rename ask, peer-worktree
  dispatch inside an executor-owned worktree, and the clarifying-questions
  mandate — none of which a 17-line adapter could hold back.
- The old file's "the whole-change repair budget is intentionally larger"
  editorial. It invites scope growth and states a manifest fact the agent cannot
  act on.

**Added.**
1. **The triggering review is the work list** — enumerate `payload.findings`
   before editing; resolve every `P0`/`P1`; bounded discretion on `P2`/`P3`; never
   invent a change for a finding that is not true at this subject. This is the
   OPE-64 gap: the receipt was already delivered as prior evidence, the skill just
   never said to use it.
2. **Supersession rule for resumed sessions** — this action's context policy is
   `resume_required`, so a repair session can remember round N-1's list. The
   prompt's receipt is authoritative for this round.
3. **No scope growth** — enumerated, including "do not weaken a test/assertion/
   safety check to close a finding" and the out-of-scope escape hatch
   (`issues` + `needs_human`) instead of silent widening.
4. **Trigger binding stated correctly (E3)** — explicit "do **not** copy the
   triggering review's `receiptHash` into `evidence`"; the link is carried
   deterministically by `fence.request_hash`, computed over the dispatched
   request's `priorEvidence`. `evidence` describes *this* action's outputs. This
   is the resolved-at-`origin/main` shape, so the skill now agrees with the code
   instead of contradicting it in either direction.
5. **Per-finding disposition** in `payload.verification`, reusing the review's
   identity string verbatim, with an explicit rule for >32 findings (the list cap).
6. `subject.post` via `ot-subject-post`, matching the sibling worker drafts
   (`implement-unit`, `repair-unit`) rather than describing the executor algorithm
   — see open question 3.
7. Budgets, fence/producer echo, `assurance` top-level, single-line JSON output.

---

## Finding-identity design (the churn killer)

**Problem.** The current dedup fingerprint is `normalize(file) + line_bucket(line)
+ normalize(title)`, computed across the reviewers *of a single run*. Two
consequences: (a) any repair that shifts lines re-issues an unfixed defect as a
*new* finding, and (b) there is no cross-round, cross-generation identity at all,
so no round can say "this one is already closed". Combined with per-run roster
re-selection, review→repair→review has no fixed point. OPE-91 paid 16 generations
for this.

**Design.** Identity is content-derived and rendered as a prefix of `message`,
because `parseFindings` accepts only `{severity, message, path}` — there is no
field to put an id in without a contract change:

```
[<repo-relative path>#<symbol, export, or nearest stable anchor>: <invariant violated>]
```

- **No line numbers**, anywhere in the identity. That is the specific property
  that makes the current key unstable.
- Same defect ⇒ byte-identical tag across rounds, even after reformatting or a
  symbol move. Different defects in one symbol differ in the invariant clause.
- `path` carries the file with no line suffix, so the machine-readable field stays
  stable too.
- `final-repair` echoes the tag verbatim in its per-finding disposition lines,
  which is what makes a round's outcome legible to the next review and to the
  operator reading the ledger.
- Paired round discipline: no new advisory findings on a re-review, and no
  re-reporting of a finding recorded as resolved unless it is demonstrably still
  present at the current subject.

**Why prefix-in-`message` and not a schema change.** It ships with zero contract
churn and survives the 12 KiB seal (~60–100 bytes per finding). If the contract
later gains a `finding_id`, the same string moves there unchanged.

---

## Test / CI impact (would need updating when these land in `skills/`)

`sandbox/tests/ce-adapters.test.mjs` asserts skill *contents*. Three assertions
fail against these drafts, all because the CE tokens are gone by design:

- `expect(skillBody("accept-unit")).toContain("Do not invoke \`ce-code-review\`")`
- `expect(skillBody("final-review")).toContain("ce-code-review")`
- `expect(skillBody("final-review")).toContain("mode:agent")`

Deliberately preserved so the rest keeps passing: `unit_decision`,
`not a code review`, `integrated whole`, `report-only`, `final-repair`,
`exact-base repair worktree`, `unit_completion`, the `---` frontmatter with
`name:`/`description:`, and the absence of `apply:local`. The `ce-*`-tokens-resolve
check is unaffected (removing tokens cannot break it).

---

## Open questions

1. **`final-review` cannot see prior rounds today, so the anti-churn rule is
   inert on the review side.** `priorEvidenceForAction` gives `final_review` only
   `final_command` receipts, and `execute-loop.mjs` *rejects* any non-`final_command`
   entry for that role; the binding is `contextPolicy: fresh`, so there is no
   session memory either. The draft is written conditionally ("when the prompt
   carries an earlier round's findings"). To make it bite, the executor must
   include the previous `semantic_review` and the intervening `final_repair`
   `unit_completion` in `final_review` prior evidence (bounded), and the loop-side
   role check must allow them. Recommend doing this with the drafts.
2. **Bind lead/final-review evidence deterministically instead of by prose.** E3's
   fix shape (request-hash binding) already exists for `final_repair`. Until the
   same is applied to lead and review, these two receipts depend on an agent
   copying 64-hex strings correctly — the drafts make that as mechanical as prose
   can, but it is still the weakest link in the family.
3. **`ot-subject-post` does not exist yet.** All three worker-family drafts
   (`implement-unit`, `repair-unit`, `final-repair`) now instruct "run
   `ot-subject-post` and copy its output", and `final-repair` says to stop rather
   than guess if it is missing. That makes the family blocked on shipping the
   helper (or executor-side stamping). The executor algorithm is
   `read-tree HEAD` → `add -A -- .` → `write-tree` in a private index; the
   resulting oid is content-only, so a prose recipe *would* work, but per E2 a
   helper is the right instrument. Decide once, family-wide.
4. **Is `subject.base` resolvable inside the review's read-only view?** The draft
   tells `final-review` to diff `subject.pre` against `subject.base`. The view is
   built by packing objects reachable from the integration `HEAD`, which should
   include the base commit — but some subjects in this system are *tree* oids
   rather than commits, and `git diff <tree> <tree>` behaves differently from a
   commit-range diff. Worth one live check before merge; if it does not resolve,
   the alternative is exporting `BASE_BRANCH` (or a base sha) through
   `loop-agent-environment.mjs`.
5. **Delivery is still unobservable (E4/C8).** A skill that cannot be read exits 0
   and is scored as a clean run. None of these rewrites can be validated in
   production until the readability preflight and the `Unknown command: /` launch
   classification land.
6. **`accept-unit` cannot verify a `context_updates` target.** The plan context
   contains only *this* unit, so the lead cannot see which units declare it as a
   dependency — yet an invalid target aborts the action. The draft's answer is
   "leave it empty unless you can verify", which is safe but makes the field
   nearly unusable. Consider including the unit's declared dependents in
   `loopActionPlanContext`.
7. **Where does per-round finding disposition get persisted?** Today the
   disposition lives only in a `unit_completion.verification` list. If the ledger
   or the next review is meant to consume it, it likely wants a first-class
   representation rather than a formatted string.
