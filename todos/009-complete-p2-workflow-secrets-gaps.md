---
status: pending
priority: p2
issue_id: "009"
tags: [code-review, architecture]
dependencies: []
---

# wake-sandbox.yml: missing SUPABASE_ACCESS_TOKEN + incomplete secrets + snapshot validation

## Problem Statement
The `daytona create` command doesn't pass `SUPABASE_ACCESS_TOKEN` — projects with Supabase MCP configured will get `"from-env"` as the token value. The workflow also doesn't validate that `snapshot` is set in `.sodaprompts.yml` (yq returns `"null"` which causes opaque Daytona API errors). GitHub Actions expressions are used inline in `run:` blocks (injection risk).

## Findings
- **Agent-native:** `SUPABASE_ACCESS_TOKEN` not passed to sandbox (Critical #4)
- **Silent-failure-hunter:** yq '.snapshot' has no validation (HIGH)
- **Security-sentinel:** GitHub Actions expression injection risk (MEDIUM)

## Proposed Solutions

### Option A: Add missing env var + validation + expression safety
Add `SUPABASE_ACCESS_TOKEN` to `--env` list. Validate `SNAPSHOT` is non-empty before `daytona create`. Move `${{ }}` expressions to `env:` block.
- Pros: Fixes all three issues
- Cons: None
- Effort: Small
- Risk: Low

## Technical Details
- **File:** `daytona/wake-sandbox.yml` lines 81, 93-101, 55-61

## Acceptance Criteria
- [ ] `SUPABASE_ACCESS_TOKEN` passed as `--env` to sandbox
- [ ] `SNAPSHOT` validated as non-empty/non-null before `daytona create`
- [ ] `${{ github.event.label.name }}` moved to `env:` block
