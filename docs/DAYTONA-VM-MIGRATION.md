# Daytona container → stronger-isolation (VM / Kata) migration plan

Status: proposed. This is the **alternative to the Sprites switchover (PR #22)**.
The conclusion of the Daytona-vs-Sprites re-evaluation (see git history / the PR
discussion) is that most of the Sprites rationale — persistence, pay-when-active,
auto-lifecycle — is *already* true on Daytona, and Daytona additionally has
**fork** (confirmed) and more maturity. What we were actually missing was that
we ran Daytona's **default container tier** (shared-kernel Docker), not its
stronger-isolation options. This plan upgrades that **without a provider
migration** and unlocks fork for the golden-image optimization.

Baseline to branch from: **`main`** (Daytona *container* + the #21 pipeline).
The Sprites branch (`claude/daytona-fly-sprites-comparison-n0nxwh`, PR #22) is
shelved, not merged. Everything below is a small delta on the existing,
proven Daytona code — the `daytona.ts` adapter, the entrypoint, the poll-based
event model, preview, autostop, and raw-git-in-the-sandbox all stay.

## The decision that sets the effort: Kata/Sysbox vs full VM

Daytona offers strong isolation two ways, and they cost very different amounts
of work:

| Option | What it gives | Effort | Fork? |
|---|---|---|---|
| **Kata / Sysbox** enhanced-isolation containers | microVM-grade isolation on the container path; keeps the Dockerfile snapshot flow | **Small** — likely a create-time class/flag | No (fork is VM-only) |
| **Full VM sandboxes** | dedicated Linux VM; **required for fork** | **Moderate** — VM snapshots (built differently), slower boot | **Yes** |

So the first thing the spike settles is which we need:

- **Isolation is the goal, fork is optional at our scale** → **Kata/Sysbox** is
  probably enough and is the smaller change. (We already agreed per-ticket
  provisioning is fine at low volume, so fork's golden-image saving is a
  nice-to-have, not a driver.)
- **We want fork now** (per-repo golden image, the "snapshot the repo at init"
  idea) → **full VM**.

Recommendation: **start with Kata/Sysbox for isolation** (small, low-risk),
and treat **full VM + fork** as a separate follow-on only if provisioning
latency becomes a real pain.

## What we know (and the specifics to confirm)

Confirmed from docs:
- Daytona `create` is snapshot-based (`daytona.create({ snapshot })`), default =
  **container**. Our `createForTicket` already uses this.
- Snapshots build **from a Dockerfile** (`Image.fromDockerfile`, what
  `build-snapshot.mjs` already does) or a base image, with `--cpu/--memory/--disk`
  resource defaults and a declarative builder that builds off your compute.
- **Kata/Sysbox** are the documented enhanced-isolation options on containers.
- **Full VM** sandboxes exist but "can currently only be created from existing
  VM snapshots," and are what **fork** requires.
- Pricing (container tier): ~$0.128/vCPU-hr active, ~$0.0212/GB-hr memory,
  $0.023/GB-mo snapshots, per-second, pay-when-active. VM/bare-metal boots in
  ~2s (vs container sub-90ms) and likely costs more.

## Phase 0 — Spike (gates the effort; ~half a day, live Daytona)

Answer, on a real Daytona account:
1. **Isolation mechanism**: exact SDK/create shape to get **Kata/Sysbox**
   isolation on our container create (a `class`/`resources`/isolation param on
   `daytona.create`?). Confirm our existing Dockerfile snapshot works unchanged
   under it.
2. **If we want fork**: how a **VM snapshot** is built (from our
   `sandbox/Dockerfile`? a base VM image + provision? a snapshot of a running
   sandbox?), the create-VM API, and the **`fork`** API shape.
3. **Feature parity** under the chosen tier: `fs.uploadFile/setFilePermissions`,
   `process.createSession/executeSessionCommand/getEntrypointLogs`,
   `getSignedPreviewUrl`, `setAutostopInterval`, and label-based `list` all
   behave identically (these are the entire `daytona.ts` surface).
4. **Latency + cost**: VM/Kata create + resume time (tune our `start(60)`
   timeouts), and the price delta vs container.

Output: which tier (Kata vs VM), the exact create/snapshot API, and a go.

## Phase 1 — Snapshot + adapter (small)

- **`build-snapshot.mjs`**: if Kata/Sysbox — likely **no change** (same
  Dockerfile snapshot; isolation is a runtime property). If full VM — build a
  VM snapshot per the Phase-0 finding (the one real unknown; may reuse the
  Dockerfile or need a VM-image step).
- **`daytona.ts` `createForTicket`**: add the isolation class/flag (Kata) or
  point at the VM snapshot (VM) on the existing `daytona.create({...})` call.
  This is the primary code change — a few lines.
- **`config.ts`**: reuse `DAYTONA_SNAPSHOT`; add an optional
  `DAYTONA_SANDBOX_CLASS` (or VM snapshot name) if needed. Minimal.

## Phase 2 — CI / deploy / verify (small)

- **`deploy.yml`**: the snapshot job builds the same (Kata) or VM snapshot per
  Phase 1. Likely unchanged for Kata.
- **Timeout tuning**: bump `start()`/resume timeouts if VM boot (~2s) needs it.
- **Verify**: the existing supervisor + sandbox test suites stay green (the
  adapter surface is unchanged); run the Docker smoke and a live single-ticket
  drive to confirm the entrypoint, preview, and autostop behave on the new tier.

## Phase 3 — (Optional, later) Fork-based per-repo golden

Only if full VM is chosen and provisioning latency is worth optimizing:
- At `init` (or lazily on first ticket), build a **per-repo golden VM sandbox**:
  toolchain + repo clone + deps. Snapshot/keep it.
- Per ticket, **`fork`** the golden → the ticket sandbox starts with repo+deps
  present; entrypoint just `git fetch`es to the current base and reconciles.
- **Refresh** the golden keyed on base-commit + lockfile hash (it's a cache,
  not a frozen image — see the staleness note in the repo-snapshot discussion).
- Keeps `ot-<ticket>` identity: fork creates a new independent sandbox you label
  per ticket.

## Cutover

Because this is a same-provider tier change, cutover is a normal deploy:
1. Build the new (Kata or VM) snapshot.
2. Deploy the supervisor with the updated create + snapshot name.
3. New tickets provision on the stronger-isolation tier; existing container
   sandboxes drain/close normally.
Rollback = redeploy the previous supervisor + container snapshot name. No data
migration; the two can even coexist during validation via the snapshot name.

## Why this beats merging the Sprites PR (#22)

- **Far less code**: a create-param + snapshot change on proven code, vs the
  multi-workstream provider rewrite #22 was.
- **Keeps what #22 gave up**: the signed-URL click-to-preview (`/preview/:id`),
  the poll event model we already trust, raw-git portability.
- **More mature platform**, and **fork is confirmed** (the golden-image
  optimization #22 couldn't promise on Sprites).
- **Reversible and low-risk**; no bet on a pre-1.0 platform.

Sprites' only remaining edges are single-vendor Fly consolidation and
marginally faster idle-wake — not enough to justify the migration once Daytona's
VM/Kata tier is on the table.

## Risks / open questions (for the spike)

| Risk | Note |
|---|---|
| VM snapshot build path unknown | The one real unknown; Phase 0 Q2. Kata sidesteps it entirely. |
| VM boot ~2s + higher cost | Negligible for our minutes-long runs; confirm cost delta. |
| Feature parity on the new tier | Expected identical (SDK abstracts it); Phase 0 Q3 verifies. |
| Fork golden staleness | Cache keyed on lockfile/base-commit, not a frozen snapshot (Phase 3). |
| Daytona went closed-source (Jun 2026) | Transparency downgrade, not a reliability issue; note for vendor risk. |
