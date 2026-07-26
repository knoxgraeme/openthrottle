---
title: "Manifest transition defaults and neutral pipeline IDs - Plan"
type: refactor
date: 2026-07-25
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
credit: "Transition-defaults design from the 2026-07-25 developer proposal (manifest transition defaults, reviewed and amended: same_as dropped)"
---

# Manifest transition defaults and neutral pipeline IDs

## Goal

Two authoring problems, one PR. First, `ce-implement-v3.yaml` declares 64 transitions across 8 stages and roughly 49 of them are ceremony — identical terminals repeated per stage, and a `retryable_infrastructure_failure` self-loop that is a convention the schema cannot enforce (a mistyped target would validate and ship). Add a manifest-level `defaults` block plus a `retry:` shorthand so every surviving line is a decision and the self-loop becomes structurally guaranteed. Second, the platform pipelines are named `ce/implement` / `ce/investigate` although CE is the swappable default skill pack, not the platform — codified doctrine says core vocabulary is OpenThrottle's own. Ship the next manifest versions under the neutral `core/` namespace in the same authoring pass. The `ce/` prefix remains, correctly, on capability IDs (`ce/plan@1`, `ce/implement@1`, …), which genuinely bind the CE plugin.

## Requirements

- R1. `openthrottle.pipeline/v1` manifests may declare an optional top-level `defaults.transitions` map (outcome → transition) that every stage inherits; a stage's own declaration for an outcome always wins. Unknown outcome keys in `defaults` fail validation.
- R2. Manifests may declare `defaults.retry: { max_reentries: <n>, on_exhausted: <outcome> }` and/or a per-stage `retry:` override, expanding to `retryable_infrastructure_failure: { to: <declaring stage>, … }`. The target is implied and not expressible, making an invalid self-loop target unrepresentable.
- R3. Expansion happens during parse/normalization, before digesting. The stored, hashed, pinned normalized manifest is byte-identical to what an explicit hand-written manifest produces; the reducer, gates, fences, and pinned instances never observe that defaults exist. `same_as` is explicitly rejected as a key (reserved, unimplemented): on the real v3 file, `no_change` is terminal on 3 of 8 stages, so a `same_as: success` default would silently convert "nothing changed" into pipeline advancement wherever an override was forgotten.
- R4. Golden acceptance: a fixture manifest authored in short form and its hand-expanded explicit twin (same id/version) produce identical normalized JSON and identical SHA-256 digests. This assertion is the safety argument.
- R5. All expanded graphs pass the existing reachability/bounded-cycle validation; a `defaults` transition targeting an unknown stage fails validation with a named error.
- R6. New catalog entries `core/implement@1` and `core/investigate@1` are the current v3/v2 pipelines re-authored in short form under neutral IDs; the `implement` and `investigate` aliases move to them. Existing `ce/*` entries remain registered untouched (accepted `(id, version)` pairs are immutable and pinned history must keep resolving). The `core/*` digests will differ from their `ce/*` twins because the id is part of the manifest — expected and correct.
- R7. `docs/SPEC.md` documents `defaults`/`retry` in the manifest contract section and records the naming rule: `core/` for platform pipelines, `ce/` reserved for capability IDs.
- R8. The outcome vocabulary (8 outcomes), assurance classes, context policies, fencing, effect intents, and the sequential stage model are unchanged. If any coordinator, gate, or store test requires editing, the expansion is leaking past normalization and the design is wrong — stop and surface it.

## Files

- `supervisor/src/pipeline/manifest.ts` (+ `manifest.test.ts`) — parse `defaults`/`retry`, expand per stage before normalization/digest, validation errors.
- `supervisor/pipelines/core-implement-v1.yaml`, `supervisor/pipelines/core-investigate-v1.yaml` — new short-form manifests (content-equivalent to `ce-implement-v3.yaml` / `ce-investigate-v2.yaml` apart from id/version).
- `supervisor/pipelines/catalog.yaml` — register `core/*`, move both aliases; `ce/*` entries retained.
- Tests that enumerate the shipped catalog or aliases (`manifest.test.ts`, admission and store tests) — extend for the new entries and alias targets.
- `docs/pipelines/` — regenerate with `npm run docs:pipelines --prefix supervisor` (renderer landed in PR #57): pages for `core/implement@1` and `core/investigate@1` must exist, and comparing the rendered graphs of each `core/*` manifest against its `ce/*` twin is the visual content-equivalence check the original proposal recommended. The retained `ce/*` pages stay.
- `docs/SPEC.md` — R7.

## Approach

- Expansion order per stage: start from `defaults.transitions`, apply `defaults.retry` (if the stage declares no explicit `retryable_infrastructure_failure`), then overlay the stage's own `transitions` and `retry:`; validate the merged result with the existing per-stage rules.
- Author the two `core/*` manifests by mechanically shortening the current explicit files; verify content-equivalence by comparing their expanded stage/transition sets (ignoring id/version) against the `ce/*` twins in a test, so the rename provably changes identity only.
- Do not rewrite the retained `ce/*` YAML files into short form — they are frozen history; leave them byte-identical.

## Test scenarios

- R4 golden test (short form ≡ explicit form, same id: identical normalized JSON + digest).
- Content-equivalence test: `core/implement@1` expanded stages/transitions equal `ce/implement@3`'s (id/version excluded).
- Negative: unknown outcome key in defaults; `defaults` transition to an unknown stage; `same_as` key present; a stage override winning over a default (positive assertion of precedence).
- Alias resolution: `implement` → `core/implement@1`; a pinned historical instance carrying a `ce/implement@3` digest still resolves its manifest.
- Full supervisor suite green with zero edits to coordinator/gates/store tests (R8).
- `docs/pipelines/` regenerated and committed in the same PR; the `core/*` rendered graphs are topology-identical to their `ce/*` twins.

## Out of scope

`same_as` (rejected), `retry: false` (deferred, backward-compatible), catalog-wide defaults (weakens self-contained pinning), stage templates/fragments (re-measure after this lands), merging the `test`/`lint`/`build` stages (separate simplification), removing `ce/*` catalog entries (contraction-release material).
