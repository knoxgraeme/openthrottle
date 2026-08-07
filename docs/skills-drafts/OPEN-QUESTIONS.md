# OPEN-QUESTIONS — consolidated for the OPE-105/OPE-106 runtime ticket

Consolidated from the four per-family RATIONALEs after the harmonization pass.
Everything here is a **runtime/code decision**, not a skill-text decision: the
eleven `SKILL.md` drafts are now internally consistent and match `origin/main`,
so nothing below blocks reading them — each one blocks a behaviour the text
either assumes or deliberately avoids assuming.

Verified at `origin/main` unless stated.

---

## Blocking (the drafts assume a resolution)

### Q1 — `ot-subject-post` does not exist
`git grep ot-subject-post origin/main` returns nothing; `sandbox/bin/` holds
only `ot-activity.mjs` and `ot-stage-result.mjs`. Four drafts
(`implement-unit`, `repair-unit`, `simplify-unit`, `final-repair`) instruct
"run `ot-subject-post` from the worktree root and copy its output". Each
carries the marker `<!-- OPE-106 ships \`ot-subject-post\`; this wording is
fixed until it lands. -->`.

Decide one of:
- **(a) Ship the helper** on `PATH` inside the loop action environment. The
  executor's own computation is `computeWorkspaceTreeOidFromTree`
  (`sandbox/runner/repository-control.mjs:154-199`): `read-tree HEAD` →
  `add -A -- .` → `write-tree` against a private `GIT_INDEX_FILE`, run from the
  worktree root. The helper must inherit the action's
  `GIT_DIR`/`GIT_OBJECT_DIRECTORY`/`GIT_ALTERNATE_OBJECT_DIRECTORIES`
  (`prepareLoopGitObjectEnvironment`). Keep the four bullets as written.
- **(b) Stamp `subject.post` executor-side** and delete the bullet from all
  four skills, replacing it with the read-only form already used by
  `accept-unit`/`final-review`.

Do **not** describe the algorithm in prose in the skill. Whichever lands, all
four files change identically — they currently carry byte-identical wording.

### Q2 — a unit repair receives no failure text at all
`repair-unit`'s "fix only what the failure names" is partly aspirational today.
Verified:
- the repair action payload is `{parent_attempt_id, parent_run_id, unit_id,
  action_kind, cycle, command_name?, resume_native_session_id?}` and nothing
  else (`unit-store-phase-reducer.ts`);
- `priorEvidence` is built only for `lead`, `final_review`, `final_repair`
  (`structured-child-runtime.ts` `priorEvidenceForAction`), and
  `PRIOR_EVIDENCE_ROLES` in `execute-loop.mjs:81` rejects any other role;
- the lead's `revision_request`, the failing `command_result` receipts, and the
  gate `reason` reach the Linear ledger but never the repair prompt;
- `downstreamContext` carries notes from *other integrated units*, not failure
  feedback for this one.

Options: (a) add a `repair` prior-evidence role carrying the triggering
`unit_decision` and failing `command_result` receipts — smallest change, reuses
existing validation, and lets the skill say "resolve each named finding by
identity"; (b) embed the gate `reason` and `revision_request` in the action
payload; (c) leave as-is and rely on the drafted reproduce ladder. The draft is
already fail-closed for (c): a repair that cannot state the failure returns
`needs_human`.

### Q3 — `final-review` cannot see prior rounds, so its anti-churn rule is inert
`priorEvidenceForAction` gives `final_review` only `final_command` receipts, and
`execute-loop.mjs` *rejects* any non-`final_command` entry for that role
(`"contains non-final-command evidence for final review"`). The binding is
`FINAL_REVIEW_BINDING` (`kind: gate`, no `context`), so there is no session
memory either. The draft's "do not re-report a resolved finding" and "add no new
advisory finding on a re-review" paragraphs are written conditionally ("when the
prompt carries an earlier round's findings"). To make them bite, include the
previous `semantic_review` and the intervening `final_repair` `unit_completion`
in `final_review` prior evidence (bounded), and relax the loop-side role check.
Recommend landing this with the drafts — it is the mechanism the whole stable
finding-identity design exists to serve.

### Q4 — skill selection must become capability-keyed
`sandbox/runner/execute-stage.mjs:396`:
```js
const skillName = request.taskType === "investigate" ? "investigate" : "implement-plan";
```
Selection is by **task type**, not capability. Consequences at `origin/main`:
the tracked `skills/tasks/publish/SKILL.md` is never loaded on the stage path
(nothing else selects it; the `publish` graph node compiles to an *agent stage*,
not a loop action), and the two new drafts `review-change` and `simplify-change`
are unreachable until this line becomes a `capability → skill` map:

| Capability | Skill |
|---|---|
| `ce/implement@1` | `implement-plan` |
| `ce/review@1` | `review-change` |
| `ce/simplify@1` | `simplify-change` |
| `ce/publish@1` | `publish` |
| `ce/investigate@1` | `investigate` |

Pair with the delivery preflight (Q10) or the split fails green.

### Q5 — publish does not re-assert the fenced subject
`execute-stage.mjs` checks `request.expectedSubject` only against `preSubject`
at stage start. After the agent runs, `gatedSubject = computeWorkspaceTreeOid()`
is recomputed and used as the artifact subject with **no** comparison back to
`request.expectedSubject`. A post-gate commit therefore does not fail the local
fence — it silently redefines the shipped subject to a tree no gate ran against.
The `publish` draft forbids this in prose ("Write no file inside the repository
in this stage"); the durable fix is one assertion `gatedSubject ===
request.expectedSubject` for `ce/publish@1`. File regardless of which skill text
lands.

### Q6 — `sandbox/tests/ce-adapters.test.mjs` must be rewritten in the same change
21 assertions break by design (full list in `REVIEW.md` §4). The new skills also
need their own coverage. Note the planned "no plugin references under `skills/`"
grep gate must use a word boundary (`\bce-[a-z][a-z-]*[a-z]\b`, as the existing
test does): a naive `grep ce-` matches `force-push` in `publish/SKILL.md`.

### Q7 — `agents/openai.yaml` for the new skills
`ce-adapters.test.mjs` asserts every task ships
`skills/tasks/<task>/agents/openai.yaml` containing
`allow_implicit_invocation: false`. The drafts add two names (`review-change`,
`simplify-change`) with no `agents/` directory. Both need one for the
`/etc/codex/skills` admin-scope bake. OpenCode inlines the body into the prompt,
so three more skills means three more prompt bodies against the engine context
budget (bodies are 111–142 lines each).

---

## Non-blocking (decide before or shortly after landing)

### Q8 — the `producer` echo instruction is satisfiable on only one branch
`loopPrompt()`'s `expectedProducer`-absent fallback emits `producer` with `skill`
alone, while `parseProducer` (`contracts/src/receipts.ts:194`) requires all four
keys. Today `structured-child-runtime` always supplies `expectedProducer`, so
"copy `producer` verbatim" holds — but a repository-skill or non-structured
caller hitting the fallback would follow the instruction into a schema
rejection. Fix the fallback branch or the instruction becomes a trap.

### Q9 — bind lead/final-review evidence deterministically instead of by prose
`assertEvidenceBinding` requires the lead receipt to carry
`[completionHash, candidateHash, ...commandHashes]` and the review receipt to
carry every `final_command` hash. The request-hash binding already used for
`final_repair` (`priorEvidenceForAction` → `fence.request_hash`) would remove
the dependency on an agent copying 64-hex strings correctly. Until then the
`accept-unit`/`final-review` echo sections are the weakest link in the family.
(Note the branch skew: `origin/main` requires `[completion, candidate,
…commands]`; `operator-staging-sync` requires `[candidate, …commands]`. The
drafts say "every entry in `## Prior Evidence`", which satisfies both.)

### Q10 — delivery is still unobservable
A skill that cannot be read exits 0 and grades as a clean run. None of these
rewrites can be validated in production until the readability preflight and the
`Unknown command: /` launch classification land.

### Q11 — resume is not guaranteed for repair
`contextPolicy` degrades to `prefer_resume` when `action.native_session_id` is
absent. A repair that neither resumes nor receives failure text (Q2) has *only*
the reproduce path. Confirm that is acceptable, or make repair
`resume_required` and fail the action when the session is gone.

### Q12 — unit worktrees have no installed dependencies
`createWorktree()` is `git worktree add --detach` into
`/var/lib/openthrottle/worktrees/<handle>`; `post_bootstrap` installs only into
`/home/agent/repo` during entrypoint phase 5 and is never re-run per action.
Node resolution will not reach `/home/agent/repo/node_modules` from the worktree
path. This affects the executor's own unit command gates too
(`execute-child-action.mjs` `repoDirFor()`). If it is a live gap, "verify as you
go" (`implement-unit`) and "reproduce it" (`repair-unit`) degrade to type-level
checks for any repo whose commands need installed dependencies.

### Q13 — scope detection inside the sealed git environment
`simplify-unit` equates the unit's change set with `git diff HEAD` +
`git status --porcelain` in the worktree. Verify both behave as expected for the
`agent` user under `prepareLoopGitObjectEnvironment` (root-owned `GIT_DIR` admin
dir, index read-tree'd at HEAD, split object dirs). If not, substitute the exact
invocation that does, or have the executor write the change list into the action
directory.

### Q14 — `accept-unit` cannot verify a `context_updates` target
`loopActionPlanContext` carries only *this* unit, so the lead cannot see which
units declare it as a dependency — yet an invalid target throws inside the
integration transaction (`unit-store.ts` `acceptedDownstreamContextRecords`).
The draft's answer is "leave it empty unless you can verify", which is safe but
makes the field nearly unusable. Consider including declared dependents in the
plan context. The same gap applies to `downstream_context` in
`implement-unit`/`repair-unit`.

### Q15 — where `needs_human` lands
`unit_completion.result: needs_human` maps to gate outcome `needs_human`
(`artifacts.mjs` `STANDARD_RECEIPT_STAGE_OUTCOMES`), and
`evaluateUnitAcceptanceGate` returns `worker_completion_not_success` with
`indeterminate`. Confirm the receipt's `requested_human_input` surfaces to the
operator; if it does not, the drafted escape hatch is a silent stop.

### Q16 — push authorization is not capability-scoped
`sandbox/safety/enforce-stage-push-policy` allows a push for any valid context
policy; only main/master and non-fast-forward are blocked. "Only `publish`
pushes" is skill text, not a fence. Consider deriving the policy from the stage
capability.

### Q17 — `ce/plan@1` is unbound
Declared in `sandbox/runner/capabilities.mjs` and
`supervisor/pipelines/runtime-capabilities-v1.json`, bound by no manifest and no
graph node. Either bind it or drop it; no skill was drafted for it.

### Q18 — fork vs. thicken for `publish`
The audit recommends THICKEN for `publish` and for `implement-plan`'s implement
branch. These drafts fork all five stage skills. The drafts cover duplicate-PR
and `--body-file` correctness; they do **not** cover cross-repository/fork PR
bases, which OpenThrottle may never hit (registered repos push their own
branches). Decide explicitly before landing.

### Q19 — "report-only" for `investigate`
Read as *output* report-only: the stage still applies convergent fixes, because
`core/investigate@1` routes `investigate → publish` and a strictly report-only
stage would leave publish an empty subject (terminal `no_change`). If report-only
was meant literally, the manifest needs a decision stage or the publish edge
needs to become conditional-on-diff.

### Q20 — simplify repeat rounds and per-round disposition persistence
`simplify-loop` allows `max_rounds: 3`; nothing in `simplify-unit` distinguishes
a second pass from the first. Separately, `final-repair`'s per-finding
disposition lives only in a `unit_completion.verification` string list. If the
ledger or the next review is meant to consume it, it wants a first-class
representation rather than a formatted string.
