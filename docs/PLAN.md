# OpenThrottle delivery plan

Status: coordinator cutover, Stage C structured remediation (RU1–RU11), and
the post-RU11 hardening lane are complete; live credentialed dogfood is the
open milestone.

The detailed implementation units and acceptance criteria live in
[`docs/plans/2026-07-21-001-feat-configurable-agentic-pipeline-coordinator-plan.md`](plans/2026-07-21-001-feat-configurable-agentic-pipeline-coordinator-plan.md).
This file records the active product-level plan after that cutover.

## Product boundary

OpenThrottle is a pre-production proof of concept. A Linear delegation selects
one immutable configurable pipeline; a deterministic Fly supervisor coordinates
fenced stages in Daytona; self-contained OpenThrottle skills supply agent
reasoning; and GitHub is the publication/provider surface. The current snapshot
still carries the Compound Engineering plugin as an unused legacy image input;
removing that ambient dependency is separate cleanup, not a planning contract.

There is one execution architecture. New generations never select a direct
task runner, automatic resume scheduler, callback endpoint, preview revival
path, or repository environment fallback. Compatibility code is limited to
idempotent SQLite migrations that can open a database created by an earlier
revision.

## Completed delivery units

- U0–U1: vocabulary, typed manifests, strict validation, immutable catalog and
  runtime/config snapshots.
- U2–U5: durable coordinator state, stage attempts, artifacts, gates, work
  bindings, effects, runtime resources, and recovery semantics.
- U6–U9: sealed stage executor, context policies, subject fencing, provider
  evidence, bounded repair, and publication receipts.
- U10–U13: core implement/investigate pipelines, command/agent fixtures,
  unconditional admission, operator visibility, and rollout documentation.
- Cutover cleanup: removed live direct-run scheduling, task adapter registry,
  standalone resume tasks, completion callback/markers, preview revival,
  repository routing fallbacks, and their production tests/configuration.
- Stage C remediation (RU1–RU11): the structured, repository-configurable
  `for_each_unit` graph is now admission-reachable, fenced, durably reduced,
  and proven end-to-end by a local two-unit Docker walking skeleton (see
  [`docs/plans/2026-07-29-001-fix-complete-structured-workflows-u2-u7-plan.md`](plans/2026-07-29-001-fix-complete-structured-workflows-u2-u7-plan.md)).
  RU11 closes the lane: reportable child transitions durably insert an
  ordered, sanitized child-publication event and its correlated Linear outbox
  activity in the same transaction as the reducer write, and every terminal
  ledger renders directly from those durable event rows -- independent of the
  correlated outbox activity's own delivery -- so Linear/GitHub converge from
  restart-safe records instead of a point-in-time snapshot. The repository
  default graph remains `simple`.
- Post-RU11 hardening lane (merged since 2026-07-29): self-contained default
  skills replacing CE delegation (#143/#149); the read-only analysis contract
  (`GET /analysis/runs`, the citation contract and grading gate, and the
  bounded differential improvement ratchet — #156/OPE-113/#185); structured
  review-persona fanout with review-journal evidence (OPE-138, #186);
  GitHub-Issue control routes and their runbook (#192, #196–#198); the gated
  `core/tune@1` self-improvement pipeline (#203/#206); and the v12
  admission-drain deployment cutover (#211–#213).

## Origin U8 (live credentialed dogfood)

The Stage C remediation chain is now locally complete. Origin U8 — migrating
a repository's public config/graph surface to select `structured` and running
the first live, credentialed Linear → Fly → Daytona → GitHub dogfood
(OPE-45; earlier revisions of this plan cited OPE-35) — remains explicitly
out of scope for this plan and is tracked separately. No PR in this lane
changes the repository default or claims hosted credential/provider
acceptance.

## Acceptance gate for this PR

1. Supervisor and CLI typecheck and build pass.
2. Supervisor, CLI, and sandbox unit tests pass.
3. Sandbox shell tests pass where Bats is available.
4. Sandbox image builds and sealed Claude/Codex/OpenCode plus command-stage
   smoke passes.
5. Semantic code review covers the complete branch diff; valid findings are
   fixed and regression-tested.
6. GitHub CI and review threads on the PR are green/resolved.

The credentialed Linear → Fly → Daytona → GitHub exercise is intentionally
deferred at the user’s direction. It remains a known verification gap, not a
reason to retain an alternate execution path.

## Next proof milestones

- Run one explicitly authorized credentialed pipeline in a registered test
  repository/team and capture immutable selection, fenced stage results,
  exact-subject provider evidence, repair, publication, and cleanup.
- Dogfood implement and investigate manifests against representative target
  repositories.
- Revisit destructive database schema contraction only if retaining historical
  columns becomes an operational burden. Migration scaffolding must never
  influence admission or execution.

## Non-goals for the POC

- Production cohort rollout, consumer draining, or soak gates.
- Multi-tenant administration or a separate web UI.
- GitHub replacement or agent-authored GitHub approvals.
- Parallel swarms within one ticket.
- Windows support.
