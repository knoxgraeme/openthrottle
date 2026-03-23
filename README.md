<p align="center">
  <img src="assets/banner.jpg" alt="Open Throttle" width="100%" />
</p>

Ship prompts to autonomous coding agents running on [Daytona](https://daytona.io) sandboxes. Write a prompt, ship it, get a PR back.

## How it works

1. You write a prompt describing a feature, bug fix, or task
2. You label a GitHub Issue `prd-queued` (or use `/openthrottle-ship`)
3. A GitHub Action creates an ephemeral Daytona sandbox
4. The builder implements the work and opens a PR
5. The reviewer reviews the PR against the original task
6. You get a Telegram notification when the PR is ready
7. Sandbox auto-deletes — zero cost when idle

Ship multiple prompts — they run **in parallel** (one sandbox each):

```bash
npx openthrottle ship auth.md
npx openthrottle ship billing.md
npx openthrottle ship search.md
# → 3 sandboxes spin up simultaneously
```

## Quick start

### 1. Set up your project (~2 minutes)

```bash
npx openthrottle init
```

This will:
- Detect your project (package manager, commands, base branch)
- Generate `.openthrottle.yml`
- Copy `.github/workflows/wake-sandbox.yml`
- Create a Daytona snapshot

Requires `DAYTONA_API_KEY` — get one at [daytona.io/dashboard](https://daytona.io/dashboard).

### 2. Set GitHub repo secrets

| Secret | Required | Source |
|---|---|---|
| `DAYTONA_API_KEY` | Yes | [daytona.io/dashboard](https://daytona.io/dashboard) |
| `ANTHROPIC_API_KEY` | Claude (option A) | [console.anthropic.com](https://console.anthropic.com) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude (option B) | `claude setup-token` (valid 1 year) |
| `OPENAI_API_KEY` | Codex / Aider | [platform.openai.com](https://platform.openai.com) |
| `TELEGRAM_BOT_TOKEN` | Optional | [@BotFather](https://t.me/botfather) |
| `TELEGRAM_CHAT_ID` | Optional | Telegram getUpdates API |
| `SUPABASE_ACCESS_TOKEN` | Optional | [supabase.com/dashboard](https://supabase.com/dashboard) |

### 3. Commit and push

```bash
git add .openthrottle.yml .github/workflows/wake-sandbox.yml
git commit -m "feat: add openthrottle config"
git push
```

### 4. Ship a prompt

```bash
npx openthrottle ship docs/prds/search.md
```

Or via Claude Code: `/openthrottle-ship docs/prds/search.md`

## Config

`.openthrottle.yml` is generated during setup and committed to your repo:

```yaml
base_branch: main
test: pnpm test
build: pnpm build
lint: pnpm lint
format: pnpm prettier --write
dev: pnpm dev --port 8080 --hostname 0.0.0.0

agent: claude                              # claude | codex | aider
snapshot: openthrottle
notifications: telegram

post_bootstrap:
  - pnpm install

mcp_servers: {}

limits:
  max_turns: 200                           # max agentic turns per run
  max_budget_usd: 5.00                     # max USD per run (API keys only)
  task_timeout: 7200                       # wall-clock timeout in seconds

review:
  enabled: true
  max_rounds: 3
```

### MCP servers

Add project-specific MCPs. Telegram and Context7 are always included automatically.

```yaml
mcp_servers:
  supabase:
    command: npx
    args: ["-y", "@supabase/mcp-server"]
    env:
      SUPABASE_ACCESS_TOKEN: from-env
```

`from-env` values are resolved from sandbox environment variables at boot.

**Supabase safety:** When detected, a tool allowlist is applied — only branch management and read-only operations are permitted. `execute_sql`, `apply_migration`, `deploy_edge_function`, and `merge_branch` are blocked.

## Task lifecycle

| Trigger | What happens |
|---|---|
| Issue labeled `prd-queued` | Builder implements feature, opens PR |
| Issue labeled `bug-queued` | Builder fixes bug, opens PR |
| PR labeled `needs-review` | Reviewer runs task-aware review |
| Issue labeled `needs-investigation` | Reviewer investigates, posts findings |
| PR gets `changes_requested` review | Builder applies fixes, re-requests review |

Labels track state through each workflow:

```
PRDs:     prd-queued → prd-running → prd-complete / prd-failed
Bugs:     bug-queued → bug-running → bug-complete / bug-failed
Reviews:  needs-review → reviewing → approved / changes_requested
```

## Architecture

```
npx openthrottle init          ← one-time setup
git push                       ← .openthrottle.yml + wake workflow committed
                                      │
                                      ▼
Issue labeled prd-queued        GitHub Action fires
                                      │
                                      ▼
                               Daytona Sandbox
                              ┌──────────────────┐
                              │  entrypoint.sh    │
                              │  ├─ clone repo    │
                              │  ├─ read config   │
                              │  ├─ install deps  │
                              │  ├─ wire hooks    │
                              │  └─ dispatch:     │
                              │     prd/bug/fix   │ → run-builder.sh
                              │     review/invest │ → run-reviewer.sh
                              │                   │
                              │  Safety layers:   │
                              │  ├─ git pre-push  │ (universal)
                              │  ├─ PreToolUse    │ (Claude)
                              │  ├─ sealed config │ (chattr +i)
                              │  └─ sanitization  │ (secrets in logs)
                              │                   │
                              │  Artifacts:       │
                              │  ├─ PR + commits  │
                              │  ├─ session report│
                              │  └─ Telegram msg  │
                              └──────────────────┘
                                      │
                              auto-deleted on stop
```

Each sandbox is ephemeral — created per task, destroyed after. Session data persists on a Daytona volume for `--resume` across sandboxes.

## Security

The agent runs with `--dangerously-skip-permissions`. Safety comes from defense in depth:

| Layer | Prevents | Bypassable? |
|---|---|---|
| GitHub branch protection | Push to main, force push | No |
| Sealed settings.json | Removing hooks or allowlists | No (chattr +i) |
| Supabase MCP allowlist | SQL execution, migrations | No |
| Fine-grained PAT | Repo deletion, org access | No |
| Git pre-push hook | Push to main (all agents) | No (config sealed) |
| PreToolUse hooks | Secret exfiltration, config tampering | Difficult (Claude only) |
| Secret sanitization | Token leakage in logs/comments | Partial |
| Ephemeral sandbox | Persistent damage | N/A |

**Requirements:**
- GitHub branch protection enabled (require PR reviews, no direct push)
- Fine-grained PAT: `contents:rw`, `pull_requests:rw`, `issues:rw` — deny admin/actions/secrets

## CLI

Requires [gh CLI](https://cli.github.com) installed and authenticated.

| Command | What it does |
|---|---|
| `npx openthrottle init` | Set up Open Throttle in your project |
| `npx openthrottle ship <file.md>` | Create a GitHub issue to trigger a sandbox |
| `npx openthrottle ship <file.md> --base dev` | Target a non-default branch |
| `npx openthrottle status` | Show running, queued, and completed tasks |
| `npx openthrottle logs` | Show recent GitHub Actions workflow runs |

### Claude Code plugin (optional)

The plugin adds `/openthrottle-ship` as a skill in Claude Code, delegating to the CLI above. It's optional — the CLI works standalone.

```bash
claude plugin install knoxgraeme/openthrottle
```

## License

MIT
