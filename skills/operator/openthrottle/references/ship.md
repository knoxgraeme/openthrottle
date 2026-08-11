# Ship

Use `openthrottle ship` only after explicit user intent to send or ship work
through OpenThrottle.

1. Resolve the repository root and confirm `.openthrottle.yml` exists.
2. If the target is a directory or ambiguous path, run the CLI dry-run JSON flow
   once OPE-145 provides it and show the disambiguation result instead of
   guessing. Ambiguity stops the workflow.
3. If the user explicitly asks for the structured graph, validate or prepare
   the execution block before shipping:

   - When the plan already contains an execution block, use the read-only
     validation command:

     ```bash
     openthrottle plan validate <file.md> --graph structured --json
     ```

   - When the plan lacks a valid execution block, explain that `prepare` writes
     the execution block into the plan file in place and obtain the user's
     explicit authorization for that write. This is not a read-only preview or
     dry run. Only then run preparation and independently validate the written
     plan:

     ```bash
     openthrottle plan prepare <file.md> --graph structured --json
     openthrottle plan validate <file.md> --graph structured --json
     ```

   Surface the validated digest from the validation JSON output. If preparation
   or validation fails, stop without shipping. Never trigger a prose-only ticket
   as structured and never fall back to `simple`.
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

5. Report only the ticket URL and graph/selection that the current command
   output actually provides. Then run `openthrottle status <ticket>` when a
   ticket identifier is available.
6. Ticket reuse, trigger-state JSON, and recovery commands are capability-gated
   future paths until OPE-145 adds those CLI contracts. Do not claim or infer
   them from current `ship` output.
