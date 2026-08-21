# Core pipelines

The authoritative pipeline definitions are filesystem files under
`.openthrottle/pipelines/core/`. These pages explain intent and operator-visible
behavior; they are not generated runtime inputs.

- [`core/implement`](core-implement.md) — ordinary whole-change delivery.
- [`core/investigate`](core-investigate.md) — evidence-led diagnosis and an
  optional convergent fix.
- [`core/structured`](core-structured.md) — bounded dependency-aware units,
  serial integration, and whole-change assurance.

Automatic admission is an application workflow that chooses one of these
pipelines and, for structured work, validates an execution plan. It is not a
separate user-authored pipeline. See
[`automatic-admission.md`](../runbooks/automatic-admission.md).

Every pipeline compiles into one immutable DefinitionBundle at the exact
admitted Git subject. Ordinary and structured paths execute through the same
Attempt, Record, Effect, and Checkpoint kernel.
