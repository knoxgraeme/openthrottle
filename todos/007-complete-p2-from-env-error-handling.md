---
status: pending
priority: p2
issue_id: "007"
tags: [code-review, silent-failure]
dependencies: []
---

# from-env resolution + MCP config error handling

## Problem Statement
When env vars are missing, `from-env` resolution silently keeps the literal string `"from-env"` as the credential value. MCP servers then fail with opaque auth errors. Additionally, the MCP config `yq` call uses `2>/dev/null || echo '{}'` — if YAML is malformed, project MCP servers are silently dropped.

## Findings
- **Silent-failure-hunter:** `from-env` keeps literal string when env vars missing (HIGH)
- **Silent-failure-hunter:** MCP config yq errors suppressed, integrations silently dropped (HIGH)

## Proposed Solutions

### Option A: Fail on missing env vars + visible yq errors
Use `jq error()` to abort when a `from-env` value can't be resolved. Remove `2>/dev/null` from the MCP config yq call.
- Pros: Clear error messages at boot, no silent config failures
- Cons: Entrypoint fails if secrets are missing (acceptable — better than silent auth failure)
- Effort: Small
- Risk: Low

## Technical Details
- **File:** `daytona/entrypoint.sh` lines 107-113

## Acceptance Criteria
- [ ] Missing `from-env` env vars produce a clear FATAL error with the variable name
- [ ] Malformed `mcp_servers` YAML produces a visible warning
- [ ] `yq` call no longer suppresses stderr
