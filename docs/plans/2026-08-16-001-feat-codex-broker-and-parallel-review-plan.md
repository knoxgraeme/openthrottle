---
title: "Codex token broker, then concurrent review fanout - Plan"
type: feat
date: 2026-08-16
origin: docs/plans/2026-07-22-001-feat-repository-configurable-structured-workflows-plan.md
---

# Codex token broker, then concurrent review fanout

Phased, individually testable delivery of intra-run parallelism, starting with
the credential fix that makes Codex an equal citizen. Phases 0 through 2 have
shipped. Phase 3 is now specified in the dedicated
[parallel structured units plan](2026-08-19-1232-feat-parallel-structured-units-plan.md).

## Why now

- The persona review fanout and all unit actions execute strictly serially.
  For personas the blockers are (a) shared per-action sandbox state and (b)
  the Codex credential; for units the serial spine was a deliberate V1
  decision (R14/KTD11 in the origin plan) whose parallel successor was
  named but deferred: "parallel unit dispatch, sibling worktree/process
  isolation, resource claims, conflict groups, and deterministic waves."
- The Codex blocker was probed on 2026-08-15 (source inspection of the pinned
  CLI 0.143.0 + behavioral A/B on 0.146.1, real credential untouched):
  - `refresh_token: ""` (empty string, never omitted — omission is a
    load-time serde failure) runs full sessions normally.
  - The CLI reloads auth.json from disk on both refresh paths (guarded
    proactive reload that adopts an externally-updated blob with no network
    call, and a 401 recovery ladder that reloads before refreshing).
    Reloads are gated on `tokens.account_id` matching.
  - Access tokens live ~240h (one sample; always compute from `exp`); the
    max action timeout is 24h, so mid-run renewal is unnecessary.
  - The CLI's own auth.json writes are not atomic; under the broker the CLI
    never writes it, and any supervisor-delivered rewrite must be
    tmp+rename.

## Phase 0 — pin the probe to the fleet binary

Behavior was verified on CLI 0.146.1; source says the auth structs are
byte-identical on the pinned 0.143.0, but `manager.rs` drifted ~430 lines
between them.

- Add a smoke assertion to `sandbox/tests/smoke.sh` (or a sibling probe
  script) that runs the image's own `codex` against an isolated
  `CODEX_HOME` whose auth.json fixture carries a syntactically valid access
  token and `refresh_token: ""`, asserting the CLI starts and fails on
  auth (not on parse). No live credential involved.
- Gate: assertion passes against the built image in CI docker-smoke.

## Phase 1 — supervisor-owned Codex token broker

The supervisor becomes the only holder of the refresh token; sandboxes only
ever see access tokens. Mostly deletion; the single-flight central refresh in
`supervisor/src/providers/codex/auth.ts` already exists.

Scope:

- Seed stripping: the per-action credential envelope carries the stored blob
  with `tokens.refresh_token` set to `""` — preserving `access_token`,
  `id_token`, `account_id`, `auth_mode`, `last_refresh`. Never delete the
  key. Never alter `account_id`.
- Refresh leeway: raise the proactive refresh threshold from 15 minutes to
  `taskTimeout + margin`, so no sandbox is ever seeded with a token that can
  expire mid-action (~one refresh every ~9 days at current TTL).
- Fail closed: reject admission when the stored token has less than
  `taskTimeout` remaining and the central refresh failed, instead of seeding
  a doomed sandbox.
- Delete the capture-back path end to end: the auth.json harvest in both
  runners, `captureCodexAuth` plumbing through pipeline-effects and
  structured-child-runtime, `captureCodexAuthJson` wiring in `index.ts`, and
  the newest-wins reconcile in `entrypoint.sh`/`lib/runtime.sh`. The seed
  always wins.
- SPEC: remove the per-persona auth-snapshot serialization requirement;
  document the broker contract (empty-string invariant, account_id gate,
  leeway, fail-closed rule) as normative.

Tests and gates:

- Unit: seed stripping shape, leeway boundary, fail-closed admission path;
  runner tests updated for the removed harvest; bats for the removed
  reconcile.
- CI: full suites + docker smoke green.
- Live dogfood gate: after auto-deploy, re-delegate one previously stopped
  ticket (the OPE-177/179/181 redo backlog) and confirm a full Codex run
  completes with no auth material in results and no rotation of the stored
  credential (`last_refresh` unchanged unless the supervisor refreshed).
- Rollback: revert the PR (restores capture-back); the stored credential is
  untouched by the broker until its first central refresh.

Side effects: closes coordinator-plan audit #21 (shared agent-writable
rotating credential); removes today's cross-ticket rotation exposure; the
refresh token stops entering sandboxes at all.

## Phase 2 — concurrent review personas

Personas are read-only sessions with no worktree, no integration risk, and
(post Phase 1) no stateful credentials on any engine. They share one sandbox,
so this adds no Daytona quota pressure.

Scope:

- Sandbox sibling isolation: give each concurrently-running subaction its own
  action directory state and its own CLI home (redirect `~/.claude`,
  `~/.codex`, and OpenCode state per sibling; the stage-boundary reset
  discipline extends to sibling homes). The repo checkout stays a single
  shared read-only view — that property is load-bearing for receipt/subject
  integrity and must not change.
- Supervisor concurrent fanout: replace the serial dispatch/collect loop in
  the review fanout with bounded concurrent dispatch (config, small default,
  e.g. 3) over the existing durable per-subaction dispatch intents;
  collection gathers all siblings; the validator and deterministic synthesis
  remain strictly serial after the gather.
- Per-subaction liveness/timeout semantics unchanged (they are already
  per-action); crash recovery must re-collect individual siblings exactly as
  today.

Tests and gates:

- Unit: concurrent collection determinism (synthesis byte-identical to the
  serial result for the same receipts), bounded-concurrency cap, single
  sibling crash/retry without disturbing others.
- Walking skeleton: a scenario with N stub personas running concurrently,
  asserting no shared-state contention, all receipts collected, and the same
  synthesis as the serial ordering.
- Live dogfood gate: delegate a review-heavy ticket; compare final_review
  wall-clock against a serial baseline; confirm review journal and repair
  authority behave identically.
- Rollback: concurrency config back to 1 restores serial behavior without
  code changes.

## Phase 3 — parallel structured units

The complete implementation contract now lives in the
[Phase 3 plan](2026-08-19-1232-feat-parallel-structured-units-plan.md). It first
delivers deterministic, claim-safe parallel waves with isolated writable
workers and serial integration. Lead-selected scheduling, safe splits,
continuation, and budget-aware wind-down follow only after that mechanical
layer passes its live gate.

## Dogfooding thread

Every phase lands through the normal PR + CI path and is exercised by a live
delegated run before the next phase starts. The Phase 1 gate doubles as the
pending redo of the receipt-correction-stopped tickets. Supervisor-side
Phase 2 work is a candidate for delegation through the pipeline itself once
Phase 1 is proven live.

## Out of scope

- API-key Codex auth (documented fallback if the broker misbehaves live) and
  credential pools (fallback of last resort).
- Engine-native subagent fanout as the review mechanism — rejected as the
  default: it makes persona evidence parent-mediated, degrading per-persona
  receipt authority, timeout/liveness, and crash recovery from
  supervisor-enforced to engine-trusted, and it is engine-specific.
- Any change to integration serialization, in any phase.
