# Daytona Migration Plan

Migrate sodaprompts from Sprites to Daytona sandboxes: ephemeral, agent-agnostic, config-driven.

## Goals

1. **Agent-agnostic** — support Claude, Codex, Aider, or any future agent
2. **No plugin install** — `npx create-sodaprompts` replaces `/sodaprompts-setup` as the primary onboarding path
3. **Generic snapshot** — one OCI image per agent runtime; project config read at boot from `.sodaprompts.yml`
4. **Ephemeral sandboxes** — one per task, parallel by default, no long-lived state
5. **Dual auth** — subscription (`CLAUDE_CODE_OAUTH_TOKEN`) or API key (`ANTHROPIC_API_KEY`) via env vars

---

## Architecture Overview

```
Issue labeled prd-queued
  → GitHub Action fires
  → daytona create --snapshot ... --auto-delete 0
  → Entrypoint: clone repo, install deps, wire config from .sodaprompts.yml
  → Builder implements, opens PR
  → Reviewer reviews (same sandbox)
  → Sandbox auto-deleted on stop

3 issues queued → 3 sandboxes in parallel. No queue needed.
```

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

### Comparison

| | Current (Sprites) | Target (Daytona) |
|---|---|---|
| **Onboarding** | `claude plugin install` → `/sodaprompts-setup` | `npx create-sodaprompts` (any agent) |
| **Runtime** | Long-lived sprites, checkpoint/restore | Ephemeral sandboxes, create/run/destroy |
| **Config** | Plugin-driven | `.sodaprompts.yml` in repo |
| **Parallelism** | Queue-based | Inherent (one sandbox per task) |
| **Agent** | Claude-only onboarding | Any agent via snapshot variants |

---

## Sandbox Lifecycle

### Ephemeral Model

Every task gets a fresh sandbox. No stop/start, no cleanup scripts, no stale state. Daytona provides sub-90ms sandbox creation from snapshots.

**Lifecycle parameters** (TS SDK — `@daytonaio/sdk`):

| Parameter | Value | Rationale |
|---|---|---|
| `autoStopInterval` | `60` | 60-min idle timeout (default: 15 min). Daytona auto-stop resets on preview access, SSH connections, and Toolbox SDK API calls — **not** on internal process activity (background scripts, agent sessions). The entrypoint runs a background heartbeat (see below) to keep long sessions alive. |
| `autoDeleteInterval` / `ephemeral` | `0` / `true` | Delete immediately on stop. CLI: `--auto-delete 0`. SDK: `ephemeral: true` (equivalent). Value `-1` disables auto-delete entirely. |
| `autoArchiveInterval` | N/A | Default: 7 days. Irrelevant for ephemeral sandboxes — they're deleted on stop, never reaching the archive threshold. |
| `resources` | `cpu: 2, memory: 4, disk: 10` | Defaults (1 vCPU / 1 GiB / 3 GiB) too small for Claude Code + Node + pnpm. Max per org: 4 vCPU / 8 GiB / 10 GiB. SDK `memory` unit is GiB; CLI `--memory` unit is MB (so `--memory 4096`). |
| `labels` | `project`, `taskType`, `issue` | For auditing and cost attribution. Note: `daytona list` doesn't support label filtering — use `daytona info` or SDK for orphan cleanup. |

**Why `image` instead of `snapshot`?** The TS SDK's `CreateSandboxFromSnapshotParams` does not support the `resources` field — only `CreateSandboxFromImageParams` does. Since we need to control CPU/RAM/disk, we reference the GHCR image directly. Daytona caches pulled images, so subsequent creates are still fast.

**CLI note:** `daytona create --memory` expects MB (`4096`); `daytona snapshot create --memory` expects GB (`4`). Snapshot defaults are baked at snapshot creation time; `daytona create` can override per-sandbox.

**CLI vs SDK:** The CLI's `daytona create` requires `--snapshot` (a pre-created snapshot name). The TS SDK's `CreateSandboxFromImageParams` can create directly from an OCI image. The wake workflow uses the CLI; the scaffolder uses the SDK.

### Persistent Volume

Each project gets a Daytona Volume mounted to every sandbox (free, no storage quota impact):

- `~/.claude/projects/` — session data for `--resume` across sandboxes
- `~/.claude/logs/` — sanitized bash command history from `log-commands.sh` hook

Command logs on the volume serve four purposes:

1. **Session reports** — posted as PR comment (sanitized command log, last 50 lines, collapsible)
2. **Debugging** — logs persist after sandbox destruction for post-mortem analysis
3. **Audit trail** — full record of what the agent executed, with secrets redacted
4. **Usage tracking** — parseable for build duration, command count, failure rate

```typescript
const sandbox = await daytona.create({
  image: 'ghcr.io/sodaprompts/doer-claude:node-1.0.0',
  user: 'daytona',               // run agent as non-root (entrypoint sets chattr +i as root first)
  ephemeral: true,
  autoStopInterval: 60,
  autoDeleteInterval: 0,
  resources: { cpu: 2, memory: 4, disk: 10 },
  volumes: [{ volumeId: 'sodaprompts-myproject', mountPath: '/home/daytona/.claude' }],
  labels: {
    project: repoName,
    taskType: taskType,
    issue: String(issueNumber),
  },
  envVars: {
    CLAUDE_CODE_OAUTH_TOKEN: '...',
    GITHUB_TOKEN: '...',
    TELEGRAM_BOT_TOKEN: '...',
    TELEGRAM_CHAT_ID: '...',
    RESUME_SESSION: '...',
  },
} satisfies CreateSandboxFromImageParams)
```

### Resume for Review Fixes

When the builder picks up a `changes_requested` review, it resumes the original session:

```
Build sandbox → volume at ~/.claude → session abc123 → PR opened → sandbox destroyed
  ↓
Review-fix sandbox → same volume → claude --resume abc123 → full context preserved → fixes applied → sandbox destroyed
```

This is better than Sprites — checkpoint/restore persisted the filesystem but lost Claude's conversation context. Volumes + `--resume` preserves both.

When `RESUME_SESSION` is set, the entrypoint runs `claude --resume $RESUME_SESSION` instead of starting a fresh session.

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

## Snapshot Image

Based on the **default Daytona sandbox image** (`daytonaio/sandbox`), which already includes Chromium, Xvfb/xfce4/x11vnc/novnc, Node.js, Claude Code, git, curl, and Python. We add our tooling on top and snapshot once — after that, sandbox creation is sub-90ms regardless of image size.

**Already in the base image** (from `daytonaio/sandbox`):

- **System:** git, curl, Chromium, Xvfb, xfce4, x11vnc, novnc, ffmpeg, ripgrep
- **Runtime:** Node.js, Python 3
- **Agent:** Claude Code (`@anthropic-ai/claude-code`)

**Added by our layer:**

- **System:** gh, jq, gosu, pnpm
- **Browser automation:** agent-browser (uses system Chromium — no separate download)
- **Orchestration:** `run-builder.sh`, `run-reviewer.sh`, `entrypoint.sh`, `task-adapter.sh`
- **Hooks:** `block-push-to-main.sh`, `log-commands.sh`, `auto-format.sh`
- **MCP defaults:** Telegram, Context7

### Browser Testing

**agent-browser** is the primary browser testing tool. It's a native Rust CLI that provides token-efficient browser automation via accessibility tree snapshots with reference-based element targeting (`@e1`, `@e2`). More token-efficient than Playwright MCP because:

- **Batch mode** — multiple commands in one tool call (`agent-browser batch --json`)
- **Compact refs** — `@e1` instead of verbose MCP tool schemas
- **No schema overhead** — CLI output, not MCP tool definitions loaded into context
- **Stateful daemon** — browser stays open between commands, no re-initialization

The agent calls it via Bash tool: `agent-browser open http://localhost:3000`, `agent-browser snapshot`, `agent-browser click @e3`.

**Playwright MCP** (`@playwright/mcp`) available as an opt-in alternative via `mcp_servers` in `.sodaprompts.yml`. Better for projects needing device emulation, vision mode, or isolated browser profiles. Not a default because of higher token cost per interaction.

**Daytona Computer Use** is infrastructure, not a testing tool:
- Xvfb/xfce4/x11vnc/novnc already in the base image — Computer Use API just starts/stops them
- External screenshot/recording API useful for observability (GitHub Action can capture for debugging)
- Started by GitHub Action after sandbox creation if needed, not by the entrypoint

```dockerfile
FROM daytonaio/sandbox:0.54.0
# Base image includes: Chromium, Xvfb, xfce4, Node.js, Claude Code, Python, git, curl
RUN apt-get update && apt-get install -y gh jq gosu && npm install -g pnpm agent-browser
COPY run-builder.sh run-reviewer.sh entrypoint.sh task-adapter.sh /opt/sodaprompts/
COPY hooks/ /opt/sodaprompts/hooks/
ENTRYPOINT ["/opt/sodaprompts/entrypoint.sh"]
```

Published as: `ghcr.io/sodaprompts/doer-claude:node-1.0.0`

**Why base on `daytonaio/sandbox`:**
- Chromium, Xvfb, Claude Code, Node.js already included — less to install and maintain
- Inherits Daytona's updates to Chromium/Claude Code versions
- Computer Use works out of the box (VNC packages pre-installed)
- Extra packages we don't use (Python ML libs) are harmless once snapshotted

**Why publish to GHCR:**
- Free for public images
- Native GitHub Actions integration (`docker/login-action` + `docker/build-push-action`)
- Same auth model as the rest of the project (GitHub PAT)
- No separate account/billing (Docker Hub requires one)
- Org-scoped: `ghcr.io/sodaprompts/*` keeps everything under one namespace
- Explicitly supported by Daytona as a container registry source

**Snapshot creation** (once during onboarding):

```shell
daytona snapshot create sodaprompts-doer-claude-node \
  --image ghcr.io/sodaprompts/doer-claude:node-1.0.0 \
  --cpu 2 --memory 4 --disk 10
```

**Constraint:** Snapshot images must use explicit version tags — no `latest`/`lts`/`stable`.

**Snapshot auto-deactivation:** Daytona automatically deactivates snapshots after 2 weeks of non-use. If a project goes idle, the next `daytona create --snapshot` will fail. The wake workflow should handle this gracefully — either by calling `daytona snapshot activate` before creation, or by using `CreateSandboxFromImageParams` (SDK) which bypasses snapshots entirely. The scaffolder should document this in onboarding.

**Future variants** (not v1): `doer-codex:node-1.0.0`, `doer-claude:python-1.0.0`, `doer-claude:full-1.0.0`

---

## `.sodaprompts.yml` Schema

The snapshot is generic. Everything project-specific is wired at boot from this config:

```yaml
base_branch: main
test: pnpm test
build: pnpm build
lint: pnpm lint
format: pnpm prettier --write
dev: pnpm dev --port 8080 --hostname 0.0.0.0

post_bootstrap:
  - pnpm install

agent: claude                              # claude | codex | aider
snapshot: sodaprompts-doer-claude-node      # Daytona snapshot name

notifications: telegram

mcp_servers:
  supabase:
    command: npx
    args: ["-y", "@supabase/mcp-server"]
    env:
      SUPABASE_ACCESS_TOKEN: from-env

review:
  enabled: true
  max_rounds: 3
```

| Category | Config fields | What the entrypoint does |
|---|---|---|
| Build commands | `test`, `build`, `lint`, `format`, `dev` | Wired into Claude Stop hooks (lint + test before exit), auto-format hook |
| Post-bootstrap | `post_bootstrap` | Runs after clone (pnpm install, DB migrations, etc.) |
| MCP servers | `mcp_servers` | Merged into `~/.claude/settings.json`; `"from-env"` resolved from env vars. Defaults (Telegram, Context7) always included; project-specific servers (e.g. Playwright MCP, Supabase) added on top. |
| Supabase safety | Auto-detected from `mcp_servers.supabase` | Applies tool allowlist — only branch management + read-only ops |
| Network policy | Default | Daytona essential services cover our needs. `network_policy` field from Sprites schema is deprecated — remove from `sodaprompts-schema.yml`. |
| Hooks | Baked into snapshot | `block-push-to-main`, `log-commands`, `auto-format` |

---

## Entrypoint

Replaces the 400-line `bootstrap.sh` with ~50 lines:

```
1. gh repo clone $GITHUB_REPO
2. Read .sodaprompts.yml
3. Run post_bootstrap commands
4. Write ~/.claude/settings.json (as root):
   - Merge MCP servers (defaults + project-specific)
   - Resolve "from-env" placeholders
   - Register hooks (block-push-to-main, log-commands, auto-format)
   - Wire lint + test into Stop hooks
   - If supabase MCP detected: apply tool allowlist
5. chattr +i ~/.claude/settings.json (seal as root)
6. Nullify repo-level .claude/settings.json
7. Drop to `daytona` user via exec gosu daytona
8. Detect work item type from $TASK_TYPE env var
9. Run builder or reviewer skill
```

**Heartbeat.** The entrypoint starts a background loop that calls a Toolbox SDK API endpoint (e.g. `sandbox.fs.list('/')`) every 5 minutes. This resets the `autoStopInterval` timer and prevents long-running agent sessions from being killed. The heartbeat exits when the runner finishes.

**Computer Use is started externally.** The Daytona Computer Use API (`sandbox.computerUse.start()`) launches Xvfb, xfce4, x11vnc, and novnc inside the sandbox — but it must be called from **outside** via the SDK or REST API (`POST /toolbox/{sandboxId}/computeruse/start`). The entrypoint runs inside the sandbox and cannot call it. The GitHub Action starts Computer Use after sandbox creation (see GitHub Action section).

| Current bootstrap step | Daytona |
|---|---|
| Install system packages | Baked into snapshot |
| Install Chromium + xvfb | Already in base image (`daytonaio/sandbox`) |
| Install agent-browser + Playwright | agent-browser baked into snapshot; uses system Chromium |
| Install GitHub CLI | Baked into snapshot |
| Install Claude Code | Baked into snapshot |
| Install sodaprompts plugin | Baked into snapshot |
| Install Telegram MCP | Baked into snapshot |
| Clone repo | Entrypoint (runtime) |
| Run post_bootstrap | Entrypoint (runtime) |
| Configure MCP + hooks | Entrypoint (runtime, as root before dropping privileges) |
| Start Computer Use | Optional — GitHub Action calls `computerUse.start()` via SDK/API if project needs headed browser mode |
| Start runner | Entrypoint (runtime, as `daytona` user) |

---

## GitHub Action

`wake-sprite.yml` becomes `wake-sandbox.yml`:

```yaml
name: Wake Sandbox
on:
  issues:
    types: [labeled]
  pull_request_review:
    types: [submitted]

jobs:
  run-task:
    if: >-
      contains(github.event.label.name, 'prd-queued') ||
      contains(github.event.label.name, 'bug-queued') ||
      contains(github.event.label.name, 'needs-review') ||
      (github.event.review.state == 'changes_requested')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Resolve work item
        id: work
        run: |
          # GitHub Actions expressions don't support || for coalescing.
          # Use shell fallback instead.
          WORK_ITEM="${{ github.event.issue.number }}"
          if [[ -z "$WORK_ITEM" ]]; then
            WORK_ITEM="${{ github.event.pull_request.number }}"
          fi
          echo "item=$WORK_ITEM" >> "$GITHUB_OUTPUT"

          # Determine task type
          TASK_TYPE="prd"
          if [[ "${{ github.event.label.name }}" == "bug-queued" ]]; then
            TASK_TYPE="bug"
          elif [[ "${{ github.event.label.name }}" == "needs-review" ]]; then
            TASK_TYPE="review"
          elif [[ "${{ github.event.review.state }}" == "changes_requested" ]]; then
            TASK_TYPE="review-fix"
          fi
          echo "task_type=$TASK_TYPE" >> "$GITHUB_OUTPUT"

          # Extract session ID for review fixes (portable — no grep -oP)
          RESUME_SESSION=""
          if [[ "$TASK_TYPE" == "review-fix" ]]; then
            PR_NUM="${{ github.event.pull_request.number }}"
            RESUME_SESSION=$(gh pr view "$PR_NUM" --json comments \
              --jq '.comments[] | select(.body | contains("session-id:")) | .body' \
              | sed -n 's/.*session-id: \([^ ]*\).*/\1/p' | tail -1)
          fi
          echo "resume_session=$RESUME_SESSION" >> "$GITHUB_OUTPUT"

      - name: Create and run sandbox
        env:
          DAYTONA_API_KEY: ${{ secrets.DAYTONA_API_KEY }}
        run: |
          SNAPSHOT=$(yq '.snapshot' .sodaprompts.yml)

          # Create ephemeral sandbox
          SANDBOX_ID=$(daytona create \
            --snapshot "$SNAPSHOT" \
            --auto-delete 0 \
            --auto-stop 60 \
            --cpu 2 --memory 4096 --disk 10 \
            --label project=${{ github.event.repository.name }} \
            --label task_type="${{ steps.work.outputs.task_type }}" \
            --label issue="${{ steps.work.outputs.item }}" \
            --volume sodaprompts-${{ github.repository_id }}:/home/daytona/.claude \
            --env GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }} \
            --env GITHUB_REPO=${{ github.repository }} \
            --env ANTHROPIC_API_KEY=${{ secrets.ANTHROPIC_API_KEY }} \
            --env CLAUDE_CODE_OAUTH_TOKEN=${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }} \
            --env TELEGRAM_BOT_TOKEN=${{ secrets.TELEGRAM_BOT_TOKEN }} \
            --env TELEGRAM_CHAT_ID=${{ secrets.TELEGRAM_CHAT_ID }} \
            --env WORK_ITEM="${{ steps.work.outputs.item }}" \
            --env TASK_TYPE="${{ steps.work.outputs.task_type }}" \
            --env RESUME_SESSION="${{ steps.work.outputs.resume_session }}")

          # Optional: Start Computer Use (Xvfb + xfce4 + x11vnc + novnc) for headed browser mode.
          # Not needed for headless agent-browser (default) or headless Playwright MCP.
          # curl -sf -X POST \
          #   "https://proxy.app.daytona.io/toolbox/${SANDBOX_ID}/computeruse/start" \
          #   -H "Authorization: Bearer $DAYTONA_API_KEY"
```

---

## Authentication

### Two Paths

| Method | Env var | Source | For whom |
|---|---|---|---|
| API key | `ANTHROPIC_API_KEY` | console.anthropic.com | Pay-per-use API users |
| Subscription | `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` (1-year token) | Max/Pro/Team/Enterprise |

Both are env vars — the sandbox is born authenticated, does work, dies.

### Auth Priority in Claude Code

Claude Code picks up credentials in this order:

1. Cloud provider creds (`CLAUDE_CODE_USE_BEDROCK` etc.)
2. `ANTHROPIC_AUTH_TOKEN` (bearer token for proxies)
3. `ANTHROPIC_API_KEY` (direct API key)
4. `CLAUDE_CODE_OAUTH_TOKEN` (subscription OAuth token)
5. OAuth login (interactive — not used in sandboxes)

### Secrets Flow

```
GitHub Secrets → GitHub Action → Daytona SDK (envVars at creation) → Sandbox environment → Agent picks up automatically
```

Daytona is the runtime, not the secrets store. Secrets live in GitHub.

---

## Onboarding: `npx create-sodaprompts`

### Steps

1. Detect project (reads `package.json`, TS-only for v1)
2. Prompt for config: base branch, commands, auth method, notifications
3. Generate `.sodaprompts.yml`
4. Copy `.github/workflows/wake-sandbox.yml`
5. Create Daytona snapshot from GHCR image
6. Create Daytona volume for session data + logs
7. Print next steps (set GitHub secrets, commit, push)

### Implementation

- ~200 lines JS, published as `@sodaprompts/create-sodaprompts`
- Zero dependencies on any agent CLI
- Requires `DAYTONA_API_KEY` for snapshot + volume creation

### Onboarding Tiers

| User | Path | Agent-locked? |
|---|---|---|
| Claude Code user | `/sodaprompts-setup` (existing skill) | Yes — premium UX, does scaffolding + shipping in one flow. Internally calls `create-sodaprompts` logic. |
| Any developer | `npx create-sodaprompts` | No |
| Power user | Copy template, edit YAML | No |

---

## Full User Workflow

### One-time setup (~2 minutes)

```
1. npx create-sodaprompts
   → detects package.json, prompts for commands
   → generates .sodaprompts.yml
   → copies .github/workflows/wake-sandbox.yml
   → creates Daytona snapshot + volume via SDK (needs DAYTONA_API_KEY)

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

### Runner Scripts (`run-builder.sh`, `run-reviewer.sh`)

**Significant refactor.** Already agent-agnostic via `AGENT_RUNTIME` env var. Move from being uploaded per-sprite to being baked into the snapshot at `/opt/sodaprompts/`. The core build/review logic stays, but the Sprite-specific scaffolding needs updating.

Changes:

1. **Completion artifacts** — `completion.json` currently written to `/home/sprite/completions/`, destroyed with ephemeral sandbox. Move to GitHub:
   - Decision log → PR comment (already done)
   - Session report → PR comment (already done)
   - Completion status → GitHub issue comment or check run (new)
   - Runner result detection reads from GitHub instead of local filesystem
2. **Remove idle-to-suspend pattern** — both runners currently exit after 5 min idle to trigger Sprite suspension at zero cost. Ephemeral sandboxes don't need this — the runner runs once, finishes, and the sandbox auto-stops. Remove the polling loop and idle timeout logic.
3. **Update paths** — `/home/sprite/` references → `/home/daytona/`; completion paths, log paths, session file paths all change.
4. **Remove checkpoint/restore references** — no more `sprite checkpoint` calls or golden-base logic.
5. **Task type from env var** — the entrypoint no longer needs to poll GitHub for work items. `TASK_TYPE` and `WORK_ITEM` are passed as env vars from the GitHub Action. The runner executes a single task and exits.
6. **Task adapter** — route all `gh issue` calls through `task-adapter.sh` for provider abstraction.

### Task Adapter (`scripts/task-adapter.sh`)

**Already exists** (253 lines). Thin shell library sourced by runners, abstracts task operations:

| Function | GitHub implementation |
|---|---|
| `task_create` | `gh issue create` |
| `task_transition` | `gh issue edit --remove-label OLD --add-label NEW` |
| `task_close` | `gh issue close` |
| `task_comment` | `gh issue comment` |
| `task_view` | `gh issue view` |
| `task_first_by_status` | `gh issue list --label --sort created` |
| `task_read_comments` | `gh issue view --json comments` |
| `task_ensure_labels` | `gh label create --force` |

**Not abstracted** (stays as direct `gh` calls): PR operations, PR comments, PR review state — these are always GitHub.

**Future:** Add `TASK_PROVIDER=linear` case branches. The adapter uses a `case "$TASK_PROVIDER"` pattern so adding a new backend is additive (no changes to runner logic). Add a `task_provider` field to `.sodaprompts.yml` to configure per-project.

### `bootstrap.sh` → `entrypoint.sh`

**Rewrite.** ~50 lines instead of ~400. See Entrypoint section.

### `ship-doer.sh`

**Simplify.** Current 393-line, 12-step flow → ~50-line, 3-step flow: read config, create sandbox via SDK, print summary. Steps that disappear: locate plugin, upload files, push env, run bootstrap, apply network policy, checkpoint as golden-base, verify setup. The structured output protocol (`===SHIP_ERROR_BEGIN/END===`, `===SHIP_COMPLETE===`) stays for `/sodaprompts-setup` integration.

### Hooks

**Keep the scripts, two small changes.** `block-push-to-main.sh`, `log-commands.sh`, `auto-format.sh` are agent-agnostic bash — unchanged from Sprites. Baked into the snapshot. The entrypoint registers them in Claude's `settings.json` (or equivalent for other agents).

Changes to `log-commands.sh`:

1. Log path: `/home/sprite/logs/` → volume-backed `~/.claude/logs/` (persists across ephemeral sandboxes)
2. Add `CLAUDE_CODE_OAUTH_TOKEN` to secret sanitization list

### `/sodaprompts-ship` Subcommands

| Subcommand | Current (Sprites) | Daytona |
|---|---|---|
| `ship <file>` | `gh issue create` | No change |
| `ship status` | `gh issue list` + `gh pr list` | No change |
| `ship logs` | `sprite exec` tail log | Daytona SDK: stream sandbox stdout |
| `ship kill` | `sprite exec` kill session | `sandbox.stop()` (auto-deletes) |
| `ship push-env` | Push `.env` + re-checkpoint | **Removed** — env vars at creation |

### Telegram Notifications

**Simplify.** The current `telegram-poller.sh` (312 lines) runs as a background daemon on the Sprite, continuously polling for commands. With ephemeral sandboxes there's no long-lived process to host a daemon.

Replace with **on-demand polling** — the runner sends Telegram notifications at key moments (task started, PR opened, review complete, error) and only polls for a reply when it needs human input (phone-a-friend pattern). No background daemon, no `/status`/`/logs`/`/queue`/`/kill` commands inside the sandbox.

| Notification | When | Direction |
|---|---|---|
| Task started | Entrypoint begins | Sandbox → Telegram |
| PR opened | Builder creates PR | Sandbox → Telegram |
| Review complete | Reviewer finishes | Sandbox → Telegram |
| Error / blocked | Runner hits an error or needs input | Sandbox → Telegram, then poll for reply |

User-facing commands (`/status`, `/queue`) continue to work from the local `/sodaprompts-ship` skill — they read from GitHub, not from the sandbox.

---

## Deprecated (Removed in Migration)

### Concepts
- **Separate Chromium/xvfb install** → included in base Daytona image
- **Checkpoint/restore** → ephemeral sandboxes
- **`push-env`** → env vars at sandbox creation
- **Env-reset signal** → every sandbox starts clean
- **`/home/sprite/completions/`** → completion status moves to GitHub
- **Sprite-level network policy API** → replaced by Daytona platform defaults
- **Long-lived sprite lifecycle** → create/run/destroy per task
- **Idle-to-suspend polling loop** → runner executes a single task and exits; sandbox auto-stops

### Scripts
- **`bootstrap.sh`** (431 lines) → replaced by `entrypoint.sh` (~50 lines)
- **`bootstrap-reviewer.sh`** (124 lines) → removed (single sandbox, two skills)
- **`ship-reviewer.sh`** (341 lines) → removed (no separate reviewer sprite)
- **`ship-common.sh`** (380 lines) → most logic disappears with simplified `ship-doer.sh`
- **`install-skill.sh`** (40 lines) → skills baked into snapshot at build time
- **`preflight.sh`** → sprite-specific pre-flight checks no longer needed
- **`telegram-poller.sh`** (312 lines) → replaced by on-demand notifications (no background daemon)
- **`bootstrap-common.sh`** (137 lines) → shared bootstrap utilities no longer needed

---

## Security

The agent runs with `--dangerously-skip-permissions`. Safety comes from defense in depth.

### Defense Layers

| Layer | Prevents | Enforced by | Bypassable? |
|---|---|---|---|
| GitHub branch protection | Push to main, force push, unreviewed merge | GitHub server | No |
| Sealed settings.json | Removing hooks or MCP allowlists | `chattr +i` as root, then drop to `daytona` user | No |
| Supabase MCP allowlist | SQL execution, migrations, deploys | Claude Code permissions | No |
| Fine-grained PAT | Repo deletion, org access, secret access | GitHub token scope | No |
| Network policy | Data exfiltration | Daytona platform (Tier 3+) | No |
| Ephemeral sandbox | Persistent damage | Daytona auto-delete | N/A |
| PreToolUse hooks | Push to main, settings tampering | Claude Code hooks | Difficult |
| Secret sanitization | Token leakage in logs | `sanitize_secrets()` + `log-commands.sh` | Partial |

### Requirements

**GitHub Branch Protection** (most important layer):
- Require PR reviews (1+ reviewer), dismiss stale reviews on new commits
- Require status checks, no bypass (even admins), no direct push, no force push, no deletions

**Fine-Grained PAT** (scoped to specific repo):
- Grant: `contents:read+write`, `pull_requests:read+write`, `issues:read+write`
- Deny: `admin`, `actions`, `secrets`, `security_events`, `pages`
- Lifetime: 90-day max, rotate before expiry

**Daytona Tier 3+** — Tiers 1-2 have restricted network that can't be overridden. Tier 3+ has full internet with configurable firewall. Required for MCP access and web research.

### Sealed Settings

```bash
chattr +i ~/.claude/settings.json   # immutable — only root can undo
# Entrypoint then drops to `daytona` user via `su` or `gosu` before starting agent
```

This prevents the agent from:
- Removing hooks (block-push-to-main, log-commands)
- Removing the Supabase MCP allowlist
- Adding permissions to call blocked tools

The `block-push-to-main` hook also blocks attempts to write to settings files or modify git hooks paths as a second line of defense.

### Secret Sanitization

All text posted to GitHub (PR comments, session reports, logs) passes through `sanitize_secrets()`. Both the runner and `log-commands.sh` hook redact:

- Named env vars: `GITHUB_TOKEN`, `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `SUPABASE_ACCESS_TOKEN`
- Pattern-based: `ghp_*`, `ghs_*`, `sk-*`, `Bearer *`

**Limitation:** `log-commands.sh` only redacts the command string, not stdout/stderr. Mitigation: the session report only posts the last 50 lines of the *command log*, not raw stdout. Network policy prevents exfiltration to arbitrary domains.

### Network Policy

Daytona provides two network controls: `networkBlockAll` (blocks everything) and `networkAllowList` (up to 5 IPv4 CIDRs, no domains). Regardless of either setting, Daytona always allows "essential services" (npm, PyPI, GitHub, GitLab, Anthropic, OpenAI, Supabase, Vercel, Docker Hub, GHCR, etc.).

We use **Daytona's default network policy** (no `networkBlockAll`, no custom `networkAllowList`) because:

1. `networkBlockAll` would break MCP servers that call external APIs (Context7 → `mcp.context7.com`, Telegram → `api.telegram.org`)
2. `networkAllowList` is limited to 5 IPv4 CIDRs — too few and too fragile (IPs change) for MCP endpoints
3. The essential services list already covers the high-value targets
4. The agent needs open web access for research — `WebFetch` and `WebSearch` are read-only (can't POST data or exfiltrate secrets via HTTP)

**If stricter network isolation is needed later:** Use `networkBlockAll: true` and run MCPs in stdio mode (local process, no external API calls). Context7 supports stdio via `npx @upstash/context7-mcp`. This trades convenience for isolation.

### Prompt Injection Defense

Three independent layers:

1. **Boundary markers** — all user-submitted content (issue bodies, review comments, PR bodies) wrapped in explicit boundary markers with warnings in every prompt. Applied in: `run-builder.sh` (PRD file, bug prompt, review-fix prompt), `run-reviewer.sh` (original task, builder review).
2. **PreToolUse sandbox guard** (`block-push-to-main.sh`) — blocks bash commands that reference secret env vars (`$GITHUB_TOKEN`, `$ANTHROPIC_API_KEY`, `$CLAUDE_CODE_OAUTH_TOKEN`, `$SUPABASE_ACCESS_TOKEN`, `$TELEGRAM_BOT_TOKEN`) in outbound network calls (`curl`, `wget`, `nc`, `netcat`, `python http`, `node http`, `fetch`). Also blocks `env`/`printenv`/`set` and `cat .env` piped to outbound commands. Fires before every Bash tool invocation.
3. **Sealed settings** — agent cannot remove the guard hook or modify permissions (settings.json is immutable).

**Limitation:** The sandbox guard uses regex pattern matching. Sophisticated obfuscation (base64 encoding, writing to a temp file then curling it, using Python's `requests` library with an env var read) could theoretically bypass it. The guard catches common/obvious attack patterns. GitHub branch protection remains the hard stop for the most critical action (pushing to main).

**Remaining exfiltration risk:** The agent could use `curl` via Bash to POST secrets to an arbitrary URL. Mitigations: fine-grained PAT limits damage, `log-commands.sh` redacts secrets from command strings, ephemeral sandbox limits the window of exposure.

### Supabase Safety

Supabase is **not set up for every project** — only when the user configures `mcp_servers.supabase` in `.sodaprompts.yml`. Auto-detected at boot and scoped via tool allowlist.

Supabase branches are separate Postgres instances. The agent uses them for **testing against the current production schema** — not to run migrations or modify schema. Branches are billed per hour, so the lifecycle minimizes uptime:

```
1. Agent writes migration files and code (no branch yet)
2. Agent needs to test → create_branch("sodaprompts-prd-42")
3. Agent runs tests against branch connection string (mirrors prod schema)
4. Tests pass → delete_branch("sodaprompts-prd-42") immediately
5. Agent continues coding (branch is gone)
6. If needed again later → create a new branch (fast, <30s)
```

The agent **never runs migrations**. It writes migration files and includes them in the PR. The project owner runs `supabase db push` (or their own migration command) after merging.

**Tool allowlist** (only these permitted):

| Tool | Purpose |
|---|---|
| `create_branch`, `delete_branch`, `list_branches`, `reset_branch` | Branch lifecycle |
| `list_tables`, `get_schemas`, `list_migrations` | Read-only introspection |
| `get_project_url`, `search_docs`, `get_logs` | Reference |

Blocked: `execute_sql`, `apply_migration`, `deploy_edge_function`, `merge_branch`.

**Orphan cleanup:** On session start, builder lists branches with `sodaprompts-` prefix and deletes leftovers from crashed sessions.

### Error Handling

Redact secrets in sandbox creation error output:

```bash
OUTPUT=$(daytona sandbox create ... 2>&1) || {
  SAFE_OUTPUT=$(echo "$OUTPUT" | sed \
    -e "s/${ANTHROPIC_API_KEY:-___}/[REDACTED]/g" \
    -e "s/${CLAUDE_CODE_OAUTH_TOKEN:-___}/[REDACTED]/g" \
    -e "s/${GITHUB_TOKEN:-___}/[REDACTED]/g")
  echo "::error::Sandbox creation failed: $SAFE_OUTPUT"
  exit 1
}
```

### Volume Hygiene

- Prune session files (`.id`) after 7 days
- Delete session data older than 30 days
- Manual purge: `daytona volume delete sodaprompts-<project>`
- `CLAUDE_CODE_OAUTH_TOKEN` valid 1 year — document annual rotation in onboarding
- `/sodaprompts-ship status` should warn if token was set >6 months ago

---

## Daytona API Capabilities

| Capability | Status |
|---|---|
| Create sandbox from snapshot (CLI: `daytona create --snapshot`, SDK: `CreateSandboxFromSnapshotParams`) | Available |
| Create sandbox from OCI image (SDK only: `CreateSandboxFromImageParams`) | Available (supports `resources` field; no CLI equivalent — CLI requires snapshot) |
| Create snapshot from image (CLI: `daytona snapshot create --image`) | Available |
| Create snapshot from Dockerfile (CLI: `daytona snapshot create --dockerfile`) | Available |
| Pass env vars at sandbox creation (CLI: `--env`, SDK: `envVars`) | Available |
| Mount volumes (CLI: `--volume name:/path`, SDK: `volumes: [{ volumeId, mountPath }]`) | Available (FUSE-based, free, no quota impact, max 100 per org) |
| Computer Use API (start/stop Xvfb + xfce4 + x11vnc + novnc) | Available (called externally via SDK/REST, launches processes inside sandbox) |
| Computer Use mouse/keyboard/screenshot/recording | Available |
| Stop/start sandbox (filesystem persisted) | Available |
| Archive/restore sandbox (cold storage) | Available |
| GHCR as container registry source | Explicitly supported (register at daytona.io/dashboard/registries) |
| Snapshot auto-deactivation | Automatic after 2 weeks of non-use; reactivate via SDK/API/dashboard |
| Snapshot a *running* sandbox's state | Not yet ([#2519](https://github.com/daytonaio/daytona/issues/2519)) |
| Point-in-time checkpoint/rollback | Not yet ([#2528](https://github.com/daytonaio/daytona/issues/2528)) |
| Fork filesystem + memory state | Coming soon |

We don't need #2519 or #2528 — the ephemeral model avoids the need for persistent sandbox state entirely.

**Volume limitations:** Volumes are FUSE-based mounts — slower than local sandbox filesystem, cannot be used for applications requiring block storage access (database tables). Fine for session data and logs.

---

## Migration Phases

### Phase 1: Scaffolder

- Build and publish `npx create-sodaprompts` (TS-only)
- Update `.sodaprompts.yml` schema with new fields (`agent`, `snapshot`, `review`)
- Keep Sprites as runtime — scaffolder just generates config
- Claude plugin becomes optional for onboarding

### Phase 2: Daytona Runtime

- Build Docker image (based on `daytonaio/sandbox`), publish to GHCR as `doer-claude:node-1.0.0`
- Create Daytona snapshot from GHCR image
- Write `entrypoint.sh` replacing `bootstrap.sh`
- Write `wake-sandbox.yml` workflow template
- Refactor `run-builder.sh` — remove idle-to-suspend, update paths, single-task execution, env-var-driven task type
- Refactor `run-reviewer.sh` — same changes as builder
- Simplify `ship-doer.sh` for Daytona
- Update `log-commands.sh` — new log path, add `CLAUDE_CODE_OAUTH_TOKEN` to sanitization
- Test with existing users

### Phase 3: Multi-Agent

- Build Codex and Aider snapshot variants
- Update `entrypoint.sh` for per-agent hook configuration
- Update scaffolder for agent-specific config
- Publish snapshot variants

### Phase 4: Polish

- Web onboarding UI (optional, generates `.sodaprompts.yml` via browser)
- Language-specific snapshots (Python, Rust)
- `sodaprompts` CLI for status/logs/kill without agent dependency

---

## Open Questions

1. **Cost model** — Daytona billing (per sandbox-minute? per creation?) affects parallel sandbox viability at scale.
2. **Stdout streaming** — for `ship logs` and Telegram `/logs`, confirm Daytona SDK `process.executeCommand()` streaming works for runner script output.
3. **Snapshot activation in CI** — if a project goes idle >2 weeks, the snapshot auto-deactivates. The wake workflow needs a pre-creation activation step or fallback to `CreateSandboxFromImageParams` (slower first run, fast after image cache).
4. **GHCR registry setup** — Daytona requires private registries to be registered at `daytona.io/dashboard/registries` with a GitHub PAT scoped to `write:packages`, `read:packages`, `delete:packages`. The scaffolder should automate or document this step.
5. **Heartbeat implementation** — the entrypoint needs a background heartbeat to keep long sessions alive. Determine the lightest Toolbox API call that resets `autoStopInterval` (e.g. `GET /toolbox/{sandboxId}/filesystem/list?path=/`). The heartbeat script needs the sandbox ID — verify it's available inside the sandbox as an env var or via metadata endpoint.
