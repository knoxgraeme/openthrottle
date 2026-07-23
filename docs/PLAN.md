# OpenThrottle delivery plan

Status: coordinator cutover implemented; cleanup and acceptance in progress.

The detailed implementation units and acceptance criteria live in
[`docs/plans/2026-07-21-001-feat-configurable-agentic-pipeline-coordinator-plan.md`](plans/2026-07-21-001-feat-configurable-agentic-pipeline-coordinator-plan.md).
This file records the active product-level plan after that cutover.

## Product boundary

OpenThrottle is a pre-production proof of concept. A Linear delegation selects
one immutable configurable pipeline; a deterministic Fly supervisor coordinates
fenced stages in Daytona; native Compound Engineering supplies agent reasoning;
and GitHub is the publication/provider surface.

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
- U10–U13: CE implement/investigate pipelines, command/agent fixtures,
  unconditional admission, operator visibility, and rollout documentation.
- Cutover cleanup: removed live direct-run scheduling, task adapter registry,
  standalone resume tasks, completion callback/markers, preview revival,
  repository routing fallbacks, and their production tests/configuration.

## Acceptance gate for this PR

1. Supervisor and CLI typecheck and build pass.
2. Supervisor, CLI, and sandbox unit tests pass.
3. Sandbox shell tests pass where Bats is available.
4. Sandbox image builds and sealed Claude/Codex/OpenCode plus command-stage
   smoke passes.
5. CE code review covers the complete branch diff; valid findings are fixed and
   regression-tested.
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
