# Multi-stage build per docs/SPEC.md "Supervisor contract > Fly":
#   node:22-slim, tsc build, CMD node dist/index.js
#
# Build context is the REPO ROOT, not supervisor/: the payload stage below
# bakes sandbox/ and skills/ (siblings of supervisor/) into payload.tar.gz,
# and Docker cannot COPY from outside its build context. Every COPY source in
# this file is therefore repo-root-relative. See
# .github/workflows/deploy.yml, which runs
#   flyctl deploy --config supervisor/fly.toml --dockerfile supervisor/Dockerfile
# from the repo root so the context stays at the root while still using this
# Dockerfile and supervisor/fly.toml.
#
# better-sqlite3 ships prebuilt native binaries for common platforms, but we
# install build-essential/python3 as a fallback in case prebuild-install
# can't find a match for the target platform and falls back to node-gyp.

FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY supervisor/package.json supervisor/package-lock.json* ./
RUN npm ci
COPY supervisor/tsconfig.json supervisor/tsconfig.build.json ./
COPY supervisor/src ./src
RUN npm run build
# Strip devDependencies (typescript, tsx, @types/*) from node_modules,
# leaving the built better-sqlite3 native binary intact for the runtime stage.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Sandbox payload stage.
#
# Assembles payload.tar.gz: the tarball the supervisor writes into every Fly
# Sprite and extracts with `sudo tar -xzf $OT_PAYLOAD_TAR_PATH -C /`, then
# runs `sudo bash /opt/openthrottle/provision.sh` (see supervisor/src/config.ts
# `payloadTarPath`, default /app/payload.tar.gz — this stage's output must
# land there in the runtime image). The tarball's internal layout is a fixed
# contract with the supervisor and must extract to exactly:
#   opt/openthrottle/entrypoint.sh
#   opt/openthrottle/provision.sh
#   opt/openthrottle/runner/**
#   opt/openthrottle/lib/**
#   opt/openthrottle/safety/**
#   opt/openthrottle/skills/**   (from repo skills/)
#   usr/local/bin/ot-activity   (from sandbox/bin/ot-activity.mjs)
# A staging directory (rather than `tar --transform`) keeps the rename from
# sandbox/bin/ot-activity.mjs -> usr/local/bin/ot-activity, and the sandbox/*
# -> opt/openthrottle/* prefix, explicit and easy to verify.
# ---------------------------------------------------------------------------
FROM node:22-slim AS payload
WORKDIR /payload
RUN mkdir -p \
      staging/opt/openthrottle/runner \
      staging/opt/openthrottle/lib \
      staging/opt/openthrottle/safety \
      staging/opt/openthrottle/skills \
      staging/usr/local/bin
COPY sandbox/entrypoint.sh staging/opt/openthrottle/entrypoint.sh
COPY sandbox/provision.sh staging/opt/openthrottle/provision.sh
COPY sandbox/runner/ staging/opt/openthrottle/runner/
COPY sandbox/lib/ staging/opt/openthrottle/lib/
COPY sandbox/safety/ staging/opt/openthrottle/safety/
COPY sandbox/bin/ot-activity.mjs staging/usr/local/bin/ot-activity
COPY skills/ staging/opt/openthrottle/skills/
RUN chmod 0755 \
      staging/opt/openthrottle/entrypoint.sh \
      staging/opt/openthrottle/provision.sh \
      staging/opt/openthrottle/lib/runtime.sh \
      staging/usr/local/bin/ot-activity \
      staging/opt/openthrottle/safety/pre-push \
      staging/opt/openthrottle/safety/seal.sh \
    && tar czf /payload/payload.tar.gz -C staging .

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=payload /payload/payload.tar.gz ./payload.tar.gz

# /data is where the SQLite DB lives (see fly.toml [mounts] and DATABASE_PATH default).
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080
CMD ["node", "dist/index.js"]
