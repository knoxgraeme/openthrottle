---
status: pending
priority: p1
issue_id: "001"
tags: [code-review, security]
dependencies: []
---

# block-push-to-main.sh fails open + bypass patterns

## Problem Statement
The PreToolUse guard (`block-push-to-main.sh`) fails **open** when jq can't parse input — if jq is missing or input is malformed, `COMMAND` is empty, all grep checks pass, and the command is **allowed**. A security guard must fail **closed**.

Additionally, the guard has several bypass patterns: variable indirection (`BRANCH=main; git push origin $BRANCH`), git aliases, `/proc/self/environ` reads, and `os.environ` in Python/Node.

## Findings
- **Security-sentinel:** jq failure bypasses all safety guards (HIGH)
- **Security-sentinel:** Variable indirection, git alias, /proc reads bypass exfiltration guard (HIGH)
- **Silent-failure-hunter:** jq parse failure causes unblocked execution (HIGH)

## Proposed Solutions

### Option A: Fail-closed + expanded patterns
Add fail-closed default at top of script. Block `git remote add/set-url`, `git config alias`, `/proc/self/environ`, `printenv <SECRET_NAME>`.
- Pros: Catches more bypass patterns
- Cons: May need ongoing pattern updates
- Effort: Small
- Risk: Low

### Option B: Network egress allowlist approach
Instead of pattern matching, block ALL outbound network by default and allowlist specific destinations.
- Pros: Comprehensive defense
- Cons: Requires Daytona Tier 3+ network policy support
- Effort: Medium
- Risk: Medium (may break MCP servers)

## Technical Details
- **File:** `daytona/hooks/block-push-to-main.sh` lines 13-14, 21-70

## Acceptance Criteria
- [ ] Script exits 2 (deny) when jq fails to parse input
- [ ] Script exits 2 (deny) when COMMAND is empty
- [ ] `git remote add/set-url` blocked
- [ ] `/proc/self/environ` reads blocked in outbound contexts
- [ ] `git config alias` blocked
