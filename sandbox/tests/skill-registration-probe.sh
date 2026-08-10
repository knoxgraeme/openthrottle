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
# name -- the self-contained skills replaced the CE-delegating
# adapters, and a rename/typo in any single directory would exit 0 under a
# probe that only ever checked `/implement-unit`.
#
# OPE-107 (references tier): registration alone is not enough. A SKILL.md
# points at its sibling craft file with a bare relative path
# (`read `references/branch-review-passes.md``) while the agent's cwd is the
# target repository, so the pointer resolves against the skill package
# directory. Arrival of those files is provable by inspection; the *read* as
# the agent uid is not, and it is the half that fails silently -- an
# unreadable reference exits 0 and grades as a clean run, quietly dropping
# the craft the reference carries. Probe it here, on the same real
# materialized action HOME, with the same privilege drop.

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
  select-review-personas
  correctness-dataflow
  tests-contracts
  reliability-adversarial
  agent-native-contracts
  security
  data-migration
  performance
  project-standards
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

  # Read one references/*.md per skill that ships them, as the agent uid,
  # resolved relatively from the skill package directory exactly the way the
  # SKILL.md pointer reads it. Exercises traversal into the root-owned
  # read-only skill tree plus the file mode, which is the whole runtime
  # question. Skills with no references/ directory are skipped, not failed.
  check_references_readable() {
    local name="$1"
    local skill_dir="$home_dir/.claude/skills/$name"
    if [ ! -d "$skill_dir/references" ]; then
      echo "--- $name has no references/ (skipped) ---"
      return 0
    fi

    local first=""
    local candidate
    for candidate in "$skill_dir"/references/*.md; do
      if [ -f "$candidate" ]; then
        first="$(basename "$candidate")"
        break
      fi
    done
    if [ -z "$first" ]; then
      echo "skill $name has a references/ directory containing no *.md file" >&2
      exit 1
    fi

    if ! gosu agent env -C "$skill_dir" cat "references/$first" > /dev/null; then
      echo "agent uid cannot read $name/references/$first -- its SKILL.md pointer does not resolve at runtime" >&2
      exit 1
    fi
    echo "--- $name/references/$first is readable as agent ---"
  }

  for name in "$@"; do
    check_registered "$name"
    check_references_readable "$name"
  done

  bogus_output="$(run_probe "/ot-nonexistent-probe")" || true
  echo "--- /ot-nonexistent-probe output ---"
  echo "$bogus_output"
  if ! grep -q "Unknown command:" <<<"$bogus_output"; then
    echo "bogus command /ot-nonexistent-probe was unexpectedly accepted -- oracle is not discriminating" >&2
    exit 1
  fi

  echo "slash-command registration oracle passed for all adopted skills, and every references/ pointer read back as agent"
' bash "${SKILL_NAMES[@]}"
