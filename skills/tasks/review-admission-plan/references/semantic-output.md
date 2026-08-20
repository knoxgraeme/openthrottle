# Admission reviewer semantic output

Return exactly these four keys and no wrapper:

```json
{
  "verdict": "approved | rejected | needs_human",
  "summary": "bounded review summary",
  "findings": [],
  "questions": []
}
```

`approved` has no findings or questions. `rejected` has at least one anchored
finding and no human question. `needs_human` has at least one specific question.
Every finding has exactly this shape:

```json
{
  "severity": "P0 | P1 | P2 | P3",
  "message": "specific correctable defect",
  "path": "optional repository path"
}
```

For example, a rejected review may return:

```json
{
  "verdict": "rejected",
  "summary": "The plan omits a required failure-path check.",
  "findings": [
    {
      "severity": "P1",
      "message": "Unit api_change does not test the ticket-required unauthorized response.",
      "path": "supervisor/src/http/routes.ts"
    }
  ],
  "questions": []
}
```

Do not emit receipt or mechanical authority fields; the executor owns them and
binds the review to the sealed candidate plan digest.
