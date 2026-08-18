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

## Prove admission before enabling it

The credential-free walking skeleton is the release-blocking mechanical proof:

```bash
docker build -f sandbox/Dockerfile -t openthrottle:automatic-admission .
node sandbox/tests/automatic-walking-skeleton.mjs openthrottle:automatic-admission
```

It proves the `simple`, reviewed `structured`, locked-route, `needs_human`,
invalid-binding, and repository planner/reviewer override paths. It also invokes
the existing structured walking skeleton unchanged for crash recovery,
checkpoint restoration, secret containment, publication fencing, and the full
unit lifecycle. It uses stub model credentials only, runs its Docker probe with
networking disabled, scans exported evidence for secret-shaped values, and does
not call Linear, GitHub, Daytona, Fly, or a live model.

The blinded model evaluation is a separate, credentialed operator ticket. Do
not run it in CI and do not enable automatic admission as part of collecting
it. Use these pinned inputs:

- `contracts/fixtures/admission-corpus/v1/cases.json` contains 45 synthetic,
  redacted cases: 15 cohesive simple, 15 cross-component structured, and 15
  ambiguous or missing-authority cases. Give evaluators this file only.
- Keep `labels.json` sealed from both planner and reviewer contexts until all
  repetitions finish. `manifest.json` pins both files and the combined corpus.
- Pin one Sol model and one Opus model, including exact model identifier and
  reasoning level. Run every case three times for every model, producing at
  least 270 decision records.
- Record the corpus digest plus runtime, automatic-template, compiler, planner
  package, reviewer package, and effective-manifest digests. A change to any
  governing digest invalidates the evidence instead of silently carrying it
  forward.
- Record route, generated-plan digest, structured-review approval, latency,
  input tokens, output tokens, and `cost_usd_micros` for every repetition. Never
  place prompts, ticket text, environment values, or credentials in the result.

Build and score the evidence with the exported contracts functions
`validateAdmissionEvaluationCorpus`, `validateAdmissionRolloutEvidence`, and
`scoreAdmissionRolloutEvidence`. The report applies the worst repetition for each
case/model pair. Each model must independently achieve at least 90% accuracy,
at most 10% `needs_human` on unambiguous cases, zero `simple` decisions for
structured or ambiguous cases, zero executable decisions for ambiguous cases,
and an approved independent review for every structured output. The report also
retains repeated-`needs_human` rate and per-model latency, token, and cost totals
for operator review.

Before a canary, an operator must inspect the blinded report, confirm every
structured output has an approval receipt, confirm the evidence is current for
the deployed digests, and attach it to the separate rollout ticket. Rehearse
the rollback below, then enable one explicitly selected repository, monitor its
admission details and publication state, and expand only through separate
configuration changes. This repository change supplies proof machinery only;
it does not change the default mode or enable a repository.

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
