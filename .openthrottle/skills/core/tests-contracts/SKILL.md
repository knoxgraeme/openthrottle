---
name: tests-contracts
description: Use when reviewing whether changed behaviour has executable proof and cross-boundary contracts remain compatible.
---

# Tests and contracts review

Evaluate the proof carried by the change and the compatibility of every public
or persisted contract it touches.

## Review method

- Map each changed behaviour to a test that would fail if the behaviour were
  absent or wrong.
- Check meaningful success, rejection, failure, empty, and boundary cases.
- Prefer assertions on observable outcomes over collaborator-call assertions or
  “does not throw” coverage.
- Require at least one real cross-layer path when the change alters an
  interaction; substituted collaborators cannot prove the interaction itself.
- Compare changed signatures, return values, error classes, configuration,
  command semantics, serialized forms, JSON schemas, and persisted records with
  every direct consumer.
- Check compatibility for omitted fields, defaults, legacy values, and version
  transitions where existing callers or data can still reach the code.

## Finding bar

A finding must name the changed behaviour or contract, the missing or misleading
proof, the path and stable symbol involved, and the observable regression that
could escape. Explain why the current test would still pass when the defect is
present.

Use stable semantic anchors rather than line numbers. Rank concrete contract
breaks and false-confidence tests above general coverage suggestions.

## Exclusions

Do not report coverage percentages, snapshot taste, import order, test naming,
private-helper tests when public behaviour is already proven, unchanged gaps,
or additive optional fields whose defaults preserve compatibility.
