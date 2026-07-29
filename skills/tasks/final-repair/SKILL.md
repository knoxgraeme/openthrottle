---
name: final-repair
description: Repairs whole-change final gate failures in an executor-owned worktree.
---

# OpenThrottle final repair adapter

Use only the sealed whole-change command/review failure context in the provided
exact-base repair worktree. The whole-change repair budget is intentionally
larger than per-unit repair because final review owns the correctness backstop.

Invoke native Compound Engineering as:

```text
ce-work mode:return-to-caller <final repair context supplied in the loop context>
```

Do not mutate the integration checkout directly, commit outside the executor
candidate path, publish, or claim gate authority. Finish by returning one
`openthrottle.receipt/v1` `unit_completion` receipt for the final repair
attempt.
