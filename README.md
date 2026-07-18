# OpenThrottle v2

A plan-first, autonomous coding pipeline built on Linear and Daytona.

You approve a plan in a Linear ticket and delegate it. OpenThrottle spins up
a per-ticket sandbox running Claude Code or Codex CLI, which implements the
plan, opens a PR with a preview link, and keeps working the same sandbox as
you reply in the Linear thread. Merge or close the PR and the sandbox is
deleted — the sandbox's lifetime is the ticket's lifetime.

See [`docs/SPEC.md`](docs/SPEC.md) for the full cross-component contract;
this file is the tour.

## Architecture

```
                    ┌───────────────┐
  Linear ticket ───▶│ Linear webhook│
  (plan approved,   │ agentActivity │
   delegated)       └───────┬───────┘
                             │ POST /webhooks/linear
                             ▼
                   ┌───────────────────┐        GET/POST
                   │   Fly supervisor  │◀──────────────────────┐
                   │ (Hono, sqlite)    │                        │
                   │  - verify sig     │                        │
                   │  - ack < 10s      │           GET /status  │
                   │  - route ticket   │◀───────────────────────┼── openthrottle CLI
                   │  - sweep/cleanup  │                        │   (init / ship / status)
                   └─────────┬─────────┘                        │
                             │ create/exec (Daytona SDK)         │
                             ▼                                   │
                  ┌─────────────────────┐                        │
                  │  Daytona sandbox     │   sandbox lifetime     │
                  │  (1 per ticket)      │   == ticket lifetime   │
                  │  entrypoint.sh:      │                        │
                  │   - clone + safety   │                        │
                  │   - claude/codex     │                        │
                  │     w/ implement-    │                        │
                  │     plan skill       │                        │
                  │   - gh pr create     │                        │
                  │   - dev server       │                        │
                  └─────────┬─────────────┘                       │
                             │ branch + PR + preview URL           │
                             ▼                                     │
                    ┌────────────────┐   pull_request webhook      │
                    │   GitHub PR    │─────────────────────────────┘
                    └────────┬───────┘   (closed → supervisor deletes sandbox)
                             │
                     reply in Linear thread
                             │ (action=prompted)
                             ▼
                   supervisor resumes the SAME sandbox
                   (claude --resume / codex exec resume)
```

## Quick start

1. **Deploy the supervisor** (`supervisor/`, Fly, Hono + SQLite). It's the
   only always-addressable piece — everything else is created on demand.
   ```sh
   cd supervisor
   fly launch   # see supervisor/fly.toml
   fly deploy
   ```

2. **Point `openthrottle init` at your target repo** (the codebase the agent
   will actually work on):
   ```sh
   cd /path/to/your-project
   npx openthrottle init
   ```
   This writes `.openthrottle.yml`, builds/updates the Daytona sandbox
   snapshot, and prints every `fly secrets set ...` command you need to run
   against the supervisor app from step 1.

3. **Delegate a ticket.** Write a plan as markdown and ship it:
   ```sh
   npx openthrottle ship docs/plans/add-dark-mode.md
   ```
   This creates a Linear issue (title = first `#` heading) and tries to
   delegate it to the OpenThrottle agent automatically; otherwise it prints
   the issue link so you can delegate it by hand. Once delegated, the
   supervisor spins up a sandbox, implements the plan, and opens a PR. Reply
   in the Linear thread to iterate — merging the PR tears the sandbox down.

## Components

```
openthrottle-v2/
  supervisor/   Node 22 + TypeScript + Hono + better-sqlite3, deployed on Fly.
                Verifies webhooks, creates/resumes/deletes Daytona sandboxes,
                posts activity back to Linear, sweeps stale tickets.
  sandbox/      Dockerfile + entrypoint that runs inside each Daytona
                sandbox: clone, safety hooks, run the agent, open the PR.
  skills/       Agent instructions (Claude skills + Codex prompt mirrors) —
                implement-plan, review, review-fix, investigate.
  cli/          `openthrottle` — init / ship / status.
  docs/         SPEC.md and friends.
```

## Security model

Five invariants, enforced across supervisor + sandbox + CLI (see
`docs/SPEC.md` "Security invariants" for the normative version):

1. **Least privilege in the sandbox.** The agent only ever sees a repo PAT
   (contents + PRs), a Linear API key/token, and its own model auth. No
   Daytona key, no Fly key, no webhook secrets ever enter the sandbox.
2. **`main`/`master` is unreachable from inside.** A pre-push hook blocks
   pushes to the base branch, and the hook path is sealed after install.
3. **Everything the agent can write is sanitized.** Logs and Linear/GitHub
   comments pass through redaction for tokens, keys, secrets, and known
   credential patterns before they leave the sandbox.
4. **Branch protection + a scoped PAT are the outer ring.** Document and
   configure these on GitHub — no component here can enforce them for you.
5. **Webhooks are verified before any side effect.** Both `/webhooks/linear`
   and `/webhooks/github` check their signature first; on any handler error,
   the endpoint still returns 200 (to avoid retry storms) but logs and
   surfaces an `error` activity if a ticket is already known.

## Status: v2 scaffold

This is a fresh rewrite, not yet run end-to-end against live Linear/Daytona
accounts. Every place an external API's exact shape was assumed rather than
verified is marked `// TODO(verify-sdk)` or `// TODO(verify-linear-api)` in
the source — grep for those and resolve them against current docs before the
first production run. Known open questions:

- Daytona SDK: declarative `Image`/`Snapshot` builder calls in `cli/src/init.ts`
  are checked against the installed `@daytonaio/sdk` types, but sandbox
  creation/exec options used by the supervisor still need a live-account pass.
- Linear Agent API (Developer Preview): `agentActivityCreate`,
  `agentSessionUpdate`, and issue-delegation field names need to be checked
  against current docs — see `cli/src/ship.ts` for the delegation
  `SPEC-DEVIATION`.
- No test framework is wired up anywhere yet; code is structured for it
  (pure functions for parsing/verification) but nothing is under test.

Treat every checked-in secret name, endpoint, and mutation here as "spec'd,
not proven" until it's exercised against real accounts.
