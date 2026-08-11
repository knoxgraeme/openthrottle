# Ship

Use `openthrottle ship` only after explicit user intent to send or ship work
through OpenThrottle.

1. Resolve the repository root and confirm `.openthrottle.yml` exists.
2. If the target is a directory or ambiguous path, run the CLI dry-run JSON flow
   once OPE-145 provides it and show the disambiguation result instead of
   guessing.
3. For a concrete markdown plan file today, run:

   ```bash
   openthrottle ship <file.md> --json
   ```

4. Report the CLI-evidenced created or reused ticket URL, graph/selection, and
   trigger state. Then run `openthrottle status <ticket>` when a ticket
   identifier is available.
5. If the CLI reports that a ticket exists but delegation/trigger failed, show
   its recovery command and reuse that ticket on the next explicit attempt.
