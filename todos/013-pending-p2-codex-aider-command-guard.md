---
status: pending
priority: p2
issue_id: "013"
tags: [code-review, security]
dependencies: []
---

# Codex/Aider have no pre-execution command guards

## Problem Statement
Claude has a PreToolUse hook (`block-push-to-main.sh`) that inspects every bash command before execution, blocking secret exfiltration, remote manipulation, and settings tampering. Codex and Aider have no equivalent — the git pre-push hook only blocks `git push` to main, not arbitrary dangerous operations.

## Findings
- **Security-sentinel:** Codex `--approval-mode full-auto` runs with zero pre-execution guards (CRITICAL)
- **Security-sentinel:** Git hooks bypassable for non-Claude agents if `.git/config` is modified (now sealed, reducing this)

## Proposed Solutions

### Option A: Network-level restriction via iptables
Add iptables rules in entrypoint (before dropping to daytona) to block outbound connections except to known-good IPs (GitHub, OpenAI, Anthropic, Telegram).
- Pros: Universal, agent-agnostic
- Cons: Fragile (IPs change), breaks MCP servers
- Effort: Medium

### Option B: Accept risk with documentation
Document that Codex/Aider have reduced security posture compared to Claude. Recommend only using them with trusted repos where issue bodies are not attacker-controlled.
- Pros: Zero implementation cost
- Cons: Weaker security posture
- Effort: Small

### Option C: Command wrapper
Wrap Codex/Aider invocations with a command interceptor that pipes all shell commands through the guard before execution.
- Pros: Parity with Claude
- Cons: Complex, may break agent behavior
- Effort: Large

## Acceptance Criteria
- [ ] Decision documented on which approach to take
- [ ] If implementing: Codex/Aider cannot exfiltrate env vars via curl/wget
- [ ] If accepting risk: Security posture difference documented in migration plan
