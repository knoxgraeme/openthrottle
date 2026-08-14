---
name: prepare-execution-plan
description: Convert a completed implementation plan or task specification into one validated OpenThrottle execution-plan block for a structured run.
---

# Prepare Execution Plan

Use this skill at planning time against a completed implementation plan or task
specification. Its surrounding format and section names do not matter. The
source must define enough scope, ordering, requirements, acceptance, tests,
and verification detail to fill every unit's fields without guessing.

The output is a single fenced JSON block with schema
`openthrottle.execution-plan/v2`. That block is the complete runtime authority
for the run: a dispatched unit worker only ever sees its own unit's fields,
never the source prose, so every applicable value must be materialized into
the unit directly. The source prose remains the human-authored input this
skill reads, not something the runtime reads back.

## Workflow

1. Read the complete source and identify its goal and scope, implementation
   units or workstreams, dependencies, requirements, file scope, implementation
   approach, test scenarios, acceptance criteria, and verification steps.
   These may use any headings or document structure.
2. Read `references/execution-plan.md` before drafting JSON.
3. Preserve the plan's semantic decomposition:
   - Preserve stable authored unit IDs when present. Otherwise derive concise,
     stable lowercase IDs from unambiguous unit titles. Do not invent a split
     merely to create units.
   - Normalize runtime `units[].id` and dependency IDs to the identifier form
     accepted by the frozen contract, such as `contracts` or `api_tests`.
   - Keep declared dependency order; infer a dependency only when the plan text
     directly states it.
   - For every behavior-bearing unit, copy the source's applicable meaning
     directly into that unit's `objective`, `requirements`, `files`,
     `approach`, `tests`, `acceptance`, and `verification` fields in full. A
     value that only points back at the source ("see above", "as described in
     the plan") is never acceptable -- write the actual requirement, file,
     step, or check in the field itself.
   - Do not invent product requirements, acceptance criteria, commands, or unit
     splits.
4. Write or replace exactly one fenced block:

   ```text
   ```json openthrottle.execution-plan/v2
   { ... }
   ```
   ```

5. Run `openthrottle plan validate <plan-file> --json`.
6. If validation fails because the JSON is structurally wrong, repair the block
   and validate again. If the plan is semantically ambiguous, stop and surface a
   decision instead of guessing.

## Ambiguity Rules

Return a human decision request when any of these are unresolved:

- a unit boundary is unclear, combines incompatible scopes, or cannot receive a
  stable ID without choosing between competing decompositions;
- dependency order has more than one defensible interpretation;
- required verification commands are unnamed or conflict with repository config;
- requirements, files, approach, tests, acceptance, or verification content is
  missing for a behavior-bearing unit;
- the chosen graph requires capabilities the repository graph does not declare.

## Completion

Report the validation command and digest. Success means the plan contains
exactly one valid `openthrottle.execution-plan/v2` block and no unresolved
semantic ambiguity remains.
