---
name: agent-native-contracts
description: Use when reviewing agent sessions, prompt boundaries, structured result handling, skill delivery, or tool-access contracts.
---

# Agent-native contracts review

Trace the changed agent-execution path from trusted orchestration input through
prompt construction and runtime materialization to structured result parsing.
Focus on exact boundary defects rather than prompt-writing preference.

## Review method

- Confirm continuation identifiers cannot cross providers, runs, attempts,
  units, generations, or incompatible context policies.
- Trace how untrusted ticket, review, and repository text enters prompts and
  verify it cannot expand capabilities or displace higher-priority instructions.
- Check structured result parsing for type validation, bounded fields,
  deterministic repair, ambiguity rejection, and separation of semantic claims
  from executor-observed facts.
- Verify skill discovery and materialization use only declared packages and do
  not import personal state, hidden configuration, or repository content that
  was not selected.
- Verify tool and MCP configuration materializes only declared logical names
  and exposes no ambient credentials.
- Compare Claude, Codex, OpenCode, or other engine delivery paths for semantic
  parity rather than relying on an engine-only convenience.

## Finding bar

Name the agent boundary, changed path and stable symbol, attacker or failure
input, violated contract, and observable authority, provenance, validation, or
continuation consequence. Keep finding identity stable across rounds without
using line numbers.

## Exclusions

Do not report model preference, prose taste, external plugin availability,
provider outages, local command failures, generic hardening, or unchanged
agent-runtime risks.
