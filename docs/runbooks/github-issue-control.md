# GitHub Issue control operations

This runbook temporarily switches a registered repository from Linear control
to GitHub Issue control, runs a delegation, observes it, and restores the prior
route. Keep tokens, webhook bodies, and restoration state in private operator
notes.

## Preconditions

- Export `OT_SUPERVISOR_URL` and `OT_STATUS_TOKEN`.
- Work from the target repository root.
- Commit and push `.openthrottle/config.yml` and every referenced definition.
- Keep the exact provider reference or PipelineRun ID returned by status.
- The activation label is lowercase `openthrottle`.
- The activating GitHub user must have triage, write, maintain, or admin access.

Check the route and runtime before changing anything:

```bash
curl -fsS -H "Authorization: Bearer ${OT_STATUS_TOKEN}" \
  "${OT_SUPERVISOR_URL%/}/repositories" | jq .
curl -fsS -H "Authorization: Bearer ${OT_STATUS_TOKEN}" \
  "${OT_SUPERVISOR_URL%/}/capabilities" | jq .
```

Save the matching registration’s repository, base branch, control provider,
Linear team key, and optional Linear team ID. Stop if it is not the Linear route
you intend to restore.

## Select and validate the pipeline

Pipeline selection is committed filesystem state, not a label or command-line
runtime override:

```yaml
# .openthrottle/config.yml
schema: openthrottle.config/v2
pipeline: core/structured
engine: codex
```

For a pipeline that loops over `execution_plan.units`, the Issue body must
contain exactly one `openthrottle.execution-plan/v2` block whose `pipeline_id`
matches the selected pipeline. Prepare and validate it locally:

```bash
npx openthrottle plan prepare docs/plans/<plan>.md --pipeline core/structured
npx openthrottle plan validate docs/plans/<plan>.md --pipeline core/structured
```

Other pipelines accept reviewed prose and reject an unused execution-plan
block. Commit and push all definition changes before activation: admission reads
the registered branch’s exact Git commit, never the operator’s working tree.

## Switch to GitHub Issue control

Interactive path:

```bash
npx openthrottle init
```

Noninteractive path:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer ${OT_STATUS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"repo":"OWNER/REPO","controlProvider":"github","baseBranch":"BASE_BRANCH"}' \
  "${OT_SUPERVISOR_URL%/}/repositories/register"
```

Registration verifies the repository and branch, creates or refreshes the
webhook and activation label, verifies the Daytona snapshot, and switches only
future work. Linear fields are rejected for GitHub control.

## Activate and observe

Create an open Issue containing the full reviewed task or structured plan, then
apply `openthrottle`. The signed event is accepted only when the route, actor,
live Issue state, exact subject, and filesystem definitions all verify. Duplicate
or reordered deliveries are deduplicated by the inbox.

```bash
npx openthrottle status "OWNER/REPO#123"
npx openthrottle logs "OWNER/REPO#123"
npx openthrottle analysis --run "OWNER/REPO#123"
```

Status shows the selected pipeline and DefinitionBundle hash, exact subject,
current stage, Attempts and their `inspect`/`edit` authority, Effects,
correction diagnostics, and terminal outcome. Use logs for bounded event detail
and analysis for settled Result/Decision/Delivery metadata.

Authorized comments become steering inbox events only when their run, Attempt,
generation, request, bundle, subject, and native session match the current
binding. A stale comment cannot mutate a later Attempt.

## Stop safely

Closing the Issue creates a durable control event. The provider-neutral command
is:

```bash
npx openthrottle stop "OWNER/REPO#123"
```

“Stop requested” means the deduplicated control event was accepted. Continue
observing status until terminal reduction records runtime stop/cleanup delivery;
do not manually delete a Daytona resource as a substitute for kernel evidence.

## Restore Linear control

Interactive path:

```bash
npx openthrottle init
```

Noninteractive path:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer ${OT_STATUS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"repo":"OWNER/REPO","controlProvider":"linear","linearTeamKey":"TEAM_KEY","linearTeamId":"TEAM_ID","baseBranch":"BASE_BRANCH"}' \
  "${OT_SUPERVISOR_URL%/}/repositories/register"
```

Omit `linearTeamId` when the saved route had none. Confirm that `GET
/repositories` exactly matches the saved team key, optional ID, and base branch.
Already-admitted runs retain their pinned provider and DefinitionBundle; the
restored route governs only later events.
