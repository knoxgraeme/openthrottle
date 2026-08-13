# Execution Plan Reference

The execution plan is a normalized runtime index over an implementation plan or
task specification. It is not a replacement for the source prose, and it does
not require any particular planning format or section names.

## Required Shape

```json
{
  "schema": "openthrottle.execution-plan/v1",
  "graph_id": "structured",
  "plan_id": "stable_plan_slug",
  "instructions": {
    "contracts_instructions": "Freeze the public schemas and validators described in the source plan."
  },
  "acceptance": {
    "contracts_acceptance": "The contracts package exports the required parser and validator entry points."
  },
  "units": [
    {
      "id": "contracts",
      "title": "Freeze contracts",
      "depends_on": [],
      "instructions": ["contracts_instructions"],
      "acceptance": ["contracts_acceptance"]
    }
  ],
  "commands": [
    { "name": "test", "unit": "contracts" },
    { "name": "build" }
  ]
}
```

## Deterministic Rules

- Emit closed JSON only. Unknown fields are rejected.
- Unit IDs, instruction IDs, acceptance IDs, and dependency IDs must be unique
  identifiers.
- Dependencies may reference only known units and must not form cycles.
- Unit instruction and acceptance arrays must reference keys in the top-level
  `instructions` and `acceptance` maps.
- Command names must reference repository command names, not shell strings.
- A command may name a unit only when the command is unit-scoped.
- Source headings and planning vocabulary are never parsed as runtime fields;
  only this fenced JSON contract is consumed by the structured pipeline.
- Keep graph topology and units immutable after validation; proposed splits or
  scope expansion require a human and a new validated plan.

## Validation

Always run:

```bash
openthrottle plan validate <plan-file> --json
```

The validator returns a canonical digest for the block. Include that digest in
the preparation result.
