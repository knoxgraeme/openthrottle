---
name: openthrottle-ship
description: >
  Ship prompts to Daytona sandboxes, check status, or view recent activity.
  Use when: "ship this prompt", "queue prompt", "check status", "what's running",
  or any interaction with Open Throttle. Run `npx create-openthrottle` first
  if the pipeline hasn't been set up yet.
disable-model-invocation: true
argument-hint: [prompt-file.md | status] [--base branch]
---

# Ship Prompt

Ship prompts and check status via the `gh` CLI. Works from any environment
with `gh` installed (Claude Code, Claude Desktop, terminal, CI, etc.).

---

## Config

Read `.openthrottle.yml` at the repo root for:

```bash
GITHUB_REPO=$(git remote get-url origin | sed -E 's|.*github.com[:/](.+/.+?)(\.git)?$|\1|')
BASE_BRANCH=$(grep '^base_branch:' .openthrottle.yml | awk '{print $2}')
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
for LABEL in prd-queued prd-running prd-complete prd-failed needs-review reviewing bug-queued bug-running bug-complete bug-failed; do
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

Query GitHub directly:

```bash
echo "RUNNING"
gh issue list --repo "$GITHUB_REPO" --label "prd-running" --state open --json number,title --jq '.[] | "  #\(.number) — \(.title)"'

echo "QUEUE"
gh issue list --repo "$GITHUB_REPO" --label "prd-queued" --state open --sort created --json number,title --jq '.[] | "  #\(.number) — \(.title)"'

echo "REVIEW"
gh pr list --repo "$GITHUB_REPO" --label "needs-review" --json number,title --jq '.[] | "  pending: #\(.number) — \(.title)"'
gh pr list --repo "$GITHUB_REPO" --label "reviewing" --json number,title --jq '.[] | "  active:  #\(.number) — \(.title)"'
gh pr list --repo "$GITHUB_REPO" --search "review:changes_requested" --json number,title --jq '.[] | "  fixes:   #\(.number) — \(.title)"'

echo "COMPLETED (recent)"
gh issue list --repo "$GITHUB_REPO" --label "prd-complete" --state closed --sort updated --limit 5 --json number,title --jq '.[] | "  #\(.number) — \(.title)"'
```

---

### View Logs

Sandbox logs are available in GitHub Actions:

```bash
gh run list --workflow="Wake Sandbox" --limit 5
gh run view <run-id> --log
```

---

## After Shipping

Always tell the user:
- The issue URL that was created
- Whether it started immediately or was queued (check queue position)
- That they'll get a Telegram message when the PR is ready (if configured)
- How to check: `/openthrottle-ship status`
