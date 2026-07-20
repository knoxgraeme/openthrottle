# Porting OpenThrottle from Daytona to Fly Sprites

Status: proposed. This is a **complete one-time switchover**, not a dual-provider
migration. Where a structure existed only because Daytona worked a certain way,
this plan replaces the structure with the Sprites-native one instead of porting
it.

Grounded in the official docs at `superfly/sprites-docs` (docs.sprites.dev),
especially the *Claude Managed Agents* integration guide, which is Fly's own
reference implementation of OpenThrottle's exact shape: an always-on worker
that claims queued work and runs each session in a named, persistent,
per-session Sprite.

## 1. Platform facts the design relies on

| Fact | Source |
|---|---|
| A Sprite is a persistent microVM addressed **by name**; create is `POST /v1/sprites {name}` (409 when it exists → reuse), list filters by name **prefix** | API reference |
| Filesystem persists forever (NVMe cache + object storage, synced continuously); memory/processes do not survive a pause | Lifecycle |
| Auto-pause ~30s after activity stops → `warm` (wake 100–500ms, processes intact) → `cold` (wake 1–2s, processes dropped). Not configurable | Lifecycle, Configuration |
| **Tasks API** (`/.sprite/api.sock`, in-sprite): a named hold that keeps the Sprite active; max 1h per task, heartbeat pattern = 5m expiry refreshed every 60s; expires on its own if the holder crashes | Keeping a Sprite Running |
| **Services**: runtime-owned processes, restarted on crash and cold boot; one service may bind the Sprite URL via `http_port`, with start-on-request; manageable from outside via `/v1/sprites/{name}/services` | Services |
| **No custom OCI images.** Managed Ubuntu base image (Node 22, Python, Go, etc. + `claude`, `codex`, `gemini`, `cursor` CLIs preinstalled); base upgrades automatically without touching the overlay | Base Images |
| User inside the sprite is `sprite` **with passwordless sudo** | Base Images |
| Checkpoints: per-sprite filesystem snapshots (`v0`, `v1`, …), restore replaces the overlay. **No fork/create-from-checkpoint across sprites.** Deleting a sprite deletes its checkpoints | Checkpoints, API |
| Files are written from outside via `PUT /v1/sprites/{name}/fs/write?path=…`; commands run via `POST …/exec` (framed output, exit code after a `0x03` frame) or SDK exec/spawn with per-call `env`/`cwd` | Managed-agents guide, JS SDK |
| Sprite URL `https://<name>-<org-id>.sprites.app` is **org-private by default** (`url_settings.auth: "sprite"`), switchable to `public` per sprite; routes to the `http_port` service and wakes on request | Networking, API |
| **Egress network policy**: DNS-based allowlist applied from outside via API, read-only inside the sprite; raw-IP and private-IP dialing blocked under policy | Networking |
| Fixed shape: 8 vCPU, ~4 GB RAM (platform-managed, may autoscale), 100 GB disk. Billing per second, compute+hot-storage only while active; object storage accrues 24/7, including for paused sprites | Lifecycle, Billing |
| Concurrency is plan-capped: pay-as-you-go 3 concurrent sprites; Level 10 $20/mo = 10 concurrent + 450 CPU-hrs / 1,800 GB-hrs / 50 GB included; overage at usage rates (~$0.07/CPU-hr, ~$0.04375/GB-hr) | Billing |
| Auth: one org-scoped `SPRITE_TOKEN` against `https://api.sprites.dev`. JS SDK (`@fly/sprites`) requires **Node 24+** | Configuration, JS SDK |
| Hosted MCP server (`https://sprites.dev/mcp`, OAuth, name-prefix + count-capped tokens) exposes create/exec/checkpoint/policy/services as MCP tools | Remote MCP |

Two doc-level inconsistencies to verify in the spike (§8): checkpoint creation
time ("milliseconds, no interruption" vs "10–30s, processes stop"), and RAM
("fixed 4 GB" vs "platform-autoscaled").

## 2. Structural decisions (what we stop doing, not just re-implement)

Each of these replaces a Daytona-era structure with the Sprites-native one.

### D1. Identity: deterministic names, no labels, no discovery scan

Was: create with `labels {openthrottle, ticket}`, find by label scan, store
`sandbox_id`.

Becomes: the sprite name **is** the key: `ot-<issue-identifier>` lowercased
(validated `[a-z0-9-]`, ≤ 40 chars, collision-checked at delegation). Create is
idempotent (tolerate 409 → reuse), lookup is `GET /v1/sprites/ot-eng-123`,
orphan listing is `prefix=ot-`. The `tickets.sandbox_id` column becomes
`sprite_name` (still stored — it is the audited mapping — but derivable).
`findSandboxForTicket`, label plumbing, and the create/find race handling are
deleted.

### D2. Lifecycle inversion: the sprite holds itself open; the supervisor stops managing lifecycle

Was: supervisor-owned autostop intervals (60m active / 5m idle),
`reconcileSandboxAutostop` retry loops, explicit `start()` before every
interaction, stop/start choreography.

Becomes: the platform pauses on idle and wakes on demand; **the run holds the
sprite open from the inside** with a Task heartbeat (5m expiry, refreshed every
60s by the entrypoint, deleted on exit). A crashed run stops heartbeating and
the sprite frees itself — the crash-safety story the autostop dance was
approximating. `sandbox-lifecycle.ts`, both autostop constants, and every
active/idle transition in `server.ts` are deleted. The supervisor's lifecycle
verbs shrink to two: create (at delegation) and delete (at PR close/expiry).

### D3. Events: push replaces the 5-second poll

Was: agent writes activity/completion records to an on-disk outbox; supervisor
polls every active run through the Daytona SDK every 5s
(`SANDBOX_EVENT_POLL_INTERVAL_MS`), claims events, projects to Linear.

Becomes: `ot-activity` and the completion trap **POST directly to the
supervisor** — `POST /runs/:id/events` (new) and the already-existing
`POST /runs/:id/complete` — authenticated by the run's one-time callback token.
The durable `sandbox_events` idempotency/dedupe layer is kept as the inbox for
pushed events, so Linear projection stays exactly-once and ordered. The on-disk
outbox and completion marker remain as a **local spool fallback**: the
15-minute sweep reconciles any run past its deadline by `exec`-reading the
marker, covering push failures. `sandbox-events.ts` polling and the 5s
interval are deleted; the supervisor makes zero steady-state calls to the
Sprites API while a run executes.

This was the design Daytona forced us away from (the "legacy" callback path in
SPEC §Sandbox activity). Sprites' always-on outbound path makes push the
correct primary again.

### D4. One artifact: the sandbox payload ships inside the supervisor; the snapshot pipeline is deleted

Was: `sandbox/Dockerfile` → CI builds a commit-pinned Daytona snapshot
(`build-snapshot.mjs`, `deploy.yml` staging `DAYTONA_SNAPSHOT`) → snapshot
verified by `setup`/`init` → version skew between supervisor and snapshot is a
managed risk.

Becomes: there is no image to build. The Dockerfile's content is split:

- **Base-image-provided** (dropped from our payload): OS, Node, git, the
  `claude`/`codex` CLIs. We still install our **pinned** agent-CLI versions
  into the overlay at provision time (`npm i -g @anthropic-ai/claude-code@X
  @openai/codex@Y`) so engine versions stay ours, not the base image's.
- **`sandbox/provision.sh`** (new, replaces the Dockerfile): creates the
  non-privileged `agent` user, installs pinned CLIs, lays down
  `/opt/openthrottle` (entrypoint, normalizer, adapters, skills, the pinned
  Compound Engineering checkout), seals the pre-push boundary.
- The payload (provision.sh + entrypoint + skills) is **baked into the
  supervisor's own Fly image** and uploaded per-sprite via `fs/write` at
  provision. Supervisor and sandbox assets are now always in lockstep — the
  entire snapshot build/verify/stage pipeline, `DAYTONA_SNAPSHOT`, and the
  snapshot steps in `deploy.yml`, `setup`, and `init` are deleted.

Cost: provision (CLI install + payload + clone + deps) runs once per ticket,
est. 1–3 min on first run only — resume/review runs reuse the provisioned
sprite. After provision the entrypoint takes checkpoint `v0` ("clean
toolchain + clone") as a rollback point. Cross-ticket golden templates are not
possible (no fork-from-checkpoint) and are explicitly out of scope.

### D5. Runs are Services, not detached exec sessions

Was: `process.createSession` + `executeSessionCommand({runAsync})`; logs via
`getEntrypointLogs`.

Becomes: Fly's documented pattern for unattended agents — each run is a
**one-shot, self-stopping Service** (`PUT /v1/sprites/{name}/services/run`):
supervised by the sprite runtime, survives a cold wake mid-run (restart =
idempotent entrypoint re-entry, which the entrypoint already guarantees for
resume), logs land in `/.sprite/logs/services/run.log`. The service command
sources a per-run env file and **deletes it before starting work**, registers
the Task heartbeat (D2), runs the entrypoint, then drops the task and stops
itself. `/tickets/:id/logs` reads the sanitized tail via one-shot `exec`
instead of `getEntrypointLogs`.

### D6. Secrets: per-run sourced-then-deleted env file; new egress policy boundary

Was: `sandbox.updateEnv` persisted run credentials in sandbox config, with an
`unset` list to retire stale secrets.

Becomes: the supervisor writes `/home/agent/.ot/run.env` (mode 600) via
`fs/write` per run; the run service sources it and deletes it immediately, so
credentials never persist in sprite config, process listings, or on disk
beyond startup (Fly's own managed-agents pattern). `updateEnv`/unset plumbing
is deleted. Security invariants are unchanged: only repo/Linear-issue/model
credentials enter a sprite; `SPRITE_TOKEN` (like `DAYTONA_API_KEY` before it)
never does.

New, previously impossible boundary: at provision the supervisor applies a
**DNS egress allowlist** to every ticket sprite (`include: defaults` — GitHub,
npm, PyPI, model APIs — plus the supervisor callback host). Raw-IP and
private-IP egress are platform-blocked under policy, and the policy is
read-only from inside the sprite.

One regression to manage: the base `sprite` user has passwordless sudo, so
root-sealing is weaker than under Daytona. Provision runs agent work as the
non-sudo `agent` user (as today, via `sudo -u agent` instead of gosu) and
removes `sprite` from sudoers at the end of provisioning as evaluated in the
spike (§8). GitHub branch protection + fine-grained PAT remain the outer
enforcement layer regardless (already a stated invariant).

### D7. Preview: org-auth'd Sprite URL replaces signed preview URLs (deferred polish)

Was: `public:false` sandbox + supervisor-signed 5-minute preview URLs +
`/preview/:id` wake-and-redirect.

Becomes (v1, per explicit decision to not sort previews now): the dev server
(when `.openthrottle.yml` declares `dev`) is registered as a Service with
`http_port: DEV_PORT`; the sprite URL stays **org-private** (`auth: "sprite"`),
wakes on request, and is reachable by org members — strictly no worse than
today's model and zero supervisor code. The per-ticket preview-token flow,
hashed preview tokens, and `getSignedPreviewUrl` are deleted; `/preview/:id`
returns the sprite URL. Tokened external sharing (flip to `public` behind a
supervisor-signed gate, or a supervisor proxy) is a later, separate work item.

### D8. Client: thin internal REST client, not the SDK (for now)

`@fly/sprites` requires Node 24; the supervisor pins Node 22, and our surface
is 8 endpoints (create/get/delete/list, fs/write, exec, services put/delete,
network-policy put — plus checkpoints later). Fly's own reference worker uses
raw HTTP. We write `supervisor/src/sprites.ts` as a ~200-line typed REST
client with the same testability as today's mocked SDK. Revisit the SDK when
the supervisor moves to Node 24.

## 3. What does not change

The provider-agnostic 90% is untouched by design: Linear OAuth/webhook HMAC +
freshness, the durable leased webhook inbox, `linear_outbox` exactly-once
ordered projection, session/run/ticket state machine and generations, GitHub
webhook lifecycle (PR close → delete, review → review-fix, `REVIEW_MAX_ROUNDS`),
decision-gate elicitation flow, sanitizers, the CE adapter composition, the
JSONL normalizer, session resume via `~/.ot/agent-session-id`, the CLI verbs,
and `.openthrottle.yml` (still no `BASE_BRANCH`). `TASK_TIMEOUT` still bounds
runs via `timeout` in the entrypoint, with the sweep as outer guard.

## 4. Work breakdown

### Phase 0 — Platform spike (gate for everything below)

Manual, ~half a day, against a real org: validate §8's open questions, measure
provision time and warm/cold wake in practice, confirm fs/write + exec framing,
service+task pattern end-to-end, egress policy with the supervisor callback
host, sudoers removal, and org-auth URL behavior. Output: answers recorded in
this doc; go/no-go.

### Phase 1 — Supervisor

- New `sprites.ts` REST client + `provisioning.ts` (create → policy → payload
  upload → provision.sh → checkpoint v0).
- Rewrite the sandbox-facing functions currently exported by `daytona.ts`
  (`createForTicket`, `startTask`, `stopSandbox`, `deleteSandbox`,
  `getSandboxLogs`, `listLabeledSandboxes`, preview) against the client;
  `SandboxEnvContract` is unchanged except delivery mechanism (env file).
- Delete: `sandbox-lifecycle.ts`, `sandbox-events.ts` polling loop and boot
  poll, autostop reconciliation calls in `server.ts`, preview-token issuance.
- Add `POST /runs/:id/events` (token-authenticated, feeding the existing
  `sandbox_events` dedupe → outbox projection); keep `/runs/:id/complete`.
- Sweep: orphan pass lists `prefix=ot-`; completion-reconcile pass exec-reads
  the marker for overdue runs; storage-cost reaping unchanged in spirit.
- Config: drop `DAYTONA_API_KEY`/`DAYTONA_SNAPSHOT`/`SANDBOX_EVENT_POLL_INTERVAL_MS`;
  add `SPRITE_TOKEN`, optional `SPRITES_API_URL`. DB migration:
  `sandbox_id` → `sprite_name` (additive, backfilled null for closed tickets).

### Phase 2 — Sandbox payload

- `sandbox/Dockerfile` → `sandbox/provision.sh` (same steps, target = live
  overlay; idempotent).
- `entrypoint.sh`: gosu → `sudo -u agent`; add task-heartbeat
  register/refresh/release; `ot-activity` and the EXIT trap POST to the
  supervisor with spool fallback; source-and-delete `run.env`; register dev
  service instead of raw dev-server start; take checkpoint v0 after first
  provision.
- Bake `sandbox/` + `skills/` into the supervisor Fly image (Dockerfile COPY).

### Phase 3 — CLI, CI, docs

- `setup`/`init`: replace snapshot verification with a `SPRITE_TOKEN` org
  check; remove snapshot instructions.
- `deploy.yml`: delete the snapshot build/stage job; deploy is just the Fly
  app.
- Smoke: replace the Docker-image smoke with a harness that runs
  `provision.sh` + entrypoint stubs inside `ubuntu:25.04` (approximating the
  base image); Bats and Vitest contract suites updated to the REST client.
- Rewrite SPEC.md sandbox/supervisor contract sections; README bootstrap.

### Phase 4 — Cutover (one-time)

1. Freeze delegations (stop assigning the app); let active runs drain or
   `/stop` them.
2. Verify every open ticket is terminal or stopped; export any needed Daytona
   log tails (already durably stored in SQLite).
3. Deploy the new supervisor (secrets: unset Daytona, set `SPRITE_TOKEN`).
4. Smoke one live ticket end-to-end (implement → PR → reply-resume → review →
   merge → sprite deleted).
5. Delete remaining `openthrottle=true` Daytona sandboxes and the Daytona API
   key; close the account when comfortable.

Rollback = redeploy the previous supervisor image + restore Daytona secrets
(kept valid until step 5). In-flight tickets don't migrate across providers in
either direction — the freeze/drain makes that set empty.

## 5. Cost & capacity

Per active-ticket-hour ≈ 8 CPU × $0.07 + 4 GB × $0.04375 ≈ **$0.74/hr while
the agent actually runs**, $0 compute while paused; storage ~$0.5/GB-month for
what's written. The binding constraint is the **plan's concurrent-sprite cap**
(= max simultaneously *active* tickets, assuming paused sprites don't count —
spike question). Level 10 ($20/mo, 10 concurrent) fits current usage; the
sweep's expiry of stale tickets now also directly bounds storage spend.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Base image drifts under us (it auto-upgrades) | Pin agent CLIs + CE checkout in the overlay at provision; smoke against `ubuntu:25.04` in CI; `/.sprite/version.txt` logged per run |
| No custom images → per-ticket provision latency | Accepted (1–3 min, once per ticket); checkpoint v0 covers intra-ticket resets; revisit if Fly ships fork-from-checkpoint |
| `sudo` on the base user weakens hook sealing | D6: non-sudo `agent` user + sudoers removal (spike-validated); branch protection is the enforced outer layer |
| Push events depend on sprite egress | Local spool + sweep exec-reconcile fallback (D3); callback host pinned in egress policy |
| 4 GB RAM ceiling for heavy builds | Spike measures a real repo build; platform claims memory autoscaling — verify |
| Sprites is young; API is `dev-latest` | Thin client isolates the surface; contract tests mock at HTTP level |
| Concurrency cap semantics (active vs existing) | Spike question §8; plan sizing before cutover |

## 7. Later (explicitly out of scope for the port)

- **Sub-sandbox scratch compute for agents**: hand the in-ticket agent a
  prefix- and count-capped Sprites MCP connector (`https://sprites.dev/mcp`)
  so it can spin up disposable `mcp-ot-*` sprites for risky experiments. The
  deterministic supervisor remains the outer state machine.
- Tokened public preview sharing (D7 polish).
- Connectors for brokered GitHub credentials (would get the PAT off the
  sprite entirely).
- Checkpoint-based "reset between review rounds" if run cross-contamination
  ever becomes an issue.

## 8. Open questions for the spike

1. Do **paused** sprites count against the plan's concurrent cap, or only
   active ones?
2. Checkpoint creation: milliseconds-CoW or 10–30s with process stop? (Docs
   disagree.) Determines where in the entrypoint v0 is taken.
3. Is memory genuinely autoscaled above ~4 GB under pressure?
4. Does removing `sprite` from sudoers break the runtime (services, exec,
   base-image upgrades)?
5. Exact sprite-name constraints (charset/length) for `ot-<identifier>`
   mapping.
6. Egress-policy interaction with `gh`/git credential helper and model APIs —
   confirm `defaults` covers all agent traffic, enumerate what doesn't.
7. Service restart semantics after a cold wake mid-run: confirm re-entry
   behavior matches the entrypoint's idempotency assumptions (or mark the run
   service `stop`ped on first exit so it never auto-re-runs).
