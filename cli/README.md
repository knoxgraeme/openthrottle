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
openthrottle operator-skill install
openthrottle operator-skill status --json
```

- `setup` verifies the canonical Daytona snapshot when local Daytona
  credentials are present and prints the one-time Fly secrets checklist.
- `init` detects the GitHub origin/default branch and package scripts, writes
  `.openthrottle.yml`, registers the repository for either Linear-team or
  GitHub-Issue control with the deployed supervisor, creates or refreshes the
  repository webhook, and verifies GitHub/Daytona readiness. Linear control
  asks for a team key and optional team ID; GitHub control does not. It also
  supports non-Node repositories with manually entered commands.
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
- `operator-skill install|status|refresh|remove` manages the explicit local
  `openthrottle` agent skill through the pinned `skillfish` dependency. It
  installs from the immutable public source recorded at CLI build time, disables
  Skillfish telemetry for the embedded flow, never forwards OpenThrottle or
  provider credentials, and scopes removal to the exact Skillfish-managed
  OpenThrottle skill directory.

Other environment values: `DAYTONA_API_KEY`/`DAYTONA_SNAPSHOT` for `setup`;
optional `LINEAR_TEAM_KEY`/`LINEAR_TEAM_ID` defaults when `init` selects Linear
control; and
`LINEAR_API_KEY`, optional `LINEAR_TEAM_ID`, and `OT_AGENT_APP_ID` for
shipping.

The CLI never builds divergent per-project snapshots. Create the canonical
snapshot once from the OpenThrottle repository:

```bash
daytona snapshot create openthrottle --dockerfile sandbox/Dockerfile --context .
```

`init` is idempotent. Re-run it to change the selected control-provider route,
base branch, or project commands. Editable scaffolding currently covers the
simple pipeline's initial and repair implementation loops only; review,
simplification, publication, and structured-unit roles remain platform-owned
until their graph bindings can be represented faithfully. Repository
registrations live in the supervisor's durable SQLite database; they are not
Fly secrets.

Repositories can recommend the local skill in their own onboarding docs with:

```bash
openthrottle operator-skill install
```

Do not commit the installed skill, provider credentials, or user-global agent
configuration. The canonical source remains `skills/operator/openthrottle/` in
the public OpenThrottle repository.

Development:

For OpenCode projects, choose `agent: opencode`; `init` writes
`model: kimi-code/kimi-for-coding`. A top-level `model` is a legacy default for
the matching top-level `agent` only. Repositories that allow multiple agent
providers should use `agent_defaults` to pin each provider independently; the
Claude and Codex entries may also set `reasoning_effort`. OpenCode resumes keep
the model saved from the first run.

```bash
npm ci
npm run typecheck
npm test
npm run build
```
