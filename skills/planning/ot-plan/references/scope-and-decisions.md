# Scope and Decisions

Use this reference to convert a conversation, ticket, or source document into a
stable planning brief before researching implementation details.

## Classify the input

Maintain four internal groups:

- **Confirmed choices:** behavior, boundaries, priorities, and technical
  choices the user explicitly stated or approved.
- **Working assumptions:** necessary interpretations that have not been
  approved and could change the resulting plan.
- **Excluded work:** adjacent changes deliberately left outside the active
  artifact, including cleanup and future enhancements.
- **Blockers:** unanswered questions with materially different product,
  architecture, sequencing, or risk outcomes.

A choice is confirmed when the user selected it, approved a recommendation, or
clearly treated it as fixed while comparing alternatives. A directive that has
not been examined is authoritative input, but may receive one evidence-backed
challenge when it creates a substantial risk.

## Preserve provenance

For each confirmed choice that affects the implementation shape, retain:

- what was chosen;
- whether the user directed or approved it;
- the relevant rejected alternative when known;
- any repository evidence that later constrains it.

Research may improve the rationale around a confirmed choice. Do not silently
reverse it. If current evidence makes it impossible, stop with the conflicting
evidence and request a new decision.

## Decide whether to ask

Ask only when the answer changes at least one of:

- externally visible behavior or success criteria;
- in-scope versus deferred work;
- trust, authorization, or data handling;
- architectural boundary or dependency direction;
- irreversible migration or rollout posture;
- the execution-unit graph;
- proof required for acceptance.

Do not ask about naming, low-level implementation details, or choices with a
clear repository-standard default. Record the default as an implementation
detail instead.

Ask one question at a time. Teach unfamiliar choices with concise options, the
material tradeoff, and a recommended default.

## Present a scope checkpoint

Before substantial research, present a short checkpoint when the plan is
standard/deep or a material working assumption exists. Include:

1. What the plan will cover.
2. The most important exclusion.
3. Confirmed choices being carried forward.
4. Only the forks the user can evaluate without reading code.

Keep each fork to one or two lines. Omit file names, exact payloads, commands,
status codes, and implementation sequencing. Those belong in the plan.

Proceed without waiting only when the plan is lightweight and no material fork
remains. Announce the scope in one concise paragraph so the user can interrupt.

## Route unresolved material

- Put confirmed behavior in Requirements or Scope.
- Put confirmed technical choices in Decisions.
- Put nonblocking working assumptions in Assumptions.
- Put excluded adjacent work in Deferred Work or Non-goals.
- Do not write a final plan while a blocker remains.
