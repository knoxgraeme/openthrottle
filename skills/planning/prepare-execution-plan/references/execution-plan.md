# Execution Plan Reference

The execution plan is a normalized runtime index over a CE unified plan. It is
not a replacement for the plan prose.

## Required Shape

```json
{
  "schema": "openthrottle.execution-plan/v1",
  "graph_id": "structured",
  "plan_id": "stable_plan_slug",
  "instructions": {
    "u1_instructions": "Human-readable pointer to the source plan slice."
  },
  "acceptance": {
    "u1_acceptance": "Requirement, acceptance-example, and verification references."
  },
  "units": [
    {
      "id": "u1",
      "title": "U1. Freeze contracts",
      "depends_on": [],
      "instructions": ["u1_instructions"],
      "acceptance": ["u1_acceptance"]
    }
  ],
  "commands": [
    { "name": "test", "unit": "u1" },
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
- Keep graph topology and units immutable after validation; proposed splits or
  scope expansion require a human and a new validated plan.

## Validation

Always run:

```bash
openthrottle plan validate <plan-file> --json
```

The validator returns a canonical digest for the block. Include that digest in
the preparation result.
