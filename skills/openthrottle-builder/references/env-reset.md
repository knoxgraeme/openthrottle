# Environment Reset

If the environment is broken (missing tools, corrupted `node_modules`, broken
global packages, commands that should work but don't), you can request an
environment reset. This preserves your work and creates a continuation task.

The reset mechanism exists because Sprite environments can accumulate state
(global installs, corrupted caches) that can't be fixed with simple retries.
Rather than waste time debugging the environment, signal for a clean reset
and the runner script handles the rest.

## When to request a reset

- `pnpm` or `node` commands fail with unexpected errors
- Build tools are missing or corrupted
- Global state is broken after a task ran `npm install -g`, `apt install`, etc.
- You've tried basic fixes (`pnpm install`, clearing caches) and they didn't help

## How to request a reset

1. **Push your current work** — commit and push whatever you have. Your work
   survives only if it's on the remote.
2. **Write the signal file** — create `/home/sprite/env-reset-request.json`:

```json
{
  "original_issue": 42,
  "original_type": "prd",
  "title": "Add billing webhooks",
  "branch": "feat/prd-42",
  "base_branch": "main",
  "reason": "pnpm command not found after global npm install corrupted PATH",
  "remaining_work": "- Webhook signature verification\n- Retry logic for failed deliveries",
  "context": "Branch has base webhook handler and Stripe integration. Tests for those pass."
}
```

3. **Exit** — stop working. The runner script will:
   - Pause the original issue (label: `prd-paused` / `bug-paused`)
   - Create a continuation issue referencing the original
   - Repair the environment (reinstall deps, clear caches)
   - Pick up the continuation issue on the next poll iteration

The continuation issue will include your branch name, remaining work, and
context. When you complete it, the PR should close both the continuation and
the original issue.

## What NOT to do

- **Never run `sprite checkpoint restore`** — it terminates your running session
- **Don't keep retrying** broken commands — if the env is bad, signal and exit
- **Don't skip the push** — unpushed work is lost during env repair
