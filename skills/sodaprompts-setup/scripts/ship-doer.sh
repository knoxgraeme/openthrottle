#!/usr/bin/env bash
# =============================================================================
# ship-doer.sh — bootstrap a Doer sprite deterministically
#
# Runs on the user's machine. Creates/connects a sprite, uploads files,
# runs bootstrap, applies network policy, checkpoints, and verifies.
#
# Usage:
#   bash ship-doer.sh [--from-step N] [--config .sodaprompts.yml] [--verbose]
#
# On failure: outputs structured JSON between ===SHIP_ERROR_BEGIN/END===
# On success: outputs ===SHIP_COMPLETE=== with full status
# =============================================================================

SHIP_SCRIPT_NAME="ship-doer.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/ship-common.sh"

parse_args "$@"

# ── Globals populated by steps ────────────────────────────────────────────
SPRITE=""
BASE_BRANCH=""
PLUGIN_DIR=""
BUILDER_DIR=""

# ═════════════════════════════════════════════════════════════════════════
# Step functions
#
# Convention: call fail_step to set context, then ALWAYS return 1 after it.
# ═════════════════════════════════════════════════════════════════════════

step_read_config() {
  if [[ ! -f "$CONFIG_FILE" ]]; then
    fail_step "test -f $CONFIG_FILE" \
      ".sodaprompts.yml not found at '${CONFIG_FILE}'. Run /sodaprompts-setup Steps 2-3 first to generate it."
    return 1
  fi

  if ! check_yaml_parser; then
    fail_step "python3 -c 'import yaml'" "Install pyyaml: pip3 install pyyaml"
    return 1
  fi

  SPRITE=$(read_yaml_field "$CONFIG_FILE" "sprite" "soda-base") || {
    fail_step "read sprite from ${CONFIG_FILE}" "Check .sodaprompts.yml for YAML syntax errors."
    return 1
  }
  BASE_BRANCH=$(read_yaml_field "$CONFIG_FILE" "base_branch" "main") || {
    fail_step "read base_branch from ${CONFIG_FILE}" "Check .sodaprompts.yml for YAML syntax errors."
    return 1
  }

  log "Config loaded: sprite=${SPRITE}, base_branch=${BASE_BRANCH}"

  # Validate sprite name is set
  if [[ -z "$SPRITE" || "$SPRITE" == "None" ]]; then
    SPRITE="soda-base"
    warn "No sprite name in config, defaulting to 'soda-base'"
  fi

  return 0
}

step_locate_plugin() {
  PLUGIN_DIR=$(locate_plugin_dir) || {
    fail_step "find ~/.claude -path '*/sodaprompts-setup'" \
      "sodaprompts plugin not found. Install: claude plugin install knoxgraeme/sodaprompts"
    return 1
  }

  BUILDER_DIR=$(locate_skill_dir "sodaprompts-builder") || {
    fail_step "find ~/.claude -path '*/sodaprompts-builder'" \
      "sodaprompts-builder skill not found. Reinstall: claude plugin install knoxgraeme/sodaprompts"
    return 1
  }

  # Verify critical files exist
  local missing=()
  [[ -f "${PLUGIN_DIR}/scripts/bootstrap.sh" ]]       || missing+=("scripts/bootstrap.sh")
  [[ -f "${PLUGIN_DIR}/scripts/bootstrap-common.sh" ]] || missing+=("scripts/bootstrap-common.sh")
  [[ -f "${PLUGIN_DIR}/scripts/install-skill.sh" ]]    || missing+=("scripts/install-skill.sh")
  [[ -f "${PLUGIN_DIR}/scripts/telegram-poller.sh" ]]  || missing+=("scripts/telegram-poller.sh")
  [[ -f "${BUILDER_DIR}/SKILL.md" ]]                   || missing+=("builder/SKILL.md")
  [[ -f "${BUILDER_DIR}/scripts/run-builder.sh" ]]     || missing+=("builder/scripts/run-builder.sh")

  if [[ ${#missing[@]} -gt 0 ]]; then
    fail_step "file existence check" \
      "Missing files in plugin: ${missing[*]}. Reinstall: claude plugin install knoxgraeme/sodaprompts"
    return 1
  fi

  log "Plugin dir: ${PLUGIN_DIR}"
  log "Builder dir: ${BUILDER_DIR}"
  return 0
}

step_create_sprite() {
  # Check connectivity first
  if sprite exec -s "$SPRITE" -- echo "ok" &>/dev/null; then
    log "Sprite '${SPRITE}' exists and is reachable"
    return 0
  fi

  log "Creating sprite '${SPRITE}'..."
  if ! sprite create "$SPRITE"; then
    fail_step "sprite create ${SPRITE}" \
      "Failed to create sprite. Run 'sprite list' to check existing sprites. Destroy unused ones with 'sprite destroy <name>', or use an existing sprite by setting 'sprite: <name>' in .sodaprompts.yml"
    return 1
  fi
  log "Sprite '${SPRITE}' created"
  return 0
}

step_check_auth() {
  # First, verify sprite is reachable
  if ! sprite exec -s "$SPRITE" -- echo "connectivity-ok" &>/dev/null; then
    fail_step "sprite exec -s ${SPRITE} -- echo ok" \
      "Cannot reach sprite '${SPRITE}'. Check: sprite list. If stopped: sprite start ${SPRITE}"
    return 1
  fi

  local auth_check
  auth_check=$(sprite exec -s "$SPRITE" -- claude -p "reply with only OK" --output-format text 2>&1 || true)

  if echo "$auth_check" | grep -qi "login\|auth\|sign in\|not logged\|unauthorized"; then
    fail_step "sprite exec -s ${SPRITE} -- claude -p 'reply with only OK'" \
      "Claude Code is not authenticated on the sprite. Manual steps required: 1) Run: sprite console -s ${SPRITE}  2) Inside the sprite, run: claude  3) Open the printed URL in your browser and log in  4) Ctrl+C once authenticated  5) Re-run: bash ship-doer.sh --from-step 4"
    return 1
  fi

  if echo "$auth_check" | grep -qi "OK"; then
    log "Claude Code authenticated on sprite"
  else
    warn "Auth check returned unexpected output: ${auth_check}"
    warn "Proceeding — bootstrap will fail if auth is actually broken"
  fi

  # Warn about ANTHROPIC_API_KEY
  local api_key_check
  api_key_check=$(sprite exec -s "$SPRITE" -- bash -c 'echo "${ANTHROPIC_API_KEY:-}"' 2>/dev/null || true)
  if [[ -n "$api_key_check" ]]; then
    warn "ANTHROPIC_API_KEY is set on sprite — this overrides subscription login and bills per-token"
  fi

  return 0
}

step_upload_files() {
  log "Creating directories on sprite..."
  if ! sprite exec -s "$SPRITE" -- bash -c "
    mkdir -p /tmp/pipeline/hooks /tmp/pipeline-builder /home/sprite/{prd-inbox,logs}
  "; then
    fail_step "sprite exec -- mkdir" \
      "Failed to create directories on sprite. Check sprite is running: sprite list"
    return 1
  fi

  log "Uploading bootstrap scripts..."
  local upload_failed=false
  sprite_upload "$SPRITE" "${PLUGIN_DIR}/scripts/bootstrap.sh"        "/tmp/pipeline/bootstrap.sh"        || upload_failed=true
  sprite_upload "$SPRITE" "${PLUGIN_DIR}/scripts/bootstrap-common.sh" "/tmp/pipeline/bootstrap-common.sh" || upload_failed=true
  sprite_upload "$SPRITE" "${PLUGIN_DIR}/scripts/install-skill.sh"    "/tmp/pipeline/install-skill.sh"    || upload_failed=true
  sprite_upload "$SPRITE" "${PLUGIN_DIR}/scripts/telegram-poller.sh"  "/tmp/pipeline/telegram-poller.sh"  || upload_failed=true

  log "Uploading hooks..."
  for hook in block-push-to-main.sh log-commands.sh auto-format.sh; do
    if [[ -f "${PLUGIN_DIR}/hooks/${hook}" ]]; then
      sprite_upload "$SPRITE" "${PLUGIN_DIR}/hooks/${hook}" "/tmp/pipeline/hooks/${hook}" || upload_failed=true
    else
      warn "Hook not found: ${hook}"
    fi
  done

  log "Uploading builder skill..."
  sprite_upload "$SPRITE" "${BUILDER_DIR}/SKILL.md"                "/tmp/pipeline-builder/SKILL.md"       || upload_failed=true
  sprite_upload "$SPRITE" "${BUILDER_DIR}/scripts/run-builder.sh"  "/tmp/pipeline-builder/run-builder.sh" || upload_failed=true

  log "Uploading project config..."
  sprite_upload "$SPRITE" "$CONFIG_FILE" "/tmp/pipeline/sodaprompts.yml" || upload_failed=true

  if [[ "$upload_failed" == true ]]; then
    fail_step "sprite_upload" \
      "One or more file uploads failed. Check sprite connectivity: sprite exec -s ${SPRITE} -- echo ok"
    return 1
  fi

  log "All files uploaded"
  return 0
}

step_push_env() {
  local env_count=0
  env_count=$(find . \( -name '.env' -o -name '.env.local' -o -name '.env.*' \) -print \
    | grep -v node_modules | grep -v .git | wc -l | tr -d ' ')

  if [[ "$env_count" -eq 0 ]]; then
    warn "No .env files found to push"
    return 0
  fi

  log "Pushing ${env_count} .env file(s) to sprite staging..."
  if ! push_env_files "$SPRITE"; then
    fail_step "push .env files" \
      "Failed to push .env files. Check sprite connectivity: sprite exec -s ${SPRITE} -- echo ok"
    return 1
  fi

  return 0
}

step_run_bootstrap() {
  log "Running bootstrap on sprite (this takes ~5 minutes)..."

  if ! sprite exec -s "$SPRITE" -- bash -c "
    cd /tmp/pipeline &&
    chmod +x bootstrap.sh &&
    set -a && source /tmp/env-staging/.env && set +a &&
    bash bootstrap.sh
  "; then
    fail_step "sprite exec -- bash bootstrap.sh" \
      "Bootstrap failed inside the sprite. Common causes: 1) GITHUB_TOKEN doesn't have repo scope — regenerate PAT  2) npm install failed — sprite may lack internet access  3) Claude auth expired mid-bootstrap. Check the output above for the specific error, fix it, then re-run from this step."
    return 1
  fi

  log "Bootstrap completed"
  return 0
}

step_apply_network_policy() {
  apply_network_policy "$SPRITE" "$CONFIG_FILE"
}

step_checkpoint() {
  log "Creating golden-base checkpoint..."
  if ! sprite checkpoint create -s "$SPRITE" --comment "golden-base"; then
    fail_step "sprite checkpoint create -s ${SPRITE} --comment golden-base" \
      "Checkpoint creation failed. If a golden-base checkpoint already exists, delete it first: sprite checkpoint delete golden-base -s ${SPRITE}"
    return 1
  fi
  log "Checkpoint 'golden-base' created"
  return 0
}

step_verify() {
  local failures=0 warnings=0

  # 1. Claude auth
  local claude_check
  claude_check=$(sprite exec -s "$SPRITE" -- claude -p "reply with only OK" --output-format text 2>&1 || true)
  if echo "$claude_check" | grep -qi "OK"; then
    log "  Claude auth: PASS"
  else
    err "  Claude auth: FAIL"
    failures=$((failures + 1))
  fi

  # 2. Repo cloned
  if sprite exec -s "$SPRITE" -- test -d /home/sprite/repo/.git &>/dev/null; then
    log "  Repo cloned: PASS"
  else
    err "  Repo cloned: FAIL"
    failures=$((failures + 1))
  fi

  # 3. Plugin installed (non-critical)
  local skills_check
  skills_check=$(sprite exec -s "$SPRITE" -- claude -p "list your available skills" --output-format text 2>/dev/null || true)
  if echo "$skills_check" | grep -qi "sodaprompts"; then
    log "  Plugin installed: PASS"
  else
    warn "  Plugin installed: WARN (not detected, non-critical)"
    warnings=$((warnings + 1))
  fi

  # 4. Hooks installed (non-critical)
  if sprite exec -s "$SPRITE" -- test -f ~/.claude/hooks/block-push-to-main.sh &>/dev/null; then
    log "  Hooks installed: PASS"
  else
    warn "  Hooks installed: WARN (not detected, non-critical)"
    warnings=$((warnings + 1))
  fi

  # 5. gh auth
  if sprite exec -s "$SPRITE" -- gh auth status &>/dev/null; then
    log "  gh authenticated: PASS"
  else
    err "  gh authenticated: FAIL"
    failures=$((failures + 1))
  fi

  if [[ "$failures" -gt 0 ]]; then
    fail_step "verification checks" \
      "${failures} critical verification check(s) failed. Re-run bootstrap (--from-step 7) or check individual failures above."
    return 1
  fi

  if [[ "$warnings" -gt 0 ]]; then
    warn "${warnings} non-critical warning(s) — sprite will work but some features may be missing"
  fi

  log "Verification passed"
  return 0
}

step_install_wake_workflow() {
  local workflow_src="${PLUGIN_DIR}/references/wake-sprite.yml"
  if [[ ! -f "$workflow_src" ]]; then
    workflow_src="$(find . -name 'wake-sprite.yml' -path '*/.github/*' 2>/dev/null | head -1)"
  fi

  if [[ -z "$workflow_src" || ! -f "$workflow_src" ]]; then
    fail_step "locate wake-sprite.yml" \
      "wake-sprite.yml not found in plugin. Reinstall: claude plugin install knoxgraeme/sodaprompts"
    return 1
  fi

  mkdir -p .github/workflows
  cp "$workflow_src" .github/workflows/wake-sprite.yml
  log "Installed .github/workflows/wake-sprite.yml"

  echo ""
  echo "  Set these in GitHub → Settings → Secrets and variables → Actions:"
  echo ""
  echo "  Secrets:"
  echo "    SPRITES_TOKEN  — your Sprites API token"
  echo ""
  echo "  Variables:"
  echo "    BUILDER_SPRITE — ${SPRITE}"
  echo ""

  return 0
}

step_summary() {
  local policy_status="unrestricted"
  local rules_json
  rules_json=$(build_network_policy_json "$CONFIG_FILE" 2>/dev/null || true)
  if [[ -n "$rules_json" ]]; then
    local domain_count
    domain_count=$(echo "$rules_json" | python3 -c "import json,sys; print(len([r for r in json.load(sys.stdin)['rules'] if r.get('action')=='allow']))" 2>/dev/null || echo "?")
    policy_status="${domain_count} allowed domains"
  fi

  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}  Soda Prompts setup complete!${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo "  Sprite:      ${SPRITE}"
  echo "  Config:      ${CONFIG_FILE}"
  echo "  Checkpoint:  golden-base"
  echo "  Wake:        .github/workflows/wake-sprite.yml"
  echo "  Egress:      ${policy_status}"
  echo ""
  echo "  How it works:"
  echo "    1. Ship a prompt:  /sodaprompts-ship path/to/feature.md"
  echo "    2. GitHub Action wakes the sprite automatically"
  echo "    3. Sprite works, opens a PR, goes back to sleep"
  echo "    4. Telegram notification when PR is ready"
  echo ""
  echo "  Refresh Claude auth (every few weeks):"
  echo "    sprite console -s ${SPRITE} → claude login"
  echo "    sprite checkpoint create -s ${SPRITE} --comment golden-base"
  echo ""
  echo "  Commit: .sodaprompts.yml and .github/workflows/wake-sprite.yml"
  echo ""

  emit_complete "{\"status\":\"success\",\"sprite\":\"${SPRITE}\",\"checkpoint\":\"golden-base\"}"
  return 0
}

# ═════════════════════════════════════════════════════════════════════════
# Main — run all steps
# ═════════════════════════════════════════════════════════════════════════

echo ""
echo "Soda Prompts — Ship Doer"
echo "━━━━━━━━━━━━━━━━━━━━━━━━"
[[ "$FROM_STEP" -gt 1 ]] && echo "Resuming from step ${FROM_STEP}"

run_step  1  "read-config"             "Parse .sodaprompts.yml"              step_read_config       --required
run_step  2  "locate-plugin"           "Locate plugin files"                 step_locate_plugin     --required
run_step  3  "create-sprite"           "Create or connect sprite"            step_create_sprite
run_step  4  "check-auth"              "Verify Claude auth on sprite"        step_check_auth
run_step  5  "upload-files"            "Upload scripts and skills to sprite" step_upload_files
run_step  6  "push-env"               "Push .env files to sprite"           step_push_env
run_step  7  "run-bootstrap"           "Run bootstrap on sprite (~5 min)"    step_run_bootstrap
run_step  8  "apply-network-policy"    "Apply network egress policy"         step_apply_network_policy
run_step  9  "checkpoint"              "Create golden-base checkpoint"       step_checkpoint
run_step 10  "verify"                  "Verify sprite setup"                 step_verify
run_step 11  "install-wake-workflow"   "Install GitHub Actions workflow"     step_install_wake_workflow
run_step 12  "summary"                 "Print summary"                       step_summary
