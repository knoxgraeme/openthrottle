# Research Routing

Research exists to change planning decisions, not to demonstrate breadth. Start
with local evidence, add focused lanes by risk, and stop when another search is
unlikely to alter the plan.

## Choose depth

- **Lightweight:** one bounded area, established pattern, low ambiguity, and no
  consequential trust, data, migration, or external-contract surface.
- **Standard:** multiple collaborating files or layers, a meaningful design
  choice, a user/system flow, or a public/configuration contract.
- **Deep:** cross-cutting architecture, unfamiliar territory, durable data
  change, security-sensitive behavior, external integration, complex rollout,
  or several independently risky decisions.

Use risk and uncertainty rather than file count alone. Upgrade the depth when
research reveals a public interface, external consumer, migration, or hidden
cross-system dependency.

## Run the local baseline

Every plan must inspect the smallest useful set of:

1. Active repository instructions and normative specifications.
2. The product source, ticket, or prior plan supplied by the user.
3. `.openthrottle/config.yml`, referenced definition files, and relevant package/runtime versions.
4. Owning modules, boundaries, entry points, and integration seams.
5. Two or more direct implementation examples when available.
6. Existing tests and verification conventions for the affected behavior.
7. Strategy, vocabulary, and durable learnings when the repository provides
   them.
8. Recent history only when the reason for an existing boundary or unusual
   pattern remains unclear.

Prefer authoritative contracts over observed convention, and current code over
stale documentation. Record contradictions instead of choosing silently.

## Add focused research lanes

Use independent contexts when the host supports them and the questions do not
overlap. Otherwise investigate sequentially. Do not count multiple lenses in
one context as independent confirmation.

Before dispatch, read `references/research-prompts.md` from the skill root and
select the smallest matching prompt contract. Add task-specific scope, primary
sources, repository instructions, and exact versions only when relevant. Do not
send the planner's preferred answer or ask a researcher to write a full plan.

Available lanes:

- **Repository patterns:** ownership, architecture, concrete file targets,
  conventions, tests, and sequencing clues.
- **Past decisions:** applicable lessons, failed approaches, recurring defects,
  and established terminology.
- **Flow completeness:** actors, branches, state transitions, failure states,
  and cross-system handoffs.
- **Official documentation:** version-specific APIs, compatibility,
  deprecations, and supported integration patterns.
- **External practice:** security, privacy, payments, migrations, reliability,
  or other domain constraints absent from the repository.
- **Option landscape:** available libraries, providers, or approaches when the
  choice is genuinely unsettled and materially shapes the plan.
- **Specialist risk:** authorization, data integrity, performance, deployment,
  or agent-access parity when that risk is present.

Typical limits:

- Lightweight: no fanout; perform the baseline inline.
- Standard: up to three independent lanes.
- Deep: start with three to five lanes, then add a follow-up only to close a
  load-bearing evidence gap.

Researchers return evidence and implications. They do not author competing
plans or decide product scope.

## Decide on external research

Run external research when the user requests it, a named external resource must
be consulted, current API behavior matters, local examples are missing or only
adjacent, or high-risk domain guidance can change the design.

Distinguish:

- **Build guidance:** the technology is settled; research correct use,
  constraints, pitfalls, and proof.
- **Option discovery:** the technology or provider is unsettled; research the
  realistic choices and selection criteria.
- **Combined:** map the choices first, then investigate only the shortlist.

For APIs and services, check current support and deprecation status before
recommending an integration. Prefer official and primary sources. Treat vendor
claims and community reports as lower-confidence evidence.

Skip external research when current repository patterns directly cover the
problem and another source is unlikely to change a decision. If requested
research is unavailable, continue where safe and record the gap in the plan.

## Evidence return contract

For every retained finding, capture:

- **Finding:** the relevant fact, constraint, or pattern.
- **Evidence:** repo-relative path, authoritative document, or cited source.
- **Planning effect:** the decision, unit, sequencing, verification, or risk it
  changes.
- **Confidence:** confirmed, supported, or uncertain.
- **Residual question:** only when the uncertainty still matters.

Discard findings that do not change the plan. Synthesize retained findings into
their owning sections rather than appending a research dump.

## Stop conditions

Stop researching when direct evidence answers the planning question, new
sources repeat known conclusions, or another result would not change scope,
design, sequencing, risk, or proof. Name uncertainty honestly instead of
padding the artifact.
