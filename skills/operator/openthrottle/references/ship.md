# Ship

Use `openthrottle ship` only after explicit user intent to send or ship work
through OpenThrottle.

1. Resolve the repository root and confirm `.openthrottle.yml` exists.
2. If the target is a directory or ambiguous path, run the CLI dry-run JSON flow
   once OPE-145 provides it and show the disambiguation result instead of
   guessing. Ambiguity stops the workflow.
3. If the user explicitly asks for the structured graph, validate or prepare
   the execution block before shipping:

   - When the plan already contains an execution block, run:

     ```bash
     openthrottle plan validate <file.md> --graph structured --json
     ```

   - When the plan lacks a valid execution block, run:

     ```bash
     openthrottle plan prepare <file.md> --graph structured --json
     ```

   Surface the validated digest from the JSON output. If validation or
   preparation fails, stop. Never trigger a prose-only ticket as structured and
   never fall back to `simple`.
4. For a concrete markdown plan file today, run the currently supported CLI
   invocation without adding unsupported flags:

   ```bash
   openthrottle ship <file.md>
   ```

   For structured shipping after validation/preparation, include the explicit
   graph selection:

   ```bash
   openthrottle ship <file.md> --graph structured
   ```

5. Report the CLI-evidenced created or reused ticket URL, graph/selection, and
   trigger state from the command output. Then run `openthrottle status
   <ticket>` when a ticket identifier is available.
6. If the CLI reports that a ticket exists but delegation/trigger failed, show
   its recovery command and reuse that ticket on the next explicit attempt.
