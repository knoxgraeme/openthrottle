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
- The snapshot is tagged **`sandboxClass: "linux-vm"`** — the one build-time
  change (today `build-snapshot.mjs` builds a `container`-class snapshot from
  `sandbox/Dockerfile`; same Dockerfile, class tag added).
- `createForTicket` is **unchanged**: it still `create({ snapshot })`s, and the
  sandbox inherits `linux-vm` from the snapshot (VM sandboxes "can currently only
  be created from existing VM snapshots" — satisfied by the class on the snapshot).
- Start/resume timeouts tuned for VM boot where Phase 0 shows it's needed.

**Stays (unchanged):**
- `daytona.ts` surface (`fs`, `process`, `exec`, `getSignedPreviewUrl`,
  `setAutostopInterval`, label-based `list`), the entrypoint's 8 phases + raw
  git/gh, the 5s **poll** event model, `/preview/:id` signed URL, the #21
  pipeline, and the whole supervisor control plane.

## The build path (confirmed from the SDK, v0.199.0)

**Resolved — it's a one-field change.** Reading the published SDK's own type
definitions (`@daytona/sdk@0.199.0` → `@daytona/api-client@0.199.0`) settles what
the docs left implicit:

- The VM tier is **not a `create()` parameter**. `create()` takes only
  `CreateSandboxFromImageParams` / `CreateSandboxFromSnapshotParams`; neither has
  a `class`/VM field.
- The tier is a property of the **snapshot**. `CreateSnapshotParams` (and the
  wire model `CreateSnapshot`) carry `sandboxClass?: SandboxClass`, documented as
  "Determines which runners can host sandboxes created from this snapshot."
- `SandboxClass` is an enum: **`LINUX_VM = "linux-vm"`**, `CONTAINER =
  "container"`, `ANDROID`, `WINDOWS`. The VM tier is literally
  `sandboxClass: "linux-vm"`.

So the "VM snapshot build path" is the best case (old candidate 1): we keep
building the snapshot from our existing `sandbox/Dockerfile`
(`Image.fromDockerfile`, exactly as today) and just add `sandboxClass:
"linux-vm"` to the `snapshot.create()` call. A sandbox created from that snapshot
(`daytona.create({ snapshot })`, unchanged) inherits the VM class. "VM sandboxes
can only be created from existing VM snapshots" is satisfied by the snapshot
carrying the class — there is no separate VM-image artifact to produce.

The remaining live-only questions are small tuning details, not blockers:
whether `linux-vm` supports pausing (`autoPauseInterval` / pay-when-paused) and
the VM boot latency + price delta. Phase 0 shrinks to confirming those.

### Also confirmed from the SDK — relevant to OpenThrottle

- **Native network policy at create()**: `networkBlockAll`, `networkAllowList`
  (CIDRs), `domainAllowList` (domains) — egress lockdown as create params, no
  separate call.
- **Org Secrets**: `secrets?: Record<envName, orgSecretName>` mounts a Secret as
  an opaque placeholder, substituted transparently on outbound calls to the
  Secret's allowed hosts. A cleaner path than injecting raw model/GitHub tokens
  as `envVars` — worth evaluating for credential handling.
- **`linkedSandbox` + `ephemeral`**: co-schedule an ephemeral sandbox on the same
  runner with a private local network — the primitive for the future
  agent-orchestrator / sub-sandbox scratch-compute idea.

None of these are required for the VM switch; they're captured because the
confirmation surfaced them and two map onto earlier design questions.

## Phase 0 — Spike (small now that the API is confirmed; live Daytona)

The build recipe and the create/fork API shapes are settled from the SDK
(above), so the spike only has to confirm runtime behavior on a real account:
1. **Pause economics** — does `linux-vm` support pausing? Set `autoPauseInterval`
   and confirm the sandbox pauses (billed while active, cheap while paused) and
   resumes on `start()`. If `linux-vm` does *not* pause, fall back to
   `autoStopInterval` (stop/start) and note the cold-start cost.
2. **Latency + cost** — VM create/resume time (to tune the `create()`/`start()`
   timeouts, default 60s) and the `linux-vm` price delta vs `container`.
3. **`_experimental_fork`** — exercise `daytona._experimental_fork(sandbox,
   { name })` directly: independence of the fork, fork-tree behavior, and that
   it's stable enough to build Phase 4 on (it's an `_experimental_` API).
4. **Feature parity spot-check** — `fs`, `process`, `getPreviewLink`,
   `setAutostopInterval`, and label `list` on a `linux-vm` sandbox (expected
   identical; the SDK abstracts the class, so this is a confidence check, not a
   discovery).

Output: pause-vs-stop decision, tuned timeouts, the fork go/no-go, and a green
single-run drive on `linux-vm`.

## Phase 1 — VM snapshot build (one field)

- In `supervisor/scripts/build-snapshot.mjs`, add `sandboxClass: "linux-vm"`
  (`SandboxClass.LINUX_VM`) to the existing
  `daytona.snapshot.create({ name, image: Image.fromDockerfile(...) })` call.
  Keep `sandbox/Dockerfile` and the whole build exactly as-is — the only change
  is the class tag on the snapshot.
- Keep the snapshot **commit-pinned** (`openthrottle-v2-ce-<sha>`) and the CI
  `snapshot` job that stages `DAYTONA_SNAPSHOT`. No new artifact type, no
  base-VM/provision detour.

## Phase 2 — Adapter + config + deploy (small)

- **`supervisor/src/daytona.ts` `createForTicket`** — **unchanged.** It already
  calls `daytona.create({ snapshot: cfg.daytonaSnapshot, ... })`; the sandbox
  inherits `linux-vm` from the snapshot, and `create()` has no class param to
  add. (Optional: set `autoPauseInterval` here if Phase 0 confirms pausing.)
- **`config.ts`** — reuse `DAYTONA_SNAPSHOT` (now points at the `linux-vm`
  snapshot). No new class env var — the class rides on the snapshot, not the
  sandbox-create call.
- **Timeouts** — bump `create()`/`start()` waits for VM boot where Phase 0 shows
  it's needed.
- **`deploy.yml`** — the snapshot job builds the `linux-vm` snapshot (Phase 1);
  otherwise unchanged.

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

**Caveat: fork is currently experimental.** The SDK exposes it on the client as
`daytona._experimental_fork(sandbox, { name? }, timeout?): Promise<Sandbox>` — a
top-level `Daytona` method that takes the source `Sandbox` (not a
`sandbox.fork()`), documented as "creating a new Sandbox with an identical
filesystem." The `_experimental_` prefix means the API is not GA and may change
or be unstable. The Phase-0 spike must exercise it directly before Phase 4
commits to it; the baseline VM switch (Phases 1–3, the isolation win) does
**not** depend on fork, so it's safe to ship first and adopt fork only once its
stability is confirmed.

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
| ~~VM snapshot build path unknown~~ **Resolved** | Confirmed from the SDK: `snapshot.create({ …, sandboxClass: "linux-vm" })`, `create()` unchanged. Phase 1 is a one-field change. |
| Pause support on `linux-vm` | `autoPauseInterval` is class-dependent; Phase 0 Q1 confirms whether `linux-vm` pauses (pay-when-paused) or only stops. Tuning, not a blocker. |
| VM boot + higher cost | Negligible latency for our minutes-long runs; confirm the `linux-vm` price delta in Phase 0. |
| Feature parity on VM tier | Expected identical (SDK abstracts sandbox class); Phase 0 Q4 spot-checks before code. |
| **Fork is experimental** (`_experimental_fork`) | Not GA; `daytona._experimental_fork(sandbox, { name })`. Baseline VM switch (Phases 1–3) doesn't depend on it — ship isolation first, adopt fork only after the spike confirms stability. |
| Fork golden staleness | Cache keyed on lockfile/base-commit, cold-install fallback (Phase 4), not a frozen snapshot. |
| Daytona closed-source (Jun 2026) | Transparency downgrade, not a reliability issue; noted for vendor risk. |
