# Sprites wire-protocol reference (from `superfly/sprites-js` source)

Extracted from the official JS SDK source (`github.com/superfly/sprites-js`,
commit `accf9dc`, 2026-03-06) so `supervisor/src/sprites.ts` can be written
against the real protocol rather than the (sometimes ambiguous) public docs.
File/line references are to that commit.

## Auth and base URL

- `Authorization: Bearer <SPRITE_TOKEN>` on every REST and WebSocket call.
- Base URL `https://api.sprites.dev`. WS URLs are the same paths with
  `https`→`wss`.
- Token minting (`POST /v1/organizations/{org}/tokens`) is the one exception:
  it authenticates with a Fly macaroon (`Authorization: FlyV1 …`).

## REST surface (what our client needs)

| Purpose | Call |
|---|---|
| Create | `POST /v1/sprites` body `{name, config?}` — 120s SDK timeout |
| Get | `GET /v1/sprites/{name}` |
| List | `GET /v1/sprites?prefix=&max_results=&continuation_token=` |
| Delete | `DELETE /v1/sprites/{name}` (200 or 204) |
| URL auth | `PUT /v1/sprites/{name}` body `{url_settings:{auth:"sprite"\|"public"}}` |
| Exec sessions | `GET /v1/sprites/{name}/exec` |
| Checkpoint create | `POST /v1/sprites/{name}/checkpoint` (**singular**) body `{comment?}` — **NDJSON progress stream** response |
| Checkpoint list/get | `GET /v1/sprites/{name}/checkpoints`, `GET …/checkpoints/{id}` |
| Checkpoint restore | `POST /v1/sprites/{name}/checkpoints/{id}/restore` — NDJSON stream |
| Service create/update | `PUT /v1/sprites/{name}/services/{svc}?duration=` body `{cmd, args?, needs?, httpPort?}` — NDJSON stream; 409 on conflict |
| Service start/stop | `POST …/services/{svc}/start`, `POST …/services/{svc}/stop?timeout=` |
| Service signal | `POST /v1/sprites/{name}/services/signal` body `{name, signal}` (flat path — SDK outlier) |
| Service delete | `DELETE …/services/{svc}` (204) |
| Network policy | `GET`/`POST /v1/sprites/{name}/policy/network` body `{rules:[{include:"defaults"}\|{domain,action}]}` — 204 on success, 400 invalid |
| fs write | `PUT /v1/sprites/{name}/fs/write?path=&workingDir=&mkdirParents=&mode=` raw body, `Content-Type: application/octet-stream`, mode as 4-digit octal string |
| fs read | `GET /v1/sprites/{name}/fs/read?path=&workingDir=` → raw bytes |
| fs list/stat | `GET /v1/sprites/{name}/fs/list?path=&workingDir=` (stat = `entries[0]`; no separate stat endpoint) |
| fs delete/rename/copy/chmod | `DELETE …/fs/delete`, `POST …/fs/rename`, `POST …/fs/copy`, `POST …/fs/chmod` |

No server-side mkdir: the SDK writes a `.keep` file with `mkdirParents=true`
and deletes it.

Casing caveat: request/response casing is **per-endpoint**, not global
(create body camelCase `config`, URL-settings body snake_case `url_settings`,
services natively camelCase, sprites responses snake_case). The service
`httpPort` field is camelCase in the SDK types but one official example sends
`http_port` — the spike harness sends both.

## Exec transport

The SDK's exec is a **WebSocket**: `wss://…/v1/sprites/{name}/exec` (new) or
`…/exec/{sessionId}` (attach), with query params `cmd` (repeated), `path`,
`stdin=true`, `env=K=V` (repeated), `dir`, `tty`/`rows`/`cols`,
`detachable=true`. Fly's own managed-agents reference worker instead uses a
plain **HTTP `POST /v1/sprites/{name}/exec`** with repeated `cmd` query
params and a framed streaming body — both transports exist; the spike
verifies the HTTP one (it's what our supervisor would prefer: no socket to
babysit).

Non-TTY byte framing (both transports): each frame is
`[streamID byte][payload]` —

```
0 = stdin (client→server)     2 = stderr (server→client)
1 = stdout (server→client)    3 = exit: payload[0] = exit code
4 = stdin EOF (client→server, no payload)
```

TTY mode drops the stream prefix (raw PTY bytes; control messages as JSON
text frames: `{type:"resize",cols,rows}`, `{type:"signal",signal}`).
Detachable sessions are tmux-backed server-side; attach blocks on a
`{type:"session_info"}` text frame.

Two SDK caveats worth knowing if we ever adopt it: its keepalive is a
45s receive-timeout watchdog (a silent long-running command gets its
*client* connection killed — the server session survives), and non-TTY
`port_opened` notifications are dropped by a framing bug.

## Errors

- Sprite CRUD: structured JSON `{error, message, retry_after_seconds?, …}`
  with error codes including `sprite_creation_rate_limited` and
  **`concurrent_sprite_limit_exceeded`** (+ `upgrade_available`/`upgrade_url`)
  and rate-limit headers. This makes plan-cap handling programmatic.
- fs endpoints: `{error, code, path}` with POSIX-style codes (`ENOENT`, …).
- Services/checkpoints/policy: plain-text status+body errors.

## Name validation

None client-side (names are string-interpolated into URLs unencoded), so
constraints are entirely server-enforced — the spike's `names` probe is the
source of truth for the `ot-<identifier>` mapping.

## Node compatibility (plan D8)

`engines: node >=24`, zero runtime deps. The only >=24-looking usage is
`new WebSocket(url, {headers})` (Node/undici extension) for WS auth. A
REST-only client (all we need: fetch + HTTP exec) has no Node-24
requirement — confirming the plan's thin-client decision for the Node 22
supervisor.
