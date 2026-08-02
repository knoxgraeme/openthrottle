---
name: final-review
description: Performs the single whole-change review for a structured OpenThrottle graph.
---

# OpenThrottle final review adapter

Run the whole-change semantic review only after configured whole-change command
evidence is present for the exact integrated subject.

This review is report-only and carries no edit authority. Invoke native
Compound Engineering as:

```text
ce-code-review mode:agent base:origin/$BASE_BRANCH
```

Never authorize local edits and never edit, commit, or otherwise mutate the
integrated checkout from this skill. Review the integrated whole once. Do not
review individual units here and do not publish. Any finding that warrants a
change must be routed to the dedicated final-repair action, which invalidates
this review's receipt; a repaired head requires a fresh final review and
cannot be accepted against the review this skill produced. Finish by
returning one `openthrottle.receipt/v1` `semantic_review` receipt bound to
the integrated subject.
