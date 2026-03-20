# Soda Prompts

Ship prompts to autonomous coding agents running on [Daytona](https://daytona.io) sandboxes. Write a prompt, ship it, get a PR back.

## How it works

1. You write a prompt describing a feature, bug fix, or task
2. You label a GitHub Issue `prd-queued` (or use `/sodaprompts-ship`)
3. A GitHub Action creates an ephemeral Daytona sandbox
4. The builder implements the work and opens a PR
5. The reviewer reviews the PR against the original task
6. You get a Telegram notification when the PR is ready
7. Sandbox auto-deletes — zero cost when idle

Ship multiple prompts — they run **in parallel** (one sandbox each):

```bash
gh issue create --title "Auth" --body-file auth.md --label prd-queued
gh issue create --title "Billing" --body-file billing.md --label prd-queued
gh issue create --title "Search" --body-file search.md --label prd-queued
# → 3 sandboxes spin up simultaneously
```

## Quick start

### 1. Set up your project (~2 minutes)

```bash
npx create-sodaprompts
```

This will:
- Detect your project (package manager, commands, base branch)
- Generate `.sodaprompts.yml`
- Copy `.github/workflows/wake-sandbox.yml`
- Create a Daytona snapshot and volume

Requires `DAYTONA_API_KEY` — get one at [daytona.io/dashboard](https://daytona.io/dashboard).

### 2. Set GitHub repo secrets

Pick one auth method:

| Secret | Required | Source |
|---|---|---|
| `DAYTONA_API_KEY` | Yes | [daytona.io/dashboard](https://daytona.io/dashboard) |
| `ANTHROPIC_API_KEY` | Option A | [console.anthropic.com](https://console.anthropic.com) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Option B | `claude setup-token` (valid 1 year) |
| `OPENAI_API_KEY` | For Codex/Aider | [platform.openai.com](https://platform.openai.com) |
| `TELEGRAM_BOT_TOKEN` | Optional | [@BotFather](https://t.me/botfather) |
| `TELEGRAM_CHAT_ID` | Optional | Telegram getUpdates API |
| `SUPABASE_ACCESS_TOKEN` | Optional | [supabase.com/dashboard](https://supabase.com/dashboard) |

### 3. Commit and push

```bash
git add .sodaprompts.yml .github/workflows/wake-sandbox.yml
git commit -m "feat: add sodaprompts config"
git push
```

### 4. Ship a prompt

```bash
gh issue create --title "Add search feature" \
  --body-file docs/prds/search.md \
  --label prd-queued
```

Or from Claude Code: `/sodaprompts-ship docs/prds/search.md`

## How tasks flow

| Trigger | What happens |
|---|---|
| Issue labeled `prd-queued` | Builder implements feature, opens PR |
| Issue labeled `bug-queued` | Builder fixes bug, opens PR |
| PR labeled `needs-review` | Reviewer runs task-aware review |
| Issue labeled `needs-investigation` | Reviewer investigates, posts findings |
| PR gets `changes_requested` review | Builder applies fixes, re-requests review |

State machine labels:
- PRDs: `prd-queued` → `prd-running` → `prd-complete` / `prd-failed`
- Bugs: `bug-queued` → `bug-running` → `bug-complete` / `bug-failed`
- Reviews: `needs-review` → `reviewing` → approved / changes_requested

## Config

`.sodaprompts.yml` is generated during setup and committed to your repo:

```yaml
base_branch: main
test: pnpm test
build: pnpm build
lint: pnpm lint
format: pnpm prettier --write
dev: pnpm dev --port 8080 --hostname 0.0.0.0

agent: claude                              # claude | codex | aider
snapshot: sodaprompts-doer-claude-node
notifications: telegram

post_bootstrap:
  - pnpm install

mcp_servers: {}

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

## Architecture

```
npx create-sodaprompts          ← one-time setup
git push                        ← .sodaprompts.yml + wake workflow committed
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

## Snapshot modes

During `npx create-sodaprompts`, you choose how the sandbox image is created:

**Pre-built image (default):** Uses `ghcr.io/sodaprompts/doer-claude:node-1.0.0` — fast, no customization needed. The scaffolder creates the Daytona snapshot automatically.

**Build from Dockerfile:** Copies the Dockerfile + runtime scripts into `.sodaprompts/docker/` in your project. You can customize the image (add system packages, tools, different Node version), then create the snapshot yourself:

```bash
daytona snapshot create sodaprompts-doer-claude-node \
  --dockerfile .sodaprompts/docker/Dockerfile \
  --build-arg AGENT=claude
```

## Multi-agent support

The runtime supports Claude Code, Codex, and Aider. Set `agent` in `.sodaprompts.yml`:

```yaml
agent: codex   # claude | codex | aider
```

The Dockerfile uses a build arg to install the right agent CLI:

```bash
docker build --build-arg AGENT=codex -t ghcr.io/sodaprompts/doer-codex:node-1.0.0 daytona/
```

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

## Commands

| Command | What it does |
|---|---|
| `/sodaprompts-ship <file.md>` | Ship a prompt via GitHub Issues |
| `/sodaprompts-ship status` | Check status from GitHub |
| `/sodaprompts-ship logs` | Stream sandbox logs |
| `/sodaprompts-ship kill` | Stop the running sandbox |

## Claude Code plugin (optional)

The Claude Code plugin adds `/sodaprompts-ship` and `/sodaprompts-setup` skills for a richer onboarding experience. It's optional — `npx create-sodaprompts` works without it.

```bash
claude plugin install knoxgraeme/sodaprompts
```

## License

MIT
