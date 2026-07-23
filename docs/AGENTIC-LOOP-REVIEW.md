## Code Review Results

> **Historical review record:** file paths and scheduler/direct-run findings
> below describe the pre-coordinator implementation. They are retained as
> provenance, not as current operational guidance; see `docs/SPEC.md` and
> `docs/PLAN.md` for the coordinator-only contract.

**Scope:** `9a51ab02094f51d40dd570893362f1465d01575b..5bf4d53d08c9c0374fdcf4eaa8c2cac86692a3b4` on `knoxgraeme/review-agentic-loop` (73 files; 7,699 additions / 2,355 deletions)
**Intent:** Review the simplification, durable feedback, live progress, rotating auth, reaper, dispatch guard, and mid-run steering changes as one autonomous-loop modernization.
**Mode:** markdown report-only
**Reviewers:** correctness, reliability, testing, security, performance, maintainability, project-standards, agent-native, api-contract, data-migration. Security was selected for shared subscription credentials and untrusted steering; performance for heartbeat persistence/reaper queries; project-standards and agent-native for canonical skills and loop behavior; API/data reviewers for runtime, SQLite, and upgrade contracts.

### Structural Assessment

The architectural direction is sound: Linear is the control plane, GitHub is the work surface, the supervisor owns durable state, and the sandbox owns agent reasoning. The same-session feedback loop is also the right primitive. The current implementation is not yet dependable enough for unattended operation because several durable states mean "attempted" where the scheduler treats them as "consumed," and several terminal transitions unlock the ticket before the old actor is actually gone.

The strongest consolidation path is:

1. Keep the semantically distinct webhook, sandbox-event, and Linear-outbox queues, but replace the duplicated `session_work` plus `session_inbox` message bodies with one work item and explicit delivery attempts/acknowledgements. The plan said to revisit queue consolidation when a fifth queue appeared; `session_inbox` is that fifth queue.
2. Give every claim/delivery the same lifecycle vocabulary: `pending -> leased -> dispatched/uploaded -> acknowledged -> consumed`, with lease expiry, attempts, last error, and compare-and-set terminal transitions.
3. Make one loop manifest authoritative for task name, entry skill, CE pipeline, and allowed triggers; generate scheduler/runtime/test declarations from it.
4. Add a typed completion outcome and deterministic gate receipts. This is a pre-existing architectural gap, but it is the cleanest way for the outer machine to verify that an implement loop actually shipped a matching PR and ran the configured gates.
5. Split the 1,359-line SQLite store by domain (`tickets/runs`, `work/delivery`, `events/outbox`, `settings/auth`) over the same database and transaction coordinator. Split tests beside those modules rather than growing `server.test.ts` further.
6. Introduce an error taxonomy: retry bounded infrastructure failures automatically, resume agent-fixable failures, pause on explicit human decisions, and reserve terminal `error` for exhausted or non-recoverable work.

### Triage Groups

| Group | Findings | Context | Preferred Resolution | Why |
|---|---|---|---|---|
| Credential continuity and trust (decision gate) | #1, #3, #21 | Supervisor refresh, sandbox reuse, and fleet-wide persistence currently disagree on credential ownership | Bound refresh I/O first (#3), select the newest trusted token (#1), then decide whether to validate/pin rotated credentials or move to per-run credentials (#21) | Fixing only one race leaves either resume failures or a fleet-wide trust escalation |
| Exactly-once work and steering (apply queue) | #4, #7, #9, #10, #16, #17, #22 | Claims, inbox uploads, review events, and CI events lack one durable acknowledgement model | Define one leased work-item state machine; then bind delivery by run/session and batch one PR snapshot per round | One delivery/ack contract resolves most lost, duplicated, and over-counted feedback |
| Run liveness and settlement (apply queue) | #8, #14, #18, #19, #23, #28 | The reaper can miss dead bootstrap runs, kill healthy long commands, overlap agents, and block the event loop | Establish explicit liveness leases and an exclusive `reaping` transition before tuning retention/indexes | Correct state transitions must precede query and retention optimization |
| Canonical agent contract (apply queue) | #2, #20, #25, #26, #32 | Skill names, invocation syntax, runtime pipeline metadata, and the supposed registry have drifted | Fix the installed skill name (#2), prove real CLI hook behavior (#20), then generate all loop declarations from one manifest | The agent cannot reliably follow a contract that is both invalid and duplicated |

### P1 -- High

| # | File | Issue and required response | Reviewer | Confidence |
|---|---|---|---|---|
| 1 | `sandbox/entrypoint.sh:199` | Resume keeps a stale local Codex token even when preflight produced a newer seed; compare `last_refresh` and atomically install the newer trusted blob | reliability | 100 |
| 2 | `skills/tasks/implement-plan/SKILL.md:47` | The adapter invokes nonexistent `ce-simplify`; rename it to the pinned `ce-simplify-code` skill and contract-test every referenced skill | api-contract | 100 |
| 3 | `supervisor/src/codex-auth.ts:165` | OAuth refresh has no timeout and can hold the run lock/shared refresh promise indefinitely; add a bounded abort and fallback test | reliability | 100 |
| 4 | `supervisor/src/db.ts:1118` | `session_work` claims have no lease, so a restart can strand feedback forever; add lease/attempt/error fields and restart recovery | testing, fast-pass | 100 |
| 6 | `supervisor/src/db.ts:691` | Upgrade resets the bounded review-round history because legacy `review-fix` runs are not counted/backfilled; preserve the lifetime cap | data-migration | 100 |
| 7 | `supervisor/src/db.ts:714` | A transient launch failure leaves pending work on an `error` ticket that recovery excludes; redrain idle `active` and `error` tickets | correctness | 100 |
| 8 | `supervisor/src/db.ts:768` | Runs with no sandbox events are never stalled because `MAX` is NULL; use the documented `started_at` fallback and test bootstrap silence | api-contract | 100 |
| 9 | `supervisor/src/inbox.ts:27` | A fallback resume leaves its old inbox row pending and injects the same steer into the next run; retire the old delivery on fallback launch | correctness | 100 |
| 10 | `supervisor/src/inbox.ts:27` | Pending inbox selection ignores stored run/session IDs, allowing stale guidance into a newer context; require current run/session binding | testing, security | 100 |
| 12 | `supervisor/src/linear-events.ts:308` | The documented missing-session recovery says re-delegate, but same-agent re-delegation selects `resume` again; persist a fresh-context requirement | correctness, fast-pass | 100 |
| 14 | `supervisor/src/reaper.ts:38` | The reaper emits timeout/settlement side effects after losing the completion compare-and-set; stop when `finishRun` returns undefined | testing, reliability | 100 |
| 16 | `supervisor/src/scheduler.ts:223` | Upload is treated as consumption, so a crash before the hook boundary loses steering and cancels fallback; require a durable hook acknowledgement | reliability, testing | 100 |
| 17 | `supervisor/src/scheduler.ts:94` | One whole-review snapshot can consume several bounded rounds because each event launches independently; batch event IDs into one claimed manifest | agent-native | 100 |
| 18 | `sandbox/runner/normalize.mjs:134` | Fifteen-second ephemeral heartbeats permanently grow `linear_outbox`; prune only old processed rows while retaining pending/failed work | performance | 75 |
| 19 | `sandbox/runner/normalize.mjs:346` | Quiet commands longer than the stall threshold look dead because heartbeats occur only on completion; track bounded in-flight command liveness | reliability | 75 |
| 20 | `sandbox/tests/smoke.sh:174` | Steering tests replace the real Codex CLI, so hook discovery/trust/injection can fail in production while CI passes; add a real pinned-CLI acceptance test | testing | 75 |
| 21 | `supervisor/src/codex-auth.ts:117` | An agent-writable auth blob can replace the credential used by later tickets; decide between centrally validated account-pinned rotation and per-run credentials | security | 75 |
| 22 | `supervisor/src/github-events.ts:188` | SHA-only CI dedup discards a later distinct workflow failure on the same commit; key by stable workflow/check identity | correctness | 75 |
| 23 | `supervisor/src/reaper.ts:38` | Reaping clears the dispatch lock before the old process is stopped, allowing two agents in one workspace; use a non-dispatchable `reaping` state and explicit stop | reliability | 75 |

### P2 -- Moderate

| # | File | Issue and required response | Reviewer | Confidence |
|---|---|---|---|---|
| 25 | `sandbox/lib/runtime.sh:92` | Runtime pipeline metadata omits the required conditional simplification stage; after #2, declare `ce-simplify-code` and update contract tests | project-standards | 100 |
| 26 | `skills/tasks/implement-plan/SKILL.md:40` | Required native skills first appear as bare prose despite the explicit cross-engine invocation convention; add `/skill` and `$skill` forms | project-standards | 100 |
| 27 | `supervisor/scripts/snapshot-resources.mjs:25` | Executable disk default is 5 GiB while workflow, SPEC, README, and example config say/use 10 GiB; choose one value and generate/check all surfaces | correctness, reliability, api-contract | 100 |
| 28 | `supervisor/src/db.ts:768` | The correlated latest-event query lacks `(run_id, created_at)` support and blocks the synchronous SQLite event loop as history grows; add and verify the index | data-migration, performance | 100 |
| 32 | `supervisor/src/scheduler.ts:30` | `LOOP_REGISTRY` is unused while dispatch/runtime remain hard-coded elsewhere; delete the false canonical layer or make one generated manifest authoritative | maintainability | 100 |

### Requirements Completeness

The discovered plan is inferred from `docs/SIMPLIFICATION-PLAN.md`, so this checklist informs the review but does not independently block it.

- Partial: Phase 1 removed internal review loops and moved feedback to same-session resume, but #4, #7, #17, and #22 prevent reliable bounded delivery.
- Partial: Phase 2 extracted scheduler/event/lifecycle modules, but #32 shows the promised registry does not drive transitions and several current transitions remain non-durable.
- Partial: Phase 3 single-sourced adapters, but #2, #25, and #26 leave the canonical agent contract invalid/inconsistent.
- Met: Phase 4 legacy per-agent adapter bridges are removed and absence is pinned in tests.
- Not evaluated: Phase 5 debugging access was explicitly gated on a product decision.
- Triggered follow-up: the plan said to revisit queue consolidation when a fifth queue appeared; `session_inbox` is now the fifth.

### Actionable Findings

| # | File | Issue | Route | Notes |
|---|---|---|---|---|
| 1 | `sandbox/entrypoint.sh:199` | Newer central Codex seed ignored on resume | `gated_auto -> downstream-resolver` | Suggested fix present; auth ordering needs integration verification |
| 2 | `skills/tasks/implement-plan/SKILL.md:47` | Nonexistent CE skill invoked | `gated_auto -> downstream-resolver` | Suggested fix present |
| 3 | `supervisor/src/codex-auth.ts:165` | Refresh request unbounded | `gated_auto -> downstream-resolver` | Suggested fix present |
| 4 | `supervisor/src/db.ts:1118` | Work claim has no lease | `manual -> downstream-resolver` | Suggested fix present; concurrency/schema change |
| 6 | `supervisor/src/db.ts:691` | Review-round history resets on upgrade | `gated_auto -> downstream-resolver` | Suggested fix present; migration compatibility |
| 7 | `supervisor/src/db.ts:714` | Error tickets excluded from recovery | `gated_auto -> downstream-resolver` | Suggested fix present |
| 8 | `supervisor/src/db.ts:768` | No-event run never stalls | `gated_auto -> downstream-resolver` | Suggested fix present |
| 9 | `supervisor/src/inbox.ts:27` | Fallback steer re-delivered | `gated_auto -> downstream-resolver` | Suggested fix present |
| 10 | `supervisor/src/inbox.ts:27` | Inbox ignores run/session | `gated_auto -> downstream-resolver` | Suggested fix present; trust boundary |
| 12 | `supervisor/src/linear-events.ts:308` | Missing-session recovery repeats resume | `manual -> downstream-resolver` | Suggested fix present |
| 14 | `supervisor/src/reaper.ts:38` | Completion/reaper loser emits side effects | `gated_auto -> downstream-resolver` | Suggested fix present |
| 16 | `supervisor/src/scheduler.ts:223` | Upload treated as consumption | `manual -> downstream-resolver` | Suggested fix present; delivery protocol change |
| 17 | `supervisor/src/scheduler.ts:94` | One review burns several rounds | `manual -> downstream-resolver` | Suggested fix present |
| 18 | `sandbox/runner/normalize.mjs:134` | Processed heartbeat rows never pruned | `gated_auto -> downstream-resolver` | Suggested fix present |
| 19 | `sandbox/runner/normalize.mjs:346` | Healthy long command looks stalled | `manual -> downstream-resolver` | Suggested fix present |
| 20 | `sandbox/tests/smoke.sh:174` | Real Codex hook contract untested | `gated_auto -> downstream-resolver` | Suggested fix present |
| 22 | `supervisor/src/github-events.ts:188` | CI failures deduped by SHA only | `gated_auto -> downstream-resolver` | Suggested fix present |
| 23 | `supervisor/src/reaper.ts:38` | Reaper permits overlapping agents | `manual -> downstream-resolver` | Suggested fix present; process termination semantics |
| 25 | `sandbox/lib/runtime.sh:92` | Pipeline metadata omits simplification | `gated_auto -> downstream-resolver` | Suggested fix present; do after #2 |
| 26 | `skills/tasks/implement-plan/SKILL.md:40` | Cross-engine invocation syntax incomplete | `gated_auto -> downstream-resolver` | Suggested fix present; do after #2 |
| 27 | `supervisor/scripts/snapshot-resources.mjs:25` | Snapshot disk default drift | `gated_auto -> downstream-resolver` | Suggested fix present |
| 28 | `supervisor/src/db.ts:768` | Stall query missing supporting index | `gated_auto -> downstream-resolver` | Suggested fix present |
| 32 | `supervisor/src/scheduler.ts:30` | Loop registry is an unused duplicate | `gated_auto -> downstream-resolver` | Suggested fix present; consolidation choice |

Human decision gate: #21 requires choosing the credential trust model before implementation.

### Pre-existing Issues

These are outside the modernization diff's verdict but remain important to the user's current-state question.

| ID | File | Current weakness | Suggested direction |
|---|---|---|---|
| E1 | `supervisor/src/linear-events.ts:301` | Re-delegation during an active run supersedes the session but does not persist the new dispatch | Queue a generation-bound dispatch and consume it only after launch |
| E2 | `supervisor/src/linear-events.ts:561` | `/merge` is enqueued as session work before command handling and can replay later as a resume | Handle control commands before work enqueue, or explicitly consume/cancel the command row |
| E3 | `supervisor/src/run-lifecycle.ts:357` | Exit zero is accepted without a typed, task-specific outcome or deterministic gate/PR receipts | Require outcomes such as `shipped`, `no-fix`, `needs-human`, and verify the matching PR/gate evidence |
| E4 | `supervisor/src/run-lifecycle.ts:396` | Any prior terminal response can suppress a later nonzero wrapper failure | Suppress only when an error activity already represents that failure |

### Agent-Native Gaps

- OpenCode replies remain queued until after the run because no live steering hook is wired; expose that distinction in status/UX until the real hook is verified.
- The operator steering HTTP endpoint is not surfaced by the CLI. Either add `openthrottle steer` or remove the orphaned public surface until it has an operator workflow.
- Gate and PR completion are still agent-authored prose rather than supervisor-verifiable receipts; E3 is the key next-generation loop contract.

### Coverage

- Mechanical merge: 43 raw reviewer candidates -> 33 deduplicated candidates -> 24 validated primary findings. No confidence-gate suppressions or malformed returns.
- Soft-bucket demotions: 4. `session_work`/`session_inbox` duplication and the oversized server test module are residual risks; the weak recovery test is a testing gap; OpenCode live steering is an agent-native gap.
- Validator: one fresh batch checked all 24 P1 candidates plus five actionable P2 candidates. It validated 24, rejected one intentional migration claim, and classified four candidates as pre-existing. No blocker is validation-degraded.
- Cross-model adversarial route: `claude-native`; `model_requested=opus`; `model_actual=unavailable`; `effort_requested=high`; `effort_actual=unavailable`; `receipt_supported=false`; `independence_verified=false`. The peer produced no usable schema-shaped output because its process could not set `LC_CTYPE=C.UTF-8`; this is an execution-context locale failure, not evidence of an account/login problem.
- Validation run: Node 22 syntax check, Bash syntax checks, and `git diff --check origin/main...HEAD` passed. Full npm typecheck/tests could not run because all three `node_modules` trees are absent; `bats` is also unavailable. No dependencies were installed for this report-only review.
- Residual risks: one human message is still duplicated between two durable tables; long concurrent Codex sandboxes share one rotating subscription lineage; same-session context can degrade across review rounds; inbox filenames lack a local containment check; `db.ts` remains a 1,359-line multi-domain store; `server.test.ts` remains an oversized integration fixture.
- Testing gaps: no file-backed restart test for claim recovery; no upload-vs-hook-consumption integration test; no completion/reaper interleaving test; no real pinned-CLI steering acceptance test; no end-to-end delegation -> PR -> review/CI failure -> same-session repair -> green/closure test.
- Repository state: unchanged and clean after review.

---

### Verdict

> **Verdict:** Not ready
>
> **Reasoning:** The high-level split and same-session feedback model are good, but the current hardening can still lose, duplicate, or cross-deliver feedback; overlap two agents after a reap; repeatedly fail the documented missing-session recovery; and fail the conditional simplification stage through an invalid skill name. Those are autonomy-breaking defects, not polish.
>
> **Fix order:** exactly-once work/steering (#4, #7, #9, #10, #16) -> exclusive liveness/settlement (#8, #14, #19, #23) -> auth continuity/trust (#1, #3, then decision #21) -> canonical agent contract (#2, #20, #25, #26, #32) -> feedback batching/dedup and operational cleanup (#6, #17, #18, #22, #27, #28).

Prioritized actionable recap:

- #4 P1 `supervisor/src/db.ts:1118` -- claimed work has no recovery lease; `manual -> downstream-resolver`; suggested fix: yes; confidence 100.
- #16 P1 `supervisor/src/scheduler.ts:223` -- upload is mistaken for consumption; `manual -> downstream-resolver`; suggested fix: yes; confidence 100.
- #10 P1 `supervisor/src/inbox.ts:27` -- inbox ignores run/session binding; `gated_auto -> downstream-resolver`; suggested fix: yes; confidence 100.
- #9 P1 `supervisor/src/inbox.ts:27` -- fallback steer is re-delivered; `gated_auto -> downstream-resolver`; suggested fix: yes; confidence 100.
- #7 P1 `supervisor/src/db.ts:714` -- error-state work is not recovered; `gated_auto -> downstream-resolver`; suggested fix: yes; confidence 100.
- #23 P1 `supervisor/src/reaper.ts:38` -- reaper can overlap agents; `manual -> downstream-resolver`; suggested fix: yes; confidence 75.
- #14 P1 `supervisor/src/reaper.ts:38` -- reaper acts after losing completion CAS; `gated_auto -> downstream-resolver`; suggested fix: yes; confidence 100.
- #8 P1 `supervisor/src/db.ts:768` -- no-event runs never stall; `gated_auto -> downstream-resolver`; suggested fix: yes; confidence 100.
- #19 P1 `sandbox/runner/normalize.mjs:346` -- healthy long commands look stalled; `manual -> downstream-resolver`; suggested fix: yes; confidence 75.
- #1 P1 `sandbox/entrypoint.sh:199` -- newer Codex seed ignored on resume; `gated_auto -> downstream-resolver`; suggested fix: yes; confidence 100.
- #3 P1 `supervisor/src/codex-auth.ts:165` -- token refresh is unbounded; `gated_auto -> downstream-resolver`; suggested fix: yes; confidence 100.
- #2 P1 `skills/tasks/implement-plan/SKILL.md:47` -- adapter invokes nonexistent skill; `gated_auto -> downstream-resolver`; suggested fix: yes; confidence 100.
- #20 P1 `sandbox/tests/smoke.sh:174` -- real Codex hook path is untested; `gated_auto -> downstream-resolver`; suggested fix: yes; confidence 75.
- #12 P1 `supervisor/src/linear-events.ts:308` -- re-delegation repeats missing-session resume; `manual -> downstream-resolver`; suggested fix: yes; confidence 100.
- #17 P1 `supervisor/src/scheduler.ts:94` -- one review burns several rounds; `manual -> downstream-resolver`; suggested fix: yes; confidence 100.
- #22 P1 `supervisor/src/github-events.ts:188` -- SHA-only CI dedup drops later failures; `gated_auto -> downstream-resolver`; suggested fix: yes; confidence 75.
- #6 P1 `supervisor/src/db.ts:691` -- upgrade resets review-round history; `gated_auto -> downstream-resolver`; suggested fix: yes; confidence 100.
- #18 P1 `sandbox/runner/normalize.mjs:134` -- processed heartbeat outbox grows forever; `gated_auto -> downstream-resolver`; suggested fix: yes; confidence 75.
- #25 P2 `sandbox/lib/runtime.sh:92` -- runtime pipeline omits simplification; `gated_auto -> downstream-resolver`; suggested fix: yes; confidence 100.
- #26 P2 `skills/tasks/implement-plan/SKILL.md:40` -- explicit invocation syntax is incomplete; `gated_auto -> downstream-resolver`; suggested fix: yes; confidence 100.
- #32 P2 `supervisor/src/scheduler.ts:30` -- loop registry is unused duplication; `gated_auto -> downstream-resolver`; suggested fix: yes; confidence 100.
- #27 P2 `supervisor/scripts/snapshot-resources.mjs:25` -- disk defaults disagree; `gated_auto -> downstream-resolver`; suggested fix: yes; confidence 100.
- #28 P2 `supervisor/src/db.ts:768` -- stall query lacks the run/timestamp index; `gated_auto -> downstream-resolver`; suggested fix: yes; confidence 100.

---

## Plan Disposition — Configurable Agentic Pipeline Coordinator

Added by **U1** of
`docs/plans/2026-07-21-001-feat-configurable-agentic-pipeline-coordinator-plan.md`.
This matrix records the *planned* disposition and the evidence each finding
requires. Every finding is labelled with one of: **prerequisite** (an acute fix
landed independently, ahead of any coordinator cutover), **resolved by U-ID**
(closed when the named unit ships with the listed evidence), **orthogonal
follow-up** (tracked separately, stays open), or **verified obsolete** (no longer
applies).

Per the plan, **U1 does not mark any finding resolved** — every row is `open`
here. A finding is closed only in its named unit against the required evidence,
and the entire audit is rerun line by line at cutover (U8 / requirement R30),
where unresolved credential-trust work (#21) must stay visibly open rather than
be treated as resolved by a replaced code path.

| Finding | Disposition | Unit(s) | Required verification evidence | Status |
|---|---|---|---|---|
| #1 newer Codex seed overwritten on resume | prerequisite | U2 | Freshness/lineage regression tests and resume smoke. | open |
| #2 nonexistent `ce-simplify` reference | prerequisite, then catalog validation | U1, U2, U8 | Source rename + skills-tree contract test (landed in U1 on this branch); snapshot skill-resolution and generated-reference validation (U8). | open |
| #3 unbounded Codex refresh I/O | prerequisite | U2 | Hanging-endpoint timeout/cancellation test. | open |
| #4 work claimed without a lease | resolved by U-ID | U3 | File-backed lease crash matrix. | open |
| #6 review-round history can reset | resolved by U-ID | U3, U8 | Migration and legacy/new preservation tests. | open |
| #7 errored tickets can strand work | resolved by U-ID | U3 | Explicit redrain/recovery state tests. | open |
| #8 no-event runs evade stale detection | resolved by U-ID | U4 | `started_at` fallback test. | open |
| #9 fallback steering race | resolved by U-ID | U3 | Acknowledgement/cancel/redelivery matrix. | open |
| #10 work can cross session/run | resolved by U-ID | U3 | Session/run/generation/context fencing tests. | open |
| #12 missing native session recovery repeats failure | resolved by U-ID | U1, U6 | Explicit fresh/reconstruction/reject transition tests. | open |
| #14 reaper loser performs side effects | resolved by U-ID | U4 | Completion/reaper CAS race tests. | open |
| #16 inbox upload treated as consumption | resolved by U-ID | U3 | Hook acknowledgement test. | open |
| #17 provider events spend excess rounds | resolved by U-ID | U3 | One-snapshot/one-round tests. | open |
| #18 processed heartbeats grow indefinitely | resolved by U-ID | U4 | Retention/pruning safety tests. | open |
| #19 quiet long commands appear dead | resolved by U-ID | U4, U6 | Executor heartbeat liveness test. | open |
| #20 real pinned CLI acceptance is missing | prerequisite (feasibility/cutover gate) | U1, U8 | Real Claude/Codex/OpenCode snapshot acceptance (infra-gated; runs against the built image). | open |
| #21 writable shared credential lineage | orthogonal follow-up (stays open) | Deferred | Separate approved credential-trust decision; concurrent-run constraint remains documented. | open |
| #22 CI identity dedup loses distinct failures | resolved by U-ID | U3 | Stable workflow/check identity tests. | open |
| #23 reaper overlap and release-before-stop | resolved by U-ID | U4 | Reaper lock, stop confirmation, quarantine tests. | open |
| #25 declarative pipeline metadata drifts | resolved by U-ID | U5, U8 | Catalog-derived validation/declarations. | open |
| #26 engine invocation mapping drifts | resolved by U-ID | U1, U6, U8 | Generated capability descriptor and engine tests. | open |
| #27 disk/default config drift | prerequisite | U2 | Checked-in config/default contract test. | open |
| #28 missing run/event query index | resolved by U-ID | U4 | Schema/query test and bounded reaper scan. | open |
| #32 unused `LOOP_REGISTRY` is false authority | resolved by U-ID | U5, U8 | Remove registry after parity and zero legacy. | open |
| E1 follow-up dispatch not generation-bound | resolved by U-ID | U3 | Old-generation rejection tests. | open |
| E2 control command can queue behind work | resolved by U-ID | U3 | Control/stop priority and fencing tests. | open |
| E3 exit zero conflates semantic success | resolved by U-ID | U5, U6 | Missing/invalid result failure tests. | open |
| E4 wrapper can suppress failure | prerequisite, then typed result | U2, U6 | Wrapper/result precedence regression tests. | open |

No finding is dispositioned **verified obsolete**: every original finding maps
to a prerequisite fix, a unit that will resolve it, or explicit open follow-up
work.

## U8 cutover re-audit — 2026-07-22

This is the required line-by-line U8 re-audit of the original findings and the
four pre-existing issues. “Resolved” means the named repository evidence is
implemented and covered locally; it does not claim the credentialed deployment
acceptance reserved for the rollout gate.

| Finding | U8 status | Repository evidence |
|---|---|---|
| #1 newer Codex seed overwritten on resume | resolved | Central/newer seed selection and resume lineage are covered by Codex auth/runtime regression tests. |
| #2 nonexistent `ce-simplify` reference | resolved | Canonical adapters use `ce-simplify-code`; catalog/runtime/adapter parity tests reject unknown capability mappings. |
| #3 unbounded Codex refresh I/O | resolved | Refresh timeout, cancellation, and single-flight behavior are regression-tested. |
| #4 work claimed without a lease | resolved | Durable work-delivery leases, expiry, reclamation, and file-backed restart cases replace claim-only ownership. |
| #6 review-round history can reset | resolved | Migration reconciliation preserves consumed automatic work and pipeline repair counters without counting human work. |
| #7 errored tickets can strand work | resolved | Idle/error recovery and redrain tests retain and relaunch eligible current-generation work. |
| #8 no-event runs evade stale detection | resolved | Sealed liveness falls back to `started_at`; stale no-event actors are covered by reaper tests. |
| #9 fallback steering race | resolved | Dispatch/acknowledge/consume fencing cancels the queued fallback only after the exact journal is observed. |
| #10 work can cross session/run | resolved | Session, generation, run, context revision, request hash, and idempotency fences are stored and tested. |
| #12 missing native session recovery repeats failure | resolved | Manifest context policies make fresh, reconstruction, and reject transitions explicit and bounded. |
| #14 reaper loser performs side effects | resolved | Settlement CAS losers return before terminal publication or cleanup; interleaving tests pin the behavior. |
| #16 inbox upload treated as consumption | resolved | Upload is only `dispatched`; the sealed hook journal is required for `acknowledged` and later consumption. |
| #17 provider events spend excess rounds | resolved | Legacy and pipeline paths share immutable current-head snapshots: stable provider identities coalesce, arrivals during repair collect for the next snapshot, and one snapshot creates one manifest re-entry. |
| #18 processed heartbeats grow indefinitely | resolved | Processed ephemeral activity retention is pruned while retryable rows remain durable. |
| #19 quiet long commands appear dead | resolved | Root-owned executor heartbeats cover in-flight command and agent stages independently of semantic output. |
| #20 real pinned CLI acceptance is missing | **open — deferred POC verification** | Stubbed multi-engine Docker coverage exists, but real released-snapshot Claude/Codex/OpenCode runs require operator credentials. The POC owner explicitly deferred this test. |
| #21 writable shared credential lineage | **open — orthogonal** | No trust-model decision was inferred. The shared subscription lineage and API-key concurrency alternative remain documented; this finding stays owned outside coordinator cutover. |
| #22 CI identity dedup loses distinct failures | resolved | Provider event identity is workflow/check specific while current-head snapshots coalesce repair work. |
| #23 reaper overlap and release-before-stop | resolved | Non-dispatchable reaping and explicit stop confirmation retain exclusivity; uncertain termination quarantines the actor. |
| #25 declarative pipeline metadata drifts | resolved | Immutable CE v2 manifests and the independent runtime descriptor are boot-validated; fixtures use the same catalog path. |
| #26 engine invocation mapping drifts | resolved | Sandbox capability inventory and adapter tests cover Claude, Codex, and OpenCode stage invocation. |
| #27 disk/default config drift | resolved | Snapshot resource defaults are single-sourced and checked against workflow/documented surfaces. |
| #28 missing run/event query index | resolved | Additive migration and schema tests pin the liveness-supporting run/event indexes. |
| #32 unused `LOOP_REGISTRY` is false authority | resolved | `LOOP_REGISTRY`, `task_skill_name`, and `task_ce_pipeline` are absent; immutable manifests drive pipeline execution and one JSON registry remains explicitly legacy-only. |
| E1 follow-up dispatch not generation-bound | resolved | Work/effect intents carry immutable session and generation fences and reject stale execution. |
| E2 control command can queue behind work | resolved | Stop/control handling precedes semantic work and cancels nonterminal queued delivery. |
| E3 exit zero conflates semantic success | resolved | Typed stage artifacts, deterministic gate receipts, publish trees plus executor-verified remote commits, and head-bound provider receipts decide outcomes; process exit alone cannot pass. |
| E4 wrapper can suppress failure | resolved | Wrapper/result precedence requires a matching typed failure/result rather than any earlier terminal prose. |

### U8 verdict

> **Verdict:** Locally complete for the pre-production POC; credentialed acceptance is deferred.
>
> The original autonomy-breaking delivery, liveness, fencing, typed-result,
> and false-authority findings are resolved in repository code. #20 remains an
> explicit deferred verification item and #21 remains an orthogonal
> credential-trust decision. Because this is a POC with no installed consumer
> population, new generations use the coordinator unconditionally and there is
> no canary cohort, legacy-drain period, or production soak gate. Destructive
> schema contraction remains separate.
