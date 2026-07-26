---
title: "Linear replies during provider waits become feedback - Plan"
type: feat
date: 2026-07-26
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# Linear replies during provider waits become feedback

## Goal

Today a Linear message sent while the pipeline is in `waiting_provider` is rejected with "The current pipeline stage does not accept live steering." — the human is told to go somewhere else with their words. Wrong response: a reply to a waiting run should wake it. Convert such replies into provider feedback events on the existing head-scoped snapshot channel — the same pipe a PR comment travels — so the message coalesces with any pending GitHub feedback, a repair round resumes the session lineage, and the reply reaches the agent through the typed transition context. Linear becomes one more feedback provider alongside GitHub; no new state machine, no new session semantics.

## Requirements

- R1. When a Linear `reply` prompt arrives for a ticket whose pipeline instance is in `waiting_provider` and the live-steering path does not apply, the supervisor must record it as a provider feedback event with source `linear`, stable identity derived from the Linear agent activity ID (idempotent on redelivery), bound to the instance's current published head, and coalesced into the pending feedback snapshot under the existing head-scoped rules.
- R2. The reply body must reach the repair agent through the typed channel: sanitized and bounded (≤ 2,000 chars) in the event summary/evidence so the coordinator's `transitionContext` carries it into the sealed repair request. No reliance on session memory.
- R3. The human gets an acknowledgement activity, not an error: one sentence saying the run is being woken to address the message (honest-ledger vocabulary). The existing rejection error remains only for the still-unanswerable cases: no pipeline instance, terminal instances, and `opencode` live-steer attempts.
- R4. Precedence is unchanged elsewhere: a steerable running stage still consumes the message as live steering (existing inbox path); only the `waiting_provider` case converts to feedback. `needs_human` terminals keep their current messaging — the reply-to-re-delegate flow is a separate feature and out of scope here.
- R5. A reply arriving for a superseded or just-terminal instance (race) must degrade to the existing error, never create a feedback event for a dead generation (generation/head fences already enforce this — prove it with a test rather than new mechanism).
- R6. One coalescence property must hold and be tested: a Linear reply plus a PR comment on the same head produce ONE snapshot with both provider events, consumed by ONE repair round.

## Files

- `supervisor/src/app/session-service.ts` (+ test) — the prompted-reply branch: convert instead of reject for `waiting_provider`.
- `supervisor/src/providers/github/events.ts` or a small neutral module — the feedback-recording helper is currently GitHub-local (`recordPipelineProviderEvent`); expose/relocate the minimal surface so the Linear path can record events without importing GitHub machinery. Keep the move minimal; do not restructure the snapshot store (it is already provider-agnostic — `FeedbackSnapshotEvent.provider` exists).
- `docs/SPEC.md` — one paragraph: Linear replies during provider waits are feedback events.

If satisfying this appears to require coordinator, gate, or schema changes, stop and surface it — the snapshot and repair machinery must be consumed as-is.

## Test scenarios

- Reply during `waiting_provider` → feedback event recorded with source `linear` and the activity-ID identity; acknowledgement activity enqueued; no rejection error.
- Same reply delivered twice (webhook redelivery) → one event.
- Reply + PR comment on the same head → one snapshot, two provider events (R6).
- Reply while a steerable stage is running → existing live-steer inbox path, no feedback event.
- Reply for a terminal/superseded instance → existing error, no event.
- Full supervisor suite green.

## Out of scope

`needs_human` reply→re-delegation, feedback-content enrichment (OPE-8), the republish settlement defect (paired ticket — note: that defect currently degrades every repair round's re-publish and should land first or alongside), multi-user identity.
