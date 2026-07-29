# Multi-stage build per docs/SPEC.md "Supervisor contract > Fly":
#   node:22-slim, tsc build, CMD node dist/index.js
#
# NOTE: this image builds from the REPOSITORY ROOT context (see
# .github/workflows/deploy.yml `flyctl deploy --dockerfile supervisor/Dockerfile`
# and the ci.yml "Build supervisor image" guard) so the supervisor's
# `@openthrottle/contracts` (file:../contracts) dependency is available.
#
# better-sqlite3 ships prebuilt native binaries for common platforms, but we
# install build-essential/python3 as a fallback in case prebuild-install
# can't find a match for the target platform and falls back to node-gyp.

# Build the shared contracts package first so file:../contracts resolves.
FROM node:22-slim AS contracts
WORKDIR /contracts
COPY contracts/package.json contracts/package-lock.json* ./
RUN npm ci
COPY contracts/tsconfig.json contracts/tsconfig.build.json ./
COPY contracts/src ./src
RUN npm run build

FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# Provide the built contracts package at ../contracts (relative to /app) so the
# supervisor's file:../contracts dependency resolves during npm ci. --install-links
# packs it into node_modules as a real copy (not a symlink) so the runtime stage's
# node_modules is self-contained.
COPY --from=contracts /contracts /contracts
COPY supervisor/package.json supervisor/package-lock.json* ./
RUN npm ci --install-links
COPY supervisor/tsconfig.json supervisor/tsconfig.build.json ./
COPY supervisor/src ./src
COPY supervisor/pipelines ./pipelines
RUN npm run build
# Strip devDependencies (typescript, tsx, @types/*) from node_modules,
# leaving the built better-sqlite3 native binary and the vendored contracts copy intact.
RUN npm prune --omit=dev --install-links

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/pipelines ./pipelines

# /data is where the SQLite DB lives (see fly.toml [mounts] and DATABASE_PATH default).
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080
CMD ["node", "dist/index.js"]
