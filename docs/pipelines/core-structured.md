# `core/structured`

Source: `.openthrottle/pipelines/core/structured/pipeline.yml`

The structured pipeline executes one validated
`openthrottle.execution-plan/v2` as bounded dependency-aware units. It uses the
same kernel as ordinary work; loop items and reviewer personas are scoped
Attempts rather than a second coordinator model.

## Unit cycle

```text
ready unit
  -> implement_unit(edit)
  -> simplify_unit(edit)
  -> unit_test(command) -> unit_lint(command) -> unit_build(command)
  -> accept_unit(inspect)
       |-- blocking --> repair_unit(edit) --> simplify_unit
       `-- accepted --> integrate_unit(effect)
```

The pipeline-local `loops/unit-cycle.yml` keeps this longer body readable. Its
`execution_plan.units` selector, maximum parallelism, and maximum rounds are
sealed in the DefinitionBundle.

Dependencies determine which units are eligible, but this release executes
eligible unit Attempts serially. The complete bounded dependency frontier
remains durable and visible; width one changes overlap, not plan cardinality.
Each Attempt has a stable scope/member identity and receives only the ordered
Result, Decision, and Checkpoint evidence of its dependencies. Unit workers
cannot see or modify sibling worktrees.

The unit lead uses inspect authority and decides only whether the exact unit
candidate matches that unit's scope, acceptance criteria, and verification
obligations. It is not whole-change review and cannot repair. A rejection
schedules `repair_unit` with edit authority.

`integrate_unit` is an executor Effect. It accepts only a unit candidate whose
lead DecisionRecord and Checkpoint are exact and settled. Integration is serial
against the run's current subject. It records delivery evidence and either
selects the next accepted integration, exposes newly ready units, or advances
to whole-change gates.

## Whole-change assurance

```text
all units integrated
  -> final_test -> final_lint -> final_build
  -> select_review_personas(inspect)
  -> persona_review(inspect serial fanout)
  -> validate_review_findings(inspect)
       |-- confirmed blockers --> final_repair(edit) --> final_test
       `-- clear -------------> publish(effect) -> provider(wait)
```

The eval may select up to five allowlisted personas. Every selected persona
receives a stable scoped inspect Attempt and remains visible in status/evidence;
the width-one dependency chain executes them serially against the same exact
integrated subject. The selector cannot name a new agent or skill. Current
lenses include correctness/dataflow, tests/contracts, reliability, agent-native
contracts, security, data changes, performance, and project standards.

Finding validation independently re-inspects proposed blockers. Only confirmed
blocking evidence can schedule `final_repair`; advisory findings remain
evidence without transition authority. Repair is a distinct edit Attempt, then
all whole-change commands and reviews repeat within finite budgets.

## Recovery invariants

- The exact execution plan is parsed from the immutable task prompt, not
  reconstructed from mutable history.
- Restart planning selects settled Attempts by exact run, DefinitionBundle,
  parent, group, stage, and member identity.
- Accepted unit work is never inferred from prose; it requires direct Result,
  Decision, and Checkpoint pointers.
- A stale unit base cannot overwrite the current integration subject.
- Result-shape correction preserves the exact Attempt, unit Checkpoint, subject,
  and native session; it never reruns implementation merely to repair JSON.
- `repair_unit` and `final_repair` are distinct edit successors with
  `native_session_id: null`, exact rejection evidence, and the accepted
  Checkpoint boundary. Each binds a fresh session when it starts.
- Stop, failure, human intervention, or retry exhaustion must stop and clean a
  confirmed Daytona resource before terminal settlement.
