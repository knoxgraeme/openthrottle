# Proposal: manifest transition defaults

**Status:** superseded by the execution-kernel rewrite
**Scope:** historical authoring ergonomics for the deleted `openthrottle.pipeline/v1` contract
**Risk:** historical — no longer applicable to the current architecture

> This proposal is retained as design history. The kernel rewrite removed the
> `openthrottle.pipeline/v1` contract, the `ce-implement-v3.yaml` manifest, and
> the former SPEC section it discussed. The text below does not describe the
> current authoring or runtime contracts.

## Problem

`ce-implement-v3.yaml` is 148 lines declaring 64 transitions across 8 stages.
Most of them are not decisions. Measured on the former file:

| Outcome | Count | Observation |
|---|---:|---|
| `needs_human` / `canceled` / `superseded` | 24 | 100% identical on every stage — always `{ terminal: <same-name> }` |
| `retryable_infrastructure_failure` | 8 | **always** a self-loop; no stage is an exception |
| `semantic_repair_required` | 8 | 7 identical (`→ implementation, ≤3, needs_human`); 1 deliberate override (`implementation`, ≤8) |
| `failure` | 8 | 5 are byte-identical to that same stage's `semantic_repair_required` |
| `no_change` | 8 | 5 are byte-identical to that same stage's `success` |
| `success` | 8 | all distinct — this is the real spine |

Roughly 15 of 64 transitions carry information. The other ~49 are ceremony
that must be repeated correctly by hand on every new stage and every new
manifest.

Two consequences:

1. **Reviewability.** A manifest diff is dominated by boilerplate, so a
   changed `to:` target is easy to miss in review.
2. **Correctness by convention only.** `retryable_infrastructure_failure` is a
   self-loop in all 8 cases, but nothing in the schema requires it. A typo
   pointing it at another stage would validate and ship.

## Proposal

Add an optional manifest-level `defaults` block that stages inherit and may
override.

```yaml
defaults:
  transitions:
    needs_human: { terminal: needs_human }
    canceled:    { terminal: canceled }
    superseded:  { terminal: superseded }
    semantic_repair_required: { to: implementation, max_reentries: 3, on_exhausted: needs_human }
    no_change: { same_as: success }
    failure:   { same_as: semantic_repair_required }
  retry: { max_reentries: 2, on_exhausted: failed }
```

- `same_as: <outcome>` resolves against the **stage's own** final transition
  set, which is what makes the `no_change`/`success` and
  `failure`/`semantic_repair_required` pairings expressible.
- `retry:` is sugar for `retryable_infrastructure_failure` targeting the
  declaring stage. Because the target is implied, an invalid target becomes
  unrepresentable rather than merely unconventional.
- Any stage may declare an outcome explicitly; the stage always wins.

Expected effect on `ce-implement-v3`: ~64 explicit transitions → ~15,
148 lines → roughly 55. Every surviving line is a decision.

## Why this is safe

**Expansion happens during normalization, before digesting.**

The authored YAML is expanded to a fully explicit transition set as part of
the existing parse/normalize step. The normalized manifest that gets stored,
hashed, and pinned is byte-identical to what a hand-written explicit manifest
would produce. Therefore:

- `digestNormalized(normalized) !== instance.manifest_digest`
  (`coordinator.ts:139`) is unchanged and still verifies on every event.
- `reducePipelineEvent` never learns that defaults exist — it reads
  `stage.transitions[outcome]` exactly as today.
- Existing pinned instances are unaffected; their stored normalized manifests
  already contain the expanded form.
- Reachability and unbounded-cycle validation (`manifest.ts:330-350`) run
  against the expanded graph, so coverage does not regress.

This is macro expansion, not runtime indirection. Nothing downstream of
normalization changes.

## What changes

- `supervisor/src/pipeline/manifest.ts` — parse `defaults`, expand per stage,
  resolve `same_as`, reject unresolvable or cyclic `same_as` chains.
- `supervisor/pipelines/*.yaml` — rewrite the three manifests in the shorter
  form. Their normalized digests **must not change**; that is the acceptance
  test.
- `docs/SPEC.md` — document `defaults` in the manifest contract section.

## Explicitly not changing

**The outcome vocabulary stays at 8.** The redundancy measured above is in the
*routing table*, not the vocabulary. `failure` and `semantic_repair_required`
routing identically does not make them the same event: they carry different
meaning to the gate receipt, the Linear publication, and the human reading the
ticket. Collapsing them would trade a genuine strength of the system for a
cosmetic win. Same for `success` vs `no_change`.

Also unchanged: assurance classes, context policies, the fencing model,
effect intents, and the sequential stage model.

## Verification

1. Golden test: for each of the three catalog manifests, the normalized JSON
   and SHA-256 digest produced from the new short form equal those produced
   from the current explicit form. This is the whole safety argument as a
   single assertion.
2. Negative tests: unknown outcome key in `defaults`; `same_as` naming an
   outcome the stage does not end up with; `same_as` cycle; a stage override
   of a defaulted outcome actually winning.
3. Existing suite green — coordinator, gates, and store tests should require
   no edits at all. If any of them need changing, the expansion is leaking
   past normalization and the design is wrong.

## Open questions for review

1. **Is `same_as` worth it?** It buys the `no_change`/`failure` pairings (10 of
   the ~49 redundant transitions) at the cost of a second resolution concept.
   Dropping it keeps the proposal simpler; those 10 lines stay explicit.
2. **Should `defaults` be per-manifest or catalog-wide?** Per-manifest is
   proposed. Catalog-wide would deduplicate further across implement and
   investigate, but weakens the "a manifest is self-contained and pinned"
   property. Recommendation: per-manifest.
3. **Should `retry:` also allow `false`** to opt a stage out of infrastructure
   retry entirely? No current stage wants this; adding it later is
   backward-compatible.
4. **Sequencing vs. the fragment idea.** A stage-template/fragment mechanism
   (deduplicating whole stages, e.g. `test`/`lint`/`build`) addresses an
   overlapping problem. Defaults are strictly smaller and independently
   valuable; recommend landing defaults first and re-measuring before deciding
   whether fragments still earn their keep.

## Related

- `docs/pipelines/` — rendered Mermaid graphs of each manifest. Reviewing the
  rendered graph before and after this change is the quickest way to confirm
  the expansion produced the intended topology.
