#!/usr/bin/env bash
# =============================================================================
# ship-common.sh — shared harness for ship-doer.sh and ship-reviewer.sh
#
# Source this, don't execute it directly.
# Provides: step runner, structured error/success output, config parsing,
# plugin discovery, network policy helpers.
# =============================================================================

set -uo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

# Globals set by parse_args
FROM_STEP=1
CONFIG_FILE=".sodaprompts.yml"
VERBOSE=false

# Tracking
COMPLETED_STEPS=()
CURRENT_STEP_NUM=0
CURRENT_STEP_NAME=""

# ── Argument parsing ─────────────────────────────────────────────────────

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --from-step) FROM_STEP="$2"; shift 2 ;;
      --config)    CONFIG_FILE="$2"; shift 2 ;;
      --verbose)   VERBOSE=true; shift ;;
      *) echo "Unknown argument: $1"; exit 1 ;;
    esac
  done
}

# ── Logging ──────────────────────────────────────────────────────────────

log()  { echo -e "${GREEN}[ship]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
err()  { echo -e "${RED}[error]${NC} $1"; }
debug() { [[ "$VERBOSE" == true ]] && echo -e "${CYAN}[debug]${NC} $1" || true; }

# ── JSON escaping ────────────────────────────────────────────────────────

# Properly escape a string for embedding in JSON using python3.
# Falls back to basic sed if python3 unavailable.
json_escape() {
  local input="$1"
  if command -v python3 &>/dev/null; then
    printf '%s' "$input" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()), end='')"
  else
    # Fallback: escape backslashes, quotes, tabs, newlines
    printf '%s' "$input" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | tr '\n' ' '
  fi
}

# ── Structured output ────────────────────────────────────────────────────

emit_step_ok() {
  local step_num="$1" step_name="$2" message="$3"
  COMPLETED_STEPS+=("$step_name")
  echo "===SHIP_STEP_OK==="
  cat <<EOF
{"step_number": ${step_num}, "step_name": "${step_name}", "message": "${message}"}
EOF
  echo "===SHIP_STEP_OK==="
}

emit_error() {
  local step_num="$1"
  local step_name="$2"
  local failed_cmd="$3"
  local exit_code="$4"
  local error_output="$5"
  local suggested_fix="$6"
  local script_name="$7"

  # Build completed steps JSON array (guard empty array for set -u)
  local completed_json="["
  if [[ ${#COMPLETED_STEPS[@]} -gt 0 ]]; then
    local first=true
    for s in "${COMPLETED_STEPS[@]}"; do
      [[ "$first" == true ]] && first=false || completed_json+=","
      completed_json+="\"${s}\""
    done
  fi
  completed_json+="]"

  # Truncate and escape for JSON
  local escaped_output escaped_cmd escaped_fix
  escaped_output=$(json_escape "$(echo "$error_output" | tail -30)")
  escaped_cmd=$(json_escape "$failed_cmd")
  escaped_fix=$(json_escape "$suggested_fix")

  echo ""
  echo "===SHIP_ERROR_BEGIN==="
  cat <<EOF
{
  "status": "failed",
  "step_number": ${step_num},
  "step_name": "${step_name}",
  "failed_command": ${escaped_cmd},
  "exit_code": ${exit_code},
  "error_output": ${escaped_output},
  "suggested_fix": ${escaped_fix},
  "resume_command": "bash ${script_name} --from-step ${step_num}",
  "completed_steps": ${completed_json}
}
EOF
  echo "===SHIP_ERROR_END==="
}

emit_complete() {
  local payload="$1"
  echo ""
  echo "===SHIP_COMPLETE==="
  echo "$payload"
  echo "===SHIP_COMPLETE==="
}

# ── Step runner ──────────────────────────────────────────────────────────

# run_step <number> <name> <description> <function> [--required]
#
# If step_number < FROM_STEP and not --required, skip it.
# Calls function, captures output. On failure, emits structured error and exits.
run_step() {
  local step_num="$1"
  local step_name="$2"
  local description="$3"
  local func="$4"
  local required=false
  [[ "${5:-}" == "--required" ]] && required=true

  CURRENT_STEP_NUM="$step_num"
  CURRENT_STEP_NAME="$step_name"

  # Reset per-step error context
  STEP_FAILED_CMD=""
  STEP_SUGGESTED_FIX=""

  if [[ "$required" == false ]] && [[ "$step_num" -lt "$FROM_STEP" ]]; then
    debug "Skipping step ${step_num} (${step_name}) — already completed"
    COMPLETED_STEPS+=("$step_name")
    return 0
  fi

  echo ""
  log "Step ${step_num}: ${description}"

  # Run the function, stream output to terminal and capture it.
  # Capture PIPESTATUS immediately after the pipeline — before any conditional.
  local output_file
  output_file=$(mktemp)

  $func 2>&1 | tee "$output_file"
  local func_exit="${PIPESTATUS[0]}"

  if [[ "$func_exit" -eq 0 ]]; then
    emit_step_ok "$step_num" "$step_name" "$description"
    rm -f "$output_file"
    return 0
  else
    local output
    output=$(cat "$output_file")
    rm -f "$output_file"

    err "Step ${step_num} (${step_name}) failed with exit code ${func_exit}"

    emit_error \
      "$step_num" \
      "$step_name" \
      "${STEP_FAILED_CMD:-$func}" \
      "$func_exit" \
      "$output" \
      "${STEP_SUGGESTED_FIX:-Check the output above for details}" \
      "${SHIP_SCRIPT_NAME:-ship-doer.sh}"

    exit "$func_exit"
  fi
}

# Step functions call fail_step to set error context, then MUST return 1.
# Usage: fail_step "command" "fix suggestion"; return 1
STEP_FAILED_CMD=""
STEP_SUGGESTED_FIX=""

fail_step() {
  STEP_FAILED_CMD="$1"
  STEP_SUGGESTED_FIX="$2"
  # NOTE: Callers MUST follow with 'return 1'. fail_step itself only sets
  # metadata — it cannot return from the calling function.
}

# ── Config parsing ───────────────────────────────────────────────────────

# Read a top-level field from a YAML file. Returns the value, or the default
# if the field is absent. Errors (bad YAML, missing file) return non-zero.
read_yaml_field() {
  local file="$1" field="$2" default="${3:-}"
  local val exit_code
  val=$(FILE="$file" FIELD="$field" DEFAULT="$default" python3 -c "
import os, yaml
with open(os.environ['FILE']) as f:
    config = yaml.safe_load(f) or {}
val = config.get(os.environ['FIELD'])
if val is None:
    print(os.environ['DEFAULT'])
else:
    print(val)
" 2>&1)
  exit_code=$?
  if [[ "$exit_code" -ne 0 ]]; then
    err "Failed to read '${field}' from ${file}: ${val}"
    return 1
  fi
  echo "$val"
}

# Read a nested field (e.g., "reviewer.sprite") from a YAML file.
read_yaml_nested() {
  local file="$1" path="$2" default="${3:-}"
  local val exit_code
  val=$(FILE="$file" PATH_KEY="$path" DEFAULT="$default" python3 -c "
import os, yaml
with open(os.environ['FILE']) as f:
    config = yaml.safe_load(f) or {}
keys = os.environ['PATH_KEY'].split('.')
for k in keys:
    config = config.get(k, {}) if isinstance(config, dict) else {}
result = config if config else os.environ['DEFAULT']
print(result)
" 2>&1)
  exit_code=$?
  if [[ "$exit_code" -ne 0 ]]; then
    err "Failed to read '${path}' from ${file}: ${val}"
    return 1
  fi
  echo "$val"
}

check_yaml_parser() {
  if ! python3 -c "import yaml" 2>/dev/null; then
    err "python3 pyyaml module not found"
    echo "  Fix: pip3 install pyyaml"
    return 1
  fi
  return 0
}

# ── Plugin discovery ─────────────────────────────────────────────────────

locate_plugin_dir() {
  PLUGIN_DIR="$(find ~/.claude -path '*/sodaprompts/skills/sodaprompts-setup' -type d 2>/dev/null | head -1)"
  if [[ -z "$PLUGIN_DIR" ]]; then
    PLUGIN_DIR="$(find ~/.claude -path '*/sodaprompts-setup' -type d 2>/dev/null | head -1)"
  fi
  if [[ -z "$PLUGIN_DIR" ]]; then
    return 1
  fi
  debug "Plugin dir: $PLUGIN_DIR"
  echo "$PLUGIN_DIR"
}

locate_skill_dir() {
  local skill_name="$1"
  local dir
  dir="$(find ~/.claude -path "*/${skill_name}" -type d 2>/dev/null | head -1)"
  if [[ -z "$dir" ]]; then
    return 1
  fi
  debug "Skill dir (${skill_name}): $dir"
  echo "$dir"
}

# ── Network policy ───────────────────────────────────────────────────────

# Build the network policy JSON from .sodaprompts.yml.
# Returns empty string if no policy configured. Returns non-zero on parse error.
build_network_policy_json() {
  local config_file="$1"
  local val exit_code
  val=$(CONFIG="$config_file" python3 -c "
import os, yaml, json
with open(os.environ['CONFIG']) as f:
    config = yaml.safe_load(f) or {}
np = config.get('network_policy', {})
if not np or not np.get('allow'):
    print('')
else:
    rules = []
    preset = np.get('preset', '')
    if preset:
        rules.append({'include': preset})
    for domain in np.get('allow', []):
        rules.append({'action': 'allow', 'domain': domain})
    rules.append({'action': 'deny', 'domain': '*'})
    print(json.dumps({'rules': rules}))
" 2>&1)
  exit_code=$?
  if [[ "$exit_code" -ne 0 ]]; then
    err "Failed to parse network policy from ${config_file}: ${val}"
    return 1
  fi
  echo "$val"
}

apply_network_policy() {
  local sprite_name="$1" config_file="$2"
  local rules_json
  rules_json=$(build_network_policy_json "$config_file") || {
    STEP_FAILED_CMD="build_network_policy_json"
    STEP_SUGGESTED_FIX="Check network_policy section in ${config_file} for YAML syntax errors."
    return 1
  }

  if [[ -z "$rules_json" ]]; then
    log "No network_policy configured — egress is unrestricted"
    return 0
  fi

  log "Applying network policy to sprite ${sprite_name}..."
  debug "Policy: $(echo "$rules_json" | python3 -m json.tool 2>/dev/null || echo "$rules_json")"

  if echo "$rules_json" | sprite api -s "$sprite_name" \
    "/v1/sprites/${sprite_name}/policy/network" \
    -X POST \
    -H "Content-Type: application/json" \
    -d @-; then
    log "Network policy applied"
    return 0
  else
    STEP_FAILED_CMD="sprite api -s ${sprite_name} /v1/sprites/${sprite_name}/policy/network"
    STEP_SUGGESTED_FIX="Check 'sprite login' is authenticated. Run 'sprite list' to verify connectivity."
    return 1
  fi
}

# ── Upload helper ────────────────────────────────────────────────────────

# Upload a local file to a path on the sprite. Returns non-zero on failure.
sprite_upload() {
  local sprite="$1" local_path="$2" remote_path="$3"
  if [[ ! -f "$local_path" ]]; then
    err "Local file not found: $local_path"
    return 1
  fi
  if ! sprite exec -s "$sprite" -- bash -c "cat > '${remote_path}'" < "$local_path"; then
    err "Failed to upload ${local_path} → ${remote_path}"
    return 1
  fi
}

# ── .env file discovery and push ─────────────────────────────────────────

# Push all .env files to /tmp/env-staging/ on the sprite.
# Uses process substitution to avoid subshell pipe (which loses errors).
push_env_files() {
  local sprite="$1"
  local count=0

  while IFS= read -r envfile; do
    local relpath="${envfile#./}"
    log "  Pushing ${relpath}"
    if ! sprite exec -s "$sprite" -- bash -c "mkdir -p '/tmp/env-staging/$(dirname "$relpath")'"; then
      err "Failed to create directory for ${relpath} on sprite"
      return 1
    fi
    if ! sprite exec -s "$sprite" -- bash -c "cat > '/tmp/env-staging/${relpath}'" < "$envfile"; then
      err "Failed to upload ${relpath} to sprite"
      return 1
    fi
    count=$((count + 1))
  done < <(find . \( -name '.env' -o -name '.env.local' -o -name '.env.*' \) -print \
    | grep -v node_modules | grep -v .git | sort)

  log "Pushed ${count} .env file(s) to sprite staging"
}
