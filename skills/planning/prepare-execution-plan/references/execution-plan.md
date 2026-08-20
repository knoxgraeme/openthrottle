# Execution Plan Reference

The execution plan is the complete runtime authority for a structured run. It
is not an index into the source plan or task specification: a dispatched unit
worker never sees the source prose, so every applicable value the worker needs
must be copied into the unit itself. It does not require any particular
planning format or section names -- only that the source define enough detail
to fill every field below without guessing.

## Required Shape

```json
{
  "schema": "openthrottle.execution-plan/v2",
  "pipeline_id": "core/structured",
  "plan_id": "stable_plan_slug",
  "units": [
    {
      "id": "contracts",
      "title": "Freeze contracts",
      "depends_on": [],
      "objective": "Freeze the closed public schemas and validators this run depends on.",
      "requirements": [
        "Reject unknown fields on every object in the contract.",
        "Keep canonical JSON output deterministic regardless of authored key order."
      ],
      "files": [
        "contracts/src/execution-plan.ts",
        "contracts/src/index.ts"
      ],
      "approach": [
        "Add the new field to the existing contract type and its parser.",
        "Export the updated parser and validator from the package barrel."
      ],
      "tests": [
        "A valid fixture with the new field parses and normalizes to a stable digest.",
        "A fixture missing the new field is rejected and names the field."
      ],
      "acceptance": [
        "The contracts package exports the required parser and validator entry points."
      ],
      "verification": [
        "Run the contracts package test suite and confirm the new fixtures pass."
      ]
    }
  ],
  "commands": [
    { "name": "test", "unit": "contracts" },
    { "name": "build" }
  ]
}
```

## Field Meaning

Every behavior-bearing unit carries all seven fields directly -- copy the
source's meaning into each one; do not summarize it away or point back at the
source ("see above", "as described in the plan", "follow the requirements
above" are never valid values here, because the field they'd occupy must
instead hold the actual requirement, file, step, or check).

- `objective` -- one paragraph stating what this unit accomplishes and why.
- `requirements` -- the specific, applicable requirements this unit must
  satisfy, copied from the source in full, not abbreviated to a reference.
- `files` -- the files or paths this unit is expected to touch.
- `approach` -- the implementation steps or design the unit should follow.
- `tests` -- the test scenarios (new or adjusted) that prove the behavior.
- `acceptance` -- the concrete, checkable conditions that define done.
- `verification` -- how to confirm the unit works: commands to run, behavior
  to observe, or evidence to collect.

There is no separate top-level map to point into: every array above holds the
actual text, not an identifier. Ordinary sentences that happen to describe
targets or protocols (`"see that latency stays under 200ms"`, `"refer clients
to error code 429"`) are completely normal content for these fields -- nothing
in this contract classifies natural language, so write in whatever plain
English the requirement, step, or check actually needs.

## Deterministic Rules

- Emit closed JSON only. Unknown fields are rejected.
- Unit IDs and dependency IDs must be unique identifiers.
- Dependencies may reference only known units and must not form cycles.
- Every behavior-bearing unit's `requirements`, `files`, `approach`, `tests`,
  `acceptance`, and `verification` arrays must be non-empty; each holds
  applicable text copied from the source, not a placeholder.
- Command names must reference repository command names, not shell strings.
- A command may name a unit only when the command is unit-scoped.
- Source headings and planning vocabulary are never parsed as runtime fields;
  only this fenced JSON contract is consumed by the structured pipeline.
- Keep pipeline topology and units immutable after validation; proposed splits or
  scope expansion require a human and a new validated plan.

## Sealed v1 Plans

`openthrottle.execution-plan/v1` (units carrying `instructions`/`acceptance`
IDs that index into a plan-level map) is a frozen, already-sealed format kept
only for deterministic replay of runs admitted before this contract existed.
Never author a new v1 block; `openthrottle plan prepare` always writes v2.

## Validation

Always run:

```bash
openthrottle plan validate <plan-file> --json
```

The validator returns a canonical digest for the block. Include that digest in
the preparation result.
