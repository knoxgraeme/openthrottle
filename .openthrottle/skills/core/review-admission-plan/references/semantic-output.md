# Writing the admission review

Keep the conclusion compact and semantic. It should contain:

- one clear disposition: approve, reject for correctable defects, or escalate
  for missing source authority;
- a short summary explaining the decisive evidence;
- anchored findings for every correctable defect; and
- specific questions only when the source request is genuinely incomplete or
  contradictory.

An approval has no findings or open questions. A correctable rejection has at
least one finding and does not ask a person to solve work the planner can fix.
An escalation names the exact missing decision and why repository evidence
cannot settle it.

## Findings

Each finding should state:

1. the source requirement, acceptance condition, or plan invariant involved;
2. the unit, dependency edge, verification command, or repository path where
   the defect occurs;
3. the concrete omission, contradiction, unsupported expansion, or
   implausibility; and
4. the observable consequence for implementation or acceptance.

Rank findings by impact. Avoid vague advice, proposed rewrites, duplicated
claims, and large excerpts of the candidate plan.
