---
name: publish
description: Publishes the already gated OpenThrottle subject through the standard CE PR adapter.
---

# OpenThrottle publish adapter

Publish only the already-gated subject named by the sealed stage context.

Invoke native Compound Engineering as:

```text
ce-commit-push-pr mode:pipeline branding:on
```

Ensure the PR targets `$BASE_BRANCH`, update `## OpenThrottle gates` from the
supplied evidence, and do not wait for provider feedback. Finish by returning
one `openthrottle.receipt/v1` `publish_subject` receipt.
