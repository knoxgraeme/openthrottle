---
title: "feat: Build npx create-sodaprompts scaffolder"
type: feat
status: completed
date: 2026-03-19
origin: docs/daytona-migration-plan.md
---

# feat: Build `npx create-sodaprompts` scaffolder

## Overview

Build and publish `@sodaprompts/create-sodaprompts` — a standalone npm package that onboards any project to sodaprompts in ~2 minutes. Zero agent CLI dependencies. Runs via `npx create-sodaprompts`, detects the project, prompts for config, generates `.sodaprompts.yml` + `wake-sandbox.yml`, creates a Daytona snapshot + volume, and prints next steps.

This is Phase 1 of the Daytona migration (see origin: `docs/daytona-migration-plan.md` lines 797-802). Phase 2 (runtime) is already code complete in `daytona/`.

## Problem Statement

Current onboarding requires Claude Code installed (`claude plugin install knoxgraeme/sodaprompts` → `/sodaprompts-setup`). This locks out Codex users, Aider users, and anyone without Claude Code. The scaffolder makes onboarding agent-agnostic.

## Proposed Solution

A single JavaScript file (~200 lines) published as `@sodaprompts/create-sodaprompts`. Uses `prompts` for interactive config collection, `@daytonaio/sdk` for snapshot/volume creation, and plain `fs` for file generation.

### User Flow

```
$ npx create-sodaprompts

  Detected: package.json (pnpm monorepo)

  Base branch: main
  Test command: pnpm test
  Build command: pnpm build
  Lint command: pnpm lint
  Format command: pnpm prettier --write
  Dev command: pnpm dev --port 8080 --hostname 0.0.0.0
  Agent runtime: claude
  Notifications: telegram

  ✓ Generated .sodaprompts.yml
  ✓ Copied .github/workflows/wake-sandbox.yml
  ✓ Created Daytona snapshot: sodaprompts-doer-claude-node
  ✓ Created Daytona volume: sodaprompts-myproject

  Next steps:
  1. Set GitHub repo secrets:
     DAYTONA_API_KEY, ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN)
     Optional: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
  2. git add .sodaprompts.yml .github/workflows/wake-sandbox.yml
  3. git commit -m "feat: add sodaprompts config" && git push
  4. Label an issue with prd-queued to ship your first prompt!
```

## Technical Approach

### Package Structure

```
packages/create-sodaprompts/
├── package.json
├── index.mjs          # Main scaffolder (~200 lines)
└── templates/
    └── wake-sandbox.yml   # Copied from daytona/wake-sandbox.yml
```

Published as `@sodaprompts/create-sodaprompts` with `bin: { "create-sodaprompts": "./index.mjs" }`.

### Dependencies

| Package | Purpose | Why |
|---|---|---|
| `prompts` | Interactive CLI prompts | Lightweight, no peer deps, well-maintained |
| `@daytonaio/sdk` | Snapshot + volume creation | Official Daytona TS SDK |
| `yaml` | YAML generation | Write `.sodaprompts.yml` with comments |

No agent CLIs. No build step (plain ESM). Node 18+.

### 7-Step Implementation

#### Step 1: Detect project

Read `package.json` in cwd. Extract:
- Package manager: check `packageManager` field → `pnpm-lock.yaml` → `yarn.lock` → `package-lock.json` → default `npm`
- Scripts: `test`, `dev`, `build`, `lint`, `format` from `scripts`
- Project name: from `name` field (used for volume naming)
- Base branch: `git rev-parse --abbrev-ref HEAD` or `git remote show origin | grep 'HEAD branch'`

If no `package.json` found, error: "No package.json found. create-sodaprompts currently supports Node.js projects only."

#### Step 2: Prompt for config

Using `prompts`, collect values with detected defaults pre-filled:

| Prompt | Type | Default | Notes |
|---|---|---|---|
| Base branch | text | detected | |
| Test command | text | `{pm} test` | Pre-filled from package.json |
| Build command | text | `{pm} build` | Pre-filled from package.json |
| Lint command | text | `{pm} lint` | Pre-filled from package.json |
| Format command | text | `{pm} prettier --write` | Pre-filled from package.json or devDeps |
| Dev command | text | `{pm} dev --port 8080 --hostname 0.0.0.0` | Append port/host if not present |
| Post-bootstrap | text | `{pm} install` | |
| Agent runtime | select | `claude` | Options: claude, codex, aider |
| Notifications | select | `telegram` | Options: telegram, none |
| Review enabled | confirm | `true` | |
| Max review rounds | number | `3` | Only if review enabled |

Where `{pm}` is the detected package manager.

#### Step 3: Generate `.sodaprompts.yml`

Write YAML using the `yaml` library. Include comments matching the schema template at `daytona/sodaprompts-schema.yml`. Derive snapshot name: `sodaprompts-doer-{agent}-node`.

#### Step 4: Copy `wake-sandbox.yml`

Copy the bundled workflow template to `.github/workflows/wake-sandbox.yml`. Create the directory if it doesn't exist. The template is static — no templating needed (it reads the snapshot name from `.sodaprompts.yml` at runtime).

#### Step 5: Create Daytona snapshot

Requires `DAYTONA_API_KEY` env var.

```typescript
import { Daytona } from '@daytonaio/sdk';

const daytona = new Daytona();
await daytona.snapshot.create({
  name: snapshotName,  // e.g. 'sodaprompts-doer-claude-node'
  image: `ghcr.io/sodaprompts/doer-${agent}:node-1.0.0`,
  resources: { cpu: 2, memory: 4, disk: 10 },
});
```

**Gotcha (from origin plan):** `snapshot create` memory unit is GB (not MB like `daytona create --memory`). SDK `memory` is GiB.

If snapshot already exists (409 conflict), skip with message: "Snapshot already exists — skipping."

#### Step 6: Create Daytona volume

```typescript
await daytona.volume.create({
  name: `sodaprompts-${projectName}`,
});
```

Volume is free, no storage quota impact. Mounted at `/home/daytona/.claude` on every sandbox.

If volume already exists, skip with message: "Volume already exists — skipping."

#### Step 7: Print next steps

Print required GitHub secrets, git commands, and how to ship the first prompt. Include both auth options (API key vs subscription token).

### Error Handling

| Scenario | Behavior |
|---|---|
| No `package.json` | Error with clear message |
| No `DAYTONA_API_KEY` | Error: "Set DAYTONA_API_KEY env var. Get one at daytona.io/dashboard" |
| Snapshot create fails (not 409) | Error with Daytona API message |
| Volume create fails (not 409) | Error with Daytona API message |
| `.sodaprompts.yml` already exists | Prompt: "Overwrite existing config?" |
| `wake-sandbox.yml` already exists | Prompt: "Overwrite existing workflow?" |
| User cancels prompts (Ctrl+C) | Clean exit, no files written |

### What the Scaffolder Does NOT Do

- Install any agent CLI (Claude, Codex, Aider)
- Push to git or create commits
- Set GitHub secrets (user does this manually)
- Create GitHub labels (the wake workflow handles label-based triggers)
- Build or push the Docker image (pre-published to GHCR)

## Acceptance Criteria

- [ ] `npx create-sodaprompts` runs successfully in a Node.js project
- [ ] Detects package manager (pnpm/yarn/npm) and pre-fills commands
- [ ] Generates valid `.sodaprompts.yml` matching the schema at `daytona/sodaprompts-schema.yml`
- [ ] Copies `wake-sandbox.yml` to `.github/workflows/`
- [ ] Creates Daytona snapshot via SDK (idempotent — skips if exists)
- [ ] Creates Daytona volume via SDK (idempotent — skips if exists)
- [ ] Prints clear next steps with all required GitHub secrets listed
- [ ] Errors clearly on missing `package.json` or `DAYTONA_API_KEY`
- [ ] Handles existing config/workflow with overwrite prompt
- [ ] Zero agent CLI dependencies
- [ ] Package published as `@sodaprompts/create-sodaprompts`

## MVP

### packages/create-sodaprompts/package.json

```json
{
  "name": "@sodaprompts/create-sodaprompts",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "create-sodaprompts": "./index.mjs"
  },
  "dependencies": {
    "@daytonaio/sdk": "^0.54.0",
    "prompts": "^2.4.2",
    "yaml": "^2.4.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

### packages/create-sodaprompts/index.mjs

The main scaffolder implementing the 7-step flow above (~200 lines).

### packages/create-sodaprompts/templates/wake-sandbox.yml

Verbatim copy of `daytona/wake-sandbox.yml`.

## Sources & References

- **Origin document:** [docs/daytona-migration-plan.md](docs/daytona-migration-plan.md) — Phase 1 scaffolder spec (lines 443-467, 797-802), onboarding tiers (lines 461-467), full user workflow (lines 471-527)
- **Target schema:** [daytona/sodaprompts-schema.yml](daytona/sodaprompts-schema.yml) — exact YAML format to generate
- **Workflow template:** [daytona/wake-sandbox.yml](daytona/wake-sandbox.yml) — file to bundle and copy
- **Existing onboarding:** [skills/sodaprompts-setup/SKILL.md](skills/sodaprompts-setup/SKILL.md) — current flow being replaced
- **Daytona SDK gotchas:** Origin plan lines 72-87 — unit mismatches, snapshot vs image params
