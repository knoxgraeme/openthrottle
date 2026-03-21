---
name: sodaprompts-ship
description: >
  Ship prompts to the remote Sprite, check status, view logs, or kill
  a running session. Use when: "ship this prompt", "push to sprite", "queue prompt",
  "check sprite status", "show logs", "kill the session", "what's running",
  or any interaction with Soda Prompts. Run /sodaprompts-setup first
  if the pipeline hasn't been set up yet.
disable-model-invocation: true
argument-hint: [prompt-file.md | status | logs | kill | push-env] [--base branch]
---

# Ship Prompt

Interact with Soda Prompts running on your Sprite.

All ship and status operations use the `gh` CLI directly — no sprite exec needed.
This means shipping works from any environment with `gh` installed (Claude Code,
Claude Desktop, terminal, CI, etc.).

Note: The runner scripts (run-builder.sh, run-reviewer.sh) use `task-adapter.sh`
to abstract task management operations. This skill runs on the user's machine
and uses `gh` directly since it only targets GitHub.

Logs, kill, and push-env still require sprite exec (scripts in `scripts/` subdir).

---

## Config

Read `.sodaprompts.yml` at the repo root for:

```bash
GITHUB_REPO=$(git remote get-url origin | sed -E 's|.*github.com[:/](.+/.+?)(\.git)?$|\1|')
BASE_BRANCH=$(grep '^base_branch:' .sodaprompts.yml | awk '{print $2}')
BASE_BRANCH="${BASE_BRANCH:-main}"
```

Verify `gh` is authenticated before any operation:
```bash
gh auth status > /dev/null 2>&1
```

---

## Actions

### Ship a Prompt

When the user wants to ship/push/send/submit a prompt file:

1. **Validate and read the prompt file.** Verify the file exists and is a
   markdown file before proceeding. If the file doesn't exist or isn't readable,
   tell the user and stop.

   Extract the title from the first markdown heading:
```bash
TITLE=$(head -20 "$PRD_FILE" | grep -m1 '^#' | sed 's/^#* *//')
TITLE="${TITLE:-$(basename "$PRD_FILE" .md)}"
[[ "$TITLE" != PRD:* ]] && TITLE="PRD: ${TITLE}"
```

2. **Ensure labels exist** (idempotent):
```bash
for LABEL in prd-queued prd-running prd-complete prd-failed prd-paused needs-review reviewing bug-queued bug-running bug-complete bug-failed bug-paused; do
  gh label create "$LABEL" --repo "$GITHUB_REPO" --force 2>/dev/null || true
done
```

3. **Create the issue**:
```bash
LABELS="prd-queued"
[[ "$BASE_BRANCH" != "main" ]] && LABELS="${LABELS},base:${BASE_BRANCH}"

ISSUE_URL=$(gh issue create \
  --repo "$GITHUB_REPO" \
  --title "$TITLE" \
  --body "$(cat "$PRD_FILE")" \
  --label "$LABELS")
```

   If issue creation fails (auth expired, rate limit, network error), tell
   the user what went wrong. Common fixes: `gh auth login` to refresh,
   or check network connectivity. Do not retry silently.

4. **Show queue position**:
```bash
QUEUE_COUNT=$(gh issue list --repo "$GITHUB_REPO" --label "prd-queued" --state open --json number --jq 'length')
RUNNING=$(gh issue list --repo "$GITHUB_REPO" --label "prd-running" --state open --json number,title --jq '.[0] | "#\(.number) — \(.title)"' 2>/dev/null || echo "")
```

If `--base <branch>` is specified, use that instead of the config value.

**Examples:**
- "Ship docs/prds/auth.md" → read file, create issue with `prd-queued` label
- "Ship billing.md off dev" → same but add `base:dev` label

For multiple prompts, loop over the files and create one issue per file.

---

### Check Status

Query GitHub directly — no sprite exec needed:

```bash
echo "RUNNING"
gh issue list --repo "$GITHUB_REPO" --label "prd-running" --state open --json number,title --jq '.[] | "  #\(.number) — \(.title)"'

echo "QUEUE"
gh issue list --repo "$GITHUB_REPO" --label "prd-queued" --state open --sort created --json number,title --jq '.[] | "  #\(.number) — \(.title)"'

echo "REVIEW"
gh pr list --repo "$GITHUB_REPO" --label "needs-review" --json number,title --jq '.[] | "  pending: #\(.number) — \(.title)"'
gh pr list --repo "$GITHUB_REPO" --label "reviewing" --json number,title --jq '.[] | "  active:  #\(.number) — \(.title)"'
gh pr list --repo "$GITHUB_REPO" --search "review:changes_requested" --json number,title --jq '.[] | "  fixes:   #\(.number) — \(.title)"'

echo "PAUSED (env reset)"
gh issue list --repo "$GITHUB_REPO" --label "prd-paused" --state open --json number,title --jq '.[] | "  #\(.number) — \(.title)"'
gh issue list --repo "$GITHUB_REPO" --label "bug-paused" --state open --json number,title --jq '.[] | "  #\(.number) — \(.title)"'

echo "COMPLETED (recent)"
gh issue list --repo "$GITHUB_REPO" --label "prd-complete" --state closed --sort updated --limit 5 --json number,title --jq '.[] | "  #\(.number) — \(.title)"'
```

---

### View Logs

Requires sprite exec. Find this skill's `scripts/` directory (sibling to this
SKILL.md) and run:

```bash
SCRIPTS_DIR="$(dirname "$(find ~/.claude/plugins -path '*/sodaprompts-ship/scripts/logs.sh' -type f | head -1)")"
bash "$SCRIPTS_DIR/logs.sh" [prd-id]
```

- No ID → tails the currently running prompt's log
- With ID → shows that run's complete log

---

### Kill Running Session

Requires sprite exec. **Always confirm with the user before killing** — this
stops the prompt mid-run and any uncommitted work is lost.

```bash
SCRIPTS_DIR="$(dirname "$(find ~/.claude/plugins -path '*/sodaprompts-ship/scripts/kill.sh' -type f | head -1)")"
bash "$SCRIPTS_DIR/kill.sh"
```

---

### Push Env Update

When the user updates their `.env` (rotated keys, new secrets, etc.):

```bash
SCRIPTS_DIR="$(dirname "$(find ~/.claude/plugins -path '*/sodaprompts-ship/scripts/push-env.sh' -type f | head -1)")"
bash "$SCRIPTS_DIR/push-env.sh"
```

Pushes all local `.env` files to the sprite and re-checkpoints as
`golden-base` so future sessions pick up the changes.

Only needed when secrets change — not for regular prompt shipping.

---

## After Shipping

Always tell the user:
- The issue URL that was created
- Whether it started immediately or was queued (check queue position)
- That they'll get a Telegram message when the PR is ready
- How to check: `/sodaprompts-ship status`
