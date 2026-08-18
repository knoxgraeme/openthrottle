# Automatic admission operator runbook

Automatic admission remains disabled unless a repository operator explicitly
sets `intents.implement.admission_mode: automatic` in committed
`.openthrottle.yml`. Missing mode and `legacy` retain the existing default-graph
behavior. `openthrottle init`, including `--editable-skills`, does not enable it.

## Routes and overrides

- `simple` is one cohesive implementation that is verified as a whole.
- `structured` is multiple independently implementable or ordered units and
  requires one complete reviewed execution plan.
- `needs_human` means product scope or acceptance authority is missing. It
  starts no writer and creates no pull request.

A complete explicit simple selection remains a human bypass. A complete valid
structured plan remains the manual structured route. Operators who do not want
automatic planning can run `openthrottle plan prepare <file.md>` and
`openthrottle plan validate <file.md>` before `ship`.

Repositories may declare pinned `repo://` planner and reviewer packages and
bind them with `planner_skill` and `reviewer_skill`. The two bindings are
independent. Ticket text cannot select packages or alter their digests.

## Inspect a decision

Use the provider-neutral status surface instead of interpreting a Linear
activity or GitHub comment:

```bash
openthrottle status <provider-qualified-ticket-id>
openthrottle status <provider-qualified-ticket-id> --admission
```

The list view shows proposed/final route, semantic repairs, infrastructure
retries, actionable questions, planner/reviewer identity, admission,
effective-manifest, generated-plan and checkpoint digests, and task-branch and
publication state. The detail command returns the exact accepted plan and
reviewer receipt. Both require `OT_STATUS_TOKEN`; the detail is automatically
generated content that an operator must verify.

Planning actors are read-only. They cannot activate another generation, edit
or reroute the ticket, publish, mutate status, or answer their own
`needs_human`. To continue after `needs_human`, an authenticated operator must
resolve the listed questions in the control ticket and create a fresh
activation. The exact-base reserved `ot/*` branch follows the normal retention
policy and is not automatically deleted.

## Checkpoint and publication behavior

The supervisor reserves the OPE-187 task branch at the exact base before the
planner runs. Planning stages receive no write authority. After a route is
accepted, write stages advance only through acknowledged exact-SHA checkpoints;
the status checkpoint digest identifies the most recently acknowledged bundle.
PR creation and provider waiting begin only after the task branch reaches the
existing published state. A replacement sandbox restores the acknowledged
checkpoint and accepted plan rather than rerunning accepted planning work.

## Roll back

Changing `admission_mode` to `legacy` affects only future activations. It does
not stop an automatic instance that is already active.

For a full active-run rollback:

1. Pause new admission with the deploy-token-protected
   `POST /maintenance/admission/pause` endpoint.
2. Commit `admission_mode: legacy` for each repository that must stop using
   automatic admission, or remove the key to restore the legacy default.
3. Stop every active automatic ticket with `openthrottle stop <ticket>` and
   verify terminal cleanup in `openthrottle status <ticket>`.
4. Inspect retained task branches and any acknowledged checkpoint. Do not
   treat reservation/checkpoint state as publication evidence and do not
   delete retained exact-base branches as part of this procedure.
5. Resume admission with `POST /maintenance/admission/resume` only after the
   drain is clear and the legacy repository configuration is visible at the
   intended base.
