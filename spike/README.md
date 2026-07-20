# Sprites platform spike

Phase 0 of [docs/SPRITES-PORT-PLAN.md](../docs/SPRITES-PORT-PLAN.md): answers
the §8 open questions against a real Sprites org and validates the endpoint
shapes `supervisor/src/sprites.ts` will be written against.

This cannot run from the hosted OpenThrottle dev sessions —
`api.sprites.dev` is blocked by their egress policy — so run it from a
laptop or any environment with open egress.

## Run it

```bash
# 1. Get an org token: https://sprites.dev/account  (or `sprite org auth`)
export SPRITE_TOKEN=...

# 2. Full run (~10 minutes, creates/deletes only ot-spike-* sprites, <$1)
node spike/sprites-spike.mjs

# Subset / options
node spike/sprites-spike.mjs --only exec,fs,service-task
node spike/sprites-spike.mjs --destructive   # adds the sudoers-removal check
node spike/sprites-spike.mjs --keep          # don't delete spike sprites
```

Node >= 20, no dependencies. Behind a corporate proxy, run with
`NODE_USE_ENV_PROXY=1` (Node 22.21+).

## What each check answers

| Check | Plan question | What a good result looks like |
|---|---|---|
| `auth`, `create` | — | token works; create is idempotent-ish (409 on repeat) |
| `names` | §8 Q5 | which name shapes 400 (charset/length for `ot-<identifier>`) |
| `exec` | D3/D5 | exit-code framing matches the `0x03` frame assumption |
| `fs` | D4/D6 | `fs/write` endpoint shape confirmed |
| `sudo` | §8 Q4 | non-sudo `agent` user can be created and used |
| `sudo-removal` | §8 Q4 | exec/services/socket still work after de-sudoing `sprite` |
| `service-task` | D2/D5 | task heartbeat holds the sprite past the 30s idle window; it pauses after release |
| `checkpoint` | §8 Q2 | create/restore endpoint shape + real timing (ms vs 10–30s) |
| `policy` | D6 | network-policy endpoint shape + REFUSED enforcement |
| `url` | §8 Q7 / D7 | what org-auth'd URLs return to anonymous vs tokened requests |
| `wake` | D2 | warm-wake latency after the idle window |
| `cap` | §8 Q1 | where the concurrent-sprite cap bites (create vs activate; paused counted?) |
| `mem` | §8 Q3 | reported RAM + behavior when a process allocates past ~4 GB |

Checks marked as **probes** in the source try several candidate endpoint
paths where the public docs are ambiguous (checkpoints, network policy,
services) and report which one the API accepted — paste the full output back
into the plan doc's §8 when done.
