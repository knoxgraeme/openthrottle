# Execution Graphs Rollout

This runbook covers the Stage C V1 rollout for public execution graphs.

## Current State

- `.openthrottle.yml` declares `simple` and `structured`.
- `simple` is the default for `implement` and `investigate`.
- `structured` is allowed only for explicit implement canaries.
- The built-in pipeline alias still resolves `implement` to `core/implement@4`.

Do not flip the default to `structured` without Graeme's explicit approval.

## Opt-In Dogfood

1. Prepare a CE unified plan and add one `openthrottle.execution-plan/v1` block
   whose `graph_id` is `structured`.
2. Validate locally:

   ```bash
   npm run build --prefix contracts
   npm run build --prefix cli
   node cli/dist/index.js plan validate <plan.md> --graph structured --json
   ```

3. Delegate only through the operator-approved opt-in path. Until admission
   persists graph selection end to end, do not rely on `openthrottle ship --graph`.
4. Save only sanitized evidence: graph ID, execution-plan digest, run/session
   IDs, publication subject, PR link, and provider receipt IDs.

## Acceptance Checks

- Structured executes units serially: at most one writable unit worktree and one
  active unit action.
- Unit lead acceptance is a scope-match decision, not code review.
- Whole-change commands run before the fresh final semantic review.
- Publication uses one exact integrated subject.
- Stop and restart reconciliation leave no active unit action or duplicate
  integration.
- Switching the repository default back to `simple` affects only new
  generations; pinned structured instances keep their sealed graph/runtime.

## Default Migration Gate

The default can move from `simple` to `structured` only after:

- a credentialed Linear -> Fly -> Daytona -> GitHub structured run completes,
- the U8 audit has no unresolved V1 findings beyond explicitly accepted
  operator risks,
- rollback to `simple` has been tested for new generations, and
- Graeme explicitly approves the default flip.
