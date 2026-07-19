# Skills

These are thin OpenThrottle task adapters. They connect Fly's deterministic
task state machine, branch boundary, activity outbox, and Linear/GitHub
publication contract to native Compound Engineering skills installed in the
Daytona image.

```text
skills/
  claude/<name>/SKILL.md   # user-level Claude adapter
  codex/<name>.md          # prompt piped to codex exec
  codex/AGENTS-fragment.md # standing Codex runtime instructions
```

The four adapters are `implement-plan`, `review`, `review-fix`, and
`investigate`. Resume does not start an adapter; it resumes the saved native
Claude session or Codex thread.

## Native CE composition

| OpenThrottle task | Native CE pipeline |
|---|---|
| `implement` | `ce-work mode:return-to-caller` → `ce-code-review apply:local` → `ce-commit-push-pr mode:pipeline` → `ce-babysit-pr mode:pipeline` |
| `review` | `ce-code-review mode:agent`, followed by one comment-based verdict |
| `review-fix` | `ce-resolve-pr-feedback mode:pipeline` → `ce-babysit-pr mode:pipeline` |
| `investigate` | `ce-debug mode:pipeline`; if fixed, create/find the PR and run `ce-babysit-pr mode:pipeline` |

The snapshot installs the official `compound-engineering` plugin natively for
both Claude Code and Codex from one commit-pinned marketplace checkout. Do not
copy CE source into this directory or into target repositories: native install
preserves its skill-local reviewer/research assets and makes every target repo
use the same version.

## Adapter-owned rules

The adapters remain necessary for contracts that CE does not own:

- The hard approved-plan gate before implementation.
- The existing checked-out branch and sealed never-push-to-base boundary.
- `ot-activity` semantic events; Fly alone holds Linear app credentials and
  publishes as OpenThrottle.
- Comment-only review verdicts because the app identity cannot approve its own
  PR and a human owns merge.
- Fly's deterministic fresh re-review after a successful review-fix.
- Prompt-injection treatment for ticket, repository, and review content.

`investigate` is deliberately action-capable. Native `ce-debug mode:pipeline`
may diagnose, test, fix, commit, and push a convergent bug. Product/design
decisions and other divergent fixes remain needs-human residuals.

## Keeping Claude and Codex aligned

Both forms must preserve the same task ordering and product boundaries. The
only intentional differences are native invocation syntax (`/ce-*` for Claude,
`$ce-*` for Codex), Claude YAML frontmatter, and Codex's appended runtime
context. When changing a task, update and review both forms together.

Codex receives `AGENTS-fragment.md` globally at `~/.codex/AGENTS.md`, outside
the checkout. It provides standing environment, safety, sanitization, and
activity rules without modifying a target repository's own `AGENTS.md`.
