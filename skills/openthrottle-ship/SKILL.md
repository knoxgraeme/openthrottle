---
name: openthrottle-ship
description: >
  Ship prompts to Daytona sandboxes, check status, or view recent activity.
  Use when: "ship this prompt", "queue prompt", "check status", "what's running",
  or any interaction with Open Throttle. Run `npx create-openthrottle` first
  if the pipeline hasn't been set up yet.
disable-model-invocation: true
argument-hint: [prompt-file.md | status] [--base branch]
---

# Ship Prompt

Ship prompts and check status via the `openthrottle` CLI.

---

## Actions

### Ship a Prompt

When the user wants to ship/push/send/submit a prompt file:

```bash
npx openthrottle ship "<file>" [--base <branch>]
```

If `--base` is specified by the user, pass it through. Otherwise omit it
(the CLI reads `.openthrottle.yml` for the default).

For multiple prompts, run the command once per file.

Report the output to the user verbatim.

---

### Check Status

```bash
npx openthrottle status
```

Report the output to the user verbatim.

---

### View Logs

```bash
npx openthrottle logs
```

Report the output to the user verbatim.
