---
status: pending
priority: p2
issue_id: "008"
tags: [code-review, silent-failure]
dependencies: []
---

# Heartbeat + post_bootstrap error handling

## Problem Statement
The heartbeat curl suppresses all errors (`> /dev/null 2>&1 || true`). If the Toolbox port is wrong or the agent isn't running, every heartbeat fails silently, the sandbox auto-stops, and hours of work are destroyed. Similarly, `post_bootstrap` yq errors are suppressed and gosu command failures have no contextual logging.

## Findings
- **Silent-failure-hunter:** Heartbeat curl suppresses errors — sandbox can auto-stop (CRITICAL)
- **Silent-failure-hunter:** post_bootstrap yq errors suppressed (CRITICAL)
- **Silent-failure-hunter:** `read_config` doesn't distinguish missing key from parse error (HIGH)

## Proposed Solutions

### Option A: Log heartbeat failures with counter + improve error reporting
Track consecutive heartbeat failures and log warnings. Remove `2>/dev/null || true` from yq parsing. Add return code checking to `read_config`.
- Pros: Diagnosable failures, no silent sandbox death
- Cons: Slightly more verbose logging
- Effort: Small
- Risk: Low

## Technical Details
- **File:** `daytona/entrypoint.sh` lines 37, 47-53, 170-177

## Acceptance Criteria
- [ ] Heartbeat logs warnings after 3+ consecutive failures
- [ ] `read_config` fails on yq parse errors (not just missing keys)
- [ ] `post_bootstrap` yq call reports errors instead of suppressing
- [ ] Failed `gosu daytona bash -c` commands log the failing command
