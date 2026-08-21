# OpenThrottle skills and agent instructions

OpenThrottle separates stable role identity from reusable procedure.

- `.openthrottle/agents/<id>/instructions.md` defines how an agent should think
  and the limits of its role.
- `.openthrottle/skills/<id>/SKILL.md` defines a procedure that a pipeline may
  disclose for one action.
- The sealed action prompt supplies the task, exact subject, selected context,
  and output contract.

An agent therefore starts with **instructions + task prompt + an allowlist of
progressively disclosed skills**. A `SKILL.md` is not the agent's standing
system prompt, and an agent file does not enumerate all procedures it might ever
use.

## Layout

```text
.openthrottle/
  agents/<namespace>/<name>/instructions.md
  skills/<namespace>/<name>/SKILL.md
  skills/<namespace>/<name>/references/<file>.md
  pipelines/<namespace>/<name>/pipeline.yml
  evals/<namespace>/<name>/eval.yml

skills/
  planning/<name>/SKILL.md       # local plan authoring
  operator/<name>/SKILL.md       # local interactive operation
  codex/AGENTS-fragment.md       # sandbox-wide Codex safety context
```

Core runtime definitions are maintained under `.openthrottle/` and released as
a sealed platform catalog. A repository can use those platform definitions or
provide repository-owned definitions in the same layout. The `core/` namespace
is reserved for the platform.

Files under `skills/planning/` and `skills/operator/` are not pipeline runtime
definitions. The CLI installs them for a human's local agent. They may help
author a plan, prepare a structured execution plan, trigger a run, or monitor a
run, but they do not gain supervisor transition authority.

## Agent instructions

An instruction file is plain Markdown without skill frontmatter. Keep it short
and stable. It should state:

- the role's judgment boundary;
- whether it reasons about a whole change, one unit, or one admission decision;
- what it must not decide;
- the fact that the executor owns Git, identity, state, and external effects.

Repository authority is compiled from the pipeline, not inferred from prose.
Writing “do not edit” in instructions is useful guidance but is not the
security boundary.

Current core roles are:

- `ordinary-worker` — whole-change implementation, simplification, and repair;
- `investigator` — evidence-led diagnosis and a scoped convergent fix;
- `unit-worker` — implementation, simplification, or repair of one structured
  unit;
- `unit-lead` — narrow read-only unit acceptance;
- `reviewer` — read-only whole-change or persona review;
- `admission-planner` and `admission-reviewer` — independent read-only route and
  plan judgments.

Do not create one agent per review lens. The reviewer role is stable; security,
correctness, reliability, performance, project standards, and other lenses are
skills selected per action.

## Runtime skills

Every runtime skill is self-contained and agent-neutral. Its YAML frontmatter
declares only skill metadata; its body and referenced files carry the procedure.
The compiler includes the exact selected package bytes in the DefinitionBundle.
The sandbox materializes only that allowlist.

A skill should contain:

1. when and how to apply the procedure;
2. a bounded sequence or rubric;
3. evidence expectations;
4. uncertainty and escalation rules;
5. references used only when the procedure needs deeper detail.

Keep role language in `instructions.md`. Keep action-specific task facts in the
sealed prompt. Keep deterministic validation in an eval or executor primitive.
Do not ask the model to reproduce request hashes, subjects, bundle hashes,
timestamps, session IDs, or other executor-owned identity.

References provide native progressive disclosure. A `SKILL.md` may point to its
own `references/` files; the runtime must make those files available without
inlining every reference into the initial prompt. A skill cannot discover an
unlisted sibling package or widen tools, MCP servers, credentials, repository
scope, or repository authority.

Core procedures currently cover:

- ordinary implementation, review, simplification, and investigation;
- structured unit implementation, simplification, acceptance, and repair;
- whole-change repair;
- reviewer-persona selection, focused review lenses, and finding validation;
- automatic admission planning and independent plan review.

Pipeline files own ordering, loops, bounds, retries, remediation, commands,
publication, and provider waits. Skills never call another orchestration system
or run an end-to-end pipeline themselves.

## Evals and semantic output

Every agent stage names one `.openthrottle/evals/<id>/eval.yml`. The eval binds:

- the allowed semantic outcomes;
- the bounded payload fields and types;
- a registered deterministic evaluator;
- any explicitly allowed normalization.

The agent submits only `openthrottle.result-candidate/v1`. The executor validates
and normalizes it, then authors the authoritative ResultRecord. For example,
core result schemas allow `string-array-to-newlines/v1` on `payload.summary`;
an array is joined with newlines and the transformation hashes are recorded.

If output remains invalid, successful work is retained at its checkpoint and
the same native session receives one bounded result-correction action. That
action has inspect authority, no provider access or MCP, and only the
`ot-result` tool. A formatting correction never reruns implementation.

## Inspect and edit actions

Skills do not own repository authority:

| Authority | Repository view | Typical skills |
|---|---|---|
| `inspect` | immutable exact-subject checkout, disabled remotes, native read-only tools | planning, review, selection, acceptance, validation, result correction |
| `edit` | isolated writable content tree, executor-owned Git metadata | implementation, simplification, investigation fix, remediation |

Inspect actions may use native read/search CLI features. They may not make the
repository writable. Tests or builds that create artifacts execute as separate
deterministic command Attempts. A blocking reviewer result schedules an edit
Attempt rather than applying a small fix in the review context.

No action may commit, push, publish, open a pull request, or claim an external
mutation. The executor captures changed content, computes the exact output
subject, integrates accepted checkpoints, and drains Effects.

## Delivery by engine

The same selected instruction and skill bytes are delivered to every supported
engine:

| Engine | Delivery |
|---|---|
| Claude | materialize the sealed packages in the action's private Claude skill root and invoke the entry skill explicitly |
| Codex | materialize the sealed packages in the action's admin-owned Codex skill root and invoke the entry skill explicitly |
| OpenCode | materialize a sealed native skill root; capability admission fails if selective disclosure cannot be enforced |

Engine adapters may change delivery mechanics only. They must not maintain a
second copy of instructions or skill bodies and must not inline the full
allowlist as a fallback.

Native session continuation is action context. The executor binds the provider
session ID to the live Attempt before work can finish. Result correction uses
that same session; retries clear it unless the pipeline explicitly requests a
correction of completed work.

## Authoring checklist

When adding or changing a runtime procedure:

1. Decide whether this is stable role behavior (`agents/`) or reusable action
   procedure (`skills/`).
2. Reference the skill and eval from a pipeline stage; do not add a registry
   row or hard-coded capability map.
3. Keep the stage's `repository_authority` minimal and explicit.
4. Make the semantic schema bounded and put deterministic repair in the eval.
5. Compile from both filesystem and exact-Git readers and compare bundle bytes.
6. Test selective disclosure for Claude, Codex, and OpenCode.
7. Test that agent output cannot move Git or supervisor state without reducer
   validation.

Runtime definitions must not depend on Compound Engineering or another
second-hop toolkit. If a procedure is important to an OpenThrottle action, keep
its necessary craft in the selected OpenThrottle skill package.
