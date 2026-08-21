# `core/implement`

Source: `.openthrottle/pipelines/core/implement/pipeline.yml`

The ordinary implementation pipeline delivers one approved whole change. Its
agents share the same exact DefinitionBundle but receive separate native
sessions and the minimum repository authority for each action.

```text
implement(edit)
  -> review(inspect) --blocking--> repair(edit) --+
  -> simplify(edit)                                |
  -> post_simplify_review(inspect) --blocking------+
  -> test(command) -> lint(command) -> build(command)
  -> publish(effect) -> provider(wait)
  -> completed
```

## Actions

| Action | Authority | Definition | Purpose |
|---|---|---|---|
| `implement` | `edit` | ordinary worker + `core/implement-plan` | implement the sealed request and leave a verified content tree |
| `review` | `inspect` | reviewer + `core/review-change` | inspect the exact accepted implementation subject |
| `repair` | `edit` | ordinary worker + `core/implement-plan` | remediate only validated blocking findings or command failures |
| `simplify` | `edit` | ordinary worker + `core/simplify-change` | reduce avoidable complexity without changing behavior |
| `post_simplify_review` | `inspect` | reviewer + `core/review-change` | verify the exact simplified subject |
| `test`, `lint`, `build` | command | named repository config commands | produce executor-authored deterministic command results |
| `publish` | effect | `core/publish@1` | publish only the expected exact subject with one idempotency key |
| `provider` | wait | `core/provider-wait@1` | settle from exact GitHub/provider evidence |

Reviewers never apply small fixes. A blocking review DecisionRecord schedules
the separate `repair` Attempt. The review action receives the accepted edit
Checkpoint boundary and cannot make the repository writable.

Each edit action may return `no_change`, a semantic repair request, a human
block, a retryable infrastructure outcome, or failure as allowed by its eval.
Re-entry counts are bounded in the authored definition. Exhausted semantic
repair ends at `needs_human`; exhausted infrastructure retries end at `failed`.

The agent returns a semantic ResultCandidate. The executor captures the tree,
normalizes/validates the candidate, authors the ResultRecord, and runs the pure
reducer. An invalid output shape can enter result-only correction without
rerunning successful implementation.

Publication is impossible until both inspect reviews and all configured command
Attempts settle successfully. `no_change` at initial implementation or
publication terminates without creating a pull request.
