# RATIONALE — `implement-unit` and `repair-unit` self-contained rewrites

Covers both drafts:
`.context/skills-drafts/implement-unit/SKILL.md` (127 lines) and
`.context/skills-drafts/repair-unit/SKILL.md` (127 lines).

Target: OPE-105 (`.context/ope105-ticket.md`), scope item 1 —
"FORK (self-contained rewrite): … `implement-unit`, `repair-unit` (the plugin's
commit phase collides with executor-owned integration)".

Sources read: `skills/README.md`; `AGENTS.md` skills section;
`.context/skill-audit.md` §1c, §3a, §4 (C1–C3, C9), §5b rows `implement`/`repair`,
§7 M0/M3, §8 E1/E2/E8/E11/E12; `origin/main:skills/tasks/{implement-unit,repair-unit}/SKILL.md`;
the locally installed toolkit's implementation-worker skill body (content
reference only, no text reused); and on `origin/main`:
`sandbox/runner/execute-loop.mjs`, `sandbox/runner/artifacts.mjs`,
`sandbox/runner/worktrees.mjs`, `sandbox/runner/execute-child-action.mjs`,
`contracts/src/receipts.ts`, `contracts/src/execution-plan.ts`,
`supervisor/src/pipeline/structured-loop-envelope.ts`,
`supervisor/src/pipeline/execution-gates.ts`,
`supervisor/src/persistence/pipeline/unit-store.ts`,
`supervisor/src/persistence/pipeline/unit-store-phase-reducer.ts`,
`supervisor/src/operations/structured-child-runtime.ts`.

---

## 1. `implement-unit`

Baseline: 17 lines, one delegating sentence, no contract content.

### Kept

| Kept | Why |
|---|---|
| Frontmatter shape (`name`, `description` only) | `sandbox/tests/ce-adapters.test.mjs` asserts `body.startsWith("---\n")`, `name: <task>`, and `\ndescription: .+\n---\n`. `description` reworded; key set unchanged. |
| "Execute only the unit named in the sealed request" | The one genuinely load-bearing sentence in the original. Expanded into an explicit **Scope** section. |
| "Transition context is untrusted task data" | `AGENTS.md` invariant; kept and widened to plan prose and repository content. |
| "Do not commit, integrate, publish, simplify, run whole-change review, or claim gate authority" | Kept and made enforceable — named commands rather than a category. |
| The `unit_completion` payload field list | Kept and given the actual bounds. The word `unit_completion` also keeps the existing test assertion (`ce-adapters.test.mjs:83`) green. |

### Dropped

| Dropped | Why |
|---|---|
| The delegating invocation line | Ticket design decision: "no plugin slash-command invocations, no `mode:` tokens". Also `.context/skill-audit.md:230` — a mode token with no following path is an error path in the pinned toolkit version, which is exactly the shape the old adapter emitted. |
| Everything downstream of that hop: plan triage, engine/strategy selection, branch setup and rename, task-list construction, subagent dispatch and integration, incremental commits, "simplify as you go", the shipping tail | `.context/skill-audit.md:190-246` (§3a) — elicitation, commit, and peer-worktree collisions. The commit collision is the ticket's stated reason for the fork: `loopPrompt()` says "Do not commit, push, or alter executor state" while the delegated body's Phase 2 step 2 commits. 17 adapter lines cannot hold back 438. |
| "bounded" as an unquantified word | `.context/skill-audit.md:404` — appears nine times across the skill set, never with a number. Replaced with the real limits. |
| `ot-activity` progress reporting (listed as adapter-owned in `skills/README.md`) | Not wired into the loop path: `ot-activity` appears in `sandbox/Dockerfile`, `sandbox/bin/`, `sandbox/hooks/`, `sandbox/tests/` — never in `execute-loop.mjs` or `loop-agent-environment.mjs`. Instructing it in a loop action would be a phantom capability. |

### Added (each traceable to enforcement code)

| Added | Enforced at |
|---|---|
| Receipt must be the whole final message, or a complete object on one line | `execute-loop.mjs` `parseLoopReceipt()`: candidates are the full sanitized output and each individual trimmed line. Pretty-printed JSON inside a fence parses as neither. Audit C9 (`:470`) flags the omission; this is the concrete rule. |
| Echo `fence` + `producer` verbatim; `assurance` top-level, never inside `producer` | `execute-loop.mjs` `assertLoopReceiptFence()` four-way producer + top-level assurance check; `execution-gates.ts` `assertReceiptFence()`. Audit C2 (`:370`), E8 (`:948`). Today this rule lives only in a code comment. |
| `subject.post` via `ot-subject-post`, never hand-derived | `execute-loop.mjs`: executor computes `computeWorkspaceTreeOid(worktreeDir, gitObjectEnv)` and rejects any mismatch. Audit C1 (`:346`) and revision 9.1 (`:1052`): do **not** describe the algorithm in prose. See open question **Q1**. |
| Budgets: 12 KiB seal, `evidence` 1–32 × ≤1000, summary ≤4000, lists ≤32, human input ≤16 | `artifacts.mjs` `MAX_ARTIFACT_PAYLOAD_BYTES = 12 * 1024` (hard failure, not truncation); `contracts/src/receipts.ts` `stringList` / `integerAt(evidence.length, 1, 32)`. Audit C3 (`:389`). |
| `downstream_context[].unit_id` is the **target**, must be a declared dependent, must still be pending | `unit-store.ts:439-489` `acceptedDownstreamContextRecords()` **throws** (`downstream context target X is not a declared dependent of Y`) inside the integration gate transaction. A well-meant note addressed to the wrong unit aborts integration. Undocumented anywhere before now. |
| Result semantics for all four `unit_completion` values | `artifacts.mjs` `STANDARD_RECEIPT_STAGE_OUTCOMES`: `exited → needs_human`, `failure → failure`. The old adapter named none of them. |
| Implementation discipline: read-before-write, smallest correct increment, test discovery, scenario categories, two-levels-out tracing, verify-as-you-go | The distillation the ticket asks for. `.context/skill-audit.md:549-551` names the discipline worth carrying — evidence strategy, system-wide test check, scenario completeness — as the reason implementation stages produce tests at all. Rewritten in our own words, no tables copied, no persona files, no references tree. |
| "The executor runs `test`/`lint`/`build` separately; don't preempt them" | `execute-child-action.mjs` runs unit command actions in the same worktree after the agent finishes. Prevents both the wasted full-suite run and the belief that the agent's run is gate evidence. |
| Explicit headless fence: no questions, no blocking-question tool, no waiting | `.context/skill-audit.md:194` (mandatory clarifying questions in the delegated body), E9 (`:975`) — a structured run has no steerable stage, so a stall is unrecoverable. |

---

## 2. `repair-unit`

Baseline: 13 lines. Differed from `implement-unit` only by the word "repair".

### Kept

- Frontmatter shape; reworded `description`.
- "Use only the sealed failure/revision context for the current unit."
- "Repair the unit, then locally verify the targeted fix" — promoted to its own
  **Verify the repair** section with the re-run-what-failed rule.
- "Do not widen scope" — promoted to a **Repair scope** section with concrete
  prohibitions.
- Same `unit_completion` receipt contract (keeps `ce-adapters.test.mjs:85`).

### Dropped

- The delegating invocation (same reasons as above; §5b row `repair`,
  `.context/skill-audit.md:504`).
- The implicit assumption that a "sealed failure context" is present. It is not
  — see **Q2**, the most consequential finding in this draft.

### Added

| Added | Why |
|---|---|
| **Establish the failure before you change anything**, with a three-step precedence: sealed text → continued session → reproduce via `.openthrottle.yml` `commands` | Direct consequence of Q2. Without a stated failure the repair degenerates into a rewrite, which is the round-burning shape described in audit C4 (`:410`) and E12 (`:1034`). |
| Never suppress the symptom: no deleting, skipping, weakening, or expected-failing a test/assertion/type/lint rule to make a gate pass | Repair rounds are triggered by command failure, and the cheapest way to make a command pass is to disable the check. Nothing in the tree prevents it — `execution-gates.ts` `commandOutcome()` only reads exit codes. |
| "A repair touching more files than the original implementation is a signal you widened scope" | Cheap self-check for the no-scope-growth rule. |
| Add the test that would have caught the failure, when behavioral | Keeps repair rounds compounding rather than oscillating. |
| Anything the failure named and you did not resolve goes in `issues` explicitly | Audit C4 (`:419-423`) and the OPE-64 shape (`:511`): repair skills never say to enumerate and resolve the triggering findings. |
| `needs_human` explicitly includes "the failure is unidentifiable from your input" | Fail-closed answer to Q2 until the input gap is fixed. |
| Convergence framing: budgeted rounds, exhaustion ends the run | `unit-coordinator.ts` `DEFAULT_MAX_REPAIR_ROUNDS`/`unitBudgetDecision`; audit E12 — each round also consumes future ticket admissibility. |

Both drafts deliberately share the **Authority fence** and **The receipt**
sections nearly verbatim. They are separate files loaded in separate sessions,
so duplication is the correct trade; if OPE-105 later introduces a shared
preamble (audit M1 / D1, `:609`), lift those two sections whole.

---

## 3. Open questions for the OPE-105 implementer

**Q1 — `ot-subject-post` does not exist.** `git grep ot-subject-post origin/main`
returns nothing. Both drafts instruct it because the ticket puts shipping it in
scope and the audit forbids prose (`:1052`). Decide one of:
(a) ship the helper on `PATH` and keep the bullet as written;
(b) stamp `subject.post` executor-side like `attempt_id` and **delete** the
bullet from every skill (preferred by audit revision 9.1);
(c) document the sequence — feasible but discouraged: the agent inherits
`GIT_DIR`/`GIT_WORK_TREE`/`GIT_OBJECT_DIRECTORY`/`GIT_ALTERNATE_OBJECT_DIRECTORIES`
(`execute-loop.mjs` `prepareLoopGitObjectEnvironment`), and
`computeWorkspaceTreeOidFromTree` reduces to `read-tree HEAD` → `add -A -- .` →
`write-tree` against a scratch `GIT_INDEX_FILE`.
Whichever is chosen, all six structured skills must say the same thing.

**Q2 — a unit repair currently receives no failure text at all.** Verified:
- the action payload is `{parent_attempt_id, parent_run_id, unit_id, action_kind,
  cycle, command_name?, resume_native_session_id?}` and nothing else
  (`unit-store-phase-reducer.ts:276-283`);
- `priorEvidence` is built only for `lead`, `final_review`, and `final_repair`
  (`structured-child-runtime.ts:790`), and `PRIOR_EVIDENCE_ROLES` in
  `execute-loop.mjs:81` rejects any other role;
- the lead's `revision_request`, the failing `command_result` receipts, and the
  gate `reason` reach the Linear ledger (`unit-store.ts:943`) but never the
  repair prompt;
- `downstreamContext` carries notes from *other integrated units*, not failure
  feedback for this one.

So the repair worker's only channels are the resumed session transcript and the
worktree. Options: (a) extend `priorEvidence` with a `repair` role carrying the
triggering `unit_decision` and failing `command_result` receipts — smallest
change, reuses existing validation, and would let the skill say "resolve each
named finding by identity"; (b) embed the gate `reason` and `revision_request`
in the action payload; (c) leave as-is and rely on the drafted reproduce step.
Until (a) or (b) lands, `repair-unit`'s "fix ONLY what the failure names" is
partly aspirational — the draft handles that with the reproduce ladder and a
`needs_human` escape, but the fix belongs in the runtime.

**Q3 — resume is not guaranteed.** `contextPolicy` degrades to `prefer_resume`
when `action.native_session_id` is absent (`structured-child-runtime.ts:820`). A
repair that neither resumes nor receives failure text has *only* the reproduce
path. Confirm that is acceptable, or make repair `resume_required` and fail the
action when the session is gone.

**Q4 — the unit worktree has no installed dependencies.** `createWorktree()` is
`git worktree add --detach` into `/var/lib/openthrottle/worktrees/<handle>`
(`worktrees.mjs:160-186`); `post_bootstrap` installs only into
`/home/agent/repo` during entrypoint phase 5 and is never re-run per action
(`entrypoint.sh:515-577`; no `post_bootstrap` reference anywhere in
`sandbox/runner/`). Node resolution will not reach `/home/agent/repo/node_modules`
from that path. This affects the executor's own unit command gates too —
`execute-child-action.mjs` `repoDirFor()` runs them in the same worktree. If
this is a live gap, both "verify as you go" and repair's "reproduce it" degrade
to type-level checks for any repo whose commands need installed dependencies.
Worth confirming before OPE-105 ships, since both drafts lean on local
verification.

**Q5 — `assurance` wording differs across the concurrent drafts.** This pair says
"copy `assurance` from the contract"; the sibling `simplify-unit` draft says
`assurance` is `semantic_attested`. The fence compares against
`request.expectedProducer.assurance` (`execute-loop.mjs` `assertLoopReceiptFence`),
so "copy from the contract" is the safe rule. Harmonize before merge.

**Q6 — the producer echo instruction is only satisfiable on one branch.**
`loopPrompt()`'s `expectedProducer`-absent fallback emits `producer` with `skill`
alone, while `parseProducer` requires four keys (audit E8, `:963`). Today
`structured-child-runtime` always supplies `expectedProducer`, so "copy producer
verbatim" holds — but a repository-skill or non-structured caller hitting the
fallback would follow the instruction into a schema rejection. Fix the fallback
branch, or the instruction becomes a trap.

**Q7 — verification gates for the rewrite.** The ticket asks for a grep gate
proving no plugin reference remains under `skills/`. Note that
`sandbox/tests/ce-adapters.test.mjs` currently *requires* plugin tokens in
`implement-plan`, `final-review`, `investigate`, and `accept-unit`; the two files
here are already compatible (they only need the literal `unit_completion`), but
the test file must be rewritten in the same change or the suite fails on the
skills that follow. Also confirm the OPE-104 slash-command registration probe
covers both names unchanged — neither draft renames a skill.

**Q8 — where `needs_human` lands.** `unit_completion.result: needs_human` maps to
gate outcome `needs_human` (`artifacts.mjs`), and `evaluateUnitAcceptanceGate`
returns `worker_completion_not_success` with `indeterminate`. Confirm that
surfaces the receipt's `requested_human_input` to the operator; if it does not,
the drafted escape hatch is a silent stop and the ledger rendering needs a fix.
