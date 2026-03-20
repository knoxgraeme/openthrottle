---
status: pending
priority: p2
issue_id: "010"
tags: [code-review, architecture]
dependencies: []
---

# Missing notifications + cancel mechanism + auto-delete

## Problem Statement
Review completion has no success notification — users only learn a review finished by checking the PR. Investigation tasks leave no deliverable and have no completion notification. There is no cancel/abort mechanism for running tasks. `--auto-delete 0` means failed sandboxes linger forever.

## Findings
- **Agent-native:** Review completion has no success notification (Critical #2)
- **Agent-native:** Investigation tasks leave no deliverable (Critical #1)
- **Agent-native:** No cancel/abort mechanism (Warning #5)
- **Agent-native:** `--auto-delete 0` causes resource leak (Warning #6)

## Proposed Solutions

### Option A: Add notifications + set auto-delete timeout
Add `notify` calls after successful review and investigation. Set `--auto-delete` to 1440 (24 hours) instead of 0. Cancel mechanism can be deferred.
- Pros: Users get complete picture of task lifecycle
- Cons: Cancel mechanism still missing (acceptable for v1)
- Effort: Small
- Risk: Low

## Technical Details
- **Files:** `daytona/run-reviewer.sh` lines 224-226, 258-259; `daytona/wake-sandbox.yml` line 86

## Acceptance Criteria
- [ ] `review_pr` sends notification on successful completion
- [ ] `investigate_bug` sends notification on completion
- [ ] `--auto-delete` set to reasonable nonzero value
