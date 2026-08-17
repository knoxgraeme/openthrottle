# Quality Gates

Run two separate passes after the first complete draft: a confidence pass that
strengthens technical grounding, then a coherence pass that checks the artifact
as an executable agreement.

## Confidence pass

Score each material section:

- Add **2** for a gap that could change implementation direction or allow an
  incorrect result.
- Add **1** for a useful but nonblocking weakness.
- Add **1** when the section owns a high-risk concern touched by the change.

Strengthen sections scoring at least 2, starting with the highest scores. Limit
the pass to one section for lightweight work, three for standard work, and five
for deep work. A strong plan may require no change.

### Signals by section

**Requirements and scope**

- The problem or success condition is unclear.
- A requirement is vague, untraceable, or contradicted downstream.
- Product behavior has been introduced without user authority.
- An assumption is presented as confirmed scope.

**Decisions and design**

- A consequential choice lacks rationale or ignores an obvious alternative.
- The design conflicts with repository boundaries or current contracts.
- A multi-component, stateful, or branching design needs a visual representation.
- Agent-facing work omits access, context, approval, or lifecycle decisions.

**Implementation units**

- A unit is vague, oversized, microscopic, or mixes unrelated concerns.
- Dependencies are absent, circular, or likely ordered incorrectly.
- File or test paths are missing without justification.
- The unit depends on prose it will not receive at runtime.
- Test scenarios omit applicable failure or integration behavior.
- Acceptance or verification cannot be observed.

**System impact and risk**

- Affected interfaces, consumers, middleware, callbacks, or shared state are
  missing.
- Security, migration, privacy, reliability, performance, or rollout risk lacks
  a mitigation.
- Failure propagation, recovery, or operator visibility is under-specified.

**Research grounding**

- A cited source does not affect a decision.
- A decision claims repository precedent without concrete evidence.
- High-risk or unfamiliar work relies on unsupported assumptions.
- External guidance conflicts with the repository without resolving the
  tradeoff.

For a weak section, use the smallest useful follow-up: reread the owning
contract, inspect another direct pattern, or run one focused independent
research lane. Strengthen only the owning section and its trace links. Do not
rewrite the entire plan or renumber units.

## Coherence pass

Read the artifact once as an implementer who has no access to the planning
conversation. Check:

- The summary, requirements, decisions, units, tests, and acceptance describe
  the same change.
- Terms and IDs are consistent and unique.
- Each rule has one owning statement; other sections cite it without creating a
  competing version.
- In-scope and out-of-scope statements do not conflict.
- Every unit is self-contained and has complete required fields.
- File paths are repo-relative and plausible from research.
- Tests prove behavior rather than mirroring implementation details.
- Verification uses configured command names and observable outcomes.
- Assumptions are visible and nonblocking.
- Deferred work is not required for current acceptance.
- No section contains placeholders, “see above,” or unresolved alternatives.
- The artifact remains concise enough to review and fit the downstream ticket
  and execution-plan limits.
- The source ledger and Source Trace agree with the plan body, including any
  user-approved change, exclusion, or deferral.

Repair safe clarity and consistency defects directly. Ask the user before
changing product scope, reversing a confirmed decision, choosing between valid
architectures, or altering acceptance.

For standard and deep plans, this coherence pass does not replace the fresh,
read-only review defined in `references/document-review.md`. The independent
review challenges the completed artifact after the author has finished these
repairs.

## Final readiness

The plan is ready only when:

- an implementer can begin without inventing architecture or product behavior;
- each structured unit can execute without surrounding plan prose;
- planning-owned questions are resolved;
- implementation-owned unknowns are explicitly deferred;
- the chosen graph and verification posture are known;
- no research limitation is being concealed.
