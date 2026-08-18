<p align="center">
  <img src="https://raw.githubusercontent.com/knoxgraeme/openthrottle/main/docs/assets/banner.jpg" alt="OpenThrottle" width="100%">
</p>

# `openthrottle`

The Node.js 22 CLI for OpenThrottle, a self-hosted pipeline that turns approved
plans into reviewed GitHub pull requests with Claude Code, Codex, or OpenCode.

> OpenThrottle is pre-production software. Use it for controlled pilots and
> register only repositories you trust to execute inside the sandbox.

## Start here

Install the Fly and Daytona CLIs, authenticate them, then run guided setup:

```bash
npx openthrottle setup
```

Initialize a target repository:

```bash
cd your-repository
npx openthrottle init
```

`init` installs user-global authoring/operator skills for detected local agents,
writes `.openthrottle.yml`, registers a Linear-team or GitHub-Issue control route,
creates the GitHub webhook, and verifies the Daytona snapshot.

For Linear control, prepare and delegate a plan:

```bash
npx openthrottle plan prepare docs/plans/my-change.md
npx openthrottle ship docs/plans/my-change.md
npx openthrottle status
```

For GitHub-Issue control, an authorized collaborator starts work by applying
the exact `openthrottle` label to an open Issue.

## Commands

```text
openthrottle setup [--profile <name>] [--check] [--yes] [--legacy-checklist]
openthrottle init [--profile <name>] [--editable-skills] [--dry-run]
openthrottle plan validate <file.md>
openthrottle plan prepare <file.md> [--graph <id>]
openthrottle validate <file.md>
openthrottle ship <file.md>
openthrottle status
openthrottle stop <ticket>
openthrottle logs <ticket>
openthrottle analysis [filters]
openthrottle operator-skill <install|status|refresh|remove> [--json]
openthrottle planning-skill <install|status|refresh|remove> [--json]
```

Key workflows:

- `setup` provisions and verifies the pinned supervisor and sandbox release.
  `--check` is read-only; `--profile` keeps multiple environments separate.
- `init` is idempotent. Re-run it to change control provider, base branch, or
  repository commands. A partial `OT_SUPERVISOR_URL`/`OT_STATUS_TOKEN` pair
  fails closed.
- `init --editable-skills` scaffolds repository-owned `implement-plan`,
  `admission-plan`, and `review-admission-plan` packages. The planner and
  reviewer may be edited independently; provenance refreshes include their
  metadata and references and refuse to overwrite local edits. `--dry-run`
  reports refresh classifications without writing or registering.
- `plan prepare` uses the configured local engine and canonical planning skill;
  `plan validate` checks the embedded execution-plan contract.
- `status`, `stop`, `logs`, and `analysis` call authenticated supervisor
  endpoints.

Run `npx openthrottle --help` for full flag descriptions.

## Credentials and local state

Setup profiles live under `~/.openthrottle/profiles/`. Generated supervisor
secrets and repository setup access are stored separately with owner-only
permissions. Operator-owned GitHub, Daytona, Linear, and model credentials are
not persisted by the CLI; configure them as Fly secrets.

Common environment variables:

- `OT_SUPERVISOR_URL` and `OT_STATUS_TOKEN` for explicit supervisor access;
- `DAYTONA_API_KEY` for setup;
- `LINEAR_API_KEY`, `LINEAR_TEAM_ID`, and `OT_AGENT_APP_ID` for Linear
  delegation; and
- `OT_FLY_APP`, `OT_FLY_ORG`, and `OT_FLY_REGION` for resource overrides.

Do not commit local skills, provider credentials, user-global agent
configuration, or `.env` files.

## Learn more

Read the [project README](https://github.com/knoxgraeme/openthrottle#readme),
[security policy](https://github.com/knoxgraeme/openthrottle/blob/main/SECURITY.md),
and [normative specification](https://github.com/knoxgraeme/openthrottle/blob/main/docs/SPEC.md).

## License

MIT
