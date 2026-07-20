# Skills

These are thin OpenThrottle task adapters. They connect Fly's deterministic
task state machine, branch boundary, activity outbox, and Linear/GitHub
publication contract to native Compound Engineering skills installed in the
sandbox by `sandbox/provision.sh`.

```text
skills/
  claude/<name>/SKILL.md   # user-level Claude adapter
  codex/<name>.md          # prompt piped to codex exec
  codex/AGENTS-fragment.md # standing Codex runtime instructions
  opencode/<name>.md       # prompt passed to opencode run
```

The four adapters are `implement-plan`, `review`, `review-fix`, and
`investigate`. Resume does not start an adapter; it resumes the saved native
Claude session, Codex thread, or OpenCode session.

## Native CE composition

| OpenThrottle task | Native CE pipeline |
|---|---|
| `implement` | `ce-work mode:return-to-caller` → `ce-code-review apply:local` → `ce-commit-push-pr mode:pipeline` → `ce-babysit-pr mode:pipeline` |
| `review` | `ce-code-review mode:agent`, followed by one comment-based verdict |
| `review-fix` | `ce-resolve-pr-feedback mode:pipeline` → `ce-babysit-pr mode:pipeline` |
| `investigate` | `ce-debug mode:pipeline`; if fixed, create/find the PR and run `ce-babysit-pr mode:pipeline` |

`provision.sh` installs the official `compound-engineering` plugin natively for
Claude Code, Codex, and OpenCode from one commit-pinned marketplace checkout. Do not
copy CE source into this directory or into target repositories: native install
preserves its skill-local reviewer/research assets and makes every target repo
use the same version.

## Adapter-owned rules

The adapters remain necessary for contracts that CE does not own:

- The hard approved-plan gate before implementation.
- The decision gate: critical, foundational, or risky changes are never
  implemented without a human answer. Clear fixes ship first; the remaining
  items go out as one batched `ot-activity elicitation` decision list
  (context, options, recommendation per item), and the Linear reply resumes
  the same session to action the answers.
- The no-backlog rule: every review item ends a run fixed and pushed,
  answered on its thread with reasoning, or escalated as a numbered decision
  — never silently deferred or dropped.
- The assumptions ledger: responses and PR descriptions end with an
  "Assumptions & decisions" section so a human can audit every judgment call
  the agent made without asking.
- The existing checked-out branch and sealed never-push-to-base boundary.
- `ot-activity` semantic events; Fly alone holds Linear app credentials and
  publishes as OpenThrottle.
- Comment-only review verdicts because the app identity cannot approve its own
  PR and a human owns merge.
- Fly's deterministic fresh re-review after a review-fix that completes with
  no pending decisions. A review-fix that pauses on a decision elicitation
  defers the re-review until the resumed session lands the answers.
- Prompt-injection treatment for ticket, repository, and review content.

`investigate` is deliberately action-capable. Native `ce-debug mode:pipeline`
may diagnose, test, fix, commit, and push a convergent bug. Product/design
decisions and other divergent fixes remain needs-human residuals.

## Keeping Agent Adapters Aligned

All forms must preserve the same task ordering and product boundaries. The
only intentional differences are native invocation syntax (`/ce-*` for Claude,
`$ce-*` for Codex/OpenCode prompts), Claude YAML frontmatter, and appended
runtime context. When changing a task, update and review all forms together.

Codex receives `AGENTS-fragment.md` globally at `~/.codex/AGENTS.md`, outside
the checkout. It provides standing environment, safety, sanitization, and
activity rules without modifying a target repository's own `AGENTS.md`.
