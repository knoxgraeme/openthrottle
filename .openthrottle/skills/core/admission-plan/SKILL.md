---
name: admission-plan
description: Use when classifying an implementation request and, when warranted, decomposing it into independently executable plan units.
---

# Classify and decompose implementation work

Decide whether a request is one cohesive implementation, needs structured
units, or lacks a material product decision. Read `references/route-rubric.md`
for the classification boundary.

## Method

1. Reduce the request to required behaviour, acceptance boundaries, likely
   repository areas, and executable verification. Inventory explicit source
   requirement or acceptance IDs before decomposing it.
2. Prefer one cohesive unit when one implement-review-verify cycle can own the
   whole change. Use structured units when boundaries are independently
   implementable, ordered, or safely parallelizable.
3. Treat missing product, contract, security, migration, destructive, or
   acceptance decisions as genuine questions. Do not manufacture an answer to
   make the plan executable.
4. Keep decomposition within the request. Adjacent cleanup and speculative
   architecture are observations, not plan units.

## Structured-plan craft

- Keep units independently implementable or explicitly ordered with
  `depends_on`. Dependencies must name real unit ids and remain acyclic.
- Keep the plan within the bounded ticket. Do not add product features,
  architecture rewrites, migrations, dependencies, cleanup, or rollout work
  that the ticket does not require.
- Preserve explicit source requirement or acceptance IDs verbatim in every
  structured unit that owns their meaning. Keep the complete obligation beside
  its ID, never replace source meaning with an ID-only pointer, invent an ID, or
  reuse one ID for conflicting obligations.
- Name plausible repository-relative files. A path is a planning prediction,
  not permission to create it. Never include paths outside the repository.
- Include success, boundary, and failure tests where applicable. Verification
  names runnable commands or focused checks that exist in the repository's
  compiled facts; do not invent commands or claim they ran.
- Every `execution_plan.commands[].name` must be one of the sealed repository
  `command_names` keys, such as `test`, `lint`, or `build`. Use the key exactly;
  never copy its shell command value or invent a command name. If the sealed
  list is empty, return an empty `commands` array.
- Use one stable `plan_id`, `pipeline_id: "core/structured"`, and the exact v2 fields.
  Keep the canonical plan JSON at or below 256 KiB.
