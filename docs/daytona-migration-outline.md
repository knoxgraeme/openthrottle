# Daytona Migration Outline

> Moving from Sprites + Claude plugin to Daytona sandboxes with agent-agnostic distribution.

## Goals

1. **Agent-agnostic** — users choose Claude, Codex, Aider, or any future agent
2. **No plugin install required** — `npx create-sodaprompts` replaces `/sodaprompts-setup` as the primary onboarding path
3. **Generic snapshot** — one published OCI image per agent runtime; project config is read at boot from `.sodaprompts.yml`
4. **Keep subscription auth** — Claude `login` device flow stays; auth is baked into the snapshot after first login

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

### Target (Daytona + Scaffolder)

```
npx create-sodaprompts      ← agent-agnostic scaffolder generates config
git push                     ← .sodaprompts.yml + wake workflow committed
GitHub Action                ← wakes Daytona sandbox on issue label
```

- Any agent runtime supported via snapshot variants
- Claude plugin becomes optional enhancement, not requirement
- Config-driven: all project specifics live in `.sodaprompts.yml`

---

## Snapshot Architecture

### Layer 1: Generic Base Snapshot (published, same for everyone)

One snapshot per agent runtime. Pre-installed:

- System packages: git, gh, jq, curl, chromium, xvfb
- Language runtimes: Node.js + pnpm (start here; Python/Go/Rust variants later)
- Agent binary: Claude Code, Codex, or Aider (one per snapshot variant)
- Sodaprompts orchestration: run-builder.sh, run-reviewer.sh, bootstrap-common.sh
- Default MCP servers: Telegram, Context7
- Entrypoint script

Published as:

```
sodaprompts/doer-claude:node       ← Claude Code + Node.js
sodaprompts/doer-codex:node        ← Codex + Node.js
sodaprompts/reviewer-claude:node   ← lighter image for review sprite
```

Future variants for language coverage:

```
sodaprompts/doer-claude:python
sodaprompts/doer-claude:rust
sodaprompts/doer-claude:full       ← fat image, all runtimes
```

### Layer 2: Project Init (happens at sandbox boot)

The entrypoint script runs at sandbox creation. Everything project-specific comes from env vars + `.sodaprompts.yml` in the repo:

1. `gh repo clone $GITHUB_REPO`
2. Read `.sodaprompts.yml` for test/build/lint commands, post_bootstrap, MCP servers
3. Run `post_bootstrap` commands (e.g. `pnpm install`)
4. Configure agent: merge project MCP servers, set up hooks
5. Apply network policy from config
6. Start runner loop (`run-builder.sh` or `run-reviewer.sh`)

### Auth Flow

Interactive login is preserved for subscription users:

```
1. daytona sandbox create --snapshot sodaprompts/doer-claude:node
2. daytona ssh <sandbox>
3. claude login                    ← one-time browser device flow
4. daytona snapshot <sandbox>      ← auth baked into personal snapshot
5. All future sandboxes boot from the authed snapshot
```

API key users skip steps 2-4 — just pass `ANTHROPIC_API_KEY` as an env var at sandbox creation.

---

## Onboarding: `npx create-sodaprompts`

Replaces the interactive `/sodaprompts-setup` Claude skill as the primary onboarding path.

### What It Does

1. Detects project: reads `package.json`, `pyproject.toml`, `Cargo.toml`, etc.
2. Prompts for config values (with smart defaults):
   - Base branch
   - Test / build / lint / format commands
   - Agent runtime (claude / codex / aider)
   - Notification provider (telegram / none)
   - Sprite name
3. Generates `.sodaprompts.yml`
4. Copies `.github/workflows/wake-sprite.yml` into the repo
5. Prints next steps (set GitHub secrets, create sandbox, login)

### Implementation

- ~150 lines of JS
- Published as `@sodaprompts/create-sodaprompts` on npm
- Uses `prompts` (or similar) for interactive questions
- Zero dependencies on any agent CLI

### Three Onboarding Tiers

| User | Path | Agent-locked? |
|------|------|--------------|
| Claude Code user | `/sodaprompts-setup` (existing skill) | Yes — premium UX, does scaffolding + shipping in one flow |
| Any developer | `npx create-sodaprompts` | No — generates config, user ships manually |
| Power user | Copy template, edit YAML by hand | No |

---

## What Changes in Existing Code

### Runner Scripts (run-builder.sh, run-reviewer.sh)

**Keep as-is.** Already agent-agnostic via `AGENT_RUNTIME` env var. Move from being uploaded per-sprite to being baked into the base snapshot at `/opt/sodaprompts/`.

### bootstrap.sh → entrypoint.sh

**Simplify.** Half the current bootstrap steps disappear because they're pre-baked into the snapshot:

| Current bootstrap step | In Daytona |
|----------------------|-----------|
| Install system packages | Baked into snapshot |
| Install GitHub CLI | Baked into snapshot |
| Install Claude Code | Baked into snapshot |
| Install sodaprompts plugin | Baked into snapshot |
| Install agent-browser + Playwright | Baked into snapshot |
| Install Telegram MCP | Baked into snapshot |
| Clone repo | Entrypoint (runtime) |
| Run post_bootstrap | Entrypoint (runtime) |
| Configure MCP servers from config | Entrypoint (runtime) |
| Apply network policy | Entrypoint (runtime) |
| Start runner loop | Entrypoint (runtime) |

The new `entrypoint.sh` is ~50 lines instead of ~400.

### ship-doer.sh

**Simplify.** Current 12-step flow becomes ~5 steps:

1. Read `.sodaprompts.yml`
2. Create Daytona sandbox from snapshot (with env vars)
3. Wait for health check
4. Install wake workflow (if not already in repo)
5. Print summary

Steps that disappear: locate plugin, upload files, push env (env vars passed at creation), run bootstrap (entrypoint handles it), checkpoint (snapshot model).

### Hooks

**Keep the logic, change the wiring.** The hook scripts (`block-push-to-main.sh`, `log-commands.sh`, `auto-format.sh`) are agent-agnostic bash. Only the registration in `settings.json` is Claude-specific. For other agents, the entrypoint configures the equivalent hook system.

### `/sodaprompts-setup` Skill

**Keep as optional.** Still works for Claude users. Internally, it could call `create-sodaprompts` for config generation, then handle the Daytona-specific shipping.

### `/sodaprompts-ship` Skill

**Keep as-is.** It just creates GitHub Issues — already agent-agnostic in function, just invoked from Claude. Other agents can use `gh issue create` directly, or we add the same commands to the scaffolder CLI later.

---

## `.sodaprompts.yml` Schema Changes

New fields for agent-agnostic support:

```yaml
# Existing fields (unchanged)
base_branch: main
test: pnpm test
build: pnpm build
lint: pnpm lint
format: pnpm prettier --write
notifications: telegram
sprite: soda-base
post_bootstrap:
  - pnpm install
mcp_servers: {}
network_policy:
  allow:
    - github.com
    - "*.anthropic.com"

# New fields
agent: claude                    # claude | codex | aider
runtime: node                    # node | python | rust | full (determines snapshot variant)

# Reviewer config (unchanged, already optional)
reviewer:
  sprite: soda-reviewer
  agent_runtime: claude
  max_rounds: 3
```

---

## GitHub Action Changes

The `wake-sprite.yml` workflow changes from `sprite` CLI calls to Daytona SDK/CLI:

```yaml
# Current
- run: |
    sprite start ${{ vars.BUILDER_SPRITE }}
    sprite exec -s ${{ vars.BUILDER_SPRITE }} -- bash /home/sprite/run-builder.sh

# Target
- uses: daytonaio/create-sandbox@v1
  with:
    snapshot: sodaprompts/doer-${{ env.AGENT }}:${{ env.RUNTIME }}
    env: |
      GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}
      GITHUB_REPO=${{ github.repository }}
      TELEGRAM_BOT_TOKEN=${{ secrets.TELEGRAM_BOT_TOKEN }}
      TELEGRAM_CHAT_ID=${{ secrets.TELEGRAM_CHAT_ID }}
```

If using subscription auth (not API key), the action references the user's personal authed snapshot instead of the generic public one.

---

## Migration Path

### Phase 1: Scaffolder (no Daytona changes yet)

- Build and publish `npx create-sodaprompts`
- Add `agent` and `runtime` fields to `.sodaprompts.yml` schema
- Keep Sprites as the runtime — scaffolder just generates config
- Claude plugin still works, now optional for onboarding

### Phase 2: Daytona Runtime

- Build generic base snapshots (start with `doer-claude:node`)
- Write `entrypoint.sh` replacing `bootstrap.sh`
- Simplify `ship-doer.sh` for Daytona
- Update `wake-sprite.yml` template for Daytona action
- Test with existing users

### Phase 3: Multi-Agent

- Build Codex and Aider snapshot variants
- Update `entrypoint.sh` to configure hooks per agent runtime
- Update scaffolder to handle agent-specific config generation
- Publish snapshot variants

### Phase 4: Polish

- Web onboarding UI (optional, generates `.sodaprompts.yml` via browser)
- Language-specific slim snapshots (python, rust)
- `sodaprompts` CLI for status/logs/kill without agent dependency

---

## Open Questions

1. **Daytona snapshot persistence** — do sandboxes survive between tasks (like Sprites checkpoints), or are they ephemeral per GitHub Action run? This affects auth caching and cost.
2. **Snapshot registry** — where do we publish OCI images? Daytona's registry, Docker Hub, GitHub Container Registry?
3. **Auth refresh** — if sandboxes are ephemeral, how do subscription users avoid re-login per task? Possible: store session token as GitHub secret, inject at boot.
4. **Reviewer sprite** — same sandbox or separate? Currently two sprites; with Daytona, could be two sandboxes or one sandbox with two processes.
5. **Cost model** — Sprites charge per-sprite with sleep/wake. How does Daytona bill? Affects whether we keep long-lived sandboxes vs ephemeral per task.
