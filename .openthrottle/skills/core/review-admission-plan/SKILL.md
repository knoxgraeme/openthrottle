---
name: review-admission-plan
description: Use when independently reviewing a candidate execution plan for scope, completeness, dependency coherence, and executable proof.
---

# Review an execution-plan candidate

Review the supplied plan against the original bounded request without repairing
or rewriting it. Reconstruct the mapping from request to plan independently;
do not inherit unstated assumptions from the plan author.

Use `references/review-checklist.md` when the candidate has multiple units,
explicit source IDs, or cross-component dependencies. Use
`references/semantic-output.md` when findings are difficult to separate from
missing source decisions.

## Review method

1. **Inventory the source obligations.** List every explicit requirement,
   acceptance condition, constraint, and stable identifier from the request.
2. **Check coverage.** Map each obligation to an owning unit and to concrete
   proof. Reject omissions, weakened language, ID-only pointers, or proof that
   does not exercise the promised behaviour.
3. **Check expansion.** Identify product behaviour, architecture, migrations,
   dependencies, cleanup, or rollout work not supported by the request.
4. **Check unit completeness.** Each unit must carry enough objective,
   requirements, files, approach, tests, acceptance, and verification context
   for a worker to execute it without consulting hidden rationale.
5. **Check graph coherence.** Unit identifiers must be unique; dependencies
   must exist, be acyclic, and order shared contracts before their consumers.
6. **Check proof quality.** Success, meaningful boundaries, failures, and
   relevant cross-layer behaviour need executable checks. Commands and paths
   must be plausible in the repository.
7. **Check decision authority.** Distinguish a correctable planning defect from
   a request that genuinely lacks a necessary product or acceptance decision.

## Conclusions

Approve only when the whole candidate is complete, in scope, coherent,
plausible, and verifiable. Reject correctable plan defects with anchored
findings. Escalate only missing or conflicting source authority that the plan
author could not resolve without inventing a requirement.

Do not improve, normalize, or copy the candidate into the review. Keep each
finding tied to a source obligation, unit, path, dependency edge, or proof gap,
and ask questions that are specific enough to unblock a revised plan.
