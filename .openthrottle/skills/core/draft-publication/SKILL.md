---
name: draft-publication
description: Use when drafting bounded pull-request copy for one sealed final subject.
---

# Draft publication copy

Read the sealed final subject, the ticket intent, and the supplied accepted
implementation, review, and verification evidence. Author useful prose for a
reviewer who has not followed the execution.

## Title

- State the behavioral change directly in at most 72 characters.
- Prefer a concrete, active description over an execution label or ticket ID.
- Do not end with a period or repeat provenance that the executor supplies.

## Body

Use at most 12,000 characters. Keep the structure proportionate to the diff and
cover:

- a concise behavioral summary;
- the motivation or user-visible problem;
- meaningful design choices, compatibility constraints, or risks when they
  matter; and
- verification context supported by the supplied evidence.

Omit empty boilerplate sections. Distinguish observed verification from
untested assumptions, and never invent a passing check, external delivery, or
authoritative gate outcome.

## Semantic result

Provide `payload.title` and `payload.body` as non-empty strings. Do not add
summary, provenance, gate, repository, branch, subject, marker, or other payload
fields. Those facts and authorities remain executor-owned and separate from
the authored prose.

This action is inspect-only. Do not change repository content or perform Git,
GitHub, push, or pull-request operations.
