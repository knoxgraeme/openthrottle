# Proposal: self-improving harness

**Status:** draft, for review
**Scope:** turning journal evidence into reviewed pull requests against a
target repository's own OpenThrottle configuration
**Risk:** medium — new journal fields, a new settlement rollup, a new read-only
analysis surface, and one new pipeline. No coordinator control-flow change.

## Summary

OpenThrottle already records why each run did what it did. Nothing reads that
record back. This proposal closes the loop in the most conservative way
available: a run's evidence becomes a **pull request against the target
repository's own OpenThrottle configuration**, reviewed and merged by a human,
then measured against subsequent runs and rolled back if it regresses.

Two boundaries define the whole design.

1. **Improvement is a diff, not a mutation.** The agent never edits live
   state. It opens a PR. Review, history, rollback, and CI are the existing
   safety mechanism; nothing new needs inventing.
2. **The tuner edits the repository's OpenThrottle configuration, never
   OpenThrottle.** `supervisor/`, `sandbox/`, `skills/tasks/`, and the
   package-owned built-in graphs are out of scope, permanently and by
   construction. This holds even when the target repository *is*
   `openthrottle-v2` — a delegated run against this repo may propose changes to
   this repo's `.openthrottle.yml`, and may not propose changes to
   `supervisor/src/`.

## Problem

`orchestration_journal` shipped in migration v15
(`supervisor/src/persistence/migrations/definitions.ts:804`) as an append-only
ledger keyed by team, repository, issue, and recorded time. `docs/SPEC.md:371`
states its read-contract precisely:

> The journal is queryable for operator or future orchestrator inspection, but
> no coordinator transition, gate, or effect scheduling logic may consume it as
> authority.

That sentence is the licence for this work: the journal sits deliberately
outside the control loop, so reading it cannot contaminate determinism. But as
built it is a log, not a corpus:

| Gap | Evidence |
|---|---|
| Sparse write sites | 9 call sites total (`app/admission.ts:262`, `providers/github/events.ts:349`, `operations/reaper.ts:67`, `persistence/pipeline/instance-store.ts:413,523`, `persistence/pipeline/transition-store.ts:80,351,372,392`) |
| Untyped payloads | `refs` and `structured` are free-form JSON; aggregation would require parsing prose |
| No join keys | No stable `manifest_digest` / `stage_id` / `attempt` / `repair_round` on the row |
| No outcome labels | Nothing records whether a run was *good*, only what happened |
| No corpus query | `listJournalEntries` filters by one issue or repository, `LIMIT 200` (`journal-store.ts:144`) |

A learner reading that today would be inferring conclusions from sanitized
prose. That is exactly the failure mode this design must avoid.

## What already exists

Enough that the remaining work is mostly plumbing.

| Capability | Location | State |
|---|---|---|
| Append-only decision ledger | `orchestration_journal` (v15) | Shipped |
| Journal read surface | `http/server.ts:286,313` | Shipped |
| Immutable digest-addressed manifests | `pipeline_catalog_entries` (`persistence/pipeline/catalog-store.ts:43`) | Shipped — re-accept with a different digest throws |
| Promotion pointer | `pipeline_catalog_aliases` (`catalog-store.ts:52`) | Shipped — upsert; instances pin the resolved manifest, so in-flight runs are unaffected by a flip |
| Per-run config pinning | `repository_config_snapshots` (`catalog-store.ts:105`) | Shipped — every run records the exact config bytes it ran under |
| Settlement hook | `pipeline/settlement.ts` | Shipped |
| Repo-authored graphs and skills | `.openthrottle/graphs/`, `.agents/skills/` (Stage C R1–R6, plan lines 337–347) | Planned |
| Lead decisions worth learning from | Stage C R19/R20 | Planned |

## The improvable surface

All four artifacts live in the target repository and are already fetched at the
pinned base commit during selection (Stage C plan line 174).

| Layer | Artifact | Examples of a proposed change | Risk |
|---|---|---|---|
| L1 | `.openthrottle.yml` | command strings, `post_bootstrap`, `limits`, `mcp_servers`, intent → graph selection | Low — closed schema, validated by the existing parser (`pipeline/manifest.ts:657`) |
| L2 | `.openthrottle/graphs/*.yml` | budgets, gate ordering, worker/loop bindings within installed node kinds | Medium — compiles to `PipelineManifest`, digest-pinned |
| L3 | `.agents/skills/*/SKILL.md` | repo-local skill bodies and checklists | Medium-high — prose, weakest determinism |
| L4 | `AGENTS.md` / `CLAUDE.md` | repository conventions every worker reads | Medium-high — highest leverage, least structured |

Out of scope permanently: supervisor code paths, credential scopes, assurance
classes, gate semantics, `skills/tasks/`, `sandbox/`, and `supervisor/graphs/`.
R26 already forbids repository configuration from introducing new evaluator
mechanics, artifact schemas, assurance classes, or gate expression languages —
this proposal adds no exception to it.

## Design

### 1. Typed journal entries

Add to every journal write:

- **Join keys** — `pipeline_id`, `pipeline_version`, `manifest_digest`,
  `stage_id`, `attempt`, `repair_round`. Additive columns, indexed by
  `(repository, pipeline_id, recorded_at)`.
- **A reason code enum** — a closed vocabulary in the `structured` payload
  (`gate_failed_lint`, `repair_budget_exhausted`, `context_stale`,
  `scope_mismatch`, `human_steered`, …), pinned by a migration contract line
  exactly as the existing `journal-contract` / `actor-contract` /
  `read-contract` lines are.

Aggregation runs on the enum. Prose stays as supporting colour and is never the
basis of a decision.

**This is the time-sensitive item.** Stage C's lead loop is the largest new
producer of journal entries (R19 receipts: assumptions, decisions, issues,
verification performed, downstream context, requested human input; R20
decisions: `accept` / `revise` / `context_update` / `needs_human`). Emitting
reason codes as that loop is built costs nothing. Retrofitting them across a
populated journal is a migration and a backfill. The lead should also record
*rejected* alternatives — a corpus containing only accepted paths cannot teach
what to change.

### 2. Deterministic outcome labels

At settlement, the supervisor computes a `run_outcomes` row. Supervisor-derived
facts only — no model inference:

- terminal level, and for `needs_human` the escalation reason code
- repair rounds consumed against `max_repair_rounds`
- per-gate pass/fail and per-command exit status
- provider evidence after publication (CI red/green)
- human steering count, as a proxy for the harness getting it wrong
- post-merge signals where GitHub supplies them: PR closed unmerged, review
  comment volume, reverts touching the published subject

This is the supervised signal. Without it the tuner has no way to tell a good
run from a bad one, and every proposal is aesthetic.

### 3. Read-only corpus query

A token-scoped `GET /analysis/runs?repository=&from=&to=` returning sanitized,
bounded, joined rollups of journal entries and `run_outcomes`. Read-only,
outside the coordinator, honouring the SPEC read-contract. `openthrottle
analysis` exposes the same data to a human, because an operator should be able
to read the evidence a proposal cites without running the tuner.

### 4. The tuning pipeline

A new manifest, `core/tune@1`, whose subject is the target repository's
OpenThrottle configuration.

```
corpus query ──> proposal (typed) ──> citation gate ──> branch + PR ──> human review
                                          │
                                          └── reject if the cited evidence does not verify
```

Stages:

1. **`analysis`** (agent) — reads the corpus for one repository over a window,
   returns typed proposals. Each proposal names the layer (L1–L4), the exact
   file, the change, the metric it claims to improve, and the journal entry IDs
   supporting it.
2. **`citation_gate`** (deterministic) — the supervisor re-runs the cited query
   and verifies the entries exist and the counts match. A proposal whose
   evidence does not reproduce is dropped before anything is written. This is
   the cheapest available defence against a confident, wrong proposal, and it
   reuses the existing receipts doctrine rather than inventing a new one.
3. **`assurance_ratchet`** (deterministic) — for L1/L2, compile the proposed
   configuration and diff it against the pinned current one. Reject unless
   credentials ⊆ current, gates ⊇ current, and limits are not raised. A
   proposal that wants to relax any of those must be labelled and routed to
   `needs_human`.
4. **`edit`** (agent) — apply the surviving proposals in a worktree.
5. **`test` / `lint` / `build`** — the repository's own configured gates, run
   against the change.
6. **`publish`** — an `ot/tune/*` branch and a PR whose body is the evidence
   table: proposal, citation, metric, expected effect.

The PR is the deliverable. Merge is a human decision, always.

### 5. Promotion and rollback

Promotion is the existing mechanism, unchanged: the merged configuration is
fetched at the next run's pinned base commit and snapshotted
(`saveRepositoryConfigSnapshot`). For L2, a changed graph compiles to a new
manifest digest; `pipeline_catalog_entries` keeps the prior digest immutably,
so rollback is a revert commit — or, if a promoted graph is aliased, an alias
flip back to the prior digest.

Rollback must be automatic, not aspirational. After a merged improvement, score
the next N runs on the metric the proposal named. Regression opens a revert PR
citing the same metric. Bound the change rate to at most one accepted
improvement per repository per window.

**Propose → merge → done is not self-improvement; it is an agent editing YAML.
The measure-and-revert half is what earns the name.**

## Guardrails

**Prompt injection is the sharp edge.** There is a real path from untrusted
input to harness modification: ticket text → `stage_agent` run note → tuner
reads the note → tuner proposes weakening a gate. AGENTS.md already classifies
ticket text, PR comments, and review bodies as untrusted regardless of where
they are read, and journal notes are sanitized and bounded to 8 KB
(`journal-store.ts:16,137`). That is necessary and not sufficient. Three
additional constraints:

- The tuner decides on **structured and enum fields only**. Prose is
  observation, never instruction.
- The **assurance ratchet is deterministic** and runs in the supervisor, so a
  persuaded model cannot talk its way past it.
- **A human merges.** No configuration reaches a run without review.

Additional bounds:

- The tuner's write scope is restricted to the four target-repo paths. A
  proposal touching anything else fails before the edit stage.
- Every proposal, citation-gate verdict, ratchet verdict, and promotion is
  journaled with `actor = 'orchestrator'`, per the Stage C convention (plan
  line 24) — no parallel decision journal.
- The journal remains outside coordinator control flow. The tuner is an
  ordinary pipeline reading an ordinary read-only endpoint; no gate, transition,
  or effect scheduler gains a dependency on journal contents.

## Phasing

| Phase | Work | Gate to proceed |
|---|---|---|
| P0 | Reason-code enum + join keys on journal writes, emitted by the Stage C lead loop as it is built | Lands **with** the lead loop, not after |
| P1 | `run_outcomes` rollup at settlement | Labels reproduce by hand for a sample of completed runs |
| P2 | Read-only `/analysis/runs` + `openthrottle analysis` | An operator can read the corpus unaided |
| P3 | `core/tune@1` scoped to **L1 only**, deploy-gated, citation gate + ratchet, human merge | Ten proposals reviewed by hand; precision judged acceptable |
| P4 | Measurement + automatic revert PR | A seeded regression triggers a revert |
| P5 | Extend to L2, then L3/L4 | P4 stable across more than one repository |

P0 is the only item with a real deadline attached, and it is attached to Stage
C rather than to this proposal.

## Deliberately not proposed

- **Live mutation of configuration in SQLite.** The definition surface stays in
  git. SQLite holds evidence, proposals, and pointers.
- **A DB-resolved catalog.** `resolvePipelineReference` (`pipeline/manifest.ts:698`,
  called from `app/admission.ts:236`) resolves against the in-memory catalog
  loaded at boot (`index.ts:48`); the SQLite copy is an audit ledger, not the
  resolution path. Making the DB authoritative would let a running supervisor
  change behaviour without a deploy. Deploy-gated promotion costs a deploy and
  buys a trust boundary; keep it.
- **Self-modification of OpenThrottle core.** Improving `supervisor/` or
  `skills/tasks/` from run evidence is a different proposal with a different
  risk profile, and it should not be smuggled in under this one.

## Open questions

1. **Window and N.** How many runs before a proposal is well-founded, and how
   many before a promoted change is judged? Both are per-repository and depend
   on delegation volume, which is currently zero.
2. **Reason-code vocabulary.** The enum must be closed and stable enough to
   aggregate across versions. Drafting it is P0's real content and wants a pass
   with the Stage C lead design in hand.
3. **L3/L4 verification.** L1 and L2 compile and can be ratcheted
   deterministically. A `SKILL.md` or `AGENTS.md` edit has no compiler. Either
   accept human review as the only gate for those layers, or defer them
   indefinitely.
4. **Cross-repository learning.** Anonymized corpora and shareable improvement
   bundles are the strongest OSS story here, and also the largest new data
   boundary. Out of scope for this proposal; worth a separate one once P4 is
   stable.
