---
status: pending
priority: p2
issue_id: "006"
tags: [code-review, architecture, quality]
dependencies: []
---

# Extract shared agent-lib.sh — duplicated invoke_agent, sanitize_secrets, notify, log

## Problem Statement
`invoke_agent` is defined independently in both runner scripts (~109 lines total) with behavioral drift: the builder has a `RESUME_SESSION` check the reviewer lacks. `sanitize_secrets`, `notify`, `log`, and the preamble boilerplate are also duplicated. The two `invoke_agent` copies have already diverged — missing `touch` on session file mtime, missing empty session file guard.

## Findings
- **Pattern-recognition:** Duplicated `invoke_agent` with behavioral drift (HIGH)
- **Code-simplicity:** 120+ lines duplicated across runners (~16%)
- **Pattern-recognition:** Missing defensive guards from Sprites version (session mtime refresh, empty file check)

## Proposed Solutions

### Option A: Create agent-lib.sh
Extract `invoke_agent`, `sanitize_secrets`, `notify`, `log`, and shared preamble into `/opt/sodaprompts/agent-lib.sh`. Both runners source it.
- Pros: Single source of truth, ~95 lines removed, prevents future drift
- Cons: One more file to manage
- Effort: Small
- Risk: Low

## Technical Details
- **Files:** `daytona/run-builder.sh` lines 43-51, 56-69, 130-188; `daytona/run-reviewer.sh` lines 45-53, 58-108

## Acceptance Criteria
- [ ] `agent-lib.sh` contains: invoke_agent, sanitize_secrets, notify, log
- [ ] Both runners source it
- [ ] Session mtime `touch` restored on resume
- [ ] Empty session file guard restored (log warning, start fresh)
- [ ] Dockerfile COPY updated to include agent-lib.sh
