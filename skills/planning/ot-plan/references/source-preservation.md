# Source Preservation

Maintain a source ledger so planning cannot silently drop, weaken, or transform
authoritative input. Apply it to the current conversation, user-selected ticket
or specification, named source documents, and any existing plan being revised.

## Build the ledger

Extract each atomic source item that states one of:

- a required behavior or outcome;
- an acceptance condition or required proof;
- a technical, product, operational, legal, or timing constraint;
- a decision the user already directed or approved.

Assign stable source IDs such as `S1`, `S2`, and `S3`. Preserve the source's
meaning and strength; concise paraphrase is allowed, but do not turn “must” into
“should,” merge distinct obligations, or infer new authority. Record an exact
locator when available, such as a heading, ticket field, comment, or conversation
turn.

Sanitize ledger content. Preserve the planning meaning of secrets, credentials,
personal data, private URLs, customer identifiers, and sensitive incident
details without copying their values. Use a bounded description such as
`<redacted credential requirement>` plus a safe source locator. The plan must
not become a second store for sensitive source material.

Use this shape:

```markdown
| Source ID | Kind | Source meaning | Origin | Disposition | Plan links | Rationale |
|---|---|---|---|---|---|---|
| S1 | requirement | ... | `docs/spec.md` § Name | represented | R2, U1 | ... |
```

`Plan links` must name stable plan IDs or an explicit section-owned acceptance
or definition-of-done item. Avoid page or line numbers that will drift.

## Allowed dispositions

- **represented:** preserved by the linked requirement, decision, unit,
  acceptance condition, or verification statement;
- **superseded:** replaced by a later source with authority to change it; cite
  that source ID and the replacement plan link;
- **deferred:** intentionally postponed with user authority; name the deferred
  section, reason, and trigger for reconsideration;
- **excluded:** explicitly outside this plan with user authority; name the
  scope boundary;
- **blocked:** cannot be represented until a named conflict or unanswered
  decision is resolved.

Do not use “not applicable,” “covered elsewhere,” or an empty cell as a
disposition. Repository research may constrain implementation, but it cannot
supersede a user-set requirement or decision unless it proves the choice
infeasible and the user resolves the conflict.

When two authoritative sources conflict and no repository rule establishes
precedence, keep both rows, mark them blocked, and ask for a decision. Do not
silently choose the newer, more detailed, or easier source.

## Audit both directions

Before finalizing or after any deepening revision:

1. Confirm every source item has exactly one valid disposition.
2. Follow each `represented` link and verify the full meaning survives, including
   qualifiers, thresholds, failure behavior, and required proof.
3. Confirm every source acceptance condition reaches a unit acceptance item,
   test scenario, Verification Contract item, or Definition of Done item.
4. Confirm every source constraint reaches the requirement, decision, unit, or
   risk control that enforces it.
5. Confirm every settled decision reaches `Decisions` and each unit whose shape
   it governs.
6. Validate `superseded`, `deferred`, and `excluded` rows against the cited
   authority; unresolved conflicts become `blocked`.
7. Run the reverse, plan-to-source audit: trace every plan requirement,
   decision, and acceptance condition back to a source ID or label it as
   repository-derived, research-derived, or an explicit working assumption.
   Research-derived facts still need evidence.

Any missing, partial, or contradictory mapping is a plan defect. Restore the
source meaning, add an explicit disposition, or ask for the decision. Never
delete a ledger row merely because the draft omitted its obligation.

## Keep the audit durable

Preserve source IDs across revisions. Append new source items with new IDs; do
not renumber after deletion or supersession. Update plan links whenever units
or requirements change, and keep dispositions for rejected or superseded
material when their history prevents future ambiguity.

Render the durable ledger as the plan's compact `Source Trace` whenever the
input contains stable IDs, multiple sources, or independently checkable
requirements, decisions, constraints, or acceptance conditions. A repository
may instead require a linked companion artifact, but its repo-relative path
must appear in the plan and the artifact must travel with the same reviewed
snapshot. Never leave the only ledger in temporary planning context. Summarize
blocked rows and authority-based exclusions in the final planning report.
