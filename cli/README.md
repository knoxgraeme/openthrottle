# `openthrottle` CLI

Node 22 command line for configuring a target repository and operating the
OpenThrottle supervisor.

```text
openthrottle setup
openthrottle init
openthrottle plan validate <plan.md> [--graph <id>]
openthrottle ship <plan.md>
openthrottle status
openthrottle stop <ticket>
openthrottle logs <ticket>
```

- `setup` verifies the canonical Daytona snapshot when local Daytona
  credentials are present and prints the one-time Fly secrets checklist.
- `init` detects the GitHub origin/default branch and package scripts, writes
  `.openthrottle.yml`, registers a Linear-team route with the deployed
  supervisor, creates or refreshes the repository webhook, and verifies
  GitHub/Daytona readiness. It also supports non-Node repositories with
  manually entered commands.
- `ship` creates a Linear issue from the first `# Heading` and delegates it
  with `IssueUpdateInput.delegateId` when `OT_AGENT_APP_ID` is configured.
- `plan validate --graph structured` checks that a plan contains exactly one
  execution-plan block for the selected local graph. `ship --graph` is reserved
  until graph selection is persisted through admission.
- `status`, `stop`, and `logs` call authenticated supervisor endpoints using
  `OT_SUPERVISOR_URL` and `OT_STATUS_TOKEN`.

Other environment values: `DAYTONA_API_KEY`/`DAYTONA_SNAPSHOT` for `setup`;
optional `LINEAR_TEAM_KEY`/`LINEAR_TEAM_ID` defaults for `init`; and
`LINEAR_API_KEY`, optional `LINEAR_TEAM_ID`, and `OT_AGENT_APP_ID` for
shipping.

The CLI never builds divergent per-project snapshots. Create the canonical
snapshot once from the OpenThrottle repository:

```bash
daytona snapshot create openthrottle --dockerfile sandbox/Dockerfile --context .
```

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
