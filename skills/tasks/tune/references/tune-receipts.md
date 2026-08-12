# Typed Tune Receipts

The contracts are closed objects: do not add fields. Identifiers are stable
machine identifiers, digests are lowercase SHA-256, Git subjects are the exact
sealed values, and timestamps are ISO-8601 UTC.

## Receipt envelope

Both stages emit `openthrottle.receipt/v1` with the exact authority-provided
`assurance`, `producer`, `subject`, and `fence`, plus a bounded string array
`evidence`, a stage-specific payload, and `issued_at`.

The entire sealed artifact stays under 12 KiB. Never meet that bound by
truncating a typed contract; an oversize exact result is not a valid receipt.

- `tune_analysis` results: `success`, `failure`, `needs_human`. Payload keys:
  `summary`, `analysis`.
- `tune_proposal` results: `success`, `no_change`, `failure`, `needs_human`.
  Payload keys: `summary`, `proposal`.

No tune receipt carries semantic-review findings or supervisor gate results.

## Analysis

`openthrottle.tune-analysis/v1` contains exactly:

- `schema`, `id`, `intent`, `intent_digest`, `corpus_rows`, `corpus_digest`,
  `generated_at`.
- `intent` is the complete `openthrottle.tune-sealed-intent/v1`: `schema`,
  `id`, complete `task`, `task_digest`, `sealed_at`, `authority_digest`.
- `task` is the complete `openthrottle.tune-task/v1`: `schema`, `id`, `target`,
  `query`, `scope`, `window`, `baseline`, `policy`.
- A corpus row contains exactly `id`, `pipeline_instance_id`, `generation`,
  nullable `execution_graph_id`, `outcome`, `closed_reason`, nullable
  `fault_attribution`, `created_at`, non-empty `source_digests`, `row_digest`.

The row digest covers the row without `row_digest`. The corpus digest covers
the exact row array. Rows must satisfy the sealed query and window, must not
duplicate an id or pipeline-instance/generation pair, and cannot exceed the
smaller of `task.query.limit` and `task.window.limit`.

## Proposal

`openthrottle.tune-proposal/v1` contains exactly:

- `schema`, `id`, complete `analysis`, `analysis_digest`, `target`, `query`,
  `scope`, `window`, `baseline`, `policy`, `outcome`, `changes`,
  `citation_contract`, `ratchet_input`.
- `target`, `query`, `scope`, `window`, `baseline`, and `policy` are exact copies
  of `analysis.intent.task`. `analysis_digest` is the canonical digest of the
  embedded complete analysis.
- `outcome` is `propose`, `no_change`, or `needs_human`. Only `propose` may have
  changes, and it must have at least one.
- Each unique change contains exactly `path`, `operation` (`add`, `modify`, or
  `delete`), nullable `before_digest`, nullable `after_digest`, and `rationale`.
  Its path must be allowed and the total cannot exceed `max_changed_files`.

The citation contract is a complete `openthrottle.citation-contract/v1` with
exactly `schema`, `id`, `summary`, `claims`, `citations`, `dispositions`, and
`grades`. Each claim has `id`, `text`, `citation_ids`. Each citation has `id`,
an allowlisted analysis-run `query`, exact `expected_result`, and non-empty
`source_digests`. Each disposition has `claim_id`, `disposition`, `rationale`,
`citation_ids`; every claim has exactly one. Each grade has `id`, `value`,
`disposition_claim_ids`, `rationale`; all dispositions are graded. All
references resolve, and every expected result/source digest exists in the
sealed analysis corpus.

The ratchet input is a complete `openthrottle.ratchet-contract/v1` with exactly
`schema`, `id`, `pinned`, `proposed`, optional paired config/graph/repository
skill values, nullable `human_authority`, and nullable `tuner_authority`.
Pinned/proposed artifact entries use `id`, `kind`, `artifact_digest`, and
`provenance_digest`. Tuner authority uses `tuner_id`, `proposal_digest`, and
`model_digest`; its `proposal_digest` is the canonical citation-contract digest.
The differential input must be directly comparable and preserve or tighten
the pinned gates, scopes, and resource policy.
