#!/usr/bin/env bash
# push-env.sh — push local .env files to the sprite and re-checkpoint
#
# Use when: secrets rotate, new env vars added, .env files changed.
# Re-checkpoints as golden-base so future sessions pick up the changes.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"
load_config

echo ""
echo "  Pushing .env files to sprite: $SPRITE"
echo ""

# Find and push all .env files
cd "$REPO_ROOT"
PUSHED=0
while IFS= read -r envfile; do
  RELPATH="${envfile#./}"
  echo "  -> $RELPATH"
  sprite exec -s "$SPRITE" -- bash -c "mkdir -p /home/sprite/repo/$(dirname "$RELPATH")"
  cat "$envfile" | sprite exec -s "$SPRITE" -- bash -c "cat > /home/sprite/repo/${RELPATH}"
  PUSHED=$((PUSHED + 1))
done < <(find . \( -name '.env' -o -name '.env.local' -o -name '.env.*' \) -print | grep -v node_modules | grep -v .git)

echo ""
echo "  Pushed ${PUSHED} .env file(s)"
echo ""
echo "  Re-checkpointing as golden-base..."
sprite checkpoint create -s "$SPRITE" --comment "golden-base"

echo ""
echo "  Done. Future sessions will use the updated env."
echo ""
