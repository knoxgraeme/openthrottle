# Deepening an Existing Plan

Use this contract only when the user asks to deepen, expand, strengthen, or add
research to a plan that is already complete enough to implement. Deepening
improves evidence and execution confidence; it is not permission to redesign
the approved change.

## Freeze the baseline

Before research or edits:

1. Read the complete current plan and its source-preservation ledger. If the
   ledger is absent, build it from the plan's named sources before continuing.
2. Check whether the plan is sealed, explicitly approved as immutable, bound to
   a validation digest, or attached to an active or completed run. If so, do not
   mutate it in place. Create a clearly named successor artifact that records
   its predecessor path and digest or run reference, then deepen the successor.
3. Record the existing scope, exclusions, requirements, decisions, acceptance
   conditions, verification posture, and unit dependency graph.
4. Inventory every stable `R`, `D`, and `U` identifier. Never renumber, recycle,
   or silently change the meaning of an existing identifier.
5. Restate the requested deepening focus and the decisions that remain fixed.

If the artifact is incomplete rather than complete-but-shallow, return to the
normal planning workflow instead of presenting ordinary completion work as a
deepening pass.

## Classify proposed changes

Apply without a new approval only when the edit preserves approved meaning:

- add concrete repository evidence, paths, patterns, or current citations;
- make an existing requirement or decision clearer without broadening it;
- add missing test scenarios or verification detail implied by current
  acceptance;
- split prose for readability while leaving unit ownership and dependencies
  unchanged;
- correct a trace link whose intended target is unambiguous.

Request explicit user approval before applying any consequential delta:

- add, remove, or broaden product or technical scope;
- reverse, replace, or materially qualify a settled decision;
- add an externally visible acceptance condition or weaken an existing one;
- split, merge, reorder, or change dependencies between execution units;
- introduce a migration, rollout, trust, data, or operational obligation that
  materially changes delivery;
- convert an assumption or deferral into required work.

Evidence may reveal the need for such a change, but evidence does not authorize
it.

## Approval checkpoint

Present each consequential delta separately:

```text
Delta: <short name>
Current plan: <existing scope, decision, acceptance, or unit shape>
Proposed change: <precise replacement or addition>
Why it matters: <evidence and risk>
Plan impact: <affected R/D/U IDs, sequencing, proof, and exclusions>
Recommendation: <preferred choice and material tradeoff>
```

Do not edit the consequential fields until the user approves the delta. Apply
rejected deltas as neither hidden assumptions nor active work; record them as
excluded by decision or deferred when that history matters.

## Preserve identifiers and history

- Keep an existing ID attached to its original semantic obligation.
- Add new obligations with the next unused ID; gaps are valid.
- When approved meaning is replaced, retain an explicit supersession note and
  point to the new ID rather than reusing the old ID for different meaning.
- Update every affected unit's repeated requirement meaning, test scenarios,
  acceptance, and verification after an approved change.
- Keep the source-preservation ledger synchronized with every applied,
  rejected, superseded, or deferred delta.
- Treat any execution-plan block as generated output. Never deepen or hand-edit
  it independently of the human plan; revise approved prose first, then
  regenerate and revalidate the block using the selected graph.

## Finish the pass

Re-run traceability, unit self-containment, source-preservation, and coherence
checks. For standard or deep plans, route the revised snapshot through the
independent document-review contract.

Report the unchanged baseline, safe enrichments applied, approved deltas,
declined or deferred deltas, new IDs, and any research gap. Never describe the
plan as merely “more detailed”; name what became more certain or executable.
