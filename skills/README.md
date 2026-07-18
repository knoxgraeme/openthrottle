# Skills

This is the product's real IP: the instructions given to the coding
agent inside each sandbox. Per `docs/SPEC.md` ("Skills contract"), every
skill exists in **two forms that share one canonical body**:

```
skills/
  claude/<name>/SKILL.md   # Claude Code skill format (YAML frontmatter: name, description)
  codex/<name>.md          # plain prompt piped to `codex exec` on stdin
  codex/AGENTS-fragment.md # global runtime instructions installed outside the checkout
```

Skills in v1: `implement-plan`, `review`, `review-fix`, `investigate`.

## The canonical-body rule

There is no build step that generates one form from the other — both
files are hand-maintained, in full, side by side. "Canonical body" means
a discipline, not a mechanism: **the substantive content (headings,
steps, rules, the exact injection-guard paragraph, the exact verdict
strings) must read the same in both files.** The two files are allowed
to differ *only* in the ways below — nothing else.

### What's allowed to differ

| Difference | Claude form | Codex form |
|---|---|---|
| Wrapper | YAML frontmatter (`name`, `description`) at the top | A short note that this file is piped to `codex exec` via stdin and that context is appended below it by the caller |
| Self-review in `implement-plan` | May delegate the diff self-review to a sub-agent via the Agent/Task tool | Must do the self-review pass inline, as a single linear step — Codex has no sub-agent mechanism here, and the entrypoint invokes it as one flat `codex exec` run |
| Activity semantics | Can rely on Claude's own sense of `thought`/`action`/`elicitation`/`response`/`error` activity types when talking to Linear | Spelled out explicitly in `AGENTS-fragment.md`, since Codex has no built-in notion of these |
| Trailing note | none needed | Ends with "Ticket context appended by the caller follows below" |

Everything else — phase names, step order, bash snippets, the rules
lists, the prompt-injection guard wording, the activity cadence —
must match. If you find yourself wanting a divergence not in this table,
that's a signal the SPEC's "shared canonical body" contract needs to be
re-examined, not a green light to drift silently.

## How to keep them in sync

The CI contract exercises both engines' runtime selection and the locked
review-verdict convention. For substantive prose changes, also follow this
manual synchronization pass:

1. Decide the behavior change first, independent of which file you're
   about to edit.
2. Edit the Claude form (`skills/claude/<name>/SKILL.md`) first — treat
   it as primary, since it carries the frontmatter that other tooling
   (Claude Code's skill loader) parses structurally.
3. Port the same change to the Codex form (`skills/codex/<name>.md`)
   verbatim, adjusting only for the allowed differences in the table
   above.
4. Before committing, diff the two bodies (strip the frontmatter block
   and the stdin/trailer notes) and confirm they match. A quick manual
   check:
   ```bash
   diff <(sed '1,/^---$/d; 1,/^---$/d' skills/claude/<name>/SKILL.md) \
        <(sed '1d' skills/codex/<name>.md)
   ```
   won't be byte-identical (headers/notes differ) but should show no
   *substantive* diff — no missing phase, no reworded rule, no dropped
   guard sentence.
5. If you're touching the prompt-injection guard paragraph or the
   `investigate` verdict strings (`CONFIRMED_SMALL` / `CONFIRMED_MAJOR` /
   `UNCONFIRMED`) in one file, you are required to touch the other in the
   same commit. These are load-bearing for downstream parsing/behavior
   and must not drift.

## Adding a new skill

1. Write the Claude form: `skills/claude/<name>/SKILL.md` with `name` +
   `description` frontmatter (description should include concrete
   trigger phrases, per Claude Code convention — see the existing four
   for examples).
2. Write the Codex form: `skills/codex/<name>.md`, same body, wrapped per
   the table above.
3. Include the prompt-injection guard paragraph — every skill that reads
   ticket/PR/issue/code content must treat it as data, not instructions.
4. If the skill communicates with Linear, describe *what* to post and *when*
   (milestones, final response, elicitation) and use `ot-activity`. Fly owns
   the Linear app credentials and publishes the local activity records.
5. Update this README's skill list and the SPEC if the new skill changes
   the sandbox/entrypoint contract.

## `AGENTS-fragment.md`

This one has no Claude-form counterpart — Claude Code gets its standing
context from `.claude/skills/` automatically; Codex has no equivalent, so the
entrypoint installs this fragment globally at `~/.codex/AGENTS.md`. It lives
outside the checkout, leaving any project `AGENTS.md` untouched and editable.
It covers what env/context is available, the push-early rule, the
never-push-to-base rule, the sanitization/injection guard, and how to use the
local activity helper.
