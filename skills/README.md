# Skills

These are thin OpenThrottle task adapters. They connect Fly's deterministic
task state machine, branch boundary, activity outbox, and Linear/GitHub
publication contract to native Compound Engineering skills installed in the
Daytona image.

```text
skills/
  tasks/<name>/SKILL.md          # canonical adapter — single source of truth
  tasks/<name>/agents/openai.yaml  # Codex admin-scope skill policy
  codex/AGENTS-fragment.md       # standing Codex runtime instructions
```

`skills/tasks/<name>/SKILL.md` is the one file maintained by hand per task.
Its YAML frontmatter (`name`, `description`) is the same file Claude Code
loads natively as a user-level skill, so there is no per-agent copy to keep in
sync. The two canonical tasks are `implement-plan` and `investigate`. Resume
does not start an adapter; it resumes the saved native Claude session, Codex
thread, or OpenCode session with a follow-up message — including PR feedback
that arrived while the run was idle (see "Two loops" below).

## Delivery per agent

The canonical `SKILL.md` is the input; each agent CLI receives it through
whatever mechanism that CLI natively supports, decided once in
`sandbox/entrypoint.sh` and `sandbox/Dockerfile`:

| Agent | Mechanism |
|---|---|
| Claude | `sandbox/entrypoint.sh` copies `/opt/openthrottle/skills/tasks/.` into the sandbox user's `~/.claude/skills/` (user scope) every run. Invocation: `claude -p "/<skill-name>" ...`. |
| Codex | `sandbox/Dockerfile` bakes the same canonical directories into `/etc/codex/skills/<name>/` at image build time (admin scope — Codex discovers these without any per-run copy). Each skill's `agents/openai.yaml` sets `policy.allow_implicit_invocation: false` so a skill only runs when the entrypoint's prompt explicitly names it. Invocation: the piped stdin begins with `$<skill-name>` on its own line, followed by the runtime-context and Linear-context blocks. |
| OpenCode | The pinned version cannot yet discover agent-standard skills from a sandbox-owned directory while ignoring project-external sources (Phase 3 item 4's open question), so the entrypoint renders the prompt at run time: it strips the canonical file's YAML frontmatter and appends the same runtime-context and Linear-context blocks passed to Codex. Invocation flags are unchanged, including the `OPENCODE_DISABLE_*` env that keeps the sandbox off repo-local and Claude-compatibility config. |

## Two loops

- **implement** — plan gate → `ce-work` → local `ce-code-review` →
  conditional `ce-simplify` (only when the diff is large or structurally
  complex; behavior-preserving, skips noted in the ledger) → configured
  gates (`$OT_TEST_CMD`/`$OT_LINT_CMD`/`$OT_BUILD_CMD`) → `ce-commit-push-pr`
  → resolve the PR URL and retarget it to `$BASE_BRANCH` if needed → wait for
  CI to settle (`gh pr checks --watch`, fixing in-scope reds in the same run)
  → refresh the `## OpenThrottle gates` checklist in the PR description →
  elicitation-or-response ending in "Assumptions & decisions".
- **investigate** — the debugging analogue: `ce-debug mode:pipeline` (action-
  capable — it may diagnose, fix, verify, commit, and push a convergent bug),
  then the same PR-resolve/retarget step if it shipped a fix, then
  elicitation-or-response.

Neither loop babysits its own PR. Once a PR exists, GitHub-native reviewers
(bot or human) take over review, and their feedback — reviews, PR comments, CI
failures — is queued by the supervisor and delivered later as a `resume`
message in the **same session**, not as a new task and not as a fresh
context. That resume message is where the triage happens: gather the whole
picture first (`gh pr checks` plus every open review thread and comment), reply
visibly on **every** item — a change gets a reply naming what was done and the
commit that addresses it, with the thread resolved; a no-change gets a reply
with reasoning — wait for CI to go green (fixing in-scope reds in the same run)
before finalizing, refresh the `## OpenThrottle gates` checklist, and batch any
decision-required items into one further elicitation.

## Native CE composition

| OpenThrottle task | Native CE pipeline |
|---|---|
| `implement` | `ce-work mode:return-to-caller` → `ce-code-review apply:local` → conditional `ce-simplify` (large/complex diffs only) → `ce-commit-push-pr mode:pipeline` |
| `investigate` | `ce-debug mode:pipeline`; if it shipped a fix, resolve/create the PR |
| `resume` | continues the saved native session with the human's or GitHub's follow-up message |

The snapshot installs the official `compound-engineering` plugin natively for
Claude Code, Codex, and OpenCode from one commit-pinned marketplace checkout. Do not
copy CE source into this directory or into target repositories: native install
preserves its skill-local reviewer/research assets and makes every target repo
use the same version.

## Adapter-owned rules

The adapters remain necessary for contracts that CE does not own:

- The hard approved-plan gate before implementation.
- The decision gate: critical, foundational, or risky changes are never
  implemented without a human answer. Clear fixes ship first; the remaining
  items go out as one batched `ot-activity elicitation` decision list
  (context, options, recommendation per item), and the Linear reply resumes
  the same session to action the answers.
- The no-backlog rule: every review item ends a run fixed and pushed with a
  reply naming the commit that addresses it, answered on its thread with
  reasoning, or escalated as a numbered decision — never silently deferred or
  dropped. This rule applies identically to the feedback-triage resume that
  follows a PR, not just the original run.
- The CI gate: a run does not finalize while CI is red or still running. After
  any push, the adapter waits for `gh pr checks` to conclude and fixes in-scope
  failures in the same run; only genuinely pre-existing/out-of-scope reds are
  left, and then only as a recorded known gap.
- The gate checklist: each run writes or refreshes an `## OpenThrottle gates`
  checklist in the PR description (tests, lint, build, internal review,
  simplification, CI, review threads) so a human can see which gates completed.
  A gate that could not run — e.g. one the sandbox OOM-killed (exit 137) — is
  marked a known gap, never reported as passed.
- The assumptions ledger: responses and PR descriptions end with an
  "Assumptions & decisions" section so a human can audit every judgment call
  the agent made without asking.
- The existing checked-out branch and sealed never-push-to-base boundary.
- `ot-activity` semantic events; Fly alone holds Linear app credentials and
  publishes as OpenThrottle.
- Prompt-injection treatment for ticket, repository, and review content.

`investigate` is deliberately action-capable. Native `ce-debug mode:pipeline`
may diagnose, test, fix, commit, and push a convergent bug. Product/design
decisions and other divergent fixes remain needs-human residuals.

## Keeping the canonical skills accurate

Each canonical `SKILL.md` is agent-neutral: on a skill's first mention it
spells out both invocation forms (e.g. "invoke the native Compound
Engineering skill `ce-work` (`/ce-work` in Claude Code; `$ce-work` in
Codex/OpenCode)"), then refers to it by bare name thereafter. Delivery
mechanics (Claude's user-skills copy, Codex's admin-scope bake plus
`agents/openai.yaml`, OpenCode's rendered prompt) are the only per-agent
difference and live entirely in `sandbox/entrypoint.sh` / `sandbox/Dockerfile`
— never hand-duplicate a skill's body per agent again.

Codex receives `AGENTS-fragment.md` globally at `~/.codex/AGENTS.md`, outside
the checkout. It provides standing environment, safety, sanitization, and
activity rules without modifying a target repository's own `AGENTS.md`.

## Decision recorded: repo-scope skill discovery stays enabled

Codex's repo-scope `.agents/skills` discovery (skills a target repository
checks in itself) stays **enabled**, even though the sandbox now also ships
admin-scope skills at `/etc/codex/skills`. Registered repositories are
already code-execution-trusted via `.openthrottle.yml`'s `post_bootstrap`
(the entrypoint runs arbitrary commands from repository config before the
agent starts), so a repo-checked-in skill adds no new capability beyond what
that repository could already do. This is an explicit invariant, not an
oversight: registered repos are trusted for code execution and skills;
ticket text, PR comments, and review bodies remain untrusted data regardless
of where they are read from.
