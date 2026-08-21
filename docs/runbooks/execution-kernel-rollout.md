# Fresh epoch initialization and first dogfood

Use this runbook once to start the execution kernel from empty storage. Prior
dogfood state is abandoned, not migrated or restored. Downtime is intentional.
Later releases use the normal serialized deploy workflow.

The supervisor never initializes storage during normal boot. The packaged
one-shot initializer starts from exact absent database and blob paths, verifies
their release identities, and leaves mutating ingress closed. A retry accepts
only its own exact empty BlobStore-only partial or exact bootstrap-only closed
pair and re-emits the same receipt.

## 1. Verify the candidate

Run the complete local proof in [`AGENTS.md`](../../AGENTS.md). At minimum, the
fresh-storage boundary must pass:

```bash
npm run build --prefix contracts
npm run build --prefix supervisor
npm test --prefix supervisor -- \
  src/persistence/fresh-epoch.test.ts \
  src/persistence/blob-store.test.ts \
  src/app/kernel-bootstrap.test.ts \
  scripts/initialize-epoch.test.mjs \
  scripts/rollout-runbook.test.mjs \
  scripts/deploy-workflow.test.mjs
node supervisor/scripts/initialize-epoch.mjs --help
```

Keep the repository variable `FRESH_EPOCH_INITIALIZED` absent or false. This
is a storage-existence prerequisite, not a canary or rollout-approval gate.

## 2. Stop the old writer

Decide that old dogfood work and state are abandoned. Stop all supervisor and
worker processes. A Fly volume can attach to only one Machine, so destroy the
old volume-owning Machine before attaching the volume to the temporary
initializer Machine. Do not copy old rows or blobs into the fresh paths.

The fresh defaults deliberately do not reuse the old database names:

```text
/data/openthrottle-kernel-v1.sqlite
/data/openthrottle-kernel-v1-blobs
```

Both targets must be absent on the first invocation. If initialization is
interrupted, retry the same accepted image and paths: it recovers only an exact
empty BlobStore-only partial or an exact bootstrap-only pair with ingress still
closed at version `0`. It refuses every other existing or partial state, plus
relative, nested, symlinked, cross-volume, or identity-invalid storage.

## 3. Initialize from the accepted image

Use the accepted release manifest from the release workflow, not a checkout
build. Resolve its digest-pinned supervisor image, identify the existing Fly
volume, and give one temporary Machine exclusive access:

```bash
set -euo pipefail
umask 077

export RELEASE_MANIFEST=/absolute/path/to/accepted-release-manifest.json
export FLY_APP=openthrottle-supervisor
export FLY_REGION=sjc
export VOLUME_ID=vol_REPLACE_ME

if [ ! -f "$RELEASE_MANIFEST" ]; then
  echo "Set RELEASE_MANIFEST to the accepted release-manifest.json" >&2
  exit 1
fi
if [[ ! "$VOLUME_ID" =~ ^vol_[a-z0-9]+$ ]]; then
  echo "Set VOLUME_ID to the exact lowercase vol_... ID" >&2
  exit 1
fi

VOLUMES="$(flyctl volumes list --app "$FLY_APP" --json)"
if ! jq -e --arg id "$VOLUME_ID" --arg region "$FLY_REGION" '
  def volume_id: (.id // .ID // "");
  def volume_name: (.name // .Name // "");
  def volume_region: (.region // .Region // "");
  def attached_machine:
    (.attached_machine_id // .attachedMachineId // .AttachedMachineId // "");
  type == "array" and
  ([.[] | select(volume_name == "openthrottle_data")] as $named |
    ($named | length) == 1 and
    ($named[0] |
      volume_id == $id and
      volume_region == $region and
      attached_machine == ""))
' <<<"$VOLUMES" >/dev/null; then
  echo "VOLUME_ID must be the sole detached openthrottle_data volume in $FLY_REGION" >&2
  jq . <<<"$VOLUMES" >&2 || true
  exit 1
fi

export SUPERVISOR_IMAGE="$(
  jq -er '
    .supervisorImage
    | select(type == "string" and test("^[^@\\s]+@sha256:[a-f0-9]{64}$"))
  ' "$RELEASE_MANIFEST"
)"
export INIT_MACHINE="ot-epoch-init-$(date -u +%Y%m%d%H%M%S)"

flyctl machine run "$SUPERVISOR_IMAGE" \
  --app "$FLY_APP" \
  --region "$FLY_REGION" \
  --name "$INIT_MACHINE" \
  --restart no \
  --detach \
  --volume "$VOLUME_ID:/data" \
  node /app/scripts/initialize-epoch.mjs

INIT_MACHINE_ID="$(
  flyctl machines list --app "$FLY_APP" --json | jq -er --arg name "$INIT_MACHINE" '
    [.[] | select((.name // .Name // "") == $name) | (.id // .ID // empty)]
    | if length == 1 then .[0] else error("expected exactly one initializer Machine") end
  '
)"
flyctl machine wait "$INIT_MACHINE_ID" \
  --app "$FLY_APP" --state stopped --wait-timeout 5m
```

Capture only this Machine's logs and require exactly one valid initializer
receipt before deleting it. Re-running `logs --no-tail` replaces the local
snapshot rather than appending duplicates:

```bash
FLY_LOGS="$(mktemp)"
RECEIPT_CANDIDATES="$(mktemp)"

for attempt in $(seq 1 15); do
  flyctl logs --app "$FLY_APP" --machine "$INIT_MACHINE_ID" \
    --no-tail --json >"$FLY_LOGS"
  jq -Rsc '
    [split("\n")[] | fromjson? | (.message // .Message // empty) | fromjson?
      | select(.schema == "openthrottle.fresh-epoch-initialization/v1")]
  ' "$FLY_LOGS" >"$RECEIPT_CANDIDATES"
  [ "$(jq 'length' "$RECEIPT_CANDIDATES")" -eq 1 ] && break
  sleep 2
done

jq -e '
  def sha256: type == "string" and test("^[a-f0-9]{64}$");
  if length != 1 then error("expected exactly one initializer receipt") else .[0] end
  | if (
      .schema == "openthrottle.fresh-epoch-initialization/v1" and
      .database_path == "/data/openthrottle-kernel-v1.sqlite" and
      .blob_store_path == "/data/openthrottle-kernel-v1-blobs" and
      .blob_store_id == "openthrottle-execution-kernel-v1" and
      .release_id == "openthrottle-execution-kernel/v1" and
      (.blob_marker_checksum | sha256) and
      (.runtime_capability_digest | sha256) and
      (.bootstrap_checksum | sha256) and
      (.schema_checksum | sha256) and
      .schema_version == 1 and .maintenance_ingress_closed == true and
      .integrity == "ok"
    ) then . else error("initializer receipt identity is invalid") end
' "$RECEIPT_CANDIDATES" >epoch-initialization-receipt.json

flyctl machine destroy --app "$FLY_APP" "$INIT_MACHINE_ID"
rm -f "$FLY_LOGS" "$RECEIPT_CANDIDATES"
```

Retain `epoch-initialization-receipt.json`. It binds the database path, blob
marker, release, runtime-capability digest, bootstrap checksum, schema checksum,
integrity result, and closed maintenance state. If launch, wait, capture, or
validation fails, do not set the deployment prerequisite and do not destroy the
Machine; inspect its exact logs and storage before fixing forward.

Stage the emitted bootstrap checksum for normal open-only startup:

```bash
export OT_EPOCH_BOOTSTRAP_CHECKSUM="$(
  jq -er '.bootstrap_checksum' epoch-initialization-receipt.json
)"
flyctl secrets set --stage --app "$FLY_APP" \
  OT_EPOCH_BOOTSTRAP_CHECKSUM="$OT_EPOCH_BOOTSTRAP_CHECKSUM"
```

Set the GitHub repository variable `FRESH_EPOCH_INITIALIZED` to the exact
string `true`. Leave it true for later releases; it records only that the
one-shot storage boundary has completed.

## 4. Deploy one writer

Run the normal deploy workflow. It uses `--ha=false`, converges to one Machine,
and verifies that the sole `openthrottle_data` volume is attached to that
Machine. Confirm health and the authenticated release identity:

```bash
flyctl machines list --app "$FLY_APP" --json
flyctl volumes list --app "$FLY_APP" --json
flyctl checks list --app "$FLY_APP" --json

curl -fsS -H "Authorization: Bearer $OT_STATUS_TOKEN" \
  "https://$FLY_APP.fly.dev/capabilities"
curl -fsS -H "Authorization: Bearer $OT_DEPLOY_TOKEN" \
  "https://$FLY_APP.fly.dev/maintenance"
```

Maintenance must still be closed at version `0`. Normal boot must fail rather
than create storage if any schema, release, runtime, bootstrap, or blob identity
does not match.

## 5. Register, open ingress, and dogfood

Register the repository while maintenance remains closed. Then open ingress
with the exact observed maintenance version:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $OT_DEPLOY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"expected_version":0}' \
  "https://$FLY_APP.fly.dev/maintenance/open"
```

Submit one real, scoped bug-fix ticket. Treat failures as dogfood findings and
fix them forward. Local harnesses do not claim to prove live publication,
provider evidence, semantic remediation, or terminal provider cleanup; real
items exercise those boundaries.

If deployment fails before ingress opens, keep maintenance closed, inspect the
exact receipt/storage identity, and repair or redeploy. There is no archive,
restore hook, replacement report, prescribed canary pair, dual-write path, or
durable cutover state machine.
