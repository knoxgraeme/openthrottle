---
name: simplify-unit
description: Simplifies one structured OpenThrottle unit worktree and returns a standard unit completion receipt.
---

# OpenThrottle unit simplification adapter

Execute only the sealed unit simplification loop in the provided worktree.

Invoke native Compound Engineering as:

```text
ce-simplify-code
```

Preserve behavior, keep edits scoped to the current unit, and do not commit,
integrate, publish, or perform code review. Finish by returning one
`openthrottle.receipt/v1` `unit_completion` receipt with semantic assurance and
the unit verification evidence.
