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
  → Daytona SDK: create sandbox from snapshot (ephemeral: true, env_vars: {...})
  → Entrypoint: clone repo, pnpm install, wire up config from .sodaprompts.yml
  → Builder implements, opens PR
  → Reviewer reviews (same sandbox, different skill)
  → Sandbox auto-deleted on stop (ephemeral)

3 issues queued? → 3 sandboxes in parallel. No queue needed.
```

This is how Daytona is designed to be used — sub-90ms sandbox creation from snapshots, fully stateless, spin up and throw away.

### Persistent Volume (session continuity + logs)

Each project gets a **Daytona Volume** mounted to every sandbox. The volume persists across sandbox lifetimes (free, no storage quota impact). It stores:

- **Claude session data** (`~/.claude/projects/`) — enables `--resume` across ephemeral sandboxes
- **Command logs** (`~/.claude/logs/`) — sanitized bash command history from `log-commands.sh` hook

```python
sandbox = daytona.create(CreateSandboxFromSnapshotParams(
    snapshot='sodaprompts-doer',
    ephemeral=True,
    volumes=[VolumeMount(
        volume_id='sodaprompts-myproject',
        mount_path='/home/daytona/.claude'
    )],
    env_vars={...}
))
```

#### `--resume` for review fix cycles

When the doer picks up a `changes_requested` review, it resumes the original build session instead of starting cold:

```
Build sandbox:
  → volume mounted at ~/.claude
  → builder runs, session ID = abc123
  → opens PR, saves session ID to GitHub (PR comment metadata)
  → sandbox destroyed — session data persists on volume

Review fix sandbox:
  → same volume mounted at ~/.claude
  → claude --resume abc123
  → full conversation context: knows the codebase, decisions, what it built
  → reads review comments, applies fixes with full understanding
  → sandbox destroyed
```

This is **better than Sprites** — with checkpoint/restore the filesystem persisted but Claude's conversation context was lost. With volumes + `--resume`, the agent picks up exactly where it left off.

#### Command logs on volume

The `log-commands.sh` hook writes to the volume at `~/.claude/logs/bash-commands.log`. This serves:

1. **Session reports** — posted as PR comment (sanitized command log, last 50 lines, collapsible)
2. **Debugging** — logs persist after sandbox destruction for post-mortem analysis
3. **Audit trail** — full record of what the agent executed, with secrets redacted
4. **Usage tracking** — parseable for build duration, command count, failure rate

The hook itself is unchanged from Sprites — only the log path moves to the volume. One addition: `CLAUDE_CODE_OAUTH_TOKEN` added to the sanitization list alongside existing redactions (GITHUB_TOKEN, ANTHROPIC_API_KEY, etc.).

### Published Snapshot (shared by all users)

One Docker image per agent runtime, published on GHCR. Pre-installed:

- System packages: git, gh, jq, curl (lightweight — no chromium/xvfb)
- Language runtime: Node.js + pnpm (TS-only for v1)
- Agent binary: Claude Code (v1), Codex/Aider (future)
- Sodaprompts orchestration: run-builder.sh, run-reviewer.sh, entrypoint.sh
- Default MCP servers: Telegram, Context7

**Not in the image** (provided by Daytona platform):
- Chromium, xvfb, display server → Daytona Computer Use API (`sandbox.computer_use.start()`)
- agent-browser → replaced by Daytona's native mouse/keyboard/screenshot APIs
- Playwright → optional, installed via `post_bootstrap` if project needs browser tests

This removes ~700MB from the image compared to the Sprites bootstrap.

```dockerfile
FROM node:22-slim
RUN apt-get update && apt-get install -y git gh jq curl
RUN npm install -g @anthropic-ai/claude-code
COPY run-builder.sh run-reviewer.sh entrypoint.sh task-adapter.sh /opt/sodaprompts/
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
    ephemeral=True,               # auto-delete when sandbox stops
    auto_stop_interval=30,        # stop after 30min idle (safety net)
    volumes=[VolumeMount(
        volume_id='sodaprompts-myproject',
        mount_path='/home/daytona/.claude'  # sessions + logs persist
    )],
    env_vars={
        'CLAUDE_CODE_OAUTH_TOKEN': '...',  # or ANTHROPIC_API_KEY
        'GITHUB_TOKEN': '...',
        'TELEGRAM_BOT_TOKEN': '...',
        'TELEGRAM_CHAT_ID': '...',
        'RESUME_SESSION': '...',   # session ID from previous build (if review fix)
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
| **Supabase safety** | Auto-detected from `mcp_servers.supabase` | Applies tool **allowlist** — only branch management and read-only operations permitted. All other tools (execute_sql, apply_migration, deploy_edge_function, merge_branch) blocked. |
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
1. Start Daytona Computer Use (sandbox.computer_use.start() — Xvfb, xfce4, display)
2. gh repo clone $GITHUB_REPO
3. Read .sodaprompts.yml
4. Run post_bootstrap (pnpm install, playwright install if needed, etc.)
5. Write ~/.claude/settings.json:
   - Merge MCP servers (defaults + project-specific)
   - Resolve "from-env" placeholders in MCP config
   - Register hooks (block-push-to-main, log-commands, auto-format)
   - Wire lint + test into Stop hooks
   - If supabase MCP detected: apply tool allowlist
6. Nullify repo-level .claude/settings.json (sandbox-only hooks apply)
7. Detect work item type from GitHub (issue label / PR state)
8. Run builder or reviewer skill accordingly
```

| Current bootstrap step | In Daytona |
|---|---|
| Install system packages | Baked into snapshot |
| Install Chromium + xvfb | Daytona Computer Use API (platform-provided) |
| Install agent-browser + Playwright | Daytona Computer Use replaces agent-browser; Playwright optional via post_bootstrap |
| Install GitHub CLI | Baked into snapshot |
| Install Claude Code | Baked into snapshot |
| Install sodaprompts plugin | Baked into snapshot |
| Install agent-browser + Playwright | Baked into snapshot |
| Install Telegram MCP | Baked into snapshot |
| Clone repo | Entrypoint (runtime) |
| Run post_bootstrap | Entrypoint (runtime) |
| Configure MCP servers from config | Entrypoint (runtime) |
| Configure hooks + permissions | Entrypoint (runtime) |
| Apply network policy | Sandbox creation params (`network_block_all`, `network_allow_list`) |
| Start Computer Use (display) | Entrypoint calls Daytona Computer Use API |
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

          # For review fixes: extract session ID from PR comments
          RESUME_SESSION=""
          if [[ "${{ github.event.review.state }}" == "changes_requested" ]]; then
            PR_NUM="${{ github.event.pull_request.number }}"
            RESUME_SESSION=$(gh pr view "$PR_NUM" --json comments \
              --jq '.comments[] | select(.body | contains("session-id:")) | .body' \
              | grep -oP 'session-id: \K\S+' | tail -1)
          fi

          # Create ephemeral sandbox with volume for session continuity
          # --ephemeral auto-deletes sandbox when it stops
          daytona sandbox create \
            --snapshot "$SNAPSHOT" \
            --ephemeral \
            --volume sodaprompts-${{ github.repository_id }}:/home/daytona/.claude \
            --env GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }} \
            --env GITHUB_REPO=${{ github.repository }} \
            --env ANTHROPIC_API_KEY=${{ secrets.ANTHROPIC_API_KEY }} \
            --env CLAUDE_CODE_OAUTH_TOKEN=${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }} \
            --env TELEGRAM_BOT_TOKEN=${{ secrets.TELEGRAM_BOT_TOKEN }} \
            --env TELEGRAM_CHAT_ID=${{ secrets.TELEGRAM_CHAT_ID }} \
            --env WORK_ITEM=${{ github.event.issue.number || github.event.pull_request.number }} \
            --env RESUME_SESSION="$RESUME_SESSION"
```

Each issue/PR event gets its own sandbox — inherently parallel. No queue management needed.

When `RESUME_SESSION` is set, the entrypoint runs `claude --resume $RESUME_SESSION` instead of starting a fresh session. The agent picks up with full context from the original build.

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
6. Creates Daytona volume for session data + logs (`sodaprompts-<project-name>`)
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

**Keep logic, update artifact storage.** Already agent-agnostic via `AGENT_RUNTIME` env var. Move from being uploaded per-sprite to being baked into the snapshot at `/opt/sodaprompts/`.

Two changes:
1. `completion.json` currently written to local filesystem (`/home/sprite/completions/`). In ephemeral model, write completion status to GitHub (issue comment or check run) so the runner and wake workflow can detect results after sandbox destruction.
2. **Task adapter** — all `gh issue` calls in the runners now go through `task-adapter.sh` (see below). This abstracts issue creation, state transitions, comments, and polling behind provider-agnostic functions. Currently GitHub-only; designed for future Linear/other backends.

### Task Adapter (`scripts/task-adapter.sh`)

**New.** Thin shell library sourced by both runner scripts. Abstracts task management operations so the runners don't call `gh issue ...` directly:

| Function | What it does | GitHub impl |
|---|---|---|
| `task_create` | Create a task/issue | `gh issue create` |
| `task_transition` | Move task between states | `gh issue edit --remove-label OLD --add-label NEW` |
| `task_close` | Close a task | `gh issue close` |
| `task_comment` | Post a comment | `gh issue comment` |
| `task_view` | Read task details | `gh issue view` |
| `task_first_by_status` | Poll for oldest task in a state | `gh issue list --label --sort created` |
| `task_read_comments` | Read/filter comments | `gh issue view --json comments` |
| `task_ensure_labels` | Create all state labels (idempotent) | `gh label create --force` |

**Not abstracted** (stays as direct `gh` calls):
- PR operations (`gh pr create`, `gh pr edit`, `gh pr review`) — code hosting is always GitHub
- PR comments (session reports, decision logs) — attached to code, not task
- PR review state detection (`gh pr view --json reviews`) — GitHub-native concept

**Future:** Add `TASK_PROVIDER=linear` case branches to swap in Linear API calls. The adapter uses a `case "$TASK_PROVIDER"` pattern so adding a new backend is additive (no changes to runner logic). Add a `task_provider` field to `.sodaprompts.yml` to configure per-project.

### bootstrap.sh → entrypoint.sh

**Rewrite.** ~50 lines instead of ~400. See "Entrypoint" section above.

### ship-doer.sh

**Simplify.** Current 12-step flow becomes ~3 steps:

1. Read `.sodaprompts.yml`
2. Create Daytona sandbox from snapshot (with env vars)
3. Print summary

Steps that disappear: locate plugin, upload files, push env, run bootstrap, checkpoint.

### Hooks

**Keep the scripts, two small changes.** `block-push-to-main.sh`, `log-commands.sh`, `auto-format.sh` are agent-agnostic bash. Baked into the snapshot. The entrypoint registers them in Claude's `settings.json` (or equivalent for other agents).

Changes to `log-commands.sh`:
- Log path moves from `/home/sprite/logs/` to volume-backed `~/.claude/logs/` (persists across ephemeral sandboxes)
- Add `CLAUDE_CODE_OAUTH_TOKEN` to secret sanitization list

### `/sodaprompts-setup` Skill

**Keep as optional.** Still works for Claude users. Internally calls `create-sodaprompts` logic for config generation.

### `/sodaprompts-ship` Skill

**Mostly keep.** Core `ship` command (creates GitHub Issues) is agent-agnostic. Subcommands change:

| Subcommand | Current (Sprites) | Daytona |
|---|---|---|
| `ship <file>` | `gh issue create` | Same — no change |
| `ship status` | `gh issue list` + `gh pr list` | Same — no change |
| `ship logs` | `sprite exec` tail log | Daytona SDK: stream sandbox stdout |
| `ship kill` | `sprite exec` kill session | Daytona SDK: `sandbox.stop()` (ephemeral auto-deletes) |
| `ship push-env` | Push `.env` + re-checkpoint | **Removed** — env vars passed at sandbox creation |

### Completion Artifacts

**Change storage.** Currently `completion.json` is written to `/home/sprite/completions/` — destroyed with ephemeral sandbox. Move to GitHub:

- Decision log → PR comment (already done)
- Session report → PR comment (already done)
- Completion status → GitHub issue comment or check run (new)
- Runner result detection reads from GitHub instead of local filesystem

### Env-Reset Signal

**Remove.** The current builder has an env-reset mechanism for Sprites checkpoint/restore cycles. Irrelevant in ephemeral model — every sandbox starts clean by definition.

### Telegram Commands

**Adapt.** `/status`, `/logs`, `/queue`, `/kill` currently talk to Sprites. Need to:

- `/status` → read from GitHub (issues, PRs) — already works this way
- `/logs` → Daytona SDK stream sandbox stdout, or read from GitHub Actions logs
- `/queue` → `gh issue list --label prd-queued` — no change
- `/kill` → Daytona SDK `sandbox.stop()` (auto-deletes if ephemeral)

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

## Database Strategy — Supabase Branching

Supabase is **not set up for every project** — only when the user configures `mcp_servers.supabase` in `.sodaprompts.yml`. Auto-detected at boot and scoped via tool allowlist.

### How It Works

Supabase branches are separate Postgres instances. The agent uses them for **testing against the current production schema** — not to run migrations or modify schema. Branches are billed per hour, so the lifecycle is designed to minimize uptime:

```
1. Agent writes migration files and code (no branch yet)
2. Agent needs to test → create_branch("sodaprompts-prd-42")
3. Agent runs tests against branch connection string (mirrors prod schema)
4. Tests pass → delete_branch("sodaprompts-prd-42") immediately
5. Agent continues coding (branch is gone)
6. If needed again later → create a new branch (fast, <30s)
```

The agent **never runs migrations**. It writes migration files and includes them in the PR. The project owner runs `supabase db push` (or their own migration command) after merging.

### Tool Allowlist

Only these Supabase MCP tools are permitted (allowlist, not denylist):

| Tool | Purpose |
|---|---|
| `create_branch` | Spin up isolated DB for testing |
| `delete_branch` | Tear down after testing |
| `list_branches` | Orphan cleanup on session start |
| `reset_branch` | Reset branch to clean state |
| `list_tables`, `get_schemas` | Read-only introspection |
| `list_migrations` | Check migration state |
| `get_project_url`, `search_docs`, `get_logs` | Reference |

Blocked: `execute_sql`, `apply_migration`, `deploy_edge_function`, `merge_branch`, and any future tools added to the Supabase MCP.

### Orphan Cleanup

On session start, the builder skill lists branches with `sodaprompts-` prefix and deletes any left over from crashed sessions. Listing is free. This prevents cost accumulation from abandoned branches.

---

## Deprecated (removed in migration)

These Sprites-specific features have no equivalent and are intentionally dropped:

- **Checkpoint/restore** — replaced by ephemeral sandboxes (no state to checkpoint)
- **`push-env` command** — env vars passed at sandbox creation, not pushed to a running environment
- **Env-reset signal** — every sandbox starts clean; no reset needed
- **`/home/sprite/completions/` filesystem artifacts** — completion status moves to GitHub
- **Sprite-level network policy API** — replaced by per-sandbox config from `.sodaprompts.yml`
- **Long-lived sprite lifecycle** — no stop/start/wake; create/run/destroy per task

## Security Considerations

### Secret Sanitization

All text posted to GitHub (PR comments, session reports, logs) passes through `sanitize_secrets()` in `run-builder.sh` and the `log-commands.sh` hook. Both redact:

- `GITHUB_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- `ANTHROPIC_API_KEY`
- `CLAUDE_CODE_OAUTH_TOKEN`
- `SUPABASE_ACCESS_TOKEN` (log-commands.sh only)
- Pattern-based: `ghp_*`, `ghs_*`, `sk-*`, `Bearer *`

**Limitation:** Command output (stdout/stderr) is not sanitized by `log-commands.sh` — it only redacts the command string. If the agent runs `echo $GITHUB_TOKEN`, the output appears in the session log unredacted. Mitigation: the session report only posts the last 50 lines of the *command log*, not raw stdout.

### GitHub Token Scoping

Recommend **fine-grained PATs** instead of classic tokens with broad `repo` scope. Minimum permissions needed:

- `contents:read+write` (clone, push branches)
- `pull_requests:read+write` (create/edit PRs, post reviews)
- `issues:read+write` (create/edit issues, post comments)

Scope to the specific repository only. Classic `repo` scope grants access to all repos the user can see — too broad for a sandbox running autonomous code.

### Sandbox Creation Error Handling

When the Daytona SDK call fails (quota, bad config, network), error responses may echo back env var values. The wake workflow must capture errors and redact all `env_vars` before logging:

```bash
# In wake-sandbox.yml — redact secrets from any error output
OUTPUT=$(daytona sandbox create ... 2>&1) || {
  SAFE_OUTPUT=$(echo "$OUTPUT" | sed \
    -e "s/${ANTHROPIC_API_KEY:-___}/[REDACTED]/g" \
    -e "s/${CLAUDE_CODE_OAUTH_TOKEN:-___}/[REDACTED]/g" \
    -e "s/${GITHUB_TOKEN:-___}/[REDACTED]/g")
  echo "::error::Sandbox creation failed: $SAFE_OUTPUT"
  exit 1
}
```

### Network Policy — Domain to CIDR

`.sodaprompts.yml` uses domain names (`github.com`, `*.anthropic.com`), but Daytona's `network_allow_list` takes CIDRs. The entrypoint must resolve domains at sandbox boot:

```bash
# Resolve domains to CIDRs for Daytona network policy
for DOMAIN in $(yq '.network_policy.allow[]' .sodaprompts.yml); do
  dig +short "$DOMAIN" | grep -E '^[0-9]' | sed 's|$|/32|'
done
```

Wildcard domains (e.g., `*.supabase.co`) require CIDR ranges from the provider's documentation rather than DNS lookups.

### Prompt Injection via Issue Content

Runner scripts paste raw issue/PR body into the agent prompt. Malicious issue content could attempt prompt injection. Mitigations:

1. Agent runs with `--dangerously-skip-permissions` — already has full sandbox access, so injection can't escalate privileges beyond what the agent already has
2. Network policy limits exfiltration targets
3. `block-push-to-main` hook prevents direct main branch pushes
4. **Recommendation:** GitHub branch protection rules on main/master are the real safety net (required reviews, no force push). The hook is best-effort; branch protection is server-side

### Volume Data Hygiene

Persistent volumes store Claude session data across ephemeral sandboxes. Risk: stale sessions could contain API responses with secrets from previous builds.

- Session files (`.id`) are pruned after 7 days
- **Recommendation:** Add volume-level cleanup to entrypoint — delete session data older than 30 days
- Users can manually purge: `daytona volume delete sodaprompts-<project>`

### OAuth Token Lifetime

`CLAUDE_CODE_OAUTH_TOKEN` is valid for 1 year (Anthropic limitation). Recommend:

- Document annual rotation in onboarding
- `/sodaprompts-ship status` should warn if token was set >6 months ago (check GitHub secret last-updated timestamp via `gh api`)

---

## Open Questions

1. **Cost model** — how does Daytona bill? Per sandbox-minute? Per creation? Affects whether parallel sandboxes are practical at scale.
2. ~~**Network policy in Daytona**~~ **Resolved:** Daytona supports `network_block_all` (bool) and `network_allow_list` (comma-separated CIDRs) per sandbox at creation time. Replaces Sprites' DNS-based egress filtering. The entrypoint can read `network_policy.allow` from `.sodaprompts.yml` and pass it as `network_allow_list`.
3. **Sandbox stdout streaming** — for `ship logs` and Telegram `/logs`, can we stream sandbox output in real-time via the Daytona SDK? The Python SDK has `on_data` callbacks — confirm this works for our runner script output.
