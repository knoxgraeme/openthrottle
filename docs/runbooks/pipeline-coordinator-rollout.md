# Pipeline coordinator rollout

This runbook activates the configurable pipeline coordinator without changing
the execution mode of an already-delegated generation. Activation, legacy-code
removal, and schema contraction are separate releases.

## Ownership and hard stops

| Responsibility | Primary | Backup | Stop condition |
|---|---|---|---|
| Release and admission flag | `@knoxgraeme` | designated repository release operator | No backup recorded in the release issue |
| SQLite backup, migration, restore | Fly volume operator | designated infrastructure operator | Restore rehearsal absent or checksum mismatch |
| Daytona runtime/capability compatibility | snapshot release operator | designated infrastructure operator | Runtime/catalog digest mismatch |
| Linear/GitHub evidence | OpenThrottle product operator | designated release operator | Missing/duplicate receipt or wrong session |
| Soak incident response | release operator on call | infrastructure operator on call | No reachable responder for the full soak |
| Final audit and deferred findings | `@knoxgraeme` | designated security reviewer | #21 or another deferred finding is unowned |

The designations above must be replaced by named people in the release issue
before canary. This repository does not guess personnel from credentials. An
unassigned backup is a hard stop, not an implied approval.

## Release rings

1. **Dormant schema.** Deploy additive migrations with
   `PIPELINE_COORDINATOR_ENABLED=false`. Save the release SHA, catalog digest,
   runtime descriptor digest, database backup ID, and `/status` baseline.
2. **Runtime capability.** Build the Daytona snapshot independently. The image
   build must pass `capabilities.mjs --verify` against the descriptor shipped to
   the supervisor. Keep admission off through one supervisor restart.
3. **Fixture acceptance.** Select `fixture-command` and `fixture-agent` in a
   test repository. Prove command, fresh, resume-required, and review contexts
   without CE-specific coordinator changes. Before admission, prove there are
   no non-terminal `pipeline_instances` on the accepted immutable v1 manifests;
   v2 is the first runtime-executable CE manifest and v1 remains audit-only.
4. **Single-repository canary.** Use the Deploy workflow's `canary` admission
   mode with exactly one registered repository. Exercise implement,
   investigate, every advertised engine, a failed-feedback repair, Linear
   publication retry, and GitHub summary reconciliation.
5. **Cohort expansion.** Add repositories one at a time. Hold each ring for at
   least the greater of 24 hours or twice the maximum configured task timeout.
6. **Default admission.** Select `all` only after live acceptance is attached
   to the release issue and every stop criterion below is false.
7. **Legacy drain.** Require `/status.legacy_drain.drained=true` on consecutive
   reconciliation sweeps and throughout a 72-hour soak longer than every
   lease/retry horizon.
8. **Cleanup release.** Remove the compatibility path only in a separately
   reviewed release after backup restore and previous-supervisor compatibility
   are re-proved. Keep legacy tables read-only for at least one later release.
   Destructive schema contraction is another independently approved release.

## Saved baseline

Before each ring, attach these to the release issue:

- Git SHA, Fly release ID, Daytona snapshot/release, catalog digest, runtime
  capability digest, and schema-migration ledger/checksums;
- a restorable SQLite volume snapshot and the successful restore command/log;
- `/status` including admission policy, execution summary, complete legacy
  drain predicate, waiting reasons, and publication-blocked count;
- counts/oldest ages for webhook deliveries, work items/deliveries, actors,
  sandbox events, provider snapshots, pipeline effects, publication receipts,
  runtime resources, reaping/quarantine, and sandboxes;
- one Linear ledger permalink and one GitHub summary permalink per accepted
  flow, with secrets and reasoning absent.

## Canary acceptance

Go only when all of the following are attached:

- local typecheck/build/test/Bats/Docker smoke is green;
- the real pinned Claude, Codex, and OpenCode CLIs each complete a fenced stage
  against the released snapshot (stub smoke alone is insufficient);
- implement traverses planning, implementation, semantic review,
  simplification run/skip, configured test/lint/build, exact-tree publish, and
  provider wait; its provider receipt names the same commit the publish executor
  sealed, and a post-publish head change produces `needs_human`, never `shipped`;
- investigate emits a typed result and conditionally publishes without entering
  implement-only stages;
- command and semantic-agent fixtures can be selected by catalog/config only;
- one red GitHub head produces one bounded current-head repair in the original
  implementation session, followed by a distinct green/merge provider receipt;
- a Linear outage queues one receipt, does not duplicate it, and terminal state
  remains completion-pending until acknowledgement;
- the admission kill switch exercise below passes;
- owners and backups are named, reachable, and approve the evidence.

Stop on any unfenced actor, stale/cross-generation event, subject mismatch,
missing typed artifact, unbounded retry/re-entry, lost feedback, duplicate
publication, credential leakage, permanent publication failure, growing queue
age, runtime/catalog skew, or migration/restore discrepancy.

## Admission kill-switch exercise

1. Record one active legacy generation, one active canary pipeline generation,
   and their review/session counters.
2. Manually deploy with `pipeline_admission=canary` and the test repository.
   Delegate one new ticket and verify only it pins pipeline mode.
3. Deploy with `pipeline_admission=off`.
4. Re-read `/status`: the active canary remains pipeline with unchanged
   manifest/config/runtime digests and counters; the active legacy generation
   remains legacy; a newly delegated generation is legacy.
5. Let the pinned canary advance or pause at a fenced wait. Never convert it to
   legacy. Attach before/after status and ledger evidence.

The kill switch controls future admission only. If an active pipeline is
unsafe, stop/quarantine that generation explicitly; do not reinterpret it.

## Rollback decision tree

- **Selection fails before provisioning:** keep admission off, fix catalog or
  repository config, and re-delegate only after validation.
- **New pipeline fails; active actor is fenced and recoverable:** disable future
  admission, leave pinned instances unchanged, repair the current release, and
  resume through their durable effects.
- **Actor identity, credential, tree, published-commit, or provider-head fence is uncertain:** disable
  admission, stop the actor, quarantine the runtime resource, preserve DB and
  sandbox evidence, and escalate. Do not fall back in place.
- **Publication only is permanently blocked:** keep the technical state pinned,
  use the authenticated publication retry after correcting provider access, and
  verify the stable external ID.
- **Migration or database integrity fails:** stop deployment, restore the saved
  backup, run the previous compatible supervisor with admission off, and retain
  the failed database for analysis.
- **Runtime/supervisor skew:** roll forward the missing snapshot or supervisor
  component only after descriptor verification. Never weaken capability checks.

## Cross-domain legacy drain predicate

`GET /status` reports the canonical predicate. It is false while any legacy
generation has an active/error ticket, running/reaping/quarantined actor,
pending/leased/dispatched/acknowledged/reconciliation work item or delivery,
steering inbox item, collecting/claimed feedback snapshot, unassigned provider
event, retryable webhook/Linear/sandbox event, or retained active sandbox.

Record a sample at every sweep. A rediscovered obligation resets the soak clock.
Zero active-run count alone is never sufficient. Before cleanup, also query for
unexpected legacy effect/publication/resource bindings; their expected count is
zero because those tables require a pipeline instance.

## Monitoring

The operator surface is authenticated `GET /status` plus ticket `logs` and the
Linear/GitHub permanent receipts. Dashboards should link to those sources and
segment by execution mode, repository cohort, pipeline/version, engine, stage,
wait reason, and publication state. Alert on oldest age and count for actor
liveness, effect leases/retries, work delivery acknowledgement, feedback
backlog, gate subject/assurance mismatch, publication blocking, reaping,
quarantine, and every nonzero legacy-drain component.

## Current release boundary

The code and local Docker smoke make the release canary-ready, but this checkout
has no authority to perform the credentialed Linear-to-Daytona-to-GitHub live
acceptance, name another human operator, restore the production Fly volume, or
observe a 72-hour drain. Therefore broad admission and legacy removal remain
blocked until those artifacts are attached. The compatibility registry and
legacy tables intentionally remain; schema contraction is not part of this
release.
