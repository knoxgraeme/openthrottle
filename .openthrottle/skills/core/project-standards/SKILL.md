---
name: project-standards
description: Use when reviewing a change against committed architecture, packaging, documentation, or contributor conventions.
---

# Project standards review

Check only standards that are explicit in repository instructions, normative
documentation, executable architecture tests, or a clear nearest-neighbour
pattern.

## Review method

1. Read the repository instruction files that govern each changed path.
2. Identify applicable architecture, module ownership, import, packaging,
   command, and documentation rules.
3. Compare the change with executable tests and the nearest canonical example.
4. Check all mirrored or generated surfaces named by the standard when a
   shipped behaviour, command, or package changes.
5. Verify normative operator and runtime documentation matches executable
   defaults, credentials, limits, and ordering.
6. For Agent Skills, keep reusable craft in the skill and keep agent role,
   repository policy, task-specific context, and result transport in their
   owning platform layers.

## Finding bar

Quote or precisely paraphrase the governing standard, name the changed path and
stable construct that violates it, and explain the observable packaging,
runtime, CI, or contributor consequence. When standards conflict, use the
nearest higher-authority instruction and surface the contradiction.

## Exclusions

Do not report personal style taste, formatter-owned differences, broad refactor
preferences, naming without a contract effect, unchanged drift, missing docs
for private helpers, or a preferred pattern unsupported by committed guidance.
