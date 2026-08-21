# Execution-kernel offline replacement

Use this runbook once to replace the dogfood installation with the fresh
execution-kernel epoch. Downtime is intentional. This is not an online
transition and is not a reusable migration framework.

The normal [`deploy.yml`](../../.github/workflows/deploy.yml) workflow performs
direct releases after this operation. It does not own storage replacement.

## Required artifacts

Prepare and pin:

- exact old supervisor image/release and Daytona snapshot;
- exact candidate supervisor image/release and Daytona snapshot;
- old SQLite database and blob-root paths;
- distinct, absent fresh database and blob-root paths on the same Fly volume;
- an absent archive directory and absent report path;
- a checksummed `openthrottle.fresh-epoch-bootstrap/v1` containing only desired
  settings and repository registrations, with its exact checksum pinned for
  candidate and normal startup;
- operator hook programs for observed-precondition verification, candidate
  start, ordinary smoke, structured smoke, ingress reopen, candidate stop, and
  old-tuple restore, including each exact executable SHA-256 and required parent
  environment allowlist.

Keep the old image, snapshot, database, and blobs until the candidate is
accepted. Do not reuse the old paths for the fresh epoch.

Build and verify the candidate before the maintenance window:

```bash
npm ci --prefix contracts && npm ci --prefix supervisor
npm run typecheck --prefix contracts && npm run build --prefix contracts
npm run typecheck --prefix supervisor && npm run build --prefix supervisor
npm test --prefix supervisor -- \
  src/persistence/offline-replacement.test.ts \
  src/persistence/fresh-epoch.test.ts \
  src/persistence/blob-store.test.ts \
  scripts/offline-replace.test.mjs \
  scripts/deploy-workflow.test.mjs
node supervisor/scripts/offline-replace.mjs --help
```

Run the full repository gate in `AGENTS.md` before touching the live volume:
both Bats suites, both image builds, the sandbox smoke, kernel sandbox E2E, and
structured walking skeleton. These local/stubbed proofs do not prove live
publication, trusted provider wait, semantic-remediation efficacy,
provider-backed cleanup, or epoch acceptance. The canaries below own those
claims.

## 0. Close normal deployment

Set the GitHub repository variable `FRESH_EPOCH_READY` to `false` (or remove it)
and verify the `deploy` job is skipped. The workflow accepts only the exact
string `true`. Keep this gate closed throughout replacement and evidence review;
snapshot builds may run, but no normal supervisor deploy may start.

## 1. Close ingress

Close mutating ingress with the deploy token:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $OT_DEPLOY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "$OT_SUPERVISOR_URL/maintenance/close" | tee maintenance-close.json
```

Record the returned fence version. Provider webhooks must now receive a
retryable `503` with `acknowledge:false`; they must not be persisted or manually
copied across epochs.

## 2. Settle or abandon every live lifecycle

```bash
curl -fsS \
  -H "Authorization: Bearer $OT_DEPLOY_TOKEN" \
  "$OT_SUPERVISOR_URL/maintenance/active-work?limit=2000" \
  | tee active-work.json
```

The report must name every live Attempt, result correction, Effect, lease, and
runtime resource. For each entry, either:

- let it reach a terminal state; or
- explicitly abandon this dogfood work and record the decision.

Every runtime resource requires verified cleanup evidence. An operator note or
agent statement is insufficient. Repeat the report until no undisposed item
remains.

## 3. Stop every old writer

Stop all Fly supervisor Machines and any separate workers. Verify:

- no Machine for the old release is started;
- no maintenance or worker process holds the database;
- no WAL writer or storage lock remains;
- the volume is detached before attaching the maintenance Machine.

Capture commands and machine IDs as maintenance evidence. Do not run the
replacement command through `flyctl ssh` into an active supervisor: that would
make its own no-writer assertion false.

## 4. Create the one-shot manifest

`supervisor/scripts/offline-replace.mjs` accepts one absolute path to a bounded
JSON file. The root has exactly `replacement` and `commands`. Each of the seven
commands is an exact object with an absolute executable, lowercase SHA-256,
bounded arguments, and an explicit parent-environment allowlist. It is never a
shell string. Each helper writes one JSON object to stdout.

```json
{
  "replacement": {
    "schema": "openthrottle.offline-replacement/v1",
    "maintenance": {
      "ingress_closed": true,
      "supervisors_stopped": true,
      "workers_stopped": true,
      "storage_lock_absent": true,
      "evidence": [
        "maintenance fence version 7",
        "Fly Machines stopped: 01ABC...",
        "volume vol_ABC detached"
      ]
    },
    "active_work": [
      {
        "id": "attempt-example",
        "kind": "attempt",
        "status": "canceled",
        "disposition": "terminal",
        "resource_cleanup": "not_applicable"
      },
      {
        "id": "sandbox-example",
        "kind": "runtime_resource",
        "status": "abandoned",
        "disposition": "abandoned",
        "resource_cleanup": "verified"
      }
    ],
    "old": {
      "release_id": "old-release-id",
      "runtime_capability_digest": "<old-lowercase-sha256>",
      "database_path": "/data/openthrottle.db",
      "blob_root": "/data/openthrottle-blobs",
      "archive_root": "/data/archive/old-release-id"
    },
    "fresh": {
      "release_id": "openthrottle-execution-kernel/v1",
      "runtime_capability_digest": "<fresh-lowercase-sha256>",
      "database_path": "/data/epochs/kernel-v1.sqlite",
      "blob_root": "/data/epochs/kernel-v1-blobs",
      "blob_store_id": "openthrottle-execution-kernel-v1",
      "bootstrap": {
        "schema": "openthrottle.fresh-epoch-bootstrap/v1",
        "settings": [],
        "repository_registrations": [],
        "checksum": "<canonical-bootstrap-sha256>"
      }
    },
    "report_path": "/data/reports/kernel-v1-replacement.json"
  },
  "commands": {
    "verify_preconditions": {
      "executable": "/data/maintenance/verify-preconditions",
      "sha256": "<lowercase-sha256>",
      "args": [],
      "inherit_env": ["FLY_APP"]
    },
    "start_candidate": {
      "executable": "/data/maintenance/start-candidate",
      "sha256": "<lowercase-sha256>",
      "args": [],
      "inherit_env": ["FLY_APP"]
    },
    "smoke_ordinary": {
      "executable": "/data/maintenance/smoke-ordinary",
      "sha256": "<lowercase-sha256>",
      "args": [],
      "inherit_env": ["FLY_APP"]
    },
    "smoke_structured": {
      "executable": "/data/maintenance/smoke-structured",
      "sha256": "<lowercase-sha256>",
      "args": [],
      "inherit_env": ["FLY_APP"]
    },
    "reopen_ingress": {
      "executable": "/data/maintenance/reopen-ingress",
      "sha256": "<lowercase-sha256>",
      "args": [],
      "inherit_env": ["FLY_APP"]
    },
    "stop_candidate": {
      "executable": "/data/maintenance/stop-candidate",
      "sha256": "<lowercase-sha256>",
      "args": [],
      "inherit_env": ["FLY_APP"]
    },
    "restore_old": {
      "executable": "/data/maintenance/restore-old",
      "sha256": "<lowercase-sha256>",
      "args": [],
      "inherit_env": ["FLY_APP"]
    }
  }
}
```

Use real IDs and include every active-work disposition; an empty array is valid
only when the final active-work report is empty. Generate the bootstrap through
the contract helper so its checksum covers the canonical content. Do not fill a
checksum by hand.

`verify_preconditions` must observe live state after the old writers have been
stopped and bind that observation to the exact old tuple:

```json
{
  "old_release_id": "old-release-id",
  "old_runtime_capability_digest": "<old-lowercase-sha256>",
  "database_path": "/data/openthrottle.db",
  "blob_root": "/data/openthrottle-blobs",
  "ingress_closed": true,
  "active_work_clear": true,
  "supervisors_stopped": true,
  "workers_stopped": true,
  "evidence": "bounded exact evidence"
}
```

The command also acquires an exclusive SQLite lock before archiving. Manifest
booleans are declarations; neither they nor a stale active-work report replace
this observed precondition.

Candidate start/stop and ingress-reopen hook output contracts are:

```json
{"evidence":"bounded exact evidence"}
```

The two smoke hooks instead return:

```json
{"id":"disposable-work-id","status":"passed","evidence":"bounded exact evidence"}
```

`restore_old` returns the exact restored tuple and archive identity:

```json
{
  "old_release_id": "old-release-id",
  "old_runtime_capability_digest": "<old-lowercase-sha256>",
  "database_path": "/data/openthrottle.db",
  "blob_root": "/data/openthrottle-blobs",
  "archive_manifest_digest": "<archive-manifest-sha256>",
  "evidence": "bounded exact evidence"
}
```

Before any hook runs, the loader verifies every executable is a normalized
absolute nonsymlink regular executable and that its bytes match `sha256`; it
repeats that verification immediately before each spawn. A hook receives only
parent values named in `inherit_env`, plus executor-owned
`OT_OFFLINE_REPLACEMENT_OPERATION`; rollback hooks also receive
`OT_OFFLINE_REPLACEMENT_REASON`. Reserved names cannot appear in `inherit_env`,
and no other parent secret or variable is copied. Hooks never pass through a
shell parser. The executor applies a two-hour per-hook deadline by default;
`OT_OFFLINE_REPLACEMENT_HOOK_TIMEOUT_MS` may pin another value from 100 through
86400000 milliseconds without changing the authenticated manifest. A timed-out
hook is terminated as one detached process group with `SIGTERM`, then always
completes a `SIGKILL` and process-group-quiescence phase before rollback
proceeds, even when the hook leader exits during the grace period.

## 5. Run from a maintenance Machine

Use the pinned candidate image in a one-off Machine that exclusively mounts the
stopped volume. Override the image command so the supervisor service does not
start automatically. The command is conceptually:

```bash
OT_OFFLINE_REPLACEMENT_HOOK_TIMEOUT_MS=7200000 \
  node /app/scripts/offline-replace.mjs \
    /data/maintenance/offline-replacement.json
```

The supervisor image includes this exact `/app/scripts/offline-replace.mjs`
entrypoint and its sibling `/app/dist` implementation.

Fly's one-off Machine must have restart policy `no` and must be destroyed after
the command exits so the volume can attach to the normal app Machine. Verify the
exact `fly machine run` flags against the installed `flyctl` version before the
window; volume name/ID, app, and region are operator-specific.

The replacement command will:

1. revalidate the manifest and require distinct non-root paths;
2. observe the exact old tuple, closed ingress, clear active work, and stopped
   writers, then acquire an exclusive old-database lock;
3. take a SQLite backup of the old database;
4. run `integrity_check` and `foreign_key_check`;
5. copy and hash the old blob tree;
6. atomically publish a checksum-bound archive manifest;
7. initialize the fresh twelve-table database and BlobStore at absent paths,
   including the executor-owned mutable maintenance fence set to `true`;
8. verify release, schema, store, and bootstrap identities;
9. start the candidate in the maintenance context;
10. run distinct named ordinary and structured smokes;
11. durably write a checksum-bound `ready_to_reopen` report;
12. have the reopen hook compare-and-set that exact maintenance fence from
    `true` to `false`, then atomically replace the ready report with a
    `completed` report whose `ready_report_digest` binds the pre-reopen report.

The candidate start hook launches the supervisor against the fresh paths with
`OT_EPOCH_BOOTSTRAP_CHECKSUM` set to the exact manifest bootstrap checksum and
the initialized maintenance fence still closed. It must observe that fence
before reporting the candidate started. The ordinary and structured hooks are
the first and only canary pair for this replacement; do not create an ambiguous
second pair after `ready_to_reopen`.

Each canary starts from a scoped real Linear/GitHub work item and must:

- produce an operator-accepted change;
- pass the configured commands and an inspect-only review;
- publish the exact accepted subject and satisfy every sealed GitHub
  trusted-producer observation;
- record every manual intervention;
- prove cleanup of both admission and promoted-run runtime resources; and
- return bounded evidence that binds those facts into the ready report.

Give the structured item at least two dependency-independent units and select
multiple review personas. The complete frontiers execute serially in this
release. Across the pair, deliberately exercise one result-shape correction
that retains its exact Attempt/session and one semantic rejection that creates
a distinct edit remediation Attempt with a fresh native session.

## 6. Promote the fresh paths

After the command returns `status:"completed"`:

1. verify the report digest independently;
2. destroy the one-off maintenance Machine;
3. inspect and accept the canary deliverables, trusted-provider observations,
   interventions, and cleanup evidence bound by the ready-report digest;
4. configure `DATABASE_PATH`, `OT_BLOB_STORE_PATH`, `OT_BLOB_STORE_ID`,
   `OT_EPOCH_RELEASE_ID`, `OT_EPOCH_BOOTSTRAP_CHECKSUM`, and
   `DAYTONA_SNAPSHOT` for the exact candidate tuple;
5. set `FRESH_EPOCH_READY` to the exact string `true` and run the normal deploy
   workflow, which uses `--ha=false` and converges to one Machine;
6. verify exactly one normal app Machine exists and the sole
   `openthrottle_data` volume is attached to it;
7. verify `/healthz`, `/capabilities`, both smoke run projections, and zero live
   runtime resources;
8. retain the old archive and image for diagnosis and explicit rollback.

Subsequent commits use the normal direct deployment workflow.

## Rollback

If archive creation, initialization, candidate start, or either smoke fails,
the command invokes `stop_candidate` before `restore_old`, writes a
checksum-bound `status:"rolled_back"` report, and exits nonzero. It never
claims restoration if candidate stop or old-tuple restore fails: the report is
`status:"rollback_failed"` with the exact failure and requires operator repair.

Once `ready_to_reopen` is durable, a reopen failure does not roll back behind
the operator's back. The ready report remains intact and the command exits with
an operator-resolution error; repair ingress, independently verify the ready
report, then complete or explicitly roll back the exact tuple.

Then:

1. set `FRESH_EPOCH_READY` to `false` (or remove it) and verify the normal deploy
   job cannot start;
2. verify every candidate writer is stopped;
3. archive candidate storage separately for diagnosis;
4. destroy the maintenance Machine;
5. reattach the volume to the exact old release configured for the old database,
   blob root, and Daytona snapshot;
6. verify the old archive manifest, runtime-capability digest, and restored
   health;
7. reopen old ingress only after the release/storage tuple matches;
8. manually close disposable smoke branches, issues, or pull requests.

Never import a fresh-epoch row into old storage and never point the old release
at the new database. A rollback restores the tuple; it does not translate it.

## Stop conditions

Stop immediately on any of the following:

- a live writer, storage lock, or attached volume owner;
- an undisposed lifecycle or runtime resource without cleanup proof;
- failed SQLite integrity/foreign-key checks;
- unsafe path, symlink, nonempty fresh path, or mixed storage identity;
- archive hash mismatch or corrupt blob;
- candidate release/runtime capability mismatch;
- duplicate/conflicting Record or Effect identity;
- unknown external-effect outcome;
- Git subject mismatch;
- failed ordinary or structured smoke;
- candidate cleanup failure.

Do not bypass these checks because the installation has no external users. The
absence of users permits downtime and abandonment; it does not make mixed state
recoverable.
