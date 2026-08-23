# OpenThrottle sandbox

The Daytona image is built from the repository root because it contains the
platform fence and generated runtime schemas:

```bash
docker build -f sandbox/Dockerfile -t openthrottle .
daytona snapshot create openthrottle --dockerfile sandbox/Dockerfile --context .
```

The image contains Node 22, Git, jq, ripgrep, Claude Code, Codex, OpenCode, and
one unprivileged `agent` user. Its image entrypoint is intentionally inert. The
supervisor uploads one root-owned, read-only request and explicitly launches
`/opt/openthrottle/entrypoint.sh`.

## Execution kernel

The entrypoint accepts exactly two request families:

- `OT_ACTION_REQUEST_FILE`, `OT_ACTION_RESULT_FILE`, and
  `OT_ACTION_SESSION_FILE` execute or replay one work/result-correction
  attempt.
- `OT_INTEGRATION_REQUEST_FILE` and `OT_INTEGRATION_RESULT_FILE` integrate or
  replay one accepted checkpoint effect.

An action materializes the exact requested Git subject into a fresh repository
with no usable remote. Git administration stays executor-owned. An `inspect`
action also makes the complete checkout root-owned and read-only, filters the
child environment, and verifies the exact Git control and tree after execution.
Those executor controls are the authoritative inspect boundary. An `edit`
action grants the agent write access to repository content, while commits, refs,
pushes, and publication remain outside the model's authority. Before any action
or integration, the shared source checkout is recursively root-owned and
non-writable without following symlinks. Deterministic command gates run in the
same isolated repository and never contribute their incidental filesystem
mutations.

Normal Codex inspect work uses explicit `--sandbox danger-full-access` inside
the isolated Daytona executor. This avoids nesting Codex's Linux sandbox where
the provider runtime does not permit its network-namespace setup; it does not
change `repository_authority: inspect` or any executor-owned safeguard. Codex
shell commands may have network access, so the minimal child environment and
absence of GitHub or provider-mutation credentials are part of the boundary.
The CLI can still read its attempt-scoped Codex access-token seed; the
supervisor strips the durable refresh token before materializing that seed.
Until an outer egress policy exists, this mode is appropriate only for the
registered public dogfood repository and must not be described as a
confidentiality boundary for private source. Codex result correction keeps
`--sandbox read-only` because its shell features are disabled and that
least-privilege path does not invoke repository commands. Both paths ignore
user configuration and rules and disable Codex Apps, browser, plugin,
image-generation, and multi-agent features.

An inspect action with an accepted-edit boundary also receives one bounded
executor-owned change artifact in a dedicated read-only directory outside the
checkout. It names the exact base/input subjects and trees, includes changed
paths and textual diff within fixed bounds, and records explicit omission
diagnostics otherwise. Claude, Codex, and OpenCode are all prompted with the
same path; the artifact itself adds no shell, network, edit, provider, MCP, or
Git-administration authority.

For an agent action, the sealed DefinitionBundle supplies:

- one agent instruction document;
- the task prompt;
- only the allowed skill packages; and
- model, reasoning, repository authority, and semantic-result contracts.

The executor installs those skills into the selected engine's private discovery
root for that attempt. `SKILL.md` references, scripts, and assets therefore use
the engine's native progressive disclosure instead of being flattened into the
initial prompt. Nothing is installed globally per engine.

The agent submits `openthrottle.result-candidate/v1`. The executor validates it
against the sealed semantic schema and applies only declared deterministic
normalizers. For example, `string-array-to-newlines/v1` converts the OPE-188
`payload.summary` array into a string without rerunning completed work. If the
candidate still fails validation, a bounded same-session correction can call
only `ot-result`; it receives no skills, MCP, provider access, or writable
repository. Claude and Codex keep the sealed steering hook and exact correction
lease/session bindings, but injected guidance cannot expand that result-only
tool policy.

Every completed attempt creates an executor-authored Git commit and a bounded,
content-addressed bundle at
`refs/openthrottle/checkpoints/<request_hash>`. The checkpoint separately binds
the commit and accepted content tree. The supervisor can then request an
idempotent fast-forward or deterministic three-way integration. Integrated
output is another exact commit/bundle under a hash-derived integration ref;
conflicts become `needs_human` evidence rather than agent-authored Git state.

Runtime results and native-session observations are immutable, identity-bound
files. A repeated launch with the same request and output path returns that
evidence without redispatching the agent or command.

## Steering and credentials

Only model credentials needed by the selected engine enter its minimal child
environment. Linear, Daytona, Fly, webhook, install, and operator credentials
never enter the agent process.

Claude and Codex work and result-correction attempts may receive guidance through
`~/.ot/inbox`. The hook injects only envelopes matching the live pipeline run,
attempt, request hash, definition-bundle hash, lease, and native session.
Malformed or mismatched envelopes remain untouched. OpenCode does not install
this hook.

## Verification

```bash
npm ci --prefix sandbox
npm test --prefix sandbox
bats sandbox/tests/runtime.bats sandbox/tests/inbox-drain.bats
docker build -f sandbox/Dockerfile -t openthrottle:test .
sandbox/tests/smoke.sh openthrottle:test
node sandbox/tests/structured-walking-skeleton.mjs openthrottle:test
```

The ordinary Docker smoke proves an editable action, deterministic result
normalization, immutable replay, a hard read-only inspect action, progressive
skill delivery, and exact checkpoint restoration. The structured proof runs two
dependent attempts through the same action and integration primitives and
verifies their final integrated Git subject.
