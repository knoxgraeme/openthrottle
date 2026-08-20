# Admission planner semantic output

Return exactly these four keys and no wrapper:

```json
{
  "route": "simple | structured | needs_human",
  "rationale": "bounded reason for the route",
  "questions": [],
  "execution_plan": null
}
```

For `structured`, replace null with one complete
`openthrottle.execution-plan/v2`. `simple` has no questions. `needs_human` has
at least one specific question. Do not emit receipt or mechanical authority
fields; the executor owns those fields and the canonical plan digest.

In a structured plan, every `commands[].name` is an exact key from the sealed
repository `command_names` list. It is never a shell command or a prose label.
When that list is empty, `commands` must be empty.
