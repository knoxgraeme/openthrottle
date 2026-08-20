# Acceptance judgment

Use this guide to keep unit acceptance narrow, evidence-based, and stable
across revision rounds.

## Read each obligation by kind

- **Behavioural:** a value, error, state transition, or side effect must be
  observable. Judge it from the implementation and executable proof.
- **Artifact:** a file, migration, export, command, or other concrete construct
  must exist with the required shape.
- **Constraint:** a public response, dependency set, data shape, or unrelated
  area must remain unchanged.

Requirements and acceptance criteria are both mandatory. Tests and
verification instructions are proof expectations, not substitutes for the
obligation itself.

Ambiguity resolves narrowly. “Reject invalid input” requires rejection; it does
not silently require a particular error class, log entry, or metric. An
obligation that cannot be judged from the available code and evidence must be
identified as unresolved rather than assumed satisfied.

## Read only as deeply as needed

Use three tiers:

1. **Visible claim:** the changed code or artifact directly demonstrates the
   obligation. Inspect it and decide.
2. **Contested claim:** the summary says an obligation is met but the diff does
   not make that clear. Read the enclosing symbol, direct callers, and owning
   tests.
3. **Deliberate but surprising change:** recover the local reason from nearby
   patterns, explicit constraints, and upstream facts before treating the
   change as a scope breach.

Read a file once and judge every obligation that touches it together.

## Default to acceptance when the contract is met

Acceptance is not a chance to raise the quality bar. Revise only for a stated
obligation, explicit prohibition, or material scope boundary. Do not revise for
personal preferences about naming, formatting, comments, abstraction, test
layout, or extra coverage the unit never requested.

An acceptable candidate may still deserve a note about an inherited issue or a
fact useful to later work. Keep that note separate from revision work.

## Write a revision that can close in one round

A strong request names:

- the unmet criterion in its own words;
- the repository-relative path and stable symbol involved;
- the current observable behaviour; and
- the observable behaviour required for acceptance.

Avoid vague directions such as “improve error handling.” Ask for the smallest
change that demonstrates the criterion.

## Keep the bar stable across rounds

- Judge each candidate against the same supplied obligations.
- Once a previous request is satisfied, do not substitute a new preference.
- A newly noticed defect justifies another revision only when it demonstrably
  violated an existing obligation before.
- Do not restate failures already established by automated checks; use them as
  evidence and spend the judgment on scope match.
