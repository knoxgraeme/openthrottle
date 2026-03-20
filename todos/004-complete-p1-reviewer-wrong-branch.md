---
status: pending
priority: p1
issue_id: "004"
tags: [code-review, silent-failure]
dependencies: []
---

# Reviewer can review wrong branch — git operations and gather_review_context fail silently

## Problem Statement
In `run-reviewer.sh`, `git fetch/checkout/pull` all use `2>/dev/null || true`. If `gather_review_context` fails (GitHub API error) and returns an empty branch name, the reviewer continues on whatever branch was checked out (likely main), reviews the wrong code, and potentially approves or requests changes on code it never looked at.

## Findings
- **Silent-failure-hunter:** `gather_review_context` returns empty on API failure, cascades (CRITICAL)
- **Silent-failure-hunter:** git fetch/checkout/pull suppress errors (CRITICAL)

## Proposed Solutions

### Option A: Fail-fast on empty branch + error handling
Check `gather_review_context` return code. Validate branch name is non-empty. Make git fetch fail-fast with error reporting.
- Pros: Prevents wrong-branch reviews entirely
- Cons: Review fails instead of producing wrong results (acceptable)
- Effort: Small
- Risk: Low

## Technical Details
- **File:** `daytona/run-reviewer.sh` lines 113-144, 179-181

## Acceptance Criteria
- [ ] `gather_review_context` returns non-zero on API failure
- [ ] Caller exits with error message if branch is empty
- [ ] `git fetch` failures abort review with notification
- [ ] `git checkout` failures abort review with notification
