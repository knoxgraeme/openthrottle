# `openthrottle` CLI

Node 22 command line for configuring a target repository and operating the
OpenThrottle supervisor.

```text
openthrottle setup
openthrottle init
openthrottle ship <plan.md>
openthrottle status
openthrottle stop <ticket>
openthrottle logs <ticket>
```

- `setup` verifies `SPRITE_TOKEN` with a live GET against the Fly Sprites API
  when local credentials are present and prints the one-time Fly secrets
  checklist.
- `init` detects the GitHub origin/default branch and package scripts, writes
  `.openthrottle.yml`, registers a Linear-team route with the deployed
  supervisor, creates or refreshes the repository webhook, and the supervisor
  verifies GitHub access and Fly Sprites reachability. It also supports
  non-Node repositories with manually entered commands.
- `ship` creates a Linear issue from the first `# Heading` and delegates it
  with `IssueUpdateInput.delegateId` when `OT_AGENT_APP_ID` is configured.
- `status`, `stop`, and `logs` call authenticated supervisor endpoints using
  `OT_SUPERVISOR_URL` and `OT_STATUS_TOKEN`.

Other environment values: `SPRITE_TOKEN` (and optional `SPRITES_API_URL`) for
`setup`; optional `LINEAR_TEAM_KEY`/`LINEAR_TEAM_ID` defaults for `init`; and
`LINEAR_API_KEY`, optional `LINEAR_TEAM_ID`, and `OT_AGENT_APP_ID` for
shipping.

There is no sandbox image to build, canonical or per-project: the sandbox
payload is baked into the supervisor's own Fly image and installed onto each
Fly Sprite by `sandbox/provision.sh` (idempotent) the first time it is used,
so supervisor and sandbox assets can never drift out of lockstep.

`init` is idempotent. Re-run it to change a team route, base branch, or
project commands. Repository registrations live in the supervisor's durable
SQLite database; they are not Fly secrets.

Development:

For OpenCode projects, choose `agent: opencode`; `init` writes
`model: kimi-code/kimi-for-coding`. The `model` setting is ignored by Claude
and Codex runs, and OpenCode resumes keep the model saved from the first run.

```bash
npm ci
npm run typecheck
npm test
npm run build
```
