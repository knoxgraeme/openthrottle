# Onboarding release acceptance

This runbook is the live operator acceptance gate for the onboarding
subsystem: the `release.yml` pipeline that produces digest-pinned images plus
the baked CLI release manifest, and the `openthrottle setup` command that
verifies and converges against them. It consumes real operator credentials
(GitHub, Fly, Daytona), so it must be explicitly authorized like the other
credentialed exercises. Do not paste secrets, live tokens, or API keys into
issues, PRs, docs, or command output captures — only secret NAMES ever appear
in evidence.

## Scope and prerequisites

- A workstation with Node 22, Docker (with buildx), `gh` authenticated against
  `knoxgraeme/openthrottle-v2`, and `flyctl`.
- A real Fly org token (`FLY_API_TOKEN`, org-scoped so setup can create apps)
  and a real Daytona API key (`DAYTONA_API_KEY`).
- Use a DEDICATED throwaway Fly app name for this exercise. The CLI's default
  hosting app is `openthrottle-supervisor` — the live deployment. Always
  export `OT_FLY_APP` to an acceptance-only name so this gate never touches
  the production supervisor.
- Mind the Daytona org disk quota (30 GiB total across retained sandboxes and
  snapshots) before creating the acceptance snapshot; delete it in teardown.

## 1. Trigger the release workflow

Either push a `v*` tag (publishes to npm when `NPM_TOKEN` is configured) or
dispatch manually (always degrades to workflow artifacts):

```bash
gh workflow run release.yml --repo knoxgraeme/openthrottle-v2
# optionally: -f release_id=<id>   (defaults to the cli package version)
gh run watch --repo knoxgraeme/openthrottle-v2 "$(gh run list --repo knoxgraeme/openthrottle-v2 \
  --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

The run must end green: image pushes, manifest generation, CLI build,
`npm test --prefix cli`, and the artifact upload are all release gates.

## 2. Make the GHCR packages public (first release only)

GHCR packages are created PRIVATE on first push. Until each image package is
made public once, anonymous pulls of the pinned digests fail — including
`openthrottle setup` runs and runtimes that pull without a GitHub token.

For each of `openthrottle-supervisor` and `openthrottle-sandbox`: GitHub →
your profile → Packages → the package → Package settings → Danger Zone →
Change visibility → Public. This is a one-time step per package; later
releases push new versions into the already-public package.

Prove public visibility from an unauthenticated client:

```bash
docker logout ghcr.io
docker buildx imagetools inspect "$(jq -r .supervisorImage release-manifest.json)"
docker buildx imagetools inspect "$(jq -r .sandboxImage release-manifest.json)"
```

## 3. Verify the digests match the manifest

Download the run's artifact (it contains `cli/release-manifest.json` and the
packed `openthrottle-<version>.tgz`):

```bash
gh run download --repo knoxgraeme/openthrottle-v2 <run-id> \
  --name "openthrottle-release-<release_id>" --dir release-acceptance
jq . release-acceptance/cli/release-manifest.json
```

Check, for both `supervisorImage` and `sandboxImage`:

- the reference is digest-pinned (`ghcr.io/...@sha256:<64 hex>`);
- `docker buildx imagetools inspect <ref>` succeeds and reports the same
  digest as the manifest reference;
- `runtime.descriptorDigest` equals the canonical-JSON sha256 of
  `supervisor/pipelines/runtime-capabilities-v1.json` at the released commit;
- `cliVersion` matches the packed tarball's version.

## 4. Install the packed CLI

Install the exact tarball from the artifact (the same bytes the publish step
ships when npm publication is enabled):

```bash
npm install -g ./release-acceptance/openthrottle-<version>.tgz
openthrottle   # usage banner proves the install
```

A dev checkout build is NOT acceptable here: only the release build carries
the baked `dist/release-manifest.json`, and `openthrottle setup` refuses to
run unpinned.

## 5. Readiness check from a fresh profile (expect needs_action)

Point the profile and secret stores at empty directories so no prior
onboarding state leaks into the evidence, and target the acceptance app:

```bash
export OT_PROFILE_DIR="$(mktemp -d)"
export OT_SECRET_DIR="$(mktemp -d)"
export FLY_API_TOKEN=<org-scoped token>       # or `flyctl auth login`
export DAYTONA_API_KEY=<acceptance key>
export OT_FLY_APP=<acceptance-only app name>  # NEVER the live supervisor app
export OT_FLY_ORG=<fly org>
export OT_FLY_REGION=<region>

openthrottle setup --check
```

Expected: exit code 1, an evidence table with `needs_action` rows, and a
recovery report listing the operator-owned supervisor secrets (for example
`GITHUB_TOKEN`, `GITHUB_READ_TOKEN`, `DAYTONA_API_KEY`, and the agent
credential for the chosen `DEFAULT_AGENT`). `--check` is read-only — confirm
no Fly app, volume, or Daytona snapshot was created.

## 6. Full setup

```bash
openthrottle setup
```

Review the mutation plan before approving it. Setup converges the hosting and
runtime providers against the manifest (acceptance Fly app + `/data` volume,
generated supervisor secrets, and the release snapshot pinned to the
manifest's `sandboxImage`), then hands back the remaining operator-owned
`fly secrets set` steps. Complete those and re-run `openthrottle setup` until
it reports ready.

## 7. Idempotence

Run the full command a second time from the same shell:

```bash
openthrottle setup
```

Expected: it must plan ZERO mutations — no mutation-approval prompt, no
resource creation, exit code 0. Any planned mutation on the second run is an
acceptance failure (non-idempotent converge), not something to approve away.

## 8. Final readiness gate

```bash
openthrottle setup --check
echo $?
```

Expected: every evidence row ready, "Nothing was changed" outro, exit code 0.

## 9. Teardown

The acceptance resources are throwaway; remove them and the local state:

```bash
# Fly: destroying the app also releases its machines and the
# openthrottle_data volume created for it.
flyctl apps destroy "$OT_FLY_APP" --yes
flyctl volumes list --app "$OT_FLY_APP" || true   # must fail: app is gone

# Daytona: delete the acceptance snapshot (openthrottle-<release_id>) from
# the dashboard or API so it stops counting against the org disk quota.

# Local state: remove the fresh profile and secret stores.
rm -rf "$OT_PROFILE_DIR" "$OT_SECRET_DIR"
unset OT_PROFILE_DIR OT_SECRET_DIR OT_FLY_APP OT_FLY_ORG OT_FLY_REGION
```

Finally, revoke or rotate any acceptance-only tokens (the Fly org token and
Daytona API key minted for this exercise), and record the run id, release id,
both image digests, and the exit codes from steps 5, 7, and 8 as the
acceptance evidence.
