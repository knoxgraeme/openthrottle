---
name: repair-unit
description: Repairs one failed structured OpenThrottle unit loop and returns a standard unit completion receipt.
---

# OpenThrottle unit repair adapter

Use only the sealed failure/revision context for the current unit and the
provided worktree. Repair the unit, then locally verify the targeted fix.

Invoke native Compound Engineering as:

```text
ce-work mode:return-to-caller <unit repair context supplied in the loop context>
```

Do not widen scope, commit, integrate, publish, or run whole-change code
review. Finish by returning one `openthrottle.receipt/v1` `unit_completion`
receipt.
