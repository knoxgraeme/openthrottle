# Flow and Risk Analysis

Use this reference for standard/deep work and whenever behavior crosses user,
state, process, system, trust, or data boundaries.

## Trace behavior end to end

For each material journey, identify:

- actor and entry point;
- prerequisites and authorization;
- state before the action;
- decisions and branches;
- collaborating components or external systems;
- success outcome;
- invalid-input, denial, timeout, cancellation, and dependency-failure outcomes;
- retry, partial-completion, stale-state, and concurrency behavior when
  applicable;
- terminal state and what the user or operator can observe.

Ground the trace in current repository behavior. Do not flag a generic concern
when an existing global mechanism already owns it. Do flag when the plan relies
on that mechanism but never verifies the handoff.

Convert gaps into a concrete requirement, decision, test scenario, risk, or
focused user question. Prioritize gaps that block implementation or could cause
security, data, or silent-success failures.

## Apply only relevant risk lenses

### Trust and authorization

Map trusted and untrusted inputs, identity and permission checks, credential
scope, sensitive output, injection surfaces, audit needs, and irreversible
actions. Preserve explicit human approval for costly or externally visible
effects unless a safe delegated contract already exists.

### Durable data

Map schema compatibility, migration order, backfill safety, transaction
boundaries, retries, idempotency, rollback, mixed-version operation, retention,
and privacy obligations.

### Reliability and operations

Map timeouts, retries, duplicate delivery, ordering, leases, recovery,
observability, rollout gates, rollback triggers, and operator diagnosis.

### Performance

Identify hot paths, query or loop growth, boundedness, external call volume,
memory/artifact retention, concurrency limits, and a way to verify the expected
scale.

### External contracts

Identify public APIs, CLI flags, configuration, environment variables, events,
shared types, documentation links, and downstream consumers. Plan compatibility
and version-specific verification.

### Agent-access parity

For products with agents, skills, tools, prompts, MCP, or autonomous work,
check:

- important user actions have an agent-accessible primitive when appropriate;
- the agent receives equivalent state, vocabulary, permissions, and results;
- user and agent operate on the same durable artifact;
- tools expose composable actions while judgment remains in the skill;
- long-running work has progress, completion, interruption, and recovery;
- external or irreversible effects have proportional approval and auditability;
- verification exercises the agent-facing contract, not only internal code.

Classify agent access as required now, deferred, or intentionally human-only.
Do not invent an agent surface for narrow cosmetic work.

## Produce planning changes

Return only:

- missing or tightened requirements;
- decisions that need rationale;
- unit or dependency changes;
- concrete test and acceptance scenarios;
- risks with mitigations;
- blockers or assumptions that remain.

Do not return a general checklist or a second plan.
