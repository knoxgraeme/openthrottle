# Skills

Task skills (`skills/tasks/`) are self-contained stage and loop adapters: each
one carries its own craft — implementation discipline, review lenses,
simplification heuristics, diagnostic method — instead of delegating to a
second-hop toolkit. The supervisor selects a versioned pipeline manifest; each
agent stage or structured-loop action invokes one canonical adapter for the
capability named in its sealed request. Planning skills (`skills/planning/`)
still author against native Compound Engineering at authoring time — that is
a separate, upstream-of-delegation surface this split does not change.

```text
skills/
  planning/<name>/SKILL.md          # planning-time authoring skills
  planning/<name>/agents/openai.yaml
  tasks/<name>/SKILL.md             # canonical adapter, single source of truth
  tasks/<name>/agents/openai.yaml   # Codex admin-scope policy
  codex/AGENTS-fragment.md          # standing Codex runtime instructions
```

Task skills run inside a sealed sandbox stage or structured-loop action. There
is no task-name registry and no shell-owned end-to-end task loop. Pipeline
manifests in `supervisor/pipelines/` own stage order, retries, gates, and
terminal outcomes. `sandbox/runner/execute-stage.mjs` executes exactly one
sealed stage and `sandbox/runner/execute-loop.mjs` executes exactly one sealed
loop action; each writes exactly one typed result.

Five stage-path skills adapt one agent stage each, keyed off the sealed
request's `capability` (`sandbox/runner/execute-stage.mjs`'s
capability→skill map, not task type):

- `implement-plan` (`ce/implement@1`) implements or repairs the approved plan.
- `review-change` (`ce/review@1`) reviews the whole branch diff and returns
  ranked, stable findings.
- `simplify-change` (`ce/simplify@1`) simplifies the branch diff above an
  entry-gate size/complexity threshold, preserving behavior.
- `publish` (`ce/publish@1`) commits, pushes, and opens or updates the pull
  request for the already-gated exact subject.
- `investigate` (`ce/investigate@1`) diagnoses a reported defect and applies a
  convergent fix only.

Structured graphs use six loop-path task adapters, one per unit action:

- `implement-unit`, `simplify-unit`, and `repair-unit` implement, simplify, or
  repair one execution-plan unit in its own worktree and return
  `unit_completion` receipts.
- `accept-unit` is the minimal lead scope-match decision and returns
  `unit_decision`; it is explicitly not a code review.
- `final-review` is the only whole-change review adapter in the structured
  path and returns `semantic_review` for the integrated whole. It is
  report-only; it never edits.
- `final-repair` repairs exactly the findings `final-review` raised, in an
  executor-owned exact-base worktree, and returns `unit_completion`.

Review fanout uses baseline and optional report-only persona packages. They
install with the same task-skill baseline for every supported engine and emit
independent `semantic_review` receipts:

- `select-review-personas` chooses the deterministic roster from the sealed
  review policy, always including the mandatory baseline personas when present.
- `correctness-dataflow` reviews changed value flow, state transitions,
  ordering, and failure paths.
- `tests-contracts` reviews executable proof and cross-boundary contracts.
- `reliability-adversarial` optionally reviews retry, ordering, idempotency,
  and silent-pass risks where changed code crosses durable or asynchronous
  execution.
- `agent-native-contracts` optionally reviews native session continuation,
  prompt-boundary handling, receipt provenance, and tool-contract authority
  where changed code crosses agent execution boundaries.
- `security` optionally reviews authority, untrusted-input, injection, and
  secret-handling risks where changed code crosses trust boundaries.
- `data-migration` optionally reviews schema, backfill, persisted-record, and
  serialized-contract compatibility risks.
- `performance` optionally reviews hot-path queries, bounded work, resource
  defaults, artifact retention, and scaling risks.
- `project-standards` optionally reviews committed OpenThrottle standards such
  as task packaging, manifests, architecture boundaries, and normative docs.

A repository-scoped skill may replace any of these when it emits the same
`openthrottle.receipt/v1` or `openthrottle.stage-proposal/v1` contract. The
coordinator evaluates the receipt and executor-derived Git/command evidence,
not implementation details internal to the skill.

## Delivery per agent

The canonical `SKILL.md` is maintained once:

| Agent | Delivery |
|---|---|
| Claude | `sandbox/entrypoint.sh` copies the canonical task skills to `~/.claude/skills/`; the stage prompt invokes `/<skill-name>`. |
| Codex | `sandbox/Dockerfile` bakes the same directories into `/etc/codex/skills/`; `agents/openai.yaml` disables implicit invocation and the prompt explicitly invokes `$<skill-name>`. |
| OpenCode | The entrypoint strips YAML frontmatter from the same canonical file, inlines every `references/*.md` file the skill carries, and renders the result into the stage prompt — because the pinned CLI cannot safely discover only sandbox-owned external skills, a `references/` pointer would otherwise be unresolvable. |

Planning skills use the same one-body-per-skill layout, but they are packaged
for local authoring tools instead of sealed stage execution. A planning skill
may call local CLI validators; it must not mutate Linear, publish branches, or
claim runtime gate authority.

The runtime chooses fresh, read-only fresh, required-resume, or preferred-resume
context from the pinned manifest. When continuation is allowed, the sealed
request carries the prior native Claude session, Codex thread, or OpenCode
session identifier. Continuation is a context policy, not a separate task type.

## Coordinator-owned composition

The current catalog aliases `implement` and `investigate` to immutable `core/`
manifests:

- `core/implement@4`: implementation → semantic review → simplification →
  post-simplify review → test → lint → build → exact-subject publication →
  provider verification.
  Repair transitions use the manifest's scoped repair stages and round budget.
- `core/investigate@1`: investigation → conditional exact-subject publication.
  Convergent fixes may ship; divergent decisions terminate as `needs_human`.

Agent stages emit semantic proposals. Command stages produce
executor-verified results. Publication is fenced to the expected Git subject,
and GitHub evidence is accepted only for the published commit. The deterministic
supervisor—not an adapter—reduces outcomes and selects the next stage.

## Adapter-owned rules

Every task adapter owns the same reasoning contracts, restated in its own
words rather than inherited from a shared toolkit:

- approved-plan and decision gates;
- prompt-injection treatment for ticket, plan, repository, and review content;
- complete, typed stage proposals or receipts with evidence and explicit
  uncertainty;
- visible `ot-activity` progress (stage path) without direct Linear
  credentials;
- branch and worktree safety — never pushing to the base branch, never
  touching a sibling worktree or the integration checkout;
- no silent backlog: fix, explain, or return `needs_human`.

The snapshot still installs the commit-pinned Compound Engineering plugin
natively for Claude Code, Codex, and OpenCode, for planning-time authoring
skills. No task skill under `skills/tasks/` invokes it.

## Runtime trust boundary

Registered repositories are trusted for code execution: their validated
`.openthrottle.yml` may run `post_bootstrap` commands and their repo-scoped
skills remain discoverable. Ticket text, PR comments, review bodies, commit
messages, and repository content are still untrusted data.

Codex also receives `codex/AGENTS-fragment.md` globally at
`~/.codex/AGENTS.md`, outside the checkout. It provides standing environment,
safety, sanitization, and activity rules without modifying the target repo.

## Design notes

Distilled from the adoption review (`OPE-105`/`OPE-107`); kept because the
reasoning is easy to accidentally undo in a future edit.

**Canonical shared blocks.** Every loop-path skill in a family (the four
worktree-owning skills: `implement-unit`, `repair-unit`, `simplify-unit`,
`final-repair`; the two read-only gates: `accept-unit`, `final-review`) states
its authority fence, receipt-echo rules, receipt output format, and budgets in
byte-identical prose, duplicated per file rather than factored into a shared
include — each skill loads in its own session with no shared runtime, so a
shared file would not actually be shared at read time. The five stage-path
skills share their standing rules and result-contract budgets the same way.
When one of these blocks needs to change, change it in every skill that
carries it — the sandbox skill test suite asserts the duplication stays
byte-identical.

**Stable finding identity, not line numbers.** `final-review` and
`review-change` key a finding by `(path, enclosing symbol or nearest stable
anchor, invariant)`, never by line number. A repair that shifts surrounding
lines must not re-issue an already-raised defect as a new finding — that
non-convergence was the single largest cost in early dogfooding rounds. The
identity is carried as a prefix of the finding's `message` field because the
receipt contract has no dedicated id field.

**Why the split is a fork, not a thicken.** `publish` and the review/simplify
stages could have wrapped a shared external toolkit instead of restating its
logic. The fork was chosen because delegation's failure modes were structural,
not cosmetic: an unenforced second hop (nothing verified the delegated skill
actually ran before the fence checked only `producer.skill`), a commit
authority collision (a delegated implementation skill's own shipping tail
tried to commit inside an executor-owned worktree), and unbounded elicitation
in a headless session with no user to answer a blocking question. A thin
wrapper cannot hold any of those back; each self-contained skill states its
own authority fence and receipt contract directly.

**`ot-subject-post` and the negative-hash rule.** The four worktree-owning
skills copy `subject.post` from the `ot-subject-post` helper rather than
hand-deriving it with `git` — the executor recomputes the same value
independently and rejects a mismatch, so a hand-derived value is redundant at
best and silently wrong at worst. The same four skills are told, explicitly,
never to copy a prior receipt's hash into their own `evidence` array, but the
reason splits in two: `implement-unit` and `simplify-unit` receive no prior
evidence at all — a first implement or simplify attempt has nothing to
receive — so the instinct to echo something from the prompt is always wrong
for them. `repair-unit` and `final-repair` do receive prior evidence (the
triggering lead decision and failing command receipts, or the triggering
review, respectively — `PRIOR_EVIDENCE_ROLES` covers `lead`, `repair`,
`final_review`, `final_repair`), but the link back to what triggered the
repair is bound deterministically by the executor through
`fence.request_hash`, not by the agent copying a hash, so echoing it would be
redundant at best. This is the opposite of `accept-unit` and `final-review`,
which are read-only gates that must echo prior-evidence hashes verbatim as
their own evidence — the one family where copying is exactly right.

**Determinism over inferred rosters.** Review lenses (`final-review`,
`review-change`) and simplification lenses (`simplify-unit`,
`simplify-change`) are a fixed, ordered list applied every round, rather than
a per-run set inferred from perceived risk. A fixed roster is what lets a
repair-then-re-review cycle converge: the same change produces the same
review shape whether it is round one or round four.
