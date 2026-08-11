# GitHub Issue control operations

This runbook is for a short credentialed operator exercise that temporarily
switches one registered repository from Linear control to GitHub Issue control,
runs a structured Codex delegation, observes it, and restores the previous
Linear route exactly. Do not paste secrets, live tokens, webhook payloads, or
time-specific acceptance artifacts into issues, PRs, docs, or command output
captures.

## Scope and identifiers

- Run commands from the target repository root after setting
  `OT_SUPERVISOR_URL` and `OT_STATUS_TOKEN` in the shell.
- Use the repository slug as `OWNER/REPO`.
- Use the provider-qualified ticket `id` from `openthrottle status`, not the
  display `reference`, for `status`, `logs`, and `stop`. A GitHub-controlled
  ticket id is provider-qualified by the supervisor; copy it from the `id:`
  line.
- The activation label is exactly lowercase `openthrottle`.
- GitHub activation requires a repository collaborator with `triage`, `write`,
  `maintain`, or `admin` permission.
- Structured activation requires the supervisor `GET /capabilities` response to
  include `graph/for-each-unit@1`. The CLI verifies this before Linear mutation
  for `ship --graph structured`; for GitHub Issue control, check it explicitly
  before applying the label.

## Save the current Linear route

Record the current registration before changing control providers. Keep this
record in the operator's private notes only, because it is restoration state,
not acceptance evidence.

```bash
curl -fsS \
  -H "Authorization: Bearer ${OT_STATUS_TOKEN}" \
  "${OT_SUPERVISOR_URL%/}/repositories"
```

For `OWNER/REPO`, save these fields exactly from the matching registration:

- `github_repo`
- `base_branch`
- `linear_team_key`
- `linear_team_id`, if present
- `control_provider`

Stop unless the saved `control_provider` is `linear`; this runbook restores a
Linear route, not an arbitrary prior state.

## Switch the repository to GitHub Issue control

Use `openthrottle init` when doing this manually. Choose `GitHub Issues` for
`Control provider`, keep the same base branch, and keep `Default agent` as
`Codex CLI` unless the exercise deliberately tests another engine. Commit only
normal repository config changes that are intended to remain after the exercise.

```bash
npx openthrottle init
```

For noninteractive automation, use the same supervisor endpoint that `init`
uses:

```bash
curl -fsS \
  -X POST \
  -H "Authorization: Bearer ${OT_STATUS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"repo":"OWNER/REPO","controlProvider":"github","baseBranch":"BASE_BRANCH"}' \
  "${OT_SUPERVISOR_URL%/}/repositories/register"
```

The supervisor verifies the GitHub repository, creates or refreshes the webhook,
ensures the exact `openthrottle` label, verifies the Daytona snapshot, and
upserts the route. Linear team fields are rejected for GitHub control.

## Prepare structured Codex input

Ensure `.openthrottle.yml` permits the structured graph and sets `agent: codex`.
The generated config includes both `simple` and `structured`; do not hand-edit
around config validation. Before applying the activation label, apply the exact
GitHub Issue label `agent:codex`. This pins the admission engine on the Issue
itself; it is mandatory for this Codex exercise. Do not rely on a remembered or
unobservable supervisor default agent.

Prepare or validate the markdown plan before opening the GitHub Issue:

```bash
npx openthrottle plan prepare docs/plans/<plan>.md --graph structured
npx openthrottle plan validate docs/plans/<plan>.md --graph structured
```

If the plan already contains a valid
`json openthrottle.execution-plan/v1` block, run only validation. The plan's
`graph_id` must be `structured`; do not activate a prose-only issue as a
structured run.

Check the live supervisor capability before labeling the Issue:

```bash
curl -fsS \
  -H "Authorization: Bearer ${OT_STATUS_TOKEN}" \
  "${OT_SUPERVISOR_URL%/}/capabilities"
```

Continue only when the response includes `graph/for-each-unit@1` and a nonempty
`release` and `capabilityDigest`.

## Activate from a GitHub Issue

Create an open GitHub Issue in `OWNER/REPO`. Its complete body, including the
prepared plan text and the `openthrottle.execution-plan/v1` block, must fit the
20,000-character admission limit. Count the final body before creating or
editing the Issue; shortening only the prose while omitting the execution-plan
block is not valid structured input. Do not put credentials or operator-only
values in the Issue.

After `agent:codex` is present and the complete body is within the admission
bound, apply the exact lowercase `openthrottle` label to start the generation.
Opening or reopening an already-labeled Issue is equivalent. The supervisor
admits the Issue only if the repository is registered for GitHub control, the
actor is authorized, the webhook signature is valid, and the live Issue state
still matches the activation event.

Plain comments from authorized collaborators are steering for the current
generation. Closing the Issue requests stop for every nonterminal stage,
including provider wait. Reopening it or reapplying the label after a terminal
generation starts a new session.

## Observe progress

Use the CLI status view first:

```bash
npx openthrottle status
```

Find the GitHub Issue row and copy its `id:` value. Then use that exact id for
focused status and logs:

```bash
npx openthrottle status "<ticket-id-from-status>"
npx openthrottle logs "<ticket-id-from-status>"
```

The status output reports the control provider, external thread, agent,
pipeline generation, current stage, publication state, current effect, recovery
action, and structured unit breakdown when the graph is structured. The
supervisor also maintains one pinned GitHub Issue status comment with the
lifecycle, structured activity, PR link, and revision marker.

Treat `whose move` as the operator-facing owner:

- `working`: supervisor or sandbox work is active.
- `waiting on GitHub`: the run is waiting for provider evidence on the
  executor-verified published commit.
- `waiting on you`: human or operator action is required.
- `finished`: terminal outcome reached.

For publication or webhook-delivery problems, inspect `publication`,
`effect`, `last error`, and `recovery` in `status` before touching provider
state.

## Fail-safe stop

Prefer closing the GitHub Issue when the desired operator action is "stop this
Issue-controlled generation." Use the authenticated stop command when the Issue
cannot be used, the run is wedged, or the operator needs a provider-neutral
stop:

```bash
npx openthrottle stop "<ticket-id-from-status>"
```

`Stop requested for ...` means the supervisor accepted the stop and returned
`202 stop_requested`; the durable stop effect has not acknowledged yet. After
that response, repeat the same stop command until it returns `200 stopped` and
prints `Stopped ...`. Do not treat focused status or a terminal ticket status
by itself as proof that the runtime stopped: only the repeated stop response
confirms both durable stop-effect acknowledgement and live-run absence.

If termination cannot be confirmed, retain the supervisor's durable evidence
and follow the rollout runbook's quarantine guidance. Do not manually delete a
runtime resource as a substitute for a coordinator stop.

## Restore Linear control exactly

Restore the saved route immediately after the GitHub exercise, whether it
passed, failed, or was stopped.

Manual path:

```bash
npx openthrottle init
```

Choose `Linear`, enter the saved `linear_team_key`, enter the saved
`linear_team_id` when one was present, and enter the saved `base_branch`. The
CLI uppercases the team key before registration.

Noninteractive path:

```bash
curl -fsS \
  -X POST \
  -H "Authorization: Bearer ${OT_STATUS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"repo":"OWNER/REPO","controlProvider":"linear","linearTeamKey":"TEAM_KEY","linearTeamId":"TEAM_ID","baseBranch":"BASE_BRANCH"}' \
  "${OT_SUPERVISOR_URL%/}/repositories/register"
```

If no `linear_team_id` was saved, omit the `linearTeamId` field rather than
sending an empty string. Re-registering the same repository switches future
control only; already admitted tickets and sessions retain their pinned
provider. The supervisor refuses to transfer a Linear team route to another
repository.

Confirm restoration:

```bash
curl -fsS \
  -H "Authorization: Bearer ${OT_STATUS_TOKEN}" \
  "${OT_SUPERVISOR_URL%/}/repositories"
npx openthrottle status
```

The matching registration for `OWNER/REPO` must show
`control_provider: "linear"` with the saved team key, optional team id, and
base branch. New Linear delegations from that team should route to the restored
repository; new GitHub Issue labels should fail closed unless the repository is
switched back to GitHub control.
