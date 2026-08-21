# `core/investigate`

Source: `.openthrottle/pipelines/core/investigate/pipeline.yml`

The investigation pipeline reproduces a reported problem, finds a concrete
causal boundary, and applies a scoped fix only when the evidence supports one.

```text
investigate(edit)
  |-- no_change --------------------------> no_change
  |-- needs_human ------------------------> needs_human
  `-- success -> publish(effect) -> provider(wait) -> completed
```

The investigator receives the stable `core/investigator` instructions, sealed
task prompt, and progressively disclosed `core/investigate` skill. Its edit
authority permits a convergent content fix but does not permit Git
administration, commits, publication, or unrelated cleanup.

The ResultCandidate must distinguish:

- evidence that reproduces the symptom;
- evidence connecting it to a cause;
- the scoped change, if any;
- local verification;
- uncertainty or a decision still required.

If the evidence does not justify a change, the action returns `no_change` or
`needs_human`; it does not invent a patch to keep the pipeline moving.

On success the executor checkpoints the exact output subject. Publication uses
that subject and one durable idempotency key. The provider wait accepts only
evidence bound to the published subject. Retryable work/publication/wait
failures have finite re-entry budgets; semantic output repair uses the same
native session and cannot alter the checkpointed tree.
