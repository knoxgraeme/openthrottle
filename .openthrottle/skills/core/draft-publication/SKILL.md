---
name: draft-publication
description: Use when authoring bounded pull-request title and body copy for one exact final accepted subject.
---

# Draft publication copy

Author pull-request prose for the exact subject in the sealed action. Inspect
the final diff and bounded evidence closely enough to explain what a reviewer
needs to know, but do not change the repository or perform publication work.

## Compose the copy

1. Write a concise title that names the observable behavioral change. Keep it
   nonempty and at most 72 characters.
2. Write a body that concisely summarizes the behavior and explains its
   motivation.
3. Include meaningful design choices, compatibility implications, or risk
   notes in proportion to the diff. Do not manufacture concerns when none are
   material.
4. Include useful verification context supported by the sealed evidence. Do
   not invent checks, claim executor verification authority, or embed run,
   ticket, gate, ownership, branch, or repository provenance as if the prose
   were authoritative.
5. Keep the body nonempty and at most 12,000 characters. Prefer clear Markdown
   and omit boilerplate that does not help a reviewer.

## Semantic result

Return one successful `openthrottle.result-candidate/v1` candidate with exactly
`payload.title` and `payload.body`. Both values must be strings; do not add
summary, provenance, verification, metadata, or other fields. If the result is
rejected for shape or bounds, correct only the semantic result against the same
locked subject; do not redo implementation, review, or command work.

This skill grants no Git, credential, provider, push, or pull-request mutation
authority. The supervisor constructs and schedules publication separately.
