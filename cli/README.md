# `openthrottle` CLI

Node 22 command line for configuring a target repository and operating the
OpenThrottle supervisor.

```text
openthrottle init
openthrottle ship <plan.md>
openthrottle status
openthrottle stop <ticket>
openthrottle logs <ticket>
```

- `init` detects package scripts, writes `.openthrottle.yml`, verifies the
  canonical Daytona snapshot, and prints the supervisor secrets checklist.
- `ship` creates a Linear issue from the first `# Heading` and delegates it
  with `IssueUpdateInput.delegateId` when `OT_AGENT_APP_ID` is configured.
- `status`, `stop`, and `logs` call authenticated supervisor endpoints using
  `OT_SUPERVISOR_URL` and `OT_STATUS_TOKEN`.

Other environment values: `DAYTONA_API_KEY`/`DAYTONA_SNAPSHOT` for snapshot
verification; `LINEAR_API_KEY`, optional `LINEAR_TEAM_ID`, and
`OT_AGENT_APP_ID` for shipping.

The CLI never builds divergent per-project snapshots. Create the canonical
snapshot once from the OpenThrottle repository:

```bash
daytona snapshot create openthrottle --dockerfile sandbox/Dockerfile --context .
```

Development:

```bash
npm ci
npm run typecheck
npm test
npm run build
```
