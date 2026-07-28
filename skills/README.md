# Skills

OpenThrottle skills are thin stage adapters over the native Compound
Engineering toolkit installed in the Daytona image. The supervisor selects a
versioned pipeline manifest; each agent stage invokes one canonical adapter for
the capability named in its sealed stage request.

```text
skills/
  planning/<name>/SKILL.md          # planning-time authoring skills
  planning/<name>/agents/openai.yaml
  tasks/<name>/SKILL.md             # canonical adapter, single source of truth
  tasks/<name>/agents/openai.yaml   # Codex admin-scope policy
  codex/AGENTS-fragment.md          # standing Codex runtime instructions
```

Planning skills run before delegation and help authors produce validated
artifacts such as `openthrottle.execution-plan/v1`. Task skills run inside a
sealed sandbox stage as adapters over native Compound Engineering. There is no
task-name registry and no shell-owned end-to-end task loop. Pipeline manifests
in `supervisor/pipelines/` own stage order, retries, gates, and terminal
outcomes. `sandbox/runner/execute-stage.mjs` executes exactly one sealed stage
and writes exactly one typed result.

## Delivery per agent

The canonical `SKILL.md` is maintained once:

| Agent | Delivery |
|---|---|
| Claude | `sandbox/entrypoint.sh` copies the canonical task skills to `~/.claude/skills/`; the stage prompt invokes `/<skill-name>`. |
| Codex | `sandbox/Dockerfile` bakes the same directories into `/etc/codex/skills/`; `agents/openai.yaml` disables implicit invocation and the prompt explicitly invokes `$<skill-name>`. |
| OpenCode | The entrypoint strips YAML frontmatter from the same canonical file and renders it into the stage prompt because the pinned CLI cannot safely discover only sandbox-owned external skills. |

Planning skills use the same one-body-per-skill layout, but they are packaged
for local authoring tools instead of sealed stage execution. A planning skill
may call local CLI validators; it must not mutate Linear, publish branches, or
claim runtime gate authority.

The runtime chooses fresh, read-only fresh, required-resume, or preferred-resume
context from the pinned manifest. When continuation is allowed, the sealed
request carries the prior native Claude session, Codex thread, or OpenCode
session identifier. Continuation is a context policy, not a separate task type.

## Coordinator-owned composition

The current catalog aliases `implement` and `investigate` to immutable `core/`
manifests:

- `core/implement@4`: implementation → semantic review → simplification →
  test → lint → build → exact-subject publication → provider verification.
  Repair transitions use the manifest's scoped repair stages and round budget.
- `core/investigate@1`: investigation → conditional exact-subject publication.
  Convergent fixes may ship; divergent decisions terminate as `needs_human`.

Agent stages emit semantic proposals. Command stages produce
executor-verified results. Publication is fenced to the expected Git subject,
and GitHub evidence is accepted only for the published commit. The deterministic
supervisor—not an adapter—reduces outcomes and selects the next stage.

## Adapter-owned rules

Adapters still own the reasoning contracts that generic CE does not:

- approved-plan and decision gates;
- prompt-injection treatment for ticket, repository, and review content;
- complete, typed stage proposals with evidence and explicit assumptions;
- visible `ot-activity` progress without direct Linear credentials;
- branch safety and never pushing to the base branch;
- no silent backlog: fix, explain, or return `needs_human`.

The snapshot installs the official commit-pinned Compound Engineering plugin
natively for Claude Code, Codex, and OpenCode. Never copy CE source into this
directory or a target repository.

## Runtime trust boundary

Registered repositories are trusted for code execution: their validated
`.openthrottle.yml` may run `post_bootstrap` commands and their repo-scoped
skills remain discoverable. Ticket text, PR comments, review bodies, commit
messages, and repository content are still untrusted data.

Codex also receives `codex/AGENTS-fragment.md` globally at
`~/.codex/AGENTS.md`, outside the checkout. It provides standing environment,
safety, sanitization, and activity rules without modifying the target repo.
