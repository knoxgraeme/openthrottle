# Test-only image that simulates a provisioned Fly Sprite.
#
# Production no longer builds an image: the supervisor uploads the payload to a
# Sprite and runs sandbox/provision.sh on the live overlay. This Dockerfile
# reproduces that end state locally/CI so sandbox/tests/smoke.sh can exercise
# the real provision.sh + entrypoint.sh against stubbed agent CLIs.
#
# The base is node:22-bookworm because the Sprites base image ships Node 22
# preinstalled (provision.sh's corepack/npm steps assume it); everything else
# provision.sh installs itself. Build context is the repo root (skills/ is a
# sibling of sandbox/):
#   docker build -f sandbox/tests/Dockerfile -t openthrottle:test .
FROM node:22-bookworm

# Lay down the payload at the same paths the supervisor's tarball extracts to,
# then run provision.sh exactly as the supervisor would (`sudo bash …`, here as
# the build's root user).
COPY sandbox/entrypoint.sh       /opt/openthrottle/entrypoint.sh
COPY sandbox/runner              /opt/openthrottle/runner
COPY sandbox/lib                 /opt/openthrottle/lib
COPY sandbox/safety              /opt/openthrottle/safety
COPY sandbox/provision.sh        /opt/openthrottle/provision.sh
COPY sandbox/bin/ot-activity.mjs /usr/local/bin/ot-activity
COPY skills                      /opt/openthrottle/skills

RUN bash /opt/openthrottle/provision.sh

WORKDIR /home/agent
