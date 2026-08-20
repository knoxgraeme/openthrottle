---
name: reliability-adversarial
description: Use when reviewing retries, replay, ordering, idempotency, partial failure, or silent-success risks.
---

# Reliability adversarial review

Look for defects that survive happy-path tests: duplicated work, lost work,
out-of-order settlement, non-idempotent replay, and success recorded before a
required effect completes.

## Review method

1. Trace every changed retry, queue, webhook, lease, reducer, journal, drain,
   or asynchronous settlement path.
2. Test the mental model against duplicate, late, stale, missing, and reordered
   events.
3. Identify the durable identity that makes replay safe. Check whether partial
   failure can create a second row, request, message, or external effect.
4. Verify progress is recorded only after the operation it depends on is
   durably complete.
5. Inspect empty evidence, swallowed errors, skipped work, default-success
   branches, and missing state that may be mistaken for success.
6. Compare retry behaviour across layers so framework retry, application
   fallback, and caller replay do not multiply one another.

## Finding bar

Report only a reachable path introduced or changed by the work. Name the
trigger, state transition, stable symbol, violated reliability invariant, and
duplicate, lost, stuck, or falsely successful outcome. Trace direct local
callers and callees only as far as needed to prove the path.

## Exclusions

Do not report provider outages, generic network flakiness, missing local tools,
executor crashes, broad hardening, logging preferences, unchanged reliability
debt, or timing concerns with no changed semantic contract.
