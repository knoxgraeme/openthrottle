---
name: accept-unit
description: Use when judging whether an implementation candidate satisfies one plan unit's requirements, acceptance criteria, and scope.
---

# Judge one plan unit

Perform a narrow scope-match review of the supplied candidate. This is not a
general code review: decide whether the unit delivered exactly what its
requirements and acceptance criteria demand, no less and no material extra.

## Build the acceptance map

1. Inventory every requirement and acceptance statement.
2. Classify each as behavioural, artifact-based, or a constraint on what must
   not change.
3. Map each statement to the changed code and the supplied proof expectation.
4. Inspect the implementation itself. A worker summary is a claim to verify,
   not proof.

Tests and verification instructions show how an obligation should be
demonstrated; they do not waive a requirement. When wording admits several
readings, use the narrowest reading supported by the text instead of inventing
new work.

Read `references/acceptance-judgment.md` when a claim is contested, the change
appears broader than the unit, or a revision round has already occurred.

## Decision boundary

Accept when every requirement and acceptance statement is met and the change
stays within scope. Imperfect naming, formatting, structure, or an inherited
defect is not a reason to reject acceptable work.

Request revision only when:

- a stated obligation is observably unmet;
- the candidate includes material work outside the unit;
- the implementation violates an explicit prohibition; or
- the candidate follows a clearly wrong reading of an unambiguous criterion.

Surface a human decision when the available code and evidence cannot resolve a
material ambiguity or contradict one another. Do not guess.

## Make revision requests convergent

Each revision request should identify:

1. the exact requirement or acceptance statement;
2. the file and stable symbol where it is unmet; and
3. the current and required observable behaviour.

Ask for one focused round of work. Do not replace a satisfied request with a
new preference on the next round; the acceptance bar must remain stable.

## Evidence

Ground the decision in changed paths, stable symbols, observable behaviour,
and relevant test outcomes. If the candidate is acceptable but a dependent
unit needs a fact, state that fact and its intended consumer without turning it
into a revision request.
