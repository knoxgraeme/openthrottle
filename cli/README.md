# `openthrottle` CLI

Node 22 command line for configuring a target repository and operating the
OpenThrottle supervisor.

```text
openthrottle setup
openthrottle init
openthrottle init --editable-skills
openthrottle init --editable-skills --dry-run
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
- `init --editable-skills` additionally scaffolds the editable implementation
  adapter for the simple pipeline at
  `.openthrottle/skills/implement-plan/`, writes its repository graph at
  `.openthrottle/graphs/simple.json`, and records release, graph, package, and
  file digests in the self-validating `.openthrottle/skills.lock.json`. It
  copies the complete bounded package closure, including references; no
  `.agents/skills` mirror or user-global skill is created. Repeated use reports
  every file as unchanged, upstream-only, local-only, or conflict, refuses
  local edits and conflicts before any write, and asks separately before
  applying an eligible refresh. Add `--dry-run` to print that plan without
  changing files or registering the repository.
- `ship` creates a Linear issue from the first `# Heading` and delegates it
  with `IssueUpdateInput.delegateId` when `OT_AGENT_APP_ID` is configured.
  Linear emits that first delegation as an issue-only assignment-created
  session, so graph selection and execution-plan fences must live in the child
  issue body, not in later comment or parent context.
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

`init` is idempotent. Re-run it to change a team route, base branch, or project
commands. Editable scaffolding currently covers the simple pipeline's initial
and repair implementation loops only; review, simplification, publication, and
structured-unit roles remain platform-owned until their graph bindings can be
represented faithfully. Repository registrations live in the supervisor's
durable SQLite database; they are not Fly secrets.

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
