#!/usr/bin/env bash
set -euo pipefail

# OPE-104 regression pin: a credential-free, network-free, exact oracle for
# whether Claude actually registered its baked-in user skills as slash
# commands. Runs the real pinned `claude` binary (never a stub) against a
# real materialized action HOME -- the same skill baseline and skills/
# layout execute-loop.mjs materializes for a live action -- with no engine
# credential present. Claude resolves a slash command against its locally
# discovered skill set before ever reaching the network, so a
# `Not logged in`/non-zero exit for the registered skill IS the pass (proof
# the command resolved locally); an `Unknown command:` prefix is the exact
# failure OPE-101/OPE-104 produced and this probe exists to catch.
#
# OPE-107: every adopted task skill must register, not just one representative
# name -- the eleven self-contained skills replaced the CE-delegating
# adapters, and a rename/typo in any single directory would exit 0 under a
# probe that only ever checked `/implement-unit`.

IMAGE="${1:-openthrottle:test}"

# Keep in sync with skills/tasks/*.
SKILL_NAMES=(
  implement-plan
  investigate
  review-change
  simplify-change
  publish
  implement-unit
  simplify-unit
  repair-unit
  accept-unit
  final-review
  final-repair
)

docker run --rm --entrypoint bash "$IMAGE" -lc '
  set -euo pipefail

  home_dir=/tmp/ope-104-skill-registration-probe-home
  rm -rf "$home_dir"

  # Mirrors materializeClaudeProfileBaseline + lockExecutorOwnedSkillTree
  # (sandbox/runner/action-home-baseline.mjs, loop-agent-environment.mjs):
  # an agent-owned, writable profile root with a root-owned, read-only
  # skills/ tree materialized underneath it.
  install -d -o agent -g agent -m 0711 "$home_dir"
  install -d -o root -g root -m 0755 "$home_dir/.claude"
  cp -r /opt/openthrottle/action-home-baseline/claude/skills "$home_dir/.claude/skills"
  chown -R root:root "$home_dir/.claude/skills"
  find "$home_dir/.claude/skills" -type d -exec chmod 0755 {} +
  find "$home_dir/.claude/skills" -type f -exec chmod 0444 {} +
  chown agent:agent "$home_dir/.claude"
  chmod 0711 "$home_dir/.claude"

  run_probe() {
    local prompt="$1"
    timeout 30 gosu agent env HOME="$home_dir" claude \
      --print --output-format stream-json --verbose \
      --dangerously-skip-permissions --strict-mcp-config \
      --plugin-dir /opt/openthrottle/compound-engineering-marketplace \
      --setting-sources user <<<"$prompt" 2>&1
  }

  check_registered() {
    local name="$1"
    test -f "$home_dir/.claude/skills/$name/SKILL.md"

    local registered_output registered_status
    registered_output="$(run_probe "/$name")" && registered_status=0 || registered_status=$?
    echo "--- /$name output ---"
    echo "$registered_output"
    if grep -q "Unknown command:" <<<"$registered_output"; then
      echo "registered skill /$name was NOT recognized by claude" >&2
      exit 1
    fi
    # A grep miss alone is not enough: a hang killed by the timeout (exit
    # 124) or a crash can also produce no "Unknown command:" text while
    # proving nothing about registration. Empty output is the exact,
    # credential-free signature of that -- a genuine credential refusal (the
    # documented pass) always prints something. Fail loudly instead of
    # falling through to a silent pass for either case.
    if [ "$registered_status" -eq 124 ] || [ -z "$registered_output" ]; then
      echo "claude produced no usable output for the registered skill probe /$name (exit $registered_status) -- cannot confirm registration" >&2
      exit 1
    fi
  }

  for name in "$@"; do
    check_registered "$name"
  done

  bogus_output="$(run_probe "/ot-nonexistent-probe")" || true
  echo "--- /ot-nonexistent-probe output ---"
  echo "$bogus_output"
  if ! grep -q "Unknown command:" <<<"$bogus_output"; then
    echo "bogus command /ot-nonexistent-probe was unexpectedly accepted -- oracle is not discriminating" >&2
    exit 1
  fi

  echo "slash-command registration oracle passed for all eleven adopted skills"
' bash "${SKILL_NAMES[@]}"
