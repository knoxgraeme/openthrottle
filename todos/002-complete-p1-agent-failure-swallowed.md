---
status: pending
priority: p1
issue_id: "002"
tags: [code-review, silent-failure]
dependencies: []
---

# Agent failures (non-timeout) silently swallowed + no trap cleanup

## Problem Statement
The `invoke_agent || { ... }` pattern catches ALL exit codes but only handles 124 (timeout). Exit codes 127 (binary not found), 137 (OOM-killed), 139 (segfault) are caught and silently ignored. The script continues as if the agent completed.

Additionally, neither runner has a `trap cleanup EXIT` handler. If the script dies from an unhandled error (e.g., `set -e` triggered), tasks stay stuck in `*-running` state permanently.

## Findings
- **Silent-failure-hunter:** Agent failures (non-timeout) silently swallowed (CRITICAL)
- **Silent-failure-hunter:** No cleanup/rollback on failure — stuck tasks (Pattern B)
- **Agent-native:** Failed tasks have no automated recovery path

## Proposed Solutions

### Option A: Expanded exit code handling + trap
Add case-based exit code handling for known failure modes (127, 137, 139). Add `trap cleanup EXIT` to both runners for state cleanup.
- Pros: Comprehensive error reporting, no stuck tasks
- Cons: None significant
- Effort: Small
- Risk: Low

## Technical Details
- **Files:** `daytona/run-builder.sh` lines 232-238, 316-322, 402-408; `daytona/run-reviewer.sh` similar patterns

## Acceptance Criteria
- [ ] Exit codes 127, 137 handled with specific log messages
- [ ] Default `*` case logs the exit code and notifies
- [ ] `trap cleanup EXIT` transitions task to `*-failed` on unexpected termination
- [ ] Notifications sent on all failure modes
