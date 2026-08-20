# Admission reviewer receipt shape

The `Receipt Authority Contract` is a source map. It is not the receipt itself.
Return one receipt with this exact nesting:

```json
{
  "schema": "openthrottle.receipt/v1",
  "type": "admission_review",
  "assurance": "semantic_attested",
  "result": "<review.verdict>",
  "producer": {
    "worker_id": "<contract.producer.worker_id>",
    "skill": "<contract.producer.skill>",
    "capability_digest": "<contract.producer.capability_digest>",
    "skill_package_digest": null
  },
  "subject": {
    "base": "<contract.subject.base>",
    "pre": "<contract.subject.pre>",
    "post": "<contract.subject.post>"
  },
  "fence": {
    "pipeline_instance_id": "<contract.pipeline_instance_id>",
    "graph_digest": "<contract.graph_digest>",
    "unit_id": "<contract.unit_id>",
    "attempt_id": "<contract.attempt_id>",
    "parent_run_id": "<contract.parent_run_id>",
    "action_attempt_id": "<contract.action_attempt_id>",
    "generation": 0,
    "native_session_id": null,
    "request_hash": "<contract.request_hash>"
  },
  "evidence": ["<specific evidence supporting the verdict>"],
  "payload": {
    "review": {
      "schema": "openthrottle.admission-review/v1",
      "verdict": "<approved | rejected | needs_human>",
      "summary": "<bounded summary>",
      "findings": [],
      "questions": [],
      "admission_basis_digest": "<sealed admission basis digest>",
      "effective_manifest_digest": "<sealed effective manifest digest>",
      "generated_plan_digest": "<sealed candidate plan digest>"
    }
  },
  "issued_at": "<current UTC ISO 8601 timestamp>"
}
```

The receipt has exactly ten top-level fields: `schema`, `type`, `assurance`,
`result`, `producer`, `subject`, `fence`, `evidence`, `payload`, and
`issued_at`. Never place any fence field beside them. Replace every placeholder
with the named contract value. Copy `generation` as a number, not a string.
Copy `native_session_id` and `skill_package_digest` as their exact contract
string-or-null values. `approved` requires empty findings and questions.
`rejected` requires at least one finding and no human question. `needs_human`
requires at least one specific question.
