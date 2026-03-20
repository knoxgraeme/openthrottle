---
status: pending
priority: p1
issue_id: "003"
tags: [code-review, architecture]
dependencies: []
---

# handle_fixes re-labels needs-review even when no commits pushed (infinite loop)

## Problem Statement
When `handle_fixes` completes, it unconditionally adds `needs-review` label (line 241). If the agent timed out or failed without pushing commits, the PR gets re-labeled for review of unchanged code. The reviewer requests changes again, triggering another fix sandbox — creating an infinite loop burning sandbox resources.

## Findings
- **Agent-native:** Fix session → review → fix → review infinite loop (Critical #3)

## Proposed Solutions

### Option A: Check for new commits before re-labeling
Compare `git rev-parse HEAD` before and after `invoke_agent`. Only add `needs-review` if new commits exist.
- Pros: Simple, reliable check
- Cons: None
- Effort: Small
- Risk: Low

## Technical Details
- **File:** `daytona/run-builder.sh` lines 232-249

## Acceptance Criteria
- [ ] `handle_fixes` records HEAD before agent invocation
- [ ] Only adds `needs-review` if HEAD changed (new commits pushed)
- [ ] On failure with no new commits: posts comment explaining fix attempt failed, notifies user
