#!/usr/bin/env bash
# =============================================================================
# ship-reviewer.sh — bootstrap a Reviewer (Thinker) sprite deterministically
#
# Runs on the user's machine. Creates/connects a reviewer sprite, uploads
# files, runs bootstrap, applies network policy, checkpoints, and verifies.
#
# Usage:
#   bash ship-reviewer.sh [--from-step N] [--config .sodaprompts.yml] [--verbose]
#
# Requires: reviewer section in .sodaprompts.yml (added during /sodaprompts-setup)
# =============================================================================

SHIP_SCRIPT_NAME="ship-reviewer.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/ship-common.sh"

parse_args "$@"

# ── Globals populated by steps ────────────────────────────────────────────
REVIEWER_SPRITE=""
AGENT_RUNTIME=""
PLUGIN_DIR=""
REVIEWER_DIR=""
INVESTIGATOR_DIR=""

# ═════════════════════════════════════════════════════════════════════════
# Step functions
#
# Convention: call fail_step to set context, then ALWAYS return 1 after it.
# ═════════════════════════════════════════════════════════════════════════

step_read_config() {
  if [[ ! -f "$CONFIG_FILE" ]]; then
    fail_step "test -f $CONFIG_FILE" \
      ".sodaprompts.yml not found. Run /sodaprompts-setup first."
    return 1
  fi

  if ! check_yaml_parser; then
    fail_step "python3 -c 'import yaml'" "Install pyyaml: pip3 install pyyaml"
    return 1
  fi

  # Check reviewer section exists (use env vars for safe python interpolation)
  local has_reviewer
  has_reviewer=$(CONFIG="$CONFIG_FILE" python3 -c "
import os, yaml
with open(os.environ['CONFIG']) as f:
    config = yaml.safe_load(f) or {}
print('yes' if config.get('reviewer') else 'no')
" 2>&1) || {
    fail_step "parse ${CONFIG_FILE}" \
      "Failed to parse .sodaprompts.yml. Check for YAML syntax errors."
    return 1
  }

  if [[ "$has_reviewer" != "yes" ]]; then
    fail_step "check reviewer config" \
      "No 'reviewer' section in .sodaprompts.yml. Add it first (sprite name, agent_runtime, max_rounds, poll_interval)."
    return 1
  fi

  REVIEWER_SPRITE=$(read_yaml_nested "$CONFIG_FILE" "reviewer.sprite" "soda-reviewer") || {
    fail_step "read reviewer.sprite from ${CONFIG_FILE}" "Check .sodaprompts.yml for YAML syntax errors."
    return 1
  }
  AGENT_RUNTIME=$(read_yaml_nested "$CONFIG_FILE" "reviewer.agent_runtime" "claude") || {
    fail_step "read reviewer.agent_runtime from ${CONFIG_FILE}" "Check .sodaprompts.yml for YAML syntax errors."
    return 1
  }

  [[ -z "$REVIEWER_SPRITE" || "$REVIEWER_SPRITE" == "None" ]] && REVIEWER_SPRITE="soda-reviewer"
  [[ -z "$AGENT_RUNTIME" || "$AGENT_RUNTIME" == "None" ]] && AGENT_RUNTIME="claude"

  log "Config loaded: reviewer_sprite=${REVIEWER_SPRITE}, runtime=${AGENT_RUNTIME}"
  return 0
}

step_locate_plugin() {
  # Resolve from known relative path — scripts live in sodaprompts-setup/scripts/
  PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
  REVIEWER_DIR="$(cd "${SCRIPT_DIR}/../../sodaprompts-reviewer" 2>/dev/null && pwd)" || true
  INVESTIGATOR_DIR="$(cd "${SCRIPT_DIR}/../../sodaprompts-investigator" 2>/dev/null && pwd)" || true

  if [[ ! -d "${PLUGIN_DIR}/scripts" ]]; then
    fail_step "test -d ${SCRIPT_DIR}/../scripts" \
      "sodaprompts plugin not found. Install: claude plugin install knoxgraeme/sodaprompts"
    return 1
  fi

  if [[ -z "$REVIEWER_DIR" || ! -d "$REVIEWER_DIR" ]]; then
    fail_step "test -d sodaprompts-reviewer" \
      "sodaprompts-reviewer skill not found. Reinstall: claude plugin install knoxgraeme/sodaprompts"
    return 1
  fi

  if [[ -z "$INVESTIGATOR_DIR" || ! -d "$INVESTIGATOR_DIR" ]]; then
    fail_step "test -d sodaprompts-investigator" \
      "sodaprompts-investigator skill not found. Reinstall: claude plugin install knoxgraeme/sodaprompts"
    return 1
  fi

  # Verify critical files
  local missing=()
  [[ -f "${PLUGIN_DIR}/scripts/bootstrap-common.sh" ]]    || missing+=("scripts/bootstrap-common.sh")
  [[ -f "${PLUGIN_DIR}/scripts/install-skill.sh" ]]       || missing+=("scripts/install-skill.sh")
  [[ -f "${REVIEWER_DIR}/SKILL.md" ]]                     || missing+=("reviewer/SKILL.md")
  [[ -f "${REVIEWER_DIR}/scripts/run-reviewer.sh" ]]      || missing+=("reviewer/scripts/run-reviewer.sh")
  [[ -f "${REVIEWER_DIR}/scripts/bootstrap-reviewer.sh" ]] || missing+=("reviewer/scripts/bootstrap-reviewer.sh")
  [[ -f "${INVESTIGATOR_DIR}/SKILL.md" ]]                 || missing+=("investigator/SKILL.md")

  if [[ ${#missing[@]} -gt 0 ]]; then
    fail_step "file existence check" \
      "Missing files in plugin: ${missing[*]}. Reinstall: claude plugin install knoxgraeme/sodaprompts"
    return 1
  fi

  log "Plugin dir: ${PLUGIN_DIR}"
  log "Reviewer dir: ${REVIEWER_DIR}"
  log "Investigator dir: ${INVESTIGATOR_DIR}"
  return 0
}

step_create_sprite() {
  if sprite exec -s "$REVIEWER_SPRITE" -- echo "ok" &>/dev/null; then
    log "Reviewer sprite '${REVIEWER_SPRITE}' exists and is reachable"
    return 0
  fi

  log "Creating reviewer sprite '${REVIEWER_SPRITE}'..."
  if ! sprite create "$REVIEWER_SPRITE"; then
    fail_step "sprite create ${REVIEWER_SPRITE}" \
      "Failed to create reviewer sprite. Run 'sprite list' to check existing sprites."
    return 1
  fi
  log "Reviewer sprite '${REVIEWER_SPRITE}' created"
  return 0
}

step_check_auth() {
  local agent_cmd="claude"
  [[ "$AGENT_RUNTIME" == "codex" ]] && agent_cmd="codex"

  # First, verify sprite is reachable
  if ! sprite exec -s "$REVIEWER_SPRITE" -- echo "connectivity-ok" &>/dev/null; then
    fail_step "sprite exec -s ${REVIEWER_SPRITE} -- echo ok" \
      "Cannot reach reviewer sprite '${REVIEWER_SPRITE}'. Check: sprite list"
    return 1
  fi

  local auth_check
  auth_check=$(sprite exec -s "$REVIEWER_SPRITE" -- $agent_cmd -p "reply with only OK" --output-format text 2>&1 || true)

  if echo "$auth_check" | grep -qi "login\|auth\|sign in\|not logged\|unauthorized"; then
    fail_step "sprite exec -s ${REVIEWER_SPRITE} -- ${agent_cmd} -p 'reply with only OK'" \
      "${agent_cmd} is not authenticated on the reviewer sprite. Manual steps: 1) sprite console -s ${REVIEWER_SPRITE}  2) ${agent_cmd}  3) Open URL in browser  4) Ctrl+C  5) Re-run: bash ship-reviewer.sh --from-step 4"
    return 1
  fi

  log "${agent_cmd} authenticated on reviewer sprite"
  return 0
}

step_upload_files() {
  log "Creating directories on reviewer sprite..."
  if ! sprite exec -s "$REVIEWER_SPRITE" -- bash -c "
    mkdir -p /tmp/pipeline /tmp/pipeline-reviewer /tmp/pipeline-investigator /home/sprite/logs
  "; then
    fail_step "sprite exec -- mkdir" \
      "Failed to create directories. Check sprite is running: sprite list"
    return 1
  fi

  local upload_failed=false

  log "Uploading shared bootstrap scripts..."
  sprite_upload "$REVIEWER_SPRITE" "${PLUGIN_DIR}/scripts/bootstrap-common.sh" "/tmp/pipeline/bootstrap-common.sh" || upload_failed=true
  sprite_upload "$REVIEWER_SPRITE" "${PLUGIN_DIR}/scripts/install-skill.sh"    "/tmp/pipeline/install-skill.sh"    || upload_failed=true

  log "Uploading reviewer skill + runner..."
  sprite_upload "$REVIEWER_SPRITE" "${REVIEWER_DIR}/SKILL.md"                      "/tmp/pipeline-reviewer/SKILL.md"       || upload_failed=true
  sprite_upload "$REVIEWER_SPRITE" "${REVIEWER_DIR}/scripts/run-reviewer.sh"       "/tmp/pipeline-reviewer/run-reviewer.sh" || upload_failed=true
  sprite_upload "$REVIEWER_SPRITE" "${REVIEWER_DIR}/scripts/bootstrap-reviewer.sh" "/tmp/pipeline/bootstrap-reviewer.sh"    || upload_failed=true

  log "Uploading investigator skill..."
  sprite_upload "$REVIEWER_SPRITE" "${INVESTIGATOR_DIR}/SKILL.md" "/tmp/pipeline-investigator/SKILL.md" || upload_failed=true

  if [[ "$upload_failed" == true ]]; then
    fail_step "sprite_upload" \
      "One or more file uploads failed. Check sprite connectivity: sprite exec -s ${REVIEWER_SPRITE} -- echo ok"
    return 1
  fi

  log "All files uploaded to reviewer sprite"
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

  log "Pushing ${env_count} .env file(s) to reviewer sprite staging..."
  if ! push_env_files "$REVIEWER_SPRITE"; then
    fail_step "push .env files" \
      "Failed to push .env files. Check sprite connectivity."
    return 1
  fi

  return 0
}

step_run_bootstrap() {
  log "Running reviewer bootstrap on sprite..."

  if ! sprite exec -s "$REVIEWER_SPRITE" -- bash -c "
    cd /tmp/pipeline &&
    chmod +x bootstrap-reviewer.sh &&
    set -a && source /tmp/env-staging/.env && set +a &&
    AGENT_RUNTIME=${AGENT_RUNTIME} bash bootstrap-reviewer.sh
  "; then
    fail_step "sprite exec -- bash bootstrap-reviewer.sh" \
      "Reviewer bootstrap failed. Check the output above for the specific error. Common causes: 1) GITHUB_TOKEN invalid  2) Agent runtime install failed  3) Repo clone failed."
    return 1
  fi

  log "Reviewer bootstrap completed"
  return 0
}

step_apply_network_policy() {
  apply_network_policy "$REVIEWER_SPRITE" "$CONFIG_FILE"
}

step_checkpoint() {
  log "Creating golden-base checkpoint for reviewer..."
  if ! sprite checkpoint create -s "$REVIEWER_SPRITE" --comment "golden-base"; then
    fail_step "sprite checkpoint create -s ${REVIEWER_SPRITE} --comment golden-base" \
      "Checkpoint failed. If golden-base already exists: sprite checkpoint delete golden-base -s ${REVIEWER_SPRITE}"
    return 1
  fi
  log "Checkpoint 'golden-base' created for reviewer"
  return 0
}

step_verify() {
  local failures=0

  # 1. Agent config exists (auth was verified in step 4 before bootstrap)
  if sprite exec -s "$REVIEWER_SPRITE" -- test -d /home/sprite/.claude &>/dev/null; then
    log "  Agent config: PASS"
  else
    err "  Agent config: FAIL"
    failures=$((failures + 1))
  fi

  # 2. gh auth
  if sprite exec -s "$REVIEWER_SPRITE" -- gh auth status &>/dev/null; then
    log "  gh authenticated: PASS"
  else
    err "  gh authenticated: FAIL"
    failures=$((failures + 1))
  fi

  # 3. Reviewer skill installed
  if sprite exec -s "$REVIEWER_SPRITE" -- test -f .claude/skills/sodaprompts-reviewer/SKILL.md &>/dev/null; then
    log "  Reviewer skill: PASS"
  else
    err "  Reviewer skill: FAIL"
    failures=$((failures + 1))
  fi

  # 4. Investigator skill installed
  if sprite exec -s "$REVIEWER_SPRITE" -- test -f .claude/skills/sodaprompts-investigator/SKILL.md &>/dev/null; then
    log "  Investigator skill: PASS"
  else
    err "  Investigator skill: FAIL"
    failures=$((failures + 1))
  fi

  if [[ "$failures" -gt 0 ]]; then
    fail_step "verification checks" \
      "${failures} verification check(s) failed. Re-run bootstrap (--from-step 7) or check individual failures above."
    return 1
  fi

  log "Reviewer verification passed"
  return 0
}

step_summary() {
  local max_rounds poll_interval
  max_rounds=$(read_yaml_nested "$CONFIG_FILE" "reviewer.max_rounds" "3" 2>/dev/null || echo "3")
  poll_interval=$(read_yaml_nested "$CONFIG_FILE" "reviewer.poll_interval" "60" 2>/dev/null || echo "60")

  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}  Reviewer Sprite setup complete!${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo "  Sprite:      ${REVIEWER_SPRITE}"
  echo "  Runtime:     ${AGENT_RUNTIME}"
  echo "  Polling:     every ${poll_interval}s for 'needs-review' PRs"
  echo "  Max rounds:  ${max_rounds}"
  echo "  Checkpoint:  golden-base"
  echo ""
  echo "  Set in GitHub → Settings → Secrets and variables → Actions:"
  echo "    Variables:"
  echo "      REVIEWER_SPRITE — ${REVIEWER_SPRITE}"
  echo ""

  emit_complete "{\"status\":\"success\",\"sprite\":\"${REVIEWER_SPRITE}\",\"runtime\":\"${AGENT_RUNTIME}\",\"checkpoint\":\"golden-base\"}"
  return 0
}

# ═════════════════════════════════════════════════════════════════════════
# Main
# ═════════════════════════════════════════════════════════════════════════

echo ""
echo "Soda Prompts — Ship Reviewer"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
[[ "$FROM_STEP" -gt 1 ]] && echo "Resuming from step ${FROM_STEP}"

run_step  1  "read-config"                "Parse reviewer config"               step_read_config        --required
run_step  2  "locate-plugin"              "Locate plugin files"                 step_locate_plugin      --required
run_step  3  "create-reviewer-sprite"     "Create or connect reviewer sprite"   step_create_sprite
run_step  4  "check-reviewer-auth"        "Verify agent auth on reviewer"       step_check_auth
run_step  5  "upload-reviewer-files"      "Upload scripts and skills"           step_upload_files
run_step  6  "push-reviewer-env"          "Push .env files to reviewer"         step_push_env
run_step  7  "run-reviewer-bootstrap"     "Run bootstrap on reviewer"           step_run_bootstrap
run_step  8  "apply-reviewer-policy"      "Apply network egress policy"         step_apply_network_policy
run_step  9  "checkpoint-reviewer"        "Create golden-base checkpoint"       step_checkpoint
run_step 10  "verify-reviewer"            "Verify reviewer setup"               step_verify
run_step 11  "summary"                    "Print summary"                       step_summary
