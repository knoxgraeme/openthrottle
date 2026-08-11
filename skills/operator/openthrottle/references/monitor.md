# Monitor

Use this path for read-only OpenThrottle run inspection and human-action
questions.

1. Prefer `openthrottle status` and include a ticket identifier when the user
   supplied one:

   ```bash
   openthrottle status <ticket>
   ```

2. Summarize whose move it is, the current stage/status, any PR URL, and the
   next recovery or human action shown by the CLI.
3. For deeper diagnosis, use `openthrottle logs <ticket>` only when the user
   asks for logs or the status output points to logs as the recovery path.
4. Do not poll provider APIs or claim provider mutation/completion without CLI
   evidence.
