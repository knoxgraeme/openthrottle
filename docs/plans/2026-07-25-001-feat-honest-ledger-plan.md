---
title: "Honest ledger: human receipts, wait-state and capacity visibility - Plan"
type: feat
date: 2026-07-25
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# Honest ledger: human receipts, wait-state and capacity visibility

## Goal

Make the parent Linear session tell an operator, at every moment, three things in plain sentences: what just happened, how far through the job the run is, and **whose move it is**. Four live incidents on 2026-07-25 motivated this: healthy runs in `waiting_provider` were mistaken for stalls three times ("it says finished but I'm not sure if it's done or stuck"), and a provisioning run silently waiting on the Daytona memory quota was mistaken for a stall once. No coordinator, gate, fence, schema, or effect-semantics changes — this is a rendering and visibility change only.

## Requirements

- R1. Every pipeline publication template (`selection`, `gate`, `repair_reentry`, `needs_human`, `provider_wait`, `terminal`) must render its Linear body as short plain sentences. Machine vocabulary (`coordinator_pinned`, `not_evaluated → selected`, raw assurance-class names, "Residual uncertainty: None declared") must not appear in the rendered body. The typed payload underneath is unchanged; only the rendered markdown changes.
- R2. Every rendered receipt must carry job progress and turn/job distinction: `Stage <k> of <n>: <stage> — <plain outcome sentence>` plus a final line naming whose move is next, exactly one of: `Working — next receipt expected from the <stage> stage.`, `Waiting on you: <what and where>.`, `Waiting on GitHub: <what>.`, or `This run is finished: <job outcome sentence>.` Stage count comes from the pinned manifest; both values already exist in the publication envelope inputs.
- R3. Terminal receipts must state the JOB outcome honestly, distinguishing at minimum: shipped (with PR link), no_change ("no code change was needed — no PR was created"), needs_human (what decision is needed and that the workspace is preserved), failed (the real cause line already carried by the payload), canceled/superseded (one sentence each).
- R4. When the effect processor classifies a failure as `capacity` and schedules a patient retry, it must enqueue exactly one Linear activity per effect (idempotent across retries of the same effect) saying the run is waiting on sandbox capacity, what is holding it, and that it will retry automatically. When a capacity-waiting effect later succeeds, no correction activity is required.
- R5. Rendering is pure: given the same publication envelope, the same markdown. Bump `PIPELINE_PUBLICATION_TEMPLATE_VERSION` once. Existing envelope construction, idempotency keys, per-session ordering, and sanitization are unchanged.

## Files

- `supervisor/src/pipeline/publication.ts` — `renderBody` and the per-template rendering; template version constant.
- `supervisor/src/pipeline/publication.test.ts` — rendered-body assertions per template.
- `supervisor/src/operations/pipeline-effects.ts` — the capacity-classification branch enqueues the one-time wait activity.
- `supervisor/src/operations/pipeline-effects.test.ts` — capacity-activity idempotency cases.

Nothing else. If satisfying a requirement appears to need edits to the coordinator, stores, gates, or schema, stop and surface it as a blocker.

## Approach

- Rewrite `renderBody` per template around three lines: the event sentence, the progress line (R2), and the whose-move line. Reuse the existing envelope fields (pipeline id/version, stage id, attempt/reentry ordinals, outcome, wait reason, PR link, subject) — do not add new envelope fields.
- Translate outcome and assurance vocabulary into sentences at render time only (e.g. `semantic_attested` never appears; a gate receipt reads "the agent reports X; the supervisor verified the tree and evidence fences").
- For repair/continuation re-entries, say which round: "repair round 2 of 3" (bounds are in the pinned manifest transitions).
- For R4, key the one-time activity on the effect id (e.g. outbox id `capacity-wait:<effectId>`), enqueued the first time classification returns `capacity`; rely on outbox idempotency for retries.

## Test scenarios

- One rendered-body snapshot-style assertion per template state, each checking: no machine vocabulary tokens (assert absence of `coordinator_pinned`, `not_evaluated`, `semantic_attested`), presence of `Stage <k> of <n>`, and exactly one whose-move line.
- Terminal bodies for shipped / no_change / needs_human / failed each carry their R3 sentence.
- A capacity-classified provision failure enqueues exactly one wait activity across three consecutive retry failures of the same effect; a transient failure enqueues none.
- Full supervisor suite green with no changes outside the four files above.

## Out of scope

New Linear activity types, plan/session-update mechanics, `ot status` CLI changes (separate plan), the republish-settlement investigation, any coordinator or store change.
