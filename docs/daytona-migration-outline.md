# Daytona Migration Outline

> Moving from Sprites + Claude plugin to Daytona sandboxes with agent-agnostic distribution.

## Goals

1. **Agent-agnostic** — users choose Claude, Codex, Aider, or any future agent
2. **No plugin install required** — `npx create-sodaprompts` replaces `/sodaprompts-setup` as the primary onboarding path
3. **Generic snapshot** — one published OCI image per agent runtime; project config is read at boot from `.sodaprompts.yml`
4. **Ephemeral sandboxes** — one sandbox per task, parallel by default, no long-lived state to manage
5. **Subscription + API key auth** — both supported via env vars (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`)

---

## Distribution Model

### Current (Sprites + Claude Plugin)

```
claude plugin install knoxgraeme/sodaprompts
/sodaprompts-setup          ← interactive Claude skill generates config + ships sprite
/sodaprompts-ship            ← ships prompts from Claude CLI
```

- Tightly coupled to Claude Code skill/hook system
- Codex support exists in runner scripts but onboarding is Claude-only
- Users must have Claude Code installed to set up
- Long-lived sprites with checkpoint/restore

### Target (Daytona + Scaffolder)

```
npx create-sodaprompts      ← agent-agnostic scaffolder generates config
git push                     ← .sodaprompts.yml + wake workflow committed
GitHub Action                ← creates ephemeral Daytona sandbox per task
```

- Any agent runtime supported via snapshot variants
- Claude plugin becomes optional enhancement, not requirement
- Config-driven: all project specifics live in `.sodaprompts.yml`
- Ephemeral sandboxes: create per task, destroy after, parallel by default

---

## Sandbox Architecture

### Ephemeral Model

Every task gets a fresh sandbox. No stop/start, no cleanup scripts, no stale state.

```
Issue labeled prd-queued
  → GitHub Action fires
  → Daytona SDK: create sandbox from snapshot (with env vars)
  → Entrypoint: clone repo, pnpm install, wire up config from .sodaprompts.yml
  → Builder implements, opens PR
  → Reviewer reviews (same sandbox, different skill)
  → Sandbox destroyed

3 issues queued? → 3 sandboxes in parallel. No queue needed.
```

This is how Daytona is designed to be used — sub-90ms sandbox creation from snapshots, fully stateless, spin up and throw away.

### Published Snapshot (shared by all users)

One Docker image per agent runtime, published on GHCR. Pre-installed:

- System packages: git, gh, jq, curl, chromium, xvfb
- Language runtime: Node.js + pnpm (TS-only for v1)
- Agent binary: Claude Code (v1), Codex/Aider (future)
- Sodaprompts orchestration: run-builder.sh, run-reviewer.sh, entrypoint.sh
- Default MCP servers: Telegram, Context7

```dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y git gh jq curl chromium xvfb ...
RUN npm install -g @anthropic-ai/claude-code
COPY run-builder.sh run-reviewer.sh entrypoint.sh /opt/sodaprompts/
```

Published as:

```
ghcr.io/sodaprompts/doer-claude:node-1.0.0
```

Users create a Daytona snapshot in their account pointing to this image. The scaffolder does this automatically via the Daytona SDK.

**Constraint:** Daytona does not allow `latest`/`lts`/`stable` tags — must use explicit versions (e.g., `node-1.0.0`).

Future variants (not v1):

```
ghcr.io/sodaprompts/doer-codex:node-1.0.0
ghcr.io/sodaprompts/doer-claude:python-1.0.0
ghcr.io/sodaprompts/doer-claude:full-1.0.0
```

### Why GHCR

- Free for public images
- Native GitHub Actions integration (`docker/login-action` + `docker/build-push-action`)
- Same auth model as the rest of the project (GitHub PAT)
- No separate account/billing (Docker Hub requires one)
- Org-scoped: `ghcr.io/sodaprompts/*` keeps everything under one namespace
- Explicitly supported by Daytona as a container registry source

---

## Authentication

### Two Auth Paths

| Method | Env var | Source | For whom |
|---|---|---|---|
| API key | `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) | Pay-per-use API users |
| Subscription | `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` (1-year token) | Max / Pro / Team / Enterprise subscribers |

Both are just env vars — the sandbox is born authenticated, does work, dies. No browser login flow, no persistent state to manage.

### Auth priority in Claude Code

Claude Code picks up credentials in this order:

1. Cloud provider creds (`CLAUDE_CODE_USE_BEDROCK` etc.)
2. `ANTHROPIC_AUTH_TOKEN` (bearer token for proxies)
3. `ANTHROPIC_API_KEY` (direct API key)
4. `CLAUDE_CODE_OAUTH_TOKEN` (subscription OAuth token)
5. OAuth login (interactive — not used in sandboxes)

### Secrets Flow

```
GitHub Secrets (storage)
  → GitHub Action (reads them)
    → Daytona SDK call (passes as env_vars at sandbox creation)
      → Sandbox (born with them in environment)
        → Claude Code picks up auth token automatically
```

Daytona is the runtime, not the secrets store. Secrets live in GitHub, get injected at sandbox creation time via `env_vars` parameter:

```python
sandbox = daytona.create(CreateSandboxFromSnapshotParams(
    snapshot='sodaprompts-doer',
    env_vars={
        'CLAUDE_CODE_OAUTH_TOKEN': '...',  # or ANTHROPIC_API_KEY
        'GITHUB_TOKEN': '...',
        'TELEGRAM_BOT_TOKEN': '...',
        'TELEGRAM_CHAT_ID': '...',
    }
))
```

---

## What `.sodaprompts.yml` Does

The published snapshot is generic — it has tools but no project knowledge. Everything project-specific gets wired up at boot by the entrypoint reading `.sodaprompts.yml`:

| Category | Config fields | What the entrypoint does |
|---|---|---|
| **Build commands** | `test`, `build`, `lint`, `format`, `dev` | Wired into Claude's Stop hooks (lint + test before session exit), auto-format hook |
| **Post-bootstrap** | `post_bootstrap` | Runs `pnpm install`, DB migrations, etc. after clone |
| **MCP servers** | `mcp_servers` | Merged into `~/.claude/settings.json`; `"from-env"` placeholders resolved from env vars |
| **Supabase safety** | Auto-detected from `mcp_servers.supabase` | Denies `execute_sql`, `apply_migration`, `deploy_edge_function`, `merge_branch` in permissions |
| **Network policy** | `network_policy.allow` | Domain allowlist + auto-appended deny-all. Always includes github, anthropic, npm, telegram |
| **Hooks** | Baked into snapshot, configured at boot | `block-push-to-main`, `log-commands` (secret sanitization), `auto-format` |
| **Base branch** | `base_branch` | Which branch to fork from and PR into |
| **Review config** | `review.enabled`, `review.max_rounds` | Whether reviewer skill runs, convergence limit |
| **Agent** | `agent` | Which agent runtime to use (determines snapshot variant) |

### Schema

```yaml
# Project commands
base_branch: main
test: pnpm test
build: pnpm build
lint: pnpm lint
format: pnpm prettier --write
dev: pnpm dev --port 8080 --hostname 0.0.0.0

# Bootstrap
post_bootstrap:
  - pnpm install

# Agent & runtime
agent: claude                    # claude | codex | aider
snapshot: ghcr.io/sodaprompts/doer-claude:node-1.0.0

# Notifications
notifications: telegram

# MCP servers (project-specific, merged with defaults)
mcp_servers:
  supabase:
    command: npx
    args: ["-y", "@supabase/mcp-server"]
    env:
      SUPABASE_ACCESS_TOKEN: from-env

# Security
network_policy:
  allow:
    - github.com
    - "*.anthropic.com"
    - "*.supabase.co"

# Review
review:
  enabled: true
  max_rounds: 3
```

---

## Entrypoint: What Happens at Boot

The entrypoint replaces the 400-line `bootstrap.sh`. Most of that was installing packages — now baked into the snapshot. What remains (~50 lines):

```
1. gh repo clone $GITHUB_REPO
2. Read .sodaprompts.yml
3. Run post_bootstrap (pnpm install, etc.)
4. Write ~/.claude/settings.json:
   - Merge MCP servers (defaults + project-specific)
   - Resolve "from-env" placeholders in MCP config
   - Register hooks (block-push-to-main, log-commands, auto-format)
   - Wire lint + test into Stop hooks
   - If supabase MCP detected: add permission denials
5. Nullify repo-level .claude/settings.json (sprite-only hooks apply)
6. Apply network policy
7. Detect work item type from GitHub (issue label / PR state)
8. Run builder or reviewer skill accordingly
```

| Current bootstrap step | In Daytona |
|---|---|
| Install system packages | Baked into snapshot |
| Install GitHub CLI | Baked into snapshot |
| Install Claude Code | Baked into snapshot |
| Install sodaprompts plugin | Baked into snapshot |
| Install agent-browser + Playwright | Baked into snapshot |
| Install Telegram MCP | Baked into snapshot |
| Clone repo | Entrypoint (runtime) |
| Run post_bootstrap | Entrypoint (runtime) |
| Configure MCP servers from config | Entrypoint (runtime) |
| Configure hooks + permissions | Entrypoint (runtime) |
| Apply network policy | Entrypoint (runtime) |
| Start runner | Entrypoint (runtime) |

---

## Single Sandbox, Two Skills

The Doer and Thinker become **skills within the same sandbox**. The entrypoint detects the work item and invokes the right skill:

- Issue labeled `prd-queued` / `bug-queued` / PR with `changes_requested` → builder skill
- PR labeled `needs-review` / issue labeled `needs-investigation` → reviewer skill

Benefits:
- Half the infrastructure (one snapshot, one workflow)
- Shared project context (deps installed, repo cloned)
- Simpler config (no separate reviewer section)
- Review happens in the same sandbox that built the code

Trade-off: builder and reviewer run sequentially in a single sandbox. Fine — the builder finishes before the reviewer starts, and with ephemeral sandboxes a separate reviewer sandbox could be spun up in parallel if needed later.

---

## GitHub Action

The `wake-sprite.yml` workflow becomes `wake-sandbox.yml`:

```yaml
name: Wake Sandbox
on:
  issues:
    types: [labeled]
  pull_request_review:
    types: [submitted]

jobs:
  run-task:
    if: |
      contains(github.event.label.name, 'prd-queued') ||
      contains(github.event.label.name, 'bug-queued') ||
      contains(github.event.label.name, 'needs-review') ||
      (github.event.review.state == 'changes_requested')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Create and run sandbox
        env:
          DAYTONA_API_KEY: ${{ secrets.DAYTONA_API_KEY }}
        run: |
          # Read snapshot from .sodaprompts.yml
          SNAPSHOT=$(yq '.snapshot' .sodaprompts.yml)

          # Create ephemeral sandbox with all secrets
          daytona sandbox create \
            --snapshot "$SNAPSHOT" \
            --env GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }} \
            --env GITHUB_REPO=${{ github.repository }} \
            --env ANTHROPIC_API_KEY=${{ secrets.ANTHROPIC_API_KEY }} \
            --env CLAUDE_CODE_OAUTH_TOKEN=${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }} \
            --env TELEGRAM_BOT_TOKEN=${{ secrets.TELEGRAM_BOT_TOKEN }} \
            --env TELEGRAM_CHAT_ID=${{ secrets.TELEGRAM_CHAT_ID }} \
            --env WORK_ITEM=${{ github.event.issue.number || github.event.pull_request.number }}
```

Each issue/PR event gets its own sandbox — inherently parallel. No queue management needed.

---

## Onboarding: `npx create-sodaprompts`

### What It Does

1. Detects project: reads `package.json` (TS-only for v1)
2. Prompts for config values (with smart defaults):
   - Base branch
   - Test / build / lint / format commands
   - Auth method (API key or subscription)
   - Notification provider (telegram / none)
3. Generates `.sodaprompts.yml`
4. Copies `.github/workflows/wake-sandbox.yml` into the repo
5. Creates Daytona snapshot in user's account (via SDK, needs `DAYTONA_API_KEY`)
6. Prints next steps (set GitHub secrets, commit, push)

### Implementation

- ~200 lines of JS
- Published as `@sodaprompts/create-sodaprompts` on npm
- Uses `prompts` (or similar) for interactive questions
- Zero dependencies on any agent CLI
- Requires `DAYTONA_API_KEY` env var for snapshot creation

### Three Onboarding Tiers

| User | Path | Agent-locked? |
|------|------|--------------|
| Claude Code user | `/sodaprompts-setup` (existing skill) | Yes — premium UX, does scaffolding + shipping in one flow |
| Any developer | `npx create-sodaprompts` | No — generates config, user commits manually |
| Power user | Copy template, edit YAML by hand | No |

---

## Full User Workflow

### One-time setup (~2 minutes)

```
1. npx create-sodaprompts
   → detects package.json, prompts for commands
   → generates .sodaprompts.yml
   → copies .github/workflows/wake-sandbox.yml
   → creates Daytona snapshot via SDK (needs DAYTONA_API_KEY)

2. Auth (choose one):
   a) API key:      get ANTHROPIC_API_KEY from console.anthropic.com
   b) Subscription: run `claude setup-token` → get CLAUDE_CODE_OAUTH_TOKEN (valid 1 year)

3. Set GitHub repo secrets:
   DAYTONA_API_KEY              ← talks to Daytona
   ANTHROPIC_API_KEY            ← (option a) OR
   CLAUDE_CODE_OAUTH_TOKEN      ← (option b)
   TELEGRAM_BOT_TOKEN           ← optional
   TELEGRAM_CHAT_ID             ← optional

4. git add .sodaprompts.yml .github/workflows/wake-sandbox.yml
   git commit && git push
```

### Shipping a task

```
5. gh issue create --title "Add search feature" \
     --body-file docs/prds/search.md \
     --label prd-queued

   (or from Claude: /sodaprompts-ship docs/prds/search.md)

6. GitHub Action fires:
   → creates ephemeral Daytona sandbox from snapshot
   → entrypoint: clone, pnpm install, wire .sodaprompts.yml config
   → builder implements, opens PR
   → reviewer reviews (same sandbox)
   → Telegram notification: "PR ready"
   → sandbox destroyed

7. User reviews PR, merges or requests changes
   → if changes_requested, Action creates new sandbox
   → builder applies fixes, re-requests review
   → cycle repeats until approved
```

Ship multiple prompts — they run in parallel (one sandbox each):

```
gh issue create --title "Auth" --body-file auth.md --label prd-queued
gh issue create --title "Billing" --body-file billing.md --label prd-queued
gh issue create --title "Search" --body-file search.md --label prd-queued
# → 3 sandboxes spin up simultaneously
```

---

## What Changes in Existing Code

### Runner Scripts (run-builder.sh, run-reviewer.sh)

**Keep as-is.** Already agent-agnostic via `AGENT_RUNTIME` env var. Move from being uploaded per-sprite to being baked into the snapshot at `/opt/sodaprompts/`.

### bootstrap.sh → entrypoint.sh

**Rewrite.** ~50 lines instead of ~400. See "Entrypoint" section above.

### ship-doer.sh

**Simplify.** Current 12-step flow becomes ~3 steps:

1. Read `.sodaprompts.yml`
2. Create Daytona sandbox from snapshot (with env vars)
3. Print summary

Steps that disappear: locate plugin, upload files, push env, run bootstrap, checkpoint.

### Hooks

**Keep the scripts, change the wiring.** `block-push-to-main.sh`, `log-commands.sh`, `auto-format.sh` are agent-agnostic bash. Baked into the snapshot. The entrypoint registers them in Claude's `settings.json` (or equivalent for other agents).

### `/sodaprompts-setup` Skill

**Keep as optional.** Still works for Claude users. Internally calls `create-sodaprompts` logic for config generation.

### `/sodaprompts-ship` Skill

**Keep as-is.** It just creates GitHub Issues — already agent-agnostic.

---

## Migration Path

### Phase 1: Scaffolder

- Build and publish `npx create-sodaprompts` (TS-only)
- Update `.sodaprompts.yml` schema with new fields (`agent`, `snapshot`, `review`)
- Keep Sprites as the runtime — scaffolder just generates config
- Claude plugin still works, now optional for onboarding

### Phase 2: Daytona Runtime

- Build Docker image, publish to GHCR as `doer-claude:node-1.0.0`
- Write `entrypoint.sh` replacing `bootstrap.sh`
- Write `wake-sandbox.yml` workflow template
- Simplify `ship-doer.sh` for Daytona
- Test with existing users

### Phase 3: Multi-Agent

- Build Codex and Aider snapshot variants
- Update `entrypoint.sh` to configure hooks per agent runtime
- Update scaffolder to handle agent-specific config
- Publish snapshot variants

### Phase 4: Polish

- Web onboarding UI (optional, generates `.sodaprompts.yml` via browser)
- Language-specific snapshots (python, rust)
- `sodaprompts` CLI for status/logs/kill without agent dependency

---

## Daytona API Capabilities

| Capability | Status |
|---|---|
| Create snapshot from Docker image/Dockerfile | Available |
| Create sandbox from snapshot | Available |
| Pass env vars at sandbox creation | Available |
| Stop/start sandbox (filesystem persisted) | Available |
| Archive/restore sandbox (cold storage) | Available |
| GHCR as container registry source | Explicitly supported |
| Snapshot a *running* sandbox's state | Not yet ([#2519](https://github.com/daytonaio/daytona/issues/2519)) |
| Point-in-time checkpoint/rollback | Not yet ([#2528](https://github.com/daytonaio/daytona/issues/2528)) |
| Fork filesystem + memory state | Coming soon |

We don't need #2519 or #2528 — the ephemeral model with `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` as env vars avoids the need for persistent sandbox state entirely.

## Open Questions

1. **Cost model** — how does Daytona bill? Per sandbox-minute? Per creation? Affects whether parallel sandboxes are practical at scale.
