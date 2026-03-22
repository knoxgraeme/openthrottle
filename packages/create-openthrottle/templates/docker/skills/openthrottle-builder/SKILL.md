---
name: openthrottle-builder
description: >
  Builder sandbox skill — pointer to prompt templates.
  Full instructions are delivered via the invoking prompt.
user-invocable: false
---

# Open Throttle — Builder

Your full instructions were provided in the prompt that invoked you via
`run-builder.sh`. Follow those instructions.

If you were invoked interactively (no task prompt), read the relevant
template at `/opt/openthrottle/prompts/`:
- `prd.md` — new feature workflow
- `bug.md` — bug fix workflow
- `review-fix.md` — review fix workflow
