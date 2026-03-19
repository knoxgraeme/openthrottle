# Bootstrap Steps

Detailed commands for Steps 4-9 of setup. Run these after completing
project detection (Step 1), config generation (Step 2), and env var
validation (Step 3) from the main SKILL.md.

---

## Step 4 — Create or Connect Sprite

```bash
SPRITE=$(grep '^sprite:' .sodaprompts.yml | awk '{print $2}')
SPRITE="${SPRITE:-soda-base}"

# Check if sprite already exists
if sprite exec -s "$SPRITE" -- echo "ok" 2>/dev/null; then
  echo "Sprite '$SPRITE' exists and is reachable"
else
  echo "Creating sprite '$SPRITE'..."
  sprite create "$SPRITE"
fi
```

---

## Step 5 — Authenticate Claude on Sprite

```bash
AUTH_CHECK=$(sprite exec -s "$SPRITE" -- claude -p "reply with only OK" --output-format text 2>&1 || true)

if echo "$AUTH_CHECK" | grep -qi "login\|auth\|sign in\|not logged\|unauthorized"; then
  echo ""
  echo "Claude Code needs to be authenticated on the Sprite."
  echo ""
  echo "Steps:"
  echo "  1. Run: sprite console -s $SPRITE"
  echo "  2. Inside the sprite, run: claude"
  echo "  3. Open the printed URL in your browser and log in"
  echo "  4. Ctrl+C once authenticated"
  echo "  5. Re-run /sodaprompts-setup"
  echo ""
  # STOP HERE — do not continue until auth is done
fi
```

If Claude is already authenticated, continue.

---

## Step 6 — Bootstrap the Sprite

### 6a. Upload files

The setup skill, hooks, and scripts are part of the sodaprompts plugin.
Find them relative to this SKILL.md's directory.

```bash
# Locate the sodaprompts-setup skill directory. Prefer exact plugin path
# to avoid matching unrelated directories.
PLUGIN_DIR="$(find ~/.claude -path '*/sodaprompts/skills/sodaprompts-setup' -type d | head -1)"
if [[ -z "$PLUGIN_DIR" ]]; then
  PLUGIN_DIR="$(find ~/.claude -path '*/sodaprompts-setup' -type d | head -1)"
fi

# Create directories on the Sprite
sprite exec -s "$SPRITE" -- bash -c "
  mkdir -p /tmp/pipeline/hooks \
           /home/sprite/{prd-inbox,logs}
"

# Upload bootstrap script
sprite exec -s "$SPRITE" -- bash -c "cat > /tmp/pipeline/bootstrap.sh" \
  < "${PLUGIN_DIR}/scripts/bootstrap.sh"

# Upload hooks
for hook in block-push-to-main.sh log-commands.sh auto-format.sh; do
  sprite exec -s "$SPRITE" -- bash -c "cat > /tmp/pipeline/hooks/${hook}" \
    < "${PLUGIN_DIR}/hooks/${hook}"
done

# Upload bootstrap-common.sh
sprite exec -s "$SPRITE" -- bash -c "cat > /tmp/pipeline/bootstrap-common.sh" \
  < "${PLUGIN_DIR}/scripts/bootstrap-common.sh"

# Upload install-skill.sh
sprite exec -s "$SPRITE" -- bash -c "cat > /tmp/pipeline/install-skill.sh" \
  < "${PLUGIN_DIR}/scripts/install-skill.sh"

# Upload Telegram poller
sprite exec -s "$SPRITE" -- bash -c "cat > /tmp/pipeline/telegram-poller.sh" \
  < "${PLUGIN_DIR}/scripts/telegram-poller.sh"

# Upload project config
sprite exec -s "$SPRITE" -- bash -c "cat > /tmp/pipeline/sodaprompts.yml" \
  < .sodaprompts.yml
```

### 6b. Push .env files from local machine

Push all local `.env` files to a staging directory on the sprite. Bootstrap.sh
copies them into the repo after cloning — this avoids a directory collision
where the repo clone fails because `/home/sprite/repo/` already exists.

```bash
# Push all .env files to staging (bootstrap.sh copies them after clone)
find . \( -name '.env' -o -name '.env.local' -o -name '.env.*' \) -print \
  | grep -v node_modules | grep -v .git \
  | while read -r envfile; do
      RELPATH="${envfile#./}"
      echo "  Pushing $RELPATH"
      sprite exec -s "$SPRITE" -- bash -c "mkdir -p /tmp/env-staging/$(dirname "$RELPATH")"
      cat "$envfile" | sprite exec -s "$SPRITE" -- bash -c "cat > /tmp/env-staging/${RELPATH}"
    done
```

### 6c. Run bootstrap

```bash
sprite exec -s "$SPRITE" -- bash -c "
  cd /tmp/pipeline &&
  chmod +x bootstrap.sh &&
  set -a && source /tmp/env-staging/.env && set +a &&
  bash bootstrap.sh
"
```

Takes ~5 minutes. Installs tools, clones the repo, configures hooks/MCP,
installs the sodaprompts plugin, and persists env vars.

---

## Step 7 — Apply Network Policy

Apply the egress policy **after** bootstrap (which needs broad internet access for
apt/npm installs) but **before** checkpoint (so the golden-base starts locked down).

This runs from **your machine** (not inside the sprite) using the sprite CLI's
auth (from `sprite login`). The sprite never has policy API access — it cannot
modify its own network restrictions.

Policies are sprite-level config (not filesystem), so they persist through
checkpoint restore. The wake workflow only needs to restore — no re-apply needed.

Read the `network_policy` section from `.sodaprompts.yml` and build the API payload.
Skip this step if `network_policy` is absent.

API reference: https://sprites.dev/api/sprites/policies

```bash
# Check if network_policy is configured
HAS_POLICY=$(python3 -c "
import yaml
with open('.sodaprompts.yml') as f:
    config = yaml.safe_load(f) or {}
np = config.get('network_policy')
print('yes' if np and np.get('allow') else 'no')
" 2>/dev/null || echo "no")

if [[ "$HAS_POLICY" == "yes" ]]; then
  # Build the rules JSON:
  #   - Each allowed domain → {"action":"allow","domain":"..."}
  #   - Optional preset → {"include":"preset-name"}
  #   - Deny-all catch-all appended to block everything else
  RULES_JSON=$(python3 -c "
import yaml, json
with open('.sodaprompts.yml') as f:
    config = yaml.safe_load(f) or {}
np = config.get('network_policy', {})
rules = []
preset = np.get('preset', '')
if preset:
    rules.append({'include': preset})
for domain in np.get('allow', []):
    rules.append({'action': 'allow', 'domain': domain})
rules.append({'action': 'deny', 'domain': '*'})
print(json.dumps({'rules': rules}))
" 2>/dev/null || echo "")

  if [[ -n "$RULES_JSON" ]]; then
    echo "Applying network policy to sprite ${SPRITE}..."
    echo "$RULES_JSON" | jq .

    # Uses sprite CLI auth (from sprite login) — no SPRITES_TOKEN needed
    echo "$RULES_JSON" | sprite api -s "$SPRITE" \
      /v1/sprites/${SPRITE}/policy/network \
      -X POST \
      -H "Content-Type: application/json" \
      -d @- \
    && echo "Network policy applied" \
    || echo "WARNING: Failed to apply network policy — sprite has unrestricted egress"
  fi
else
  echo "No network_policy configured — egress is unrestricted"
fi
```

---

## Step 8 — Checkpoint

```bash
sprite checkpoint create -s "$SPRITE" --comment "golden-base"
```

---

## Step 9 — Verify

```bash
# Verify Claude works
sprite exec -s "$SPRITE" -- claude -p "reply with only OK" --output-format text

# Verify repo is cloned
sprite exec -s "$SPRITE" -- ls /home/sprite/repo/package.json

# Verify sodaprompts plugin is installed
sprite exec -s "$SPRITE" -- claude -p "list your available skills" --output-format text 2>/dev/null | grep -i sodaprompts

# Verify hooks are installed
sprite exec -s "$SPRITE" -- ls ~/.claude/hooks/

# Verify gh is authenticated
sprite exec -s "$SPRITE" -- gh auth status
```

---

## Step 10 — Install Wake Workflow

The wake workflow is a GitHub Action that restores sprites when work arrives.
Without it, sprites must be manually started.

```bash
PLUGIN_DIR="$(find ~/.claude -path '*/sodaprompts/skills/sodaprompts-setup' -type d | head -1)"
[[ -z "$PLUGIN_DIR" ]] && PLUGIN_DIR="$(find ~/.claude -path '*/sodaprompts-setup' -type d | head -1)"
WORKFLOW_SRC="$(dirname "$PLUGIN_DIR")/../../.github/workflows/wake-sprite.yml"

mkdir -p .github/workflows
cp "$WORKFLOW_SRC" .github/workflows/wake-sprite.yml
```

Then tell the user to set repository secrets and variables:

```
GitHub → Settings → Secrets and variables → Actions

Secrets:
  SPRITES_TOKEN  — your Sprites API token

Variables:
  BUILDER_SPRITE — name of the Doer sprite (e.g. "soda-base")
```

If the user opts into the reviewer (Step 12), also set:
```
Variables:
  REVIEWER_SPRITE — name of the Thinker sprite (e.g. "soda-reviewer")
```

---

## Step 11 — Done

Print the summary:

```
Soda Prompts setup complete!

  Sprite:      <name>
  Repo:        <github_repo>
  Config:      .sodaprompts.yml
  Checkpoint:  golden-base
  Wake:        .github/workflows/wake-sprite.yml
  Egress:      <preset> + <N> allowed domains (or "unrestricted")

  How it works:
    1. Ship a prompt:  /sodaprompts-ship path/to/feature.md
    2. GitHub Action wakes the sprite automatically
    3. Sprite works, opens a PR, goes back to sleep
    4. Telegram notification when PR is ready

  Check status:  /sodaprompts-ship status

  Refresh Claude auth (every few weeks):
    sprite console -s <sprite> → claude login
    sprite checkpoint create -s <sprite> --comment golden-base
```

Remind the user to commit `.sodaprompts.yml` and `.github/workflows/wake-sprite.yml`.

---

## Step 12 — Reviewer Sprite (Optional)

After the Doer sprite is set up and verified, ask the user:

> "Would you like to add automated PR review? This creates a second Thinker
> Sprite that does task-aware review of PRs opened by the Doer. It checks out
> the branch, reads the original issue for context, reviews for task alignment,
> best practices, and security, and can commit trivial fixes directly."

If the user says **no**, skip to the end. They can add it later by re-running
`/sodaprompts-setup`.

If the user says **yes**, continue:

### 12a. Configure reviewer

Ask the user:

| Setting | Default | Question |
|---|---|---|
| Sprite name | `soda-reviewer` | "What name for the reviewer sprite?" |
| Agent runtime | `claude` | "Which agent runtime? (claude / codex)" |
| Max review rounds | `3` | "Max review rounds before auto-approve?" |
| Poll interval | `60` | "Poll interval in seconds?" |

Add the `reviewer` section to `.sodaprompts.yml`:

```yaml
reviewer:
  sprite: soda-reviewer
  agent_runtime: claude
  max_rounds: 3
  poll_interval: 60
```

### 12b. Create reviewer sprite

```bash
REVIEWER_SPRITE=$(grep -A5 '^reviewer:' .sodaprompts.yml | grep 'sprite:' | awk '{print $2}')
REVIEWER_SPRITE="${REVIEWER_SPRITE:-soda-reviewer}"

if sprite exec -s "$REVIEWER_SPRITE" -- echo "ok" 2>/dev/null; then
  echo "Reviewer sprite '$REVIEWER_SPRITE' exists"
else
  echo "Creating reviewer sprite '$REVIEWER_SPRITE'..."
  sprite create "$REVIEWER_SPRITE"
fi
```

### 12c. Authenticate agent on reviewer sprite

For Claude:
```bash
AUTH_CHECK=$(sprite exec -s "$REVIEWER_SPRITE" -- claude -p "reply with only OK" --output-format text 2>&1 || true)
if echo "$AUTH_CHECK" | grep -qi "login\|auth\|sign in\|not logged\|unauthorized"; then
  echo "Claude Code needs auth on the reviewer sprite."
  echo "  1. Run: sprite console -s $REVIEWER_SPRITE"
  echo "  2. Inside: claude"
  echo "  3. Open URL and log in"
  echo "  4. Ctrl+C, then re-run setup"
  # STOP HERE
fi
```

For Codex: similar flow with `codex` instead of `claude`.

### 12d. Upload files and run bootstrap

```bash
REVIEWER_DIR="$(find ~/.claude -path '*/sodaprompts-reviewer' -type d | head -1)"
INVESTIGATOR_DIR="$(find ~/.claude -path '*/sodaprompts-investigator' -type d | head -1)"

# Create directories
sprite exec -s "$REVIEWER_SPRITE" -- bash -c "
  mkdir -p /tmp/pipeline /tmp/pipeline-reviewer /tmp/pipeline-investigator \
           /home/sprite/logs
"

# Upload shared bootstrap scripts
sprite exec -s "$REVIEWER_SPRITE" -- bash -c "cat > /tmp/pipeline/bootstrap-common.sh" \
  < "${PLUGIN_DIR}/scripts/bootstrap-common.sh"
sprite exec -s "$REVIEWER_SPRITE" -- bash -c "cat > /tmp/pipeline/install-skill.sh" \
  < "${PLUGIN_DIR}/scripts/install-skill.sh"

# Upload reviewer skill + runner
sprite exec -s "$REVIEWER_SPRITE" -- bash -c "cat > /tmp/pipeline-reviewer/SKILL.md" \
  < "${REVIEWER_DIR}/SKILL.md"
sprite exec -s "$REVIEWER_SPRITE" -- bash -c "cat > /tmp/pipeline-reviewer/run-reviewer.sh" \
  < "${REVIEWER_DIR}/run-reviewer.sh"

# Upload investigator skill
sprite exec -s "$REVIEWER_SPRITE" -- bash -c "cat > /tmp/pipeline-investigator/SKILL.md" \
  < "${INVESTIGATOR_DIR}/SKILL.md"

# Upload bootstrap-reviewer.sh
sprite exec -s "$REVIEWER_SPRITE" -- bash -c "cat > /tmp/pipeline/bootstrap-reviewer.sh" \
  < "${REVIEWER_DIR}/bootstrap-reviewer.sh"

# Push .env files to staging (bootstrap copies them after clone)
find . \( -name '.env' -o -name '.env.local' -o -name '.env.*' \) -print \
  | grep -v node_modules | grep -v .git \
  | while read -r envfile; do
      RELPATH="${envfile#./}"
      sprite exec -s "$REVIEWER_SPRITE" -- bash -c "mkdir -p /tmp/env-staging/$(dirname "$RELPATH")"
      cat "$envfile" | sprite exec -s "$REVIEWER_SPRITE" -- bash -c "cat > /tmp/env-staging/${RELPATH}"
    done

# Run bootstrap
AGENT_RUNTIME=$(grep -A5 '^reviewer:' .sodaprompts.yml | grep 'agent_runtime:' | awk '{print $2}')
sprite exec -s "$REVIEWER_SPRITE" -- bash -c "
  cd /tmp/pipeline &&
  chmod +x bootstrap-reviewer.sh &&
  set -a && source /tmp/env-staging/.env && set +a &&
  AGENT_RUNTIME=${AGENT_RUNTIME:-claude} bash bootstrap-reviewer.sh
"
```

### 12e. Apply network policy to reviewer sprite

Use the same network policy as the Doer sprite (read from `.sodaprompts.yml`).
The reviewer needs the same domains (GitHub for PR access, Telegram for notifications,
LLM providers for agent auth).

Same as Step 7 — apply the network policy from `.sodaprompts.yml` to the
reviewer sprite.

```bash
# Reuse the same policy-building logic from Step 7
HAS_POLICY=$(python3 -c "
import yaml
with open('.sodaprompts.yml') as f:
    config = yaml.safe_load(f) or {}
np = config.get('network_policy')
print('yes' if np and np.get('allow') else 'no')
" 2>/dev/null || echo "no")

if [[ "$HAS_POLICY" == "yes" ]]; then
  RULES_JSON=$(python3 -c "
import yaml, json
with open('.sodaprompts.yml') as f:
    config = yaml.safe_load(f) or {}
np = config.get('network_policy', {})
rules = []
preset = np.get('preset', '')
if preset:
    rules.append({'include': preset})
for domain in np.get('allow', []):
    rules.append({'action': 'allow', 'domain': domain})
rules.append({'action': 'deny', 'domain': '*'})
print(json.dumps({'rules': rules}))
" 2>/dev/null || echo "")

  if [[ -n "$RULES_JSON" ]]; then
    echo "$RULES_JSON" | sprite api -s "$REVIEWER_SPRITE" \
      /v1/sprites/${REVIEWER_SPRITE}/policy/network \
      -X POST \
      -H "Content-Type: application/json" \
      -d @- \
    && echo "Network policy applied to reviewer" \
    || echo "WARNING: Failed to apply network policy to reviewer sprite"
  fi
fi
```

### 12f. Checkpoint reviewer sprite

```bash
sprite checkpoint create -s "$REVIEWER_SPRITE" --comment "golden-base"
```

### 12g. Verify reviewer

```bash
# Check agent works
sprite exec -s "$REVIEWER_SPRITE" -- claude -p "reply with only OK" --output-format text

# Check gh auth
sprite exec -s "$REVIEWER_SPRITE" -- gh auth status

# Check skills installed
sprite exec -s "$REVIEWER_SPRITE" -- ls .claude/skills/sodaprompts-reviewer/SKILL.md
sprite exec -s "$REVIEWER_SPRITE" -- ls .claude/skills/sodaprompts-investigator/SKILL.md
```

Print reviewer summary:

```
Reviewer Sprite setup complete!

  Sprite:      <reviewer-name>
  Runtime:     <agent-runtime>
  Polling:     every <poll-interval>s for 'needs-review' PRs
  Max rounds:  <max-rounds>
  Checkpoint:  golden-base

  The Thinker reviews PRs labeled 'needs-review':
    - Checks out the branch and reads linked issue for task context
    - Reviews for task alignment, best practices, security
    - Triages the builder's deferred items
    - Commits trivial fixes directly (typos, formatting)
    - Posts structured review with blocking/non-blocking findings
    - Converges toward approval on re-reviews (no new P2/P3 blocks)
```
