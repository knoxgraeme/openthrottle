# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, OpenCode, and others) working
in this repository. This is the canonical instructions file; `CLAUDE.md` imports
it via `@AGENTS.md`.

## What this is

OpenThrottle is a plan-first coding pipeline. An approved Linear ticket selects
an immutable configurable pipeline. The Fly supervisor coordinates one fenced
stage at a time in a Daytona sandbox running Claude Code, Codex, or OpenCode;
GitHub supplies publication and provider evidence. The GitHub repo is
`openthrottle-v2`; the product, CLI, npm package, and Daytona snapshot are all
named `openthrottle`.

```
Linear ticket ──> Fly supervisor ──> Daytona sandbox ──> ot/* branch + PR
     ▲                 │     ▲              │                    │
     └── activities ───┘     └── outbox ────┴── GitHub events ──┘
```

`docs/SPEC.md` holds the normative contracts (endpoints, DB schema, sandbox
phases, sanitization); `docs/PLAN.md` is the delivery/acceptance plan. When a
change touches a contract, SPEC.md is the source of truth — read it first.

## Repository is four separate npm projects

There is **no root `package.json`**. `contracts/`, `supervisor/`, `cli/`, and
`sandbox/` each have their own. Always target one with `--prefix`:

```bash
# install
npm ci --prefix contracts && npm ci --prefix supervisor && npm ci --prefix cli && npm ci --prefix sandbox

# typecheck / build (contracts + supervisor + cli only; sandbox is JS)
npm run typecheck --prefix contracts && npm run build --prefix contracts
npm run typecheck --prefix supervisor && npm run typecheck --prefix cli
npm run build --prefix supervisor && npm run build --prefix cli   # tsc -> dist/

# test
npm test --prefix contracts
npm test --prefix supervisor             # vitest run
npm test --prefix cli
npm test --prefix sandbox                 # vitest over runner/bin/tests *.test.mjs
bats sandbox/tests/runtime.bats           # shell-level runtime.sh tests

# a single test file / name (npm passes args after `--` to vitest)
npm test --prefix supervisor -- src/persistence/run-store.test.ts
npm test --prefix supervisor -- src/__tests__/architecture.test.ts
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
npm ci --prefix contracts && npm ci --prefix supervisor && npm ci --prefix cli && npm ci --prefix sandbox
npm run typecheck --prefix contracts && npm run build --prefix contracts
npm run typecheck --prefix supervisor && npm run typecheck --prefix cli
npm run build --prefix supervisor && npm run build --prefix cli
npm test --prefix contracts
npm test --prefix supervisor
npm test --prefix cli
npm test --prefix sandbox
bats sandbox/tests/runtime.bats
docker build -f sandbox/Dockerfile -t openthrottle:test .   # context is repo root
sandbox/tests/smoke.sh openthrottle:test                     # full lifecycle with stub agents
node sandbox/tests/structured-walking-skeleton.mjs openthrottle:test  # two-unit structured Docker proof
```

`.github/workflows/ci.yml` runs the typecheck/build/test/bats matrix plus the
docker smoke on every PR. Live Linear/Daytona/Fly acceptance is intentionally a
separate deployment gate (it consumes operator credentials) — never assume it
ran locally.

## Architecture: two collaborators with a hard split

The whole system is split between a **deterministic outer state machine (Fly
supervisor)** and **agent reasoning inside the sandbox (self-contained
OpenThrottle skills)**. Keep new logic on the correct side:

- **`supervisor/`** — Hono + `better-sqlite3` control plane deployed on Fly.
  `src/index.ts` is the only top-level production module and composition root:
  it constructs the SQLite-backed stores, provider clients, Daytona runtime
  adapter, operations workers, pipeline services, and HTTP server. It never
  contains agent reasoning. Ownership boundaries:
  - `src/app/` — config parsing, command/session orchestration, admission
    preflight, and provider-neutral application ports.
  - `src/http/` — Hono routes, listener startup, bearer/HMAC handling, and
    durable webhook delivery leasing.
  - `src/pipeline/` — manifests, reducer/control logic, gates/evidence,
    stage-request construction, publication envelopes, and store contracts.
  - `src/persistence/` — SQLite lifecycle, schema, immutable migrations, the
    composed supervisor store, and concrete ticket/run/delivery/steering/work/
    feedback/settings/pipeline repositories. Production code outside this
    boundary must not import `better-sqlite3` or query `runs`/`run_liveness`.
  - `src/providers/` — Linear, GitHub, Codex, and Daytona adapters. Provider
    SDK/client imports stay in their owning provider subtree.
  - `src/runtime/` — provider-neutral runtime contracts, event parsing/polling,
    lifecycle reconciliation, and steering delivery.
  - `src/operations/` — reaping, sweeping, actor settlement, and retryable
    pipeline-effect draining through provider-neutral ports.
  - `src/shared/` — sanitization and bounded log constants.
  - `src/__tests__/architecture.test.ts` enforces the final import map: no flat
    production facades, Hono only under `http`, Daytona SDK only under
    `providers/daytona`, SQLite only under `persistence`, no provider siblings,
    no production fixture imports, and no root production module except
    `index.ts`.

- **`contracts/`** — shared NodeNext TypeScript library for stable repository
  contracts that must be byte-identical across packages. It currently owns
  canonical JSON and sha256 digest helpers plus the cross-environment
  determinism fixture. It is built and tested alongside the other projects, but
  is not a Fly service and is not copied into the supervisor deploy path.

- **`sandbox/`** — the Daytona image and its runtime boundary.
  `entrypoint.sh` is Fly-launched (the image's own entrypoint is an inert no-op
  so provisioning can't race the supervisor) and executes exactly one sealed
  stage request. `runner/execute-stage.mjs` validates the manifest/config/runtime
  fences, applies the context policy, invokes an agent or command executor, and
  writes one typed result. Native session continuation is stage context, not a
  separate task. `~/.ot` holds private context, logs, native session metadata,
  activities, and steering inbox files. `safety/pre-push`
  (with `core.hooksPath` root-sealed) blocks pushes to main/master and
  non-fast-forward — this complements, does not replace, GitHub branch
  protection.

- **`skills/`** — self-contained OpenThrottle task adapters, not delegation
  wrappers. `skills/tasks/<name>/SKILL.md` is the single hand-maintained
  source per task (`implement-plan`, `investigate`, `review-change`,
  `simplify-change`, `publish`, plus the structured-loop skills); its YAML
  frontmatter is exactly what Claude Code loads as a user skill. Pipeline
  manifests own stage ordering across implementation, review, simplification,
  command gates, publication, and provider verification. Read
  `skills/README.md` before editing anything here.

- **`cli/`** — the published `openthrottle` package (`src/index.ts` is a plain
  argv router, no framework). Commands: `setup` (guided onboarding from the
  pinned release manifest; `--check` read-only readiness report,
  `--legacy-checklist` manual secrets checklist, `--yes` pre-approves
  mutations, `--profile <name>`), `init`, `plan validate
  <file.md>`, `plan prepare <file.md>`, `validate <file.md>` (alias for
  `plan validate`), `ship <file.md>`, `status`, `stop <ticket>`,
  `logs <ticket>`, `analysis`, and `operator-skill`. `init` registers the
  GitHub repo with either a Linear-team or a GitHub-Issue control route (the
  two are equal routing options) and writes `.openthrottle.yml`; it requires
  `OT_SUPERVISOR_URL` and `OT_STATUS_TOKEN`.

## Invariants worth knowing before you change things

- **OpenThrottle skills are self-contained, not CE delegation.** Every
  `skills/tasks/` adapter restates its own craft in its own words instead of
  invoking a second-hop toolkit; the planning adapter in `skills/planning/`
  normalizes any sufficiently complete implementation plan or task
  specification without requiring a particular authoring workflow. None of
  these skills references `ce-*` or `compound-engineering`. The current
  snapshot still contains the pinned plugin as a legacy ambient image input,
  but no OpenThrottle skill may depend on it. Never copy CE source into
  `skills/` or into target repos. Each `SKILL.md` is agent-neutral and
  maintained once; the only per-agent difference is *delivery*, which lives
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
  `repository_registrations`; an unmatched team is rejected. A `branch` Linear
  label (group child, or flat `branch › <name>`) overrides the base branch for a
  single ticket and is read at delegation time (`created`), so it must be applied
  before assigning.

- **Session binding prevents cross-talk.** Sandbox events are bound to the
  pipeline instance, generation, attempt, sealed request hash, run, and expected
  Git subject. Native continuation identifiers are accepted only under the
  pinned stage context policy.

- **`.openthrottle.yml`** (repo root, committed) is the per-repo gate config the
  sandbox reads in phase 4: `agent`, `test`/`lint`/`build` commands,
  `post_bootstrap`, `limits`, `mcp_servers`. Delegated runs of *this* repo use
  it too.

## GitHub / PR Workflow For Operator Workstations Only

The following guidance is for a human or local operator workstation that has
the GitHub MCP tools installed. Sealed OpenThrottle sandbox stages must follow
their stage request and must not adopt this section as runtime behavior.

Use the `mcp__github__*` tools for all GitHub interaction (no `gh` CLI here).
Do not open a PR unless explicitly asked. After creating one, subscribe to its
activity and surface CI failures / review comments as they arrive rather than
polling.
