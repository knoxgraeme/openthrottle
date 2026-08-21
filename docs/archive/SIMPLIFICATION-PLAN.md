> **Archived:** describes the retired pre-coordinator direct-task architecture; kept as provenance only.

# Pipeline simplification plan

> **Historical design record:** this plan describes the retired direct-task
> architecture and is not an execution contract. The coordinator-only runtime
> in `docs/SPEC.md` and `docs/PLAN.md` supersedes its scheduler, resume-task,
> callback, and completion-marker proposals.

Outcome of the July 2026 architecture review. The four-layer split (Fly
supervisor → sandbox entrypoint → task adapters → native Compound Engineering)
stays. The changes below remove competing logic left over from the previous
pipeline and shrink duplication within layers, without moving the
supervisor↔sandbox security boundary.

Phases are ordered by value and are independently shippable unless a
dependency is noted. Each phase ends with the existing verification contract
green (Vitest suites, Bats, Docker smoke) plus the listed additions.

---

## Target model

Two core loops, one continuation mechanism, Linear as the control plane:

- **implement** — CE pipeline (`ce-work` → local `ce-code-review` →
  `ce-commit-push-pr`) → PR → external GitHub-native reviewers (Codex/Claude
  bots, humans) review and comment → the **original session** resumes,
  triages the feedback (action / answer on thread / escalate a decision),
  pushes, and comments. An implement ticket may be a feature or a bug plan.
- **investigate** — the debugging analogue (`ce-debug`); convergent fixes
  merge into the implement tail (PR + feedback loop), divergent findings are
  returned as residuals. Future: findings can become new Linear tickets that
  re-enter as fresh implement loops (see "Future work").
- **resume** — the single continuation mechanism for a running loop, fed by
  either source: a human reply in Linear, or GitHub feedback (reviews,
  comments, CI failures) queued as session work.

Decision recorded: always-resume means session context grows across feedback
rounds instead of each fix starting clean. Accepted — the external reviewers
provide the fresh eyes, actioning benefits from the implementation context,
the loop is bounded by `REVIEW_MAX_ROUNDS`, and the agent can delegate
subtasks to its native subagents to keep the main session lean. Re-delegation
is the pressure valve if a long-lived session degrades.

Role contract:

- **Linear is the control plane.** All human intent enters through it
  (delegate, reply, decide elicitations, stop) and all status/decisions are
  published back to it. Queuing future work = creating a ticket.
- **GitHub is the work surface.** Code, PRs, reviews, CI — it emits events;
  it is not where the pipeline is steered.
- **The supervisor is pure coordination.** Triggers, one-run-per-ticket,
  durable queues, sandbox lifecycle, publication. It knows a loop only by
  its interface — (entry task name, sandbox env contract, `ot-activity`
  outbox events, completion marker) — never by its internals. That interface
  is what makes loops swappable: a loop is a skill plus a CE pipeline
  declaration behind a task name.

---

## Phase 1 — One owner for PR feedback and CI repair; external reviewers own review

Three consolidations, driven by how the pipeline is actually used now.

First, `ce-babysit-pr` (inside implement/review-fix/investigate runs) and the
supervisor's webhook handlers both react to PR feedback, which double-handles
events, burns `REVIEW_MAX_ROUNDS`, and keeps sandboxes on the 60-minute
active autostop tier waiting on CI a webhook would report for free.

Second, the internal `review` task is legacy of the original two-agent design
(reviewer agent reviews → original agent fixes → reviewer agent re-reviews).
In practice the reviewer role is now owned by GitHub-native reviewers
(Codex/Claude review bots, humans). Their inline comments already trigger
`review-fix` today — GitHub wraps inline comments in a `commented` review,
and the non-self commented-review and issue-comment handlers launch
`ce-resolve-pr-feedback` — so the internal review choreography on top of
that can be deleted.

There is also an inconsistency worth removing while we are here: the same
feedback event is handled two different ways depending on timing. Feedback
arriving during an active run is queued as session work and later launched
as a **resume of the original session**; feedback arriving while idle
launches `review-fix` in a **fresh context**. The fresh context made sense
when a separate reviewer agent did the fixing; in the target model the
original session (which has the implementation context) always triages its
own feedback.

1. **All GitHub feedback becomes session work.** Human `CHANGES_REQUESTED`,
   non-self commented reviews (covers bot inline reviews), PR conversation
   comments, and (new) failed `workflow_run`/`check_suite` conclusions on an
   open `ot/*` PR are enqueued as `automatic` session work with dedup keys
   (`gh-review-<id>`, `gh-comment-<id>`, `gh-ci-<id>`). An idle ticket
   launches the next item immediately; an active run picks it up on
   completion. Every launch is a `resume` of the original session carrying
   the feedback-triage message (the current `prFeedbackMessage` contract:
   action clear fixes, answer threads with reasoning, batch decisions into
   one elicitation). Keep the existing mirror-to-Linear activities.
2. **Delete both review task types.** Remove `review` (its three adapter
   files, the `needs-review` label / `review_requested` triggers) and
   `review-fix` (its three adapter files, `triggerReviewTask`'s launch path,
   the auto-fresh-re-review in `completeRun`, and the `pending_re_review`
   flag plus drain logic — additive migration: columns stay, code stops
   reading them). Task types collapse to `implement | investigate | resume`.
   The `ce-resolve-pr-feedback` triage rules move into the feedback resume
   message and the standing rules (AGENTS fragment / skill text), not a
   separate task.
3. **Bound the loop.** Replace the `CHANGES_REQUESTED`-count/round logic
   with one counter: feedback-triggered resumes per ticket (a `source`
   column on session work already distinguishes `automatic` from `human`),
   bounded by `REVIEW_MAX_ROUNDS` with the existing "needs a human
   decision" escalation to Linear and the PR.
4. **Missing-session fallback.** A `resume` requires the saved native
   session (`~/.ot/agent-session-id`); it can be lost when a sandbox is
   recreated. On that failure, surface an error activity to Linear
   ("workspace was recreated — re-delegate to continue") rather than
   silently starting a fresh context. Decision recorded: no fresh-context
   fallback task; re-delegation is the recovery path.
5. **Remove babysit from the pipelines.** Delete `ce-babysit-pr` from the
   implement/investigate adapters (all agent forms), `task_ce_pipeline` in
   `sandbox/lib/runtime.sh`, the composition table in `skills/README.md`,
   and the corresponding SPEC lines.
6. **Close the loop externally.** After a feedback-triggered resume
   completes with no pending elicitation, the supervisor optionally nudges
   the external reviewer to re-review (post the bot's mention command, e.g.
   `@codex review`, or re-request review). Config: `REVIEW_NUDGE_COMMENT`
   (empty = rely on the bot's review-on-push behavior). Repos without a
   reviewer bot fall back to human review; nothing blocks on a review
   existing.
7. **Skip already-resolved queued feedback.** Before launching an
   `automatic` session-work item, check its review thread/comment via `gh`;
   drop the item if the thread is already resolved (a prior resume may have
   addressed several queued items at once).
8. **Tests.** New `server.test.ts` cases: each feedback kind → queued work →
   resume launch; CI failure during active run → queued; rounds exhaustion
   via feedback-triggered resumes; resolved-thread skip; completion posts
   the nudge and schedules nothing internal; missing-session resume →
   Linear error; bot commented review with inline comments → queued work
   (regression-pin the existing trigger).

## Phase 2 — Extract the scheduler; make chat commands explicit

The "what runs next" policy is currently spread across `completeRun`,
`handleGithubEvent`, `handlePrompted`, and `drainNextSessionWork` in a
1,800-line `server.ts`.

1. **`scheduler.ts`.** One module owning the transition table:
   `(event, ticket, run history) → launch task X | queue | ignore`. Move into
   it: session-work draining/priority, review-round bounding, the external
   re-review nudge, and Phase 1's CI rule. (Phase 1 already deleted the
   biggest former residents: fresh-re-review scheduling and the
   `pending_re_review` logic.) `completeRun` and the webhook handlers reduce
   to event normalization plus scheduler calls. Pure-function core so
   transitions are table-testable without Daytona/Linear fakes.
   Structure the table as a **loop registry**: each entry maps a task name to
   its entry skill, CE pipeline declaration, and the events that may trigger
   it. The scheduler consults the registry rather than hard-coding task
   names, so a future pipeline is added by registering an entry plus a
   canonical skill (Phase 3) — no handler changes.
2. **`commands.ts`.** Centralize `/stop`, `/merge`, and the
   `investigate` + `fix it|implement|go ahead` promotion heuristic. Add an
   explicit `/implement` command; keep the regex as a deprecated alias for
   now and log when it (rather than the command) triggers promotion.
3. **Split `server.ts`** along the seams that fall out: HTTP surface
   (routes/auth), Linear event handling, GitHub event handling, run
   lifecycle. Behavior-preserving; existing tests must pass unmodified
   except for import paths.

## Phase 3 — Single-source the task adapters

After Phase 1 removes the `review` and `review-fix` adapters, the remaining
2 tasks × 3 agents = 6 hand-synchronized prompt files become two canonical
skills. Codex now supports the open agent skills standard (same `SKILL.md`
format), which removes most of the per-agent delta.

1. **Canonical source.** Restructure to
   `skills/tasks/<task>/SKILL.md` as the single source of truth for
   implement-plan / investigate. Per-agent output is
   generated at snapshot build time (`supervisor/scripts/build-snapshot.mjs`
   or Dockerfile step), never hand-maintained.
2. **Claude:** unchanged delivery (user-level skills dir), sourced from the
   canonical files.
3. **Codex:** bake the canonical skills into the image at
   `/etc/codex/skills` (admin scope — designed for exactly this). Add
   `agents/openai.yaml` per skill with
   `policy.allow_implicit_invocation: false` so adapters only run when
   explicitly invoked. Change the entrypoint's codex case to
   `codex exec '$<skill-name>'` with the runtime-context block appended,
   replacing the stdin-piped prompt files. Keep `AGENTS-fragment.md`
   (standing rules: push-early, sanitization, `ot-activity`, decision gate)
   as global context — it is not a skill.
   *Decision recorded:* repo-scope `.agents/skills` discovery stays
   **enabled**. Registered repositories are already code-execution-trusted
   via `post_bootstrap`, so repo-checked-in skills add no new capability.
   Document this as an explicit invariant: registered repos are trusted for
   code execution and skills; ticket text, PR comments, and review bodies
   remain untrusted data.
4. **OpenCode:** verify whether the pinned version can load agent-standard
   skills from a sandbox-owned directory while still ignoring
   project-external sources. If yes, adopt the same canonical skills; if
   not, keep the prompt-argument delivery but render it from the canonical
   source at build time.
5. **Verify the pinned Codex CLI in the smoke test** discovers
   `/etc/codex/skills` and honors `$<skill>` invocation under `codex exec`;
   update `skills/README.md` and SPEC ("Sandbox contract") to match.

Dependency: none on Phases 1–2, but land Phase 1's adapter edits first (or
fold them in) so the canonical files are written once without babysit.

## Phase 4 — Delete legacy bridges

Each item is gated on a verification step; none changes behavior for current
callers once verified.

1. `POST /runs/:id/complete` — outbox polling superseded it. Confirm no
   deployed snapshot still POSTs (check run rows / logs), then remove the
   route; `completeRun` stays as the internal finalizer.
2. `GITHUB_REPO_MAPPINGS` env fallback — confirm all teams have durable
   `repository_registrations`, then remove the fallback and the config key.
3. Legacy `agentActivity.body` tolerance in the Linear webhook parser —
   confirm current Linear payloads always use `content.body`.
4. `retiredSecretNames` unset list in `daytona.ts` — remove once no
   pre-migration sandbox can still exist (all sandboxes are ephemeral per
   ticket; a sweep cycle after deploy suffices).

## Phase 5 (gated on product decision) — sandbox debugging access

Only if the agent should debug deployed apps (Fly CLI or a future sealed
observability capability). This deliberately amends security invariant 1.

1. **Daytona org-level secrets** carry static integration credentials
   (Fly token or Sentry keys), injected at sandbox creation. Per-run
   values (`RUN_CALLBACK_TOKEN`, task env, agent auth selection) stay on the
   supervisor's `updateEnv` path. Any future external-tool channel requires a
   new sealed least-authority contract; repository configuration does not
   declare MCP servers.
2. **Scoped tokens only:** Fly app-scoped read-only tokens
   (`fly tokens create`), never org tokens.
3. **Housekeeping:** add Fly token shapes (`FlyV1 `, `fm2_`) to both
   sanitizers (`supervisor/src/sanitize.ts`, `sandbox/lib/runtime.sh`);
   rewrite the AGENTS-fragment paragraph promising no Fly key exists; amend
   SPEC invariant 1 to enumerate excluded keys instead of a blanket claim.

## Future work (recorded, not scheduled)

**Swappable skill pipelines.** The end state Phases 2–3 build toward: adding
a new loop (e.g. a docs pipeline, a migration pipeline, a different vendor's
skill suite) means writing one canonical skill, declaring its CE/native
pipeline, and adding a loop-registry entry — the supervisor, sandbox
entrypoint, outbox contract, and Linear publication are untouched because
they only ever see the loop interface (task name, env contract, `ot-activity`
events, completion marker). The registry entry also declares which triggers
may start the loop, so new pipelines cannot be started by events they don't
opt into. `sandbox/lib/runtime.sh`'s `task_skill_name`/`task_ce_pipeline`
maps should derive from the same registry data (baked into the snapshot at
build time) so the loop definition lives in exactly one place.

**Investigate → ticket → implement.** An investigate loop that plans a fix
should be able to queue that work as a new Linear ticket that re-enters the
pipeline as a fresh implement loop. Since Linear is the control plane and
the sandbox holds no Linear credentials, this is a supervisor capability:
add a new semantic outbox event kind (`ticket-proposal`, carrying title /
body / suggested labels) that the sandbox emits like any `ot-activity`
event; the supervisor validates it and creates (optionally delegates) the
Linear issue. The new ticket then flows through the normal delegation front
door — no special coupling between the two loops.

## Explicitly not changing

- The four durable queue implementations (`webhook_deliveries`,
  `session_work`, `sandbox_events`, `linear_outbox`) — their semantic
  differences (per-session ordering, priority) are real. Revisit only if a
  fifth queue appears.
- The entrypoint's 8-phase structure and the polled sandbox-event outbox.
  The pipeline stays off Daytona log streaming (completion must not depend
  on a live connection); at most, add a streamed follow mode to
  `openthrottle logs` as operator UX later.
- Daytona git-operations API for the bootstrap clone — the agent needs
  `GITHUB_TOKEN` for its whole job regardless, so SDK-side git would split
  setup across two components with no security win.
