# simplify-unit rewrite — rationale

Draft target: `skills/tasks/simplify-unit/SKILL.md` (OPE-105, audit step M2).
The draft is self-contained: no plugin reference, no second-hop skill
invocation, no `mode:` token, no verbatim upstream prose. Frontmatter `name` and
`description` are byte-identical to `origin/main` so delivery mechanics
(entrypoint copy, Dockerfile bake, OpenCode frontmatter strip, the OPE-104
registration probe) are untouched.

Shape: 119 lines — role, session shape, scope pin, three lenses, guardrails,
receipt contract. Contract text is ~40% of the body; craft text is ~40%.

## Kept from the upstream simplification skill (by concept, reworded)

1. **Behavior preservation as the premise, checked per edit** — same output per
   input, same error paths, same side effects and ordering, same public surface;
   skip anything that cannot clear it.
2. **Three review lenses**: reuse, quality/clarity, efficiency. Their specific,
   genuinely useful heuristics were reworded and compressed: existing-helper and
   stdlib duplication, near-duplicate blocks, derivable state, parameter sprawl,
   leaky boundaries, stringly-typed code, deep conditional nesting, change-
   narrating comments, dead code and unused imports/exports, repeated work,
   sequentialized independent work, hot-path additions, unbounded growth,
   over-broad reads.
3. **The over-simplification counterweight** — fewer lines is not the goal;
   don't inline a helper that names a concept, don't merge unrelated logic,
   don't remove a testability/extension seam whose purpose you haven't
   confirmed obsolete, don't ship a change that reads worse.
4. **Never simplify away a safety property** — trust-boundary validation, error
   handling that prevents data loss, authz/escaping/sanitization, accessibility.
   This is the single most valuable line in the upstream skill.
5. **Behavior-equivalence caveat on stdlib swaps** — locale-sensitive
   formatting, sort stability, serialization edge cases.
6. **Skip false positives without argument**, and **report by dimension rather
   than by lines removed**.
7. **Honest verification reporting** — if nothing was run, say so; never claim a
   check that did not happen.

## Dropped, with the audit finding that justifies it

- **The mandatory blocking question on empty scope.** Audit §3c and the §6
  verdict: the upstream skill has *no non-interactive mode at all* and says
  "never silently skip the question". A sealed `--print` session has no user, so
  this is a stall. Replaced by: scope is always non-empty by construction (the
  worktree diff), and an empty diff is a successful no-edit pass.
- **The branch-diff scope default.** Audit §3c: in a unit worktree the branch
  base is not the unit boundary, and the old 12-line adapter passed no argument
  at all, so upstream scope resolution and the adapter's "keep edits scoped to
  the current unit" disagreed. Replaced by an explicit pin to the worktree's
  uncommitted change set.
- **The three-subagent parallel dispatch, model-override guidance, and the
  "omit the `mode` parameter" instruction.** Audit §3c and §5b (collision class
  W): subagent/worktree dispatch inside a sealed loop action is unbounded, can
  create harness-isolated worktrees inside the executor's worktree, and adds
  prompt cost with no fence. The lenses are applied inline in one pass.
- **Full-project typecheck and lint in the verification step.** Audit §3c and
  §5b (G/S): that pre-empts the executor-owned `command` phase, which runs
  `test`/`lint`/`build` against this exact worktree in the very next phase
  (`supervisor/graphs/structured-v1.json`, `units` node phases).
- **User-named-scope handling and the interactive/pipeline branching** — no
  user exists; the sealed request is the only scope authority.
- **The plugin hop itself.** Audit §1c: the second hop was unenforced (nothing
  verifies the delegated skill ran; the fence only checks `producer.skill`), and
  §6 rates `simplify-unit` **FORK-NATIVE, highest priority**. M2 also notes that
  after this fork the upstream simplification skill is unreferenced.

## Added from the pipeline contract (none of it was in the old adapter)

Sources are `origin/main`.

- **Receipt shape and field-by-field echo discipline** (audit C2). The
  Receipt Authority Contract payload is built in
  `sandbox/runner/execute-loop.mjs` `loopPrompt()` (~:518-566); the draft names
  which contract keys map to `producer`, `subject`, and the nine `fence` keys,
  and says the contract's other keys (`graph_id`, `assurance`, `evidence`,
  `prior_evidence`, `downstream_context_hash`) are not fence fields.
  `sandbox/runner/artifacts.mjs` `validateStandardReceipt` (~:337-346) enforces
  exact key sets on `producer`, `subject`, and `fence`.
- **`assurance` is top level, never inside `producer`.** Today this warning
  exists only as a code comment inside `loopPrompt()` (audit C2); the draft
  moves it into the text the model reads.
- **`subject.post`** (audit C1/E2). `execute-loop.mjs:1182` computes the
  workspace tree OID itself and `:1066` rejects any receipt whose `post`
  differs; the algorithm is not reproducible from prose. Per M0/M1 the draft
  says: run the executor's `ot-subject-post` helper and copy its output, never
  hand-compute. See OQ1 — the helper does not exist yet.
- **`result` must be `success`.** `supervisor/src/pipeline/execution-gates.ts`
  `evaluateUnitAcceptanceGate` fails the unit when `completion.result !==
  "success"`, and when a simplify phase ran, *the simplify receipt is that
  completion receipt* (`structured-child-runtime.ts` `expectedProducersFor`,
  `completionProbe`). So "nothing to simplify" must be `success` with an
  explanatory summary. Note this corrects M2's wording: `unit_completion` has no
  `no_change` result (`artifacts.mjs:40`) — only `semantic_review` does.
- **Evidence minimum and binding.** `contracts/src/receipts.ts:393` requires
  1-32 entries; `artifacts.mjs:359` caps each at 1,000 chars. The draft binds
  evidence to this action's own outputs, matching the contract's own sentence.
- **Output budgets** (audit C3): 12 KiB sealed payload — a hard stage failure,
  not truncation (`artifacts.mjs:70`, `:449`); `summary` 4,000; lists 32 x
  1,000; `requested_human_input` 16; `downstream_context` summaries 2,000
  (`artifacts.mjs:172-186`, `:133-142`); only the first entries render
  downstream.
- **All seven payload keys, with the required ones called out.**
  `receiptPayload` rejects unknown keys and throws on a missing `summary` or
  `downstream_context` (`boundedContextRecords` rejects `undefined`).
- **Where the result goes** (audit C9): one single-line JSON object as the final
  output, no fence or prose. `parseLoopReceipt` scans the whole trimmed output
  and then each line in reverse; a pretty-printed object inside a markdown fence
  is not reliably recoverable.
- **Git/state prohibitions**, expanded from `loopPrompt()`'s one sentence into
  the specific verbs that would destroy the unit (`checkout`, `stash`, `reset`)
  or pre-empt executor-owned integration (`commit`, `push`, `branch`,
  `worktree`).
- **Credential reality**: the simplify worker holds only `model.invoke` and
  `repo.read` (`supervisor/graphs/structured-v1.json`), so no provider or
  publication work is possible; the draft states read-only model+repo access.

## Deliberately not added

- **The prior-receipt evidence-hash echo (audit C7/E1).** It applies to
  `accept-unit` and `final-review` only; `priorEvidenceForAction`
  (`structured-child-runtime.ts`) supplies prior evidence for `lead`,
  `final_review`, and `final_repair` — a simplify action receives the empty
  default, so instructing it to echo prior hashes would be unsatisfiable.
- **Activity narration.** Loop actions rebuild their environment from a narrow
  passthrough allowlist; publishing progress is not part of this action's
  contract and would add unbounded output against a 12 KiB seal.

## Open questions for the OPE-105 implementer

1. **`ot-subject-post` does not exist.** `sandbox/bin/` contains only
   `ot-activity.mjs` and `ot-stage-result.mjs`. Either ship the helper (audit
   M0) or stamp `subject.post` executor-side like `attempt_id`. The draft's
   `subject.post` bullet must be rewritten to match whichever is chosen; as
   written it assumes the helper exists and is on `PATH` in the worktree.
2. **Scope-detection wording is the riskiest sentence in the draft.** It equates
   the unit's change set with `git diff HEAD` + `git status --porcelain` in the
   worktree. Verify that under the sealed git environment
   (`prepareLoopGitObjectEnvironment` sets `GIT_DIR` to a root-owned admin dir
   with the index read-tree'd at HEAD, plus split object dirs) both commands
   behave as expected for the `agent` user; if not, substitute the exact
   invocation that does, or have the executor write the change list into the
   action directory.
3. **How hard is the no-command rule?** The draft forbids the repository's
   configured `test`/`lint`/`build` and pushes toward establishing equivalence
   by reading, but does not ban all execution. If a strict zero-execution rule
   is wanted, tighten one sentence — accepting lower behavior-preservation
   confidence on non-obvious edits.
4. **Graph binding names.** `structured-v1.json` still binds the simplify phase
   to `builtin://ce/simplify@1`, and `producer.skill` is derived from that
   binding. The draft is insensitive to the name (it says "copy `producer`
   verbatim"), but the planned grep gate for plugin references and any binding
   rename are decisions outside `skills/`.
5. **Repeat rounds.** `simplify-loop` allows `max_rounds: 3`. Nothing in the
   draft distinguishes a second simplify pass from the first. If re-entry is
   reachable in practice, consider one line telling a repeat pass not to
   re-litigate edits it already rejected.
6. **Sibling consistency.** Items C1, C2, C3, and the JSON-output convention are
   identical across all six structured adapters. They should ship as one shared
   block, worded the same way, so the fixes do not drift per skill.
