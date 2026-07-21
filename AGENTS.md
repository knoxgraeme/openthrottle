# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, OpenCode, and others) working
in this repository. This is the canonical instructions file; `CLAUDE.md` imports
it via `@AGENTS.md`.

## What this is

OpenThrottle is a plan-first coding pipeline. An approved Linear ticket is
delegated to an isolated Daytona sandbox running an agent CLI (Claude Code,
Codex, or OpenCode); the agent opens a GitHub PR on an `ot/*` branch; external
GitHub-native reviewers own review from there, and their feedback re-enters the
**same agent session** as a `resume`. The GitHub repo is `openthrottle-v2`; the
product, CLI, npm package, and Daytona snapshot are all named `openthrottle`.

```
Linear ticket ──> Fly supervisor ──> Daytona sandbox ──> ot/* branch + PR
     ▲                 │     ▲              │                    │
     └── activities ───┘     └── outbox ────┴── GitHub events ──┘
```

`docs/SPEC.md` holds the normative contracts (endpoints, DB schema, sandbox
phases, sanitization); `docs/PLAN.md` is the delivery/acceptance plan. When a
change touches a contract, SPEC.md is the source of truth — read it first.

## Repository is three separate npm projects

There is **no root `package.json`**. `supervisor/`, `cli/`, and `sandbox/` each
have their own. Always target one with `--prefix`:

```bash
# install
npm ci --prefix supervisor && npm ci --prefix cli && npm ci --prefix sandbox

# typecheck / build (supervisor + cli only; sandbox is JS)
npm run typecheck --prefix supervisor && npm run typecheck --prefix cli
npm run build --prefix supervisor && npm run build --prefix cli   # tsc -> dist/

# test
npm test --prefix supervisor             # vitest run
npm test --prefix cli
npm test --prefix sandbox                 # vitest over runner/bin/tests *.test.mjs
bats sandbox/tests/runtime.bats           # shell-level runtime.sh tests

# a single test file / name (npm passes args after `--` to vitest)
npm test --prefix supervisor -- src/db.test.ts
npm test --prefix supervisor -- -t "leases a delivery"

# supervisor local dev (tsx watch). NOTE: .env is NOT auto-loaded — export the
# vars from supervisor/.env.example yourself, or `dotenv -e .env -- npm run dev`.
npm run dev --prefix supervisor
```

Node 22 is required. TypeScript here is ESM with `moduleResolution: nodenext`,
so **relative imports carry a `.js` extension even when the source is `.ts`**
(e.g. `import { openDb } from "./db.js"`). Keep that convention.

### Full contract suite (what CI runs)

```bash
npm ci --prefix supervisor && npm ci --prefix cli && npm ci --prefix sandbox
npm run typecheck --prefix supervisor && npm run typecheck --prefix cli
npm run build --prefix supervisor && npm run build --prefix cli
npm test --prefix supervisor
npm test --prefix cli
npm test --prefix sandbox
bats sandbox/tests/runtime.bats
docker build -f sandbox/Dockerfile -t openthrottle:test .   # context is repo root
sandbox/tests/smoke.sh openthrottle:test                     # full lifecycle with stub agents
```

`.github/workflows/ci.yml` runs the typecheck/build/test/bats matrix plus the
docker smoke on every PR. Live Linear/Daytona/Fly acceptance is intentionally a
separate deployment gate (it consumes operator credentials) — never assume it
ran locally.

## Architecture: two collaborators with a hard split

The whole system is split between a **deterministic outer state machine (Fly
supervisor)** and **agent reasoning inside the sandbox (native Compound
Engineering / "CE")**. Keep new logic on the correct side:

- **`supervisor/`** — Hono + `better-sqlite3` control plane deployed on Fly
  (`src/index.ts` wires it up). It authenticates webhooks, owns all durable
  state, controls Daytona sandboxes, and publishes to Linear. It never contains
  agent reasoning. Key seams:
  - `db.ts` — the SQLite schema and store. Everything durable lives here:
    `tickets`, `runs`, `agent_sessions`, `session_work`, `webhook_deliveries`
    (leased/retrying inbox), `linear_outbox` (per-session-ordered delivery
    outbox), `sandbox_events`, `repository_registrations`, `settings`.
  - `server.ts` — all HTTP routes (`/webhooks/linear`, `/webhooks/github`,
    `/runs/:id/complete`, operator `/status` `/repositories` `/tickets/*`,
    `/oauth/*`, `/preview/*`, `/healthz`).
  - `webhook-delivery.ts` — the durable inbox: signature-verified events are
    stored, leased, and retried so a delivery survives restarts.
  - `sandbox-events.ts` — short-interval poller that reads agent activities and
    completion markers out of live Daytona sandboxes and feeds the outbox.
  - `linear-outbox.ts` / `linear.ts` / `linear-auth.ts` — Linear activities and
    session updates are persisted **before** delivery, with per-session ordering
    and OAuth refresh shared across webhook and sweep paths.
  - `run-lifecycle.ts` / `sandbox-lifecycle.ts` / `scheduler.ts` — one sandbox
    per ticket, run serialization, follow-up scheduling, review-rounds bounding.
  - `sweep.ts` — reaps stale sandboxes/resources on boot and periodically.
  - `sanitize.ts` — redacts named/nested secret values and known GitHub / OpenAI
    / Linear / bearer token shapes before anything is logged or published.
  - `daytona.ts`, `github.ts`/`github-events.ts`, `codex-auth.ts`, `config.ts`.

- **`sandbox/`** — the Daytona image and its runtime boundary.
  `entrypoint.sh` is Fly-launched (the image's own entrypoint is an inert no-op
  so provisioning can't race the supervisor) and runs an **8-phase lifecycle**:
  auth → checkout/push → sealed safety config → project config → post_bootstrap
  → dev server → agent task → completion marker. Supported task types are
  `implement`, `investigate`, and `resume`. `~/.ot` holds ticket context, logs,
  the agent session id, the normalized result, and the activity outbox that
  `bin/ot-activity.mjs` writes into. `runner/normalize.mjs` normalizes each
  engine's JSONL and emits throttled heartbeat `thought`s. `safety/pre-push`
  (with `core.hooksPath` root-sealed) blocks pushes to main/master and
  non-fast-forward — this complements, does not replace, GitHub branch
  protection.

- **`skills/`** — thin OpenThrottle task **adapters** over the native CE
  toolkit, not reimplementations. `skills/tasks/<name>/SKILL.md` is the single
  hand-maintained source per task (`implement-plan`, `investigate`); its YAML
  frontmatter is exactly what Claude Code loads as a user skill. The two agent
  loops: **implement** = plan gate → `ce-work` → local `ce-code-review` →
  conditional `ce-simplify` → configured gates → `ce-commit-push-pr` →
  resolve/retarget PR; **investigate** = action-capable `ce-debug
  mode:pipeline`. Read `skills/README.md` before editing anything here.

- **`cli/`** — the published `openthrottle` package (`src/index.ts` is a plain
  argv router, no framework). Commands: `setup`, `init`, `ship <file.md>`,
  `status`, `stop <ticket>`, `logs <ticket>`. `init` registers the GitHub
  repo + Linear-team route and writes `.openthrottle.yml`; it requires
  `OT_SUPERVISOR_URL` and `OT_STATUS_TOKEN`.

## Invariants worth knowing before you change things

- **Skills are adapters, never CE copies.** The snapshot installs the pinned
  `compound-engineering` plugin natively for all three engines. Do not copy CE
  source into `skills/` or into target repos. Each `SKILL.md` is agent-neutral
  and maintained once; the only per-agent difference is *delivery*, which lives
  entirely in `sandbox/entrypoint.sh` + `sandbox/Dockerfile` (Claude: copy into
  `~/.claude/skills`; Codex: admin-scope bake at `/etc/codex/skills` +
  `agents/openai.yaml`; OpenCode: prompt rendered at run time). Never
  hand-duplicate a skill body per agent.

- **Security boundary — sandbox credential set is minimal.** Only repo, Linear-
  session, and model credentials enter a sandbox; never Daytona, Fly, webhook,
  install, or operator tokens. Fly alone holds Linear app credentials and
  publishes as OpenThrottle. Git uses the `gh` credential helper against a clean
  origin URL so the token never lands in `.git/config`. **Registered repos are
  trusted for code execution** (their `.openthrottle.yml` `post_bootstrap` runs
  arbitrary commands); **ticket text, PR comments, and review bodies are always
  untrusted data** regardless of where they're read.

- **Routing is fail-closed.** One Linear team routes to one GitHub repo via
  `repository_registrations`. `GITHUB_REPO`/`BASE_BRANCH`/`GITHUB_REPO_MAPPINGS`
  are legacy fallbacks only until the first durable registration exists; after
  that an unmatched team is rejected, not sent to a fallback. A `branch` Linear
  label (group child, or flat `branch › <name>`) overrides the base branch for a
  single ticket and is read at delegation time (`created`), so it must be applied
  before assigning.

- **Session binding prevents cross-talk.** Sandbox events are bound to the
  supervisor run record before entering the Linear outbox, so a late event from
  an older delegated session can't be redirected into a newer Linear
  conversation. Resume continues the saved native session/thread with a
  follow-up message; it does not start a fresh adapter.

- **`.openthrottle.yml`** (repo root, committed) is the per-repo gate config the
  sandbox reads in phase 4: `agent`, `test`/`lint`/`build` commands,
  `post_bootstrap`, `limits`, `mcp_servers`. Delegated runs of *this* repo use
  it too.

## GitHub / PR workflow in this environment

Use the `mcp__github__*` tools for all GitHub interaction (no `gh` CLI here).
Do not open a PR unless explicitly asked. After creating one, subscribe to its
activity and surface CI failures / review comments as they arrive rather than
polling.
