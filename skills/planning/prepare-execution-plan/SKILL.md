---
name: prepare-execution-plan
description: Convert a completed CE unified plan into one validated OpenThrottle execution-plan block.
---

# Prepare Execution Plan

Use this skill only at planning time, against a completed CE unified plan. The
output is a single fenced JSON block with schema
`openthrottle.execution-plan/v1`; the runtime consumes that block, while the
plan prose remains the human-authoritative source.

## Workflow

1. Read the plan metadata, Goal Capsule, Product Contract, Implementation Units,
   Verification Contract, Definition of Done, and any explicit execution
   contract.
2. Read `references/execution-plan.md` before drafting JSON.
3. Preserve the plan's semantic decomposition:
   - Preserve stable authored U-IDs in titles and reference text; normalize
     runtime `units[].id` and dependency IDs to the lowercase identifier form
     accepted by the frozen contract, such as `u1` or `u4a`.
   - Keep declared dependency order; infer a dependency only when the plan text
     directly states it.
   - Reference existing requirement, flow, acceptance-example, verification, or
     Definition-of-Done IDs when present.
   - Do not invent product requirements, acceptance criteria, commands, or unit
     splits.
4. Write or replace exactly one fenced block:

   ```text
   ```json openthrottle.execution-plan/v1
   { ... }
   ```
   ```

5. Run `openthrottle plan validate <plan-file> --json`.
6. If validation fails because the JSON is structurally wrong, repair the block
   and validate again. If the plan is semantically ambiguous, stop and surface a
   decision instead of guessing.

## Ambiguity Rules

Return a human decision request when any of these are unresolved:

- a unit has no stable ID or combines multiple incompatible scopes;
- dependency order has more than one defensible interpretation;
- required verification commands are unnamed or conflict with repository config;
- acceptance references are missing for behavior-bearing units;
- the chosen graph requires capabilities the repository graph does not declare.

## Completion

Report the validation command and digest. Success means the plan contains
exactly one valid `openthrottle.execution-plan/v1` block and no unresolved
semantic ambiguity remains.
