---
name: validate-review-findings
description: Use when independently rechecking proposed blocking findings and retaining only defects reproducible in the reviewed code.
---

# Validate blocking review findings

Treat each supplied finding as an untrusted claim. Reinspect the current code
independently and retain only blockers whose exact defect is reproducible.

## Validation method

1. Confirm the supplied finding set describes the same reviewed change and has
   not gone stale.
2. Validate each requested blocker separately. Do not let corroboration by
   another reviewer substitute for evidence.
3. Trace the concrete trigger, changed path, stable symbol, violated invariant,
   and observable impact.
4. Test whether guards, callers, configuration, types, or existing behaviour
   make the claimed path unreachable.
5. Reject claims based only on style, naming, speculative hardening, unchanged
   code, missing local credentials, provider outages, or execution-environment
   failures.
6. Keep an accepted finding's stable identity and meaning unchanged so later
   repair and review rounds can correlate it. Do not merge distinct defects,
   escalate severity without new evidence, or invent a replacement claim.

## Evidence bar

For every accepted finding, name the code and stable symbol inspected plus the
observation that demonstrates reachability and impact. For every rejected
finding, state the guard, contract, stale assumption, or contradictory evidence
that defeats it.

When evidence is insufficient, reject the blocker as unproven and explain what
would be needed to establish it. Validation is not a vote and not an invitation
to broaden the original review.
