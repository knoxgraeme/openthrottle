---
status: pending
priority: p3
issue_id: "012"
tags: [code-review, security]
dependencies: []
---

# Pin yq version + Dockerfile improvements

## Problem Statement
yq is installed from `latest` release without version pinning or checksum verification. A compromised release could inject a malicious binary. Also missing: workflow `permissions` block, `concurrency` guard, `gh api` in exfiltration guard.

## Findings
- **Security-sentinel:** yq install without checksum verification
- **Pattern-recognition:** Missing workflow `permissions` and `concurrency` blocks
- **Agent-native:** Add `gh api` to exfiltration guard

## Effort: Small | Risk: Low

## Acceptance Criteria
- [ ] yq pinned to specific version with SHA256 verification
- [ ] Workflow has explicit `permissions:` block
- [ ] Workflow has `concurrency:` guard keyed on work item number
- [ ] `gh\s+api` added to exfiltration detection in block-push-to-main.sh
