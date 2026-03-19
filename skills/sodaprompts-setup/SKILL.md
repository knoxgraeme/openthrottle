---
name: sodaprompts-setup
description: >
  One-time setup of Soda Prompts for a project. Creates or connects to a
  Sprite, detects the project stack, generates .sodaprompts.yml, bootstraps
  the Sprite with tools/hooks/skills, and checkpoints as golden-base.
  Use when: "set up soda prompts", "bootstrap the sprite", "configure sodaprompts",
  or first-time onboarding for any project. Also related:
  /sodaprompts-ship for shipping prompts after setup is complete.
disable-model-invocation: true
argument-hint: [--sprite sprite-name]
---

# Soda Prompts Setup

Onboard a project to Soda Prompts. Idempotent — safe to re-run.

## Workflow Overview

1. **Prerequisites** — verify sprite CLI, gh CLI, sprite auth
2. **Detect project** — read package.json, infer test/dev/format commands
3. **Generate config** — write `.sodaprompts.yml`, confirm with user
4. **Environment vars** — check all required secrets are set
5. **Bootstrap Doer sprite** — create sprite, upload files, run bootstrap
6. **Verify Doer** — smoke test the sprite
7. **Install wake workflow** — GitHub Action that wakes sprites on new work
8. **Reviewer prompt** — ask user if they want automated PR review
9. **(Optional) Bootstrap Thinker sprite** — second sprite for PR review

Steps 1-4 are interactive (below). Steps 5-9 are mechanical — see
[bootstrap-steps.md](references/bootstrap-steps.md).

---

## Prerequisites

```bash
which sprite || echo "MISSING: curl -fsSL https://sprites.dev/install.sh | sh"
sprite list 2>/dev/null || echo "MISSING: sprite org auth"
which gh || echo "MISSING: brew install gh"
gh auth status 2>/dev/null || echo "MISSING: gh auth login"
```

Stop if anything is missing.

---

## Step 1 — Detect Project

```bash
cat package.json | jq '{scripts: .scripts, packageManager: .packageManager}'
ls pnpm-workspace.yaml turbo.json lerna.json nx.json 2>/dev/null
ls tsconfig.json 2>/dev/null
head -50 CLAUDE.md 2>/dev/null || echo "No CLAUDE.md"
cat .sodaprompts.yml 2>/dev/null || echo "No existing config"
```

| Field | Detection |
|---|---|
| `test` | `package.json scripts.test` → `Makefile test` → `pytest` |
| `dev` | `package.json scripts.dev` + `--port 8080 --hostname 0.0.0.0` |
| `format` | `package.json scripts.format` → look for prettier in devDeps |
| `lint` | `package.json scripts.lint` |
| `build` | `package.json scripts.build` |
| `base_branch` | `git remote show origin \| grep 'HEAD branch'` |

For pnpm/turbo monorepos, prefix commands with `pnpm`.

---

## Step 2 — Generate Config

Write `.sodaprompts.yml` using the detected values from Step 1.
The reference at `references/sodaprompts-schema.yml` shows the structure — but you
should populate every field with actual detected values, not copy defaults.

**Every field should be filled in.** No commented-out sections. The config
is the source of truth for how the agent works with this project.

### What to write:

| Field | Source |
|---|---|
| `base_branch` | Detected from `git remote show origin` |
| `test` | Detected from `package.json scripts.test` |
| `dev` | Detected from `package.json scripts.dev` + `--port 8080 --hostname 0.0.0.0` |
| `format` | Detected from `package.json scripts.format` or prettier in devDeps |
| `lint` | Detected from `package.json scripts.lint` |
| `build` | Detected from `package.json scripts.build` |
| `post_bootstrap` | Always include dep install (`pnpm install`, `npm install`, etc.). Add `pnpm db:migrate` or similar if the project has a database setup step. |
| `mcp_servers` | Project-specific MCPs (see below). Use `{}` if none. |

### MCP Servers

Check what MCPs are configured locally:

```bash
cat ~/.claude/settings.json 2>/dev/null | jq '.mcpServers // empty'
cat .claude/settings.json 2>/dev/null | jq '.mcpServers // empty'
```

Show the user which MCPs were found and ask which ones the sprite should have.

| MCP | Why the sprite might need it |
|---|---|
| Supabase | If the agent needs to work with the database. **Auto-scoped for safety:** bootstrap denies `execute_sql`, `apply_migration`, `deploy_edge_function`, and `merge_branch`. The agent uses Supabase branches for isolated DB work and runs migrations via the project's own commands. |
| PostHog | If the agent needs analytics context |

**Always included (no config needed):** Telegram (notifications), Context7
(framework docs). These are installed by bootstrap automatically.

MCPs with secrets: use `"from-env"` as a placeholder. The actual values
come from `.env` files pushed to the sprite (see Step 3).

### Network Policy

The Sprites platform supports L3 DNS-based egress filtering — restricting which
domains the sprite can connect to. Applied via the Sprites REST API from
**outside** the sprite (setup script + wake workflow). The sprite never has
access to `SPRITES_TOKEN` and cannot modify its own policy.

API ref: https://sprites.dev/api/sprites/policies

By default (no policy set), egress is **unrestricted**. When a policy is set,
rules are evaluated in order. A deny-all catch-all (`{"action":"deny","domain":"*"}`)
is appended automatically to block everything not explicitly allowed.

Policy is applied once during **setup (Step 7)** — after bootstrap, before
the golden-base checkpoint. Since policies are sprite-level config (not
filesystem), they persist through checkpoint restore.

**Always-needed domains** (include in every config):

| Domain | Why |
|---|---|
| `github.com`, `*.github.com`, `*.githubusercontent.com` | Git operations, GitHub API, raw content |
| `*.anthropic.com` | Claude auth (always needed for Claude runtime) |
| `*.openai.com` | Codex auth (if using Codex runtime) |
| `api.telegram.org` | Telegram notifications |
| `*.npmjs.org`, `registry.npmjs.org` | npm package installs (env-reset needs these) |

**Auto-detect additional domains from MCP servers:**

For each entry in `mcp_servers`, inspect the config for URLs or well-known
service hostnames and add their domains to the allow list. For example, if
an MCP server's config contains `https://api.example.com/v1`, add
`*.example.com`. Show the user what was detected and let them adjust.

**Omit `network_policy` entirely** to leave egress unrestricted (not recommended).

Write the `network_policy` section with the detected domains. Example:

```yaml
network_policy:
  allow:
    - github.com
    - "*.github.com"
    - "*.githubusercontent.com"
    - "*.anthropic.com"
    - api.telegram.org
    - "*.npmjs.org"
    - registry.npmjs.org
    # + any domains detected from mcp_servers
```

### Privileges & Resources Policies (future)

Sprites also supports privileges (capability/device restrictions) and resources
(memory limits) policies via the same API. These should be configured when
their request schemas are documented. See https://sprites.dev/api/sprites/policies

### Confirm with user

Show the generated config and ask the user to confirm or edit before writing.
Then write to `.sodaprompts.yml` at the repo root.

---

## Step 3 — Environment Variables & .env Files

### Pipeline env vars

The following vars must be in the root `.env`. Check for them:

```bash
set -a && source .env && set +a
[[ -n "$GITHUB_TOKEN" ]]        && echo "ok GITHUB_TOKEN" || echo "MISSING GITHUB_TOKEN"
[[ -n "$GITHUB_REPO" ]]         && echo "ok GITHUB_REPO" || echo "MISSING GITHUB_REPO"
[[ -n "$TELEGRAM_BOT_TOKEN" ]]  && echo "ok TELEGRAM_BOT_TOKEN" || echo "MISSING TELEGRAM_BOT_TOKEN"
[[ -n "$TELEGRAM_CHAT_ID" ]]    && echo "ok TELEGRAM_CHAT_ID" || echo "MISSING TELEGRAM_CHAT_ID"
```

| Variable | Where to get it |
|---|---|
| `GITHUB_TOKEN` | GitHub → Settings → Developer settings → PAT (`repo` scope) |
| `GITHUB_REPO` | Auto-detect: `git remote get-url origin \| sed -E 's\|.*github.com[:/](.+/.+?)(.git)?$\|\1\|'` |
| `TELEGRAM_BOT_TOKEN` | Telegram `@BotFather` → `/newbot` |
| `TELEGRAM_CHAT_ID` | `https://api.telegram.org/bot<TOKEN>/getUpdates` |

> **Security note:** Do not paste your Telegram bot token into this chat for
> verification. To confirm your chat ID, open the getUpdates URL in your
> browser privately: `https://api.telegram.org/bot<TOKEN>/getUpdates`

**Note:** `SPRITES_TOKEN` is NOT stored in `.env`. It's only needed as a GitHub
Actions secret (for the wake workflow) and on your machine for setup (Step 7,
network policy). The sprite CLI authenticates via `sprite login`.

If any are missing, tell the user what to add to `.env` and stop.
The ship scripts source `.env` locally; setup pushes all `.env` files to the sprite.

### Project .env files

The sprite clones from GitHub, which doesn't include `.env` files. After
cloning, all local `.env` files are pushed to the sprite so the agent has
the same runtime environment you do.

Discover what's available:

```bash
find . \( -name '.env' -o -name '.env.local' -o -name '.env.*' \) -print | grep -v node_modules | grep -v .git | sort
```

Show the user what was found and confirm before pushing. The actual push
happens in Step 6b of [bootstrap-steps.md](references/bootstrap-steps.md)
during the bootstrap process.

All `.env` files are gitignored. They become part of the `golden-base`
checkpoint — every run starts with the full env available. Pipeline secrets
(GITHUB_TOKEN, TELEGRAM_BOT_TOKEN, etc.) are already in the root `.env`
from this step, so they get pushed with everything else.

---

## Steps 4-12 — Sprite Bootstrap

Once config is confirmed and env vars are set, follow the detailed commands
in [bootstrap-steps.md](references/bootstrap-steps.md) to:

4. Create or connect the Doer Sprite
5. Authenticate Claude on the Doer Sprite
6. Upload files and run bootstrap (~5 min)
7. Apply network egress policy (locks down outbound connections)
8. Checkpoint as `golden-base`
9. Smoke test
10. Install the wake workflow (`.github/workflows/wake-sprite.yml`) and tell user
    to set `SPRITES_TOKEN` secret and `BUILDER_SPRITE` variable in GitHub
11. Print summary
12. **Ask the user:** "Would you like to add automated PR review? This creates
    a second Thinker Sprite that auto-reviews PRs opened by the Doer."
    - If **yes** → follow the reviewer bootstrap steps (Steps 12a-12f),
      then tell user to also set `REVIEWER_SPRITE` variable in GitHub
    - If **no** → skip, remind them they can add it later by re-running setup

Remind the user to commit `.sodaprompts.yml` and `.github/workflows/wake-sprite.yml`.

### If bootstrap fails

If any step after sprite creation fails (bootstrap error, auth issue,
smoke test failure), clean up before retrying:

```bash
# Option 1: Destroy and start fresh
sprite destroy "$SPRITE"
# Then re-run /sodaprompts-setup

# Option 2: Reset the sprite and retry bootstrap
sprite checkpoint restore golden-base -s "$SPRITE"  # if checkpoint exists
# Or re-run the failed step manually
```

The setup is idempotent so re-running is always safe. The main risk is
orphaned sprites consuming resources — destroy any sprites you won't use.
