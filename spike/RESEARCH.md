# Sprites operational research (open questions §8)

Answers to the plan's §8 questions that don't require a live account, gathered
from public sources (Fly community forum, HN, blog, third-party writeups).

**Confidence caveat:** in this environment every candidate host except
github.com was egress-blocked, so these are derived from **search-engine
snippets** that quote the primary sources, not from direct reads of the forum
threads. Treat as *strong indications to confirm in the live spike*, not
settled fact. Confidence noted per item. Sources are the forum/HN URLs each
snippet came from.

## Q1 — Concurrency: paused sprites and the cap (medium)

There are **two caps, not one**: a *max active* cap and a *max warm* cap
(set to equal numbers per tier). Lifecycle: **active** (running) → **warm**
(paused, resumes in ~ms, stays warm ~a day) → **cold** (long-idle, resumes in
1–2s).

- Paused-but-**warm** does **not** count against the *active* cap — it counts
  against the separate *warm* cap. At the warm limit, the oldest warm sprite is
  evicted to cold.
- **Cold** sprites count against **neither** cap (billed only at cold storage).

**Implication for OpenThrottle:** the binding constraint is the **warm cap** =
tickets whose sprites were touched within ~a day. A ticket idling for days
(waiting on review) goes cold and stops counting. More favorable than the plan's
original "active cap = parallel tickets" framing. The SDK exposes a structured
`concurrent_sprite_limit_exceeded` error code, so this is programmatically
detectable.
Sources: community.fly.io/t/max-warm-sprites-limit/26982,
/sprites-active-sprite-limit-appears-stale/27815, /when-is-a-sprite-actually-cold…/28288.

## Q2 — Checkpoint timing (medium-high on numbers, medium on reliability)

Create ≈ **300ms** (copy-on-write, metadata-only); restore ≈ **~1s**, scaling
with data size (one report ~9s for a large restore). The "10–30s, processes
stop" doc variant is **not** corroborated anywhere.

**But real bugs exist:** threads report sprites becoming unresponsive after an
agent checkpoints, and a reproducible bug where API `restoreCheckpoint` makes the
sprite vanish / 404. So keep checkpointing strictly **off the critical path**
(the plan's D4 already treats v0 as optional).
Sources: fly.io/blog/design-and-implementation, community.fly.io/t/sprite-checkpointing-behavior/27593,
/sprites-become-unusable-when-agents-checkpoint/27678, /checkpoint-restore-causes-sprite-to-vanish/27597.

## Q3 — Memory: not fixed 4 GB (medium)

Design is elastic — bursts to **8 vCPU / up to 16 GB**. But users report the
**practical ceiling is ~8 GB** (two threads flag the 16 GB claim as not actually
available), and a realistic dev workload (server + build + Claude + browser)
inside 8 GB is "very tight" → real OOM risk.

**Implication:** heavier than the plan's "4 GB" assumption in the good direction,
but 8 GB practical is still a real ceiling for big repo builds — measure in the
spike.
Sources: fly.io/sprites, community.fly.io/t/more-ram-in-sprites/26921,
/16gb-ram-advertised-for-sprites-but-not-actually-available/28123.

## Q4 — Sudo hardening (low-medium; third-party evidence only)

No official Fly guidance on removing/hardening sudo. The one serious hardening
project (`canyonroad/agentsh-sprites`) **deliberately does not touch sudoers** —
it intercepts *around* sudo (ptrace/seccomp/FUSE/eBPF) and confirms platform
compat (`sprite exec`, services) is preserved. Fly's security model is
**Firecracker VM-level isolation** (each sprite = its own hardware-isolated
microVM), not in-guest hardening.

**Implication — revise plan D6:** each ticket already runs in its own microVM,
so the base user's passwordless sudo is far less dangerous than under Daytona's
shared-kernel model. Do **not** default to editing sudoers (unsupported, may
break base-image auto-upgrades / runtime). Rely on: VM isolation (real boundary)
+ run agent work as the non-sudo `agent` user (hook-sealing hygiene) + GitHub
branch protection (outer enforcement). Treat any in-guest hardening as a
separate advanced track.
Sources: github.com/canyonroad/agentsh-sprites, fly.io/blog/design-and-implementation,
community.fly.io/t/sprites-for-multi-tenant-production-agents/26940.

## Q5 — Plan tiers (medium on endpoints, low on middle table)

**8 tiers**, Adventurer **$20/mo (20 concurrent, up from 10 after a restructure)**
→ Mythic **$2,000/mo (2,000)**, plus custom Guild. Middle ~5 tiers not reliably
recovered (e.g. a possible Veteran $50 / 50-concurrent — low confidence).
Usage rates confirmed: **$0.07/CPU-hr, $0.04375/GB-hr RAM, $0 idle**. Storage
**repriced**: cold (object) **$0.02/GB-mo**, hot (NVMe) **$0.50/GB-mo**; **20 GB
cold storage free/mo** org-wide since ~March 2026.
Sources: community.fly.io/t/more-sprites-plans/26857, /cheaper-sprites-storage/26889,
/sprites-cold-storage-allowance/27334, rywalker.com/research/sprites.

## Q6 — Reliability & maturity (medium-high) — the decision-relevant one

Pre-1.0 (`v0.0.1-rc29…rc43`) with a documented pattern of instability through
H1 2026:

- Control-plane outages (Feb 10, Feb 23, Mar 14 2026): create/list/console
  returning 500s. One stress report: **~1-in-5** programmatic sprite creations
  succeeding, rest timing out at create/exec.
- Recurring "sprite unresponsive / unwakeable / hung" threads Feb–Jul 2026, plus
  the checkpoint bugs above.
- Base image shipped **EOL Ubuntu 25.04 for ~2 months** before a user flagged it;
  later moved to 26.04 LTS. New sprites also shipped a deprecated Codex CLI.
- **Development-slowdown signal (June 2026):** no release notes ~1.5 months,
  `sprites-js` untouched ~3 months (consistent with the SDK commit we mined being
  from March), docs repo ~10 commits in 3 months — a sharp contrast to the fast
  Jan–Apr cadence.

**Implication:** this is the strongest argument for caution on a *complete*
one-time switchover onto Sprites right now. It doesn't kill the plan, but it
raises the weight on: keeping the Daytona rollback path valid through cutover
(Phase 4 already does), building create/exec **retry + idempotency** into the
client, and confirming the platform is still actively developed before
committing. Worth an explicit go/no-go conversation.
Sources: community.fly.io/t/sprites-control-plane-down/27105, /trouble-with-sprites-stability/27104,
/are-sprites-still-under-active-development/28085, /ubuntu-25-04-has-been-unsupported…/27314,
news.ycombinator.com/item?id=46561089.

## Q7 — Org-private URL wake + auth (medium; webhooks unknown)

An inbound request wakes the sprite (warm or cold) and routes to the http
service. In default `sprite` (org-private) mode: a **human in a browser is
prompted to log in with their Fly.io account** (SSO-style); programmatic clients
send `Authorization: Bearer <org token>`. Flip to `public` for no-auth.

**Implication for D7 (preview):** confirms "click the dev-server link later and
it wakes" — *for an org member logged into Fly*. External senders (GitHub/Stripe
webhooks) can't complete a Fly login or attach a bearer, so org-private URLs are
structurally unsuitable as webhook targets — those would need `public` + your own
auth. Fine for human preview; not for external callbacks.
Sources: community.fly.io/t/how-to-access-non-public-sprite-urls/26779,
/how-do-i-expose-my-sprite-as-a-url/26908.
