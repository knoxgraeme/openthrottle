# Soda Prompts

Ship prompts to autonomous Claude Code agents running on [Sprites](https://sprites.dev). Write a prompt, ship it, get a PR back.

## How it works

1. You write a prompt describing a feature, bug fix, or task
2. `/sodaprompts-ship` creates a GitHub Issue labeled `prd-queued`
3. A GitHub Action wakes the Doer Sprite (zero cost when idle)
4. The Doer claims the issue, implements the work, and opens a PR
5. The Thinker Sprite wakes, reviews the PR against the original task, and posts findings
6. You get a Telegram notification when the PR is ready

The agents use [Compound Engineering](https://github.com/every-env/compound-engineering) for structured planning, implementation, and review.

## Architecture — Doer & Thinker Sprites

Two sprites work together. All state lives on GitHub (labels, reviews, comments) —
checkpoint restore loses nothing.

**Doer Sprite** (builder) polls for:
1. PRs with `changes_requested` reviews — applies fixes, re-requests review
2. Issues labeled `bug-queued` — reads investigation report (if available), creates branch, fixes, PRs
3. Issues labeled `prd-queued` — claims issue, full prompt-to-PR workflow

**Thinker Sprite** (reviewer) polls for:
1. PRs labeled `needs-review` — checks out the branch, gathers the linked issue for task context, runs a task-aware review (alignment, best practices, security, triage of builder's deferred items), can commit trivial fixes directly
2. Issues labeled `needs-investigation` — analyzes codebase, posts investigation report

State machine labels:
- PRDs: `prd-queued` → `prd-running` → `prd-complete` / `prd-failed` / `prd-paused`
- Bugs: `needs-investigation` → `investigating` → `bug-queued` → `bug-running` → `bug-complete` / `bug-failed` / `bug-paused`
- Reviews: `needs-review` → `reviewing` → approved / changes_requested
- Paused states (`prd-paused` / `bug-paused`) occur during environment resets — a continuation issue is created automatically

## Install

```bash
claude plugin install knoxgraeme/sodaprompts
```

## Prerequisites

- [Sprites CLI](https://sprites.dev) — `curl -fsSL https://sprites.dev/install.sh | sh`
- [GitHub CLI](https://cli.github.com) — `brew install gh`
- [Claude Code](https://claude.ai/code) with a Max subscription
- A [Telegram bot](https://core.telegram.org/bots#botfather) for notifications

## Quick start

### 1. Add secrets to your `.env`

Add these to the root `.env` in your project (create one if it doesn't exist):

```bash
GITHUB_TOKEN=ghp_your-github-pat        # GitHub PAT with repo scope
GITHUB_REPO=owner/repo                  # auto-detected during setup
TELEGRAM_BOT_TOKEN=123:ABC-xyz          # from @BotFather
TELEGRAM_CHAT_ID=123456789              # from getUpdates API
```

Your existing project secrets (database URLs, API keys, etc.) stay in `.env` too — they all get pushed to the Sprite.

> **Note:** `SPRITES_TOKEN` is not needed in `.env`. The sprite CLI authenticates
> via `sprite login`. `SPRITES_TOKEN` is only needed as a GitHub Actions secret
> (for the wake workflow).

### 2. Set up your project

```bash
claude
> /sodaprompts-setup
```

This will:
- Detect your project (test commands, package manager, monorepo structure)
- Generate `.sodaprompts.yml` (commit this to your repo)
- Create a Sprite and bootstrap it with tools, hooks, and skills
- Install `.github/workflows/wake-sprite.yml` (wakes sprites on new work)
- Checkpoint as `golden-base`
- Optionally set up a Thinker Sprite for automated PR review

### 3. Ship a prompt

```bash
> /sodaprompts-ship docs/prds/add-search.md
```

That's it. You'll get a Telegram message when the PR is ready.

## Commands

| Command | What it does |
|---|---|
| `/sodaprompts-ship <file.md>` | Ship a prompt via GitHub Issues |
| `/sodaprompts-ship status` | Check status from GitHub (issues, PRs, reviews) |
| `/sodaprompts-ship logs` | Tail the active session's log (sprite exec) |
| `/sodaprompts-ship kill` | Stop the running session (sprite exec) |
| `/sodaprompts-ship push-env` | Push updated `.env` files + re-checkpoint |

Status reads from GitHub, not the sprite filesystem — it works even after a checkpoint restore.

Ship multiple prompts — they queue as GitHub Issues automatically:

```bash
> /sodaprompts-ship docs/prds/auth.md
> /sodaprompts-ship docs/prds/billing.md
> /sodaprompts-ship docs/prds/search.md
```

## Telegram commands

Control the Sprite from your phone:

| Command | What it does |
|---|---|
| `/status` | What's running, queue, completions |
| `/logs` | Last 20 lines of the active log |
| `/queue` | Show queued prompts |
| `/kill` | Stop the running session |
| `/help` | List commands |

## Config

`.sodaprompts.yml` is generated during setup and committed to your repo:

```yaml
base_branch: main
test: pnpm test
dev: pnpm dev --port 8080 --hostname 0.0.0.0
format: pnpm prettier --write
lint: pnpm lint
build: pnpm build
notifications: telegram
sprite: soda-base
post_bootstrap:
  - pnpm install
mcp_servers: {}
```

### MCP servers

Add project-specific MCPs to `.sodaprompts.yml`. Telegram and Context7 are always included automatically.

```yaml
mcp_servers:
  supabase:
    command: npx
    args: ["-y", "@supabase/mcp-server"]
    env:
      SUPABASE_ACCESS_TOKEN: from-env
```

**Supabase safety:** When a Supabase MCP is detected, bootstrap applies a tool **allowlist** — only safe operations are permitted (branch management, read-only introspection, docs). Tools like `execute_sql`, `apply_migration`, `deploy_edge_function`, and `merge_branch` are blocked. The agent creates short-lived Supabase branches on demand for testing, runs `supabase db push` for migrations, and destroys branches immediately after. Production is untouchable.

## What the Sprites get

During bootstrap, each sprite is set up with the tools it needs.

**Doer Sprite** (full build environment):

| Tool | Purpose |
|---|---|
| Chromium + xvfb | Headless browser runtime |
| agent-browser | AI-native web interaction |
| Playwright | Browser test execution |
| Telegram MCP | Notifications + phone-a-friend |
| Context7 MCP | Framework documentation lookup |
| Compound Engineering | Structured plan/implement/review |
| GitHub CLI | PR creation |

Plus hooks for:
- Blocking pushes to main/master
- Logging every bash command (with secret sanitization)
- Auto-formatting files on write
- Running lint + tests before session exit

**Thinker Sprite** (lighter setup):

| Tool | Purpose |
|---|---|
| GitHub CLI | Reading diffs, posting reviews, committing trivial fixes |
| Agent runtime | Claude Code or Codex |
| Skills | Reviewer (task-aware), investigator, phone-a-friend |

## PR artifacts

The Doer Sprite posts structured artifacts to each PR:

**Decision Log** — posted as a PR comment after implementation:
- Approach chosen and reasoning
- Key decisions with justification
- Deferred items (P2/P3) and why they're safe to defer
- Review notes for human attention

**Session Report** — posted as a PR comment after the session:
- Duration, commits, and files changed
- Bash commands (total / failed)
- Sanitized command log (last 50 lines, collapsible)

**Completion Artifact** — structured JSON written to the sprite filesystem:
- Status (success / failed / blocked)
- PR URL, branch, commit count
- Deferred items and notes
- Used by the runner script for reliable result detection

## Review process

The Thinker Sprite performs a task-aware final review — not a generic code quality pass (the Doer already ran ce:review for that). The review focuses on:

1. **Task alignment** — does the PR deliver what the original issue asked for, without scope drift?
2. **Best practices** — did the builder take shortcuts (hardcoded values, copy-paste, swallowed errors)?
3. **Security** — fresh eyes on auth, input handling, secrets, injection risks
4. **Builder triage** — are any deferred P2/P3 items actually blocking?
5. **Integration sanity** — duplicated logic, pattern violations, broken callers

Trivial fixes (typos, formatting) are committed directly instead of requesting changes. The review uses structured output with blocking/non-blocking categories.

**Convergence:** On re-reviews (round 2+), the reviewer focuses narrowly on whether previous blocking items were addressed. New P2/P3 findings are noted but don't block approval — this prevents infinite review loops.

## Architecture

```
Any client (Claude Code, Desktop, CLI)
┌─────────────┐
│ /ship        │── gh issue create ──┐
│ /status      │── gh issue list     │
└─────────────┘                      │
                                     ▼
                              GitHub Issues
                              + Actions webhook
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                                  ▼
             Doer Sprite                        Thinker Sprite
            ┌──────────────┐                   ┌──────────────┐
            │  run-builder  │                   │  run-reviewer │
            │               │── PR + label ───>│               │
            │  Wakes on:    │                   │  Wakes on:    │
            │  prd-queued   │<── review ───────│  needs-review │
            │  bug-queued   │                   │  needs-invest │
            │  changes_req  │                   │               │
            │               │   Artifacts:      │  Checks out   │
            │  Posts:        │   decision log    │  PR branch    │
            │  decision log │   session report   │  reads linked │
            │  session rpt  │   completion.json  │  issue for    │
            │  completion   │                   │  task context  │
            │               │                   │               │
            │  Sleeps after │                   │  Sleeps after │
            │  5m idle      │                   │  5m idle      │
            └──────────────┘                   └──────────────┘
                    │                                  │
                    └──────── Telegram ◄───────────────┘
```

## License

MIT
