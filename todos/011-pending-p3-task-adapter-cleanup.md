---
status: pending
priority: p3
issue_id: "011"
tags: [code-review, quality]
dependencies: []
---

# Clean up task-adapter.sh — 6 unused functions + flatten case statements

## Problem Statement
6 functions from the Sprites polling model are unused in Daytona: `task_ensure_labels`, `task_create`, `task_list_by_status`, `task_first_by_status`, `task_count_by_status`, `task_list_closed_by_status` (~95 lines). The `TASK_PROVIDER` case-switch abstraction has one backend. Also rename log prefix "thinker" → "reviewer" and unify TIMEOUT vs TASK_TIMEOUT.

## Findings
- **Code-simplicity:** 6 unused functions, ~95 lines of dead code (YAGNI)
- **Code-simplicity:** Provider abstraction with one implementation
- **Pattern-recognition:** Log prefix "thinker" inconsistent with "reviewer" naming
- **Pattern-recognition:** TIMEOUT vs TASK_TIMEOUT naming inconsistency

## Effort: Small | Risk: Low

## Acceptance Criteria
- [ ] 6 unused task-adapter functions removed
- [ ] Log prefix changed from `[thinker ...]` to `[reviewer ...]`
- [ ] Timeout variable naming unified
