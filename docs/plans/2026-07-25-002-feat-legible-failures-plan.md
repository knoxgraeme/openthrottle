---
title: "Legible failures: enriched check-failure snapshots and deep ticket status - Plan"
type: feat
date: 2026-07-25
status: shipped
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# Legible failures: enriched check-failure snapshots and deep ticket status

## Goal

Two evidence gaps made 2026-07-25's failures illegible. First, a CI check failure reached the repair agent as a bare check-suite API URL with `findings: []`, so the repair round did unrelated work ("flew blind") and burned its budget without touching the real cause. Second, every operator diagnosis required exec'ing into the sandbox because neither `/status` nor `ot status` can answer "which stage, which attempt, what was the last error, why is it waiting." Fix both. The principle is established: the session is memory, the sealed request is the guarantee — failure evidence must ride the typed channel.

## Requirements

- R1. When a GitHub check/workflow failure becomes provider feedback, the recorded snapshot event must carry, in its typed payload and findings: the failing workflow name, the failing job name(s), the failing step name(s), and a bounded, sanitized excerpt of the failing step's log tail (≤ 2,000 chars per job, ≤ 3 jobs). Fetch via the existing GitHub client using the read-capable credential; API failures degrade gracefully to today's URL-only evidence (never block the snapshot).
- R2. The enrichment must flow to the repair agent through the existing structured-findings channel: each failing job becomes one finding (`severity: "P1"`, `code: "ci-check-failed"`, summary naming workflow/job/step), so the coordinator's `transitionContext` findings carry it into the sealed repair request with no coordinator changes.
- R3. The supervisor `/status` payload must expose, per ticket with a pipeline instance: pipeline id/version, generation, instance status, terminal outcome, active stage id, attempt ordinal and re-entry ordinal, wait reason, published PR URL, last error (sanitized, bounded to 500 chars — from the newest failed/dead effect or the newest failure-class gate receipt), and the timestamp of the last state change. Extend the existing status projection; do not add new tables.
- R4. `openthrottle status` (CLI) must render those fields as one block per ticket, human-readable, with the whose-move line matching the honest-ledger vocabulary ("waiting on you / waiting on GitHub / working / finished"). `openthrottle status <ticket>` filters to one ticket.
- R5. All new output is sanitized through the existing sanitizer before storage or transport. No new credentials, endpoints, or auth semantics; `/status` stays behind `OT_STATUS_TOKEN`.

## Files

- `supervisor/src/providers/github/events.ts` (+ test) — check-failure enrichment at the point the event becomes a provider snapshot.
- `supervisor/src/providers/github/client.ts` or the existing client module (+ test) — one bounded helper to fetch failing jobs/steps/log tail for a check suite, if no suitable call exists.
- `supervisor/src/persistence/pipeline/*` status projection (+ test) — the R3 fields, extending the existing projection query.
- `supervisor/src/http/server.ts` (+ test) — `/status` payload additions.
- `cli/src/status.ts` (+ test) — rendering.
- `docs/SPEC.md` — the `/status` payload additions (one table row per field).

If R1 appears to require storing raw logs durably, stop: only the bounded excerpt is stored, inside the snapshot event payload.

## Approach

- Enrich at ingestion (webhook → snapshot), not at consumption: the snapshot is immutable and the excerpt must be captured while the check run is fresh.
- Reuse the check-runs listing the supervisor already performs elsewhere (`/commits/{sha}/check-runs`) to find failing runs; fetch job/step detail and the log tail with one additional call per failing job, capped at 3 jobs.
- For R3, prefer one SQL projection extension over N+1 queries; the fields all exist in `pipeline_instances`, `pipeline_stage_attempts`, effect intents, and gate receipts.
- Keep the CLI table plain (no new dependencies; match the existing `status.ts` style).

## Test scenarios

- A failed check event with a mocked jobs/log API yields a snapshot whose findings name workflow/job/step and whose excerpt is present, bounded, and sanitized (a planted token shape in the log tail is redacted).
- The same event with the jobs API erroring still records the snapshot with URL-only evidence (degraded, not blocked).
- A repair re-entry request built from that snapshot carries the findings in `transitionContext` (assert through the real coordinator path, as in the existing findings test).
- `/status` returns the R3 fields for an instance mid-repair (attempt 2, re-entry 1, wait reason null, last error populated) and for a `waiting_provider` instance (PR URL populated, whose-move = provider).
- CLI snapshot test for the rendered block.

## Out of scope

Review-comment enrichment (already structured), the GitHub machine-account identity swap (ops task), Linear rendering changes (honest-ledger plan), auto-rerunning failed checks, storing full logs.
