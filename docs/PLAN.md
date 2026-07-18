# OpenThrottle v2 — Build Plan (final)

Plan-first, ticket-sized phases. Each phase is written so it could itself be
delegated to the pipeline once Phase 1 proves the loop. Acceptance criteria are
the gates — a phase isn't done until they pass, and from Phase 0 onward that
includes green CI.

## Decisions locked in the 2026-07-18 review

1. **Keep the GitHub repository named `openthrottle-v2`.** The product,
   package, CLI, and snapshot are named `openthrottle`; this repository stays
   `knoxgraeme/openthrottle-v2`. The older `knoxgraeme/openthrottle` remains
   reference material and is not modified by this plan.
2. **Review verdicts are comments, never GitHub approvals.** GitHub rejects a
   PAT approving its own PR, and one identity opens our PRs — so the review
   skill posts a verdict as a PR comment mirrored into the Linear thread, and
   a human merges from GitHub. A merge-from-Linear trigger is Phase 5.
3. **Sandbox → supervisor run-completion callback.** The supervisor otherwise
   never learns a run finished (the entrypoint posts its final activity
   straight to Linear). A small authenticated callback carries exit status +
   cost and unblocks the serialization guard, error states, and cost
   reporting in one move. Secured with a per-run one-time token — no standing
   supervisor secrets enter the sandbox (invariant #1 holds).
4. **Daytona previews are nice-to-have.** Target repos have Vercel previews on
   PRs; that is the preview story. Mid-run Daytona preview + wake-on-click is
   Phase 5.
5. **Codex stays Phase 3.** We actively use Codex; parity lands before the
   review loop.
6. **Hard budget caps deferred until API-key auth.** Per-run cost reporting
   still lands in Phase 2 (claude result JSON has `total_cost_usd`).
7. **Production-grade test coverage is a cross-cutting workstream** (below),
   not a someday. The sanitizer is security-critical and gets tests first.
8. **The v1 GitHub repo is the canonical source** for porting the
   review / review-fix / investigate prompts (adjusted, not copied blind).
9. **Fly runs `min_machines_running = 1`.** Scale-to-zero made the in-process
   sweep unreliable and put machine cold-start inside the 10-second ack
   budget. ~$3/mo buys both problems gone.
10. **One canonical snapshot build.** `daytona snapshot create openthrottle
    --dockerfile sandbox/Dockerfile` from this repo (Daytona builds it; if
    pushing a locally-built image instead, it must be `--platform
    linux/amd64`). `openthrottle init` no longer builds snapshots — it
    verifies the snapshot exists, writes `.openthrottle.yml`, and prints the
    supervisor secrets to set. Drop the declarative-builder path in
    `cli/src/init.ts`.

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
8. **Previews: Vercel at PR time is the story; Daytona mid-run is a bonus.**
   Human takeover = push-early branch + optionally `claude --resume` against
   the sandbox's session files; herdr/tmux attach is a nice-to-have, not core.

## Cross-cutting workstream: tests + CI

Wired in Phase 0, extended every phase. The bar is production coverage of
everything pure or contract-shaped; live-API behavior is covered by the phase
acceptance runs instead.

- **Framework:** vitest for `supervisor/`, `cli/`, and
  `sandbox/runner/normalize.mjs`; bats-core for `entrypoint.sh`'s pure
  functions (`sanitize_log`, `yq_get`, branch/checkout logic — extract into
  sourceable units where needed).
- **Priority order:** (1) sanitizers in `normalize.mjs` + `entrypoint.sh` —
  these are the wall between a prompt-injected agent and leaked tokens;
  (2) webhook signature verification (Linear HMAC, GitHub sha256) with signed
  fixtures; (3) payload parsers (`parseLinearWebhook`,
  `parseGithubPullRequestEvent`, `extractLabelNames`, `parseMarkdown`);
  (4) handler flows — `createServer` already takes injected deps
  (`ServerDeps`), so exercise created/prompted/pr-closed/sweep against fake
  Daytona + Linear clients, including the races Phase 2 hardens.
- **Sandbox smoke test:** `docker run` the sandbox image with a stub `claude`
  / `codex` on PATH emitting canned JSONL — verifies all eight entrypoint
  phases (clone → safety → config → agent → callback → final activity)
  without touching live APIs. Highest-value single test in the repo.
- **CI:** GitHub Actions on every PR — typecheck, vitest, bats, docker smoke.
  Every phase's acceptance includes CI green on its changes.

---

## Phase 0 — Verified deploy (the "resolve every TODO" stretch)

Goal: supervisor live on Fly, snapshot in Daytona, all `TODO(verify-*)`
markers resolved against live APIs, test scaffold running in CI.

Steps:
1. Keep this repository at `knoxgraeme/openthrottle-v2`; use `openthrottle`
   consistently for the contents/product/package/snapshot.
2. Wire the test workstream: vitest + bats + docker smoke + GitHub Actions;
   land the sanitizer, signature, and parser tests (they need no live
   accounts and lock in behavior before the TODO-resolution churn).
3. Build the snapshot: `daytona snapshot create openthrottle --dockerfile
   sandbox/Dockerfile` (decision #10). Simplify `cli/src/init.ts` accordingly.
4. `fly launch` supervisor with `min_machines_running = 1`, create `/data`
   volume, `fly secrets set` from `.env.example`.
5. Lock the supervisor surface: bearer token on `GET /status` (the CLI sends
   it), install secret on `GET /oauth/install` (an open install endpoint lets
   anyone overwrite our stored Linear token with their own workspace's).
6. Create the Linear OAuth app (`actor=app`, scopes `app:assignable`,
   `app:mentionable`), point its webhook (Agent session events) at
   `https://<app>.fly.dev/webhooks/linear`, complete `/oauth/install`.
7. Add GitHub repo webhook (`pull_request` events) → `/webhooks/github`.
8. Work through `grep -rn "TODO(verify" supervisor/src sandbox cli/src`:
   Linear mutation shapes (test each with a curl against the live GraphQL
   API), Daytona session-exec `env`/`runAsync` fields, `--mcp-config` JSON
   shape, Codex JSONL event names. Also confirm the full AgentSessionEvent
   action catalog (anything beyond created/prompted we should handle or log).
9. Reconcile SPEC drift found in review: drop `base_branch` from the
   `.openthrottle.yml` example (entrypoint never reads it; `BASE_BRANCH` is
   supervisor-owned) or wire it — pick one and update SPEC.md.

Acceptance: delegating a test issue produces an ack activity in Linear within
10s (measure it) and a sandbox appears in Daytona with the right env and
labels. No unresolved `TODO(verify-*)` remains (delete markers as confirmed).
CI green.

## Phase 1 — First end-to-end ticket (supervised)

Goal: one trivial, real ticket flows Linear → sandbox → PR → thread-reply
resume → merge → cleanup, with a human watching logs throughout.

Steps: pick a low-stakes target repo; `openthrottle init` in it (branch
protection ON, fine-grained PAT scoped to contents+PRs); write a genuinely
approved plan into a ticket (e.g. "add a /healthz route"); delegate; watch.
Then reply in the thread with a small change request and verify resume uses
the same session (check `~/.ot/agent-session-id` continuity); merge the PR
(Vercel preview on the PR is the preview check) and verify sandbox deletion +
closing activity.

Acceptance: full loop with zero manual intervention except the merge; resume
demonstrably continues the same agent session; no secrets appear in any log,
PR body, or Linear activity (grep the artifacts).

## Phase 2 — Failure-path hardening

Goal: the ugly paths behave. This is where v1's scar tissue says the effort
goes. Each scenario lands with a handler-level test against fake clients plus
one deliberate live run.

- **Run-completion callback (decision #3), first — the others build on it.**
  Supervisor generates a `run_id` + one-time token per exec (create and
  resume), passed as `SUPERVISOR_URL` / `RUN_ID` / `RUN_CALLBACK_TOKEN`.
  Entrypoint's final phase POSTs exit code, sanitized failure tail, cost, and
  PR URL to `POST /runs/:id/complete`. Supervisor verifies the token
  (single-use, stored hashed), clears the run guard, updates row state,
  records cost. Fallback: no callback by `TASK_TIMEOUT` + grace → mark the
  run dead, clear the guard, post an `error` activity.
- **Per-ticket run serialization.** `running_since`/`run_id` on the ticket
  row, set before the Daytona task starts, cleared by the callback. A prompt while a
  run is active gets a polite `thought` ("still working on the last message —
  reply again when this run finishes") and is rejected, not queued. Queueing
  is a later upgrade. Cross-ticket parallelism stays unbounded — one ticket =
  one sandbox = one agent session at a time is the only rule.
- **Webhook idempotency.** Linear retries deliveries; two concurrent
  `created` events for one issue can both pass the reuse guard and create two
  sandboxes. Dedupe on (session id, action, activity id) in a small table;
  fold into the same guard work.
- **PR closed mid-run.** Today `handlePrClosed` deletes the sandbox out from
  under a running agent. New behavior: if a run is active, stop it, and the
  supervisor (not the dead entrypoint) posts the closing activity noting the
  run was cut short.
- **Stop control.** `openthrottle stop <ticket>` → authenticated
  `POST /tickets/:id/stop`: stop sandbox, clear guard, mark row, post
  activity. (Linear-native stop when the Agent API exposes one.)
- Kill a run mid-flight (stop sandbox during agent run) → error surfaces via
  the callback-timeout path, row marked `error`, re-delegation recovers via
  the reuse guard.
- No-plan ticket → elicitation posted, run stops, nothing half-built.
- Test-gate failure the agent can't fix → PR still opens? No: skill says fix
  first; verify it posts an honest blocked message instead of a broken PR.
- Sweep: let a ticket go stale → expired + cleaned after `SWEEP_MAX_AGE_DAYS`;
  orphaned sandbox (row deleted manually) → swept. Guard the create-window
  race (sandbox exists, row not yet upserted — don't sweep sandboxes younger
  than a few minutes).
- Budget: verify `--max-turns` and `timeout` actually bound a runaway prompt;
  per-run cost line in the final Linear activity via the callback. Hard caps
  deferred (decision #6).
- Re-audit sanitization against real logs from Phases 1–2 (include the
  `CODEX_AUTH_JSON` inner-token case — redacting the blob doesn't catch its
  fields printed separately).

Acceptance: each scenario above run deliberately at least once with the
expected outcome observed, and encoded as a regression test where a fake
client can express it.

## Phase 3 — Codex parity

Goal: `agent:codex` label routes a ticket through `codex exec` end-to-end.

Steps: seed `CODEX_AUTH_JSON` (or API key); run the Phase 1 ticket shape with
the label; verify JSONL normalization, session-id capture from
`thread.started`, `codex exec resume` on thread reply, AGENTS-fragment
behavior; document observed differences in `skills/README.md`.

Acceptance: same Phase 1 loop, Codex engine, including one resume round-trip.

**From here on, dogfood:** file each remaining phase item as a Linear ticket
and run it through the pipeline itself (human reviews the PRs). Nothing
hardens the failure paths like being our own first customer.

## Phase 4 — Review loop wiring (gap: skills exist, triggers don't)

The scaffold ships `review`, `review-fix`, `investigate` skills but the
supervisor only triggers implement/resume. Wire the review state machine
(v1's best subsystem, reborn without labels-as-state), porting/adjusting the
v1 prompts (decision #8):

- GitHub webhook additions: PR `labeled` (`needs-review`) or `review_requested`
  → run `review` skill in the ticket's sandbox; PR review `submitted` with
  `changes_requested` → run `review-fix`.
- **Verdicts are PR comments + Linear activities — never GitHub approvals**
  (decision #2). The human merges from GitHub.
- **Mirror the loop into Linear:** PR review submissions and CI outcomes
  (`workflow_run`/`check_suite` completed for `ot/*` head branches) post as
  activities in the ticket thread, so the thread tells the whole story.
- Round-counting in the supervisor (count CHANGES_REQUESTED reviews via API);
  at `max_rounds` (default 3) stop and post "review rounds exhausted — needs
  a human decision" instead of an auto-approve GitHub would reject anyway.
- `investigate`: triggered by delegating a bug ticket with label
  `investigate` — read-only run, posts the verdict report; a human thread
  reply ("fix it") triggers implement with the report as the plan.

Acceptance: a PR goes through review → changes_requested → fix → re-review
with verdicts and CI status visible in the Linear thread, rounds bounded, no
human orchestration except the merge click.

## Phase 5 — Quality of life (pick by pain, not order)

- **Merge-from-Linear** — a "merge it" thread reply (or elicitation button if
  the Agent API grows one) → supervisor merges the PR via GitHub API once
  checks are green. Closes the loop the Phase 4 mirroring opens.
- **Scheduled tasks** — port v1's freshest subsystem: supervisor cron entries
  that run a collect script + skill in a short-lived sandbox and file findings
  as Linear tickets (which then flow through the pipeline).
- **Multi-repo** — replace `GITHUB_REPO` env with per-Linear-team or
  per-project mapping in `settings`.
- **Daytona mid-run previews** — verify `getPreviewLink` (URL + token) and add
  a wake-on-click supervisor redirect (`GET /preview/:ticket` starts the
  sandbox, then redirects); until then Vercel PR previews carry it.
- **Attach/monitor** — optional: herdr in the sandbox image + docs for
  `daytona ssh` / attach-takeover when watching a live run matters.
- **`openthrottle logs`** — CLI command streaming a ticket's sandbox log via
  the supervisor.

## Non-goals (v2)

Multi-tenant/team use beyond one workspace; a web UI (Linear is the UI);
replacing GitHub as the PR surface; GitHub approvals from the pipeline (one
identity can't approve its own PRs, and the human stays on the merge button);
parallel fan-out/swarm workflows inside a ticket (one ticket = one sandbox =
one agent session at a time); Windows.

## Standing risks

- **Auth policy** (learning #1): if subscription automation is restricted
  again, flip to API keys — at which point hard budget caps (deferred by
  decision #6) become load-bearing and get built immediately.
- **Linear AIS churn** (learning #2): pin nothing; keep `linear.ts` small and
  diffable against Cyrus.
- **Daytona pricing/limits**: sandbox-per-ticket holds disk per open PR; the
  sweep and PR-close cleanup are the cost controls. Self-host (AGPL compose)
  is the exit if cloud economics change.
- **Codex `exec` subagent constraints** (learning #6): revisit when OpenAI
  stabilizes subagents; until then don't give Codex multi-agent skills.
