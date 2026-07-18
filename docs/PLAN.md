# OpenThrottle v2 — Build Plan

Plan-first, ticket-sized phases. Each phase is written so it could itself be
delegated to the pipeline once Phase 1 proves the loop. Acceptance criteria are
the gates — a phase isn't done until they pass.

## Learnings this plan is built on (July 2026 research)

1. **Subscription auth is policy-volatile.** Anthropic changed the rules for
   Claude subscription auth in automation three times in six months (blocked
   Jan → ToS ban Feb → credit system May → paused June 15, currently allowed
   and drawing from plan limits). OpenAI officially documents ChatGPT-auth
   headless Codex for "trusted private automation" but recommends API keys for
   CI. → All auth lives behind single env vars (`CLAUDE_CODE_OAUTH_TOKEN` /
   `ANTHROPIC_API_KEY`, `CODEX_AUTH_JSON` / `CODEX_API_KEY`) so a policy shift
   is a secrets change, not a refactor.
2. **The Linear Agent API is Developer Preview.** Field names and payload
   shapes may churn. → All Linear calls are concentrated in
   `supervisor/src/linear.ts` + the entrypoint's curl helper, every guessed
   field is marked `TODO(verify-linear-api)`, and Cyrus (Apache-2.0) is the
   reference implementation to diff against when something breaks.
3. **The 10-second ack rule shapes the architecture.** The supervisor must
   post a `thought` activity before any sandbox work; sandbox creation happens
   after. Never reorder this.
4. **Sandbox lifetime == ticket lifetime is the core simplification.** Stopped
   Daytona sandboxes bill no compute (filesystem persists on the runner), so
   we keep one sandbox per ticket from delegation to PR-close. This is what
   makes `--resume` trivially correct (same cwd, same session files) and
   deletes the volume/session-sync machinery v1 half-built. Auto-archive after
   7 days stopped means old tickets restart slower — acceptable.
5. **Fresh-context phases beat long-running orchestrators.** The ecosystem
   converged on state-in-files/git with fresh agent context per run (the Ralph
   insight; v1's phased orchestrator learned it independently). → v2 has no
   orchestrator: skills carry the procedure, git/Linear carry the state, the
   supervisor only does lifecycle.
6. **`codex exec` is a near-peer of `claude -p`, with caveats.** JSONL
   streaming, resume, MCP, AGENTS.md all exist; but Codex subagents are
   experimental and approval-constrained under `exec`, and `--full-auto` was
   deprecated (~v0.128) for profiles. → Codex is the linear-task engine;
   multi-subagent skills are Claude-only.
7. **Don't build on dying hosts.** Vibe Kanban (sunsetting), Omnara (archived),
   Gitpod (gone → Ona). Depend only on: Daytona (AGPL, active, self-host
   escape), Linear API, GitHub, the two agent CLIs, Fly (replaceable in an
   afternoon — the supervisor is a plain Node app).
8. **Preview links are Daytona's differentiator; escape hatch is the branch.**
   Mid-run previews need Daytona; PR-time previews can be Vercel. Human
   takeover = push-early branch + optionally `claude --resume` against the
   sandbox's session files; herdr/tmux attach is a nice-to-have, not core.

---

## Phase 0 — Verified deploy (the "resolve every TODO" afternoon)

Goal: supervisor live on Fly, sandbox image in a registry, all 23
`TODO(verify-*)` markers resolved against live APIs.

Steps:
1. Push repo to GitHub (`knoxgraeme/openthrottle`, fresh history).
2. Build + push sandbox image (`docker build -f sandbox/Dockerfile .`) to
   Docker Hub/GHCR; create Daytona snapshot `openthrottle` from it.
3. `fly launch` supervisor, create `/data` volume, `fly secrets set` from
   `.env.example`.
4. Create the Linear OAuth app (`actor=app`, scopes `app:assignable`,
   `app:mentionable`), point its webhook (Agent session events) at
   `https://<app>.fly.dev/webhooks/linear`, complete `/oauth/install`.
5. Add GitHub repo webhook (`pull_request` events) → `/webhooks/github`.
6. Work through `grep -rn "TODO(verify" supervisor/src sandbox cli/src`:
   Linear mutation shapes (test each with a curl against the live GraphQL
   API), Daytona session-exec `env`/`runAsync` fields, preview URL domain
   (replace `computePreviewUrl` guess with `sandbox.getPreviewLink` if wrong),
   `--mcp-config` JSON shape, Codex JSONL event names.

Acceptance: delegating a test issue produces an ack activity in Linear within
10s and a sandbox appears in Daytona with the right env and labels. No
unresolved `TODO(verify-*)` remains (delete the markers as each is confirmed).

## Phase 1 — First end-to-end ticket (supervised)

Goal: one trivial, real ticket flows Linear → sandbox → PR → preview →
thread-reply resume → merge → cleanup, with a human watching logs throughout.

Steps: pick a low-stakes target repo; `openthrottle init` in it (branch
protection ON, fine-grained PAT scoped to contents+PRs); write a genuinely
approved plan into a ticket (e.g. "add a /healthz route"); delegate; watch.
Then reply in the thread with a small change request and verify resume uses
the same session (check `~/.ot/agent-session-id` continuity); merge the PR and
verify sandbox deletion + closing activity.

Acceptance: full loop with zero manual intervention except the merge; resume
demonstrably continues the same agent session; no secrets appear in any log,
PR body, or Linear activity (grep the artifacts).

## Phase 2 — Failure-path hardening

Goal: the ugly paths behave. This is where v1's scar tissue says the effort
goes.

- Kill a run mid-flight (stop sandbox during agent run) → error activity
  posted, row marked `error`, re-delegation recovers via the reuse guard.
- No-plan ticket → elicitation posted, run stops, nothing half-built.
- Test-gate failure the agent can't fix → PR still opens? No: skill says fix
  first; verify it posts an honest blocked message instead of a broken PR.
- Sweep: let a ticket go stale → expired + cleaned after `SWEEP_MAX_AGE_DAYS`;
  orphaned sandbox (row deleted manually) → swept.
- Budget: verify `--max-turns` and `timeout` actually bound a runaway prompt;
  add a per-run cost line to the final Linear activity (claude result JSON has
  `total_cost_usd`).
- Re-audit sanitization against real logs from Phases 1–2.

Acceptance: each scenario above run deliberately at least once with the
expected outcome observed.

## Phase 3 — Codex parity

Goal: `agent:codex` label routes a ticket through `codex exec` end-to-end.

Steps: seed `CODEX_AUTH_JSON` (or API key); run the Phase 1 ticket shape with
the label; verify JSONL normalization, session-id capture from
`thread.started`, `codex exec resume` on thread reply, AGENTS-fragment
behavior; document observed differences in `skills/README.md`.

Acceptance: same Phase 1 loop, Codex engine, including one resume round-trip.

## Phase 4 — Review loop wiring (gap: skills exist, triggers don't)

The scaffold ships `review`, `review-fix`, `investigate` skills but the
supervisor only triggers `implement`/`resume`. Wire the review state machine
(v1's best subsystem, reborn without labels-as-state):

- GitHub webhook additions: PR `labeled` (`needs-review`) or `review_requested`
  → run `review` skill in the ticket's sandbox; PR review `submitted` with
  `changes_requested` → run `review-fix`.
- Round-counting in the supervisor (count CHANGES_REQUESTED reviews via
  API; auto-approve with warning at `max_rounds`, default 3).
- `investigate`: triggered by delegating a bug ticket with label
  `investigate` — read-only run, posts the verdict report; a human thread
  reply ("fix it") triggers implement with the report as the plan.

Acceptance: a PR goes through review → changes_requested → fix → re-review →
approve without human orchestration; rounds are bounded.

## Phase 5 — Quality of life (pick by pain, not order)

- **Scheduled tasks** — port v1's freshest subsystem: supervisor cron entries
  that run a collect script + skill in a short-lived sandbox and file findings
  as Linear tickets (which then flow through the pipeline).
- **Multi-repo** — replace `GITHUB_REPO` env with per-Linear-team or
  per-project mapping in `settings`.
- **Vercel previews** — document/wire PR-time previews for repos that have
  them; keep Daytona preview for pre-PR.
- **Attach/monitor** — optional: herdr in the sandbox image + docs for
  `daytona ssh` / attach-takeover when watching a live run matters.
- **`openthrottle logs`** — CLI command streaming a ticket's sandbox log via
  the supervisor.
- **Dogfood** — start feeding phase tickets from this file through the
  pipeline itself.

## Non-goals (v2)

Multi-tenant/team use beyond one workspace; a web UI (Linear is the UI);
replacing GitHub as the PR surface; parallel fan-out/swarm workflows inside a
ticket (one ticket = one sandbox = one agent session at a time); Windows.

## Standing risks

- **Auth policy** (learning #1): if subscription automation is restricted
  again, flip to API keys — budget caps in Phase 2 become load-bearing.
- **Linear AIS churn** (learning #2): pin nothing; keep `linear.ts` small and
  diffable against Cyrus.
- **Daytona pricing/limits**: sandbox-per-ticket holds disk per open PR; the
  sweep and PR-close cleanup are the cost controls. Self-host (AGPL compose)
  is the exit if cloud economics change.
- **Codex `exec` subagent constraints** (learning #6): revisit when OpenAI
  stabilizes subagents; until then don't give Codex multi-agent skills.
