# OpenThrottle delivery plan

OpenThrottle now has one deterministic coordinator architecture, a live
repository-configurable structured workflow, automatic admission for Claude and
Codex, acknowledged exact-SHA task-branch checkpoints, and concurrent semantic
review fanout. The active delivery lane is controlled rollout plus safe
parallelization of structured implementation units.

The normative runtime contract is [`SPEC.md`](SPEC.md). Detailed implementation
plans live under [`docs/plans/`](plans/).

## Product boundary

OpenThrottle is a pre-production, plan-first coding pipeline. An approved
Linear ticket or GitHub Issue selects one immutable configurable graph. The Fly
supervisor owns deterministic admission, scheduling, gates, recovery,
integration, and publication. Self-contained OpenThrottle skills provide
semantic judgment inside fenced Daytona actions. GitHub supplies task-branch,
pull-request, and provider evidence.

There is no direct-run fallback coordinator. Compatibility is limited to
additive/idempotent migrations and explicitly supported older public contracts.
The sandbox image does not ship Compound Engineering; every runtime skill is an
agent-neutral OpenThrottle package maintained once and delivered per engine.

## Completed lanes

- Configurable coordinator cutover, sealed stage execution, durable effects,
  repair, publication, provider evidence, and runtime cleanup.
- Repository-configurable structured workflows with durable unit state,
  executor-owned worktrees, unit acceptance, serial exact-subject integration,
  whole-change gates, and a Docker walking skeleton.
- Self-contained skills, analysis/tuning evidence, GitHub-Issue control,
  automatic admission planning/review, and provider-neutral admission
  visibility.
- Codex supervisor-owned token brokerage and concurrent review-persona fanout.
  The active review window defaults to 5 and can be rolled back to serial by
  setting `REVIEW_FANOUT_CONCURRENCY=1`.
- OPE-187 lifecycle hardening: task branches are reserved at the exact base
  before planning; accepted write work advances through acknowledged exact-SHA
  checkpoints; replacement sandboxes restore from the acknowledged checkpoint;
  bounded action artifacts are retained while reconstructible runtime state is
  pruned.
- Automatic admission is the initializer and repository default for Claude and
  Codex. `openthrottle init` also materializes the editable simple graph plus
  repository-owned implementation, admission-planner, and admission-reviewer
  skills. OpenCode continues to use direct default-graph routing because its
  structured loop-action runtime is not implemented.

## Active milestones

1. Run the credentialed automatic-admission evaluation and a plain-text live
   delegation with current planner/reviewer/runtime digests. Capture the blinded
   scoring report, accepted route, checkpoint restoration, publication, and
   cleanup evidence described in
   [`runbooks/automatic-admission.md`](runbooks/automatic-admission.md).
2. Deliver Phase 3A from the
   [parallel structured units plan](plans/2026-08-19-1232-feat-parallel-structured-units-plan.md):
   deterministic claim-safe waves, concurrent worktree-owned writers using the
   same durable fanout machinery as reviewers,
   durable multi-action recovery, a gather barrier, and strictly serial
   integration. Concurrency 1 must remain behaviorally equivalent to today's
   structured path and is the rollback switch.
3. After Phase 3A's live gate, deliver Phase 3B: lead preferences over the
   supervisor-certified ready set, scope-preserving splits, budget-reserve
   wind-down, coherent slice publication, and merge-evidence continuation.
4. Expand repository-owned scaffolding beyond the simple implementation and
   admission roles so every replaceable structured semantic role can be copied,
   validated, pinned, refreshed, and edited through the same `repo://` model.
5. Add OpenCode structured loop actions before claiming automatic structured
   admission or structured-unit parity for that engine.

## Release gates

- Contract, supervisor, CLI, sandbox, Bats, Docker smoke, and structured walking
  skeleton suites pass.
- Every externally visible decision is bound to immutable graph, skill,
  runtime, subject, and request identities.
- Stop, supersede, crash recovery, checkpoint restoration, retention, and disk
  pressure converge without losing accepted work or exposing secrets.
- Semantic review covers the complete branch diff; valid findings are fixed and
  regression-tested; GitHub CI and review threads are green.
- Credentialed Linear/GitHub/Daytona/Fly/model proofs run only as explicit
  operator gates, never as assumed CI coverage.

## Non-goals

- Parallel integration or agent-owned Git publication authority.
- Agent authority to approve the original plan, expand approved scope, merge a
  PR, bypass dependency/resource fences, or create arbitrary follow-up work.
- Multi-tenant administration, a separate web UI, or Windows support in this
  delivery lane.
