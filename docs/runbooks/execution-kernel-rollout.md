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
  settings and repository registrations;
- operator hook programs for observed-precondition verification, candidate
  start, ordinary smoke, structured smoke, ingress reopen, candidate stop, and
  old-tuple restore.

Keep the old image, snapshot, database, and blobs until the candidate is
accepted. Do not reuse the old paths for the fresh epoch.

Build and verify the candidate before the maintenance window:

```bash
npm ci --prefix contracts && npm ci --prefix supervisor
npm run typecheck --prefix contracts && npm run build --prefix contracts
npm run typecheck --prefix supervisor && npm run build --prefix supervisor
npm test --prefix supervisor -- \
  src/persistence/offline-replacement.test.ts \
  src/persistence/epoch-database.test.ts \
  src/persistence/blob-store.test.ts
```

Run the full repository gate as described in `AGENTS.md` before touching the
live volume.

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
JSON file. The root has exactly `replacement` and `commands`. Commands are argv
arrays, not shell strings, and each helper writes one JSON object to stdout.

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
      "database_path": "/data/openthrottle.db",
      "blob_root": "/data/openthrottle-blobs",
      "archive_root": "/data/archive/old-release-id"
    },
    "fresh": {
      "release_id": "openthrottle-execution-kernel/v1",
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
    "verify_preconditions": ["/data/maintenance/verify-preconditions"],
    "start_candidate": ["/data/maintenance/start-candidate"],
    "smoke_ordinary": ["/data/maintenance/smoke-ordinary"],
    "smoke_structured": ["/data/maintenance/smoke-structured"],
    "reopen_ingress": ["/data/maintenance/reopen-ingress"],
    "stop_candidate": ["/data/maintenance/stop-candidate"],
    "restore_old": ["/data/maintenance/restore-old"]
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

All other non-smoke hook output contracts are:

```json
{"evidence":"bounded exact evidence"}
```

The two smoke hooks instead return:

```json
{"id":"disposable-work-id","status":"passed","evidence":"bounded exact evidence"}
```

Hooks inherit `OT_OFFLINE_REPLACEMENT_OPERATION`; rollback hooks also receive
`OT_OFFLINE_REPLACEMENT_REASON`. They must not accept untrusted manifest values
through a shell parser.

## 5. Run from a maintenance Machine

Use the pinned candidate image in a one-off Machine that exclusively mounts the
stopped volume. Override the image command so the supervisor service does not
start automatically. The command is conceptually:

```bash
node /app/scripts/offline-replace.mjs \
  /data/maintenance/offline-replacement.json
```

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
7. initialize the fresh twelve-table database and BlobStore at absent paths;
8. verify release, schema, store, and bootstrap identities;
9. start the candidate in the maintenance context;
10. run distinct named ordinary and structured smokes;
11. durably write a checksum-bound `ready_to_reopen` report;
12. reopen ingress, then atomically replace it with a `completed` report whose
    `ready_report_digest` binds the pre-reopen report.

The candidate start hook should launch the supervisor against the fresh paths
with public admission still closed. Smoke hooks must exercise real kernel paths,
including edit and inspect authority, semantic normalization/result correction,
Records, Effects, Checkpoints/blobs, publication/provider evidence, and runtime
cleanup.

## 6. Promote the fresh paths

After the command returns `status:"completed"`:

1. verify the report digest independently;
2. destroy the one-off maintenance Machine;
3. configure `DATABASE_PATH`, `OT_BLOB_STORE_PATH`, `OT_BLOB_STORE_ID`,
   `OT_EPOCH_RELEASE_ID`, and `DAYTONA_SNAPSHOT` for the exact candidate tuple;
4. deploy the pinned candidate directly;
5. verify `/healthz`, `/capabilities`, both smoke run projections, and zero live
   runtime resources;
6. retain the old archive and image for diagnosis and explicit rollback.

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

1. verify every candidate writer is stopped;
2. archive candidate storage separately for diagnosis;
3. destroy the maintenance Machine;
4. reattach the volume to the exact old release configured for the old database,
   blob root, and Daytona snapshot;
5. verify the old archive manifest and restored health;
6. reopen old ingress only after the release/storage tuple matches;
7. manually close disposable smoke branches, issues, or pull requests.

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
