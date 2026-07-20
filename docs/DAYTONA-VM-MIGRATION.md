# Daytona container → VM migration plan

Status: proposed. This is the **alternative to the Sprites switchover (PR #22)**,
and the chosen direction: stay on Daytona, but move sandboxes from the default
**container** tier (shared-kernel Docker) to the **VM** tier.

Two reasons to go VM specifically (not the lighter Kata/Sysbox isolation option):
1. **Isolation** — a dedicated Linux VM (own kernel) for agent code that carries
   repo + model credentials.
2. **Fork** — fork is **VM-only**, and it's what unlocks the "provision the
   toolchain/repo once, fork per ticket" optimization (the golden-image /
   per-repo-snapshot idea). Going VM is the prerequisite for that payoff.

Baseline to branch from: **`main`** (`dd468a1` — Daytona *container* + the #21
two-loop / feedback-as-resume pipeline). The Sprites branch
(`claude/daytona-fly-sprites-comparison-n0nxwh`, PR #22) is **shelved, not
merged**. This is a small-to-moderate delta on the existing, proven Daytona code:
the `daytona.ts` adapter surface, the entrypoint, the **poll** event model,
`/preview/:id`, autostop, and raw-git-in-the-sandbox all stay. The only real
change is *what kind of snapshot/sandbox we create*.

## What changes vs what stays

**Changes (VM):**
- The snapshot becomes a **VM snapshot** (today `build-snapshot.mjs` builds a
  container image snapshot from `sandbox/Dockerfile`).
- `createForTicket` creates a **VM sandbox** from that snapshot (VM sandboxes
  "can currently only be created from existing VM snapshots").
- Start/resume timeouts tuned for VM boot (~2s vs container sub-90ms).

**Stays (unchanged):**
- `daytona.ts` surface (`fs`, `process`, `exec`, `getSignedPreviewUrl`,
  `setAutostopInterval`, label-based `list`), the entrypoint's 8 phases + raw
  git/gh, the 5s **poll** event model, `/preview/:id` signed URL, the #21
  pipeline, and the whole supervisor control plane.

## The one real unknown (the spike pivot)

**How Daytona builds a VM snapshot.** Container snapshots build from a
Dockerfile (`Image.fromDockerfile`, what we do now). VM snapshots are a distinct
artifact — the docs say they "can only be created from existing VM snapshots,"
but don't spell out the *build* path. The three candidates the spike must settle:
1. Build a VM snapshot directly from our `sandbox/Dockerfile` (best case — a
   near drop-in change to `build-snapshot.mjs`).
2. Start from a Daytona **base VM snapshot**, run our provisioning into it, then
   snapshot that (a provision-then-snapshot flow — moderate; we'd adapt the
   Dockerfile steps into a provisioning script run against a base VM).
3. Snapshot a running/prepared VM sandbox into a reusable VM snapshot.

This determines whether Phase 1 is "trivial" or "moderate." Everything else is
low-risk.

## Phase 0 — Spike (gates the effort; ~half a day, live Daytona)

On a real Daytona account, confirm:
1. **VM snapshot build path** — which of the three above; whether our
   `sandbox/Dockerfile` is reusable, or we need a base-VM + provision step.
2. **Create-VM API** — the exact `daytona.create({...})` shape for a VM sandbox
   (the v0.21+ image-vs-snapshot param split; any `class`/VM flag).
3. **`fork` API** — `sandbox.fork()` / the CoW-clone call, independence, fork-tree
   behavior (needed for Phase 4).
4. **Feature parity** — `fs.uploadFile/setFilePermissions`,
   `process.createSession/executeSessionCommand/getEntrypointLogs`,
   `getSignedPreviewUrl`, `setAutostopInterval`, label `list` all behave
   identically on VM sandboxes (this is the entire adapter surface).
5. **Latency + cost** — VM create/resume time (to tune `start(60)` timeouts) and
   the VM price delta vs container.

Output: the VM-snapshot build recipe, the create-VM + fork API shapes, and a go.

## Phase 1 — VM snapshot build

- Rework `supervisor/scripts/build-snapshot.mjs` to produce a **VM snapshot** per
  the Phase-0 recipe. If path (1): swap the snapshot-create call to the VM
  variant, keep `sandbox/Dockerfile`. If path (2/3): add a base-VM + provision
  step (the Dockerfile install steps become a provisioning script run into a
  base VM, then snapshot). This is the primary work + the only real unknown.
- Keep the snapshot **commit-pinned** (`openthrottle-v2-ce-<sha>`) and the CI
  `snapshot` job that stages `DAYTONA_SNAPSHOT`.

## Phase 2 — Adapter + config + deploy (small)

- **`supervisor/src/daytona.ts` `createForTicket`** — create a VM sandbox from
  `cfg.daytonaSnapshot` (VM snapshot), adding whatever VM `class`/param Phase 0
  found. A few lines; everything else in the adapter is untouched.
- **`config.ts`** — reuse `DAYTONA_SNAPSHOT` (now a VM snapshot name); add
  `DAYTONA_SANDBOX_CLASS`/VM flag only if the API requires it.
- **Timeouts** — bump `start()`/resume waits for VM boot (~2s) where needed.
- **`deploy.yml`** — the snapshot job builds the VM snapshot (Phase 1); otherwise
  unchanged.

## Phase 3 — Verify

- Supervisor + sandbox + CLI test suites stay green (the adapter *surface* is
  unchanged, so the DI-fake tests don't move).
- Run the Docker smoke (still validates provisioning logic) + a **live
  single-ticket drive** on VM: create → entrypoint (clone/branch/push) → agent →
  PR → `/preview/:id` wake → autostop → resume → PR-close deletes the sandbox.
- Confirm VM isolation + preview + poll events behave on the new tier.

## Phase 4 — Fork-based golden image (the payoff of going VM)

Sequenced after Phase 3 is validated; this is the reason VM was chosen over Kata.

- At `init` (or lazily on first ticket for a repo), build a **per-repo golden VM
  sandbox**: toolchain + repo clone + deps installed. Snapshot/keep it.
- Per ticket, **`fork`** the golden → the ticket sandbox starts with repo+deps
  already present; the entrypoint just `git fetch`es to the current base and
  reconciles. Fork creates a new independent sandbox we label `ot-<ticket>`, so
  per-ticket identity is preserved.
- **Refresh** the golden keyed on base-commit + lockfile hash — it's a *cache*,
  not a frozen image; stale lockfiles fall back to a cold install. Rebuild on
  lockfile change (or lazily / on a schedule).
- Net: near-instant per-ticket start (skips the toolchain install and, when the
  golden is fresh, the clone + deps).

Fork is optional to *ship* — the baseline VM switch (Phases 1–3) is valuable on
its own for isolation — but it's the capability that makes VM worth it over Kata,
so it's planned, not merely deferred.

## Cutover

Same-provider tier change → a normal deploy, and the two tiers can coexist by
snapshot name during validation:
1. Build the VM snapshot.
2. Deploy the supervisor pointing `DAYTONA_SNAPSHOT` at it (+ any VM class flag).
3. New tickets provision on VM; existing container sandboxes drain/close normally.
Rollback = redeploy the previous supervisor + container snapshot name. No data
migration.

## Why this over merging the Sprites PR (#22)

- **Far less code** — a snapshot-build + create-param change on proven code, vs
  the multi-workstream provider rewrite #22 was.
- **Keeps what #22 gave up** — the signed-URL click-to-preview (`/preview/:id`),
  the poll event model we already trust, raw-git portability.
- **More mature platform**, and **fork is confirmed** — the golden-image
  optimization #22 couldn't promise on Sprites (fork-from-checkpoint unconfirmed).
- **Reversible, low-risk**; no bet on a pre-1.0 platform.

## Risks / open questions

| Risk | Note |
|---|---|
| **VM snapshot build path unknown** | The one real unknown; Phase 0 Q1. Pivots Phase 1 between trivial and moderate. |
| VM boot ~2s + higher cost | Negligible latency for our minutes-long runs; confirm the price delta in Phase 0. |
| Feature parity on VM tier | Expected identical (SDK abstracts sandbox type); Phase 0 Q4 verifies before any code. |
| Fork golden staleness | Cache keyed on lockfile/base-commit, cold-install fallback (Phase 4), not a frozen snapshot. |
| Daytona closed-source (Jun 2026) | Transparency downgrade, not a reliability issue; noted for vendor risk. |
