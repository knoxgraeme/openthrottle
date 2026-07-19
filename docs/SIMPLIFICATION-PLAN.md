# Pipeline simplification plan

Outcome of the July 2026 architecture review. The four-layer split (Fly
supervisor → sandbox entrypoint → task adapters → native Compound Engineering)
stays. The changes below remove competing logic left over from the previous
pipeline and shrink duplication within layers, without moving the
supervisor↔sandbox security boundary.

Phases are ordered by value and are independently shippable unless a
dependency is noted. Each phase ends with the existing verification contract
green (Vitest suites, Bats, Docker smoke) plus the listed additions.

---

## Phase 1 — One owner for PR feedback and CI repair

Today `ce-babysit-pr` (inside implement/review-fix/investigate runs) and the
supervisor's webhook handlers both react to PR feedback, which double-handles
events, burns `REVIEW_MAX_ROUNDS`, and keeps sandboxes on the 60-minute
active autostop tier waiting on CI a webhook would report for free. The
supervisor becomes the sole owner; runs end at "pushed + PR updated".

1. **Supervisor reacts to CI failure.** In `handleGithubEvent`
   (`supervisor/src/server.ts`), extend the `workflow_run`/`check_suite`
   `completed` branch: when the conclusion is `failure`/`timed_out`, the
   ticket is `active`, and an open `ot/*` PR exists, launch `review-fix`
   through `triggerReviewTask` (or enqueue as `automatic` session work with a
   `gh-ci-<id>` dedup key when a run is active). Keep the existing
   mirror-to-Linear activity. The existing rounds bound applies unchanged.
2. **Remove babysit from the pipelines.** Delete `ce-babysit-pr` from the
   implement/review-fix/investigate adapters (all agent forms),
   `task_ce_pipeline` in `sandbox/lib/runtime.sh`, the composition table in
   `skills/README.md`, and the corresponding SPEC lines.
3. **Skip already-resolved queued feedback.** When the scheduler is about to
   launch an `automatic` session-work item, check its review thread/comment
   via `gh`; drop the item if the thread is already resolved. With babysit
   gone this is belt-and-braces (mid-run feedback is no longer handled
   in-run), but it protects against `ce-resolve-pr-feedback` having already
   addressed a queued comment.
4. **Tests.** New `server.test.ts` cases: CI failure → review-fix launch; CI
   failure during active run → queued automatic work; rounds exhaustion via
   CI-triggered fixes; resolved-thread skip.

## Phase 2 — Extract the scheduler; make chat commands explicit

The "what runs next" policy is currently spread across `completeRun`,
`handleGithubEvent`, `handlePrompted`, and `drainNextSessionWork` in a
1,800-line `server.ts`.

1. **`scheduler.ts`.** One module owning the transition table:
   `(event, ticket, run history) → launch task X | queue | ignore`. Move into
   it: post-review-fix fresh-review scheduling, the `pending_re_review` flag
   logic, session-work draining/priority, review-round bounding, and Phase
   1's CI rule. `completeRun` and the webhook handlers reduce to event
   normalization plus scheduler calls. Pure-function core so transitions are
   table-testable without Daytona/Linear fakes.
2. **`commands.ts`.** Centralize `/stop`, `/merge`, and the
   `investigate` + `fix it|implement|go ahead` promotion heuristic. Add an
   explicit `/implement` command; keep the regex as a deprecated alias for
   now and log when it (rather than the command) triggers promotion.
3. **Split `server.ts`** along the seams that fall out: HTTP surface
   (routes/auth), Linear event handling, GitHub event handling, run
   lifecycle. Behavior-preserving; existing tests must pass unmodified
   except for import paths.

## Phase 3 — Single-source the task adapters

The 4 tasks × 3 agents = 12 hand-synchronized prompt files become four
canonical skills. Codex now supports the open agent skills standard
(same `SKILL.md` format), which removes most of the per-agent delta.

1. **Canonical source.** Restructure to
   `skills/tasks/<task>/SKILL.md` as the single source of truth for
   implement-plan / review / review-fix / investigate. Per-agent output is
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

Only if the agent should debug deployed apps (Fly CLI, observability MCP
servers). This deliberately amends security invariant 1.

1. **Daytona org-level secrets** carry static integration credentials
   (Fly token, Sentry/MCP keys), injected at sandbox creation. Per-run
   values (`RUN_CALLBACK_TOKEN`, task env, agent auth selection) stay on the
   supervisor's `updateEnv` path. This also gives `.openthrottle.yml`
   `mcp_servers` a credential channel (configs reference env var names).
2. **Scoped tokens only:** Fly app-scoped read-only tokens
   (`fly tokens create`), never org tokens.
3. **Housekeeping:** add Fly token shapes (`FlyV1 `, `fm2_`) to both
   sanitizers (`supervisor/src/sanitize.ts`, `sandbox/lib/runtime.sh`);
   rewrite the AGENTS-fragment paragraph promising no Fly key exists; amend
   SPEC invariant 1 to enumerate excluded keys instead of a blanket claim.

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
