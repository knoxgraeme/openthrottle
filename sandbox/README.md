# OpenThrottle sandbox

The Daytona snapshot is built from the repository root because it embeds the
shared `skills/` directory:

```bash
docker build -f sandbox/Dockerfile -t openthrottle .
daytona snapshot create openthrottle --dockerfile sandbox/Dockerfile --context .
```

It contains Node 22, git/curl/jq/yq/ripgrep/GitHub CLI, Claude Code, Codex,
OpenCode, a pinned native Compound Engineering installation, and an
unprivileged `agent` user. Its image entrypoint is inert; the supervisor uploads
sealed stage inputs and explicitly launches `/opt/openthrottle/entrypoint.sh`.

## Fenced stage lifecycle

Every invocation executes exactly one coordinator-selected stage:

1. Require the sealed stage request, repository config snapshot, and immutable
   pipeline manifest.
2. Verify hashes, runtime capability compatibility, request identity, and file
   ownership/mode.
3. Materialize only the credentials declared by the stage.
4. Clone the registered repository and reconstruct the branch from the sealed
   base commit or expected subject.
5. Seal the pre-push hook and Git configuration.
6. Apply the validated repository config, then run the bake-once bootstrap:
   `post_bootstrap` commands and engine probes execute only on the first stage
   of a sandbox and seal a root-owned marker recording the repository-config
   digest they ran under. Later stages verify the marker and skip the
   bootstrap; a missing-but-started, torn, or digest-mismatched marker fails
   the stage closed so the supervisor reprovisions the sandbox.
7. Invoke the command or agent executor with the manifest’s context policy.
8. Write one normalized, typed stage result to the supervisor-owned spool.

Credential materialization, `gh` credential-helper setup, commit identity,
branch reconstruction, fence validation, and the scrub of ignored
agent-executable config surfaces (`.claude`, `.codex`, `.agents`, and similar)
stay per-stage. Ignored dependency state installed by `post_bootstrap`
persists for the sandbox lifetime under the recorded config digest.

`TASK_TYPE` is ticket intent (`implement` or `investigate`), not an execution
mode. Native Claude/Codex/OpenCode continuation is controlled by the stage
request’s context policy and `nativeSessionId`; there is no standalone resume
task, task adapter registry, callback endpoint, or completion marker.

Agent stages write semantic proposals through `OT_STAGE_PROPOSAL_FILE`.
Command stages execute a configured gate directly. The runner verifies declared
artifact kinds and assurance, bounds output, records the Git subject, and emits
`stage_result` for the coordinator. Publication stages are additionally fenced
to the exact subject accepted by the publish evaluator.

Configured `limits.max_turns`, `limits.task_timeout`, and `mcp_servers` are
materialized for the selected engine. Claude uses slash-command skill entry;
Codex uses native `$skill` discovery and its sandbox-owned instructions;
OpenCode receives the canonical adapter body in its fenced prompt. Eligible
Claude/Codex stages install only the sandbox-owned live-steering hooks.
The config snapshot may include public graph declarations and intent defaults;
the sandbox treats them as sealed repository data. Stage dispatch still follows
the supervisor-pinned immutable manifest for the selected run.

`~/.ot` holds private logs, native session metadata, task context, activities,
and live-steering inbox files. `/var/lib/openthrottle/stage-results` is the
root-owned result boundary read by the supervisor. Activities and heartbeat
events are bound to the current run before they enter the Linear outbox.

## Agent configuration

Claude and Codex receive the same native Compound Engineering release through
their standard plugin installations; Codex also receives OpenThrottle standing
instructions outside the checkout. OpenCode receives a root-owned runtime
config outside the repository, with repository and compatibility config loading
disabled. Only validated `.openthrottle.yml` MCP declarations and the
allowlisted Kimi profile enter its config.

The target repository’s own agent instructions remain available as untrusted
project context. Registered repositories are trusted for code execution because
`post_bootstrap` can run arbitrary commands. Linear, Fly, Daytona, webhook,
install, and operator credentials never enter the sandbox.

## Safety and sanitization

The pre-push hook blocks main/master and non-fast-forward pushes, with
`core.hooksPath` root-sealed. Git uses the authenticated `gh` credential helper
against a clean origin URL so the token never appears in `.git/config`.

Shell and Node sanitizers redact named secret values, nested values from
`CODEX_AUTH_JSON`, the current Codex auth file after token rotation, and known
GitHub/OpenAI/Linear/bearer token shapes before logs or activities leave the
sandbox.

## Verification

```bash
npm ci --prefix sandbox
npm test --prefix sandbox
bats sandbox/tests/runtime.bats
docker build -f sandbox/Dockerfile -t openthrottle:test .
sandbox/tests/smoke.sh openthrottle:test
```

The Docker smoke verifies pinned agent CLIs and native CE discovery, then runs
sealed agent stages for Claude, Codex, and OpenCode plus a command stage against
a local bare repository. It checks stage-result assurance, branch fencing,
environment-tamper resistance, and absence of old completion events.
