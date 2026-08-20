# Admission planner receipt shape

The `Receipt Authority Contract` is a source map. It is not the receipt itself.
Copy its objects and scalar fields into this exact nesting:

```json
{
  "receipt": {
    "schema": "openthrottle.receipt/v1",
    "type": "admission_decision",
    "assurance": "semantic_attested",
    "result": "<decision.route>",
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
    "evidence": ["<specific evidence supporting the route>"],
    "payload": {
      "decision": {
        "schema": "openthrottle.admission-decision/v1",
        "route": "<simple | structured | needs_human>",
        "rationale": "<bounded rationale>",
        "questions": [],
        "admission_basis_digest": "<sealed admission basis digest>",
        "effective_manifest_digest": "<sealed effective manifest digest>",
        "generated_plan_digest": null
      }
    },
    "issued_at": "<current UTC ISO 8601 timestamp>"
  },
  "execution_plan": null
}
```

The receipt has exactly ten top-level fields: `schema`, `type`, `assurance`,
`result`, `producer`, `subject`, `fence`, `evidence`, `payload`, and
`issued_at`. Never place any fence field beside them.

Replace every placeholder with the named contract value. Copy `generation` as
a number, not a string. Copy `native_session_id` and `skill_package_digest` as
their exact contract string-or-null values.

For `structured`, replace both nulls with the same canonical plan digest and an
artifact with this exact outer shape:

```json
{
  "schema": "openthrottle.admission-execution-plan-artifact/v1",
  "execution_plan": {
    "schema": "openthrottle.execution-plan/v2",
    "graph_id": "structured",
    "plan_id": "<stable plan id>",
    "units": [],
    "commands": []
  },
  "generated_plan_digest": "<canonical digest of execution_plan>",
  "producer": {
    "skill": "<contract.producer.skill>",
    "capability_digest": "<contract.producer.capability_digest>",
    "skill_package_digest": null
  },
  "assurance": "semantic_attested",
  "source": {
    "admission_basis_digest": "<sealed admission basis digest>",
    "effective_manifest_digest": "<sealed effective manifest digest>",
    "request_hash": "<contract.request_hash>"
  }
}
```

Populate `units` and `commands` with the complete v2 plan defined by the skill;
the empty arrays above show placement only and are not valid for a structured
decision. Copy `skill_package_digest` as its exact contract string-or-null
value. For `needs_human`, keep both receipt-envelope nulls and include at least
one specific question. For `simple`, keep both nulls and leave `questions`
empty.
