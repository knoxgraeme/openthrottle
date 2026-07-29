---
name: final-review
description: Performs the single whole-change review for a structured OpenThrottle graph.
---

# OpenThrottle final review adapter

Run the whole-change semantic review only after configured whole-change command
evidence is present for the exact integrated subject.

Invoke native Compound Engineering as:

```text
ce-code-review apply:local base:origin/$BASE_BRANCH
```

Review the integrated whole once. Do not review individual units here and do
not publish. Finish by returning one `openthrottle.receipt/v1`
`semantic_review` receipt bound to the integrated subject.
