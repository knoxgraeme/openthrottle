---
name: accept-unit
description: Makes a minimal lead scope-match decision for one structured OpenThrottle unit.
---

# OpenThrottle unit acceptance adapter

Return exactly one `openthrottle.receipt/v1` `unit_decision` receipt:
`accept`, `revise`, `context_update`, or `needs_human`.

This is a lead plan/feature/scope-match judgment over the assigned unit
envelope, worker completion receipt, executor-derived candidate evidence,
configured command receipts, current integration context, and accepted
downstream context. It is not a code review. Do not invoke `ce-code-review`,
write code, call worker tools, mutate the graph, commit, integrate, publish, or
claim gate authority.
