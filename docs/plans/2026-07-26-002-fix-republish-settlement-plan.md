---
title: "Republish settlement: second publishes must settle like first ones - Plan"
type: fix
date: 2026-07-26
status: shipped
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# Republish settlement: second publishes must settle like first ones

## Goal

The first publish of a pipeline instance settles in seconds (result ingested, PR gate comment posted, instance enters `waiting_provider`). A **second** publish of the same instance — the re-publish at the end of every provider-feedback repair round — wedges: its stage-result file sits unconsumed in `/var/lib/openthrottle/stage-results/` until the stall reaper converts the round into a typed infrastructure failure. Observed twice on 2026-07-25 (generation 9: the 21:37 repair re-publish and the 21:55 post-reap publish retry — both wedged identically while the branch push itself succeeded). This defect degrades every repair round and blocks the comment→action→re-publish loop and the Linear-replies-as-feedback feature. Find it deterministically, fix it, and make any future settlement wedge diagnosable without provider logs.

## Known evidence

- Round-1 publish settles: result consumed within seconds, `github_summary` receipt acknowledged, `published_commit` recorded.
- Round-2 publish: branch push and PR head update succeed; the result event file is never consumed; no receipt, no instance transition; the executor exits 0; the stall reaper fires ~15 minutes later.
- The poller retries failed sandbox-event ingestion indefinitely (`markSandboxEventFailed` → retry), so a deterministic validation throw in the settlement path matches the symptom exactly.
- Prime suspects, in order: the coordinator/gate fences comparing the result's subject or session against state recorded by round 1 (`published_commit`, `immutable_subject`, receipt idempotency keyed on values that changed with the new head), and the publish-subject evaluator re-validating against a stale expected subject. The republish carries a NEW tree/commit while instance state still holds round 1's.

## Requirements

- R1. Write the characterization test FIRST: an integration test driving one instance through publish → settle → provider feedback snapshot → repair re-entry → forward chain → second publish → ingestion/settlement of the second result, through the real coordinator, gate, and poller settlement code (mock only the runtime/provider edges). On current `main` this test must reproduce the wedge (settlement throws or the event cannot be consumed). If it passes on `main`, the defect is not in deterministic logic — go to R4 instrumentation instead and say so in the receipt; do not invent a fix for an unreproduced bug.
- R2. Fix the defect so the second result settles: instance returns to `waiting_provider`, `published_commit` reflects the new head, a fresh `github_summary` receipt acknowledges, and prior-head receipts/snapshots are invalidated per the existing staleness rules.
- R3. No fence weakening: subject binding, request-hash/attempt fences, generation checks, and receipt idempotency all remain. The fix must correct what the re-publication path records or compares — never delete a check. If preserving a fence and settling the result genuinely conflict, stop and surface the conflict instead of choosing.
- R4. Diagnosability regardless of root cause: when ingestion of the same sandbox event fails N consecutive times (N=5), persist the sanitized last error onto the event row, surface it in the `/status` payload for the ticket, and enqueue one honest-ledger activity ("The supervisor cannot ingest the stage result: <reason>. It will keep retrying."). Idempotent per event; no behavior change on transient single failures.
- R5. Regression coverage: the R1 test joins the suite green; a second test proves a THIRD publish (two repair rounds) also settles, guarding against fixes that only handle the first re-publish.

## Files

- The R1 test: alongside the existing coordinator/gates/poller integration tests (follow `pipeline/gates.test.ts` and `runtime/event-poller.test.ts` harness patterns).
- The fix: wherever R1 points — expected in `pipeline/gates.ts` (publish-subject/settlement validation), `pipeline/coordinator.ts` fences, or `persistence/pipeline/instance-store.ts` (`published_commit`/subject recording on re-publish). Do not guess ahead of the failing test.
- R4: `runtime/event-poller.ts` (+ test), `/status` projection field, honest-ledger activity.
- `docs/SPEC.md` only if the settlement contract wording needs a correction discovered by R1.

## Test scenarios

- R1 end-to-end republish settlement (fails on main, passes after fix).
- Third-publish settlement (R5).
- Ingestion-failure surfacing: an event failing 5 consecutive ingestions persists its error, appears in `/status`, posts exactly one activity, and still retries (R4).
- Full supervisor suite green; no coordinator/gate test deletions or weakenings.

## Out of scope

Feedback-content enrichment (OPE-8), Linear-replies-as-feedback (paired ticket, lands after or alongside this), reaper behavior changes, any manifest changes.
