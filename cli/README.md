# openthrottle (CLI)

`npx openthrottle` — the command-line front door to OpenThrottle: initialize a
target repo, ship a ticket, check status. See [docs/SPEC.md](../docs/SPEC.md)
("CLI contract") for the authoritative spec this implements.

## Install

```sh
npm install -g openthrottle
# or, without installing:
npx openthrottle <command>
```

Requires Node 22+.

## Commands

### `openthrottle init`

Run from the root of the target Node.js project you want OpenThrottle to work
on (the repo with the code the agent will edit — not the openthrottle-v2
monorepo, unless you're building the canonical sandbox snapshot).

1. Detects package manager, base branch, and `test`/`build`/`lint`/`dev`
   scripts from `package.json` and `git remote show origin`.
2. Prompts to confirm/edit, then writes `.openthrottle.yml` to the repo root
   (commit this file — the sandbox reads it at bootstrap).
3. Creates or updates the Daytona snapshot used to run sandboxes:
   - If a `sandbox/Dockerfile` is found nearby (i.e. you're running this from
     within the openthrottle-v2 monorepo), builds the snapshot from it via
     `Image.fromDockerfile`.
   - Otherwise builds a declarative image (`Image.base('node:22-bookworm')`)
     that mirrors the sandbox contract's tool installs, but **without** the
     product-specific entrypoint/skills files (those live in the monorepo's
     `sandbox/` directory). Requires `DAYTONA_API_KEY`; skipped with a warning
     if it's not set.
4. Prints every env var the supervisor needs, as copy-pasteable
   `fly secrets set` lines.

### `openthrottle ship <file.md>`

Creates a Linear issue from a markdown file: the title is the file's first
`# Heading`, the body is everything after it. Requires `LINEAR_API_KEY`.
Optionally set `LINEAR_TEAM_ID` to skip the team-picker prompt.

If `OT_AGENT_APP_ID` is set, attempts to delegate the new issue to the
OpenThrottle agent app automatically. If that fails (delegation mechanics for
Linear's Agent API are still Developer Preview — see `// TODO(verify-linear-api)`
in `src/ship.ts`), it prints the issue URL and instructions to delegate it by
hand in Linear.

### `openthrottle status`

Prints a plain table of ticket rows from the supervisor's `GET /status`
endpoint. Requires `OT_SUPERVISOR_URL` (e.g. `https://openthrottle.fly.dev`).

## Environment variables

| Var | Used by | Meaning |
|---|---|---|
| `DAYTONA_API_KEY` | `init` | Daytona API key, to build the sandbox snapshot |
| `DAYTONA_SNAPSHOT` | `init` | Snapshot name to create/update (default `openthrottle`) |
| `LINEAR_API_KEY` | `ship` | Plain Linear API key with issue-create access |
| `LINEAR_TEAM_ID` | `ship` | Skips the team-picker prompt |
| `OT_AGENT_APP_ID` | `ship` | Linear actor id of the OpenThrottle agent app, for auto-delegation |
| `OT_SUPERVISOR_URL` | `status` | Base URL of the deployed supervisor |

## Development

```sh
npm install
npm run build   # tsc -> dist/
npm run dev      # tsc --watch
node dist/index.js --help
```

No test framework is wired up yet (v1 scaffold — see root README's honest-status section).
