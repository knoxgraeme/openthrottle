---
name: select-review-personas
description: Use when selecting a deterministic, risk-matched reviewer roster from a supplied review policy.
---

# Select review lenses

Choose the smallest supplied reviewer set that covers the risks actually
introduced by the change. This capability selects reviewers; it does not
perform their reviews.

## Selection method

1. Read the available roster, mandatory entries, ordering rules, and selection
   budget supplied with the task.
2. Include every mandatory reviewer in policy order.
3. On a repeat review, preserve the previously required roster and order unless
   the supplied policy explicitly says selection should be recomputed.
4. Inspect changed paths, contracts, and at most the direct local context needed
   to establish a risk trigger.
5. Add an optional reviewer only when both conditions hold: it is present in
   the supplied roster, and changed code makes its risk domain reachable.
6. Deduplicate overlapping lenses without dropping mandatory coverage.
7. Preserve deterministic order and stay within the supplied selection limit.

## Common risk triggers

- **Correctness and data flow:** changed state transitions, branching, values,
  errors, or cross-module contracts.
- **Tests and contracts:** any behaviour or public/persisted contract change.
- **Reliability:** retries, queues, webhooks, leases, ordering, replay,
  idempotency, or asynchronous settlement.
- **Agent-native behaviour:** sessions, prompts, structured agent results,
  skills, tool access, MCP, or runtime materialization.
- **Security:** authentication, authorization, trust boundaries, credentials,
  tenant binding, injection, or secret handling.
- **Data migration:** schemas, migrations, backfills, durable adapters, or
  versioned serialization.
- **Performance:** hot-path queries, scans, polling, retained artifacts,
  pagination, or work that scales with stored history.
- **Project standards:** package layout, architecture boundaries, manifests,
  normative docs, or cross-surface parity.

## Evidence and rationale

For each selected optional reviewer, cite the changed path or contract and the
specific risk it introduces. Record mandatory entries even when no optional
trigger is present. Do not select reviewers for style taste, generic hardening,
unchanged code, external outages, local tool absence, or failures already owned
by automated checks.

If mandatory coverage cannot fit the supplied limit or the policy contradicts
itself, state the conflict rather than silently omitting a reviewer.
