---
status: pending
priority: p1
issue_id: "005"
tags: [code-review, security]
dependencies: []
---

# chattr +i failure not checked — foundation of security model

## Problem Statement
`chattr +i` is the keystone of the security model (prevents agent from removing hooks or modifying permissions). It only works on ext2/ext3/ext4 filesystems. On overlayfs, tmpfs, or btrfs, it silently fails. The Daytona volume at `~/.claude` may use FUSE (incompatible with chattr). If `chattr` fails, all hook-based defenses are bypassable.

## Findings
- **Security-sentinel:** chattr +i silent failure on unsupported filesystems (MEDIUM elevated to P1)
- **Silent-failure-hunter:** chattr fails with confusing error on unsupported filesystems (MEDIUM)

## Proposed Solutions

### Option A: Check return code + fallback to permissions
Verify `chattr` succeeds. If not, fall back to `chown root:root` + `chmod 444`. Also seal `settings.local.json`.
- Pros: Defense works on any filesystem
- Cons: chmod 444 is weaker than immutable (root can still change)
- Effort: Small
- Risk: Low

## Technical Details
- **File:** `daytona/entrypoint.sh` lines 148, 155

## Acceptance Criteria
- [ ] `chattr +i` failure is detected and logged
- [ ] Fallback permissions applied if chattr fails
- [ ] `settings.local.json` also sealed
- [ ] Verification: settings.json is not writable by daytona user after sealing
