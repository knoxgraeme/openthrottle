#!/usr/bin/env bash
# =============================================================================
# install-skill.sh — install a skill SKILL.md into the correct runtime directory
#
# Usage: AGENT_RUNTIME=claude bash install-skill.sh <skill-name>
#
# Finds the SKILL.md in the same directory as this script's parent skill dir
# and copies it to the runtime's skill directory.
# =============================================================================

set -euo pipefail

SKILL_NAME="${1:?Usage: install-skill.sh <skill-name>}"
AGENT_RUNTIME="${AGENT_RUNTIME:-claude}"

# Find the SKILL.md for the requested skill
# During bootstrap, skills are uploaded to /tmp/pipeline-<skill-suffix>/
SKILL_SOURCE="/tmp/pipeline-${SKILL_NAME#sodaprompts-}/SKILL.md"

if [[ ! -f "$SKILL_SOURCE" ]]; then
  # Fallback: look relative to this script
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  SKILL_SOURCE="${SCRIPT_DIR}/../../${SKILL_NAME}/SKILL.md"
fi

if [[ ! -f "$SKILL_SOURCE" ]]; then
  echo "Error: SKILL.md not found for ${SKILL_NAME}"
  echo "Looked in: /tmp/pipeline-${SKILL_NAME#sodaprompts-}/SKILL.md"
  exit 1
fi

case "$AGENT_RUNTIME" in
  claude) TARGET_DIR=".claude/skills/${SKILL_NAME}" ;;
  codex)  TARGET_DIR=".agents/skills/${SKILL_NAME}" ;;
  *)      echo "Unknown AGENT_RUNTIME: ${AGENT_RUNTIME}"; exit 1 ;;
esac

mkdir -p "$TARGET_DIR"
cp "$SKILL_SOURCE" "${TARGET_DIR}/SKILL.md"
echo "Installed ${SKILL_NAME} to ${TARGET_DIR}/ for ${AGENT_RUNTIME}"
