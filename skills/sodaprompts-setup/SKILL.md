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

1. **Preflight** — deterministic script checks tools, env vars, project files
2. **Detect project** — read package.json, infer test/dev/format commands
3. **Generate config** — write `.sodaprompts.yml`, confirm with user
4. **Discover .env files** — find all .env files to push to the sprite
5. **Ship Doer** — deterministic script: create sprite, bootstrap, verify, checkpoint
6. **Reviewer** — (optional) ask user, then deterministic script for reviewer sprite

Steps 1 and 5-6 are deterministic scripts. Steps 2-4 are interactive (agent-driven).

---

## Step 1 — Preflight

Run the deterministic preflight script. It checks all prerequisites (sprite CLI,
gh CLI, authentication, env vars, project files) and exits non-zero with clear
fix instructions if anything fails. **Stop if it fails.**

Locate the script relative to this skill's directory:

```bash
PREFLIGHT="$(find ~/.claude -path '*/sodaprompts-setup/scripts/preflight.sh' -type f | head -1)"
if [[ -z "$PREFLIGHT" ]]; then
  echo "ERROR: preflight.sh not found. Is the sodaprompts plugin installed?"
  echo "  Fix: claude plugin install knoxgraeme/sodaprompts"
  exit 1
fi
bash "$PREFLIGHT"
```

---

## Step 2 — Detect Project

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

## Step 3 — Generate Config

Write `.sodaprompts.yml` using the detected values from Step 2.
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
come from `.env` files pushed to the sprite (see Step 4).

### Network Policy

The Sprites platform supports L3 DNS-based egress filtering — restricting which
domains the sprite can connect to. Applied via the Sprites REST API from
**outside** the sprite (setup script + wake workflow). The sprite never has
access to `SPRITES_TOKEN` and cannot modify its own policy.

API ref: https://sprites.dev/api/sprites/policies

By default (no policy set), egress is **unrestricted**. When a policy is set,
rules are evaluated in order. A deny-all catch-all (`{"action":"deny","domain":"*"}`)
is appended automatically to block everything not explicitly allowed.

Policy is applied automatically by `ship-doer.sh` (step 8) — after bootstrap,
before the golden-base checkpoint. Since policies are sprite-level config (not
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

## Step 4 — Discover .env Files

Preflight already validated that required pipeline vars exist in `.env`.
Now discover all `.env` files that need to be pushed to the sprite:

```bash
find . \( -name '.env' -o -name '.env.local' -o -name '.env.*' \) -print | grep -v node_modules | grep -v .git | sort
```

Show the user what was found and confirm before pushing. The actual push
is handled automatically by `ship-doer.sh` (step 6).

All `.env` files are gitignored. They become part of the `golden-base`
checkpoint — every run starts with the full env available.

> **Note:** `SPRITES_TOKEN` is NOT stored in `.env`. It's only needed as a
> GitHub Actions secret (for the wake workflow) and on your machine for
> setup (network policy step). The sprite CLI authenticates via `sprite login`.

---

## Step 5 — Ship Doer Sprite

Run the deterministic ship script. It handles everything: sprite creation,
auth check, file upload, bootstrap, network policy, checkpoint, verification,
and wake workflow installation.

Locate and run the script:

```bash
SHIP_DOER="$(find ~/.claude -path '*/sodaprompts-setup/scripts/ship-doer.sh' -type f | head -1)"
if [[ -z "$SHIP_DOER" ]]; then
  echo "ERROR: ship-doer.sh not found. Is the sodaprompts plugin installed?"
  exit 1
fi
bash "$SHIP_DOER"
```

### Reading the output

The script outputs structured markers:
- `===SHIP_STEP_OK===` after each successful step
- `===SHIP_ERROR_BEGIN===` ... `===SHIP_ERROR_END===` on failure (JSON with
  `step_name`, `failed_command`, `error_output`, `suggested_fix`, `resume_command`)
- `===SHIP_COMPLETE===` on success

### If a step fails

Parse the error JSON. The `suggested_fix` field tells you what to fix.
The `resume_command` field gives you the exact command to re-run from
the failed step (e.g., `bash ship-doer.sh --from-step 7`).

**Auth failures (step 4)** require manual browser login — tell the user:
1. `sprite console -s <sprite>`
2. Run `claude` inside the sprite
3. Open the URL in their browser and log in
4. Ctrl+C, then re-run from step 4

**Bootstrap failures (step 7)** — check the output for the root cause.
Common: bad GITHUB_TOKEN, npm install failures, no internet access.

**If a fix isn't obvious**, the agent can also destroy and start fresh:
```bash
sprite destroy "$SPRITE"
# Then re-run ship-doer.sh from step 1
```

---

## Step 6 — Reviewer (Optional)

After the Doer sprite is verified, ask the user:

> "Would you like to add automated PR review? This creates a second Thinker
> Sprite that auto-reviews PRs opened by the Doer."

If **no** → skip, remind them they can add it later by re-running setup.

If **yes** → ask for configuration:

| Setting | Default | Question |
|---|---|---|
| Sprite name | `soda-reviewer` | "What name for the reviewer sprite?" |
| Agent runtime | `claude` | "Which agent runtime? (claude / codex)" |
| Max review rounds | `3` | "Max review rounds before auto-approve?" |
| Poll interval | `60` | "Poll interval in seconds?" |

Add the `reviewer` section to `.sodaprompts.yml`:

```yaml
reviewer:
  sprite: soda-reviewer
  agent_runtime: claude
  max_rounds: 3
  poll_interval: 60
```

Then run the reviewer ship script:

```bash
SHIP_REVIEWER="$(find ~/.claude -path '*/sodaprompts-setup/scripts/ship-reviewer.sh' -type f | head -1)"
if [[ -z "$SHIP_REVIEWER" ]]; then
  echo "ERROR: ship-reviewer.sh not found. Is the sodaprompts plugin installed?"
  exit 1
fi
bash "$SHIP_REVIEWER"
```

Same structured output format as ship-doer.sh. Same error handling approach.

Tell the user to also set `REVIEWER_SPRITE` variable in GitHub Actions.

---

## Finish

Remind the user to commit `.sodaprompts.yml` and `.github/workflows/wake-sprite.yml`.
